# Scoring Explained

Exactly how BrandBlitz calculates round scores, aggregates them into a challenge total, breaks ties, and turns scores into leaderboard rank and USDC payouts.

> Source of truth: `apps/api/src/services/scoring.ts` (`calculateRoundScore`, `rankWinners`)
> and `apps/api/src/db/queries/sessions.ts` (`getLeaderboard`).

## The Round Score Formula

Each challenge has **3 rounds**, each with a **15-second** answer window.

For a **correct** answer:

```
roundScore = 100 (base) + floor((timeLeft / 15000ms) × 50) (speed bonus)

where timeLeft = max(0, 15000 − reactionTimeMs)
```

For a **wrong** answer:

```
roundScore = 0   (no penalty — keeps engagement positive)
```

| Constant | Value |
|---|---|
| Base points | 100 |
| Max speed bonus | 50 |
| Round window | 15,000 ms |
| Max per round | 150 |
| Max total | 450 |

Key properties:

- The speed bonus is a **linear decay** over the 15 s window: instant answers earn the full +50, an answer at exactly 15 s earns +0.
- The bonus is floored to a whole number — no fractional points.
- Answering after the window yields `timeLeft = 0`, so you still earn the 100 base if your (recorded) answer is correct.
- Answers faster than 80 ms are rejected by anti-cheat before scoring; see [Fair Play for Players](./fair-play-for-players.md).

## Worked Examples

### Example 1 — fast answer

You answer correctly in **2,500 ms**:

```
timeLeft    = 15000 − 2500            = 12500
speedBonus  = floor((12500 / 15000) × 50) = floor(41.66…) = 41
roundScore  = 100 + 41                = 141
```

### Example 2 — medium answer

You answer correctly in **7,500 ms**:

```
timeLeft    = 15000 − 7500            = 7500
speedBonus  = floor((7500 / 15000) × 50) = 25
roundScore  = 100 + 25                = 125
```

### Example 3 — slow / timeout answer

Your answer lands at exactly the 15,000 ms limit and is correct:

```
timeLeft    = 0
speedBonus  = 0
roundScore  = 100
```

### Example 4 — wrong answer

Wrong pick in any round → `roundScore = 0`, regardless of speed.

## How Rounds Aggregate Into a Challenge Total

The session's final score is the plain sum of its three round scores:

```
totalScore = round1Score + round2Score + round3Score
```

Example: rounds of 141 + 125 + 100 → **totalScore = 366**.

- Aggregation uses `COALESCE(SUM(score), 0)` over `session_round_scores`, so missing rows count as 0 rather than nulling the total.
- A perfect session is **3 × 150 = 450** points.
- Totals are validated server-side against the `[0, 450]` range; anything outside it aborts the session completion.

## Tie-Breaking Rules

When two sessions have the same `total_score`, ranks are decided deterministically by
`getLeaderboard`'s ordering (`ORDER BY gs.total_score DESC, gs.completed_at ASC, gs.id ASC`):

1. **Higher total score wins.**
2. **If tied: earlier finish wins** (`completed_at` ascending). Finishing sooner shows you recalled faster across the whole session.
3. **If still tied (same score, same completion timestamp): lower session id wins** — a stable, deterministic fallback so pagination never shuffles equal entries.

The same ordering drives payouts via `rankWinners` (with user id as the final fallback), so leaderboard order and payout order always agree.

### Tie example

| Player | Score | Finished at | Rank |
|---|---|---|---|
| Ana | 350 | 10:00:00 | 1 |
| Ben | 350 | 10:00:05 | 2 |
| Cy | 340 | 09:59:59 | 3 |

Ana outranks Ben despite identical scores because she finished earlier.

## From Scores to Payouts

Payouts are **proportional to points**, not winner-take-all:

```
yourShare = yourTotalScore / sumOfAllEligibleScores × prizePool
```

Rules applied by the payout pipeline:

- Only **completed, non-practice, non-flagged** sessions participate (`getLeaderboard` filters these; a DB trigger is the safety net).
- Every session's integrity HMAC is verified before any payout is built — tampered totals abort the run.
- Sessions with a total of 0 receive nothing (a zero denominator is also guarded).
- Shares are computed in **stroops** (1 USDC = 10,000,000 stroops, 7-decimal precision).
- Winners without a Stellar address on file are skipped (logged).

### Payout example

Pool = **100 USDC**. Eligible scores: Ana 400, Ben 300, Cy 100 (sum = 800):

| Player | Share | Payout |
|---|---|---|
| Ana | 400/800 × 100 | 50.00 USDC |
| Ben | 300/800 × 100 | 37.50 USDC |
| Cy | 100/800 × 100 | 12.50 USDC |

## Where This Data Is Served

Both endpoints below are the authoritative data sources for everything above:

### `GET /challenges/:id/leaderboard`

Paginated per-challenge standings (keyset cursor pagination). Returns one row per eligible session:

```json
{
  "challengeId": "…",
  "nextCursor": null,
  "sessions": [
    {
      "userId": "…",
      "username": "player@example.com",
      "displayName": "Ana",
      "league": "gold",
      "avatarUrl": "…",
      "totalScore": 400,
      "totalEarned": "50.0000000",
      "endedAt": "2026-08-20T10:00:00Z"
    }
  ]
}
```

Supports `?sortBy=score|rank|created_at` (default `score`) plus `limit`/`cursor`.

### `GET /challenges/:id/stats`

Aggregate challenge metrics for the brand owner/admins — average round score, accuracy %, average reaction time, completion and disqualification rates, and payout totals. Per-round averages come from the same `session_round_scores` rows that scoring writes.

Route implementations live in `apps/api/src/routes/challenges.ts`.

## Related

- [Fair Play for Players](./fair-play-for-players.md) — how flagged sessions are excluded from pools
- [Player FAQ](../faq/player-faq.md) — payout timing and status
