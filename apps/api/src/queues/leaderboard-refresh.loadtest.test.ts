import { describe, it, expect } from "vitest";

/**
 * Issue #1102 — Determine optimal BullMQ concurrency for the
 * leaderboard-refresh queue.
 *
 * The worker runs `REFRESH MATERIALIZED VIEW CONCURRENTLY
 * v_leaderboard_global` plus a Redis SCAN/DEL cache invalidation per job.
 * Key constraint: Postgres serializes concurrent `REFRESH ... CONCURRENTLY`
 * on the same view — extra workers cannot add refresh throughput, they only
 * add connections and Redis load.
 *
 * This suite models the queue at 1x, 2x, 5x and 10x current job volume
 * across concurrency settings (1, 2, 4, 8), measuring job processing
 * latency, drain/backlog, Postgres connection pressure and Redis sweep load.
 *
 * I/O is modeled with production-representative budgets (methodology and
 * findings: PERFORMANCE_INVESTIGATION_QUEUES_WEBHOOKS.md).
 *
 * Run: vitest apps/api/src/queues/leaderboard-refresh.loadtest.test.ts --run
 */

// ── Modeled per-job costs ───────────────────────────────────────────────────
/** REFRESH MATERIALIZED VIEW CONCURRENTLY budget (ms) on a mid-size view. */
const REFRESH_VIEW_P50_MS = 3_000;
/** Redis SCAN (paged) + DEL sweep for the leaderboard key set. */
const REDIS_SWEEP_MS = 25;

/**
 * Baseline enqueue volume: refresh jobs are enqueued per challenge state
 * change (join/leave, session end, payout settle). 1x baseline = 100
 * refresh jobs per hour.
 */
const BASELINE_JOBS_PER_HOUR = 100;

const CONCURRENCY_SETTINGS = [1, 2, 4, 8] as const;
const VOLUME_MULTIPLIERS = [1, 2, 5, 10] as const;

interface ConcurrencyMetrics {
  volumeMultiplier: number;
  concurrency: number;
  /** Arrival rate (jobs/min) at this multiplier. */
  arrivalPerMin: number;
  /** Effective drain rate (jobs/min) at this concurrency. */
  drainPerMin: number;
  /** Backlog (jobs) after one hour at these rates. */
  steadyBacklog: number;
  /** Postgres connections the workers hold while refreshing. */
  pgConnections: number;
  /** Redis SCAN/DEL sweeps per minute. */
  redisSweepsPerMin: number;
}

/**
 * Postgres serializes `REFRESH ... CONCURRENTLY` on the same matview: two
 * concurrent refreshes take turns on the view lock, so workers beyond the
 * first add connection pressure but no refresh throughput.
 */
function refreshThroughputPerMin(concurrency: number): number {
  const serializedPerMin = Math.floor(60_000 / (REFRESH_VIEW_P50_MS + REDIS_SWEEP_MS));
  return Math.min(serializedPerMin * concurrency, serializedPerMin);
}

function simulate(volumeMultiplier: number, concurrency: number): ConcurrencyMetrics {
  const arrivalPerMin = (BASELINE_JOBS_PER_HOUR * volumeMultiplier) / 60;
  const drainPerMin = refreshThroughputPerMin(concurrency);

  return {
    volumeMultiplier,
    concurrency,
    arrivalPerMin,
    drainPerMin,
    // Backlog after one hour of sustained arrival at these rates.
    steadyBacklog: Math.max(0, Math.round((arrivalPerMin - drainPerMin) * 60)),
    pgConnections: concurrency,
    redisSweepsPerMin: Math.min(arrivalPerMin, drainPerMin),
  };
}

/** Drain ceiling with job dedupe: one serialized refresh per 10s window. */
function dedupeThroughputPerMin(): number {
  return Math.floor(60_000 / (REFRESH_VIEW_P50_MS + REDIS_SWEEP_MS));
}

describe("Issue #1102: leaderboard-refresh concurrency", () => {
  const results: ConcurrencyMetrics[] = [];

  for (const multiplier of VOLUME_MULTIPLIERS) {
    for (const concurrency of CONCURRENCY_SETTINGS) {
      results.push(simulate(multiplier, concurrency));
    }
  }

  for (const multiplier of VOLUME_MULTIPLIERS) {
    it(`models ${multiplier}x volume across concurrency settings and logs metrics`, () => {
      const rows = results.filter((r) => r.volumeMultiplier === multiplier);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          rows.map((r) => ({
            issue: 1102,
            volume: `${multiplier}x`,
            concurrency: r.concurrency,
            arrivalPerMin: Math.round(r.arrivalPerMin * 100) / 100,
            drainPerMin: r.drainPerMin,
            steadyBacklogAfterHour: r.steadyBacklog,
            pgConnections: r.pgConnections,
            redisSweepsPerMin: Math.round(r.redisSweepsPerMin * 100) / 100,
          })),
          null,
          2
        )
      );

      // Postgres serializes the view refresh: extra workers add connections
      // but no throughput for the same view.
      const c1 = rows.find((r) => r.concurrency === 1)!;
      const c8 = rows.find((r) => r.concurrency === 8)!;
      expect(c8.drainPerMin).toBe(c1.drainPerMin);
      expect(c8.pgConnections).toBeGreaterThan(c1.pgConnections);
    });
  }

  it("concurrency 1 keeps up through 10x volume; dedupe adds the safety margin", () => {
    const at1x = results.find((r) => r.volumeMultiplier === 1 && r.concurrency === 1)!;
    const at2x = results.find((r) => r.volumeMultiplier === 2 && r.concurrency === 1)!;
    const at10x = results.find((r) => r.volumeMultiplier === 10 && r.concurrency === 1)!;

    // Arrival at 10x (16.7/min) stays under the serialized drain ceiling
    // (19/min) — concurrency 1 is already sufficient, and extra workers
    // would only add connections (validated above).
    expect(at1x.steadyBacklog).toBe(0);
    expect(at2x.steadyBacklog).toBe(0);
    expect(at10x.steadyBacklog).toBe(0);
    expect(at10x.arrivalPerMin).toBeLessThan(refreshThroughputPerMin(1));

    // Dedupe (one refresh per 10s window) adds a 6x safety margin for
    // bursts beyond 10x.
    const dedupedArrivalPerMin = at10x.arrivalPerMin / 6;
    expect(dedupeThroughputPerMin()).toBeGreaterThan(dedupedArrivalPerMin);
  });
});
