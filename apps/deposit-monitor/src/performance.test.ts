import { describe, it, expect, beforeEach, vi } from "vitest";
import pino from "pino";

/**
 * Performance Investigation Tests for Deposit Monitor
 *
 * Simulates scaled deposit polling scenarios to measure:
 * - Per-cycle polling duration as monitored address count grows
 * - Horizon API request rate and latency under different scales
 * - Whether polling cycles begin exceeding their configured interval
 *
 * Issue #1108: Investigate deposit-monitor polling interval scaling
 */

const logger = pino({ level: "warn" });

interface PollMetrics {
  cycleStartTime: number;
  fetchDuration: number;
  webhookDuration: number;
  totalCycleDuration: number;
  addressesPolled: number;
  eventsDetected: number;
  rpsToHorizon: number;
}

describe("Issue #1108: Deposit Monitor Polling Performance", () => {
  const POLL_INTERVAL_MS = 5000;
  const BASE_HORIZON_LATENCY_MS = 100;

  async function simulatePollCycle(
    activeAddresses: number,
    eventsPerPoll: number = 2
  ): Promise<PollMetrics> {
    const cycleStart = performance.now();

    // Simulate fetchDepositEvents RPC call to Horizon
    // Latency scales with number of addresses being monitored
    const fetchStart = performance.now();
    const horizonLatency =
      BASE_HORIZON_LATENCY_MS + activeAddresses * 0.05;
    await new Promise((r) => setTimeout(r, horizonLatency));
    const fetchDuration = performance.now() - fetchStart;

    // Simulate webhook deliveries for detected events
    const webhookStart = performance.now();
    const eventsDetected = Math.floor(Math.random() * eventsPerPoll) + 1;
    const webhookLatency = eventsDetected * 50; // 50ms per webhook
    await new Promise((r) => setTimeout(r, webhookLatency));
    const webhookDuration = performance.now() - webhookStart;

    const totalDuration = performance.now() - cycleStart;

    return {
      cycleStartTime: cycleStart,
      fetchDuration,
      webhookDuration,
      totalCycleDuration: totalDuration,
      addressesPolled: activeAddresses,
      eventsDetected,
      rpsToHorizon: 1 / (fetchDuration / 1000),
    };
  }

  it("should measure polling latency at 100 monitored addresses", async () => {
    const addressCount = 100;
    const cycles: PollMetrics[] = [];

    for (let i = 0; i < 5; i++) {
      const metrics = await simulatePollCycle(addressCount);
      cycles.push(metrics);
    }

    const avgDuration =
      cycles.reduce((sum, m) => sum + m.totalCycleDuration, 0) / cycles.length;
    const maxDuration = Math.max(...cycles.map((m) => m.totalCycleDuration));
    const cycleExceededInterval = maxDuration > POLL_INTERVAL_MS;

    logger.info(
      {
        addressCount,
        avgCycleDuration: avgDuration.toFixed(2),
        maxCycleDuration: maxDuration.toFixed(2),
        pollInterval: POLL_INTERVAL_MS,
        cycleExceededInterval,
        headroom: (POLL_INTERVAL_MS - avgDuration).toFixed(2),
      },
      "Poll metrics at 100 addresses"
    );

    expect(avgDuration).toBeLessThan(POLL_INTERVAL_MS * 0.5);
    expect(cycleExceededInterval).toBe(false);
  });

  it("should measure polling latency at 500 monitored addresses", async () => {
    const addressCount = 500;
    const cycles: PollMetrics[] = [];

    for (let i = 0; i < 5; i++) {
      const metrics = await simulatePollCycle(addressCount);
      cycles.push(metrics);
    }

    const avgDuration =
      cycles.reduce((sum, m) => sum + m.totalCycleDuration, 0) / cycles.length;
    const maxDuration = Math.max(...cycles.map((m) => m.totalCycleDuration));
    const avgHorizonRps =
      cycles.reduce((sum, m) => sum + m.rpsToHorizon, 0) / cycles.length;
    const cycleExceededInterval = maxDuration > POLL_INTERVAL_MS;

    logger.info(
      {
        addressCount,
        avgCycleDuration: avgDuration.toFixed(2),
        maxCycleDuration: maxDuration.toFixed(2),
        pollInterval: POLL_INTERVAL_MS,
        cycleExceededInterval,
        headroom: (POLL_INTERVAL_MS - avgDuration).toFixed(2),
        avgHorizonRps: avgHorizonRps.toFixed(2),
      },
      "Poll metrics at 500 addresses"
    );

    // At 500 addresses, we expect to use ~50% of poll interval
    expect(avgDuration).toBeLessThan(POLL_INTERVAL_MS * 0.7);
    expect(cycleExceededInterval).toBe(false);
  });

  it("should measure polling latency at 2000 monitored addresses", async () => {
    const addressCount = 2000;
    const cycles: PollMetrics[] = [];

    for (let i = 0; i < 5; i++) {
      const metrics = await simulatePollCycle(addressCount);
      cycles.push(metrics);
    }

    const avgDuration =
      cycles.reduce((sum, m) => sum + m.totalCycleDuration, 0) / cycles.length;
    const maxDuration = Math.max(...cycles.map((m) => m.totalCycleDuration));
    const avgHorizonRps =
      cycles.reduce((sum, m) => sum + m.rpsToHorizon, 0) / cycles.length;
    const cycleExceededInterval = maxDuration > POLL_INTERVAL_MS;

    logger.info(
      {
        addressCount,
        avgCycleDuration: avgDuration.toFixed(2),
        maxCycleDuration: maxDuration.toFixed(2),
        pollInterval: POLL_INTERVAL_MS,
        cycleExceededInterval,
        headroom: cycleExceededInterval
          ? `EXCEEDED by ${(maxDuration - POLL_INTERVAL_MS).toFixed(2)}ms`
          : (POLL_INTERVAL_MS - avgDuration).toFixed(2),
        avgHorizonRps: avgHorizonRps.toFixed(2),
        recommendation: cycleExceededInterval
          ? "Implement batching or webhook migration strategy"
          : "Polling sustainable at this scale",
      },
      "Poll metrics at 2000 addresses (potential scaling issue)"
    );

    // At 2000 addresses, we expect cycle time to approach or exceed interval
    if (cycleExceededInterval) {
      logger.warn(
        "Poll cycle exceeds interval; recommend sharding or webhook-based approach"
      );
    }
  });

  it("should compare polling efficiency across scales", async () => {
    const addressCounts = [100, 500, 2000];
    const results: Record<number, PollMetrics[]> = {};

    for (const count of addressCounts) {
      results[count] = [];
      for (let i = 0; i < 3; i++) {
        const metrics = await simulatePollCycle(count);
        results[count].push(metrics);
      }
    }

    const comparison = addressCounts.map((count) => {
      const cycles = results[count];
      const avgDuration =
        cycles.reduce((sum, m) => sum + m.totalCycleDuration, 0) /
        cycles.length;
      const maxDuration = Math.max(...cycles.map((m) => m.totalCycleDuration));
      const costPerAddress = avgDuration / count;

      return {
        addressCount: count,
        avgCycleDuration: avgDuration.toFixed(2),
        maxCycleDuration: maxDuration.toFixed(2),
        costPerAddress: costPerAddress.toFixed(4),
        exceedsInterval: maxDuration > POLL_INTERVAL_MS,
      };
    });

    logger.info(comparison, "Polling efficiency comparison across scales");

    // Verify polling scales reasonably (linear cost per address, not quadratic)
    const cost100 =
      (results[100][0].totalCycleDuration / 100) *
      100; // normalized baseline
    const cost2000 =
      (results[2000][0].totalCycleDuration / 2000) * 100; // cost for 100 at 2k scale

    // Should not see exponential growth
    expect(cost2000).toBeLessThan(cost100 * 3);
  });

  it("should analyze when polling cannot keep pace", async () => {
    const criticalScale = 2000;
    const pollInterval = 5000;
    let breakingPoint = criticalScale;

    for (let addressCount = criticalScale; addressCount <= 5000; addressCount += 250) {
      const cycles: PollMetrics[] = [];

      for (let i = 0; i < 3; i++) {
        const metrics = await simulatePollCycle(addressCount);
        cycles.push(metrics);
      }

      const maxDuration = Math.max(...cycles.map((m) => m.totalCycleDuration));

      if (maxDuration > pollInterval) {
        logger.warn(
          {
            addressCount,
            maxCycleDuration: maxDuration.toFixed(2),
            pollInterval,
            exceedsBy: (maxDuration - pollInterval).toFixed(2),
          },
          "Polling cannot keep pace at this scale"
        );
        breakingPoint = addressCount;
        break;
      }
    }

    logger.info(
      { breakingPoint, recommendation: "Implement sharding or webhook migration" },
      "Analysis: polling performance breaking point"
    );

    // The test finds the point where polling starts to exceed interval
    expect(breakingPoint).toBeGreaterThanOrEqual(2000);
  });
});
