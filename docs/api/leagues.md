# Leagues API

Leagues are a weekly competitive mechanic that groups players into 30-person ladders and promotes/demotes based on performance.

## How Leagues Work

Every week (Monday 00:00 UTC → Sunday 23:59 UTC), players are grouped into **leagues** of 30 people with similar skill levels. Your total score from completed challenges during the week determines your rank within your group.

### League Tiers

| Tier | Description |
|---|---|
| **Bronze** | Starting league for all new users |
| **Silver** | Promoted from Bronze — finish top 3 in your group |
| **Gold** | Promoted from Silver — finish top 3 in your group |

### Promotion & Demotion Rules

At the end of each week:

- **Top 3** in a Bronze group → promoted to **Silver** next week
- **Top 3** in a Silver group → promoted to **Gold** next week
- **Bottom 3** in a Silver group → demoted to **Bronze** next week
- **Bottom 3** in a Gold group → demoted to **Silver** next week
- Everyone else stays in their current tier

### How Assignment Works

When you first access the league endpoint in a new week, the server automatically assigns you to a group in your current tier (based on your last week's finish). You don't need to opt in — simply playing qualifies you.

---

## GET /leagues/current

Returns your current league, group assignment, and the 30-player leaderboard for this week.

### Authentication

Requires a valid `Authorization: Bearer <token>` header.

### Example Request

```bash
curl -H "Authorization: Bearer eyJhbG..." \
  https://api.brandblitz.io/leagues/current
```

### Response

**200 OK**

```json
{
  "weekStart": "2026-08-24T00:00:00.000Z",
  "weekEndExclusive": "2026-08-31T00:00:00.000Z",
  "league": "silver",
  "groupId": 3,
  "group": [
    {
      "user_id": "u0a80001-...",
      "display_name": "Alex R.",
      "avatar_url": "https://assets.brandblitz.io/avatars/u0a8...png",
      "league": "silver",
      "week_start": "2026-08-24T00:00:00.000Z",
      "group_id": 3,
      "weekly_points": 1200,
      "rank_in_group": 1
    },
    {
      "user_id": "u0a80002-...",
      "display_name": "Sam K.",
      "avatar_url": null,
      "league": "silver",
      "week_start": "2026-08-24T00:00:00.000Z",
      "group_id": 3,
      "weekly_points": 980,
      "rank_in_group": 2
    }
  ]
}
```

### Response Fields

| Field | Type | Description |
|---|---|---|
| `weekStart` | ISO 8601 | Start of the current league week (Monday 00:00 UTC) |
| `weekEndExclusive` | ISO 8601 | End of the week (next Monday 00:00 UTC, exclusive) |
| `league` | `bronze` \| `silver` \| `gold` | Your current league tier |
| `groupId` | integer | Your group number within the tier |
| `group` | array | The 30 (or fewer) players in your group, ranked by `weekly_points` |

#### Group Entry Fields

| Field | Type | Description |
|---|---|---|
| `user_id` | string (UUID) | Player's internal ID |
| `display_name` | string | Public display name |
| `avatar_url` | string \| null | Avatar image URL |
| `league` | string | League tier for this week |
| `week_start` | ISO 8601 | Week this assignment belongs to |
| `group_id` | integer | Group number |
| `weekly_points` | integer | Total score from completed challenges this week |
| `rank_in_group` | integer \| null | Position in the group (1 = highest) |

### Error Responses

| Status | Body | Trigger |
|---|---|---|
| `401` | `{ "error": "Unauthorized" }` | Missing or invalid token |
| `404` | `{ "error": "League not found" }` | No assignment found (should not happen — auto-created on first access) |
