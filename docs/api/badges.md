# Badges API

Badges are achievement milestones that track your progress across challenges, streaks, and league promotions. There are 8 badges in the catalog.

## Badge Catalog

| ID | Name | Category | Criteria |
|---|---|---|---|
| `first_win` | First Win | `achievement` | Complete your first non-practice challenge |
| `perfect_score` | Perfect Score | `accuracy` | Score 450 points in a single challenge |
| `streak_3` | On a Roll | `streak` | Maintain a 3-day login streak |
| `streak_7` | Week Warrior | `streak` | Maintain a 7-day login streak |
| `wins_10` | Veteran | `achievement` | Complete 10 non-practice challenges |
| `league_silver` | Silver Climber | `league` | Finish top 3 in your Bronze league group |
| `league_gold` | Gold Contender | `league` | Finish top 3 in your Silver league group |
| `league_diamond` | Diamond Elite | `league` | Finish top 3 in your Gold league group |

---

## GET /badges

Returns all badge definitions. When authenticated, each badge includes your earned status and the timestamp you earned it.

### Authentication

Optional (`authenticateOptional`). Unauthenticated responses are cached at the CDN layer for 5 minutes. Authenticated responses include per-user earned status.

### Query Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `category` | string | No | Filter by category (`achievement`, `accuracy`, `streak`, `league`) |

### Example Request — Unauthenticated

```bash
curl https://api.brandblitz.io/badges
```

### Example Request — Authenticated with category filter

```bash
curl -H "Authorization: Bearer eyJhbG..." \
  "https://api.brandblitz.io/badges?category=streak"
```

### Response — Unauthenticated

```json
[
  {
    "id": "first_win",
    "name": "First Win",
    "description": "You completed your first challenge.",
    "iconUrl": "/badges/first-win.svg",
    "category": "achievement",
    "unlockCriteria": "Complete your first non-practice challenge."
  },
  {
    "id": "perfect_score",
    "name": "Perfect Score",
    "description": "You answered every question correctly with maximum speed.",
    "iconUrl": "/badges/perfect-score.svg",
    "category": "accuracy",
    "unlockCriteria": "Score 450 points in a single challenge."
  }
]
```

### Response — Authenticated

```json
[
  {
    "id": "first_win",
    "name": "First Win",
    "description": "You completed your first challenge.",
    "iconUrl": "/badges/first-win.svg",
    "category": "achievement",
    "unlockCriteria": "Complete your first non-practice challenge.",
    "earned": true,
    "earnedAt": "2026-08-10T15:42:00.000Z"
  },
  {
    "id": "perfect_score",
    "name": "Perfect Score",
    "description": "You answered every question correctly with maximum speed.",
    "iconUrl": "/badges/perfect-score.svg",
    "category": "accuracy",
    "unlockCriteria": "Score 450 points in a single challenge.",
    "earned": false,
    "earnedAt": null
  }
]
```

### Error Responses

| Status | Body | Trigger |
|---|---|---|
| `400` | `{ "error": "Invalid query parameters", "code": "INVALID_QUERY" }` | Unknown query parameter |

---

## Related Endpoints

These endpoints are on the `/users` route and require authentication:

| Endpoint | Description |
|---|---|
| `GET /users/me/badges` | Returns only badges you've earned, ordered by `awarded_at` descending. Supports `?category=` filter. |
| `GET /users/:id/badges` | Returns all 8 badge definitions merged with the specified user's earned status. You can only query your own badges. |

---

## Admin-Only: POST /badges/flush

Flushes the badge definitions cache in Redis. This is an **internal admin endpoint** — not part of the public API.

```bash
curl -X POST -H "Authorization: Bearer <admin_token>" \
  https://api.brandblitz.io/badges/flush
```

Returns `204 No Content` on success. Requires `role = admin`.

**API consumers should not call this endpoint.** Badge definitions are stable and rarely change. The cache has a 5-minute TTL.
