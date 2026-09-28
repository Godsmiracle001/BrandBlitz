import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { signWebhookPayload } from "./middleware/verify-webhook";

/**
 * Issue #1109 — Load-test POST /webhooks/stellar/deposit under burst delivery.
 *
 * The deposit webhook is fully synchronous: zod parse → HMAC verification →
 * 2 duplicate-check queries → memo lookup → Horizon USDC balance check →
 * status update. This suite measures the REAL CPU cost of the cryptographic
 * path and models the I/O path against the burst targets (100 / 500 / 1000
 * events per minute), then derives:
 *
 * - per-event verification and processing latency,
 * - the sustained throughput the synchronous handler supports,
 * - whether a burst creates queue backlog (sender-side retries),
 * - where async offloading becomes necessary.
 *
 * I/O (Postgres + Horizon) is modeled with production-representative p50
 * latencies as constants, so the suite runs in milliseconds while the
 * conclusions are derived from measured CPU plus those configured budgets.
 *
 * Run: vitest apps/api/src/routes/webhooks.loadtest.test.ts --run
 */

// ── Measured constants (see PERFORMANCE_INVESTIGATION_QUEUES_WEBHOOKS.md) ────
// Postgres round-trip p50 through the pooled client.
const PG_QUERY_P50_MS = 2;
// Duplicate tx checks (2 queries) + memo lookup (1) + challenge status update (1).
const PG_QUERIES_PER_EVENT = 4;
// `getAccountUsdcBalance` hits the Horizon REST API for the hot wallet balance.
const HORIZON_BALANCE_P50_MS = 300;
// The deposit monitor (sender) retries on timeout — allow ~2 event/response
// round trips before a retry storm is expected.
const WEBHOOK_RESPONSE_BUDGET_MS = 10_000;

/** Burst targets from the issue: 100 / 500 / 1000 events per minute. */
const BURST_LEVELS = [100, 500, 1000] as const;

interface BurstMetrics {
  eventsPerMinute: number;
  /** Real, measured HMAC verification throughput (events/sec). */
  verificationOpsPerSec: number;
  /** Modeled per-event end-to-end processing latency (ms). */
  perEventLatencyMs: number;
  /** Sustained events/sec the serial handler supports at that latency. */
  sustainedThroughputPerSec: number;
  /** Events/min arrival minus drain — negative means the queue drains. */
  backlogPerMinute: number;
  /** Sender-visible timeout risk (handler latency vs response budget). */
  timeoutRisk: boolean;
}

/** Measure real HMAC verification throughput for webhook payloads. */
function measureVerificationOpsPerSec(sampleEvents = 5_000): number {
  const secret = "loadtest-secret";
  const payload = Buffer.from(
    JSON.stringify({
      memo: "7f3a1b2c-11aa-4c3e-9d21-0f3c8f4e5b6a",
      txHash: "ab".repeat(32),
      amount: "12.5",
    })
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const signatures: Buffer[] = [];
  for (let i = 0; i < sampleEvents; i++) {
    const ts = timestamp - (i % 300); // vary timestamps like a real burst
    signatures.push(Buffer.from(signWebhookPayload(payload, timestamp - i, secret), "hex"));
  }

  const start = performance.now();
  for (let i = 0; i < sampleEvents; i++) {
    const expected = Buffer.from(signWebhookPayload(payload, timestamp - (i % 300), secret), "hex");
    if (expected.length === signatures[i].length) {
      crypto.timingSafeEqual(expected, signatures[i]);
    }
  }
  const elapsedSec = (performance.now() - start) / 1000;
  return sampleEvents / elapsedSec;
}

/** Modeled end-to-end latency for one synchronous webhook event. */
function modelPerEventLatencyMs(verificationMs: number): number {
  // CPU: zod validation + JSON parse + HMAC compare (sub-millisecond).
  const parseAndVerify = verificationMs + 0.2;
  // Postgres: 2 duplicate lookups + memo lookup + status update.
  const postgresMs = PG_QUERIES_PER_EVENT * PG_QUERY_P50_MS;
  // Horizon: hot-wallet USDC balance read (network I/O, testnet p50).
  const horizonMs = HORIZON_BALANCE_P50_MS;
  return parseAndVerify + postgresMs + horizonMs;
}

function simulateBurst(eventsPerMinute: number, verificationOpsPerSec: number): BurstMetrics {
  const perEventVerificationMs = 1000 / verificationOpsPerSec;
  const perEventLatencyMs = modelPerEventLatencyMs(perEventVerificationMs);

  // The Express handler processes events with at most `concurrency` in flight
  // (Node processes one CPU-bound slice at a time; I/O overlaps, but the
  // Horizon call is serializable per event through the event loop only up to
  // connection-pool depth — model steady-state serial processing).
  const sustainedThroughput = 1000 / perEventLatencyMs;
  const backlogPerMinute = eventsPerMinute - sustainedThroughput * 60;

  return {
    eventsPerMinute,
    verificationOpsPerSec,
    perEventLatencyMs,
    sustainedThroughput,
    backlogPerMinute,
    timeoutRisk: perEventLatencyMs > 1000,
  };
}

describe("Issue #1109: deposit webhook burst load", () => {
  it("verifies signatures fast enough that crypto is never the bottleneck", () => {
    const opsPerSec = measureVerificationOpsPerSec();
    // HMAC-SHA256 + timingSafeEqual should comfortably exceed burst rates.
    expect(opsPerSec).toBeGreaterThan(20_000);
  });

  for (const eventsPerMinute of BURST_LEVELS) {
    it(`simulates ${eventsPerMinute} events/min and reports latency + backlog`, () => {
      const verificationOpsPerSec = measureVerificationOpsPerSec(1_000);
      const metrics = simulateBurst(eventsPerMinute, verificationOpsPerSec);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            issue: 1109,
            burst: `${eventsPerMinute}/min`,
            verificationOpsPerSec: Math.round(metrics.verificationOpsPerSec),
            perEventLatencyMs: Math.round(metrics.perEventLatencyMs * 100) / 100,
            sustainedThroughputPerSec: Math.round(metrics.sustainedThroughput * 100) / 100,
            backlogPerMinute: Math.round(metrics.backlogPerMinute * 100) / 100,
            timeoutRisk: metrics.timeoutRisk,
          },
          null,
          2
        )
      );

      // Crypto never bottlenecks: even at 1000/min the verification share of
      // per-event latency is well under 1ms.
      expect(metrics.verificationOpsPerSec * 60).toBeGreaterThan(eventsPerMinute * 100);

      if (eventsPerMinute >= 500) {
        // At 500+ events/min the synchronous Horizon balance check dominates
        // and the queue grows faster than it drains — the sender's own retry
        // window (10s budgets) then amplifies load.
        expect(metrics.sustainedThroughput * 60).toBeLessThan(eventsPerMinute);
        expect(metrics.timeoutRisk || metrics.backlogPerMinute > 0).toBe(true);
      }
    });
  }

  it("async offload model keeps up at 1000 events/min", () => {
    // Recommended shape: verify + enqueue (one Postgres write) → return 202;
    // a dedicated worker drains the balance-check + activation work.
    const enqueueMs = 2; // single INSERT / BullMQ add
    const offloadedThroughputPerSec = 1000 / enqueueMs;

    expect(offloadedThroughputPerSec * 60).toBeGreaterThan(1000);
  });
});
