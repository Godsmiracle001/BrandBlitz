# Question Regeneration Concurrency Investigation

**Date:** 2026-09-23  
**Endpoint:** `POST /brands/:id/questions/:questionId/regenerate` (`apps/api/src/routes/brands.ts:439`)  
**Method:** Synthetic concurrent load via `scripts/benchmark-regenerate.ts` (10, 50, 200 concurrent requests across brands)

## Question
Does concurrent `regenerate` across brands create a bottleneck or hit external rate limits?

## Handler analysis

```ts
// apps/api/src/routes/brands.ts:439
router.post("/:id/questions/:questionId/regenerate", authenticate, async (req,res) => {
  // 1. getBrandById (1 query)
  // 2. SELECT challenge_questions WHERE id = $1 (1 query)
  // 3. getActiveDistractorBrands (1 query)
  // 4. generateChallengeQuestions (CPU: shuffle + pickDistractors)
  // 5. deleteChallengeQuestion (1 query)
  // 6. insertChallengeQuestion (1 query)
})
```

- **No external generation service.** `generateChallengeQuestions` and `generateQuestionPreview` in `apps/api/src/services/questions.ts` are pure local functions (shuffle, pick 3 distractors, fallbacks). No HTTP call, no shared external rate limit.
- **No rate limiter** on this route (unlike `POST /:id/questions/preview` which uses `questionPreviewLimiter`).
- **DB pool:** `pg.Pool` with `DB_POOL_MAX=10` (default), `connectionTimeoutMillis=5s`, `idleTimeoutMillis=30s`. Each request holds a connection per query sequentially, ~4 queries × 5 ms = 20 ms pool time.

## Measurements

### Pure CPU generation (no DB)

5000 iterations of `generateChallengeQuestions("challenge", brand, distractors)`:

| Metric | Value |
|--------|-------|
| avg | 0.021 ms |
| p50 | 0.015 ms |
| p95 | 0.032 ms |
| p99 | 0.106 ms |
| min / max | 0.012 ms / 0.718 ms |

**Conclusion:** CPU is *not* a bottleneck. Even 200 concurrent generations consume <5 ms total event-loop time.

### Full handler with DB pool simulation

Simulated pool: max 10, 5 ms per query, 4 queries per request (20 ms DB + 0.02 ms CPU). Measured per-request wall latency.

| Concurrency | avg | p50 | p95 | p99 | max | Total wall | Throughput | Errors | Throttled (waiting>5) | Diagnosis |
|-------------|-----|-----|-----|-----|-----|------------|------------|--------|------------------------|-----------|
| **10** | 20.70 ms | 20.73 ms | 20.87 ms | 20.87 ms | 20.87 ms | 21.23 ms | 471 req/s | 0 | 0 | pool ok |
| **50** | 93.08 ms | 92.67 ms | **104.55 ms** | 104.62 ms | 104.62 ms | 104.78 ms | 477 req/s | 0 | 34 | **pool bottleneck** |
| **200** | 371.30 ms | 371.19 ms | **418.41 ms** | 423 ms | 423.04 ms | 423.23 ms | 473 req/s | 0 | 184 | **pool bottleneck** |

Preview endpoint (CPU-only, rate-limited) for comparison:

| Concurrency | avg | p95 | max | total |
|-------------|-----|-----|-----|-------|
| 10 | 0.040 ms | 0.179 ms | 0.179 ms | 0.55 ms |
| 50 | 0.022 ms | 0.028 ms | 0.240 ms | 1.14 ms |
| 200 | 0.018 ms | 0.028 ms | 0.041 ms | 3.78 ms |

Preview shows no DB dependency, so it scales linearly even at 200.

### Error / throttle rate

- **No shared external rate limit** to hit — generation is local, so error rate = 0 in CPU simulation.
- **DB pool is shared bottleneck.** At 50 concurrent, `pool.waitingCount` ≈ 40; at 200, ≈190 waiting. p95 latency grows linearly with `concurrency / pool_max`. With real Postgres (network + query planning ~10-20 ms vs 5 ms mock), tail latencies would be higher and `connectionTimeoutMillis=5s` could be hit, returning failures.
- Measured throttled≈34 at 50, 184 at 200 (requests that queued behind >5 waiting). No 429s currently because no limiter; failures would be pool timeouts, not rate-limit errors.

## Bottleneck identification

**Bottleneck = PostgreSQL connection pool (`DB_POOL_MAX`), NOT external service, NOT CPU, NOT connection pool of external API.**

Evidence:

- CPU per request 0.02 ms → not bottleneck.
- No external HTTP call → no shared rate limit.
- Pool waiting grows exactly as `concurrency - pool_max` when `concurrency > 10`. At 10, no queue; at 50/200, queue dominates latency.
- 200 burst from single user can starve pool for other API routes (e.g., `GET /brands`, `POST /brands/challenges`).

## Recommendation

**Safe concurrency is ≤ pool size (10). 50 needs limiter, 200 must be queued.**

### Immediate (code)

1. **Add rate limiter** to regenerate route:
   ```ts
   import { regenerateLimiter } from "../middleware/rate-limit"; // new: 10 req/min per user, burst 5
   router.post("/:id/questions/:questionId/regenerate", authenticate, regenerateLimiter, async ...);
   ```
   Reuse existing `apiLimiter` pattern (Redis-backed, fail-open). Return 429 with `Retry-After`.

2. **Per-brand queue / concurrency cap:** Use `p-limit(5)` or BullMQ queue (`concurrency: 5`) for regenerations globally. If limit hit, return 429 immediately instead of queuing in pg pool.

3. **Client backoff:** UI should disable regenerate button for 2 s after click; on 429, exponential backoff `100ms * 2^n + jitter` up to 5 retries.

4. **DB transaction batching:** Wrap `deleteChallengeQuestion + insertChallengeQuestion` in single transaction to reduce pool hold from 2 queries to 1 (≈5 ms saved).

### Observability

5. Monitor `db_pool_waiting_clients` gauge (already exported to `/metrics`) — alert if `waiting >5` for >30 s.
6. Add `regenerate_duration_seconds` histogram and `regenerate_throttled_total` counter.

### Load testing

7. Validate with k6: `200 VU` with limiter should keep p95 <100 ms; without limiter, expect p95 >300 ms and 5 s timeouts under sustained load.

### Safe thresholds

- **10 concurrent:** Safe, no action needed.
- **50 concurrent:** Needs per-user limiter (10/min) to keep p95 <50 ms.
- **200 concurrent:** Must be queued/throttled — otherwise pool exhaustion degrades all API routes.

## Reproduction

```bash
npx tsx scripts/benchmark-regenerate.ts
```

Script mocks pool with 10 max, 5 ms per query, and measures `generateChallengeQuestions` CPU. For real DB test, run against staging Postgres with `k6 run tests/load/regenerate.js`.

## Conclusion

Regeneration does **not** hit external rate limits — bottleneck is the **shared DB connection pool**. Without a limiter, 50+ concurrent requests cause queue-driven tail latency; 200 causes visible degradation. Add `regenerateLimiter` and a small concurrency queue (5) to make the endpoint safe at all tested levels.
