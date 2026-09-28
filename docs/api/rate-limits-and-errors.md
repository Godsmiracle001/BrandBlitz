# Rate Limits and API Errors

BrandBlitz uses application-layer rate limits in `apps/api/src/middleware/rate-limit.ts`. Authenticated requests are usually keyed by JWT `sub`; public or pre-authentication flows are keyed by IP or another route-specific identifier.

## Limiters

| Limiter | Limit | Key | Route usage |
|---|---:|---|---|
| `apiLimiter` | Dynamic requests per 15 minutes, default 200 | User ID when authenticated, otherwise IP | General protected/public API reads including `/brands`, `/users/profile/:username`, `/users/:username/public`, `/users/:username/activity`, and `GET /waitlist/position/:email` |
| `authLimiter` | 10 requests per 15 minutes | IP | `GET /auth/google/authorize`, `POST /auth/google/callback` |
| `challengeStartLimiter` | 5 requests per hour | User ID when authenticated, otherwise IP | `POST /sessions/:challengeId/start` |
| `uploadLimiter` | 20 requests per hour | User ID when authenticated, otherwise IP | `POST /upload/presign` |
| `webhookLimiter` | 1000 requests per hour | IP | `POST /webhooks/stellar/deposit` |
| `phoneRateLimit` | 3 requests per 15 minutes | Normalized phone number, falling back to user/IP | `POST /users/me/phone/send` |
| `webhookRotationLimiter` | 10 requests per hour | User ID when authenticated, otherwise IP | Defined for admin webhook rotation flows; check the route before relying on current coverage |
| `waitlistLimiter` | 5 requests per hour | IP | `POST /waitlist` |
| `questionPreviewLimiter` | 10 requests per hour | Brand ID | `POST /brands/:id/questions/preview` |
| `reportLimiter` | 5 requests per 15 minutes | User ID when authenticated, otherwise IP | `POST /challenges/:id/report` |

Redis-backed limiters are configured with `passOnStoreError: true` where applicable, so a Redis outage fails open for those routes rather than blocking normal users.

## 429 headers

The API uses `express-rate-limit` draft standard headers and disables legacy headers. Clients should expect standard rate-limit headers when the limiter applies.

`phoneRateLimit` also sets:

```text
Retry-After: 900
```

Other custom handlers return a 429 body but do not explicitly set `Retry-After` in the route handler.

## 429 bodies

Examples:

```json
{ "error": "Too many requests, please try again later" }
```

```json
{ "error": "Too many signup attempts, please try again later" }
```

```json
{ "error": "Too many verification attempts, please try again later" }
```

## Error envelope

The global error handler returns JSON with an `error` field:

```json
{ "error": "Validation Error" }
```

When an application error includes a code, non-production responses include it:

```json
{
  "error": "Invalid email address",
  "code": "INVALID_EMAIL"
}
```

Zod validation errors also include `details` outside production:

```json
{
  "error": "Validation Error",
  "details": [
    {
      "path": ["email"],
      "message": "Invalid email",
      "code": "invalid_string"
    }
  ]
}
```

Production server errors are intentionally generic and include the request ID when available:

```json
{
  "error": "Internal Server Error",
  "requestId": "<request-id>"
}
```

## Common status codes

| Status | Meaning |
|---:|---|
| 400 | Bad request or schema validation failure |
| 401 | Missing, invalid, or expired authentication |
| 403 | Authenticated caller is not allowed to perform the action |
| 404 | Resource was not found |
| 409 | Duplicate resource or database constraint conflict |
| 422 | Semantically invalid request body, such as an invalid waitlist email |
| 429 | Rate limit exceeded |
| 500 | Unexpected server error |