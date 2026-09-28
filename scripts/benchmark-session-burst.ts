#!/usr/bin/env tsx
/**
 * Benchmark: Synchronized Session Start Burst Load Test (Issue #1100)
 *
 * Simulates a synchronized burst of 5,000 session starts hitting the session
 * creation endpoints within a 10-second window at challenge open time.
 *
 * Measures:
 * - p50, p95, p99, and max response latency
 * - PostgreSQL connection pool waiting queue depth and connection timeouts (exhaustion)
 * - DB row-lock contention across challenges, game_sessions, and users tables
 * - Compares unshaped burst against queued / rate-shaped capacity
 */

import { performance } from "perf_hooks";

export interface SimulationResult {
  scenario: string;
  totalRequests: number;
  durationMs: number;
  completedRequests: number;
  failedRequests: number;
  connectionTimeouts: number;
  rowLockContentionEvents: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  peakPoolWaiting: number;
  effectiveThroughputRps: number;
}

export class ConnectionPoolSimulator {
  readonly max: number;
  readonly connectionTimeoutMs: number;
  readonly queryDurationMs: number;
  active = 0;
  waiting = 0;
  peakWaiting = 0;
  private queue: { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }[] = [];

  constructor(max = 10, connectionTimeoutMs = 5000, queryDurationMs = 4) {
    this.max = max;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.queryDurationMs = queryDurationMs;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }

    this.waiting++;
    if (this.waiting > this.peakWaiting) {
      this.peakWaiting = this.waiting;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting--;
        const index = this.queue.findIndex((item) => item.timer === timer);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(new Error("timeout exceeded when trying to connect to PostgreSQL pool"));
      }, this.connectionTimeoutMs);

      this.queue.push({ resolve, reject, timer });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      this.waiting--;
      next.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  async runQuery(contentionDelayMs = 0): Promise<void> {
    await this.acquire();
    try {
      const execTime = this.queryDurationMs + contentionDelayMs;
      await new Promise((r) => setTimeout(r, execTime));
    } finally {
      this.release();
    }
  }
}

export async function simulateSessionStartBurst(options: {
  totalRequests?: number;
  windowMs?: number;
  poolMax?: number;
  connectionTimeoutMs?: number;
  queryMs?: number;
  burstConcentration?: number; // fraction of requests arriving in first 20% of window
  useRateShaping?: boolean;
  rateLimitPerSec?: number;
  enableChallengeCache?: boolean;
}): Promise<SimulationResult> {
  const totalRequests = options.totalRequests ?? 5000;
  const windowMs = options.windowMs ?? 10000;
  const poolMax = options.poolMax ?? 10;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 5000;
  const queryMs = options.queryMs ?? 4;
  const burstConcentration = options.burstConcentration ?? 0.6; // 60% burst in first 2s
  const useRateShaping = options.useRateShaping ?? false;
  const rateLimitPerSec = options.rateLimitPerSec ?? 300;
  const enableChallengeCache = options.enableChallengeCache ?? false;

  const pool = new ConnectionPoolSimulator(poolMax, connectionTimeoutMs, queryMs);
  const latencies: number[] = [];
  let connectionTimeouts = 0;
  let rowLockContentionEvents = 0;
  let completedRequests = 0;
  let failedRequests = 0;

  // Track row lock on challenge row when status activates at t=0
  const challengeActivationLockMs = 150; // Challenge update transaction hold time

  const startTime = performance.now();

  // Rate shaping token bucket state
  let tokens = rateLimitPerSec;
  let lastRefill = performance.now();

  const requests = Array.from({ length: totalRequests }, (_, i) => {
    // Arrival schedule
    let arrivalDelayMs: number;
    if (i < totalRequests * burstConcentration) {
      // Concentrated burst in first 20% of window (0 - 2000 ms)
      arrivalDelayMs = Math.random() * (windowMs * 0.2);
    } else {
      // Remaining spread across the rest of the window
      arrivalDelayMs = (windowMs * 0.2) + Math.random() * (windowMs * 0.8);
    }

    return { id: i, arrivalDelayMs };
  });

  // Sort by arrival time
  requests.sort((a, b) => a.arrivalDelayMs - b.arrivalDelayMs);

  const executeRequest = async (req: { id: number; arrivalDelayMs: number }) => {
    await new Promise((r) => setTimeout(r, req.arrivalDelayMs));
    const reqStart = performance.now();

    if (useRateShaping) {
      const now = performance.now();
      const elapsed = (now - lastRefill) / 1000;
      tokens = Math.min(rateLimitPerSec, tokens + elapsed * rateLimitPerSec);
      lastRefill = now;

      if (tokens < 1) {
        failedRequests++;
        latencies.push(performance.now() - reqStart);
        return;
      }
      tokens -= 1;
    }

    try {
      // Query 1: findUserById
      await pool.runQuery();

      // Query 2: claimSession (INSERT INTO game_sessions ... ON CONFLICT DO NOTHING)
      // Check for row lock / foreign key lock contention if within challenge activation window
      const timeSinceStart = performance.now() - startTime;
      let contentionWaitMs = 0;
      if (timeSinceStart < challengeActivationLockMs) {
        rowLockContentionEvents++;
        contentionWaitMs = Math.max(0, challengeActivationLockMs - timeSinceStart);
      }
      await pool.runQuery(contentionWaitMs);

      // Query 3: getChallengeById (bypassed if challenge cache is active)
      if (!enableChallengeCache) {
        await pool.runQuery();
      }

      // Query 4: markWarmupStarted (UPDATE game_sessions)
      await pool.runQuery();

      completedRequests++;
      latencies.push(performance.now() - reqStart);
    } catch (err: any) {
      failedRequests++;
      if (err.message?.includes("timeout exceeded")) {
        connectionTimeouts++;
      }
      latencies.push(performance.now() - reqStart);
    }
  };

  await Promise.all(requests.map(executeRequest));
  const totalDurationMs = performance.now() - startTime;

  latencies.sort((a, b) => a - b);
  const avgMs = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const p50Ms = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95Ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99Ms = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const maxMs = latencies[latencies.length - 1] ?? 0;

  return {
    scenario: useRateShaping
      ? "Rate-shaped (Token Bucket 300 req/s + Cached Challenge)"
      : "Baseline (Unshaped 5k burst, pool max 10)",
    totalRequests,
    durationMs: Math.round(totalDurationMs),
    completedRequests,
    failedRequests,
    connectionTimeouts,
    rowLockContentionEvents,
    p50Ms: Math.round(p50Ms * 100) / 100,
    p95Ms: Math.round(p95Ms * 100) / 100,
    p99Ms: Math.round(p99Ms * 100) / 100,
    maxMs: Math.round(maxMs * 100) / 100,
    avgMs: Math.round(avgMs * 100) / 100,
    peakPoolWaiting: pool.peakWaiting,
    effectiveThroughputRps: Math.round((completedRequests / (totalDurationMs / 1000)) * 100) / 100,
  };
}

