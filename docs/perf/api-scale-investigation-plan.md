# API Scale Investigation Plan

This runbook covers the four API performance investigations assigned around BrandBlitz user, profile, earnings, and brand onboarding traffic. It pairs the endpoint list with a lightweight probe script so maintainers can capture repeatable numbers before deciding whether to add indexes, pagination, caching, or request queueing.

## Scope

The investigation targets these paths:

- `GET /users/me/earnings` for long-tenured users with large payout and session history.
- `GET /users/search` for search latency as the users table grows.
- `GET /users/:username/public` for viral traffic to one public profile.
- `GET /brands/:id/questions/preview` for concurrent brand onboarding question generation.

The goal is not to guess at a final optimization too early. The goal is to make each endpoint measurable, compare behavior at realistic pressure levels, and leave a clear recommendation trail for the eventual code or infrastructure change.

## Probe script

A dependency-free Node script is available at `scripts/perf/api-scale-probe.mjs`. It uses built-in `fetch`, so it can run without adding a new package to the workspace.

Configuration is controlled through environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `BRANDBLITZ_API_BASE_URL` | API origin to probe | `http://localhost:3000` |
| `BRANDBLITZ_AUTH_TOKEN` | Bearer token for authenticated endpoints | empty |
| `BRANDBLITZ_REQUESTS_PER_STEP` | Total requests per concurrency step | `120` |
| `BRANDBLITZ_CONCURRENCY_STEPS` | Comma-separated concurrency levels | `10,50,100` |
| `BRANDBLITZ_PUBLIC_USERNAME` | Username used for the public profile scenario | `demo` |
| `BRANDBLITZ_SEARCH_QUERY` | Search query used for the user search scenario | `brand` |
| `BRANDBLITZ_BRAND_ID` | Brand id used for question preview generation | `demo` |

Example local command for maintainers:

```bash
BRANDBLITZ_API_BASE_URL=http://localhost:3000 \
BRANDBLITZ_AUTH_TOKEN=replace-with-token \
BRANDBLITZ_PUBLIC_USERNAME=popular-profile \
BRANDBLITZ_BRAND_ID=brand-id \
BRANDBLITZ_REQUESTS_PER_STEP=500 \
BRANDBLITZ_CONCURRENCY_STEPS=10,50,100 \
node scripts/perf/api-scale-probe.mjs > api-scale-report.json
```

The JSON report includes request count, elapsed time, requests per second, success rate, status-code distribution, median latency, p95 latency, and max latency for each endpoint and concurrency step.

## Investigation matrix

### Earnings history: `GET /users/me/earnings`

Use synthetic users with approximately 100, 1,000, and 10,000 historical sessions. Run the probe against each fixture user with a valid bearer token. Record p95 latency, total DB query time, row counts touched by the payout query, and whether response time grows linearly with history size.

Recommended database checks:

- Capture `EXPLAIN ANALYZE` for the payout query used by `apps/api/src/db/queries/payouts.ts`.
- Check whether the plan scans all historical rows for each request.
- Confirm whether the endpoint can safely paginate older earnings rows without changing the current summary totals.
- Consider a summary table only if repeated aggregation dominates the request and index tuning is not enough.

Decision rule:

- If p95 rises sharply between 1,000 and 10,000 sessions, prefer pagination for raw history plus a summary projection for totals.
- If p95 remains stable and DB load is low, document the observed ceiling and keep the simpler query.

### User search growth: `GET /users/search`

Seed or point the environment at 10,000, 100,000, and 500,000 users. Run the probe with the same search query at each size. Capture p95 latency and the query plan for both common-prefix and partial-match searches.

Recommended database checks:

- Confirm whether the query uses an index or falls back to a sequential scan.
- Compare prefix lookup, substring lookup, and case-insensitive lookup behavior.
- Evaluate trigram or full-text indexing only when the measured plan proves the existing lookup does not scale.
- Record whether result ordering changes the cost meaningfully.

Decision rule:

- If p95 exceeds the product target at 100,000 rows, add an index-backed search path before the 500,000 row target.
- If the query is already index-backed and stable, avoid adding extra search infrastructure.

### Viral profile traffic: `GET /users/:username/public`

Use a known public username and run a spike-shaped test. The issue target is 5,000 requests per minute, which is roughly 83 requests per second. The probe can approximate this by raising request count and concurrency, then comparing DB load before and after any cache prototype.

Recommended cache checks:

- Measure the current uncached p95 latency and database reads for a single username under repeated traffic.
- Repeat with a local memory cache or Redis-backed prototype using short TTLs such as 30, 60, and 300 seconds.
- Verify that private user fields never enter the cache payload.
- Confirm invalidation behavior when the profile owner changes public profile fields.

Decision rule:

- If one hot profile causes repeated identical DB reads and p95 instability, use a short TTL cache with explicit invalidation on profile update.
- If traffic remains stable without meaningful DB pressure, keep the endpoint uncached and revisit after real traffic data exists.

### Question preview concurrency: `GET /brands/:id/questions/preview`

Run concurrent brand onboarding flows at 10, 50, and 100 concurrent preview requests. Use a representative brand id and watch whether the endpoint shares external API calls, writes intermediate rows, or serializes work through a shared resource.

Recommended contention checks:

- Separate time spent in DB work from time spent in question generation or external API calls.
- Look for duplicate generation of the same preview payload under simultaneous requests.
- Check whether preview generation should be cached per brand draft while onboarding is active.
- Consider a queue only if generation is expensive, externally rate-limited, or creates shared write contention.

Decision rule:

- If concurrent preview calls repeatedly generate the same expensive response, prefer a short-lived preview cache keyed by brand id and source inputs.
- If external services rate-limit the flow, add a queued generation path or backoff rather than letting request latency balloon.

## Reporting template

Use this template when attaching results to an issue or follow-up PR:

```markdown
## Scenario

Endpoint:
Data fixture:
Concurrency / request count:
Cache or index variant:

## Results

- Median latency:
- p95 latency:
- Max latency:
- Requests per second:
- Success rate:
- Dominant status codes:
- DB observations:

## Recommendation

Recommended change:
Reason:
Risk:
Follow-up owner:
```

## Guardrails

- Run probes only against local, staging, or approved environments.
- Use synthetic users, brands, and payout history. Do not load-test production with real customer data.
- Keep auth tokens out of saved reports and terminal history where possible.
- Treat the probe as investigation tooling, not a pass/fail CI test.
- Prefer the smallest optimization that addresses measured bottlenecks.