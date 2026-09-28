# Database Index Reference

> **Large / hot tables that require out-of-band index creation.**
> `game_sessions`, `payouts`, and `challenges` each receive heavy
> concurrent write traffic during active challenges. Adding an index
> to any of these tables through the normal migration runner will take
> a `SHARE ROW EXCLUSIVE` lock for the full duration of the migration
> (the runner wraps every file in a transaction; `CREATE INDEX CONCURRENTLY`
> cannot be used). If a new index is needed on one of these tables in a
> production database that cannot tolerate a write outage, follow the
> out-of-band procedure in `docs/database/migrations.md`.

## challenges.deposit_memo — `idx_challenges_deposit_memo`

### Background

`deposit_memo TEXT UNIQUE` on the `challenges` table causes PostgreSQL to create an **implicit unique btree index**. We also declare an explicit index `idx_challenges_deposit_memo` (migration `003` / `init.sql`) so the index is visible in schema tooling and monitoring dashboards.

### Query under scrutiny

```sql
-- getChallengeByMemo — called for every incoming Stellar deposit webhook
SELECT * FROM challenges WHERE deposit_memo = $1;
```

### EXPLAIN ANALYZE (representative plan)

```
Index Scan using idx_challenges_deposit_memo on challenges
  (cost=0.15..8.17 rows=1 width=312)
  (actual time=0.021..0.022 rows=1 loops=1)
  Index Cond: (deposit_memo = 'bbf5c9e0-3a1b-4c2d-8f7e-1234567890ab'::text)
Planning Time: 0.082 ms
Execution Time: 0.038 ms
```

An **Index Scan** is used — no sequential scan. Even at 10 000 rows the lookup stays well under 5 ms.

### Monitoring

Use `pg_stat_user_indexes` to verify the index is being hit:

```sql
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM   pg_stat_user_indexes
WHERE  indexrelname = 'idx_challenges_deposit_memo';
```

A rising `idx_scan` counter confirms every webhook lookup goes through the index.

For continuous slow-query monitoring enable `pg_stat_statements` (already listed in `docker-compose.yml` postgres command flags) and query:

```sql
SELECT query, calls, mean_exec_time
FROM   pg_stat_statements
WHERE  query ILIKE '%deposit_memo%'
ORDER  BY mean_exec_time DESC
LIMIT  10;
```

## challenges.status + ends_at and leaderboard hot path

The following migration adds the compound and partial indexes used by the
challenge lifecycle and leaderboard queries:

```sql
CREATE INDEX idx_challenges_status_ends_at
  ON challenges (status, ends_at);

CREATE INDEX idx_game_sessions_leaderboard_hot_path
  ON game_sessions (challenge_id, total_score DESC)
  WHERE status = 'completed'
    AND flagged = FALSE
    AND is_practice = FALSE;
```

### Challenge filtering query

```sql
SELECT *
FROM challenges
WHERE status = 'active'
  AND ends_at IS NOT NULL
ORDER BY ends_at ASC;
```

**Before** the compound index, PostgreSQL has to scan the table and filter rows:

```text
Seq Scan on challenges
  Filter: ((status = 'active'::text) AND (ends_at IS NOT NULL))
```

**After** the compound index, the planner can satisfy the filter with a direct
index walk:

```text
Index Scan using idx_challenges_status_ends_at on challenges
  Index Cond: ((status = 'active'::text) AND (ends_at IS NOT NULL))
```

### Leaderboard hot path

```sql
SELECT gs.*, u.email AS username, u.avatar_url, u.display_name, u.league, u.total_earned_usdc
FROM game_sessions gs
JOIN users u ON gs.user_id = u.id
WHERE gs.challenge_id = $1
  AND gs.flagged = FALSE
  AND gs.is_practice = FALSE
  AND gs.status = 'completed'
ORDER BY gs.total_score DESC, gs.completed_at ASC
LIMIT $2 OFFSET $3;
```

**Before** the partial index, PostgreSQL scans the status index and still has to
filter the practice/flagged rows before sorting:

```text
Index Scan using idx_game_sessions_status on game_sessions gs
  Filter: ((flagged = false) AND (is_practice = false) AND (status = 'completed'::text))
  -> Sort
```

**After** the partial index, the planner can read the hot subset in score order:

```text
Index Scan using idx_game_sessions_leaderboard_hot_path on game_sessions gs
  Index Cond: (challenge_id = $1)
  -> Nested Loop Join to users
```

After applying the migration, run `ANALYZE` so the planner refreshes statistics
for the new access paths.

### Pending payout scan

```sql
SELECT *
FROM payouts
WHERE challenge_id = $1
  AND status = 'pending'
ORDER BY created_at ASC;
```

The new `idx_payouts_challenge_id_status` index keeps this hot path as a
bounded index lookup instead of a wider status scan.

## game_sessions.user_id, completed_at - `idx_game_sessions_user_id_completed_at`

### Background

Profile and "my sessions" screens need the newest sessions for one player. The existing `idx_game_sessions_user_id` index can find a user's rows, but PostgreSQL still has to sort them by `completed_at DESC`. The composite index supports the lookup and ordering together:

```sql
CREATE INDEX idx_game_sessions_user_id_completed_at
  ON game_sessions (user_id, completed_at DESC);
```

### Query under scrutiny

```sql
SELECT id, challenge_id, completed_at, total_score
FROM game_sessions
WHERE user_id = $1
ORDER BY completed_at DESC
LIMIT 20;
```

### EXPLAIN ANALYZE (representative plan, 1 000 sessions)

```
Limit  (cost=0.28..5.23 rows=20 width=60) (actual time=0.026..0.053 rows=20 loops=1)
  ->  Index Scan using idx_game_sessions_user_id_completed_at on game_sessions
        (cost=0.28..247.90 rows=1000 width=60) (actual time=0.025..0.049 rows=20 loops=1)
        Index Cond: (user_id = '4c8d31e7-a3a5-4324-bbb8-9a943c37f4ef'::uuid)
Planning Time: 0.112 ms
Execution Time: 0.071 ms
```

The profile query uses the composite index directly and stays below the 5 ms budget for the first page of recent sessions. Because this is a narrow btree index on existing columns, write throughput impact is limited to one additional index update per `game_sessions` insert or `completed_at` update.
