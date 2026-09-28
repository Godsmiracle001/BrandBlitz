# RFC 1253: Consolidate Redis connection configuration into named presets

## Problem Statement

`apps/api/src/lib/redis.ts` constructs a single `ioredis` client with
`maxRetriesPerRequest: null` — a setting BullMQ *requires* (it manages its own retry
behavior; ioredis's own bounded retry logic conflicts with BullMQ's if left enabled).
`apps/api/src/lib/cache.ts` and every queue file in `apps/api/src/queues/` (`payout`,
`gdpr-erasure`, `referral-bonus`, `leaderboard-refresh`, `recurring-challenges`,
`league`, `archive`, `session-timeout` — 8 files, not 7; `archive.queue.ts` and
`leaderboard-refresh.queue.ts` each construct a Worker with a second `connection: redis`
too) all import and reuse this same `redis` export.

**Correcting the premise:** on inspection, these do **not** currently construct
*independent* connection options that could drift apart from each other — every one of
them imports the same singleton and passes `connection: redis` (or calls `redis.get`/
`redis.set` directly, in `cache.ts`'s case). There's no risk today of one queue silently
picking a different `maxRetriesPerRequest` than another.

The actual drift risk runs the other way: **one shared config, correct for BullMQ, applied
unconditionally to the cache client too.** `maxRetriesPerRequest: null` tells ioredis
"never give up retrying a command, let the caller (BullMQ) decide" — appropriate for a
queue where BullMQ owns retry/backoff. For `cache.ts`'s `cached()` (a stampede-protected
GET/SET wrapper with its own short lock TTL and poll loop), an indefinitely-retrying
Redis command on a connection blip means a cache read can hang far longer than the
`WAIT_TOTAL_MS` (500ms) the stampede-protection logic assumes as its own bound — the two
layers' timeout assumptions don't currently line up, because both cache and queue traffic
share one connection-options object that was tuned for the queue use case only.

## Current State

### Where Redis connection options are constructed today

```
apps/api/src/lib/redis.ts
└── export const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,  // required by BullMQ
      enableReadyCheck: false,
      lazyConnect: true,
    });
```

Every other consumer imports this same instance — none construct their own options:

| File | Usage |
| --- | --- |
| `lib/cache.ts` | `redis.get`/`redis.set`/`redis.del` directly (the `cached()` stampede-protection wrapper) |
| `queues/payout.queue.ts` | `connection: redis` (Queue + Worker) |
| `queues/gdpr-erasure.queue.ts` | `connection: redis` (Worker, via `gdprErasureWorkerOptions`) |
| `queues/referral-bonus.queue.ts` | `connection: redis` |
| `queues/leaderboard-refresh.queue.ts` | `connection: redis` (Queue + a second Worker `connection: redis` at a separate call site) |
| `queues/recurring-challenges.queue.ts` | `connection: redis` |
| `queues/league.queue.ts` | `connection: redis` |
| `queues/archive.queue.ts` | `connection: redis` (Queue + a second Worker `connection: redis` at a separate call site) |
| `queues/session-timeout.queue.ts` | `connection: redis` |
| `stellarSequenceStore` (also in `redis.ts`) | `redis.get`/`set`/`del`/`incr` — a third, unrelated consumer (Stellar sequence-number coordination, not caching or queueing) |

### Why BullMQ needs different options than the cache client

- **BullMQ (`maxRetriesPerRequest: null`)**: BullMQ's own `Worker`/`Queue` classes issue
  blocking commands (`BLPOP`-style waits for new jobs) and manage reconnection/backoff
  themselves. ioredis's default bounded retry count fights with this — BullMQ's own docs
  require `null` here, and ioredis will throw at construction time if a `Queue`/`Worker`
  is given a connection where this isn't set correctly.
- **Cache client (bounded retries desired)**: `cached()`'s `GET`/`SET`/`DEL` calls are
  synchronous request/response operations behind a request-scoped timeout budget, not a
  long-lived blocking wait. A bounded retry count (or none at all — failing fast to the
  loader/DB) fits the stampede-protection design's own `WAIT_TOTAL_MS`/`POLL_INTERVAL_MS`
  assumptions far better than "retry forever."
