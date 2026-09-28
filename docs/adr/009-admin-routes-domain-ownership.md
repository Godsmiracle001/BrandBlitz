# ADR 009: Reorganize admin routes into domain-owned modules

## Status

Proposed

## Context

`apps/api/src/routes/admin/` flattens unrelated domains — escrow,
payouts, fraud, users, waitlist, queue-stats, config, audit-log —
into one directory mounted behind a single router. Each file (e.g.
`admin/escrow.ts`) has no co-location with the domain module it
actually operates on (e.g. `services/payout.ts`), so it's unclear
which team owns which admin endpoint, and auth/validation patterns
have drifted slightly between files as a result.

## Decision

Reorganize admin routes to be domain-owned rather than living in one
flat directory, while keeping the external admin API paths (URLs)
unchanged. Two options, either acceptable:

1. **Co-location**: move each admin route file next to the domain
   module it serves (e.g. `services/payout.ts` + `services/payout.admin.ts`).
2. **Per-domain sub-routers**: keep `routes/admin/` as a mount point,
   but split it into per-domain sub-routers (`admin/escrow/`,
   `admin/payouts/`, ...) that each import a shared admin-auth
   wrapper, rather than one flat list of sibling files.

Sub-routers (option 2) are the lower-risk starting point since they
don't require touching `services/*` module boundaries.

## Rationale

Domain ownership should be visible from file location, not just from
route path. A shared `admin-auth` wrapper factored out once (instead
of re-implemented per file) also closes the risk of auth/validation
drifting across admin endpoints, which is the actual bug risk this
RFC is trying to prevent — not just a cosmetic reorg.

## Consequences

- No change to the public admin API surface — this is a source-tree
  reorganization only.
- Migration should happen one domain at a time (not a single large
  PR), in roughly this order: escrow → payouts → fraud → users →
  waitlist → queue-stats → config → audit-log, since escrow and
  payouts are the highest-risk/highest-churn domains and benefit most
  from an owned auth wrapper early.
- Each migrated domain's admin routes must keep their existing tests
  passing unmodified (route paths and behavior are not changing).
