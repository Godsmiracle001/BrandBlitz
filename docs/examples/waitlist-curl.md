# Waitlist API curl Examples

The waitlist routes are mounted from `apps/api/src/routes/waitlist.ts`.

Use the proxy base URL in Docker or production:

```bash
export API_URL=http://localhost:4000
```

If you call the API process directly during development, use `http://localhost:3001` instead.

## Join the waitlist

```bash
curl -i -X POST "$API_URL/waitlist" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "founder@example.com",
    "referral_code": "launch-partner"
  }'
```

Success response:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{ "message": "You're on the list!" }
```

`referral_code` is optional and can be omitted:

```bash
curl -i -X POST "$API_URL/waitlist" \
  -H 'Content-Type: application/json' \
  -d '{ "email": "founder@example.com" }'
```

## Validation error

`email` must be a valid email address with a maximum length of 254 characters. `referral_code`, when present, must be at most 64 characters.

```bash
curl -i -X POST "$API_URL/waitlist" \
  -H 'Content-Type: application/json' \
  -d '{ "email": "not-an-email" }'
```

Response:

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{
  "error": "Invalid email address",
  "code": "INVALID_EMAIL"
}
```

## Look up waitlist position

```bash
curl -i "$API_URL/waitlist/position/founder@example.com" \
  -H 'Accept: application/json'
```

Success response:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "position": 42 }
```

If the email is not on the waitlist:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{ "error": "Email not found on waitlist" }
```

## Rate-limited response

`POST /waitlist` uses `waitlistLimiter`, which allows 5 signup attempts per hour per IP. After the limit is exceeded:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{ "error": "Too many signup attempts, please try again later" }
```

`GET /waitlist/position/:email` uses the general `apiLimiter` bucket.

## Browser origins and CORS

Browser-based waitlist forms must be served from an origin allowed by the API CORS configuration. In local development, keep the landing page origin aligned with the configured web origin. In production, external partner landing pages need their origin explicitly allowed before the browser can make credentialed cross-origin calls.

Server-to-server `curl` calls are not subject to browser CORS enforcement.