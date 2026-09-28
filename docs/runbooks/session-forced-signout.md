# Runbook: Session Forced Sign-Out

## Overview

BrandBlitz uses **refresh-token rotation** with a Redis-backed revocation list.
Every `/auth/refresh` call issues a new refresh token and marks the old `jti` as
used. If a used `jti` is presented again (reuse attack), **all** of the user's
refresh tokens are revoked and the user is force-signed-out.

## Trigger scenarios

| Scenario | Behaviour |
| --- | --- |
| Normal rotation | Old jti marked `used`; new tokens issued |
| Reuse of a used jti | All user jtis revoked; `401 TOKEN_REUSE` |
| Explicit logout | Current jti marked `used`; `200 ok` |
| Token expired | `401 INVALID_REFRESH_TOKEN` |

## Redis keys

| Key | Purpose | TTL |
| --- | --- | --- |
| `jti:<uuid>` | Marks a jti as used/revoked | 30 days |
| `user_refresh_jtis:<userId>` | Set of active refresh jtis | 30 days |

## Force sign-out a user (operator)

```bash
# Revoke all refresh tokens for a user
redis-cli SMEMBERS user_refresh_jtis:<userId>
# For each jti:
redis-cli SET jti:<jti> revoked EX 2592000
redis-cli DEL user_refresh_jtis:<userId>
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `JWT_SECRET` | required | Signs access tokens (min 32 chars) |
| `JWT_REFRESH_SECRET` | falls back to `JWT_SECRET` | Signs refresh tokens |

## Monitoring

Alert if `TOKEN_REUSE` errors exceed 5/min for a single user — indicates a
potential credential leak or replay attack.
