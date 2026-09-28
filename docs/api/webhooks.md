# Webhooks

BrandBlitz uses webhooks to deliver events from the deposit monitor and other asynchronous services. This guide covers the webhook contract, security, rate limiting, and retry semantics for integrators.

## Stellar Deposit Webhook

The `POST /webhooks/stellar/deposit` endpoint is called by the internal deposit monitor service whenever a USDC payment is detected on-chain that matches a pending challenge memo.

### Request Signature

Every webhook request is signed using HMAC-SHA256. The signature is validated by the `verifyWebhook` middleware before the handler is invoked.

**Headers:**
- `x-webhook-signature` (required): Format is `sha256=<hex>` where `<hex>` is the HMAC-SHA256 digest.
- `x-webhook-timestamp` (required): Unix seconds timestamp. Must be within 300 seconds (5 minutes) of the server's current time.
- `x-webhook-id` (required): Unique identifier for this webhook delivery. Used for idempotency.

**Signature Scheme:**
```
HMAC_SHA256(secret_key, timestamp + "." + raw_body)
```

The signature is computed over the concatenation of the timestamp and the raw request body, separated by a dot. The signature must match one of:
1. The current webhook secret (stored in `app_config` or `WEBHOOK_SECRET` env var)
2. A pending webhook secret (if one is configured with an unexpired `expiresAt` date)

This dual-secret support allows for gradual secret rotation without downtime.

**Example (Node.js):**
```typescript
import crypto from "crypto";

function signWebhookRequest(payload, timestamp, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest("hex");
}

// Validate an incoming request
const timestamp = req.headers["x-webhook-timestamp"];
const signature = req.headers["x-webhook-signature"].split("=")[1];
const expectedSignature = signWebhookRequest(
  req.rawBody,
  timestamp,
  YOUR_WEBHOOK_SECRET
);

const valid = crypto.timingSafeEqual(
  Buffer.from(expectedSignature, "hex"),
  Buffer.from(signature, "hex")
);
```

### Request Payload

```typescript
{
  memo: string;          // UUID of the challenge being funded
  txHash: string;        // 64-character hex Stellar transaction hash
  amount?: string;       // Optional decimal USDC amount (e.g., "1000.5")
}
```

**Validation rules:**
- `memo` must be a valid UUID (v4 or similar)
- `txHash` must be exactly 64 hexadecimal characters
- `amount` is optional but if provided must match `/^\d+(\.\d{1,7})?$/` (up to 7 decimals for stroops)

### Response Codes

| Code | Meaning | Action |
|---|---|---|
| **200 OK** | Webhook processed or idempotent duplicate | No retry needed |
| **400 Bad Request** | Invalid payload, missing timestamp, or stale timestamp | Do not retry; fix the request |
| **401 Unauthorized** | Invalid or missing signature | Do not retry; verify the secret |
| **404 Not Found** | No challenge found for this memo | Do not retry; the memo may be incorrect |
| **422 Unprocessable Entity** | Insufficient funds in the escrow contract | Retry after delay; funds may be replenished |
| **429 Too Many Requests** | Rate limit exceeded | Retry after `Retry-After` header (see below) |
| **500 Internal Server Error** | Webhook verification or database error | Retry with exponential backoff |

### Rate Limiting

The `webhookLimiter` middleware enforces a rate limit of **1000 requests per hour** per IP address. This is keyed by IP (not user ID) because webhooks are internal-to-internal traffic.

**On 429 response:**
```
HTTP/1.1 429 Too Many Requests
Retry-After: 120
Content-Type: application/json

{ "error": "Too many requests, please try again later" }
```

The `Retry-After` header specifies the number of seconds to wait before retrying. Implementers should use exponential backoff with jitter (e.g., starting at 2 seconds, doubling up to 5 minutes) to avoid thundering herd issues when the rate limit is lifted.

### Idempotency

Webhooks are delivered at-least-once, meaning the same delivery may arrive multiple times (e.g., if the deposit monitor restarts). To detect and skip duplicates, the system uses the `x-webhook-id` header and a 10-minute Redis cache.

**Duplicate handling (server-side):**
```
1. Receive webhook with x-webhook-id = "abc123"
2. Check Redis for key "webhook:id:abc123"
3. If exists → return 200 { status: "duplicate" }
4. If not exists → process the deposit and cache the ID for 10 minutes
```

This means:
- If you receive a 200 response with `status: "duplicate_tx_ignored"`, the same transaction has already been processed.
- If you receive a 200 response with `status: "activated"`, the challenge has been activated.
- Within 10 minutes of a successful 200 response, sending the same webhook again will return `status: "duplicate"`.

**Client retry strategy:**
Callers should track delivery via the response status:
- `status: "activated"` — challenge is now active; no further retry needed
- `status: "duplicate_tx_ignored"` — transaction already processed by the API (idempotent)
- `status: "duplicate"` — webhook ID was seen recently; you may have already processed this

If you do not receive a 200 response, implement exponential backoff retry (e.g., starting at 2 seconds, max 5 minutes, max 10 attempts).

### Challenge Activation Flow

When a webhook is processed successfully:

1. Check if the transaction has already been processed (idempotency check)
2. Look up the challenge by memo UUID
3. Verify the challenge is still in `pending_deposit` status
4. Check that the escrow contract has sufficient USDC balance
5. Update the challenge status to `active` and record the transaction hash
6. Return 200 with `{ status: "activated", challengeId: "..." }`

If any step fails (e.g., challenge not found, insufficient funds), an appropriate error is returned without modifying the challenge state.

## Related

- **Stellar Architecture**: See [docs/03-stellar-architecture.md](../03-stellar-architecture.md) for the end-to-end deposit flow and monitoring service.
- **Rate Limiting**: See [apps/api/src/middleware/rate-limit.ts](../../apps/api/src/middleware/rate-limit.ts) for all rate limiter configurations.
- **Webhook Verification**: See [apps/api/src/middleware/verify-webhook.ts](../../apps/api/src/middleware/verify-webhook.ts) for the signature verification implementation.
- **Webhook Route**: See [apps/api/src/routes/webhooks.ts](../../apps/api/src/routes/webhooks.ts) for the deposit endpoint.
