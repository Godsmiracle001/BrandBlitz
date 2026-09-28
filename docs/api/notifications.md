# Notifications API

The notifications endpoints let authenticated users retrieve their in-app notifications and mark them as read.

**Base path:** `/users/me/notifications`  
**Authentication:** `Authorization: Bearer <access_token>` required on all endpoints.

---

## Endpoints

### GET /users/me/notifications

Returns the 50 most recent notifications for the authenticated user, ordered newest first.

**No query parameters.** Pagination is not currently supported — the endpoint always returns the 50 most recent records.

#### Request

```bash
curl https://api.brandblitz.io/users/me/notifications \
  -H "Authorization: Bearer <access_token>"
```

#### Response `200 OK`

```json
{
  "notifications": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "type": "payout_settled",
      "payload": {
        "amountUsdc": "12.50",
        "challengeId": "chal_abc123",
        "challengeTitle": "Summer Trivia Sprint",
        "txId": "4a1f..."
      },
      "read_at": null,
      "created_at": "2026-08-26T10:15:00.000Z"
    },
    {
      "id": "7cb8e9a2-1234-4def-8abc-0f1e2d3c4b5a",
      "type": "badge_earned",
      "payload": {
        "badgeId": "streak_7",
        "badgeName": "7-Day Streak",
        "badgeIcon": "🔥"
      },
      "read_at": "2026-08-25T08:00:00.000Z",
      "created_at": "2026-08-25T07:45:00.000Z"
    }
  ]
}
```

#### Notification object fields

| Field | Type | Description |
|---|---|---|
| `id` | UUID string | Unique notification identifier |
| `type` | string | Notification type (see below) |
| `payload` | object | Type-specific data (varies per type) |
| `read_at` | ISO 8601 string \| null | Timestamp when marked read; `null` = unread |
| `created_at` | ISO 8601 string | When the notification was created |

---

## Notification Types

| Type | Triggered by | Key payload fields |
|---|---|---|
| `payout_settled` | USDC payout confirmed on-chain | `amountUsdc`, `challengeId`, `challengeTitle`, `txId` |
| `badge_earned` | Player earns a badge | `badgeId`, `badgeName`, `badgeIcon` |
| `challenge_result` | Challenge scoring complete | `challengeId`, `challengeTitle`, `rank`, `scorePercentile` |
| `streak_at_risk` | Player hasn't played today and streak > 2 | `currentStreak`, `expiresAt` |
| `referral_joined` | A referred user completes sign-up | `referredUsername`, `bonusUsdc` |
| `account_warning` | Fraud or compliance flag raised | `reason`, `reviewUrl` |

> The `payload` schema for each type is not versioned independently — new fields may be added non-breakingly. Check for the presence of a field before using it.

---

### PATCH /users/me/notifications/:id/read

Marks a single notification as read. Idempotent — calling on an already-read notification returns `200` without changing `read_at`.

#### Request

```bash
curl -X PATCH \
  https://api.brandblitz.io/users/me/notifications/3fa85f64-5717-4562-b3fc-2c963f66afa6/read \
  -H "Authorization: Bearer <access_token>"
```

#### Response `200 OK`

```json
{ "success": true }
```

#### Error responses

| Status | Condition |
|---|---|
| `400` | `:id` is not a valid UUID |
| `404` | Notification not found or belongs to a different user |

---

### PATCH /users/me/notifications/read-all

Marks **all** unread notifications for the authenticated user as read in a single request.

#### Request

```bash
curl -X PATCH \
  https://api.brandblitz.io/users/me/notifications/read-all \
  -H "Authorization: Bearer <access_token>"
```

#### Response `200 OK`

```json
{ "success": true }
```

Returns `200` even when there are no unread notifications.

---

## Related

- [Users API](./users.md)
- [Wallet and Payouts Guide](../guides/wallet-and-payouts.md)
