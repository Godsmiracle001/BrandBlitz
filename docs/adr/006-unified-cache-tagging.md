# ADR 006: Unified Cache Tagging Scheme for Redis and Next.js Cache Invalidation

## Status

Proposed

## Context

Leaderboard data is cached on two layers: the API (Redis via `apps/api/src/lib/cache.ts`) and the web layer (Next.js cache tags via `apps/api/src/lib/cache-tags.ts`). The two systems use separate, independently-managed key/tag naming conventions with no shared constants or generation function. When a cache key format changes in one layer, the other layer may silently diverge, causing incorrect cache invalidations or stale data.

Example: `apps/api/src/routes/leaderboard.ts` constructs Redis keys as `leaderboard:global:${sortBy}:${limit}` and `leaderboard:${sortBy}:${challengeId}:${limit}:${cursor}:${scopeKey}`, while `apps/api/src/lib/cache-tags.ts` defines invalidation patterns as `leaderboard:*` and `challenges:active:*`. A reviewer cannot easily verify that the Redis key scheme matches the Next.js tag invalidation without reading multiple files and understanding both caching layers.

## Decision

Define a single canonical cache key/tag naming scheme in a shared constants module (`apps/api/src/lib/cache-keys.ts`) that both the Redis caching layer and the revalidation webhook can import and use.

- Export named constants or functions to generate cache keys: `LEADERBOARD_KEYS = { global: (sortBy, limit) => ..., challenge: (sortBy, challengeId, limit, cursor, scopeKey) => ... }`
- Use the same key format for both Redis `withCoalescing` calls and Next.js cache-tag invalidation patterns
- Update `cache-tags.ts` to import and use these constants in invalidation patterns
- Update `leaderboard.ts` to import and use these constants instead of constructing keys inline
- Document the convention in the module's header comment so future changes to key format happen in one place

## Rationale

- **Single source of truth**: both layers reference the same key-generation logic, preventing silent mismatches
- **Verifiability**: reviewers can inspect the constants module and confirm that invalidation covers all cache keys
- **Maintainability**: changing a key format requires one change, not three, reducing the risk of incomplete updates
- **Discoverability**: contributors encounter the naming convention immediately when working with caching code

## Consequences

- Requires a new `cache-keys.ts` module with key-generation functions
- `leaderboard.ts` and `cache-tags.ts` both gain imports; negligible runtime cost
- Future cache additions (challenges, user profiles) can reuse the same pattern
- Cache tag invalidation patterns must stay aligned with key-generation logic; this is now enforced by imports, not convention
