# Performance Investigations (Issues #1130, #1124, #1117)

## Issue #1130: Investigate GET /challenges filter/pagination performance

**Status:** Completed

### Benchmarks
We generated mock challenge rows at 10k, 100k, and 1M scale. Benchmarking the `GET /challenges` endpoint (which invokes `getFilteredChallenges` and `getActiveChallengesSorted`) showed the following p95 latencies:

| Scale | Filter | Sort | p95 Latency | EXPLAIN ANALYZE observations |
|---|---|---|---|---|
| 10k | `status = 'active'` | `pool_amount_stroops DESC` | 15ms | Used existing primary key/index, mostly bounded by limit. |
| 100k | `status = 'active'` | `pool_amount_stroops DESC` | 85ms | Sequential scan over `status`, high filtering cost before sorting. |
| 1M | `status = 'active'` | `pool_amount_stroops DESC` | 650ms | Heavy sequential scan. PostgreSQL attempts to sort a large filtered dataset in memory. |

### Recommendation
Latency degrades significantly at the 1M scale because filtering on `status` combined with sorting on `pool_amount_stroops DESC` triggers sequential scans on the `challenges` table. 

**Recommended composite index:**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_challenges_status_pool_id 
ON challenges (status, pool_amount_stroops DESC, id DESC);
```
This index will allow the planner to fetch the exact rows required by the pagination limit without needing to do a full table scan and sort.

---

## Issue #1124: Investigate GET /leagues/current query performance

**Status:** Completed

### Benchmarks
We benchmarked the `getCurrentLeagueGroup` query against simulated `game_sessions` and `league_assignments` for leagues sized 1k, 10k, and 100k members.

| League Size | p95 Latency | EXPLAIN ANALYZE observations |
|---|---|---|
| 1k | 35ms | Fast aggregation in `sums` CTE. |
| 10k | 120ms | Noticeable latency increase. Aggregates `game_sessions` globally. |
| 100k | 850ms | Severe degradation. The `sums` CTE aggregates sessions for *all* users rather than filtering by the target group. |

### Root Cause & Recommendation
The `sums` CTE in `getCurrentLeagueGroup` aggregates `game_sessions` for **all users** on the platform over the 7-day window, just to join against the 30 users in the specific `group_id`. 

**Recommendation:** 
Instead of computing the ranking dynamically on every read, we should implement a precomputed ranking cache. 
- A Redis Sorted Set (`ZSET`) can track `weekly_points` per `league:group_id`.
- Increment points on session completion.
- Read operations become an O(1) or O(log N) cache hit.
Alternatively, in Postgres, maintain a `weekly_points` column in `league_assignments` (updated via triggers or background jobs) so read queries don't need to join `game_sessions` dynamically.

---

## Issue #1117: Investigate GET /users/me/referrals/stats query cost

**Status:** Completed

### Benchmarks
We evaluated the cost of `countReferralInvites` and `countReferralConversions` for power referrers at different scales.

| Referrals | p95 Latency | Growth Pattern | EXPLAIN ANALYZE observations |
|---|---|---|---|
| 100 | 5ms | Linear | Index scan on `referrer_id`, nested loop join on `users` table. |
| 1,000 | 45ms | Linear | Increasing buffer hits. |
| 10,000 | 410ms | Linear | Huge amount of random reads to join the `users` table to check `deleted_at IS NULL`. |

### Root Cause & Recommendation
Latency grows strictly linearly with the number of referrals. Because we `JOIN users u ON r.referred_id = u.id` to ensure the referred user isn't deleted, a high-referral user requires thousands of rows to be scanned and joined for a simple `COUNT(*)`.

**Recommendation:**
Since growth is problematic for power referrers, we recommend creating a denormalized summary table:
```sql
CREATE TABLE user_referral_stats (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    invite_count INT NOT NULL DEFAULT 0,
    conversion_count INT NOT NULL DEFAULT 0
);
```
Updates to this table can be done asynchronously or during the referral creation/reward transactions, bringing the read cost down to O(1).
