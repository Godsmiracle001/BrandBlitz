#!/usr/bin/env tsx
/**
 * Benchmark: metrics endpoint overhead under production-like scraping.
 * Uses absolute prom-client path to avoid broken node_modules symlinks.
 */

import { performance } from "perf_hooks";
// Absolute path avoids pnpm virtual-store resolution issues
import { Registry, Gauge, collectDefaultMetrics } from "/home/emperor-caesar/drips/BrandBlitz/node_modules/.pnpm/prom-client@15.1.3/node_modules/prom-client";

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const dbPoolTotalConnections = new Gauge({
  name: "db_pool_total_connections",
  help: "Current number of connections in the PostgreSQL pool",
  registers: [registry],
});
const dbPoolIdleConnections = new Gauge({
  name: "db_pool_idle_connections",
  help: "Number of idle connections",
  registers: [registry],
});
const dbPoolWaitingClients = new Gauge({
  name: "db_pool_waiting_clients",
  help: "Number of clients waiting",
  registers: [registry],
});
const dbPoolMaxConnections = new Gauge({
  name: "db_pool_max_connections",
  help: "Maximum number of connections",
  registers: [registry],
});

function updatePoolMetrics() {
  // simulate pool stats (in-memory)
  dbPoolTotalConnections.set(5);
  dbPoolIdleConnections.set(3);
  dbPoolWaitingClients.set(0);
  dbPoolMaxConnections.set(10);
}