async function run() {
  console.log("================================================================================");
  console.log("Simulating 5,000 synchronized session starts within a 10-second window");
  console.log("================================================================================");

  // Scenario 1: Unshaped burst (Baseline)
  const baseline = await simulateSessionStartBurst({
    totalRequests: 5000,
    windowMs: 10000,
    poolMax: 10,
    connectionTimeoutMs: 5000,
    queryMs: 4,
    burstConcentration: 0.6,
    useRateShaping: false,
    enableChallengeCache: false,
  });

  console.log("\n--- Scenario 1: Baseline (Unshaped burst) ---");
  console.log(`Completed: ${baseline.completedRequests} / ${baseline.totalRequests}`);
  console.log(`Failed / Timed out: ${baseline.failedRequests} (Connection timeouts: ${baseline.connectionTimeouts})`);
  console.log(`Peak Pool Waiting Queue: ${baseline.peakPoolWaiting}`);
  console.log(`DB Row-Lock Contention Events: ${baseline.rowLockContentionEvents}`);
  console.log(`p50 Latency: ${baseline.p50Ms} ms`);
  console.log(`p95 Latency: ${baseline.p95Ms} ms`);
  console.log(`p99 Latency: ${baseline.p99Ms} ms`);
  console.log(`Max Latency: ${baseline.maxMs} ms`);
  console.log(`Throughput: ${baseline.effectiveThroughputRps} req/s`);

  // Scenario 2: Rate-shaped with challenge caching
  const optimized = await simulateSessionStartBurst({
    totalRequests: 5000,
    windowMs: 10000,
    poolMax: 20,
    connectionTimeoutMs: 5000,
    queryMs: 4,
    burstConcentration: 0.6,
    useRateShaping: true,
    rateLimitPerSec: 400,
    enableChallengeCache: true,
  });

  console.log("\n--- Scenario 2: Mitigated (Rate-shaping + Pool 20 + Challenge Cache) ---");
  console.log(`Completed: ${optimized.completedRequests} / ${optimized.totalRequests}`);
  console.log(`Failed / Throttled: ${optimized.failedRequests} (Connection timeouts: ${optimized.connectionTimeouts})`);
  console.log(`Peak Pool Waiting Queue: ${optimized.peakPoolWaiting}`);
  console.log(`DB Row-Lock Contention Events: ${optimized.rowLockContentionEvents}`);
  console.log(`p50 Latency: ${optimized.p50Ms} ms`);
  console.log(`p95 Latency: ${optimized.p95Ms} ms`);
  console.log(`p99 Latency: ${optimized.p99Ms} ms`);
  console.log(`Max Latency: ${optimized.maxMs} ms`);
  console.log(`Throughput: ${optimized.effectiveThroughputRps} req/s`);
  console.log("================================================================================");
}

if (process.argv[1]?.endsWith("benchmark-session-burst.ts")) {
  void run();
}
