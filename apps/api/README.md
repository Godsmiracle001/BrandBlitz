# BrandBlitz API

Express 5 REST API for BrandBlitz. Handles authentication, game sessions, scoring, leaderboards, Stellar webhooks, and async payout dispatch via BullMQ.

---

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Getting Started](#getting-started)
- [Operational Scripts](#operational-scripts)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
  - [Auth](#auth-routes)
  - [Challenges](#challenges-routes)
  - [Sessions (Game)](#sessions-routes)
  - [Brands](#brands-routes)
  - [Upload](#upload-routes)
  - [Leaderboard](#leaderboard-routes)
  - [Users](#users-routes)
  - [Webhooks](#webhooks-routes)
- [Middleware](#middleware)
- [Services](#services)
- [Database](#database)
- [Queue & Worker](#queue--worker)
- [Error Handling](#error-handling)
- [Building & Running](#building--running)

---

## Overview

The API runs on **Express 5** — async errors thrown inside route handlers automatically propagate to the global error handler without `try/catch` wrappers. It is stateless (all game state in PostgreSQL + Redis) and designed to run behind an Nginx reverse proxy.

The **worker** (`src/worker.ts`) is a separate entry point that runs the BullMQ payout processor. It uses the same Docker image but is started with a different command. It has no HTTP server.

---

## Directory Structure

```
apps/api/
├── Dockerfile
├── .dockerignore
├── package.json
├── tsconfig.json
├── tsup.config.ts              # Build config: entry points, CJS output
└── src/
    ├── index.ts                # Express app entry + graceful shutdown
    ├── worker.ts               # BullMQ worker entry (no HTTP)
    ├── routes/
    │   ├── index.ts            # registerRoutes(app) — mounts all routers
    │   ├── auth.ts             # POST /auth/google/callback, GET /auth/me
    │   ├── brands.ts           # CRUD brand kits + challenge creation
    │   ├── challenges.ts       # List/get challenges + leaderboard
    │   ├── sessions.ts         # Warmup, answer, scoring
    │   ├── upload.ts           # Presigned URL generation + verification
    │   ├── leaderboard.ts      # Global + per-challenge leaderboards
    │   ├── users.ts            # Profile, wallet, phone verification
    │   └── webhooks.ts         # Stellar deposit webhook
    ├── middleware/
    │   ├── authenticate.ts     # JWT validation; adds req.user
    │   ├── rate-limit.ts       # Redis-backed rate limiters
    │   ├── anti-cheat.ts       # Reaction time + device fingerprint checks
    │   └── error.ts            # Global Express 5 error handler
    ├── services/
    │   ├── scoring.ts          # Round score + payout share calculation
    │   ├── questions.ts        # Auto-generate 3-question sets from brand kit
    │   ├── payout.ts           # Payout orchestration; enqueues BullMQ jobs
    │   └── phone.ts            # Twilio Verify wrapper
    ├── queues/
    │   ├── payout.queue.ts     # BullMQ Queue definition
    │   └── processors/
    │       └── payout.processor.ts  # BullMQ Worker + job handler
    ├── db/
    │   ├── index.ts            # pg Pool + typed query<T>() helper
    │   └── queries/
    │       ├── users.ts        # findUserByEmail, upsertUser, etc.
    │       ├── brands.ts       # createBrand, getBrandsByOwner, etc.
    │       ├── challenges.ts   # createChallenge, getActiveChallenges, etc.
    │       ├── sessions.ts     # createSession, recordRoundScore, etc.
    │       └── payouts.ts      # createPayout, updatePayoutStatus, etc.
    └── lib/
        ├── redis.ts            # ioredis client (maxRetriesPerRequest: null)
        └── logger.ts           # winston: JSON in prod, colorized in dev
```

---

## Getting Started

```bash
# From the monorepo root
pnpm install

# Copy and configure env
cp ../../.env.example .env

# Start infrastructure (Postgres + Redis + MinIO)
docker compose up postgres redis minio minio-setup

# Run the API in dev mode (tsx watch)
pnpm --filter @brandblitz/api dev

# Run the worker in dev mode (separate terminal)
pnpm --filter @brandblitz/api dev:worker
```

The API listens on `PORT` (default `3001`). In the full Docker stack, Nginx proxies `/api/*` → `http://api:3001/`.

If you are applying schema changes locally, run `pnpm --filter @brandblitz/api migrate`. The dry-run form is `pnpm --filter @brandblitz/api migrate:dryrun`.

To fire test requests at a running API, open [`requests.http`](./requests.http) with the VS Code REST Client extension or the JetBrains HTTP Client. It covers auth, challenges and leaderboard routes from [`docs/openapi.yml`](../../docs/openapi.yml); set `@baseUrl` and paste an access token for authenticated calls (`Authorization: Bearer <accessToken>`).

---

## Operational Scripts

Dev-time CLI helpers, all run from the monorepo root via `pnpm --filter @brandblitz/api <script>`:

### `seed`

Populates the database with deterministic local fixtures (50 users, 3 brands, 6
challenges, 200 game sessions). Idempotent — safe to re-run.

```bash
pnpm --filter @brandblitz/api seed                 # seed once
pnpm --filter @brandblitz/api seed -- --reset      # wipe seed fixtures, then re-seed
```

Set `SEED_DEV=1` to auto-seed on `docker compose up` (see `docker-compose.override.yml`).

The placeholder brand logos the seed references live in
[`scripts/fixtures/`](./scripts/fixtures/README.md). That README lists each fixture file and
explains how it relates to `seed.ts` and the root-level `scripts/seed-e2e-challenge.ts`.

### `db:reset`

Fully resets local PostgreSQL: drops and recreates the schema, reapplies every
migration, and (with `--seed`) re-seeds the fixtures.

```bash
pnpm --filter @brandblitz/api db:reset                 # wipe + re-migrate
pnpm --filter @brandblitz/api db:reset --seed          # ...and re-seed
pnpm db:reset -- --seed                                # same from the monorepo root
```

This wipes **all** data — it refuses non-local `DATABASE_URL` hosts unless `--force` is passed.

### `admin:grant`

Grants the `admin` role to an existing user by email:

```bash
pnpm --filter @brandblitz/api admin:grant someone@example.com
```

Prints the granted user's email and id on success, or errors if the user does not exist.

### `gen:openapi`

Regenerates [`docs/openapi.yml`](../../docs/openapi.yml) from the zod route
schemas registered in `src/routes/openapi/*.openapi.ts`. Run it after any
route/schema change and commit the diff — CI (`gen:openapi:check`) fails when
the committed spec drifts from the actual routes.

```bash
pnpm --filter @brandblitz/api gen:openapi              # one-shot regeneration
pnpm --filter @brandblitz/api gen:openapi -- --watch   # regenerate on every change under src/routes/
```

To keep `docs/openapi.yml` in sync while you develop, run the watcher (the
`dev:openapi` script) alongside the API dev server in a second terminal:

```bash
pnpm --filter @brandblitz/api dev          # terminal 1 — API dev server (tsx watch)
pnpm --filter @brandblitz/api dev:openapi  # terminal 2 — rewrites docs/openapi.yml on route changes
```

`--watch` uses `fs.watch` (recursive) on `src/routes/` and respawns the
generator in a fresh process per change, so its output is byte-identical to a
one-shot run. Stop it with `Ctrl-C`.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port (default: `3001`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_SECRET` | Yes | HMAC secret for signing JWTs |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth app client secret |
| `STELLAR_NETWORK` | Yes | `testnet` or `public` |
| `STELLAR_HORIZON_URL` | Yes | Horizon base URL |
| `STELLAR_RPC_URL` | Yes | Soroban RPC URL |
| `STELLAR_HOT_WALLET_SECRET` | Yes | Secret key for payout wallet |
| `USDC_ISSUER` | Yes | USDC asset issuer address |
| `S3_ENDPOINT` | Yes | S3-compatible endpoint |
| `S3_REGION` | Yes | Region (e.g. `us-east-1`) |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret key |
| `S3_BUCKET` | Yes | Bucket name |
| `S3_PUBLIC_URL` | Yes | Base URL for public asset access |
| `S3_FORCE_PATH_STYLE` | No | `"true"` for MinIO (dev) |
| `TWILIO_ACCOUNT_SID` | No | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | No | Twilio auth token |
| `TWILIO_VERIFY_SERVICE_SID` | No | Twilio Verify service SID |
| `WEBHOOK_SECRET` | Yes | `X-Webhook-Secret` header value |
| `NEXTAUTH_URL` | Yes | Frontend base URL (for CORS) |

---

## API Reference

All routes are mounted under the base path the proxy uses (`/api` in Docker). Direct calls during development hit `http://localhost:3001` without the `/api` prefix.

Authentication uses **Bearer JWTs** in the `Authorization` header. The JWT payload is `{ sub: userId, email }`.

---

### Auth Routes

#### `POST /auth/google/callback`

Called by next-auth after Google OAuth. Creates or updates the user in the database, issues an API JWT.

**Body:**
```json
{
  "googleId": "1234567890",
  "email": "user@example.com",
  "name": "Jane Smith",
  "picture": "https://..."
}
```

**Response `200`:**
```json
{
  "token": "<jwt>",
  "user": { "id": "...", "email": "...", "displayName": "..." }
}
```

---

#### `GET /auth/me`

Returns the authenticated user's profile.

**Headers:** `Authorization: Bearer <token>`

**Response `200`:**
```json
{
  "user": {
    "id": "uuid",
    "email": "...",
    "displayName": "...",
    "stellarAddress": null,
    "phoneVerified": false,
    "league": "bronze"
  }
}
```

---

### Challenges Routes

#### `GET /challenges`

List active challenges. Supports `?limit=N&offset=N&brandId=uuid`.

**Response `200`:**
```json
{
  "challenges": [
    {
      "id": "uuid",
      "brandName": "Acme Corp",
      "logoUrl": "https://...",
      "primaryColor": "#6366f1",
      "poolAmountUsdc": "100.0000000",
      "status": "active",
      "endsAt": "2026-04-04T12:00:00Z",
      "participantCount": 42
    }
  ]
}
```

---

#### `GET /challenges/:id`

Returns challenge details plus the 3 questions for this challenge. **Correct answers are withheld** — only `questionText`, `optionA/B/C/D`, and `round` are returned.

**Response `200`:**
```json
{
  "challenge": { "id": "...", "brandName": "...", ... },
  "questions": [
    {
      "round": 1,
      "questionText": "What is Acme Corp's tagline?",
      "optionA": "Just Do It",
      "optionB": "We Build Tomorrow",
      "optionC": "Think Different",
      "optionD": "Always Coca-Cola"
    }
  ]
}
```

---

#### `GET /challenges/:id/leaderboard`

Returns the top scores for a specific challenge.

**Response `200`:**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "userId": "...",
      "displayName": "Jane",
      "totalScore": 420,
      "totalEarned": "15.3200000"
    }
  ]
}
```

---

### Sessions Routes

All session routes require authentication.

#### `POST /sessions/:challengeId/warmup-start`

Called when the user begins the warmup phase. Creates a session row.

**Body:** `{ "deviceId": "fingerprintjs-visitor-id" }` (optional)

**Response `200`:** `{ "sessionId": "uuid" }`

---

#### `POST /sessions/:challengeId/warmup-complete`

Called after the user has viewed warmup content. Server enforces a minimum of **20 seconds** since `warmup-start`. On success, returns a short-lived `challengeToken`.

**Response `200`:** `{ "challengeToken": "<signed-token>" }`

**Response `403`:** If called before 20 seconds have elapsed.

---

#### `POST /sessions/:challengeId/start`

Transitions session to `active`. Requires the `challengeToken` from `warmup-complete`.

**Body:** `{ "challengeToken": "..." }`

**Response `200`:** `{ "started": true }`

---

#### `POST /sessions/:challengeId/answer/:round`

Submit an answer for round 1, 2, or 3. Round must be submitted in order. The server validates the answer and returns the score immediately.

**Body:**
```json
{
  "selectedOption": "B",
  "reactionTimeMs": 4200
}
```

**Response `200`:**
```json
{
  "correct": true,
  "score": 137,
  "totalScore": 137
}
```

The `correct_option` is **never** included in the response.

---

### Brands Routes

All routes require authentication. Brand creation routes additionally check `role === 'brand'` or auto-promote the user.

#### `GET /brands`

Returns all brand kits owned by the authenticated user.

#### `GET /brands/:id`

Returns a single brand kit. Owners get full details; public access gets limited fields.

#### `POST /brands`

Creates a new brand kit. Triggers background image optimisation (WebP, resized) via `packages/storage`.

**Body:**
```json
{
  "name": "Acme Corp",
  "tagline": "We Build Tomorrow",
  "description": "Long brand story...",
  "primaryColor": "#6366f1",
  "logoKey": "brand-logo/uuid.webp",
  "productImageKeys": ["product-image/uuid.webp"]
}
```

**Response `201`:** `{ "brand": { ... } }`

---

#### `POST /brands/:brandId/challenges`

Creates a challenge for a brand kit, generates 3 quiz questions from the brand's content, and returns deposit instructions.

**Body:**
```json
{
  "poolAmountUsdc": "100.00",
  "durationHours": 72
}
```

**Response `201`:**
```json
{
  "challenge": { "id": "...", "status": "pending_deposit" },
  "depositAddress": "G...",
  "memo": "BLITZ-A1B2C3",
  "instructions": "Send exactly 100.00 USDC to G... with memo BLITZ-A1B2C3"
}
```

---

### Upload Routes

#### `POST /upload/presign`

Returns a presigned S3 PUT URL valid for 60 seconds. Files are uploaded directly from the browser to MinIO/S3 — they never pass through Express.

**Body:**
```json
{
  "filename": "logo.png",
  "contentType": "image/png",
  "uploadType": "brand-logo"
}
```

**Response `200`:**
```json
{
  "presignedUrl": "https://...",
  "key": "brand-logo/uuid.png",
  "publicUrl": "https://..."
}
```

---

#### `POST /upload/verify`

Calls `HeadObject` to confirm the file was actually uploaded before saving the key to the database.

**Body:** `{ "key": "brand-logo/uuid.png" }`

**Response `200`:** `{ "verified": true, "size": 45312 }`

---

### Leaderboard Routes

#### `GET /leaderboard/global`

All-time top 100 players across all challenges. Cached in Redis for 5 minutes.

#### `GET /leaderboard/:challengeId`

Live leaderboard for a specific challenge. No cache — reflects real-time scores.

---

### Users Routes

#### `GET /users/me`

Full authenticated user profile including stats and recent sessions.

#### `PATCH /users/me/wallet`

Set or update the user's Stellar address.

**Body:** `{ "stellarAddress": "G..." }`

#### `POST /users/me/phone/send`

Send a Twilio Verify OTP to the user's phone number.

**Body:** `{ "phoneNumber": "+15551234567" }`

#### `POST /users/me/phone/verify`

Verify the OTP. Marks `phone_verified = true` on success.

**Body:** `{ "phoneNumber": "+15551234567", "code": "123456" }`

#### `GET /users/profile/:username`

Public profile — display name, stats, recent sessions. No auth required.

---

### Webhooks Routes

#### `POST /webhooks/stellar`

Called by a Stellar event listener when a USDC deposit is detected. Protected by `X-Webhook-Secret` header.

**Body:**
```json
{
  "memo": "BLITZ-A1B2C3",
  "amount": "100.0000000",
  "from": "G...",
  "txHash": "..."
}
```

On receipt: validates memo against `challenges` table → transitions status to `active`.

---

## Middleware

### `authenticate.ts`

Validates `Authorization: Bearer <jwt>` on every protected route. Adds `req.user: { sub, email }` to the request. An `optionalAuth` variant is available for public routes that behave differently when authenticated.

### `compression`

`compression({ threshold: 1024 })` is mounted early in `src/index.ts` so JSON responses larger than 1 KB are compressed before they leave the API process. Nginx in this repo does not add a second compression layer, so `Vary: Accept-Encoding` is preserved without double-compressing the payload.

### `rate-limit.ts`

Redis-backed rate limiters using `express-rate-limit`:

| Limiter | Limit | Window | Applied to |
|---|---|---|---|
| `apiLimiter` | 100 requests | 15 min | All `/api/*` |
| `authLimiter` | 10 requests | 15 min | `/auth/*` |
| `challengeStartLimiter` | 5 requests | 1 hour | `/sessions/*/warmup-start` |
| `uploadLimiter` | 20 requests | 1 hour | `/upload/*` |

### `anti-cheat.ts`

- **`validateReactionTime`** — Rejects answers with `reactionTimeMs < 150` (physically impossible) or `> 30000` (timeout). Out-of-range values are clamped with a fraud flag recorded.
- **`enforceOneSessionPerChallenge`** — Redis SETNX lock prevents duplicate active sessions per user+challenge.
- **`validateDeviceFingerprint`** — Checks the FingerprintJS `visitorId` against a Redis set of known device IDs per challenge. Flags accounts sharing a device.

### `error.ts`

Global Express 5 error handler. Handles known `AppError` types with clean JSON responses and falls back to `500` for unexpected errors. Logs full stack traces in development.

```json
{
  "error": "Warmup period not complete",
  "code": "WARMUP_INCOMPLETE",
  "statusCode": 403
}
```

---

## Services

### `scoring.ts`

- **`calculateRoundScore(correct, reactionTimeMs)`** — Returns 0 for incorrect, 100–150 for correct (100 base + 0–50 speed bonus).
- **`calculatePayoutShare(userScore, totalScore, prizePool)`** — Proportional share of the prize pool.
- **`rankWinners(sessions)`** — Sorts by `totalScore DESC`, assigns integer ranks, handles ties.

### `questions.ts`

Generates 3 rounds of MCQ questions from a brand's kit:
- **Round 1** — Tagline recognition (4 options: correct + 3 distractors from a pool)
- **Round 2** — USP / brand story match
- **Round 3** — Product image identification

Questions are stored in `challenge_questions` and never change after creation.

### `payout.ts`

- **`enqueuePayout(challengeId)`** — Adds a job to the BullMQ `payout` queue after a challenge's `ends_at` passes.
- **`processPayout(challengeId)`** — Full orchestration:
  1. Load all completed (non-flagged) sessions
  2. Rank and calculate proportional shares
  3. Filter to users with a Stellar address
  4. Call `submitBatchPayout` from `packages/stellar`
  5. Write `tx_hash` and update payout statuses
  6. Update user `total_earned_usdc`

### `phone.ts`

Thin wrapper around Twilio Verify API:
- `sendVerificationCode(to)` — Sends SMS OTP
- `checkVerificationCode(to, code)` — Returns `"approved"` or `"pending"`
- `requirePhoneVerified(req, res, next)` — Middleware that blocks unverified users

---

## Database

Raw `pg` pool with a typed `query<T>(text, values)` helper. No ORM.

### Connection Pool

`max: 20` connections. Slow query warning logged when a query exceeds 500ms.

### Query Files

Each file in `src/db/queries/` exports named functions that take typed parameters and return typed results. Example:

```typescript
// src/db/queries/users.ts
export async function findUserByEmail(email: string): Promise<User | null>
export async function upsertUser(data: UpsertUserData): Promise<User>
export async function updateUserWallet(userId: string, stellarAddress: string): Promise<void>
```

See [`../../init.sql`](../../init.sql) for the bootstrap entrypoint. The canonical schema snapshot lives in [`./migrations/00000-initial.sql`](./migrations/00000-initial.sql), and `apps/api/migrations/` contains forward migrations plus optional rollback files.

---

## Queue & Worker

### `payout.queue.ts`

BullMQ `Queue` named `"payout"` connected to Redis. Jobs are added with a `delay` calculated from `challenge.ends_at`.

### `payout.processor.ts`

BullMQ `Worker` with `concurrency: 2`. Calls `processPayout(challengeId)` for each job. Retries up to 3 times with exponential back-off on failure. Failed jobs remain in the BullMQ failed set for inspection.

### Running the Worker

```bash
# Dev (tsx watch)
pnpm --filter @brandblitz/api dev:worker

# Docker (same image, different CMD)
docker compose up worker
```

The worker process is intentionally separated from the API so that a slow payout job never blocks incoming HTTP requests.

---

## Error Handling

Express 5 automatically catches errors thrown in async route handlers. Create typed errors with the `createError` helper:

```typescript
import { createError } from "@/middleware/error";

// In any route handler:
throw createError("Challenge not found", 404, "CHALLENGE_NOT_FOUND");
```

Standard HTTP errors (404 for unknown routes, 405 for wrong methods) are handled automatically by Express 5.

---

## Building & Running

```bash
# Development (TypeScript, watch mode)
pnpm --filter @brandblitz/api dev

# Build (tsup → dist/)
pnpm --filter @brandblitz/api build

# Start production build
node dist/index.js

# Start worker (production)
node dist/worker.js

# Type check
pnpm --filter @brandblitz/api type-check

# Apply pending migrations
pnpm --filter @brandblitz/api migrate

# Verify there are no pending migrations
pnpm --filter @brandblitz/api migrate:dryrun
```

### Docker Build

The `Dockerfile` is a 5-stage multi-stage build:

| Stage | Purpose |
|---|---|
| `deps` | Install all dependencies (cached layer) |
| `dev` | Dev dependencies included; used with bind mounts |
| `builder` | Compile TypeScript with tsup |
| `prod-deps` | Production-only dependencies |
| `runner` | Minimal final image; non-root user; SIGTERM handler |

Build from the monorepo root (required — the build context includes `packages/`):

```bash
docker build -f apps/api/Dockerfile -t brandblitz-api .
```
