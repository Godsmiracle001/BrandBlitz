# BrandBlitz — Stellar Edition

**The attention quality marketplace.** Brands pay for proof of understanding. Users earn USDC for demonstrating it.

---

## Table of Contents

- [The Problem](#the-problem)
- [The Insight](#the-insight)
- [What BrandBlitz Does](#what-brandblitz-does)
- [Value to Brands](#value-to-brands)
- [Value to Users](#value-to-users)
- [How It's Different](#how-its-different)
- [The Platform's Network Effect](#the-platforms-network-effect)
- [For Drips / Stellar Ecosystem](#for-drips--stellar-ecosystem)
- [Architecture Overview](#architecture-overview)
- [Monorepo Structure](#monorepo-structure)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start (Docker)](#quick-start-docker)
- [Quick Start (Local)](#quick-start-local)
- [Codespaces](#codespaces)
- [Docker Compose Files](#docker-compose-files)
- [Running Tests](#running-tests)
- [Environment Variables](#environment-variables)
- [Services & Ports](#services--ports)
- [E2E](#e2e)
- [Game Flow (Technical)](#game-flow-technical)
- [Stellar Integration](#stellar-integration)
- [Anti-Cheat](#anti-cheat)
- [Scoring](#scoring)
- [Deployment (Production)](#deployment-production)
- [Workspace Scripts](#workspace-scripts)
- [Packages](#packages)
- [Further Reading](#further-reading)
- [Operations Runbooks](#operations-runbooks)

---

## The Problem

### For Brands

Digital advertising is broken in two specific ways:

**1. You're paying for fraud and passivity.**
$140 billion in global ad spend is lost to fraud every year. Up to 50% of programmatic traffic is bots. Of the humans who do see an ad, 76% don't remember viewing it at all. The industry standard metric — the impression — measures whether a pixel loaded, not whether anyone cared.

**2. You can't advertise a brand people don't know.**
Platforms like Brave Ads reward users for viewing ads, but only for brands that already have recognition. If you're a new Stellar ecosystem project trying to reach your first 10,000 users, passive ad views teach nobody anything. You pay for exposure to people who scroll past.

### For Users

Every "earn crypto" product pays fractions of a cent for passive attention. Watch an ad: $0.001 BAT. Stare at a banner: near zero. The model treats users as eyeball inventory, not as people with skills worth rewarding.

---

## The Insight

**Active engagement generates 17x more purchase intent than passive ads** (YouGov / Neuro-Insight research). Interactive quiz formats produce **80–91% brand recall uplift**. Branded live trivia achieves **91% sponsor recall**.

The research is clear: *learn-then-test* is categorically better than *see-and-forget*. But no one has wired it to real money payouts — until now.

---

## What BrandBlitz Does

BrandBlitz is a **skill-validated attention marketplace** built on Stellar USDC. The mechanic has three steps:

```
1. WARM-UP (30–60s)
   User sees the full brand story: logo, tagline, product image,
   brand description, USP. The "Start Challenge" button is locked
   server-side for a minimum of 20 seconds — guaranteed exposure.

2. CHALLENGE (45s across 3 rounds × 15s each)
   Round 1 — Tagline recognition: show the logo, pick the correct tagline
   Round 2 — USP match: show the brand name, identify what makes it unique
   Round 3 — Product recognition: show the product image, name the brand
   Faster correct answers score higher (100 base + 0–50 speed bonus per round).

3. PAYOUT
   Top scorers receive proportional USDC shares from the brand's prize pool.
   Settlement is atomic on Stellar — 3–5 second finality, ~$0.0007 fee.
```

Any user who pays attention during warm-up has every answer they need. The challenge rewards **attention and recall speed** — both provably skill-based.

---

## Value to Brands

### What brands actually buy

BrandBlitz does not sell impressions, clicks, or views. It sells **verified attention seconds** — the emerging IAB/Adelaide AU measurement standard for 2025.

When a brand deposits $100 USDC:
- Every player completed the warm-up (minimum 20s, enforced server-side — not a client timer)
- Every player attempted all 3 rounds testing recall of brand content they just saw
- Scores objectively measure which parts of the brand message landed
- High scorers are self-identified, high-intent audience segments

**This is auditable, first-party data that no other ad format produces.**

### Brand lift benchmarks (research-backed)

| Format | Recall Uplift |
|---|---|
| Standard display ad | 4–8 percentage points |
| Standard video | Baseline |
| Interactive streaming ad | +36% vs standard video (BrightLine 2024) |
| Branded live trivia | **91% sponsor recall** (West Coast Fever / Komo) |
| Interactive quiz (YouGov FreeWall) | **80–86% brand recall uplift** |
| BrandBlitz warm-up + challenge | Architecturally comparable to interactive formats |

### What the brand dashboard shows

After a challenge ends, brands get real data on **attention quality** — not vanity metrics:

- Warm-up completion rate (% who stayed the full 20s+)
- Challenge completion rate (% who finished all 3 rounds)
- Round-by-round accuracy (which brand messages actually landed)
- Score distribution histogram (were the messages clear or confusing)
- Cost per verified attention session = pool ÷ completions

See the [Brands API](docs/api/brands.md) for the full endpoint reference including dashboard, analytics, challenge creation, and question review workflows.

### Cost comparison

| Ad format | Approx. CPM | What you get |
|---|---|---|
| Display | $2–10 | Passive view; ~50% bot traffic; no engagement proof |
| Premium video | $20–50 | Passive viewing; 50% skip rate |
| BrandBlitz | $20–50 equiv. | Verified engagement + first-party data + organic virality |

### First-party data and virality

Top scorers are self-identified brand enthusiasts — they chose to engage, proved comprehension, and competed. That's a qualified lead list that can't be bought anywhere else. **Research shows first-party behavioral data drives 83% improvement in customer acquisition cost** (AppsFlyer).

Every winner also generates a shareable result card: *"I earned $X knowing [Brand]."* That's organic brand reach through social proof, extending past the campaign end date at zero additional cost.

---

## Value to Users

### Real money, fast

- Earn USDC in 90 seconds: 30s warm-up + 45s challenge + results
- Instant settlement on Stellar (no withdrawal queue, no seed phrases)
- Top 10 in a $100 pool = potentially $15–50 USDC from a single session
- This is not $0.001 BAT for staring at a banner. These are competitive prizes with real stakes.

### Skills that compound

BrandBlitz is the only attention platform where the user actually gets better over time:

- **Recall speed** — the speed bonus rewards improvement. Practice mode lets users sharpen before competing.
- **Brand pattern recognition** — experienced players develop intuition for how brands communicate (color psychology, tagline structure) that transfers across all future challenges.
- **Brand knowledge** — users who play regularly develop genuine understanding of brands in the Stellar ecosystem.

### Status and on-chain credentials

- Public global leaderboard rank — see [Leaderboard API](docs/api/leaderboard.md) for the full endpoint reference and live SSE stream
- Weekly league tiers: Bronze → Silver → Gold (resets weekly — fresh start for everyone) — see [Leagues API](docs/api/leagues.md)
- Challenge streaks and achievement badges — see [Badges API](docs/api/badges.md) for the badge catalog and earning criteria
- Non-transferable Stellar SBT credentials for tier milestones (verifiable on-chain proof of performance, embeddable in portfolio/LinkedIn)

See the [Users API](docs/api/users.md) for profile, wallet, phone verification, notifications, earnings, referrals, and badge endpoints.

### Brand perks for top performers

Top scorers earn exclusive access: brand Discord roles, early product access, invite-only high-prize rounds. This is a super-fan loyalty pipeline built from competition, not a sign-up form.

---

## How It's Different

| Platform | Model | Payout | Unknown Brand? | Active Learning? |
|---|---|---|---|---|
| Brave Ads | Passive attention | BAT | No — needs prior recognition | No |
| Adsgram | Dev monetisation | TON | No | No |
| Coinbase Earn | Educational | USDC | No — crypto only; discontinued 2025 | Yes |
| HQ Trivia (2018) | Branded trivia | USD | Yes — showed brand content | Partial |
| Pinterest Quiz Ads | Sponsored quiz | None | Yes | Yes |
| **BrandBlitz** | **Warm-up + challenge** | **USDC instant** | **Yes — core mechanic** | **Yes — core mechanic** |

The combination of warm-up → competition → instant USDC payout is unoccupied.

> **How scoring works:** every round awards 100 base points plus a 0–50 speed bonus, and ties break by earliest finish. Full formula, worked examples, and payout math in [docs/guides/scoring-explained.md](docs/guides/scoring-explained.md).

HQ Trivia proved the model: Warner Bros., Nike, and GM paid for branded challenge rounds in 2018. Warner Bros. alone paid ~$3M for three film promotions. Users engaged. Sponsors reported "strong impact on sales, not just engagement." BrandBlitz is HQ Trivia with USDC payouts, Stellar settlement, and a micro-learning warm-up that fixes the one documented weakness of gamified ads (cognitive recall drops without a learning component).

---

## The Platform's Network Effect

```
More brands → more challenges → more user sessions
                                        ↓
                            More score data → better brand ROI signals
                                        ↓
                            More brands willing to pay premium
                                        ↑
More users → higher competition → higher quality signals for brands
```

Both loops reinforce each other. The data moat deepens with every challenge — which brand messages land, which user segments know which brands, which formats drive highest completion. This makes the platform more valuable to brands over time.

---

## For Drips / Stellar Ecosystem

BrandBlitz is open-source infrastructure for skill-validated brand attention on Stellar. It demonstrates production-grade Stellar mechanics:

- Multi-winner batch USDC payouts (up to 50 Payment ops per transaction, ~$0.0007 total fee)
- Deposit detection via memo fields using Soroban RPC `getEvents`
- Muxed accounts — virtual sub-accounts per user with zero on-chain reserve cost (no 2 XLM minimum)
- Soroban escrow contract — trustless USDC holding with `settle()` / `refund()` functions
- Embedded wallet onboarding (no seed phrase, 30-second signup)

All patterns are documented, tested, and running in Docker.

### Public Brand Catalog API

Third parties (e.g. Drips / Stellar ecosystem partners) can query the public brand listing without authentication:

```bash
curl https://api.brandblitz.io/brands/public
```

See [docs/api/public-brands.md](docs/api/public-brands.md) for the full response schema and usage.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                          Browser                            │
│              Next.js 16 (App Router, SSR)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP via Nginx reverse proxy
           ┌───────────────┴───────────────┐
           │                               │
    /api/* → Express 5            /* → Next.js
           │
┌──────────▼──────────┐
│   Express 5 API     │  JWT auth · Redis rate limiting · anti-cheat
│   apps/api          │
└──────┬──────┬───────┘
       │      │
   pg Pool  Redis
       │      │
  PostgreSQL  BullMQ Worker ──→ Stellar Horizon
  (10 tables)                   Soroban RPC
                                USDC batch payouts
```

The API is **stateless** — all game state in PostgreSQL and Redis. The BullMQ worker runs as a separate process and handles async payout jobs after a challenge's end date passes.

---

## Monorepo Structure

```
brandblitz/
├── apps/
│   ├── api/          Express 5 REST API + BullMQ worker
│   └── web/          Next.js 16 frontend
├── contracts/
│   └── contracts/
│       └── escrow/   Soroban USDC escrow contract (Rust)
├── packages/
│   ├── stellar/      Stellar SDK helpers (payout, deposit, muxed accounts)
│   └── storage/      S3/MinIO client + WebP image optimisation
├── nginx/            Dev and prod reverse proxy configs
├── docker-compose.yml             8 services: web, api, worker, postgres,
├── docker-compose.override.yml    redis, nginx, minio, minio-setup
├── docker-compose.prod.yml
├── init.sql          Bootstrap entrypoint for the Postgres schema
├── apps/api/migrations/  Baseline snapshot + forward migration files
└── .env.example      All required environment variables with documentation
```

> **Workspace dependency graph:** see [`docs/architecture/workspace-graph.md`](./docs/architecture/workspace-graph.md) for which apps depend on which `packages/*` (verified against `package.json` `@brandblitz/*` deps) — e.g. `packages/stellar` changes affect `apps/api` and `apps/deposit-monitor`.

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | Next.js App Router | 16.2.1 |
| React | React | 19.2.4 |
| Styling | Tailwind CSS v4 (CSS-first) | 4.2.2 |
| Auth | next-auth (Google OAuth) | 4.24.13 |
| Backend | Express | 5.2.1 |
| Language | TypeScript | 6.0.2 |
| Database | PostgreSQL | 17 |
| Cache / queues | Redis + BullMQ | 7 / 5.71.1 |
| Object storage | MinIO (dev) / S3-compatible (prod) | — |
| Stellar SDK | @stellar/stellar-sdk | 14.6.1 |
| Smart contracts | Soroban (Rust, soroban-sdk 25) | — |
| Monorepo | Turborepo + pnpm workspaces | 2.8.21 / 10.33.0 |

---

## Prerequisites

- **Node.js** 22+
- **pnpm** 10.33.0 — `npm install -g pnpm@10.33.0`
- **Docker** + Docker Compose v2
- **Rust** + Stellar CLI (smart contract work only)
  - `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
  - `cargo install --locked stellar-cli@25 --features opt`
- **Go** (only needed for `pnpm docs:db`) — [install instructions](https://go.dev/doc/install)

---

## Quick Start (Docker)

```bash
cd brandblitz

# Configure environment — minimum required:
# JWT_SECRET, NEXTAUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
# STELLAR_HOT_WALLET_SECRET
cp .env.example .env

# Start all 8 services (hot-reload enabled in dev)
docker compose up --build

# API container applies pending migrations before starting the watcher
# (use SEED_DEV=1 to seed after migrations)

# Verify
open http://localhost              # Next.js frontend
curl http://localhost/api/health   # {"status":"ok"}
open http://localhost:9001         # MinIO console (brandblitz / brandblitz123)
```

`docker compose up` auto-loads `docker-compose.override.yml` in development, which bind-mounts source directories for hot-reload and exposes direct service ports.

---

## Quick Start (Local)

```bash
# Infrastructure in Docker, apps native
docker compose --profile infra up

pnpm install
cp .env.example .env  # update DATABASE_URL, REDIS_URL to localhost

pnpm dev  # Turborepo runs all packages in parallel
```

Tip: `make dev` wraps the infra + migrate + `pnpm dev` sequence above — see [Workspace Scripts](#workspace-scripts) for the other `make` targets.

### Seed fixtures

Starting from an empty database makes it hard to exercise any game flow, so seed deterministic fixtures first:

```bash
# Idempotent default — inserts only the missing fixture rows; safe to re-run
pnpm --filter @brandblitz/api seed

# --reset — first truncates every seed-* fixture row (users, brands, challenges,
# sessions, round scores, fraud flags, payouts), then re-seeds from scratch
pnpm --filter @brandblitz/api seed -- --reset
```

The default run never deletes existing data; `--reset` wipes the seed-owned rows listed above (it leaves non-seed data alone) before re-inserting. The exact truncation list and fixture definitions live in [`apps/api/scripts/seed.ts`](./apps/api/scripts/seed.ts).

If you enable TLS for MinIO locally, generate the self-signed cert before starting the stack:

```bash
pnpm minio:certs
```

See [`docs/runbooks/rotate-minio-certs.md`](./docs/runbooks/rotate-minio-certs.md) for details.

---

## Codespaces

A one-click environment for GitHub Codespaces and VS Code Dev Containers lives in [`.devcontainer/devcontainer.json`](./.devcontainer/devcontainer.json).

Opening the repository in a Codespace (or running **Dev Containers: Reopen in Container** in VS Code) will:

- Boot a Node.js 22 image and install **pnpm 10.33.0** — the version pinned by the root `packageManager` field
- Forward the dev ports: **3000** (web), **3001** (api), **5432** (Postgres), **6379** (Redis), **9000** (MinIO)
- Run `docker compose up -d postgres redis minio minio-setup` via `postCreateCommand`, so the infrastructure containers are up when the dev container finishes creating

Then finish setup inside the container:

```bash
cp .env.example .env                          # fill in the required secrets
pnpm --filter @brandblitz/api migrate         # apply migrations
pnpm --filter @brandblitz/api seed            # load fixtures (add -- --reset to wipe first)
pnpm dev                                      # or: make dev
```

---

## Docker Compose Files

The project uses three Compose files for different environments:

| File | Purpose | When applied |
|------|---------|--------------|
| `docker-compose.yml` | Base configuration — all services, health checks, and volumes | Always loaded |
| `docker-compose.override.yml` | Development overrides — hot-reload bind mounts, exposed ports | **Auto-loaded** by `docker compose up` |
| `docker-compose.prod.yml` | Production overrides — no bind mounts, HTTPS, replicas, secrets | Explicitly with `-f` flag |

**Development** (default):
```bash
docker compose up
# Automatically merges docker-compose.yml + docker-compose.override.yml
# Override adds: bind mounts for hot-reload, direct port access (3000, 3001, 5432, etc.)
```

**Production:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# Skips the override file — uses prod config only
# Adds: HTTPS, replicas, resource limits, secrets, restart policies
```

The override file is **not loaded** when you specify explicit `-f` files. This means production never picks up the dev bind mounts or exposed ports.

---

## Running Migrations

```bash
# Apply any pending API migrations
pnpm --filter @brandblitz/api migrate

# Check whether the database is already up to date
pnpm --filter @brandblitz/api migrate:dryrun
```

`init.sql` is a bootstrap wrapper for fresh databases. The canonical schema
snapshot is `apps/api/migrations/00000-initial.sql`, and new schema changes
should land as forward migrations in `apps/api/migrations/`.

---

## Local Dev — Seed Data

Starting from an empty database makes it hard to exercise any game flow. The seed script creates deterministic local fixtures so you can click through every page immediately.

```bash
# Seed once (idempotent — safe to re-run)
pnpm --filter @brandblitz/api seed

# Reset and re-seed from scratch
pnpm --filter @brandblitz/api seed -- --reset
```

What it creates:
- **50 users** — 1 admin (`seed-admin@brandblitz.test`), 3 brand owners, 46 players with varied leagues
- **3 brands** — Stellar Pay, NovaMint, AetherShop (with logo fixtures at `apps/api/scripts/fixtures/logos/`)
- **6 challenges** — 2 active, 2 completed, 2 draft (2 per brand)
- **200 game sessions** — mix of completed and flagged (≈10% flagged, including fraud flags)

**Auto-seed on `docker compose up`:**

```bash
SEED_DEV=1 docker compose up
```

Set `SEED_DEV=1` in your shell or `.env` and the API container will run the seed script before starting. This is a no-op if fixtures already exist.

**Reset the local database and re-seed from scratch:**

```bash
pnpm db:reset                 # drop all data, reapply migrations
pnpm db:reset -- --seed       # ...and re-seed fixtures
```

See [`apps/api/README.md`](./apps/api/README.md#operational-scripts) for other dev CLI helpers (e.g. `admin:grant` to promote a user to admin).

---

## Environment Variables

Kept in sync with [`.env.example`](./.env.example), the source of truth (inline comments there have the full rationale/rotation notes). Vars marked **Critical secret** must never be committed with real values.

| Name | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | API server port |
| `NODE_ENV` | No | `development` | Node environment |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string. **Critical secret.** |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `POSTGRES_PASSWORD` | No | `brandblitz_dev` | PostgreSQL superuser password. **Critical secret.** |
| `SESSION_START_LOCKOUT_THRESHOLD` | No | `10` | Failed session-start attempts before lockout |
| `SESSION_START_LOCKOUT_WINDOW_SECONDS` | No | `3600` | Lockout window, in seconds |
| `JWT_SECRET` | Yes | — | Signs API JWTs (32+ chars). **Critical secret.** |
| `JWT_ISSUER` | No | `brandblitz-api` | JWT issuer claim |
| `JWT_AUDIENCE` | No | `brandblitz-client` | JWT audience claim |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | — | Google OAuth client secret. **Critical secret.** |
| `WEB_URL` | No | `http://localhost:3000` | Public URL of the web app |
| `GOOGLE_REDIRECT_URI` | No | `http://localhost:3000/api/auth/callback/google` | OAuth redirect URI |
| `GOOGLE_OAUTH_PKCE_TTL_SECONDS` | No | `300` | PKCE code verifier TTL |
| `REFERRER_POLICY` | No | `strict-origin-when-cross-origin` | `Referrer-Policy` header value |
| `NEXTAUTH_SECRET` | Yes | — | next-auth session encryption. **Critical secret.** |
| `NEXTAUTH_URL` | Yes | — | Public URL of the web app (next-auth) |
| `NEXT_PUBLIC_API_URL` | Yes | — | Browser-facing API base URL |
| `NEXTAUTH_API_URL` | Yes | — | Internal URL next-auth uses to reach the API (e.g. `http://api:3001`) |
| `NEXT_PUBLIC_CDN_HOST` | No | — | CDN host for the CSP `img-src` directive |
| `CDN_BASE_URL` | No | — | CDN base URL, overrides `S3_PUBLIC_URL` when set |
| `NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY` | No | — | FingerprintJS Pro public key; fingerprinting disabled if unset |
| `ALLOWED_ORIGINS` | Yes | — | Comma-separated CORS allow-list; API refuses to boot without it |
| `STELLAR_NETWORK` | No | `testnet` | `testnet` or `public` |
| `STELLAR_HORIZON_URL` | No | `https://horizon-testnet.stellar.org` | Horizon server URL |
| `STELLAR_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban RPC URL |
| `STELLAR_HOT_WALLET_SECRET` | Yes | — | Hot wallet secret key (`S...`) used for payouts. **Critical secret.** |
| `HOT_WALLET_PUBLIC_KEY` | Yes | — | Hot wallet public key (`G...`) used for deposit detection |
| `SOROBAN_CONTRACT_ID` | No | — | Escrow contract ID; falls back to direct transfers if unset |
| `USDC_ISSUER` | No | testnet USDC issuer | USDC asset issuer account |
| `WEBHOOK_SECRET` | Yes | — | Authenticates `/webhooks/stellar` and revalidation calls. **Critical secret.** |
| `S3_ENDPOINT` | Yes | — | S3-compatible storage endpoint |
| `S3_REGION` | No | `us-east-1` | Storage region |
| `S3_ACCESS_KEY_ID` | Yes | — | Storage access key. **Critical secret.** |
| `S3_SECRET_ACCESS_KEY` | Yes | — | Storage secret key. **Critical secret.** |
| `S3_BUCKET` | No | `brandblitz-assets` | Default bucket name |
| `S3_BUCKET_BRAND_ASSETS` | No | `brand-assets` | Brand asset uploads bucket |
| `S3_BUCKET_SHARE_CARDS` | No | `share-cards` | Share-card renders bucket |
| `S3_PUBLIC_URL` | No | — | Public URL prefix for stored objects |
| `S3_FORCE_PATH_STYLE` | No | `true` | Path-style addressing (required for MinIO) |
| `MINIO_ROOT_USER` | No | `minioadmin` | MinIO root user (docker-compose only) |
| `MINIO_ROOT_PASSWORD` | No | `minioadmin` | MinIO root password. **Critical secret.** |
| `TWILIO_ACCOUNT_SID` | No | — | Twilio account SID for phone verification |
| `TWILIO_AUTH_TOKEN` | No | — | Twilio auth token. **Critical secret.** |
| `TWILIO_VERIFY_SERVICE_SID` | No | — | Twilio Verify service SID |
| `PHONE_HASH_SALT` | Yes | — | HMAC salt for phone-number hashing (32-byte random). **Critical secret.** |
| `SESSION_INTEGRITY_KEY` | Yes | — | HMAC key for session tamper-detection — generate with `openssl rand -hex 32`. **Critical secret.** |
| `ADMIN_BOOTSTRAP_EMAIL` | No | — | Grants admin role to this email on boot, if set |
| `REVALIDATE_SECRET` | No | — | Shared secret for on-demand ISR revalidation |
| `NEXT_REVALIDATE_URL` | No | `http://localhost:3000` | Web app URL used for revalidation calls |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `http` \| `verbose` \| `debug` \| `silly` |

---

## Services & Ports

| Service | Port | Description |
|---|---|---|
| nginx | **80** | Reverse proxy; routes `/api/*` → Express |
| web | 3000 | Next.js frontend |
| api | 3001 | Express REST API |
| worker | — | BullMQ payout processor (no HTTP) |
| postgres | 5432 | PostgreSQL 17 |
| redis | 6379 | Redis 7 |
| minio | 9000 | MinIO S3 API |
| minio-console | 9001 | MinIO admin UI |

Only port 80 (and 443 in prod) is exposed externally in the Docker stack.

---

## E2E

The Playwright suite lives in [`e2e/`](./e2e) and targets the live Docker dev stack with `baseURL=http://localhost:3000`.

```bash
docker compose up -d --build
pnpm e2e
```

### Running a single spec

Iterating on one flaky test doesn't require running the whole suite — pass the spec path as an extra argument:

```bash
pnpm e2e e2e/tests/login-popup-blocked.spec.ts
```

Any Playwright flags work alongside the filter:

```bash
pnpm e2e e2e/tests/login-popup-blocked.spec.ts --headed   # watch the browser while it runs
pnpm e2e e2e/tests/login-popup-blocked.spec.ts --debug    # open the Playwright Inspector / debugger
```

What it covers:

- Mocked Google OAuth sign-in to the real web app, ending on `/dashboard`
- Brand creation through the UI, followed by deposit instructions
- Full player golden path: warmup wait, challenge start, 3 rounds, results screen

Artifacts:

- Trace, video, and screenshots are retained on failure in `e2e/artifacts/`
- In CI, upload `e2e/artifacts/` as the job artifact directory

Notes:

- The Docker dev override enables the mocked Google OAuth path used by Playwright.
- The suite assumes the stack is already running; it does not start containers for you.

---

## Game Flow (Technical)

```
POST /sessions/:id/warmup-start        ← session row created (status=warmup)
POST /sessions/:id/warmup-complete     ← server validates ≥20s elapsed;
                                          returns challengeToken (5-min TTL)
POST /sessions/:id/start               ← validates token; status=active
POST /sessions/:id/answer/1            ← server validates + scores round 1
POST /sessions/:id/answer/2            ← round 2
POST /sessions/:id/answer/3            ← round 3; status=completed

[challenge.ends_at passes]
BullMQ job fires → rank all sessions → calculate proportional shares
→ build Stellar batch tx (≤50 Payment ops) → submit → record tx_hash
```

Correct answers **never leave the server**. The client only receives round scores.

---

## Stellar Integration

### Deposits
Brand sends USDC to the hot wallet with a unique memo (e.g. `BLITZ-A1B2C3`). The Stellar webhook endpoint or background polling detects the deposit via `getEvents` on the Soroban RPC. Challenge transitions `pending_deposit → active`.

### Payouts
Single hot wallet + muxed accounts. No per-user Stellar accounts (no 2 XLM minimum reserve per user). Payout job chunks winners into batches of ≤50 Payment ops, each batch submitted as one atomic transaction.

### Soroban Escrow (on-chain alternative)
For brands wanting full on-chain transparency, the escrow contract holds USDC trustlessly. `settle(recipients)` distributes to winners; `refund()` returns the pool to the brand. See [`contracts/README.md`](./contracts/README.md).

To build the contract, deploy it to testnet, and set `SOROBAN_CONTRACT_ID` so payout code runs through the contract locally, follow [`docs/stellar/local-escrow-setup.md`](./docs/stellar/local-escrow-setup.md). If `SOROBAN_CONTRACT_ID` is unset, payouts fall back to direct hot-wallet transfers.

---

## Anti-Cheat

Five independent layers:

| Layer | Mechanism |
|---|---|
| Server authority | Correct answers and scores never sent to client |
| Warmup enforcement | Server rejects challenge start if < 20s since warmup began |
| Reaction time bounds | Answers < 150ms (physically impossible) or > 30s flagged |
| Device fingerprinting | FingerprintJS visitor ID; multi-account device detection via Redis |
| Rate limiting | Redis-backed: 5 challenge starts/hr, 100 API calls/15min per IP |

---

## Scoring

```
Per round (correct answer):   100 base + floor((timeLeft / 15s) × 50) speed bonus
Per round (wrong answer):     0  (no penalty — keeps engagement positive)
Maximum total:                450 points (3 rounds × 150)

Payout share:  userScore / sumOfAllWinnerScores × prizePool
```

Only users with at least one correct answer receive a payout share.

See [docs/guides/scoring-explained.md](docs/guides/scoring-explained.md) for the exact formula, tie-breaking rules, and worked examples.

---

## Deployment (Production)

### 1. Prepare the server

```bash
git clone <repo> brandblitz && cd brandblitz
cp .env.example .env
```

### 2. Configure production environment

Edit `.env` with the following production-specific values:

```bash
NODE_ENV=production

# Use a real S3-compatible provider (Cloudflare R2, AWS S3) — remove MinIO vars
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=<r2-access-key>
S3_SECRET_ACCESS_KEY=<r2-secret-key>
S3_BUCKET=brandblitz-assets
S3_PUBLIC_URL=https://assets.yourdomain.com
# Remove S3_FORCE_PATH_STYLE for R2/AWS

# Switch to Stellar mainnet
STELLAR_NETWORK=public
STELLAR_HORIZON_URL=https://horizon.stellar.org
STELLAR_RPC_URL=https://mainnet.sorobanrpc.com
# Mainnet USDC issuer (Centre)
USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# Generate strong secrets (run each command separately)
# openssl rand -hex 64   → JWT_SECRET
# openssl rand -hex 64   → NEXTAUTH_SECRET
# openssl rand -hex 32   → WEBHOOK_SECRET

# Set your domain
NEXTAUTH_URL=https://yourdomain.com
NEXT_PUBLIC_API_URL=https://yourdomain.com/api
```

### 3. Configure Google OAuth for production

In the [Google Cloud Console](https://console.cloud.google.com/):
- Add `https://yourdomain.com/api/auth/callback/google` as an authorised redirect URI
- Add `https://yourdomain.com` as an authorised JavaScript origin

### 4. Configure Nginx for your domain

Edit `nginx/nginx.prod.conf` and replace `${DOMAIN}` with your domain, or set it as a shell variable before starting:

```bash
export DOMAIN=yourdomain.com
```

Ensure Let's Encrypt certificates exist at `/etc/letsencrypt/live/${DOMAIN}/`.

### 5. Deploy

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Verify all services are healthy
docker compose ps

# Check logs
docker compose logs -f api
docker compose logs -f web
```

Production differences from dev:
- No bind mounts — fully built images
- `restart: unless-stopped` on all services
- Nginx serves HTTPS with HSTS, X-Frame-Options, rate limiting
- API and web each run 2 replicas for zero-downtime deployments
- MinIO removed — use Cloudflare R2 or AWS S3
- Worker retries failed payout jobs with exponential back-off

---

## Running Tests

Vitest is configured at the monorepo root with per-workspace project configs.

```bash
# Run all workspace tests
pnpm test

# Run all workspace tests with v8 coverage
pnpm test:coverage

# Run tests for one workspace
pnpm --filter @brandblitz/api test
pnpm --filter @brandblitz/web test
pnpm --filter @brandblitz/stellar test
pnpm --filter @brandblitz/storage test
```

Shared test setup is in `tests/setup.ts` and includes reusable DB test helpers based on test schema prefixes.

---

## Workspace Scripts

```bash
pnpm dev          # Start all apps in parallel (Turborepo)
pnpm build        # Build all packages and apps
pnpm test         # Run all test suites
pnpm e2e          # Run Playwright end-to-end tests against docker-compose
pnpm test:coverage # Run all test suites with coverage
pnpm lint         # Lint all packages
pnpm type-check   # TypeScript type-check everything
pnpm format       # Prettier format all .ts/.tsx/.json files
pnpm clean        # Remove all build artifacts and node_modules
```

### Makefile targets

The repo root [`Makefile`](./Makefile) wraps the most common sequences as short `make` targets — an alternative to the raw `pnpm` / `docker compose` commands above. Each target is commented in the Makefile itself.

| Target | What it runs |
|---|---|
| `make dev` | Start infra containers (health-checked), apply migrations via `migrate.ts`, then `pnpm dev` |
| `make reset-db` | `pnpm db:reset` — drop + recreate the schema and re-apply migrations (`reset-db.ts` → `migrate.ts`) |
| `make seed` | `pnpm --filter @brandblitz/api seed` — idempotent fixture seed (`seed.ts`); add `SEED_FLAGS="-- --reset"` to truncate first |
| `make test` | `pnpm test` |
| `make clean` | `pnpm clean` — build artifacts + `node_modules` |

```bash
make dev        # infra + migrate + dev servers
make reset-db   # wipe local DB, then:
make seed       # re-seed fixtures
```

---

## Packages

### `packages/stellar`

Typed helpers for all Stellar network interactions. Imported by `apps/api`.

| File | What it does |
|---|---|
| `src/client.ts` | Factory for Horizon `Server` and Soroban `RPC.Server` instances; `getUsdcAsset()` |
| `src/deposit.ts` | Polls Soroban RPC `getEvents` to detect USDC deposits by memo; returns `DepositEvent[]` |
| `src/payout.ts` | `submitBatchPayout(recipients)` — builds a `TransactionBuilder` with up to 50 Payment ops and submits it atomically |
| `src/accounts.ts` | `createMuxedAddress(baseAddress, muxedId)` — virtual sub-accounts per user at zero reserve cost; `sponsorNewAccount()` for CAP-0033 sponsored reserves |
| `src/constants.ts` | Network configs, `MAX_OPS_PER_TX=50`, `WARMUP_MIN_SECONDS=20`, poll intervals |
| `src/index.ts` | Re-exports everything |

### `packages/storage`

S3-compatible object storage with image optimisation. Imported by `apps/api`. Works with MinIO in dev and Cloudflare R2 / AWS S3 in prod — same code, different env vars.

| File | What it does |
|---|---|
| `src/client.ts` | `S3Client` configured from env; `BUCKETS` constant; `getPublicUrl(key)` |
| `src/optimize.ts` | `optimizeImage(key, type)` — fetches from S3, runs `sharp` WebP resize, overwrites: logos → 400×400 contain, products → 800×600 inside, avatars → 200×200 cover |
| `src/index.ts` | Re-exports everything |

---

## Further Reading

- [`apps/api/README.md`](./apps/api/README.md) — Full API reference, all routes, middleware, services, database schema
- [`apps/web/README.md`](./apps/web/README.md) — Frontend pages, components, auth flow, game state machine, upload flow
- [`contracts/README.md`](./contracts/README.md) — Soroban escrow contract: build, test, deploy, full function reference
- [`docs/adr/`](./docs/adr/README.md) — Architecture Decision Records (the "why" behind load-bearing engineering choices)
- [OpenAPI and Scalar UI guide](./docs/api/using-the-openapi-spec.md) — Browse `/docs`, fetch `/docs/openapi.json`, and generate typed clients from the API spec.
- [Rate limits and API errors](./docs/api/rate-limits-and-errors.md) — Public reference for limiter buckets, 429 responses, and the common error envelope.
- [Waitlist curl examples](./docs/examples/waitlist-curl.md) — Runnable signup and position lookup examples for landing-page integrations.
- Interactive API reference — Scalar UI at `/docs` (local dev: <http://localhost:4000/docs>). Spec lives at [`docs/openapi.yml`](./docs/openapi.yml); regenerate via `pnpm --filter @brandblitz/api gen:openapi`.
- [Brands API](./docs/api/brands.md) — Brand CRUD, challenge creation, question review, webhooks, analytics
- [Users API](./docs/api/users.md) — Profiles, wallet, phone verification, notifications, badges, earnings, referrals
- [Challenges API](./docs/api/challenges.md) — Challenge listing, details, stats, leaderboards, deposit info, reports
- [Sessions API](./docs/api/sessions.md) — Gameplay flow: warmup, answer submission, session recovery
- [Implementation Notes](./docs/implementation-notes/README.md) — Index of root-level implementation summary documents

---

## Operations Runbooks

Incident-response playbooks for on-call engineers live in [`docs/runbooks/`](./docs/runbooks/README.md).

| Runbook | Summary |
|---|---|
| [horizon-outage](./docs/runbooks/horizon-outage.md) | Stellar Horizon degraded — payout queue paused |
| [hot-wallet-low-balance](./docs/runbooks/hot-wallet-low-balance.md) | USDC balance too low to process payouts |
| [payout-stuck-in-queue](./docs/runbooks/payout-stuck-in-queue.md) | BullMQ payout jobs not progressing |
| [leaked-secret](./docs/runbooks/leaked-secret.md) | Secret exposed in git or logs |
| [cdn-purge](./docs/runbooks/cdn-purge.md) | Force-invalidate a cached asset |
| [rotate-secrets](./docs/runbooks/rotate-secrets.md) | General secret rotation |

See [docs/runbooks/README.md](./docs/runbooks/README.md) for the full index.
