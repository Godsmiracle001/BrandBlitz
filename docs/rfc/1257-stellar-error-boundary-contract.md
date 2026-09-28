# RFC 1257: Define a stable error-boundary contract between `packages/stellar` and `apps/api`

## Problem Statement

`packages/stellar` throws a mix of plain `Error`, `TypeError`, and `RangeError` instances with no shared shape, error codes, or a documented contract for what callers in `apps/api` should expect. Every call site in `apps/api` (routes, services, queue processors) that touches `@brandblitz/stellar` has to guess at the failure mode of the function it's calling and fashion its own ad-hoc `catch` logic. This makes it impossible to reliably distinguish retryable network/Horizon failures from permanent validation failures, and it means Sentry/monitoring context differs per call site instead of being consistent.

## Current State

### Inconsistent throw sites in `packages/stellar`

| File | Pattern |
|------|---------|
| `constants.ts` | `TypeError` for bad input shape, `RangeError` for out-of-bounds amounts |
| `escrow.ts` | Plain `Error` with a templated message pulled from the contract's `error_details` |
| `payout.ts` | Plain `Error` wrapping a lower-level SDK error's `.message` |
| `accounts.ts` | Plain `Error` for malformed envelopes/transactions |
| `client.ts` | Plain `Error` for invalid network names |

None of these carry a machine-readable `code`, a `retryable` flag, or a consistent `cause`/context payload. Consumers in `apps/api` (`services/payout.ts`, `services/refund.ts`, `routes/admin/escrow.ts`, `routes/webhooks.ts`, `queues/processors/referral-bonus.processor.ts`) each currently either:

- let the error bubble up to the global Express error handler (`apps/api/src/middleware/error.ts`), which reports everything to Sentry uniformly regardless of whether it was a transient Horizon timeout or a permanent validation error, or
- wrap the error in their own bespoke try/catch with app-specific heuristics (e.g. string-matching on `err.message`) to decide whether to retry a queue job.

String-matching on error messages is brittle — a wording change in `packages/stellar` silently breaks retry logic in `apps/api` with no compile-time signal.

## Proposed Contract

### 1. A shared `StellarError` base class

Introduce a single exported error type from `packages/stellar`:

```ts
export type StellarErrorCode =
  | "INVALID_INPUT"       // bad argument shape/range — never retryable
  | "NETWORK_UNAVAILABLE"  // Horizon/RPC unreachable or timed out — retryable
  | "CONTRACT_REJECTED"    // Soroban invocation returned an error_details — not retryable without a new tx
  | "TRANSACTION_NOT_FOUND"
  | "UNKNOWN";

export class StellarError extends Error {
  readonly code: StellarErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(message: string, code: StellarErrorCode, opts?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = "StellarError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.cause = opts?.cause;
  }
}
```

- `constants.ts` validation failures map to `StellarError` with `code: "INVALID_INPUT"` (replacing raw `TypeError`/`RangeError`).
- `escrow.ts` / `payout.ts` failures originating from a rejected contract invocation map to `code: "CONTRACT_REJECTED"`.
- Horizon/RPC network failures (timeouts, connection errors) map to `code: "NETWORK_UNAVAILABLE"` with `retryable: true`.
- `payout.ts`'s "transaction not found" case maps to `code: "TRANSACTION_NOT_FOUND"`.

### 2. `apps/api` consumes the contract, not string messages

Callers switch on `err.code` / `err.retryable` instead of matching on `err.message`:

```ts
try {
  await escrowClient.settle(...);
} catch (err) {
  if (err instanceof StellarError && err.retryable) {
    throw err; // let BullMQ retry
  }
  captureExceptionSync(err, { code: err instanceof StellarError ? err.code : "UNKNOWN" });
  throw new UnretryableJobError(err);
}
```

This keeps `apps/api/src/middleware/error.ts` unchanged for the default path (all uncaught errors still get logged + reported to Sentry), but gives queue processors and route handlers a documented, typed way to opt into retry-vs-fail decisions without inspecting message strings.

### 3. Backward compatibility

`StellarError` extends `Error`, so any code that doesn't check `instanceof StellarError` continues to work exactly as before (`err.message` is still populated, `instanceof Error` still holds). This is an additive, non-breaking change — no existing call site is required to change immediately.

## Alternatives Considered

- **Result/Either return types instead of throwing.** Rejected for this RFC's scope — it would require rewriting every function signature in `packages/stellar` and every call site in `apps/api` in one pass. A typed error class is a strictly smaller, incremental change that can land without a breaking API surface change.
- **Leave error mapping entirely to `apps/api`.** Rejected — this is the status quo and is exactly what causes the string-matching brittleness described above. The mapping needs to happen at the source (`packages/stellar`) since only that package knows whether a given failure came from input validation, the network, or a rejected contract call.

## Migration Plan

1. Add `StellarError` and `StellarErrorCode` to `packages/stellar/src/errors.ts`, exported from `packages/stellar/src/index.ts`.
2. Update `constants.ts` throw sites to use `StellarError` with `code: "INVALID_INPUT"` (no behavior change — still a thrown `Error` subclass).
3. Update `escrow.ts` and `payout.ts` throw sites to classify failures per the table above.
4. Update `apps/api` retry-sensitive call sites (queue processors in particular) to check `err.code`/`err.retryable` instead of message matching, on a case-by-case basis in follow-up PRs.
5. No database or API contract changes are required; this is internal to the two packages.

## Open Questions

- Should `NETWORK_UNAVAILABLE` classification live in `packages/stellar` (inspecting the underlying Horizon SDK error) or should `apps/api` be responsible for deciding retryability based on `code` alone? This RFC proposes the former, since `packages/stellar` is the only place with visibility into the underlying SDK error shape.

Closes #1257
