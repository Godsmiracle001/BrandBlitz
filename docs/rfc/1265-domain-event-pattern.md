# RFC 1265: Introduce a lightweight domain-event pattern for cross-cutting side effects instead of direct in-line calls

## Problem Statement

Challenge settlement and payout completion trigger several side effects via direct function
calls spread across `services/payout.ts` and `queues/processors/payout.processor.ts`. Adding a
new side effect (analytics, notifications, a future integration) means finding and editing every
call site that currently orchestrates payout completion by hand, rather than subscribing a new
listener to a well-known event.

**Correcting the issue's premise on one point:** `services/streaks.ts`'s `updateStreak()` is
*not* actually called from the payout path — `grep` confirms its only caller is
`routes/sessions.ts` on session completion, a related but distinct event from payout/challenge
settlement. It's still a same-shape example of a directly-invoked side effect, just triggered by
a different domain event (`SessionCompleted`, not `PayoutCompleted`) — included below as a second
proof-of-concept candidate rather than folded into the payout chain it doesn't belong to.

## Current State

### Direct-call chain: challenge settlement → payout completion

```
enqueuePayout(challengeId)                         [services/payout.ts:55]
├── enqueuePayoutJob(challengeId)                   → BullMQ "payout" queue
├── enqueueLeaderboardRefresh(challengeId)           → BullMQ leaderboard-refresh queue
└── logger.info("Payout job enqueued")

processPayout(challengeId)                          [services/payout.ts:66, run by the BullMQ worker]
├── getChallengeById / getLeaderboard / rankWinners  (read + compute)
├── per-session verifySessionHmac(...)               (integrity gate, throws on failure)
├── submitBatchPayout(...) / EscrowClient(...)        (Stellar settlement — packages/stellar)
├── createPayout / updatePayoutStatus                (DB writes)
├── incrementUserEarnings(userId, amount)             (DB write)
├── insertPayoutNotification(...)                     (DB write, best-effort — already wrapped
│                                                        in its own try/catch + logger.warn)
└── queueReferralBonusForPayout({...})  (x2)          → services/referrals.ts → BullMQ referral queue
```

### Direct-call chain: session completion (a separate trigger, included as a second candidate)

```
[routes/sessions.ts:321, on session status -> "completed"]
└── updateStreak(userId)                             [services/streaks.ts:37]
    ├── DB read/write of streak state
    └── metrics.inc("streaks.milestones_reached_total", ...)  (on milestone)
```

Both chains share the same shape: one triggering event, several downstream concerns bolted on by
direct call, each new concern requiring an edit to the trigger site itself.

## Proposed Solution

### A minimal in-process `EventEmitter`, not a message bus

```typescript
// apps/api/src/lib/domain-events.ts
import { EventEmitter } from "node:events";
import { logger } from "./logger";

export interface DomainEventMap {
  PayoutCompleted: {
    challengeId: string;
    payoutId: string;
    userId: string;
    amountStroops: bigint;
    txHash: string | null;
  };
  ChallengeSettled: {
    challengeId: string;
    winnerCount: number;
  };
  SessionCompleted: {
    sessionId: string;
    userId: string;
    challengeId: string;
  };
}

class DomainEvents {
  private emitter = new EventEmitter();

  emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): void {
    // Errors in one listener must never break another, or the code path that
    // emitted the event — logged and swallowed here rather than allowed to
    // propagate synchronously into the caller's control flow.
    this.emitter.listeners(event).forEach((listener) => {
      try {
        listener(payload);
      } catch (err) {
        logger.error("Domain event listener threw", { event, err });
      }
    });
  }

  on<K extends keyof DomainEventMap>(
    event: K,
    listener: (payload: DomainEventMap[K]) => void | Promise<void>,
  ): void {
    this.emitter.on(event, (payload) => {
      Promise.resolve(listener(payload)).catch((err) =>
        logger.error("Async domain event listener rejected", { event, err }),
      );
    });
  }
}

export const domainEvents = new DomainEvents();
```

Deliberately *not* proposed: a persistent/durable event log, cross-process pub/sub, or an outbox
pattern. Everything here already runs inside the same Node process (the BullMQ worker), so a
plain `EventEmitter` wrapper is the entire scope — genuinely a "minimal" pattern, not a message
bus in disguise.

### Where it lives

`apps/api/src/lib/domain-events.ts` — alongside `logger.ts`, `metrics.ts`, `redis.ts`: process-wide
infrastructure every route/service/processor can import, not a `packages/` workspace package.
Nothing here is shared with `apps/web` or `apps/deposit-monitor` (per RFC #1256's shared-config
reasoning, only genuinely cross-app concerns belong in `packages/`), so keeping it API-local avoids
a premature package boundary.

### Proof-of-concept migration: two side effects, chosen deliberately small

