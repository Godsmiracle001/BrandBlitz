#!/usr/bin/env node

/**
 * Reproducible probe for issues #1115, #1116, #1121 and #1122.
 * Run only against local or approved staging environments.
 */
const baseUrl = process.env.BRANDBLITZ_API_BASE_URL || "http://localhost:3000";
const token = process.env.BRANDBLITZ_AUTH_TOKEN || "";
const concurrency = (process.env.BRANDBLITZ_CONCURRENCY || "1").split(",").map(Number);
const requests = Number(process.env.BRANDBLITZ_REQUESTS || 100);
const path = process.env.BRANDBLITZ_PATH || "/config";
const method = process.env.BRANDBLITZ_METHOD || "GET";
const body = process.env.BRANDBLITZ_BODY;
const ratePerMinute = Number(process.env.BRANDBLITZ_RATE_PER_MINUTE || 0);

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};

async function run(level) {
  const latencies = [];
  const statuses = {};
  const cacheHeaders = {};
  let next = 0;
  let failedRequests = 0;
  const started = performance.now();
  async function worker() {
    while (next < requests) {
      const requestNumber = next;
      next += 1;
      if (ratePerMinute > 0 && requestNumber > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, (requestNumber * 60_000) / ratePerMinute),
        );
      }
      const start = performance.now();
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      }).catch(() => null);
      latencies.push(performance.now() - start);
      const status = response?.status ?? 0;
      if (status === 0) failedRequests += 1;
      statuses[status] = (statuses[status] || 0) + 1;
      const cache = response?.headers.get("x-cache");
      if (cache) cacheHeaders[cache] = (cacheHeaders[cache] || 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: level }, worker));
  const elapsedMs = performance.now() - started;
  return {
    concurrency: level,
    requests,
    ratePerMinute: ratePerMinute || null,
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: Math.round((requests / elapsedMs) * 1000 * 100) / 100,
    p50Ms: Math.round(percentile(latencies, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(latencies, 0.95) * 100) / 100,
    p99Ms: Math.round(percentile(latencies, 0.99) * 100) / 100,
    maxMs: Math.round(Math.max(...latencies, 0) * 100) / 100,
    rateLimitRejections: statuses[429] || 0,
    failedRequests,
    statuses,
    cacheHeaders,
  };
}

console.log(JSON.stringify({ endpoint: `${method} ${new URL(path, baseUrl)}`, results: await Promise.all(concurrency.map(run)) }, null, 2));
