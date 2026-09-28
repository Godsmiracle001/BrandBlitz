# API Surface Overview

This document lists every route namespace in the BrandBlitz API and its access level. Read this before building a third-party integration — **admin routes are not part of the public API contract** and may change without notice.

## Access Levels

| Level | Middleware | Who can call it |
|---|---|---|
| **Public** | None / `apiLimiter` only | Anyone — no token required |
| **Player-authenticated** | `authenticate` | Any logged-in player or brand |
| **Brand-authenticated** | `authenticate` + role check | Accounts with `role = brand` |
| **Admin-only** | `authenticate` + `requireAdmin` | Internal staff accounts (`role = admin`) |

---

## Public Routes (no token required)

| Route prefix | File | Notes |
|---|---|---|
| `GET /brands/:id` | `routes/brands.ts` | Public brand profile |
| `GET /brands/:id/challenges` | `routes/brands.ts` | Active challenges for a brand |
| `GET /challenges` | `routes/challenges.ts` | Challenge listing |
| `GET /challenges/:id` | `routes/challenges.ts` | Challenge detail |
| `GET /leaderboard` | `routes/leaderboard.ts` | Global leaderboard (see [leaderboard.md](./leaderboard.md)) |
| `GET /users/profile/:username` | `routes/users.ts` | Public player profile |
| `GET /users/:username/public` | `routes/users.ts` | Public stats |
| `GET /users/:username/activity` | `routes/users.ts` | Public activity feed |
| `GET /leagues` | `routes/leagues.ts` | League listing (see [leagues.md](./leagues.md)) |
| `GET /legal/*` | `routes/legal.ts` | Terms / privacy pages |
| `GET /config` | `routes/config.ts` | Client feature flags |
| `GET /docs` | `routes/docs.ts` | Interactive OpenAPI UI |
| `GET /docs/openapi.json` | `routes/docs.ts` | OpenAPI spec |
| `POST /waitlist` | `routes/waitlist.ts` | Join the waitlist (see [waitlist.md](./waitlist.md)) |
| `POST /csp-report` | `routes/csp-report.ts` | Browser CSP violation reports |

---

## Player-Authenticated Routes

Require `Authorization: Bearer <access_token>`.

| Route prefix | File | Key endpoints |
|---|---|---|
| `/auth/*` | `routes/auth.ts` | `GET /me`, `POST /refresh`, `POST /logout` |
| `/users/me` | `routes/users.ts` | Profile, wallet, notifications, badges, earnings, referrals |
| `/users/me/notifications` | `routes/users.ts` | List, mark-read (see [notifications.md](./notifications.md)) |
| `/users/me/wallet` | `routes/users.ts` | `PATCH` — link Stellar wallet (see [wallet-and-payouts.md](../guides/wallet-and-payouts.md)) |
| `/users/me/phone/*` | `routes/users.ts` | Phone verification send / confirm |
| `/users/:id/badges` | `routes/users.ts` | Badges for any user (auth required, see [badges.md](./badges.md)) |
| `/users/search` | `routes/users.ts` | User search |
| `/users/me/referrals` | `routes/users.ts` | Referral stats and list |
| `/challenges/:id/sessions` | `routes/sessions.ts` | Submit and retrieve game sessions |
| `/upload` | `routes/upload.ts` | File upload (avatar, assets) |
| `/webhooks` | `routes/webhooks.ts` | Inbound webhook events |
| `/me/delete-account` | `routes/me/delete-account.ts` | Account deletion |

---

## Brand-Authenticated Routes

Require a valid token with `role = brand`.

| Route prefix | File | Key endpoints |
|---|---|---|
| `POST /brands` | `routes/brands.ts` | Create a brand |
| `PATCH /brands/:id` | `routes/brands.ts` | Update brand profile |
| `POST /brands/:id/challenges` | `routes/brands.ts` | Create a challenge |
| `PATCH /challenges/:id` | `routes/challenges.ts` | Edit a challenge |
| `DELETE /challenges/:id` | `routes/challenges.ts` | Soft-delete a challenge |
| `/brands/:id/deposit-info` | `routes/brands.ts` | Escrow deposit instructions |
| `/brands/:id/webhooks` | `routes/brand-webhooks.ts` | Manage brand webhooks |

---

## Admin-Only Routes

> ⚠️ **These routes are not part of the public API.** They require a staff account with `role = admin`. Calling them with a player or brand token returns `403 Forbidden`. They may change or be removed without a deprecation period.

All admin routes are mounted under `/admin/*`.

| Route prefix | File | Purpose |
|---|---|---|
| `/admin/config` | `routes/admin/config.ts` | Runtime feature flag management |
| `/admin/users` | `routes/admin/users.ts` | User search, role updates, bans |
| `/admin/fraud-flags` | `routes/admin/fraud.ts` | View and action fraud signals |
| `/admin/challenges` | `routes/admin/challenges.ts` | Challenge moderation and settlement override |
| `/admin/cache` | `routes/admin/cache.ts` | Cache invalidation |
| `/admin/escrow` | `routes/admin/escrow.ts` | Escrow inspection and manual release |
| `/admin/audit-log` | `routes/admin/audit-log.ts` | Immutable audit trail |
| `/admin/payouts` | `routes/admin/payouts.ts` | Payout queue management and retry |
| `/admin/stats` | `routes/admin/stats.ts` | Platform KPIs and aggregate metrics |
| `/admin/queue-stats` | `routes/admin/queue-stats.ts` | BullMQ job queue health |
| `/admin/waitlist` | `routes/admin/waitlist.ts` | Waitlist management |
| `/admin/test` | `routes/admin/test.ts` | Internal test helpers (non-production) |
| `/admin` (general) | `routes/admin.ts` | Dead-letter queue triage, archive inspection |

---

## Observability (internal)

| Route | Notes |
|---|---|
| `GET /metrics` | Prometheus metrics — restrict via network policy in production |

---

## Further Reading

- [Auth endpoints and curl examples](./auth.md)
- [Badges API — catalog and earning criteria](./badges.md)
- [Leaderboard API — global, per-challenge, and SSE stream](./leaderboard.md)
- [Leagues API — weekly league tiers and promotion rules](./leagues.md)
- [Notifications API](./notifications.md)
- [Public Brands API](./public-brands.md)
- [Waitlist API — signup and position lookup](./waitlist.md)
- [Webhooks](./webhooks.md)
- [Wallet and Payouts Guide](../guides/wallet-and-payouts.md)
- [README — API section](../../README.md#api)
