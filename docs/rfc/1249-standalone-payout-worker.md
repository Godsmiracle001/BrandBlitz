# RFC 1249: Move Stellar payout execution out of the API process into a dedicated worker service

## Problem Statement

Payout logic spans three files, all running inside the same Express process that
serves user-facing HTTP traffic:

- `apps/api/src/services/payout.ts` (321 lines) — orchestration (`processPayout`,
  fraud-block handling via `isFraudBlockError`).
- `apps/api/src/queues/processors/payout.processor.ts` — the BullMQ `Worker` that
  invokes `processPayout` for each job, `concurrency: PAYOUT_WORKER_CONCURRENCY`.
- `packages/stellar/src/payout.ts` (316 lines) — Stellar transaction building, hot-wallet
  signing, and submission to Horizon.

Because the BullMQ worker (`createPayoutWorker`) runs in-process today, Horizon latency
or an outage, or hot-wallet signing slowness, shares CPU/event-loop time and memory with
whatever else the Express process is doing for concurrent HTTP requests — there's no
process boundary between "a user is hitting `GET /brands/public`" and "we're waiting on
a Horizon submission to confirm."

## Current State

### Where payout code runs today

`payout.processor.ts` constructs its `Worker` with `payoutWorkerOptions = { connection:
redis, concurrency: PAYOUT_WORKER_CONCURRENCY }` and is started as part of the same
process that also binds the HTTP listener (confirmed: no separate entrypoint file for
the payout worker exists under `apps/api` — unlike `apps/deposit-monitor`, which has its
own `src/index.ts` and its own deployable process).

`processPayoutJob` already isolates *retry* semantics correctly — fraud-blocked payouts
throw `UnrecoverableError` so BullMQ won't retry a decision that won't change — but that
retry-correctness is orthogonal to the process-isolation problem this RFC addresses.

### Existing precedent: `apps/deposit-monitor`

`apps/deposit-monitor/src/index.ts` is already a standalone process with its own
`package.json`/entrypoint. Critically, **it does not hold its own Postgres connection
pool** — it never imports `pg` or `apps/api/src/db`. Instead it polls Horizon for
deposit events and, on each one, calls back into the API over HTTP with an HMAC-signed
webhook:

```typescript
function signWebhookPayload(payload: string, timestamp: number): string {
  const hmac = crypto.createHmac("sha256", config.WEBHOOK_SECRET);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest("hex");
}
// ...
await fetch(`${config.API_URL}/webhooks/stellar/deposit`, {
  headers: { "X-Webhook-Secret": ..., "X-Webhook-Signature": `sha256=${signature}`, ... },
  body,
});
```

This is the shape this RFC proposes for the payout worker too: a separate process that
owns Stellar interaction (submission, not signing-authority *storage* necessarily — see
Open Questions) and calls back to the API via a signed webhook for the DB write, rather
than opening a second direct Postgres connection pool against the same database.

## Proposed Solution

### A standalone `apps/payout-worker` process

```
apps/payout-worker/
├── src/
│   ├── index.ts          # entrypoint: connects to Redis, starts the BullMQ Worker
│   ├── config.ts          # extends packages/config's sharedEnvSchema (see RFC #1256)
│   └── process-payout.ts  # moved from apps/api/src/services/payout.ts
├── package.json
```

- `packages/stellar/src/payout.ts` is already a shared package — it moves with no
  import-path change for either consumer, same as `@brandblitz/stellar` is already
  shared between `apps/api` and `apps/deposit-monitor` today.
