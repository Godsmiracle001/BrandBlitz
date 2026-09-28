# Upload and admin endpoint performance investigations

This runbook provides repeatable measurements for issues #1115, #1116, #1121,
and #1122. It deliberately records observations instead of asserting numbers
that can only be obtained from a representative database, Redis, object store,
and authenticated staging environment.

## Probe

The dependency-free `scripts/perf/targeted-endpoint-probe.mjs` reports p50,
p95, p99, maximum latency, status distribution, throughput, and 429 counts.
Use a staging token and synthetic fixtures only:

```bash
BRANDBLITZ_API_BASE_URL=https://staging.example \
BRANDBLITZ_AUTH_TOKEN="$TOKEN" \
BRANDBLITZ_PATH=/upload/presign \
BRANDBLITZ_METHOD=POST \
BRANDBLITZ_BODY='{"type":"brand-logo","contentType":"image/png","contentLength":1024}' \
BRANDBLITZ_REQUESTS=1000 BRANDBLITZ_RATE_PER_MINUTE=100 \
BRANDBLITZ_CONCURRENCY=10 \
node scripts/perf/targeted-endpoint-probe.mjs > upload-presign.json
```

Repeat with `BRANDBLITZ_RATE_PER_MINUTE=500` and `1000`. The rate is applied
across the run, while `BRANDBLITZ_CONCURRENCY` caps in-flight workers. Use a
small request count for a smoke test and a full minute (or longer) for a stable
rate estimate. For `/upload/complete`, use valid, isolated test
uploads and `BRANDBLITZ_CONCURRENCY=10,50,200`. Record S3 timing, optimization
timing, and DB timing from structured logs for each run; the route currently
executes `HeadObject`, `optimizeImage`, and one resource update synchronously.

For `/config`, run `BRANDBLITZ_PATH=/config` at 1,000, 5,000, and 10,000
requests/minute by setting `BRANDBLITZ_RATE_PER_MINUTE` to each value. Capture
`X-Cache: HIT|MISS`, Redis latency, and database query latency. Repeat after
flushing `config:public` to measure the cold burst. A single-flight cache fill
should be considered if concurrent misses stampede.

## Admin stats query plans

Run each statement on a restored staging snapshot with representative data at
10x current row counts. Use `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`
and save the output with the test date, row counts, PostgreSQL version, and
`shared_buffers` settings. Use the same `since` value for all statements.

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT DATE(completed_at), COUNT(DISTINCT user_id)::int
FROM game_sessions
WHERE completed_at IS NOT NULL AND completed_at >= :since
GROUP BY DATE(completed_at) ORDER BY DATE(completed_at);

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT DATE(created_at), (SUM(amount_stroops) / 10000000)::numeric(20,7)
FROM payouts WHERE status IN ('sent', 'confirmed') AND created_at >= :since
GROUP BY DATE(created_at) ORDER BY DATE(created_at);

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT b.id, b.name, COUNT(gs.id)::int
FROM game_sessions gs JOIN challenges c ON gs.challenge_id = c.id
JOIN brands b ON c.brand_id = b.id
WHERE gs.status = 'completed' AND gs.completed_at >= :since
GROUP BY b.id, b.name ORDER BY COUNT(gs.id) DESC LIMIT 10;

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
SELECT (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL),
       (SELECT COALESCE(SUM(amount_stroops), 0) FROM payouts
        WHERE status IN ('sent', 'confirmed')),
       (SELECT COUNT(*) FROM game_sessions WHERE status = 'completed');
```

While stats runs, issue a representative production query on a separate
connection and compare p50/p95/p99 latency against an idle baseline. Measure
DB CPU, I/O, pool wait, and locks. If stats materially increases p95 or pool
wait, route read-only stats to a read replica first; if the replica cannot meet
the freshness requirement, pre-aggregate daily DAU, payout volume, and summary
counters asynchronously.

## Result template

For every endpoint and load level, attach JSON output plus:

| Field | Value |
| --- | --- |
| Fixture and row counts | |
| Cache state / TTL | |
| p50 / p95 / p99 | |
| 429 rate | |
| DB / Redis / S3 timings | |
| Production-query p95 delta | |
| Recommendation and evidence | |

Do not run these tests against production or save bearer tokens in reports.

## Pull request evidence

Attach the probe JSON and `EXPLAIN` output from the approved staging fixture to
the issue or pull request. Do not claim a bottleneck without a measured p95/p99
or a query plan showing the relevant scan, sort, join, lock, or pool wait. If
the environment cannot provide representative data, report that limitation and
keep the recommendation conditional.
