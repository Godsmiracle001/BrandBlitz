# Database Migrations

Hand-rolled SQL migrations executed in lexicographic order by the migration runner.

## Naming Convention

All migration filenames use a **5-digit zero-padded sequence number** followed by a hyphen and a descriptive slug:

```
00000-initial.sql
00001-hot-path-indexes.sql
00002-refunds.sql
...
00042-example-feature.sql
```

This ensures migrations are ordered correctly regardless of the number of digits, as lexicographic sort (used by the migration runner) matches numeric sort when all numbers have the same width.

### Migration Number Allocation

- Sequence numbers start at `00000` and increment with each new migration
- Numbers are never re-used or skipped (even if a migration is removed from history)
- Use the highest existing number as a reference when adding the next migration

### Historical Note

Earlier migrations (00000-00012) used 5-digit prefixes, while migrations 0006-0026 used 4-digit prefixes. This mixed convention created ambiguity and a duplicate "0012" / "00012" that required historical files to remain unchanged. All new migrations must use 5-digit prefixes to prevent future confusion and ensure correct sort order.

Some existing files (e.g. `0015_idx_audit_log_entity_key.sql`, `0021_session_round_scores_reaction_time.sql`) use an underscore after the sequence number instead of a hyphen. The migration runner sorts lexicographically and does not care which separator is used, so this does not affect correctness — but **a hyphen is the standard separator** per the convention above. Existing underscore-separated files are left as-is; all new migrations must use a hyphen.

## Adding a New Migration

1. Find the highest sequence number currently in use (e.g., 00026)
2. Create the next file: `00027-your-slug.sql`
3. Write the SQL (add a `.down.sql` file if the migration is reversible)
4. Commit both files

## Migration Runner Expectations

The runner sorts migration files lexicographically and executes them in order. With 5-digit zero-padded prefixes, lexicographic order matches numeric order up to 99,999 migrations, which is far beyond the scope of this project.
