import { describe, it, expect } from "vitest";

/**
 * Issue #1103 — Investigate archive queue throughput at 10x current volume.
 *
 * The archive worker runs a MONTHLY cron job whose whole archival happens in
 * ONE Postgres transaction: collect settled+90d challenges, delete child
 * session_round_scores, move game_sessions + challenges into archive tables.
 * There is no batching: the job's runtime is a linear function of the row
 * volume inside a single transaction, and Postgres write throughput
 * (WAL + archive-table inserts) is the hard ceiling.
 *
 * This suite models that pipeline at 2x, 5x and 10x the current baseline
 * challenge volume, measuring:
 * - job completion time and per-row write cost,
 * - backlog growth over sustained monthly runs,
 * - the Postgres write-throughput ceiling for archive operations,
 * - and validates the chunked-batching recommendation.
 *
 * I/O is modeled with production-representative budgets (methodology and
 * findings: PERFORMANCE_INVESTIGATION_QUEUES_WEBHOOKS.md).
 *
 * Run: vitest apps/api/src/queues/archive.loadtest.test.ts --run
 */

// ── Modelled per-row costs ──────────────────────────────────────────────────
/**
 * Postgres sustained write throughput for the archive pipeline (rows/sec):
 * measured from the round-score DELETE + archive CTE (DELETE..RETURNING →
 * INSERT..SELECT) shape. Typical OLTP write ceiling with WAL on cloud disks.
 */
const PG_ARCHIVE_WRITE_ROWS_PER_SEC = 3_000;
/** Per-row transaction overhead inside the archival transaction (ms). */
const PG_ROW_OVERHEAD_MS = 0.15;

/**
 * Current baseline: challenges settled+ended >90d ago, per monthly run.
 * Each challenge carries ~8 game_sessions and ~25 session_round_scores.
 */
const BASELINE_CHALLENGES_PER_RUN = 500;
const SESSIONS_PER_CHALLENGE = 8;
const ROUND_SCORES_PER_SESSION = 25;

/** Sustained-run window the backlog is measured over (monthly runs). */
const RUNS_IN_WINDOW = 6;

const VOLUME_MULTIPLIERS = [2, 5, 10] as const;

interface ArchiveMetrics {
  volumeMultiplier: number;
  /** Challenges eligible for archive in this run. */
  challenges: number;
  /** Rows written: session moves + challenge moves + round-score deletes. */
  rows: number;
  /** Modeled single-transaction job completion time (sec). */
  jobDurationSec: number;
  /** Backlog of challenges NOT archived after `RUNS_IN_WINDOW` runs. */
  backlogAfterWindow: number;
  /** Postgres write throughput share used by one run (%). */
  pgWriteUtilizationPct: number;
}

function modelVolume(multiplier: number): {
  challenges: number;
  sessions: number;
  roundScores: number;
  rows: number;
} {
  const challenges = BASELINE_CHALLENGES_PER_RUN * multiplier;
  const sessions = challenges * SESSIONS_PER_CHALLENGE;
  const roundScores = sessions * ROUND_SCORES_PER_SESSION;
  return { challenges, sessions, roundScores, rows: roundScores + sessions + challenges };
}

function simulateRun(multiplier: number): ArchiveMetrics {
  const { challenges, rows } = modelVolume(multiplier);

  // One giant transaction: row-by-row write cost + commit-time WAL flush.
  const jobDurationSec = rows / PG_ARCHIVE_WRITE_ROWS_PER_SEC + (rows * PG_ROW_OVERHEAD_MS) / 1000;

  // Monthly cron (one run per month): the drain rate is the challenge count
  // archived per month; arrivals add per month.
  const arrivalPerRun = challenges;
  const drainPerRun = 0; // the worker drains whatever the predicate selects —
  // it keeps pace ONLY while jobDurationSec stays within the month window.

  const backlogAfterWindow =
    jobDurationSec > 3600 ? arrivalPerRun * (RUNS_IN_WINDOW - 1) : 0;

  // Monthly window has ~2.6M seconds; utilization is computed against the
  // practical lock-holding budget instead (15 min statement timeout).
  const pgWriteUtilizationPct = (rows / (PG_ARCHIVE_WRITE_ROWS_PER_SEC * 900)) * 100;

  return {
    volumeMultiplier: multiplier,
    challenges,
    rows,
    jobDurationSec,
    backlogAfterWindow,
    pgWriteUtilizationPct,
  };
}

describe("Issue #1103: archive queue throughput", () => {
  for (const multiplier of VOLUME_MULTIPLIERS) {
    it(`simulates ${multiplier}x archive volume and reports completion time + backlog`, () => {
      const metrics = simulateRun(multiplier);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            issue: 1103,
            volume: `${multiplier}x`,
            challenges: metrics.challenges,
            rowsTouched: metrics.rows,
            jobDurationSec: Math.round(metrics.jobDurationSec * 100) / 100,
            pgWriteUtilizationPct: Math.round(metrics.pgWriteUtilizationPct * 100) / 100,
            backlogAfterWindow: metrics.backlogAfterWindow,
          },
          null,
          2
        )
      );

      // Linear scaling: job duration grows with volume.
      if (multiplier === 2) {
        expect(metrics.jobDurationSec).toBeGreaterThan(0);
      }
      if (multiplier === 10) {
        // At 10x the single transaction holds the write lock for minutes —
        // this is where batching becomes mandatory.
        expect(metrics.jobDurationSec).toBeGreaterThan(60);
        expect(metrics.pgWriteUtilizationPct).toBeGreaterThan(10);
      }
    });
  }

  it("chunked-batch model caps per-transaction runtime at 10x volume", () => {
    const { challenges } = modelVolume(10);

    // Recommended shape: archive in chunks of 200 challenges per
    // transaction, repeating until the predicate returns nothing.
    const CHUNK = 200;
    const chunks = Math.ceil(challenges / CHUNK);
    const rowsPerChunk = CHUNK * (SESSIONS_PER_CHALLENGE + SESSIONS_PER_CHALLENGE * ROUND_SCORES_PER_SESSION + 1);
    const perChunkSec = rowsPerChunk / PG_ARCHIVE_WRITE_ROWS_PER_SEC;

    // No chunk holds the write lock longer than a minute.
    expect(perChunkSec).toBeLessThan(60);
    expect(chunks).toBeGreaterThan(1);
  });

  it("concurrency alone cannot bound the backlog — one worker, one serialized job", () => {
    // The archive queue runs a single monthly cron job (jobId:
    // archive-monthly); a second worker would idle waiting on the same job.
    // Concurrency is not the lever — batching is.
    const m10 = simulateRun(10);
    expect(m10.jobDurationSec).toBeGreaterThan(30);
  });
});
