# High-Volume Performance Investigation Plan

This plan captures the baseline investigation steps for the three highest-risk high-volume paths: long-tenured user history, repeated deposit-info polling, and referral bonus bursts.

## GET /users/me/history

Target file: `apps/api/src/routes/users.ts`

Measure history retrieval at these seeded sizes:

| Historical entries | Metrics to capture |
| --- | --- |
| 500 | p50, p95, p99 latency and response size |
| 5,000 | p50, p95, p99 latency, DB time, and memory use |
| 50,000 | p50, p95, p99 latency, query plan, and timeout/error rate |

Capture the underlying query plan with the same filters used by the endpoint. If latency grows linearly with the full history size, recommend cursor pagination and an index that matches the endpoint order/filter shape.

## GET /challenges/:id/deposit-info

Target file: `apps/api/src/routes/challenges.ts`

Simulate concurrent polling for active challenges at these levels:

| Concurrent polls | Metrics to capture |
| --- | --- |
| 50 | endpoint latency and Horizon/RPC calls per request |
| 200 | p95 latency, error rate, and upstream rate-limit headers |
| 1,000 | queueing, upstream failures, and duplicated lookup rate |

If repeated polling fans out to duplicate Horizon lookups for the same challenge, add a short-lived cached deposit-status layer keyed by challenge id and escrow address.

## Referral Bonus Queue Bursts

Target file: `apps/api/src/queues/referral-bonus.queue.ts`

Replay referral completion bursts over one hour:

| Burst size | Metrics to capture |
| --- | --- |
| 1,000 | queue lag and average completion time |
| 5,000 | p95 completion time and DB write contention |
| 20,000 | backlog drain time, retry count, and failed jobs |

If user balance updates become the bottleneck, evaluate bounded concurrency, grouped balance updates, or batching per referrer before increasing worker parallelism.

## Reporting Template

For each investigation, record:

- dataset size or concurrency level;
- p50, p95, and p99 latency;
- database query plan or queue lag evidence;
- upstream Stellar/Horizon rate-limit impact, when applicable;
- recommended index, pagination, caching, batching, or concurrency change.