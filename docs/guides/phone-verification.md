# Phone Verification

BrandBlitz uses SMS-based phone verification to reduce fraud and enforce ownership of phone numbers. This guide explains why phone verification matters, how the OTP flow works, and the rate limits and error handling you can expect.

## Why Phone Verification?

Phone verification serves several fraud-prevention goals:

1. **Account takeover protection**: Users must prove ownership of their phone number, making account hijacking more expensive.
2. **Challenge farming prevention**: A verified phone number is harder to spoof in bulk, reducing automated challenge participation and prize farming.
3. **Payment fraud detection**: Phone verification is a fraud signal — verified users are less likely to be compromised accounts requesting unearned payouts.

Phone verification is **optional** for browsing challenges and viewing leaderboards, but **required** before:
- Cashing out or requesting a payout
- Participating in high-value challenges
- Receiving notifications

## The OTP Flow

### 1. Request an OTP

**POST /users/me/phone/send**

Send an SMS verification code to the user's phone number. This endpoint is rate-limited to 3 requests per 15 minutes per phone number.

**Request:**
```json
{
  "phone": "+15551234567"
}
```

The phone number must be in E.164 format (e.g., `+1-555-123-4567` is normalized to `+15551234567`). Non-numeric characters are stripped, and the number must be between 10 and 15 digits.

**Response:**
```json
{
  "success": true
}
```

**Error responses:**
- **400 Bad Request**: `"phone": "Phone number must be a valid E.164 number"`
- **429 Too Many Requests**: `"error": "Too many verification attempts, please try again later"` with `Retry-After` header

The phone number is immediately sent to Twilio's Verify service, which dispatches an SMS containing a 6-digit code. The code is valid for 10 minutes.

### 2. Submit the OTP Code

**POST /users/me/phone/verify**

Confirm the 6-digit SMS code. This endpoint includes brute-force protection that locks out a phone number after 5 consecutive failed attempts within a rolling 1-hour window.

**Request:**
```json
{
  "phone": "+15551234567",
  "code": "123456"
}
```

**Response (on success):**
```json
{
  "success": true
}
```

**Error responses:**
- **400 Bad Request**: `"error": "Invalid verification code"` — the code is wrong or expired
- **409 Conflict**: `"error": "Phone number already associated with another account"` — the phone is already verified on a different user's account
- **429 Too Many Requests**: `"error": "Too many verification attempts, please try again later"` — 5+ failed attempts on this phone within the last 60 minutes

On a 429 response, the `Retry-After` header tells you how many seconds to wait before trying again (typically the remaining lockout duration).

## Rate Limiting

The phone verification endpoints are subject to rate limiting keyed by phone number, not by user or IP address.

| Endpoint | Limit | Window | Keyed By |
|---|---|---|---|
| `POST /users/me/phone/send` | 3 requests | 15 minutes | Phone number |
| OTP submission (brute-force) | 5 failed attempts | 60 minutes (rolling) | Phone number |

This keying strategy prevents:
- Users from bombing themselves with 100 OTP requests
- VPN rotation from evading brute-force detection
- Rate-limit evasion by creating many accounts

## Data Storage

Phone numbers are stored securely using one-way hashing, as documented in [docs/adr/001-phone-storage.md](../adr/001-phone-storage.md).

**What is stored:**
- `phone_hash`: HMAC-SHA256 hash of the normalized E.164 number
- `phone_verified`: Boolean flag (true after successful verification)
- `phone_verified_at`: Timestamp of when verification succeeded

**What is NOT stored:**
- The user's raw phone number is not stored in the database
- Only the hash is recorded, so a database leak does not expose phone numbers

The Twilio Verify service handles the SMS delivery and OTP validation; BrandBlitz never stores or transmits the raw phone number except to Twilio.

## Retry and Error Handling

### Handling 429 (Rate Limited)

Always respect the `Retry-After` header. It tells you the number of seconds to wait before retrying:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 3456
Content-Type: application/json

{
  "error": "Too many verification attempts, please try again later"
}
```

Recommended retry strategy:
1. Parse the `Retry-After` header
2. Wait that many seconds (or a random amount up to that value)
3. Retry the request

### Handling 400 (Invalid Code)

An invalid code always returns 400:
```json
{
  "error": "Invalid verification code"
}
```

This could mean:
- The user entered the wrong 6 digits
- The OTP expired (10-minute window)
- The phone number doesn't match the one that received the OTP

Suggest the user request a fresh code via `POST /users/me/phone/send` and try again.

### Handling 409 (Number Already Verified)

If a phone number is already associated with another account:
```json
{
  "error": "Phone number already associated with another account"
}
```

The user must contact support to reclaim the phone number or use a different number.

## Example Implementation (JavaScript/TypeScript)

```typescript
async function verifyPhoneOtp(phone: string, code: string) {
  try {
    const res = await fetch("/users/me/phone/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
      console.log(`Rate limited. Retry after ${retryAfter} seconds.`);
      return { error: "rate_limited", retryAfter };
    }

    if (!res.ok) {
      const error = await res.json();
      return { error: res.status === 409 ? "phone_taken" : "invalid_code" };
    }

    return { success: true };
  } catch (err) {
    return { error: "network_error" };
  }
}

async function sendPhoneOtp(phone: string) {
  try {
    const res = await fetch("/users/me/phone/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
      return { error: "rate_limited", retryAfter };
    }

    if (!res.ok) {
      return { error: "invalid_phone" };
    }

    return { success: true };
  } catch (err) {
    return { error: "network_error" };
  }
}
```

## Related

- **Phone Storage (ADR 001)**: [docs/adr/001-phone-storage.md](../adr/001-phone-storage.md) — why we hash phone numbers instead of storing them raw
- **Rate Limiting**: [apps/api/src/middleware/rate-limit.ts](../../apps/api/src/middleware/rate-limit.ts) — configuration for all rate limiters
- **Phone Service**: [apps/api/src/services/phone.ts](../../apps/api/src/services/phone.ts) — OTP generation, verification, and brute-force protection
- **User Routes**: [apps/api/src/routes/users.ts](../../apps/api/src/routes/users.ts) — phone verification endpoints
