# 10 — Game Design: Brand Inputs & Warmup Phase

## Overview

When a player opens a challenge they enter a **warmup phase** before any question is shown. The warmup exists to guarantee a minimum brand-study period so that skill, not reflexes, determines scores.

---

## Warmup Duration

| Constant | Value | Canonical source | Web copy |
|---|---|---|---|---|
| `WARMUP_MIN_SECONDS` | **20 s** | `packages/stellar/src/constants.ts` | `apps/web/src/components/game/constants.ts` |
| `ROUND_SECONDS` | **15 s** | `packages/stellar/src/constants.ts` | `apps/web/src/components/game/constants.ts` |
| `TOTAL_ROUNDS` / `MAX_ROUNDS` | **3** | `packages/stellar/src/constants.ts` (`MAX_ROUNDS`) | `apps/web/src/components/game/constants.ts` (`TOTAL_ROUNDS`) |

> **Kept in sync via a parity test**: The web client declares these values as independent literals (not re-exports) to avoid pulling the `@stellar/stellar-sdk` dependency into the browser bundle. A parity test at `apps/web/src/components/game/constants.test.ts` imports both the canonical and web copies and asserts equality on every `pnpm test` run. The values **must** be kept identical; change the canonical constant in `packages/stellar/src/constants.ts` first, then update the web copy in `apps/web/src/components/game/constants.ts`.

### Server enforcement

`POST /sessions/:challengeId/warmup-start` stores `unlockAt = Date.now() + WARMUP_MIN_SECONDS * 1000` in Redis with a 5-minute TTL.

`POST /sessions/:challengeId/warmup-complete` reads `unlockAt` and returns **HTTP 400 + `remainingMs`** if the minimum has not elapsed. The client displays the remaining time and prevents the player from retrying early.

### Client unlock

`WarmupPhase` mounts a `setTimeout(WARMUP_MIN_SECONDS * 1000)` that flips `unlocked → true` and enables the **Start Challenge →** button. The `CountdownTimer` component drives the visible countdown from `WARMUP_MIN_SECONDS` to `0`.

---

## Brand Inputs displayed during warmup

The `Challenge` object passed to `WarmupPhase` may contain any combination of the following fields:

| Field | UI element | Required? |
|---|---|---|
| `brand_name` | `<h1>` heading | ✅ always shown |
| `logo_url` | `<Image>` (120 × 120 px) | optional — hidden when absent |
| `tagline` | `<p>` below heading | optional — hidden when absent |
| `primary_color` | gradient start + button background | optional — falls back to `var(--primary)` |
| `secondary_color` | gradient end | optional — falls back to `var(--background)` |
| `pool_amount_usdc` | prize-pool label at bottom | ✅ always shown |

---

## Changing the warmup duration

1. Update the value in `packages/stellar/src/constants.ts`.
2. Update the matching copy in `apps/web/src/components/game/constants.ts`.
3. Update the rows in the table above.
4. Run the parity test: `pnpm --filter @brandblitz/web test -- src/components/game/constants.test.ts`.
5. Re-run the full Vitest suite (`pnpm --filter @brandblitz/web test`) and Playwright (`pnpm e2e`) — the warmup and round tests check the exact values.

---

## Scoring

Each challenge has 3 rounds, and each round is scored independently.

- Correct answer score: base 100 points + speed bonus up to 50 points
- Wrong answer score: 0 points
- Timeout (no answer): submitted as selectedOption = null and scored as 0 points

Timeout behavior is explicit in both frontend and backend contracts:

- The client submits null when the round timer expires without a click.
- The API accepts selectedOption as one of A/B/C/D or null.
- Null is treated as no-answer and never as an implicit letter choice.

This prevents accidental scoring from silent defaults and preserves fair outcomes across players.

## Test coverage

| Layer | File | What is tested |
|---|---|---|
| Vitest (unit) | `apps/web/src/components/game/warmup-phase.test.tsx` | Counts down from `WARMUP_MIN_SECONDS`; button disabled until zero; unlock enables button |
| Playwright (e2e) | `e2e/tests/game.spec.ts` | Button disabled at page load; enabled within `WARMUP_MIN_SECONDS + 5 s` |
| Playwright (e2e) | `e2e/tests/payout-settlement.spec.ts` | Full warmup → play → session complete → challenge settlement → payouts row created with correct status |

---

## API Reference

The session and gameplay endpoints are documented in detail at [docs/api/sessions.md](api/sessions.md), including the full warmup → start → answer sequence, request/response payloads, and error codes.
