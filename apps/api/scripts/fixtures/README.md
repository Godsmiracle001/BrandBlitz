# API seed fixtures

Static files consumed by the local dev seed script, [`../seed.ts`](../seed.ts). Nothing in
this directory is loaded by the running API, the worker, or the test suites.

## Contents

| File                | Used by                   | Purpose                                                             |
| ------------------- | ------------------------- | ------------------------------------------------------------------- |
| `logos/brand-1.png` | `seed.ts` → "Stellar Pay" | Placeholder logo for seed brand 1 (`seed-brand-1@brandblitz.test`). |
| `logos/brand-2.png` | `seed.ts` → "NovaMint"    | Placeholder logo for seed brand 2 (`seed-brand-2@brandblitz.test`). |
| `logos/brand-3.png` | `seed.ts` → "AetherShop"  | Placeholder logo for seed brand 3 (`seed-brand-3@brandblitz.test`). |

The logos are 1×1 RGBA PNGs: they only exist so each seeded brand has a stable, non-empty
`logo_url`. They are **not** uploaded to MinIO. `seed.ts` maps each brand's `logoKey` to
`local://fixtures/logos/<file>` and stores that string in `brands.logo_url`, and prints the
absolute path of this directory when seeding finishes.

## Fixtures vs. the seed scripts

| Script                                                                                   | Data source                                                                                         | When to use                                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`apps/api/scripts/seed.ts`](../seed.ts)                                                 | Brand/challenge definitions in the script itself, deterministic RNG, logo files from this folder.   | Local development: fills the DB with 50 users, 3 brands, 6 challenges, 200 sessions. Also run by `db:reset --seed` and `SEED_DEV=1`. |
| [`scripts/seed-e2e-challenge.ts`](../../../../scripts/seed-e2e-challenge.ts) (repo root) | Inline values only. Does **not** read anything from this folder (its logo is a `placehold.co` URL). | Playwright E2E runs (`.github/workflows/e2e.yml`): creates one active challenge for the browser tests.                               |

So `fixtures/` is only an asset folder for `seed.ts`. The row data itself (users, brands,
challenges, sessions) is generated in code, not read from fixture files.

## Adding or changing fixtures

- Add the file here and reference it from the `BRANDS` array in `seed.ts` via `logoKey`.
  Nothing picks up new files in this folder automatically.
- Keep files small and free of real data. Everything here is committed and public.
- Gitleaks still scans this folder. If a fake credential in a fixture triggers a false positive,
  add a scoped allowlist entry as described in
  [CONTRIBUTING.md → Gitleaks false positives](../../../../CONTRIBUTING.md#gitleaks-false-positives).