1. **`queueReferralBonusForPayout` (both call sites in `processPayout`)** becomes a listener on
   `PayoutCompleted` instead of an inline call:
   ```typescript
   // services/referrals.ts
   domainEvents.on("PayoutCompleted", ({ userId, amountStroops, challengeId }) => {
     return queueReferralBonusForPayout({ userId, amountStroops, challengeId });
   });
   ```
   `processPayout` emits `domainEvents.emit("PayoutCompleted", {...})` once per successful payout
   instead of calling `queueReferralBonusForPayout` directly.

2. **`updateStreak` (session completion)** becomes a listener on `SessionCompleted`, moving the
   direct call out of `routes/sessions.ts`.

Both are chosen specifically because they're already best-effort/non-blocking in spirit (a failed
referral-bonus queue or streak update shouldn't fail the payout or session-completion response) —
exactly the kind of side effect an event listener's isolated error handling suits well, and a low-
risk place to prove the pattern before touching anything on payout's critical path (Stellar
submission, DB writes, the integrity-HMAC check) which explicitly stays as direct, synchronous,
in-line code — see Open Questions.

## Honest Debuggability/Observability Trade-offs

**Costs of indirection:**
- **Harder to trace a request's full effect graph by reading one file.** Today, reading
  `processPayout` top-to-bottom tells you everything that happens on a successful payout. After
  migration, `queueReferralBonusForPayout`'s trigger requires knowing `services/referrals.ts`
  subscribes to `PayoutCompleted` — a `grep` away, but not visible in `payout.ts` itself.
- **Async listener errors are isolated by design** (a listener throwing doesn't break the emitter
  or other listeners) — this is a stated goal, but it also means a broken listener can silently
  stop doing its job while everything else looks fine, unless its `logger.error` calls are
  actually watched. This needs an explicit metric (e.g. `domain_events.listener_error_total`,
  tagged by event+listener) from day one, not added later once something's already silently
  broken.
- **No ordering or completion guarantee between listeners.** If a future listener depended on
  another listener's side effect completing first, the emitter above doesn't provide that —
  each listener must be independent, which is a real constraint on what's allowed to become a
  listener, not just a paperwork detail.
- **Testing a side effect requires either triggering the whole event flow or reaching into the
  emitter's listener registry** — more setup than calling a function directly and asserting on a
  mock.

**Benefits that justify it for these two specific side effects:**
- Referral bonus queueing and streak updates are already conceptually "fire and forget, log on
  failure" — the emitter's isolated-listener-errors model matches what they already are, it just
  makes that isolation structural instead of an artifact of each call site's own try/catch.
- Adding a third listener to `PayoutCompleted` (e.g. a future analytics hook) becomes a new file
  with an `.on()` call, not an edit to `payout.ts` that risks touching the Stellar-submission /
  integrity-check code nearby.

**Where this RFC explicitly does NOT recommend migrating:** the integrity-HMAC check, Stellar
submission (`submitBatchPayout`/`EscrowClient`), and the `createPayout`/`updatePayoutStatus` DB
writes stay direct, synchronous, in-line calls. These aren't "side effects" of payout completion —
they're what payout completion *is*. Eventifying them would hide the core operation's own control
flow behind the same indirection this RFC is trying to justify only for genuinely secondary
concerns.

## Benefits

1. New cross-cutting concerns (notifications, analytics) subscribe without editing
   `payout.ts`/`sessions.ts`.
2. Isolated listener error handling matches what referral-bonus queueing and streak updates
   already are in spirit (best-effort, non-blocking).
3. `packages/`-free — no new workspace boundary, no cross-app coupling.

## Open Questions

1. Should `domainEvents.emit()` calls be added at both `enqueuePayout` (queue time) and
   `processPayout` (execution time), or only the latter? This RFC assumes only
   `processPayout`-time events (a payout is only "completed" once it actually executes), but
   worth confirming a `PayoutQueued` event isn't also wanted by a future listener.
2. Is `node:events`' synchronous-dispatch `EventEmitter` sufficient, or does any candidate
   listener need to run *before* the emitting function returns (vs. this RFC's `Promise.resolve`
   fire-and-forget async listeners)? The two POC listeners chosen are fine either way; a future
   listener with a hard ordering requirement would need this revisited.
3. Where should `domain_events.listener_error_total` (or equivalent) actually be wired into the
   existing `metrics.ts`/alerting, so a silently-broken listener doesn't go unnoticed indefinitely?

## References

- Current files:
  - `apps/api/src/services/payout.ts`
  - `apps/api/src/queues/processors/payout.processor.ts`
  - `apps/api/src/services/streaks.ts`
  - `apps/api/src/routes/sessions.ts` (actual `updateStreak` call site)
  - `apps/api/src/services/referrals.ts` (`queueReferralBonusForPayout`)
