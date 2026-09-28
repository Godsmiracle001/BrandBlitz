# Metrics Endpoint Overhead Investigation

**Date:** 2026-09-23  
**Endpoint:** `GET /metrics` (`apps/api/src/routes/metrics.ts`)  
**Registry:** `prom-client` 15.1.3 with `collectDefaultMetrics` + 4 gauges (`db_pool_*`)  
**Method:** Isolated benchmark via `scripts/benchmark-metrics.ts` (200 iterations, `registry.metrics()` + `updatePoolMetrics()`)

## Question
Does Prometheus scraping at short intervals add measurable overhead to the API process under production traffic?

## Measurements

### Per-scrape cost (single scrape, 200 samples)

| Metric | Value |
|--------|-------|
| wall avg | **0.87 ms** |
| p50 | 0.81 ms |
| p95 | 1.32 ms |
| p99 | 1.70 ms |
| min / max | 0.61 ms / 1.81 ms |
| CPU user avg | 1.15 ms |
| CPU sys avg | 0.08 ms |
| total CPU avg | **1.23 ms** |
| payload | 7.45 KiB (7,632 bytes) |

`updatePoolMetrics()` itself is 4× `Gauge.set()` — microseconds, negligible. Cost is dominated by `registry.metrics()` serialization (prom-client iterates all collectors and formats text).

### CPU overhead vs scrape interval

| Interval | Scrapes/sec | CPU ms/sec | % of 1 core | Wall ms/sec |
|----------|-------------|------------|-------------|-------------|
| 15 s (default) | 0.067 | 0.082 | **0.008 %** | 0.058 |
| 5 s | 0.200 | 0.246 | 0.025 % | 0.174 |
| 1 s | 1.000 | 1.230 | 0.123 % | 0.867 |

Baseline with scraping disabled = 0 ms/sec.

### API latency impact (model)

Assume typical API handler p50 = 30 ms. Probability a request overlaps a scrape = `scrape_wall / interval`. Expected extra latency ≈ `overlapProb * scrape_wall * 0.5`.

| Interval | Overlap prob | Expected p50 | Delta |
|----------|--------------|--------------|-------|
| 15 s | 0.0058 % | 30.000 ms | +0.000 ms |
| 5 s | 0.017 % | 30.000 ms | +0.000 ms |
| 1 s | 0.087 % | 30.000 ms | +0.000 ms |
| 0.5 s | 0.174 % | 30.001 ms | +0.001 ms |

Even at 1 s interval, expected p50 increase is <1 µs — unmeasurable in production noise.

### Concurrent scrapes (HA Prometheus)

| Concurrency | avg per-scrape | p95 | max |
|-------------|----------------|-----|-----|
| 1 | 0.87 ms | 1.25 ms | 1.29 ms |
| 2 | 0.88 ms | 1.20 ms | 1.36 ms |
| 5 | 0.76 ms | 1.08 ms | 1.10 ms |
| 10 | 0.75 ms | 0.98 ms | 0.99 ms |

No degradation — serialization is per-request, no shared lock.

## Comparison to baseline (scraping disabled)

Baseline CPU = 0. Scraping at 15 s adds 0.008 % of one core; at 1 s adds 0.12 %. Both are orders of magnitude below typical 30-50 % API utilization. Memory impact is transient 7 KiB string per scrape, GC'd immediately.

Under burst traffic (100 RPS), 1 s scraping increases tail latency only when a request happens to queue behind the event-loop block of `registry.metrics()` (~0.9 ms). This is within normal variance and not distinguishable from GC jitter.

## Bottleneck analysis

- **No DB I/O** on `/metrics` — `pool.totalCount` etc. are in-memory.
- **No external rate limit** — pure in-process.
- **Cardinality risk:** If label cardinality grows (e.g., per-brand gauges with unbounded labels), payload and serialization time will grow linearly. Current 4 gauges with no labels is minimal.

## Recommendation

**Safe minimum scrape interval: 15 s (Prometheus default).**

- **15 s:** Safe for production, negligible overhead, matches `docs/deployment` SLOs. Keep as default.
- **5 s:** Acceptable for debugging / staging, still <0.03 % CPU. Use only temporarily.
- **1 s:** Not recommended for production. Although measured overhead is low, it quadruples network/log volume, doubles scrape timeout risk, and provides no extra alerting value. If 1 s is required (e.g., high-resolution autoscaling), benchmark with production label cardinality first — if payload stays <50 KiB and p95 <5 ms, 5 s is the lowest safe bound.

**Actions:**

1. Keep `GET /metrics` unauthenticated but consider adding `Cache-Control: no-cache` (already implicit).
2. Add scrape-time histogram metric (`metrics_scrape_duration_seconds`) to monitor regressions if label cardinality increases.
3. If scrape latency exceeds 10 ms p95, investigate new gauges with high cardinality.

## Reproduction

```bash
npx tsx scripts/benchmark-metrics.ts
# or: pnpm --filter @brandblitz/api bench for stellar benchmark comparison
```

Script uses absolute `prom-client` path to avoid pnpm symlink issues in CI.

## Conclusion

Metrics collection overhead is **not measurable** at 15 s or 5 s intervals vs disabled, and remains negligible at 1 s. The endpoint is safe to scrape at 15 s indefinitely. No code change required.
