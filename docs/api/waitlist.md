# Waitlist API

The waitlist API lets users join the BrandBlitz waitlist and look up their position in line.

## POST /waitlist

Join the waitlist. Duplicate emails are silently ignored (idempotent).

### Rate Limiting

Protected by `waitlistLimiter`: **5 requests per hour per IP**. Exceeding this returns a `429` response.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string (max 254) | Yes | Valid email address. Normalised to lowercase and trimmed before storage. |
| `referral_code` | string (max 64) | No | Referral code from another user's invite link |

### Example Request

```bash
curl -X POST https://api.brandblitz.io/waitlist \
  -H "Content-Type: application/json" \
  -d '{"email": "alex@example.com", "referral_code": "ABC123"}'
```

### Response

**201 Created** — first signup

```json
{ "message": "You're on the list!" }
```

**201 Created** — duplicate email (idempotent, no error)

```json
{ "message": "You're on the list!" }
```

### Error Responses

| Status | Body | Trigger |
|---|---|---|
| `422` | `{ "error": "Invalid email address", "code": "INVALID_EMAIL" }` | Malformed email (fails Zod validation) |
| `429` | `{ "error": "Too many signup attempts, please try again later" }` | Rate limit exceeded (5 req/hr/IP) |

---

## GET /waitlist/position/:email

Look up your position in the waitlist.

### Rate Limiting

Protected by `apiLimiter`: dynamic rate limit per user/IP over a 15-minute window.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `email` | string | The email used to sign up |

### Example Request

```bash
curl https://api.brandblitz.io/waitlist/position/alex@example.com
```

### Response

**200 OK**

```json
{ "position": 42 }
```

### Error Responses

| Status | Body | Trigger |
|---|---|---|
| `404` | `{ "error": "Email not found on waitlist" }` | Email not in database |
| `429` | `{ "error": "Too many requests, please try again later" }` | Rate limit exceeded |

---

## Notes

- The waitlist signup page is at [`apps/web/src/app/waitlist/page.tsx`](../../apps/web/src/app/waitlist/page.tsx).
- Emails are stored in the `waitlist` table. Position is derived from the `waitlist_signups` view.
- Both endpoints are public — no authentication required.
