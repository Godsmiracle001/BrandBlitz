# Brands API

Brand management, challenge creation, question review, webhooks, and analytics.

Source: `apps/api/src/routes/brands.ts`

---

## Table of Contents

- [Authentication](#authentication)
- [Public Endpoints](#public-endpoints)
- [Brand CRUD](#brand-crud)
- [Brand Analytics & Dashboard](#brand-analytics--dashboard)
- [Challenge Creation](#challenge-creation)
- [Question Review Workflow](#question-review-workflow)
- [Challenge Templates](#challenge-templates)
- [Webhooks](#webhooks)
- [Error Responses](#error-responses)

---

## Authentication

All endpoints except `GET /brands/public` require a valid JWT in the `Authorization: Bearer <token>` header.

**Ownership rule:** Unless otherwise noted, every `:id`-scoped endpoint checks `brand.owner_user_id === req.user.sub`. A `403 Forbidden` is returned if the authenticated user does not own the brand.

---

## Public Endpoints

### `GET /brands/public`

Public directory of all brands with active challenge counts. No auth required.

**Response `200`:**

```json
{
  "brands": [
    {
      "id": "uuid",
      "name": "Stellar Pay",
      "tagline": "Payments reimagined",
      "logo_url": "https://storage.brandblitz.io/brands/...",
      "primary_color": "#6B46C1",
      "active_challenge_count": 2
    }
  ]
}
```

---

## Brand CRUD

### `GET /brands` — List brands (authenticated)

Authenticated, rate-limited catalog with cursor pagination.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int (1–100) | 20 | Page size |
| `cursor` | string | — | Opaque continuation token |
| `search` | string | — | Case-insensitive name filter |
| `status` | `active` \| `inactive` \| `pending` | — | Filter by challenge-derived status |

**Response `200`:**

```json
{
  "items": [
    {
      "id": "uuid",
      "name": "Stellar Pay",
      "logo_url": "...",
      "status": "active",
      "created_at": "2025-01-15T10:00:00Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkX2F0Ijoi...",
  "total": 42
}
```

---

### `GET /brands/:id`

Returns the brand kit for the authenticated owner.

**Auth:** Owner only (`403` if not owner).

**Response `200`:**

```json
{
  "brand": {
    "id": "uuid",
    "name": "Stellar Pay",
    "logo_url": "...",
    "primary_color": "#6B46C1",
    "secondary_color": "#E2E8F0",
    "tagline": "Payments reimagined",
    "brand_story": "...",
    "usp": "...",
    "question_template": null
  }
}
```

---

### `POST /brands` — Create brand

Optimizes uploaded images server-side (converts to WebP).

**Request body:**

```json
{
  "name": "My Brand",
  "logoKey": "uploads/logo.png",
  "primaryColor": "#6B46C1",
  "secondaryColor": "#E2E8F0",
  "tagline": "Our tagline",
  "brandStory": "Our story",
  "usp": "Unique selling point",
  "productImage1Key": "uploads/product1.png",
  "productImage2Key": "uploads/product2.png"
}
```

| Field | Required | Validation |
|---|---|---|
| `name` | yes | 1–100 chars, no HTML tags |
| `logoKey` | no | S3 key for logo image |
| `primaryColor` | no | Hex `#rrggbb` |
| `secondaryColor` | no | Hex `#rrggbb` |
| `tagline` | no | Max 100 chars |
| `brandStory` | no | Max 500 chars |
| `usp` | no | Max 200 chars |
| `productImage1Key` | no | S3 key for product image 1 |
| `productImage2Key` | no | S3 key for product image 2 |

**Response `201`:** `{ brand: { ... } }`

---

### `PATCH /brands/:id`

Update mutable brand fields.

**Auth:** Owner only.

**Request body (all optional):**

```json
{
  "name": "Updated Name",
  "logo_url": "https://...",
  "primary_color": "#FF5733",
  "secondary_color": "#CCE5FF",
  "tagline": "New tagline",
  "brand_story": "Updated story",
  "usp": "Updated USP",
  "question_template": {
    "round_1": { "question_text": "Custom Q1", "prompt_type": "logo" },
    "round_2": null,
    "round_3": null
  }
}
```

The `question_template` lets brand owners override question text and prompt type per round. Set a round to `null` to remove the override.

**Response `200`:** `{ brand: { ... } }`

**Errors:**
- `422` `INVALID_QUESTION_TEMPLATE` — malformed `question_template` shape

---

### `DELETE /brands/:id`

Soft-delete a brand kit. Prevents new activity; existing challenges continue.

**Auth:** Owner or admin (`403` if neither).

**Response `200`:**

```json
{
  "brand": { "id": "uuid", "deleted_at": "2025-06-01T12:00:00Z" },
  "cancelledChallenges": 2
}
```

---

## Brand Analytics & Dashboard

### `GET /brands/:id/analytics`

Aggregated analytics for the brand's challenges.

**Auth:** Owner only.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `from` | ISO datetime | Start of date range |
| `to` | ISO datetime | End of date range |

**Response `200`:**

```json
{
  "analytics": {
    "total_challenges": 5,
    "total_sessions": 1200,
    "total_participants": 800,
    "avg_score": 210.5,
    "total_paid_out_usdc": 500.00
  }
}
```

**Errors:**
- `400` — invalid `from` or `to` date

---

### `GET /brands/:id/dashboard`

Aggregated challenge stats for the brand dashboard. Uses a database view for efficient single-query aggregation.

**Auth:** Owner only.

**Response `200`:**

```json
{
  "stats": {
    "total_challenges": 5,
    "active_challenges": 2,
    "total_sessions": 1200,
    "total_participants": 800,
    "total_paid_out_usdc": 500.00
  }
}
```

---

## Challenge Creation

### `POST /brands/challenges`

Create a new challenge and auto-generate questions from the brand kit.

**Auth:** Authenticated + TOS accepted. Brand owner only.

**Request body:**

```json
{
  "brandId": "uuid",
  "poolAmountUsdc": "100.00",
  "maxPlayers": 500,
  "endsAt": "2025-07-01T18:00:00.000Z"
}
```

| Field | Required | Validation |
|---|---|---|
| `brandId` | yes | UUID, must be owned by caller |
| `poolAmountUsdc` | yes | Regex `^\d+(\.\d{1,7})?$`, minimum 100 USDC |
| `maxPlayers` | no | Positive integer |
| `endsAt` | yes | ISO datetime, must be >1 hour in the future |

**Response `201`:**

```json
{
  "challenge": {
    "id": "uuid",
    "brand_id": "uuid",
    "status": "pending_deposit",
    "pool_amount_usdc": "100.00",
    "ends_at": "2025-07-01T18:00:00.000Z"
  },
  "depositInstructions": {
    "hotWalletAddress": "GABC...",
    "memo": "BLITZ-A1B2C3",
    "amount": "100.00",
    "asset": "USDC",
    "note": "Send exactly 100.00 USDC to the hot wallet with memo: BLITZ-A1B2C3"
  }
}
```

**Errors:**
- `400` `ENDS_AT_PAST` — end time is in the past
- `400` `ENDS_AT_TOO_SOON` — duration must be at least 1 hour
- `403` — not brand owner
- `422` `VALIDATION_ERROR` — invalid body fields

---

## Question Review Workflow

Questions are auto-generated when a challenge is created. Brand owners can review, approve, flag, and regenerate individual questions before the challenge goes live.

### `GET /brands/:id/questions/preview`

Returns questions (with `correct_answer`) for the latest challenge.

**Auth:** Owner only.

**Response `200`:**

```json
{
  "questions": [
    {
      "id": "uuid",
      "challenge_id": "uuid",
      "round": 1,
      "question_text": "What is the tagline of Stellar Pay?",
      "correct_option": "B",
      "correct_answer": "Payments reimagined",
      "options": ["Fast money", "Payments reimagined", "Send USDC", "Crypto wallet"],
      "prompt_type": "logo",
      "approved": null
    }
  ],
  "challenge": { "id": "uuid", "status": "pending_deposit" }
}
```

---

### `POST /brands/:id/questions/preview`

Generate draft questions without persisting. Idempotent — no DB writes.

**Auth:** Owner only. Rate-limited.

**Request body:**

```json
{
  "topic": "Brand recognition",
  "difficulty": "medium",
  "count": 5
}
```

**Response `200`:** `{ questions: [ ... ] }`

---

### `POST /brands/:id/questions/:questionId/regenerate`

Delete a question and regenerate it for the same round.

**Auth:** Owner only.

**Response `200`:**

```json
{
  "question": {
    "id": "new-uuid",
    "challenge_id": "uuid",
    "round": 1,
    "question_text": "New regenerated question...",
    "correct_option": "A",
    "correct_answer": "...",
    "options": ["A", "B", "C", "D"],
    "prompt_type": "logo"
  }
}
```

---

### `POST /brands/:id/questions/:questionId/approve`

Mark a question as approved.

**Auth:** Owner only.

**Response `200`:**

```json
{ "success": true }
```

---

### `POST /brands/:id/questions/:questionId/flag`

Mark a question as flagged for regeneration.

**Auth:** Owner only.

**Response `200`:**

```json
{ "success": true }
```

---

### Typical Review Workflow

```
1. Create challenge   → POST /brands/challenges (auto-generates questions)
2. Preview questions  → GET /brands/:id/questions/preview
3. Review each question:
   a. Accept  → POST .../questions/:id/approve
   b. Reject  → POST .../questions/:id/flag
   c. Replace → POST .../questions/:id/regenerate
4. Fund challenge     → Send USDC per deposit instructions
5. Challenge goes active once deposit confirmed
```

---

## Challenge Templates

### `POST /brands/:id/challenge-templates`

Create a recurring challenge template that auto-spawns challenges on a schedule.

**Auth:** Owner or admin. TOS accepted.

**Request body:**

```json
{
  "poolAmountUsdc": "100.00",
  "maxPlayers": 500,
  "durationHours": 24,
  "recurrenceRule": "weekly",
  "recurrenceCron": "0 12 * * 1",
  "recurrenceTimezone": "America/New_York"
}
```

| `recurrenceRule` | Description |
|---|---|
| `daily` | Every day |
| `weekly` | Every week |
| `biweekly` | Every 2 weeks |
| `monthly` | Every month |
| `custom` | Custom cron expression (requires `recurrenceCron`) |

**Response `201`:** `{ template: { ... } }`

---

### `GET /brands/:id/challenge-templates`

List challenge templates for a brand. Ordered by most recently created.

**Auth:** Owner or admin.

**Response `200`:** `{ templates: [ ... ] }`

---

### `GET /brands/:id/challenge-templates/upcoming`

Preview upcoming auto-generated challenges from active templates.

**Auth:** Owner or admin.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int (1–20) | 5 | Number of upcoming challenges to return |

**Response `200`:** `{ upcoming: [ ... ] }`

---

### `PATCH /brands/challenge-templates/:templateId/pause`

Pause a template. Existing spawned challenges are unaffected.

**Auth:** Owner or admin.

**Response `200`:** `{ template: { ... } }`

**Errors:**
- `400` `INVALID_STATE` — template is not active

---

### `PATCH /brands/challenge-templates/:templateId/resume`

Resume a paused template.

**Auth:** Owner or admin.

**Response `200`:** `{ template: { ... } }`

**Errors:**
- `400` `INVALID_STATE` — template is not paused

---

### `DELETE /brands/challenge-templates/:templateId`

Soft-delete a template. Previously spawned challenges remain unchanged.

**Auth:** Owner or admin.

**Response `204`:** No body.

---

## Webhooks

### `POST /brands/:id/webhooks`

Register an outbound webhook subscription for challenge lifecycle events.

**Auth:** Owner or admin.

**Request body:**

```json
{
  "url": "https://your-app.com/webhooks/brandblitz",
  "secret": "min-16-char-secret",
  "eventTypes": ["challenge.created", "challenge.activated", "challenge.settled"]
}
```

| Field | Required | Validation |
|---|---|---|
| `url` | yes | Valid URL |
| `secret` | no | Min 16 chars |
| `eventTypes` | no | Array of event type strings |

**Response `201`:** `{ webhook: { ... } }`

---

### `GET /brands/:id/webhooks`

List registered webhooks for a brand.

**Auth:** Owner or admin.

**Response `200`:** `{ webhooks: [ ... ] }`

---

### `GET /brands/:id/webhooks/deliveries`

View delivery status and logs per brand.

**Auth:** Owner or admin.

**Response `200`:** `{ deliveries: [ ... ] }`

---

## Error Responses

| Status | Code | Meaning |
|---|---|---|
| `400` | `ENDS_AT_PAST` | Challenge end time is in the past |
| `400` | `ENDS_AT_TOO_SOON` | Challenge must be at least 1 hour |
| `400` | `INVALID_STATE` | Template not in expected state |
| `403` | — | Not brand owner (or admin for delete/template routes) |
| `404` | — | Brand, question, or template not found |
| `422` | `INVALID_QUESTION_TEMPLATE` | Malformed `question_template` |
| `422` | `VALIDATION_ERROR` | Invalid request body fields |
