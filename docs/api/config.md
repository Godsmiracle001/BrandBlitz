# Public Config API

`GET /api/config` returns a flat object of whitelisted runtime configuration values. It is safe to call without authentication and is consumed by the frontend via `use-public-config.ts`.

## Endpoint

```
GET /api/config
```

No authentication required.

## Caching

The response is cached in Redis for **60 seconds** (`PUBLIC_CONFIG_CACHE_TTL_SECONDS`).

HTTP headers returned on every response:

| Header | Value |
|--------|-------|
| `Cache-Control` | `public, max-age=60` |
| `X-Cache` | `HIT` or `MISS` |

A `HIT` means the value was served from Redis. A `MISS` means it was read from the database and then written to the cache.

## Response

```json
{
  "game_round_duration_seconds": 30,
  "max_rounds_per_session": 10,
  "maintenance_mode": false
}
```

All fields are optional — if a key has not been set in `app_config` it is omitted from the response.

| Field | Type | Description |
|-------|------|-------------|
| `game_round_duration_seconds` | `number` | How long each challenge round lasts in seconds. |
| `max_rounds_per_session` | `number` | Maximum number of rounds a player can complete in a single session. |
| `maintenance_mode` | `boolean` | When `true` the frontend should display a maintenance banner and disable challenge entry. |

## Public vs internal keys

Only keys listed in `PUBLIC_CONFIG_KEYS` (`apps/api/src/db/queries/config.ts`) are ever returned. Admin-only keys (anti-cheat thresholds, payout parameters, escrow config) are stored in the same `app_config` table but are never included in this response.

## Frontend usage

`apps/web/src/hooks/use-public-config.ts` fetches this endpoint on app load and exposes the values via React context. Components that need `maintenance_mode` or round timing should read from that hook rather than calling this endpoint directly.
