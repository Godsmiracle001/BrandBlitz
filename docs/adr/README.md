# Architecture Decision Records

Load-bearing engineering decisions live here in Michael Nygard format.
See [ADR 000](./000-adr-process.md) for the format, lifecycle, and
template.

| # | Title | Status |
|---|-------|--------|
| [000](./000-adr-process.md) | Architecture Decision Record Process | Accepted |
| [001](./001-phone-storage.md) | Store Hashed Phone Numbers Instead Of Raw Numbers | Accepted |
| [002](./002-escrow-usage.md) | USDC Prize-Pool Escrow on Stellar Soroban | Accepted |
| [003](./003-migrations-framework.md) | Hand-Rolled SQL Migrations over an ORM | Accepted |
| [004](./004-vitest-vs-jest.md) | Vitest over Jest for Unit Tests | Accepted |
| [005](./005-sentry-vs-opentelemetry.md) | Sentry for Errors, OpenTelemetry for Traces / Metrics | Accepted |
| [006](./006-unified-cache-tagging.md) | Unified Cache Tagging Scheme for Redis and Next.js Cache Invalidation | Proposed |
| [007](./007-escrow-multisig-source-of-truth.md) | Escrow Multisig Threshold as Source-of-Truth from On-Chain Contract | Proposed |
| [008](./008-shared-dlq-policy.md) | Shared Dead-Letter Queue Policy for Uniform Retry and Backoff Semantics | Proposed |

## When to write one

- The decision affects more than one module or team.
- It is hard to reverse (migrations, public API, on-chain shape).
- A reasonable reviewer would ask "why didn't we do X instead?".
- The reason isn't obvious from the code (compliance, third-party
  constraint, prior incident).

Routine choices (naming a function, picking a library version) do
not need an ADR.