async function main() {
  await registry.metrics();

  async function measureScrape(): Promise<{ wallMs: number; cpuUserMs: number; cpuSysMs: number; bytes: number }> {
    updatePoolMetrics();
    const cpuStart = process.cpuUsage();
    const t0 = performance.now();
    const metrics = await registry.metrics();
    const t1 = performance.now();
    const cpuEnd = process.cpuUsage(cpuStart);
    return {
      wallMs: t1 - t0,
      cpuUserMs: cpuEnd.user / 1000,
      cpuSysMs: cpuEnd.system / 1000,
      bytes: Buffer.byteLength(metrics, "utf8"),
    };
  }

  async function runBatch(iterations = 100) {
    const samples: number[] = [];
    let totalCpuUser = 0;
    let totalCpuSys = 0;
    let totalBytes = 0;
    for (let i = 0; i < iterations; i++) {
      const r = await measureScrape();
      samples.push(r.wallMs);
      totalCpuUser += r.cpuUserMs;
      totalCpuSys += r.cpuSysMs;
      totalBytes += r.bytes;
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const p99 = samples[Math.floor(samples.length * 0.99)];
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const min = samples[0];
    const max = samples[samples.length - 1];
    return {
      avg, p50, p95, p99, min, max,
      avgCpuUserMs: totalCpuUser / iterations,
      avgCpuSysMs: totalCpuSys / iterations,
      avgBytes: Math.round(totalBytes / iterations),
      samples,
    };
  }

  async function simulateConcurrentScrapes(concurrency: number, rounds = 20) {
    const latencies: number[] = [];
    for (let r = 0; r < rounds; r++) {
      const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, () => measureScrape()));
      const end = performance.now();
      latencies.push((end - start) / concurrency);
    }
    latencies.sort((a, b) => a - b);
    return {
      concurrency,
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95: latencies[Math.floor(latencies.length * 0.95)],
      max: latencies[latencies.length - 1],
    };
  }

  console.log("=== Metrics endpoint overhead benchmark ===");
  console.log(`Node: ${process.version}, prom-client 15.1.3 registry with default metrics + 4 gauges`);
  console.log("");

  const baseline = await runBatch(200);
  console.log(`Baseline single-scrape (200 iterations):`);
  console.log(`  wall avg=${baseline.avg.toFixed(3)}ms p50=${baseline.p50.toFixed(3)}ms p95=${baseline.p95.toFixed(3)}ms p99=${baseline.p99.toFixed(3)}ms min=${baseline.min.toFixed(3)}ms max=${baseline.max.toFixed(3)}ms`);
  console.log(`  cpu  avgUser=${baseline.avgCpuUserMs.toFixed(3)}ms avgSys=${baseline.avgCpuSysMs.toFixed(3)}ms totalCpu~${(baseline.avgCpuUserMs + baseline.avgCpuSysMs).toFixed(3)}ms`);
  console.log(`  payload avgBytes=${baseline.avgBytes} (~${(baseline.avgBytes/1024).toFixed(2)} KiB)`);
  console.log("");

  const perScrapeCpu = baseline.avgCpuUserMs + baseline.avgCpuSysMs;
  const perScrapeWall = baseline.avg;
  for (const interval of [15, 5, 1]) {
    const scrapesPerSec = 1 / interval;
    const cpuPerSecMs = perScrapeCpu * scrapesPerSec;
    const cpuPercent = (cpuPerSecMs / 1000) * 100;
    const wallPerSecMs = perScrapeWall * scrapesPerSec;
    console.log(`Interval ${interval}s: ${scrapesPerSec.toFixed(3)} scrapes/sec → cpu ${cpuPerSecMs.toFixed(4)}ms/sec (${cpuPercent.toFixed(4)}% of 1 core), wall ${wallPerSecMs.toFixed(4)}ms/sec`);
  }
  console.log("");

  const typicalApiMs = 30;
  for (const interval of [15, 5, 1, 0.5]) {
    const overlapProb = perScrapeWall / (interval*1000);
    const expectedExtraMs = overlapProb * perScrapeWall * 0.5;
    console.log(`API p50 baseline ${typicalApiMs}ms with ${interval}s scraping: overlap prob ${(overlapProb*100).toFixed(4)}% → expected p50 ~${(typicalApiMs + expectedExtraMs).toFixed(3)}ms (+${expectedExtraMs.toFixed(3)}ms)`);
  }
  console.log("");

  for (const c of [1, 2, 5, 10]) {
    const r = await simulateConcurrentScrapes(c, 30);
    console.log(`Concurrent scrapes x${c}: avg per-scrape ${r.avg.toFixed(3)}ms p95 ${r.p95.toFixed(3)}ms max ${r.max.toFixed(3)}ms`);
  }
  console.log("");

  console.log("=== Recommendation ===");
  const wall = baseline.avg;
  if (wall < 5 && perScrapeCpu < 5) {
    console.log(`Scrape cost is low (wall ${wall.toFixed(2)}ms, cpu ${perScrapeCpu.toFixed(2)}ms).`);
    console.log(`15s and 5s intervals impose <0.1% CPU overhead — safe for production.`);
    console.log(`1s interval still only ${(perScrapeCpu * 100 / 1000).toFixed(3)}% of 1 core and ${(perScrapeWall/1000*100).toFixed(3)}% wall blocking.`);
    console.log(`BUT: 1s scraping quadruples log volume and increases tail-latency risk under burst traffic.`);
    console.log(`Recommended minimum: 15s (default Prometheus). 5s acceptable for debug, 1s not recommended for production.`);
  } else if (wall < 20) {
    console.log(`Scrape cost moderate (wall ${wall.toFixed(2)}ms). Recommend 15s interval; 5s acceptable, 1s risky.`);
  } else {
    console.log(`Scrape cost HIGH (wall ${wall.toFixed(2)}ms) — likely large registry. Recommend 15s minimum, investigate label cardinality.`);
  }
  console.log("");
  console.log("Notes:");
  console.log("- updatePoolMetrics is 4x Gauge.set (microseconds) — negligible.");
  console.log("- registry.metrics() is async serialization; prom-client default metrics are cached per scrape, not per-second tick.");
  console.log("- No DB I/O on /metrics path (pool stats are in-memory).");
}

main().catch((e) => { console.error(e); process.exit(1); });
