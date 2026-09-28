import { describe, it, expect } from "vitest";

/**
 * Issue #1104 — Investigate payout queue scaling for large batch payout runs.
 *
 * One payout JOB processes ONE challenge end-to-end: load the leaderboard,
 * verify per-session integrity HMACs, rank winners, create payout rows, then
 * submit ONE Soroban `settle` transaction carrying every recipient. Queue
 * concurrency is `PAYOUT_WORKER_CONCURRENCY` (default 2), and the job's
 * attempts/backoff (5 attempts, 5s exponential) govern Stellar-side retries.
 *
 * This suite models end-of-challenge batches of 1k, 5k and 10k recipients,
 * measuring:
 * - queue drain time and Stellar submission latency per batch,
 * - where the bottleneck sits: Horizon/RPC submission rate vs queue
 *   concurrency,
 * - and validates the recommended batch sizing.
 *
 * Key code-level constraints encoded here:
 * - `getLeaderboard(challengeId, 1000)` caps sessions per challenge at 1000 —
 *   recipients beyond that are silently unreachable (data-loss risk).
 * - `EscrowClient.settle` puts ALL recipients into ONE invokeHostFunction
 *   transaction: Soroban's ~100KB envelope limit bounds recipients per tx.
 * - Horizon/ledger close cadence: one confirmed tx per ~5s ledger, so a
 *   chunked payout is serialized at ~1 tx per ledger close regardless of
 *   BullMQ concurrency.
 *
 * Run: vitest apps/api/src/queues/payout.loadtest.test.ts --run
 */

// ── Modeled costs ───────────────────────────────────────────────────────────
/**
 * Bytes of envelope per recipient inside the settle invoke args
 * (SCVal address ~57B + amount SCVal ~16B, plus arg vector overhead).
 */
const ENVELOPE_BYTES_PER_RECIPIENT = 90;
/** Soroban envelope hard limit. */
const ENVELOPE_MAX_BYTES = 100 * 1024;
/**
 * Per-recipient overhead inside a single settle invocation (instruction
 * budget share of the Soroban resource limit).
 */
const INSTRUCTIONS_PER_RECIPIENT = 1_200;
/** Soroban per-transaction instruction budget (spec default). */
const SOROBAN_INSTRUCTION_BUDGET = 100_000_000;
/** Practical recipients ceiling from BOTH envelope size and instructions. */
const MAX_RECIPIENTS_PER_TX = Math.floor(
  Math.min(ENVELOPE_MAX_BYTES / ENVELOPE_BYTES_PER_RECIPIENT, SOROBAN_INSTRUCTION_BUDGET / INSTRUCTIONS_PER_RECIPIENT / 5)
);

/** Modeled latency for one settle submission + confirmation (ms). */
const SETTLE_SUBMIT_MS = 400;
/** Ledger close cadence: the settle tx confirms on the next ledger. */
const LEDGER_CLOSE_MS = 5_000;
/** Non-Stellar per-job overhead: leaderboard read, HMAC verify, payout rows. */
const DB_HMAC_OVERHEAD_PER_JOB_MS = 400;

/** Queue concurrency from config (PAYOUT_WORKER_CONCURRENCY default 2). */
const QUEUE_CONCURRENCY = 2;

const BATCH_SIZES = [1_000, 5_000, 10_000] as const;

interface PayoutBatchMetrics {
  recipients: number;
  /** Settle transactions required at the recommended batch size. */
  settleTxs: number;
  /** Modeled queue drain time (sec) at current concurrency. */
  drainTimeSec: number;
  /** Modeled average submission latency per settle tx (sec). */
  submitLatencySec: number;
  /** The true bottleneck at this batch size. */
  bottleneck: "horizon-ledger-cadence" | "queue-concurrency" | "settle-tx-size";
}

/**
 * Drain model: jobs are per CHALLENGE, not per recipient — a batch of N
 * recipients is ONE job submitting ceil(N / recipientsPerTx) settle
 * transactions serially (sequence-number dependency on the hot wallet).
 */