- **`enableReadyCheck: false`**: also a BullMQ-motivated setting (avoids delaying
  command execution until Redis's `CLUSTER`/`INFO` ready-check completes) with no
  particular benefit for simple cache GET/SET calls, though also no clear harm — worth
  keeping consistent unless profiling says otherwise.

## Proposed Architecture

### One module, two named presets

Create `apps/api/src/lib/redis-connection-options.ts`:

```typescript
import type { RedisOptions } from "ioredis";

/**
 * BullMQ requires maxRetriesPerRequest: null (it owns retry/backoff itself) and
 * benefits from enableReadyCheck: false (no need to block command dispatch on a
 * cluster-ready check for a worker that's about to block-wait on jobs anyway).
 */
export const bullmqConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * The cache client answers request-scoped GET/SET/DEL calls under cached()'s own
 * WAIT_TOTAL_MS budget — a bounded retry count that fails fast to the loader/DB
 * fits that design better than BullMQ's "retry forever."
 */
export const cacheConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
};
```

### `redis.ts` becomes two clients (or one client + one preset export, see Open Questions)

```typescript
// apps/api/src/lib/redis.ts
import { Redis } from "ioredis";
import { bullmqConnectionOptions, cacheConnectionOptions } from "./redis-connection-options";
import { config } from "./config";

// BullMQ queues/workers, and the Stellar sequence store (uses simple GET/SET/INCR
// but is coordination state, not a cache -- keeping it on the BullMQ-tuned client is
// the more conservative choice; see Open Questions).
export const redis = new Redis(config.REDIS_URL, {
  ...bullmqConnectionOptions,
  lazyConnect: true,
});

// Cache-specific client, same REDIS_URL, different retry/ready-check behavior.
export const cacheRedis = new Redis(config.REDIS_URL, {
  ...cacheConnectionOptions,
  lazyConnect: true,
});
```

`cache.ts` switches its three `redis.get`/`redis.set`/`redis.del` calls to `cacheRedis`.
Every queue file's `connection: redis` is unchanged.

### Trade-off: one physical connection vs two

This does mean two TCP connections to Redis instead of one. Given this is a single
shared-hosted Redis instance already serving 8 queue workers plus cache traffic plus the
Stellar sequence store, two long-lived connections from the API process is a small,
fixed cost — not per-request, not per-tenant. If connection count becomes a real
constraint later (e.g. moving to Redis Cluster with per-node connection limits), the
named-preset module still lets that decision be revisited without touching every call
site again — it's the one thing every consumer would need to change either way.

## Observability Gaps This Consolidation Could Close

- **No current metric distinguishes cache-client vs BullMQ-client Redis errors.** The
  single `redis.on("error", ...)` handler in `redis.ts` logs every failure identically —
  once there are two clients, error logs should include which preset/client they came
  from, so an on-call engineer can tell "cache is degraded, requests are falling through
  to the DB loader" apart from "a queue worker lost its connection, jobs are backing up."
- **`startRedisEvictionMonitor`'s `evicted_keys` polling only watches one client's view**
  of Redis `INFO stats` today; since both clients point at the same physical Redis
  instance this doesn't need duplicating, but the alert copy should clarify it reflects
  the whole instance, not just the BullMQ connection, once a reader might assume
  otherwise from two client names existing.
- **No per-preset connection-pool/retry metrics** (e.g. `cache_redis_retry_total` vs
  `bullmq_redis_retry_total`) exist today because there's only one client to attribute
  errors to. Splitting the client is a prerequisite for ever being able to tell these
  apart, even if adding the metrics themselves is separate follow-up work.

## Benefits

1. **Correctness**: the cache client stops silently inheriting a retry-forever setting
   that was never chosen for it, tuned instead for BullMQ's blocking-wait workers.
2. **Documented intent**: `redis-connection-options.ts` is a single place that states,
   in one comment each, *why* BullMQ and the cache client need different settings —
   currently that reasoning lives only in a one-line comment in `redis.ts` and nowhere
   explains the cache side of the trade-off at all.
3. **Foundation for observability**: distinguishing the two clients is what makes it
   possible to later attribute errors/retries to "cache" vs "queue" traffic.
4. **No behavior change for the 8 queue files**: they keep importing `redis` and passing
   `connection: redis` exactly as today — only `cache.ts` and `redis.ts` itself change.

## Open Questions

1. Should `stellarSequenceStore` (Stellar sequence-number coordination via
   `redis.get`/`set`/`del`/`incr`) stay on the BullMQ-tuned `redis` client, or does it
   deserve its own preset? It's simple request/response like the cache client, but it's
   coordination state (an incorrect/stale sequence number has correctness implications
   for on-chain transaction submission) rather than a cache that can safely fall through
   to a DB loader on failure — a case could be made either way. This RFC defaults to
   leaving it on `redis` (the more conservative, "don't touch working code" choice)
   pending discussion.
2. Is a second physical connection to Redis acceptable given the current hosting setup,
   or does this need to be one client with per-command option overrides instead (ioredis
   supports per-command retry via `.retryDelayOnFailover`-style options, though not as
   cleanly as two separate clients)? The Trade-off section above assumes two connections
   is fine; worth a quick check against however Redis is currently provisioned/sized in
   `docs/infrastructure/redis.md` before implementation.
3. Should `enableReadyCheck` actually differ between the two presets, or was that
   BullMQ-motivated setting harmless enough for the cache client too (i.e. should the
   presets differ only in `maxRetriesPerRequest`)? Flagged as a difference worth
   verifying empirically rather than asserting confidently in this RFC.

## References

- Current files:
  - `apps/api/src/lib/redis.ts`
  - `apps/api/src/lib/cache.ts`
  - `apps/api/src/queues/*.queue.ts` (8 files)
- Related: `docs/infrastructure/redis.md` (if present — operational background on the
  Redis instance itself, referenced but not read in depth for this RFC)
