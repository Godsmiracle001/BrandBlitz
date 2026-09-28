# Users API

User profiles, wallet management, phone verification, notifications, badges, earnings, referrals, and streaks.

Source: `apps/api/src/routes/users.ts`

---

## Table of Contents

- [Authentication](#authentication)
- [Profile](#profile)
- [Wallet](#wallet)
- [Phone Verification](#phone-verification)
- [Notifications](#notifications)
- [Badges](#badges)
- [Earnings](#earnings)
- [Referrals](#referrals)
- [Streaks](#streaks)
- [Session History](#session-history)
- [User Search](#user-search)
- [Error Responses](#error-responses)

---

## Authentication

Endpoints prefixed with `/me` require a valid JWT in the `Authorization: Bearer <token>` header.

Public endpoints (`/profile/:username`, `/:username/public`, `/:username/activity`) require no authentication but are rate-limited.

---

## Profile

### `GET /me`

Full profile of the authenticated user.

**Response `200`:**

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "display_name": "Jane",
    "username": "jane-doe",
    "avatar_url": "https://...",
    "stellar_address": "GABC...",
    "embedded_wallet_address": "GDEF...",
    "phone_verified": true,
    "age_verified": true,
    "kyc_complete": false,
    "state_code": "NY",
    "streak": 5,
    "last_play_day": "2025-06-15",
    "streak_repairs_this_month": 0,
    "streak_repair_available": true,
    "created_at": "2025-01-10T08:00:00Z",
    "updated_at": "2025-06-15T12:00:00Z"
  }
}
```

---

### `PATCH /me/profile`

Update display name and/or username. Triggers cache revalidation and token rotation.

**Request body:**

```json
{
  "displayName": "New Name",
  "username": "new-username"
}
```

| Field | Required | Validation |
|---|---|---|
| `displayName` | no | 1–100 chars, trimmed |
| `username` | no | 1–30 chars, lowercase alphanumeric + hyphens only (`/^[a-z0-9-]+$/`) |

At least one field must be provided. Returns `400` if body is empty.

**Response `200`:**

```json
{
  "success": true,
  "oldUsername": "old-name",
  "newUsername": "new-name",
  "token": "eyJhbG..."
}
```

A new JWT is issued on username change (old token is revoked). Visiting `/profile/<old-username>` redirects for 1 year.

---

### `GET /profile/:username` — Public profile (lite)

Public profile with league, earnings, and challenge count. No auth required.

**Response `200`:**

```json
{
  "user": {
    "userId": "uuid",
    "displayName": "Jane",
    "username": "jane-doe",
    "league": "silver",
    "totalEarned": "45.50",
    "totalChallenges": 32,
    "avatarUrl": "https://...",
    "streak": 5,
    "createdAt": "2025-01-10T08:00:00Z",
    "isOwner": false
  }
}
```

If the username has been renamed, returns `{ "redirect": "new-username" }`.

---

### `GET /:username/public` — Public profile (full)

Detailed public profile: win count, accuracy, league, and 6 most recent badges. No auth required. Returns `404` for unknown, deleted, or suspended users.

**Response `200`:**

```json
{
  "username": "jane-doe",
  "displayName": "Jane",
  "avatarUrl": "https://...",
  "joinedAt": "2025-01-10T08:00:00Z",
  "winCount": 18,
  "totalSessionsPlayed": 32,
  "accuracyPct": 72,
  "league": {
    "tier": "silver",
    "rank": 5,
    "season": "2025-06-09"
  },
  "badges": [
    {
      "slug": "first-win",
      "name": "First Win",
      "description": "Won your first challenge",
      "iconUrl": "https://...",
      "awardedAt": "2025-01-12T14:00:00Z"
    }
  ]
}
```

---

### `GET /:username/activity`

Returns 365 days of activity data (date + session count) for the trailing year. No auth required. Rate-limited.

**Response `200`:**

```json
[
  { "date": "2025-06-15", "session_count": 3 },
  { "date": "2025-06-14", "session_count": 1 }
]
```

---

## Wallet

### `PATCH /me/wallet`

Set or update the user's Stellar wallet address.

**Request body:**

```json
{
  "stellarAddress": "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
}
```

| Field | Required | Validation |
|---|---|---|
| `stellarAddress` | yes | 56–70 chars |

**Response `200`:**

```json
{ "success": true }
```

---

## Phone Verification

Phone verification uses a two-step OTP flow via Twilio SMS.

### `POST /me/phone/send`

Send a 6-digit verification code. Rate-limited.

**Request body:**

```json
{
  "phone": "+14155551234"
}
```

**Response `200`:**

```json
{ "success": true }
```

---

### `POST /me/phone/verify`

Confirm the 6-digit code. Marks phone as verified.

**Request body:**

```json
{
  "phone": "+14155551234",
  "code": "123456"
}
```

| Field | Required | Validation |
|---|---|---|
| `phone` | yes | Phone number string |
| `code` | yes | Exactly 6 characters |

**Response `200`:**

```json
{ "success": true }
```

**Errors:**
- `400` — wrong code
- `409` — phone number already associated with another account
- `429` — too many attempts (brute-force lockout; `Retry-After` header set)

---

## Notifications

### `GET /me/notifications`

Returns the 50 most recent unread notifications.

**Response `200`:**

```json
{
  "notifications": [
    {
      "id": "uuid",
      "type": "challenge.won",
      "payload": { "challenge_id": "uuid", "amount_usdc": "15.00" },
      "read_at": null,
      "created_at": "2025-06-15T14:00:00Z"
    }
  ]
}
```

---

### `PATCH /me/notifications/:id/read`

Mark a single notification as read.

**Response `200`:**

```json
{ "success": true }
```

**Errors:**
- `404` — notification not found (or already read, or belongs to another user)

---

### `PATCH /me/notifications/read-all`

Mark all unread notifications as read.

**Response `200`:**

```json
{ "success": true }
```

---

## Badges

### `GET /me/badges`

Returns all badges earned by the authenticated user. Supports optional category filter.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `category` | string | Filter by badge category |

**Response `200`:**

```json
{
  "items": [
    {
      "id": "uuid",
      "badge_id": "first-win",
      "badge_name": "First Win",
      "badge_description": "Won your first challenge",
      "icon_url": "https://...",
      "awarded_at": "2025-01-12T14:00:00Z",
      "trigger_event": "Win first challenge",
      "category": "milestone"
    }
  ],
  "total": 5
}
```

---

### `GET /:id/badges`

Returns all 8 badge definitions merged with the user's earned status. Only accessible by the user themselves.

**Response `200`:**

```json
{
  "badges": [
    {
      "slug": "first-win",
      "name": "First Win",
      "earned": true,
      "awarded_at": "2025-01-12T14:00:00Z"
    },
    {
      "slug": "streak-master",
      "name": "Streak Master",
      "earned": false,
      "awarded_at": null
    }
  ]
}
```

---

## Earnings

### `GET /me/earnings`

Paginated USDC payout history. Supports status filtering and cursor-based pagination.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | `pending` \| `settled` \| `failed` \| `all` | `all` | Filter by payout status |
| `cursor` | string | — | Opaque continuation token |
| `limit` | int (1–100) | 25 | Page size |

**Response `200`:**

```json
{
  "items": [
    {
      "payout_id": "uuid",
      "amount_usdc": "15.00",
      "status": "settled",
      "created_at": "2025-06-15T14:00:00Z",
      "settled_at": "2025-06-15T14:05:00Z",
      "stellar_tx_hash": "abc123...",
      "challenge_id": "uuid"
    }
  ],
  "totals": {
    "lifetime_earned_usdc": "245.50",
    "pending_usdc": "15.00"
  },
  "nextCursor": "eyJjcmVhdGVkX2F0Ijoi..."
}
```

---

## Referrals

### `GET /me/referrals/stats`

Quick summary of referral performance.

**Response `200`:**

```json
{
  "referralCode": "JANE-ABC",
  "invitesSent": 12,
  "conversions": 5,
  "totalEarned": "25.00",
  "totalEarnedUsdc": "25.00"
}
```

---

### `GET /me/referrals`

Detailed referral list with bonus status per referred user.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | `pending` \| `paid` \| `expired` \| `all` | `all` | Filter by bonus status |

**Response `200`:**

```json
{
  "referralCode": "JANE-ABC",
  "referrals": [
    {
      "referral_id": "uuid",
      "referred_user_id": "uuid",
      "referred_username": "bob",
      "joined_at": "2025-06-10T08:00:00Z",
      "activated_at": "2025-06-11T10:00:00Z",
      "bonus_status": "paid",
      "bonus_amount_usdc": "5.00"
    }
  ],
  "summary": {
    "total_referrals": 12,
    "total_paid": 5,
    "total_pending_bonuses_usdc": "10.00"
  }
}
```

---

## Streaks

### `GET /me/streak`

Detailed streak information for the authenticated user.

**Response `200`:** Streak detail object (structure varies).

---

### `GET /:id/streak`

Streak summary for a user (self only; `403` if `id !== user.sub`).

**Response `200`:**

```json
{
  "streak": 5,
  "last_play_day": "2025-06-15",
  "repair_available": true
}
```

---

### `POST /streaks/repair`

Repair a broken streak. One repair per calendar month.

**Response `200`:** Repaired streak data.

**Errors:**
- `409` `STREAK_REPAIR_LIMIT` — monthly repair already used

---

## Session History

### `GET /me/history`

Paginated session history with optional round breakdown.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | `completed` \| `disqualified` \| `all` | `completed` | Filter by session outcome |
| `include_rounds` | `true` \| `false` | `false` | Append per-round breakdown |
| `limit` | int (1–100) | 20 | Page size |
| `cursor` | string | — | Continuation token |

**Response `200`:**

```json
{
  "items": [
    {
      "session_id": "uuid",
      "challenge_id": "uuid",
      "challenge_title": "Stellar Pay Challenge",
      "started_at": "2025-06-15T14:00:00Z",
      "completed_at": "2025-06-15T14:01:30Z",
      "total_score": 350,
      "outcome": "won",
      "payout_amount_usdc": "15.00"
    }
  ],
  "nextCursor": "..."
}
```

In-progress sessions (warmup/active/abandoned) are excluded unless `status=all`.

---

## User Search

### `GET /search`

Case-insensitive prefix search against username. Authenticated to prevent enumeration.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `q` | string (min 2 chars) | Search prefix |
| `page` | int (min 1) | Page number (default 1) |

**Response `200`:**

```json
[
  {
    "id": "uuid",
    "username": "jane-doe",
    "avatar_url": "https://...",
    "total_earnings": "245.50"
  }
]
```

---

## Error Responses

| Status | Code | Meaning |
|---|---|---|
| `400` | `INVALID_QUERY` | Invalid query parameters or empty update body |
| `403` | `FORBIDDEN` | Attempting to access another user's private data |
| `404` | — | User, notification, or resource not found |
| `409` | — | Phone already in use / streak repair limit |
| `429` | — | Phone rate limit exceeded (`Retry-After` header) |