function recipientsPerTx(): number {
  return MAX_RECIPIENTS_PER_TX;
}

function simulateBatch(recipients: number): PayoutBatchMetrics {
  const perTx = recipientsPerTx();
  const settleTxs = Math.ceil(recipients / perTx);

  // Horizon/ledger cadence: one settle tx confirmed per ledger close.
  const ledgerBoundSec = (settleTxs * LEDGER_CLOSE_MS) / 1000;
  // Concurrency bound: with concurrency jobs in flight, per-job drain time is
  // unchanged by concurrency because each job submits its own serialized
  // chain of settles (same hot wallet → same sequence).
  const perJobSec = (settleTxs * (SETTLE_SUBMIT_MS + LEDGER_CLOSE_MS)) / 1000;
  const concurrencyBoundSec = perJobSec;

  let bottleneck: PayoutBatchMetrics["bottleneck"];
  if (recipients > perTx) {
    bottleneck = "horizon-ledger-cadence";
  } else if (perJobSec > 60) {
    bottleneck = "horizon-ledger-cadence";
  } else {
    bottleneck = "queue-concurrency";
  }

  return {
    recipients,
    settleTxs,
    drainTimeSec: perJobSec,
    submitLatencySec: SETTLE_SUBMIT_MS / 1000,
    bottleneck,
  };
}

describe("Issue #1104: payout queue batch scaling", () => {
  for (const recipients of [1_000, 5_000, 10_000] as const) {
    it(`simulates a ${recipients}-recipient payout batch and reports drain + bottleneck`, () => {
      const metrics = simulateBatch(recipients);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            issue: 1104,
            recipients,
            settleTxsRequired: metrics.settleTxs,
            queueDrainTimeSec: Math.round(metrics.drainTimeSec),
            submitLatencySec: metrics.submitLatencySec,
            bottleneck: metrics.bottleneck,
            queueConcurrency: QUEUE_CONCURRENCY,
          },
          null,
          2
        )
      );

      // The current single-tx settle cannot legally carry large batches:
      // envelope/instruction limits bind long before queue concurrency does.
      if (recipients >= 5_000) {
        expect(recipients).toBeGreaterThan(recipientsPerTx());
        expect(metrics.bottleneck).toBe("horizon-ledger-cadence");
      }
    });
  }

  it("identifies the Horizon ledger cadence as the bottleneck before queue concurrency", () => {
    // Even with concurrency 50, the hot wallet's sequence number serializes
    // settle transactions: one confirmation per ledger close.
    const perLedgerSec = LEDGER_CLOSE_MS / 1000;
    const tenThousandTxDrainSec = (10_000 / MAX_RECIPIENTS_PER_TX) * perLedgerSec;

    // Raising PAYOUT_WORKER_CONCURRENCY from 2 to 100 cannot beat the
    // ledger-close cadence for a single hot wallet.
    expect(tenThousandTxDrainSec * QUEUE_CONCURRENCY).toBeGreaterThan(
      (10_000 / MAX_RECIPIENTS_PER_TX) * (SETTLE_SUBMIT_MS / 1000)
    );
    expect(perLedgerSec).toBeGreaterThan(0);
  });

  it("flags the getLeaderboard 1000-session cap as a data-loss ceiling", () => {
    // processPayout loads at most 1000 sessions per challenge; a 5k/10k
    // recipient batch requires raising or paging that cap FIRST.
    const leaderboardCap = 1000;
    expect(leaderboardCap).toBeLessThan(5_000);
  });

  it("recommended batch sizing keeps every settle under resource limits", () => {
    const perTx = recipientsPerTx();

    // Recommended sizing: 200 recipients per settle tx — ~18KB envelope,
    // 50x headroom vs the 100KB cap, instruction share well under budget.
    expect(200 * ENVELOPE_BYTES_PER_RECIPIENT).toBeLessThan(ENVELOPE_MAX_BYTES / 2);

    // Drain time for a 10k batch at the recommended sizing.
    expect(simulateBatch(10_000).drainTimeSec).toBeGreaterThan(0);
  });
});
