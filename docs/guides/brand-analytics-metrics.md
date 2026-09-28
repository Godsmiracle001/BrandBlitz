# Brand Analytics Metrics

What every number on the brand analytics dashboard means, where it comes from, and how fresh it is.

Written for brand marketers — no technical background needed. Each metric below also names the exact computation it maps back to, for anyone who wants to verify the math.

> Dashboard: `apps/web/src/app/(brand)/brand/[id]/analytics/page.tsx`
> · API: `GET /brands/:id/analytics` (implemented in `apps/api/src/routes/brands.ts:312`)
> · Query layer: `apps/api/src/db/queries/analytics.ts` (`getBrandAnalytics`)

## The Dashboard at a Glance

```
┌──────────────────────────────────────────────────────────────────┐
│  [logo]  Acme Analytics                    [Overview] [Launch…]   │
│          "Just taste the difference"                              │
│                                                                   │
│  Date range:  (7 days) (30 days) (90 days)                        │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐            │
│  │ Total       │  │ Completion   │  │ Avg Cost /     │            │
│  │ Sessions    │  │ Rate         │  │ Session        │            │
│  │    1,248    │  │    78%       │  │    $0.41       │            │
│  └─────────────┘  └──────────────┘  └────────────────┘            │
│                                                                   │
│  ┌───────────────────────┐  ┌───────────────────────┐             │
│  │ Completion Rate       │  │ Accuracy by Question  │             │
│  │ (donut: completed vs  │  │ (bar per round, green │             │
│  │  total)               │  │  ≥80% yellow ≥50%)    │             │
│  └───────────────────────┘  └───────────────────────┘             │
│                                                                   │
│  ┌─────────────────────────────────────────────────┐              │
│  │ Cost per Session — daily bars, pool ÷ sessions  │              │
│  └─────────────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────────┘
```

## Metric Definitions

### Total Sessions

**What it measures:** how many challenge attempts players started across your brand's challenges.

- Counts every game session row for your challenges, regardless of outcome.
- Includes sessions that were abandoned mid-game or flagged for unfair play.
- Excludes nothing else — practice-style flags don't apply here; if a session exists, it counts.

**Computation:** `COUNT(*) FROM game_sessions WHERE challenge_id = ANY(brand's challenges)` — `getSessionStats()` in `db/queries/analytics.ts`.

### Completed Sessions

**What it measures:** sessions where the player finished all 3 rounds.

A session is "completed" only when its status is `completed`, which requires answering every round. Abandoned, expired, and flagged sessions are not completed.

**Computation:** `COUNT(*) FILTER (WHERE status = 'completed')` in the same query as above.

### Completion Rate

**What it measures:** the share of started sessions that finish all 3 rounds — your strongest signal that players stayed engaged past the warm-up.

```
completionRate = round(completedSessions / totalSessions × 100)
```

Example: 974 completed of 1,248 total → **78%**.

Benchmarks: interactive ad formats typically see steep drop-off after the first interaction; anything above ~70% here means your warm-up content held attention through all three recall questions.

**Computation:** integer percentage computed in `getBrandAnalytics()` (`Math.round((completed/total)*100)`); rendered as both the card and the donut chart.

### Accuracy by Question

**What it measures:** per round, what fraction of answers were correct — i.e. which parts of your brand message actually landed.

Each bar is one round's question ("Round 1 — Tagline recognition", etc.) showing:

| Field | Meaning |
|---|---|
| `totalAttempts` | Answers submitted by players in **completed sessions** |
| `correctAttempts` | Answers that earned points (`score > 0`) |
| `accuracy` | `round(correctAttempts / totalAttempts × 100)` |

Color coding: **green** ≥ 80%, **yellow** ≥ 50%, **red** < 50%.

How to read it:

- **Very high accuracy (85%+)** — message is clear, but consider whether recall was too easy.
- **Mid-range (50–80%)** — healthy recall challenge; most of the score spread comes from speed.
- **Low (< 50%)** — that message isn't sticking. Revisit the tagline/USP wording or warm-up copy.

Note: attempts from incomplete sessions are excluded, so this reflects players who saw your full brand kit.

**Computation:** joins `challenge_questions` to `session_round_scores` filtered on `status = 'completed'`; a correct attempt is any row with `score > 0` — `getQuestionAccuracy()` in `db/queries/analytics.ts`.

### Avg Cost / Session (summary card)

**What it measures:** the average prize-pool cost of one player session across the selected date range — your effective cost-per-engagement.

The card averages the daily *cost per session* values over the window:

```
avgCostPerSession = mean(daily costPerSession)
daily costPerSession = day's pool amount in USDC / day's session count
```

"Pool amount" is the USDC the brand deposited for the challenge(s), converted from Stellar stroops (1 USDC = 10,000,000 stroops).

**Computation:** server returns daily `{date, totalCost, sessionCount, costPerSession}` via `getCostPerSession()`; the page computes the mean client-side over the returned days.

### Cost per Session chart

**What it measures:** the same cost-per-session figure, but per day, so you can spot efficiency changes when you launch new challenges or adjust pool sizes.

- One bar per day with session activity in the range.
- Bar height = that day's pool spend divided by that day's sessions.
- Days with no sessions have no bar.

**Computation:** `SELECT DATE(gs.created_at), SUM(pool_amount_stroops)/1e7, COUNT(gs.id)` grouped by day — `getCostPerSession()` in `db/queries/analytics.ts`.

## Date Range Behavior

The **7 / 30 / 90 days** selector changes what the API receives:

- **Session stats and question accuracy** are scoped to challenges **created** within the selected window (`challenges.created_at >= from AND <= to`).
- **Cost per session** is scoped to **sessions created** within the window (defaulting to the last 30 days if no range is given).

So a long-running challenge launched 40 days ago contributes no session stats under "30 days", even though players may still be playing it today.

## Data Refresh Cadence

**Not real-time, but always current on load.**

- Every page load and date-range change triggers a **fresh request**; the route queries PostgreSQL directly with **no cache layer**, so numbers are accurate as of the moment you opened the page (or switched ranges).
- There is no live streaming/auto-refresh — reload the page to pull newer numbers.
- During an active challenge you'll see sessions appear as they're played, subject to the manual refresh above.
- Payout-related costs appear once the challenge's pool is recorded against its challenges.

For live standings during a challenge, use the challenge leaderboard instead (`GET /challenges/:id/leaderboard`).

## Related

- [Scoring Explained](./scoring-explained.md) — how player scores (behind the accuracy metric) are calculated
- [Funding a Challenge](./funding-a-challenge.md) — how pools and deposits work
- [Brand FAQ](../faq/brand-faq.md)
