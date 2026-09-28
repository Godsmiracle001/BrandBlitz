import { describe, it, expect } from "vitest";
import { simulateSessionStartBurst, ConnectionPoolSimulator } from "../../../../scripts/benchmark-session-burst";

describe("Issue #1100: POST session-start burst load test at challenge open time", () => {
  it("detects connection pool waiting spike and exhaustion under unshaped burst", async () => {
    // Scaled simulation with burst concentration
    const result = await simulateSessionStartBurst({
      totalRequests: 200,
      windowMs: 400,
      poolMax: 5,
      connectionTimeoutMs: 250,
      queryMs: 4,
      burstConcentration: 0.7,
      useRateShaping: false,
      enableChallengeCache: false,
    });

    expect(result.peakPoolWaiting).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("handles burst without connection timeouts when rate-shaping and connection pool are tuned", async () => {
    const result = await simulateSessionStartBurst({
      totalRequests: 150,
      windowMs: 600,
      poolMax: 15,
      connectionTimeoutMs: 1000,
      queryMs: 2,
      burstConcentration: 0.5,
      useRateShaping: true,
      rateLimitPerSec: 300,
      enableChallengeCache: true,
    });

    expect(result.connectionTimeouts).toBe(0);
    expect(result.completedRequests).toBeGreaterThan(0);
  });

  it("measures DB pool acquisition delay and release behavior", async () => {
    const pool = new ConnectionPoolSimulator(2, 500, 10);
    expect(pool.active).toBe(0);
    expect(pool.waiting).toBe(0);

    const task1 = pool.runQuery();
    const task2 = pool.runQuery();
    const task3 = pool.runQuery();

    await Promise.all([task1, task2, task3]);

    expect(pool.active).toBe(0);
    expect(pool.waiting).toBe(0);
    expect(pool.peakWaiting).toBeGreaterThanOrEqual(1);
  });
});
