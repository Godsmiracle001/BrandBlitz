# Daily Streaks Explained

This guide explains how daily streaks work, what breaks them, and how to repair a broken streak.

## What Is a Streak?

A streak tracks how many consecutive days you have played at least one challenge. Each day you complete a challenge, your streak counter increments by one. Missing a day resets the streak to zero.

## How Streak Days Are Counted

- A "day" is based on UTC midnight
- You must complete at least one challenge per UTC day to maintain your streak
- Playing multiple challenges in a day does not increase the streak faster — it counts as one day
- If you played yesterday and play today, your streak increments by 1
- If you missed yesterday, your streak resets to 1 (today counts as a new streak)

## What Breaks a Streak

- **Missing a day** — not completing any challenge in a UTC day
- There is a **1-day grace period** (freeze window) — if you miss one day, you can still repair the streak (see below)

## Checking Your Streak

### Your own streak

```
GET /users/me/streak
```

**Response:**

```json
{
  "current_streak": 7,
  "longest_streak": 14,
  "last_activity_at": "2026-08-24T00:00:00.000Z",
  "is_at_risk": false,
  "repair_deadline_at": null,
  "next_milestone": {
    "days_required": 14,
    "reward_badge_id": "streak_14_days"
  },
  "streak_frozen": false
}
```

| Field | Description |
|-------|-------------|
| `current_streak` | Your current consecutive-day count |
| `longest_streak` | Your all-time longest streak |
| `last_activity_at` | The last UTC day you played |
| `is_at_risk` | `true` if you played yesterday but haven't played today yet |
| `repair_deadline_at` | If `is_at_risk`, the deadline by which you must repair or play |
| `next_milestone` | The next milestone badge and how many days are needed |
| `streak_frozen` | Whether a streak freeze is active |

### Another user's streak

```
GET /users/:id/streak
```

Returns a simplified response:

```json
{
  "streak": 7,
  "last_play_day": "2026-08-24",
  "repair_available": true
}
```

## Streak Milestones

Reaching certain streak lengths earns you milestone badges:

| Days | Badge |
|------|-------|
| 3 | `streak_3_days` |
| 7 | `streak_7_days` |
| 14 | `streak_14_days` |
| 30 | `streak_30_days` |

You receive a notification when you hit a milestone. Milestones at 7 and 30 days trigger special notifications.

## Streak Repair

If your streak is at risk (you missed yesterday but had a streak of 3+ days), you can repair it once per month.

### Eligibility

- Your streak must have been at least **3 days** before it broke
- You can only repair **once per calendar month**
- The repair must be used before the deadline (typically 2 days after the missed day)

### How to Repair

```
POST /users/streaks/repair
```

**Success response:** Returns the updated streak object (same shape as `GET /users/me/streak`).

**Error responses:**

| Status | Code | Meaning |
|--------|------|---------|
| 409 | `STREAK_REPAIR_LIMIT` | You have already used your monthly repair |

### What Repair Does

- Restores your streak to its previous count (the day you missed is treated as if you played)
- The streak continues from where it left off — it does not reset
- You keep your longest streak record intact

## Tips

- Play at least one challenge every day to keep your streak alive
- If you miss a day, check `is_at_risk` and `repair_deadline_at` to see if you can still repair
- Use your repair strategically — you only get one per month
- Target streak milestones (3, 7, 14, 30 days) for badge rewards

## Related

- [Reporting a Challenge](./reporting-a-challenge.md) — what to do if a challenge is unfair
- [Funding a Challenge](./funding-a-challenge.md) — how brand admins fund challenges
