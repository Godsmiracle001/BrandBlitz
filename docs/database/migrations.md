# Database Migration Strategy

## Current strategy

`init.sql` is now a bootstrap script. It includes the baseline schema at
`apps/api/migrations/00000-initial.sql` and then applies the forward migration
files under `apps/api/migrations/`.

### Rules

| Scenario                        | What to run                                    |
| ------------------------------- | ---------------------------------------------- |
| Fresh install / CI from scratch | `psql -f init.sql`                             |
| Existing database upgrade       | `pnpm --filter @brandblitz/api migrate`        |
| Migration verification in CI    | `pnpm --filter @brandblitz/api migrate:dryrun` |

### Filename convention

New migration files must match:

```
<NNNNN>-<kebab-case-description>[.down].sql
```

- `NNNNN` — a 5-digit, zero-padded sequence number, one greater than the
  highest existing sequence number (e.g. `00027-...`).
- `<kebab-case-description>` — lowercase words separated by single hyphens.
- An optional `.down.sql` file with the same prefix provides the rollback.

Example: `00027-add-payout-retry-count.sql` with an optional
`00027-add-payout-retry-count.down.sql` rollback.

Files predating this convention (mixed 4/5-digit and underscore-separated
names under `apps/api/migrations/`) are grandfathered in and are **not**
renamed — renaming an applied migration would require rewriting the
`schema_migrations` table on every environment, which risks downtime. Only
new migration files are required to follow the pattern.

`pnpm --filter @brandblitz/api migrate:lint` (wired into CI, see
`.github/workflows/ci.yml`) enforces this for every file that isn't in the
grandfathered list.

### Migration files

| File                              | Description                                              |
| --------------------------------- | -------------------------------------------------------- |
| `00000-initial.sql`               | Baseline snapshot of the current schema                  |
| `00001-hot-path-indexes.sql`      | Adds the challenge, leaderboard, and payout indexes      |
| `00001-hot-path-indexes.down.sql` | Rolls back the hot-path indexes safely                   |
| `00002-refunds.sql`               | Adds refund tracking and the `refunded` challenge status |

### Operational notes

- The migration runner serializes execution with a `SELECT ... FOR UPDATE`
  lock row before applying DDL.
- Safe migrations can include a matching `*.down.sql` rollback file.
- The runner runs `ANALYZE` after applying or rolling back migrations so the
  planner refreshes statistics immediately.
- `CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS` are used where possible
  so replays are safe on already-upgraded databases.

### CI validation (dual-path + down-migration exercise)

The workflow `.github/workflows/db-dual-path.yml` now checks three paths:

1. **Fresh path** - runs `init.sql`
2. **Migration path** - seeds `00000-initial.sql` and then applies the forward
   migrations in `apps/api/migrations/`
3. **Down-migration exercise** - applies all forward migrations, then rolls back
   each available `.down.sql` file in reverse version order, re-applies the
   corresponding up migration, and asserts the schema matches the pre-rollback
   baseline (a round-trip check).

Both the fresh and migration paths are diffed with `pg_dump --schema-only`; the
workflow fails if they diverge.

The down-migration exercise runs whenever a PR adds or modifies a `.down.sql`
file under `apps/api/migrations/`. This ensures every rollback code path is
validated before it is ever needed during a live incident.
