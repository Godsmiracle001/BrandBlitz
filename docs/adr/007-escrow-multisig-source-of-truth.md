# ADR 007: Escrow Multisig Threshold as Source-of-Truth from On-Chain Contract

## Status

Proposed

## Context

The API stores `escrow_multisig_threshold` as a database-backed admin config in `apps/api/src/routes/admin/config.ts`, while the actual signer threshold is set on-chain in `contracts/contracts/escrow`. These two values must always match for the platform to safely authorize and settle escrow releases. However, there is no reconciliation mechanism if the two diverge (e.g. after a manual on-chain call, a failed migration, or accidental misconfiguration). When they do diverge, the API may authorize transactions that the contract rejects, or fail to authorize valid transactions.

Currently, the relationship between the DB config value and on-chain state is undocumented, making it unclear which is the source of truth in case of conflicts.

## Decision

Treat the on-chain contract as the authoritative source of truth for the multisig threshold. The API must verify the threshold at startup or on a scheduled basis and either:

1. Read the threshold from the on-chain contract and store it locally for quick lookups (with periodic re-checks), or
2. Always read the threshold from the on-chain contract at authorization time (higher latency but guaranteed correctness)

Document the current flow (how the DB config value is used today, how it relates to on-chain state, and what happens if they diverge). Define and implement a reconciliation mechanism (startup check, scheduled job, or on-demand verification) that flags drift. Add alerting for mismatches so on-call engineers can triage and correct the divergence.

## Rationale

- **On-chain is immutable**: the contract state is the actual enforcer of multisig requirements; the DB value is merely a cached reflection
- **Single enforcement point**: the contract is the only place where the rule is actually enforced, so it must be the source of truth
- **Prevents silent failures**: drift detection ensures discrepancies surface immediately, not during a critical payout
- **Audit trail**: on-chain events provide a complete history of threshold changes, independent of the API's logs

## Consequences

- Requires integration with the Soroban contract to read the current signer threshold
- Requires either a startup check or scheduled reconciliation job, adding operational complexity
- Requires alerting infrastructure so drift is detected and triaged before it causes a payout failure
- Migration to this model may reveal existing drift; drift must be resolved before the new validation is enforced
- Documentation and training needed so on-call engineers understand the reconciliation process
