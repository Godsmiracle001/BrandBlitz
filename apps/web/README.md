# BrandBlitz Web

Next.js 16 frontend for BrandBlitz. Server-rendered landing page and leaderboard, client-side game flow, and brand management dashboard. Styled with Tailwind CSS v4 using a CSS-first configuration.

---

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Routing & Pages](#routing--pages)
- [Route Groups](#route-groups)
- [Components](#components)
  - [UI Primitives](#ui-primitives)
  - [Game Components](#game-components)
  - [Brand Components](#brand-components)
  - [Layout Components](#layout-components)
- [Hooks](#hooks)
- [Lib](#lib)
- [Tailwind v4 CSS Variables](#tailwind-v4-css-variables)
- [Authentication](#authentication)
- [Game State Machine](#game-state-machine)
- [File Upload Flow](#file-upload-flow)
- [Building & Running](#building--running)
- [Docker](#docker)

---

## Overview

The web app is a **Next.js 16 App Router** project with `output: "standalone"` for Docker deployment. It uses:

- **next-auth v4** for Google OAuth — session is stored in a cookie, API JWT is stored in the next-auth session object
- **Tailwind CSS v4** CSS-first config — no `tailwind.config.js`, all tokens defined as CSS variables inside `@theme inline {}`
- **shadcn-style** UI components built with Radix UI primitives and `class-variance-authority`
- **axios** for all API calls via a typed client factory in `src/lib/api.ts`

The landing page and leaderboard are **async server components** (SSR). The game pages and dashboard are **client components** because they depend on `useSession()`, real-time timers, and user interactions.

---

## Directory Structure

```
apps/web/
├── Dockerfile
├── .dockerignore
├── next.config.ts            # output: standalone, image domains, server actions
├── postcss.config.mjs        # @tailwindcss/postcss plugin
├── tsconfig.json
└── src/
    ├── app/
    │   ├── layout.tsx                          # Root layout: SessionProvider, Inter font
    │   ├── globals.css                         # Tailwind v4 @import + @theme inline CSS vars
    │   ├── page.tsx                            # Landing page (async server component)
    │   ├── favicon.ico
    │   ├── api/
    │   │   └── auth/[...nextauth]/route.ts     # next-auth App Router handler
    │   ├── (auth)/                             # Centred layout, no header/footer
    │   │   ├── layout.tsx
    │   │   └── login/page.tsx                  # Google sign-in
    │   ├── (game)/                             # Full-screen game layout
    │   │   ├── layout.tsx
    │   │   └── challenge/[id]/
    │   │       ├── page.tsx                    # Warmup → challenge → result state machine
    │   │       └── loading.tsx                 # Suspense fallback skeleton
    │   ├── (brand)/                            # Header + footer layout
    │   │   ├── layout.tsx
    │   │   ├── dashboard/page.tsx              # Brand owner dashboard
    │   │   └── brand/
    │   │       ├── new/page.tsx                # Create brand kit form
    │   │       └── [id]/page.tsx               # Brand analytics + leaderboard
    │   ├── leaderboard/
    │   │   └── page.tsx                        # Global leaderboard (SSR)
    │   └── profile/[username]/
    │       └── page.tsx                        # Public user profile (SSR)
    ├── components/
    │   ├── ui/                                 # Primitive UI components (shadcn-style)
    │   │   ├── button.tsx
    │   │   ├── card.tsx
    │   │   ├── badge.tsx
    │   │   ├── input.tsx
    │   │   ├── label.tsx
    │   │   ├── progress.tsx
    │   │   └── dialog.tsx
    │   ├── game/                               # Game-specific components
    │   │   ├── constants.ts
    │   │   ├── warmup-phase.tsx
    │   │   ├── challenge-round.tsx
    │   │   ├── countdown-timer.tsx
    │   │   └── result-screen.tsx
    │   ├── brand/                              # Brand management components
    │   │   ├── brand-kit-form.tsx
    │   │   └── upload-field.tsx
    │   └── layout/
    │       ├── header.tsx
    │       └── footer.tsx
    ├── hooks/
    │   ├── use-challenge.ts                    # Fetch challenge + questions
    │   └── use-countdown.ts                    # Countdown timer with callbacks
    ├── lib/
    │   ├── api.ts                              # Typed axios client factory + exported types
    │   ├── auth.ts                             # next-auth config (Google, JWT callbacks)
    │   └── utils.ts                            # cn(), formatUsdc(), formatScore(), sleep()
    └── types/
        └── index.ts                            # Shared TypeScript interfaces
```

---

## Getting Started

```bash
# From the monorepo root
pnpm install

# Copy environment
cp ../../.env.example .env.local

# Start infrastructure
docker compose up postgres redis minio minio-setup

# Run the API (needed for data fetching)
pnpm --filter @brandblitz/api dev

# Run the web app
pnpm --filter @brandblitz/web dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

Set in `.env.local` for local development. In Docker, passed via `docker compose` environment config.

| Variable | Required | Description |
|---|---|---|
| `NEXTAUTH_SECRET` | Yes | Encrypts next-auth session cookie |
| `NEXTAUTH_URL` | Yes | Full URL of the web app (e.g. `http://localhost:3000`) |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `NEXT_PUBLIC_API_URL` | Yes | API base URL visible to the browser (e.g. `http://localhost:3001/api`) |

`NEXT_PUBLIC_` variables are embedded at build time — they must be available during `next build`.

---

## Routing & Pages

### Landing Page — `/` (`app/page.tsx`)

**Server component.** Fetches active challenges from the Express API on the server and renders:

- Hero section with CTA buttons
- Grid of active challenge cards with brand colours and logos
- "How It Works" 3-step explainer

Falls back gracefully if the API is unavailable (returns empty array).

---

### Login — `/login` (`app/(auth)/login/page.tsx`)

**Client component.** Renders a centred card with a Google sign-in button. Uses `signIn("google", { callbackUrl })` from next-auth. Reads `callbackUrl` from query params so users are redirected back after auth.

---

### Challenge — `/challenge/:id` (`app/(game)/challenge/[id]/page.tsx`)

**Client component.** Runs the full game state machine (see [Game State Machine](#game-state-machine)). Redirects to `/login` if the user is not authenticated.

---

### Dashboard — `/dashboard` (`app/(brand)/dashboard/page.tsx`)

**Client component.** Requires authentication. Loads the authenticated user's brand kits and their associated challenges. Links to brand analytics and challenge creation.

---

### Brand Kit Creation — `/brand/new` (`app/(brand)/brand/new/page.tsx`)

**Client component.** Requires authentication. Renders the `BrandKitForm` component.

---

### Brand Analytics — `/brand/:id` (`app/(brand)/brand/[id]/page.tsx`)

**Client component.** Shows brand details, active challenge stats (pool size, participant count, status), and the real-time leaderboard for the latest challenge.

---

### Global Leaderboard — `/leaderboard` (`app/leaderboard/page.tsx`)

**Server component.** Fetches the global top-100 players from the API and renders a full-page ranked table with medals, league badges, scores, and total USDC earned.

---

### User Profile — `/profile/:username` (`app/profile/[username]/page.tsx`)

**Server component.** Fetches a public user profile and renders their stats (challenges played, best score, USDC earned) and recent challenge history. Returns `notFound()` for unknown usernames.

---

## Route Groups

Next.js route groups `(name)` apply shared layouts without affecting URLs:

| Group | Layout | Used for |
|---|---|---|
| `(auth)` | Vertically centred, no header/footer | Login page |
| `(game)` | Full-screen, no header/footer | Immersive challenge experience |
| `(brand)` | Header + footer | Dashboard, brand management |

Pages outside groups (landing, leaderboard, profile) render directly inside the root layout.

---

## Components

### UI Primitives

All components are in `src/components/ui/` and follow the shadcn pattern: Radix UI primitives wrapped with `class-variance-authority` variants and CSS variable tokens.

#### `Button`

Variants: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`
Sizes: `sm`, `default`, `lg`, `icon`

```tsx
<Button variant="secondary" size="lg">Play Now</Button>
```

#### `Card`

Compound component: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`

#### `Badge`

Variants: `default`, `secondary`, `outline`, `destructive`, `gold`, `silver`, `bronze`

```tsx
<Badge variant="gold">Gold League</Badge>
```

#### `Input`

Styled `<input>` with focus ring using `var(--primary)`.

#### `Label`

Styled `<label>` that disables properly when paired with a disabled input.

#### `Progress`

Radix `Progress.Root` with a smooth animated fill bar. Used in the countdown timer.

```tsx
<Progress value={75} className="h-2" />
```

#### `Dialog`

Radix `Dialog` with overlay, animated content, header, footer, title, and description subcomponents.

---

### Game Components

#### `constants.ts`

```typescript
export const WARMUP_MIN_SECONDS = 20;  // Server-enforced minimum warmup
export const ROUND_SECONDS = 15;        // Time per question
export const TOTAL_ROUNDS = 3;
```

#### `WarmupPhase`

Full-screen component that displays brand content (logo, tagline, story, product images) during the warmup. The "I'm Ready" button is disabled until `WARMUP_MIN_SECONDS` have elapsed. Calls `onComplete(challengeToken)` after the API confirms warmup completion.

Props: `challenge: Challenge`, `onComplete: (token: string) => void`

#### `ChallengeRound`

Displays a single MCQ question with 4 option buttons and a countdown timer. Records `reactionTimeMs` from when the question was shown. Calls `onAnswer(option, reactionTimeMs)` immediately on selection — no confirm step.

Props: `question: ChallengeQuestion`, `round: 1|2|3`, `onAnswer`, `brandLogoUrl?`

#### `CountdownTimer`

Visual countdown with a `Progress` bar that drains over the allotted time. Turns red (via `text-red-500`) when ≤ 5 seconds remain. Calls `onExpire` when time runs out.

Props: `seconds: number`, `onExpire: () => void`

#### `ResultScreen`

Post-game screen showing total score, optional rank, estimated USDC earnings, a native share button (falls back to clipboard copy), a leaderboard link, and a "Play Another" CTA.

Props: `totalScore: number`, `rank?: number`, `estimatedUsdc?: string`, `challengeId: string`

---

### Brand Components

#### `UploadField`

Drag-and-drop / click-to-upload field that:
1. Calls `POST /upload/presign` to get a presigned S3 URL
2. `PUT`s the file directly to MinIO/S3 (never through Express)
3. Calls `POST /upload/verify` to confirm the upload
4. Shows a thumbnail on success; calls `onUploaded(key, publicUrl)`

Props: `label`, `accept`, `uploadType`, `apiToken`, `onUploaded`

#### `BrandKitForm`

Multi-section form combining brand info, asset uploads, and challenge settings. On submit:
1. `POST /brands` — creates the brand kit
2. `POST /brands/:id/challenges` — creates the challenge
3. Redirects to `/brand/:id` with deposit instructions in the query string

---

### Layout Components

#### `Header`

Sticky, blurred header with the BrandBlitz logo, navigation links, and auth state. Shows the user's Google avatar and a sign-out button when authenticated. Uses `useSession()` — rendered client-side.

#### `Footer`

Simple footer with copyright, Stellar attribution, and key navigation links.

---

## Hooks

### `useCountdown(options)`

```typescript
const { timeLeft, running, start, pause, reset } = useCountdown({
  seconds: 15,
  onExpire: () => handleTimeout(),
  autoStart: true,
});
```

Uses `setInterval` with a stable `onExpire` ref so the callback can be updated without restarting the timer.

---

### `useChallenge(challengeId, apiToken?)`

```typescript
const { challenge, questions, loading, error } = useChallenge(id, apiToken);
```

Fetches `GET /challenges/:id` and returns typed results. Used in pages that need challenge data outside the main game state machine.

---

## Lib

### `api.ts`

```typescript
// Unauthenticated (SSR / public routes)
const res = await api.get("/challenges?limit=6");

// Authenticated (client components)
const api = createApiClient(session.apiToken);
const res = await api.post(`/sessions/${id}/answer/1`, { ... });
```

`api` (default export) is a bare axios instance pointing to `NEXT_PUBLIC_API_URL`.
`createApiClient(token?)` returns an instance with `Authorization: Bearer <token>` pre-set.

Exported types: `Challenge`, `ChallengeQuestion`, `LeaderboardEntry`

---

### `auth.ts`

next-auth v4 config with:
- `GoogleProvider` for OAuth
- `signIn` callback: calls `POST /auth/google/callback` on the Express API to get a JWT, stores it in the token
- `jwt` callback: forwards `apiToken` through the JWT
- `session` callback: exposes `apiToken` on the session object so client components can read it via `useSession()`

---

### `utils.ts`

```typescript
cn(...inputs: ClassValue[])   // Merges Tailwind classes (clsx + tailwind-merge)
formatUsdc(amount: string | number)  // "100.0000000" → "100.00"
formatScore(score: number)           // 420 → "420"
sleep(ms: number): Promise<void>
```

---

## Tailwind v4 CSS Variables

Tailwind v4 uses a **CSS-first** configuration. There is no `tailwind.config.js`. All theme tokens are declared in `src/app/globals.css` inside the `@theme inline {}` block:

```css
@import "tailwindcss";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  /* ... */
}

:root {
  --background: #ffffff;
  --foreground: #0a0a0a;
  --primary: #6366f1;
  --primary-foreground: #ffffff;
  /* ... */
}
```

Components reference tokens as `bg-[var(--primary)]` or `text-[var(--muted-foreground)]`.
Brand-specific colours are overridden at runtime by setting `--brand-primary` and `--brand-secondary` on the challenge wrapper element.

---

## Authentication

1. User clicks "Continue with Google" → `signIn("google")`
2. Google redirects back to `/api/auth/callback/google` (handled by next-auth)
3. next-auth's `signIn` callback POSTs to `NEXTAUTH_URL/api/auth` → Express `POST /auth/google/callback`
4. Express creates/updates the user record, issues a signed JWT
5. JWT is stored in the next-auth session as `session.apiToken`
6. All client-side API calls read `session.apiToken` via `useSession()` and pass it as `Authorization: Bearer`

The next-auth session cookie is `httpOnly`, `sameSite: lax`, encrypted with `NEXTAUTH_SECRET`.

---

## Game State Machine

The challenge page (`/challenge/:id`) manages four phases via a `useState`:

```
loading → warmup → challenge → result
```

| Phase | Trigger | What happens |
|---|---|---|
| `loading` | Page mount | Fetches challenge + questions; calls `warmup-start` |
| `warmup` | `warmup-start` success | Renders `WarmupPhase`; button locked 20s |
| `challenge` | User clicks "I'm Ready" → `warmup-complete` | 3 sequential `ChallengeRound` renders |
| `result` | Round 3 answer submitted | Renders `ResultScreen` with total score |

Answers are submitted one at a time via `POST /sessions/:id/answer/:round`. The server validates, scores, and returns the round score. The client accumulates scores in state for display on the result screen.

---

## File Upload Flow

Direct-to-S3 upload (files never transit the Express server):

```
Browser                    Express API              MinIO / S3
   │                           │                        │
   │  POST /upload/presign     │                        │
   │ ─────────────────────────►│                        │
   │  { presignedUrl, key }    │                        │
   │◄─────────────────────────│                        │
   │                           │                        │
   │  PUT presignedUrl (file)  │                        │
   │ ─────────────────────────────────────────────────►│
   │  200 OK                   │                        │
   │◄─────────────────────────────────────────────────│
   │                           │                        │
   │  POST /upload/verify      │                        │
   │ ─────────────────────────►│  HeadObject(key)       │
   │  { verified: true }       │◄──────────────────────│
   │◄─────────────────────────│                        │
```

The `UploadField` component handles all three steps transparently.

---

## Testing

### Unit Tests
Unit tests use **Vitest** and **React Testing Library**.
```bash
pnpm --filter @brandblitz/web test
```

### E2E Tests
E2E tests use **Playwright**. They run against a local build of the application and require the API and database to be running.

#### 1. Setup Environment
Ensure your `.env.local` is configured and infrastructure is up:
```bash
docker compose up -d postgres redis minio minio-setup
```

#### 2. Seed Test Data
Run the seeding script to create a test brand and challenge:
```bash
# From root
pnpm tsx scripts/seed-e2e-challenge.ts
```

#### 3. Run Tests
```bash
# From apps/web
pnpm exec playwright test

# Or with UI mode
pnpm exec playwright test --ui
```

E2E tests are configured in `playwright.config.ts` and located in `tests/e2e/`. They use a programmatic authentication fixture to skip the Google login UI.

---

## Building & Running

```bash
# Development
pnpm --filter @brandblitz/web dev       # http://localhost:3000

# Type check
pnpm --filter @brandblitz/web type-check

# Production build
pnpm --filter @brandblitz/web build

# Bundle analysis (requires ANALYZE=true)
pnpm --filter @brandblitz/web analyze

# Start production server
pnpm --filter @brandblitz/web start
```

### Bundle size check

Before you push a web change, run the bundle budget check locally. It needs a fresh production
build, because it measures `apps/web/.next/static/chunks/`:

```bash
# From the monorepo root
pnpm --filter @brandblitz/web build   # prerequisite: produces .next/static/chunks
pnpm check:bundle                     # runs scripts/check-bundle-budget.mjs from the repo root
```

`pnpm check:bundle` compares the total gzip size of the built chunks against
[`docs/perf/bundle-baseline.txt`](../../docs/perf/bundle-baseline.txt). It prints
`::warning::Bundle size regressed by more than 10%!` when you're over budget. If you skip the build,
it measures nothing and reports a meaningless "within budget".

**Troubleshooting a bundle size warning:** see [`docs/perf/README.md`](../../docs/perf/README.md#troubleshooting-a-bundle-size-warning).
It covers where `scripts/generate-bundle-report.mjs` sends its report (stdout, no file), how to
read the report, and how to diff it against the baseline to find the chunk that grew.

### Dependency version alignment

`@next/bundle-analyzer` must always be pinned to the **exact same version** as the `next` dependency. Both packages are published together from the Next.js monorepo, and a mismatch can cause build-time incompatibilities during `pnpm analyze`.

When upgrading Next.js, update both in `package.json` atomically:

```json
"next": "X.Y.Z",
"@next/bundle-analyzer": "X.Y.Z"
```

---

## Docker

The `Dockerfile` is a 4-stage multi-stage build:

| Stage | Purpose |
|---|---|
| `deps` | Install all monorepo dependencies (cached) |
| `builder` | `next build` with build-time env args |
| `runner` | Minimal Alpine image; non-root `nextjs` user; `output: standalone` |

The `standalone` output copies only the files needed to run the server, keeping the final image small.

Build from the monorepo root (required — the Dockerfile copies shared packages):

```bash
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://yourapi.com/api \
  --build-arg NEXTAUTH_URL=https://yourapp.com \
  -t brandblitz-web .
```
