# ADR 008: Shared Dead-Letter Queue Policy for Uniform Retry and Backoff Semantics

## Status

Proposed

## Context

The dead-letter queue (DLQ) plumbing in `apps/api/src/queues/dlq.ts` (247+ lines) defines separate queue and worker pairs for payouts, referral bonuses, leagues, and recurring challenges. Each queue has its own processor function (e.g. `processPayoutDlqJob`, `processReferralBonusDlqJob`) that duplicates core logic: retry limits, backoff policy, alerting semantics, and audit-log recording. This duplication creates a maintenance burden and a risk that one queue's DLQ silently has different retry semantics or failure handling than another's, leading to inconsistent operational behavior.

## Decision

Extract a generic `registerDlq(sourceQueueName, processor, config)` helper function that encapsulates the shared DLQ lifecycle: queue and worker creation, job options, retry policy, alerting, and metrics. DLQ processors register once by name, and the shared helper ensures all DLQs have identical retry semantics and logging.

Migrate the four existing DLQs (payout, referral-bonus, league, recurring-challenges) to use the shared helper, reducing duplication and ensuring consistency. Define the DLQ policy (retry limits, backoff, alerting surface) as a central constant or configuration object so changes to retry semantics happen in one place and apply uniformly.

## Rationale

- **DRY principle**: retry logic, alerting, and job-option construction are defined once, not four times
- **Consistency**: all queues inherit the same retry semantics, eliminating surprise divergence (e.g. "payout DLQ retries differently than referral DLQ")
- **Maintainability**: changes to DLQ policy (e.g. raising retry limits, adding metrics) require edits in one place
- **Extensibility**: adding a new DLQ is a one-liner, not a copy-paste of boilerplate
- **Auditability**: a central DLQ policy module makes the retry contract explicit and reviewable

## Consequences

- Requires refactoring of `dlq.ts` to extract a shared `registerDlq` helper and move queue-specific logic into processor callbacks
- The generic helper must handle the full lifecycle (queue creation, worker setup, job forwarding, reconciliation) and remain flexible enough for edge cases (e.g. league jobs have no DB row to update)
- Testing the shared helper requires parametric tests to verify behavior across different job types
- Rollback strategy: if the generic helper misses an edge case, it may break a queue's DLQ handling; comprehensive integration tests are required before shipping
- Future DLQ additions or changes to retry policy automatically apply to all queues, reducing opportunity for divergence
