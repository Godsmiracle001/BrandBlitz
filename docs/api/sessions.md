# Sessions API

Challenge gameplay: warmup, answer submission, session recovery, and abandonment.

Source: `apps/api/src/routes/sessions.ts`

---

## Table of Contents

- [Authentication](#authentication)
- [Gameplay Sequence](#gameplay-sequence)
- [Endpoints](#endpoints)
  - [GET /sessions/:challengeId](#get-sessionschallengeid)
  - [DELETE /sessions/:challengeId](#delete-sessionschallengeid)
  - [POST /sessions/:challengeId/warmup-start](#post-sessionschallengeidwarmup-start)
  - [POST /sessions/:challengeId/warmup-complete](#post-sessionschallengeidwarmup-complete)
  - [POST /sessions/:challengeId/start](#post-sessionschallengeidstart)
  - [POST /sessions/:challengeId/answer/:round](#post-sessionschallengeidanswerround)
- [Error Responses](#error-responses)

---

## Authentication

All endpoints require a valid JWT in the `Authorization: Bearer <token>` header. The `warmup-start` endpoint additionally requires an active (non-suspended) user account.

---

## Gameplay Sequence

```
1. POST /sessions/:id/warmup-start
   → session row created (status = warmup)
   → returns { sessionId, unlockAt }

2. POST /sessions/:id/warmup-complete
   → server enforces ≥20s elapsed since warmup-start
   → returns { challengeToken } (5-min TTL)

3. POST /sessions/:id/start
   → validates challengeToken
   → status = active, 45s timer begins
   → returns { sessionId, startsAt }

4. POST /sessions/:id/answer/1  → round 1 scored
5. POST /sessions/:id/answer/2  → round 2 scored
6. POST /sessions/:id/answer/3  → round 3 scored; session completed

Total challenge time: 45s (3 rounds × 15s each)
```

Correct answers **never leave the server**. The client receives only `correct: true/false` and `score` per round.

---

## Endpoints

### `GET /sessions/:challengeId`

Return the authenticated user's current session progress for recovery UI.

**Response `200`:**

```json
{
  "session": {
    "id": "uuid",
    "status": "in_progress",
    "last_answered_round": 2,
    "current_round": 3,
    "remaining_time_ms": 15000,
    "total_score": 250,
    "round_scores": [120, 130, null]
  }
}
```

| `status` value | Meaning |
|---|---|
| `warmup` | Warmup started, challenge not yet begun |
| `in_progress` | Challenge active, timer running |
| `completed` | All 3 rounds answered |
| `expired` | Session was abandoned |

**Errors:**
- `404` — challenge or session not found
- `403` — session belongs to another user

---

### `DELETE /sessions/:challengeId`

Explicitly quit an active or warmup session. The row is soft-abandoned (not deleted) so the reason is preserved for analytics and fraud detection. A subsequent `warmup-start` will create a fresh session.

**Response `204`:** No body.

**Errors:**
- `404` — no open session to forfeit

---

### `POST /sessions/:challengeId/warmup-start`

Begin the warmup phase. Records start time server-side. Uses a DB `UNIQUE` constraint to atomically create the session (no race conditions).

**Middleware:** `authenticate`, `requireActiveUser`, `enforceOneSessionPerChallenge`, `validateDeviceFingerprint`

**Response `200`:**

```json
{
  "sessionId": "uuid",
  "unlockAt": 1718457620000
}
```

The `unlockAt` timestamp (ms since epoch) tells the client when the "Start Challenge" button unlocks. The server enforces this minimum — attempting to complete warmup before `unlockAt` is rejected.

**Errors:**
- `404` — challenge not available (not found or not active)

---

### `POST /sessions/:challengeId/warmup-complete`

Complete warmup and receive a short-lived `challengeToken`. Server enforces that minimum exposure time has passed using server-side timestamp.

**Middleware:** `authenticate`, `detectClockSkew`

**Response `200`:**

```json
{
  "challengeToken": "ct:sessionId:1718457620000"
}
```

The `challengeToken` is valid for 10 minutes and must be passed to `POST /start`.

**Errors:**
- `400` `WARMUP_TOO_FAST` — warmup minimum not yet elapsed

```json
{
  "error": "Warm-up minimum not yet elapsed",
  "code": "WARMUP_TOO_FAST",
  "remainingMs": 12500
}
```

The client should display the remaining time and prevent retrying early.

- `401` — invalid or expired challenge token (on `/start`)

---

### `POST /sessions/:challengeId/start`

Start the 45-second challenge timer. Validates the `challengeToken` from `warmup-complete`.

**Middleware:** `authenticate`, `requireActiveUser`, `challengeStartLimiter`, `requireSessionStartAllowed`

**Request body:**

```json
{
  "challengeToken": "ct:sessionId:1718457620000"
}
```

**Response `200`:**

```json
{
  "sessionId": "uuid",
  "startsAt": "2025-06-15T14:00:00.000Z"
}
```

**Errors:**
- `401` — invalid or expired challenge token
- `403` — session mismatch (token belongs to different session)
- `429` — too many start attempts

---

### `POST /sessions/:challengeId/answer/:round`

Submit an answer for a round (1, 2, or 3). Server validates and scores. Round 3 is idempotent: duplicate requests return the cached result.

**Middleware:** `authenticate`, `validateReactionTime`

**Request body:**

```json
{
  "selectedOption": "B",
  "reactionTimeMs": 3200
}
```

| Field | Required | Validation |
|---|---|---|
| `selectedOption` | yes | `"A"`, `"B"`, `"C"`, `"D"`, or `null` (timeout) |
| `reactionTimeMs` | yes | Non-negative integer (ms) |

**Response `200`:**

```json
{
  "correct": true,
  "score": 145,
  "round": 1
}
```

On round 3, the response additionally includes:

```json
{
  "correct": true,
  "score": 130,
  "round": 3,
  "total_score": 400,
  "rank": 3
}
```

After round 3 completes, the session token is revoked and the session is finalized. Streak and badges are updated.

**Errors:**
- `400` — invalid round number, round already answered
- `403` — session flagged for review
- `409` — session already completed (for rounds 1–2); answer conflict (round 3 replay with different answer)
- `422` — score validation failed (impossible reaction time)

---

## Clock Skew Detection

The `detectClockSkew` middleware (applied to `warmup-complete`) checks that the client's reported timestamp is within acceptable drift of the server clock. This prevents clients from artificially manipulating warmup timing by more than a few seconds.

---

## Error Responses

| Status | Code | Meaning |
|---|---|---|
| `400` | `WARMUP_TOO_FAST` | Warmup minimum not elapsed; `remainingMs` included |
| `400` | — | Invalid round, round already answered |
| `401` | — | Invalid or expired challenge token |
| `403` | — | Session belongs to another user / flagged for review |
| `404` | — | Challenge or session not found |
| `409` | — | Session already completed / answer conflict |
| `422` | — | Score validation failed |
| `429` | — | Rate limit exceeded (start attempts) |
