# Leaderboard API

Leaderboard endpoints expose global, per-challenge, and live-streaming rankings.

## Authentication

| Endpoint | Auth |
|---|---|
| `GET /leaderboard/global` | None (public) |
| `GET /leaderboard/:challengeId` | Optional (`authenticateOptional`) — pass token for `friends` scope |
| `GET /leaderboard/:challengeId/export.csv` | Optional — enables CSV download |
| `GET /leaderboard/stream` | None (public) |

---

## GET /leaderboard/global

Cross-challenge leaderboard. Aggregates top scores across the 10 most recent active challenges. Cached in Redis for 5 minutes.

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `sort_by` | `score` \| `earned` | `score` | Sort order |
| `limit` | integer | `100` | Max entries (capped at 100) |

### Example Request

```bash
curl https://api.brandblitz.io/leaderboard/global?limit=10
```

### Response

```json
{
  "data": [
    {
      "rank": 1,
      "challengeId": "c0a80001-0000-0000-0000-000000000001",
      "userId": "u0a80001-...",
      "username": "blitzmaster",
      "displayName": "Alex R.",
      "league": "gold",
      "avatarUrl": "https://assets.brandblitz.io/avatars/u0a8...png",
      "totalScore": 450,
      "totalEarned": 12.50
    }
  ],
  "nextCursor": null,
  "cachedAt": "2026-08-25T14:30:00.000Z"
}
```

---

## GET /leaderboard/:challengeId

Paginated leaderboard for a single challenge. Returns up to 100 sessions per page.

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `sort_by` | `score` \| `earned` | `score` | Sort order |
| `limit` | integer | `100` | Max entries per page (capped at 100) |
| `cursor` | string | — | Keyset cursor for next page (from `nextCursor`) |
| `scope` | `global` \| `friends` | `global` | `friends` filters to your referral network |

### Example Request

```bash
curl https://api.brandblitz.io/leaderboard/c0a80001-...?limit=10
```

### Response

```json
{
  "sessions": [
    {
      "rank": 1,
      "userId": "u0a80001-...",
      "username": "blitzmaster",
      "displayName": "Alex R.",
      "league": "gold",
      "avatarUrl": "https://assets.brandblitz.io/avatars/u0a8...png",
      "totalScore": 450,
      "totalEarned": 12.50
    }
  ],
  "data": [
    { "..." }
  ],
  "nextCursor": "eyJpZCI6Ij...",
  "scope": "global"
}
```

**Notes:**
- Both `sessions` and `data` are returned for backward compatibility; they contain identical arrays.
- Use `nextCursor` for pagination. An empty/null `nextCursor` means no more pages.
- When `scope=friends`, the leaderboard only includes users in your referral network. Requires a valid token.

---

## GET /leaderboard/:challengeId/export.csv

Streams the full challenge leaderboard as a CSV file (no pagination).

### Example Request

```bash
curl -o leaderboard.csv https://api.brandblitz.io/leaderboard/c0a80001-.../export.csv
```

### Response

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="leaderboard-c0a80001....csv"

rank,username,score,payout_amount_usdc
1,blitzmaster,450,12.50
2,starpupil,420,8.30
...
```

---

## GET /leaderboard/stream

Server-Sent Events (SSE) endpoint. Pushes leaderboard snapshots at a configurable interval. Ideal for building live-updating leaderboard UIs.

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `challengeId` | string | — | If provided, streams a single challenge; otherwise streams top-10 across active challenges |
| `intervalMs` | integer | `2000` | Snapshot interval in ms (min 500, max 30000) |
| `sort_by` | `score` \| `earned` | `score` | Sort order (validated but not yet used in stream output) |

### Example — Streaming with curl

```bash
curl -N https://api.brandblitz.io/leaderboard/stream?challengeId=c0a80001-...&intervalMs=3000
```

### SSE Event Format

Each snapshot is a `message` event with a JSON payload:

**Per-challenge mode** (`challengeId` provided):

```json
{
  "challengeId": "c0a80001-...",
  "sessions": [
    {
      "rank": 1,
      "userId": "u0a80001-...",
      "username": "blitzmaster",
      "displayName": "Alex R.",
      "league": "gold",
      "avatarUrl": "https://assets.brandblitz.io/avatars/u0a8...png",
      "totalScore": 450,
      "totalEarned": 12.50,
      "endedAt": "2026-08-25T14:00:00.000Z"
    }
  ],
  "updatedAt": "2026-08-25T14:30:00.000Z"
}
```

**Global mode** (no `challengeId`):

```json
{
  "leaderboard": [
    {
      "rank": 1,
      "challengeId": "c0a80001-...",
      "userId": "u0a80001-...",
      "username": "blitzmaster",
      "displayName": "Alex R.",
      "league": "gold",
      "avatarUrl": "https://assets.brandblitz.io/avatars/u0a8...png",
      "totalScore": 450,
      "totalEarned": 12.50
    }
  ],
  "updatedAt": "2026-08-25T14:30:00.000Z"
}
```

### Keep-Alive

The server sends a comment line `:keep-alive` every 15 seconds to prevent proxy timeouts. Your SSE client should treat these as no-ops.

### Recommended Reconnect / Backoff

The `useLiveLeaderboard` hook in the web app demonstrates production-grade reconnect logic:

1. **Exponential backoff** — start at 1s, double each attempt, cap at 30s. Add 50% jitter to avoid thundering-herd reconnection.
2. **Fallback to polling** — after the connection drops, poll `GET /leaderboard/global` or `GET /leaderboard/:challengeId` every 5 seconds until the stream reconnects.
3. **Max retries** — give up after 10 failed reconnection attempts and show a "disconnected" state to the user.
4. **Reset on success** — clear the retry counter on every successful message.

```typescript
// Pseudocode for reconnect with backoff
let attempts = 0;
function connect() {
  const source = new EventSource(url);
  source.onmessage = () => { attempts = 0; };
  source.onerror = () => {
    source.close();
    if (attempts >= 10) return; // give up
    const delay = Math.min(1000 * 2 ** attempts, 30000);
    const jitter = delay * 0.5 * Math.random();
    setTimeout(connect, delay + jitter);
    attempts++;
  };
}
```

See [`apps/web/src/hooks/use-live-leaderboard.ts`](../../apps/web/src/hooks/use-live-leaderboard.ts) for the full implementation.

---

## Response Schema (shared)

### Leaderboard Entry

```typescript
interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  league: "bronze" | "silver" | "gold";
  avatarUrl: string | null;
  totalScore: number;
  totalEarned: number; // USDC amount
}
```

### Error Responses

| Status | Body | Trigger |
|---|---|---|
| `400` | `{ "error": "Invalid leaderboard sort..." }` | Invalid `sort_by` value |
| `429` | `{ "error": "Too many requests..." }` | Rate limit exceeded |