- `payout.processor.ts`'s BullMQ `Worker` setup moves into `apps/payout-worker/src/
  index.ts`, unchanged in shape — it already just needs a Redis connection, which the
  new process gets independently (same `REDIS_URL`, same queue name `"payout"`, so
  `apps/api` enqueuing a job via `payout.queue.ts` and `apps/payout-worker` consuming it
  works exactly as it does today — only the process boundary changes, not the queue
  contract).

### Secret access: hot-wallet key

The worker needs `HOT_WALLET_SECRET` to sign Stellar transactions — this is the one
genuinely new secret-distribution surface this RFC introduces (today only the API
process holds it). Two options, not resolved definitively here:

- **(a) Worker holds the signing key directly** — simplest, matches how `apps/api`
  already holds it today; just widens which deployed process has access to the same
  secret value (same risk profile as today, one more place it's mounted).
- **(b) API keeps the signing key; worker calls back for signing** — worker builds the
  unsigned transaction, calls an internal API endpoint to sign+submit, API never
  delegates the key itself. Removes the "one more process holds the key" concern
  entirely, at the cost of putting the API process back in the Horizon-submission
  critical path for the signing step specifically — undermining part of this RFC's
  own motivation (isolating Horizon latency from the HTTP process). Recommended
  against for that reason, listed for completeness.

This RFC recommends **(a)** — matching `deposit-monitor`'s existing pattern of workers
holding their own scoped secrets (`WEBHOOK_SECRET`) rather than proxying every
sensitive operation back through the API.

### DB access: no second connection pool

Following the `deposit-monitor` precedent, `apps/payout-worker` does **not** open its
own `pg.Pool` against the shared database. `processPayout`'s current DB writes
(`failPayoutsForChallenge`, payout status updates) become an authenticated internal
webhook call to a new `POST /internal/payouts/:challengeId/complete`-style endpoint in
`apps/api`, signed the same way `deposit-monitor`'s webhook already is (reusing
`WEBHOOK_SECRET` verification middleware, `apps/api/src/middleware/verify-webhook.ts`,
already exists for this exact purpose). This keeps exactly one process
(`apps/api`) owning the Postgres pool sizing/connection count, rather than every worker
independently guessing at its own `DB_POOL_MAX`.

## Migration Path — In-Flight Job Handling During Cutover

1. Stand up `apps/payout-worker` as a new deployable, pointed at the **same** Redis
   instance and `"payout"` queue `apps/api` already enqueues to — but not yet started
   in production.
2. Add the internal webhook endpoint in `apps/api` for the DB-write callback; keep the
   old direct-DB-write code path in `apps/api`'s in-process worker as well (both exist
   simultaneously, neither is deleted yet).
3. **Cutover**: stop the in-process BullMQ `Worker` in `apps/api` (stop calling
   `createPayoutWorker()` at startup) and start `apps/payout-worker`'s process at the
   same time. Because both consume the exact same BullMQ queue name with the same job
   payload shape, any job already enqueued but not yet picked up at cutover time is
   simply picked up by whichever worker is running — BullMQ's queue persistence in
   Redis means no in-flight job is lost, only its *consumer* changes. A job actively
   mid-processing in the old in-process worker at the exact moment of deploy should be
   allowed to finish (standard graceful-shutdown drain, matching the pattern already
   used in `gdpr-erasure.processor.ts`'s SIGTERM handling) before that process exits.
4. Remove the old `createPayoutWorker()` call and `payout.processor.ts`'s in-process
   wiring from `apps/api` once `apps/payout-worker` has run stably.

## Benefits

1. Horizon latency/outages no longer share process/event-loop time with HTTP request
   handling.
2. Hot-wallet signing operations get their own resource ceiling
   (`PAYOUT_WORKER_CONCURRENCY`) independent of API request load.
3. Matches the precedent already established by `apps/deposit-monitor` — this isn't a
   new pattern for the codebase, it's applying an existing one consistently.
4. `apps/api`'s Postgres pool sizing stops needing to account for a second in-process
   consumer of connections during payout bursts.

## Open Questions

1. (a) vs (b) above for hot-wallet secret placement — needs a security-conscious
   maintainer's call, not just an engineering-convenience one.
2. Should the internal completion webhook reuse `apps/api/src/middleware/
   verify-webhook.ts` as-is, or does payout completion need a distinct secret from
   `WEBHOOK_SECRET` (currently shared with `deposit-monitor`'s inbound webhook) so a
   compromised deposit-monitor credential can't forge a payout-completion call?
   Recommend a **separate** secret for this reason — flagged here rather than assumed.
3. Does `PAYOUT_WORKER_CONCURRENCY` need re-tuning once it's no longer competing with
   HTTP request handling for the same process's resources?

## References

- Current files:
  - `apps/api/src/services/payout.ts`
  - `apps/api/src/queues/processors/payout.processor.ts`
  - `packages/stellar/src/payout.ts`
  - `apps/deposit-monitor/src/index.ts` — existing standalone-worker precedent this RFC
    follows
- Related: [RFC #1256](./1256-shared-config-package.md) (shared config package — the
  new worker's `config.ts` should extend the shared fragment proposed there rather than
  writing a fourth independent schema)
