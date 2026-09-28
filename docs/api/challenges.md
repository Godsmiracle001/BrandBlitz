# Challenges API

List, view, and interact with challenges: details, stats, leaderboards, deposit info, and content reports.

Source: `apps/api/src/routes/challenges.ts`

---

## Table of Contents

- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [GET /challenges](#get-challenges)
  - [GET /challenges/active](#get-challengesactive)
  - [GET /challenges/:id](#get-challengesid)
  - [GET /challenges/:id/stats](#get-challengesidstats)
  - [GET /challenges/:id/session](#get-challengesidsession)
  - [GET /challenges/:id/leaderboard](#get-challengesidleaderboard)
  - [GET /challenges/:id/deposit-info](#get-challengesiddeposit-info)
  - [POST /challenges/:id/report](#post-challengesidreport)
- [Caching](#caching)
- [Error Responses](#error-responses)

---

## Authentication

Three auth levels are used across these endpoints:

| Level | Middleware | Meaning |
|---|---|---|
| Public | none | No auth required |
| Optional auth | `optionalAuth` | Accepts JWT if present; continues without one |
| Required auth | `authenticate` | JWT required; 401 if missing/invalid |

---

## Endpoints

### `GET /challenges`

List challenges with cursor-based pagination. Supports filters.

**Auth:** Optional auth.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int (1–50) | 20 | Page size |
| `cursor` | string | — | Opaque continuation token |
| `brandId` | UUID | — | Filter by brand |
| `status` | `active` \| `upcoming` \| `ended` | — | Filter by status |
| `min_pool` | number | — | Minimum pool in USDC |
| `end_before` | ISO datetime | — | Only challenges ending before this time |
| `offset` | int | — | **Deprecated.** Use `cursor` instead. |

When no filters are applied, results are cached for 10 seconds. The response includes an `X-Cache` header (`HIT` or `MISS`).

**Response `200`:**

```json
{
  "data": [
    {
      "id": "uuid",
      "brand_id": "uuid",
      "title": "Stellar Pay Challenge",
      "pool_amount_usdc": "100.00",
      "ends_at": "2025-07-01T18:00:00Z",
      "status": "active",
      "participant_count": 45
    }
  ],
  "nextCursor": "eyJjcmVhdGVkX2F0Ijoi..."
}
```

**Deprecation:** If the legacy `offset` parameter is used, the response includes:
- `Deprecation: offset` header
- `Link: <https://docs.api.brandblitz.com/pagination>; rel="deprecation"` header

---

### `GET /challenges/active`

Lobby listing: active challenges sorted and cursor-paginated. Enriched with brand data.

**Auth:** Required auth + active user account (suspended users receive `403`).

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `sort` | `pool_desc` \| `pool_asc` \| `newest` \| `ending_soon` | `pool_desc` | Sort order |
| `limit` | int (1–50) | 20 | Page size |
| `cursor` | string | — | Continuation token |

**Response `200`:**

```json
{
  "items": [
    {
      "id": "uuid",
      "brand_id": "uuid",
      "title": "Stellar Pay Challenge",
      "reward_pool_xlm": "100.00",
      "entry_fee_xlm": null,
      "ends_at": "2025-07-01T18:00:00Z",
      "participant_count": 45,
      "brand_name": "Stellar Pay",
      "logo_url": "https://...",
      "primary_color": "#6B46C1",
      "secondary_color": "#E2E8F0"
    }
  ],
  "nextCursor": "..."
}
```

---

### `GET /challenges/:id`

Challenge details with questions (correct answers stripped). Cached for 60 seconds with ETag support.

**Auth:** Optional auth.

**Response `200`:**

```json
{
  "challenge": {
    "id": "uuid",
    "brand_id": "uuid",
    "title": "Stellar Pay Challenge",
    "status": "active",
    "pool_amount_usdc": "100.00",
    "ends_at": "2025-07-01T18:00:00Z",
    "participant_count": 45,
    "deposit_memo": "BLITZ-A1B2C3"
  },
  "questions": [
    {
      "id": "uuid",
      "round": 1,
      "question_text": "What is the tagline of Stellar Pay?",
      "options": ["Fast money", "Payments reimagined", "Send USDC", "Crypto wallet"],
      "prompt_type": "logo"
    }
  ]
}
```

For `pending_deposit` challenges, the `challenge` object includes confirmation count and requirement.

**ETag / 304:** The response includes an `ETag` header. Send `If-None-Match` to receive `304 Not Modified` if unchanged.

**Errors:**
- `404` — challenge not found

---

### `GET /challenges/:id/stats`

Aggregate performance metrics. Only accessible to the challenge's brand owner or an admin.

**Auth:** Required auth. Owner of the challenge's brand, or admin.

**Response `200`:**

```json
{
  "stats": {
    "total_sessions": 120,
    "completed_sessions": 95,
    "completion_rate_pct": 79.17,
    "disqualification_rate_pct": 5.0,
    "avg_score": 210.5,
    "avg_accuracy_pct": 68.33,
    "avg_time_per_round_ms": 8500.0,
    "total_paid_out_usdc": 100.0,
    "cost_per_completed_session_usdc": 1.0526316,
    "unique_participants": 80
  }
}
```

**Errors:**
- `403` `FORBIDDEN` — not brand owner or admin

---

### `GET /challenges/:id/session`

Return the authenticated user's most recent session for this challenge.

**Auth:** Required auth.

**Response `200`:**

```json
{
  "session": {
    "id": "uuid",
    "status": "completed",
    "total_score": 350,
    "started_at": "2025-06-15T14:00:00Z",
    "completed_at": "2025-06-15T14:01:30Z"
  }
}
```

**Errors:**
- `400` `INVALID_CHALLENGE_ID` — malformed challenge ID
- `404` — challenge or session not found

---

### `GET /challenges/:id/leaderboard`

Paginated leaderboard. Automatically uses archived data for ended challenges.

**Auth:** Public (no auth required).

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `sort_by` or `order` | `score` \| `speed` \| `earliest` | `score` | Sort order |
| `limit` | int (1–50) | 20 | Page size |
| `cursor` | string | — | Continuation token |

**Response `200`:**

```json
{
  "challengeId": "uuid",
  "nextCursor": "...",
  "sessions": [
    {
      "userId": "uuid",
      "username": "jane-doe",
      "displayName": "Jane",
      "league": "silver",
      "avatarUrl": "https://...",
      "totalScore": 420,
      "totalEarned": "25.00",
      "endedAt": "2025-06-15T14:01:30Z"
    }
  ]
}
```

**Errors:**
- `400` `INVALID_SORT` — invalid sort value

---

### `GET /challenges/:id/deposit-info`

Deposit instructions for a challenge (memo, address, amount). Only accessible to the brand owner while the challenge is in `pending_deposit` status.

**Auth:** Required auth. Brand owner only.

**Response `200`:**

```json
{
  "depositInfo": {
    "hotWalletAddress": "GABC...",
    "memo": "BLITZ-A1B2C3",
    "amount": "100.00"
  }
}
```

**Errors:**
- `400` — challenge is not pending deposit
- `403` — not brand owner

---

### `POST /challenges/:id/report`

Report inappropriate challenge content. Rate-limited to 5 reports per user per hour. Returns `409` if the same user already reported this challenge.

**Auth:** Required auth + active user.

**Request body:**

```json
{
  "reason": "misleading",
  "details": "The tagline in the question doesn't match the actual brand."
}
```

| `reason` value | Description |
|---|---|
| `misleading` | Misleading or false information |
| `offensive` | Offensive or inappropriate content |
| `spam` | Spam or low-quality content |
| `trademark_violation` | Unauthorized use of trademarks |
| `other` | Other (use `details` to explain) |

| Field | Required | Validation |
|---|---|---|
| `reason` | yes | One of the enum values above |
| `details` | no | Max 500 chars |

**Response `201`:**

```json
{
  "report_id": "uuid"
}
```

**Errors:**
- `404` — challenge not found or not active
- `409` `ALREADY_REPORTED` — user already reported this challenge

---

## Caching

| Endpoint | Cache |
|---|---|
| `GET /challenges` (no filters) | Redis, 10s TTL, with request coalescing |
| `GET /challenges/:id` | Redis, 60s TTL + ETag (304 support) |

The `X-Cache` header (`HIT`/`MISS`) is included on the challenges list endpoint when no filters are active.

---

## Error Responses

| Status | Code | Meaning |
|---|---|---|
| `400` | `INVALID_QUERY` | Invalid query parameters |
| `400` | `INVALID_SORT` | Invalid leaderboard sort value |
| `400` | `INVALID_CHALLENGE_ID` | Malformed challenge ID |
| `400` | — | Challenge not pending deposit |
| `401` | — | Missing or invalid auth token |
| `403` | `FORBIDDEN` | Not brand owner or admin |
| `404` | — | Challenge or session not found |
| `409` | `ALREADY_REPORTED` | Duplicate report from same user |
