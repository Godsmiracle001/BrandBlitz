# API Authentication

BrandBlitz supports two parallel authentication mechanisms. Both are accepted simultaneously so clients can migrate gradually.

## Bearer Token (current default)

A short-lived JWT is issued at login and sent as an `Authorization: Bearer <token>` header on every request. The API validates it via the `authenticate` middleware.

## Cookie / Session (httpOnly)

The API enables `cors({ credentials: true })` and is scoped to the specific dashboard origin (`WEB_URL` env var — never a wildcard). The frontend axios client sets `withCredentials: true` so the browser attaches cookies automatically.

This means:
- An `httpOnly` session cookie set by a future `/auth/session` endpoint will travel with every cross-origin request.
- The CORS policy rejects requests from unlisted origins even with credentials.

### Why both?

| Mechanism | Benefit |
|---|---|
| Bearer token | Stateless; easy to use from native apps and CLIs |
| httpOnly cookie | Not accessible to JavaScript; resistant to XSS token theft |

### Required API server config

```
WEB_URL=https://app.brandblitz.io   # must NOT be *
```

The browser will refuse to send credentials to a wildcard origin, so `WEB_URL` must always be a specific origin.
## Related API docs

- [Rate limits and error codes](./rate-limits-and-errors.md)
- [OpenAPI and Scalar UI guide](./using-the-openapi-spec.md)

---

## Auth Endpoints

### GET /auth/google/authorize

Returns a Google OAuth 2.0 authorization URL (PKCE flow). Redirect the user's browser to the returned URL.

```bash
curl "https://api.brandblitz.io/auth/google/authorize?callbackUrl=%2Fdashboard"
```

**Response `200 OK`**

```json
{
  "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&code_challenge=...&state=..."
}
```

---

### POST /auth/google/callback

Exchange the Google authorization code (or `idToken` from a mobile Google Sign-In) for BrandBlitz access and refresh tokens.

**Option A — Authorization code (PKCE)**

```bash
curl -X POST https://api.brandblitz.io/auth/google/callback \
  -H "Content-Type: application/json" \
  -d '{
    "code": "<google_auth_code>",
    "state": "<state_param_from_authorize_response>"
  }'
```

**Option B — ID token (mobile / one-tap)**

```bash
curl -X POST https://api.brandblitz.io/auth/google/callback \
  -H "Content-Type: application/json" \
  -d '{ "idToken": "<google_id_token>" }'
```

**Response `200 OK`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "usr_01HXYZ",
    "email": "player@example.com",
    "displayName": "Alice",
    "username": "alice",
    "avatarUrl": "https://lh3.googleusercontent.com/...",
    "role": "player",
    "status": "active"
  }
}
```

Store `token` (access token) and `refreshToken` securely. The access token is short-lived (~15 minutes); use the refresh token to obtain a new one without re-authenticating.

---

### GET /auth/me

Returns the profile of the currently authenticated user.

```bash
curl https://api.brandblitz.io/auth/me \
  -H "Authorization: Bearer <access_token>"
```

**Response `200 OK`**

```json
{
  "user": {
    "id": "usr_01HXYZ",
    "email": "player@example.com",
    "displayName": "Alice",
    "username": "alice",
    "avatarUrl": "https://lh3.googleusercontent.com/...",
    "role": "player",
    "status": "active"
  }
}
```

---

### POST /auth/refresh

Exchanges a valid refresh token for a new access token and a rotated refresh token. Refresh tokens are single-use — reusing an old token immediately revokes **all** sessions for that user.

```bash
curl -X POST https://api.brandblitz.io/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<refresh_token>" }'
```

**Response `200 OK`**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Token lifetime**

| Token | Lifetime | Notes |
|---|---|---|
| Access token | ~15 minutes | Send as `Authorization: Bearer <token>` |
| Refresh token | 30 days | Single-use; rotate on every call |

**Error codes**

| Status | Code | Meaning |
|---|---|---|
| `401` | `INVALID_REFRESH_TOKEN` | Token is malformed, expired, or unknown |
| `401` | `TOKEN_REVOKED` | Token was explicitly revoked (e.g. logout) |
| `401` | `TOKEN_REUSE` | Token was already used — all sessions revoked |

---

### POST /auth/logout

Invalidates the provided refresh token. The access token remains valid until it naturally expires (~15 minutes) — clients should discard it locally.

```bash
curl -X POST https://api.brandblitz.io/auth/logout \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<refresh_token>" }'
```

**Response `200 OK`**

```json
{ "ok": true }
```

---

## End-to-End Example

The following sequence shows a complete login → authenticated request flow using curl.

```bash
# 1. Get the Google OAuth URL
AUTH_URL=$(curl -s "https://api.brandblitz.io/auth/google/authorize" | jq -r '.url')
echo "Open this URL in a browser: $AUTH_URL"

# 2. After Google redirects back with an ID token (mobile / one-tap flow):
TOKENS=$(curl -s -X POST https://api.brandblitz.io/auth/google/callback \
  -H "Content-Type: application/json" \
  -d '{ "idToken": "<google_id_token>" }')

ACCESS_TOKEN=$(echo "$TOKENS" | jq -r '.token')
REFRESH_TOKEN=$(echo "$TOKENS" | jq -r '.refreshToken')

# 3. Call an authenticated endpoint
curl https://api.brandblitz.io/users/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 4. Refresh when the access token expires
NEW_TOKENS=$(curl -s -X POST https://api.brandblitz.io/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}")

ACCESS_TOKEN=$(echo "$NEW_TOKENS" | jq -r '.token')
REFRESH_TOKEN=$(echo "$NEW_TOKENS" | jq -r '.refreshToken')

# 5. Logout
curl -X POST https://api.brandblitz.io/auth/logout \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}"
```
