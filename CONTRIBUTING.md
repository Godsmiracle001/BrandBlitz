# Contributing to BrandBlitz

Thank you for contributing to BrandBlitz — the skill-validated attention marketplace built on Stellar.

---

## Table of Contents

- [Branch Naming](#branch-naming)
- [Commit Format](#commit-format)
- [Pull Request Guidelines](#pull-request-guidelines)
- [PR Title Lint](#pr-title-lint)
- [Code Review Expectations](#code-review-expectations)
- [Drips Wave 4 Rules](#drips-wave-4-rules)
- [Issue Templates](#issue-templates)
- [Operations Runbooks](#operations-runbooks)
- [Pre-commit Hook](#pre-commit-hook)
- [Gitleaks false positives](#gitleaks-false-positives)
- [Bundle Size](#bundle-size)
- [Getting Started](#getting-started)

---

## Branch Naming

All branches must follow this pattern:

```
<type>/issue-<N>-<short-description>
```

| Type | When to use |
|---|---|
| `feat` | New feature or user-facing behaviour |
| `fix` | Bug fix |
| `test` | Adding or updating tests only |
| `refactor` | Code change that neither adds a feature nor fixes a bug |
| `chore` | Tooling, dependencies, build scripts |
| `docs` | Documentation only |

**Examples**

```bash
feat/issue-42-challenge-leaderboard
fix/issue-13-n-plus-one-leaderboard-query
test/issue-23-rate-limit-middleware
docs/issue-55-contributing-guide
chore/issue-67-upgrade-stellar-sdk
```

Branches that do not match this pattern will fail the branch-name check in CI.

---

## Commit Format

BrandBlitz uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

- **type** — one of: `feat`, `fix`, `test`, `refactor`, `chore`, `docs`, `perf`, `ci`
- **scope** — optional, the affected package or layer: `api`, `web`, `stellar`, `storage`, `contracts`, `worker`
- **summary** — present tense, lowercase, no trailing period, under 72 characters
- **body** — wrap at 100 characters; explain *why*, not *what*
- **footer** — `Closes #N` or `Fixes #N` to auto-close the linked issue

**Examples**

```
feat(api): add getTopSessionsPerChallenge to eliminate leaderboard N+1 query

Closes #13
```

```
fix(web): validate MIME type and file size before presigning upload

Fixes #49
```

```
test(api): cover all rate-limit policies, key derivation, and Redis fail-open

Closes #23
```

Commits that do not follow Conventional Commits will fail the commit-message lint hook.

---

## Pull Request Guidelines

1. **One issue per PR.** Keep PRs focused — reviewers review faster, CI fails more precisely.
2. **Link the issue.** Include `Closes #N` (or `Fixes #N`) in the PR description body so the issue auto-closes on merge.
3. **Tests are required.** Every feature or bug fix must include tests. PRs that drop overall coverage below the current baseline will be blocked.
4. **Type-check must pass.** Run `pnpm type-check` locally before pushing.
5. **Lint must pass.** Run `pnpm lint` locally. The CI gate rejects any ESLint errors.
6. **No `console.log` in production code.** Use the structured logger (`apps/api/src/lib/logger.ts`) in the API, and `console.error` only for unrecoverable startup errors.
7. **Keep `.env.example` in sync.** If you add a new environment variable, add it to `.env.example` with an inline comment and add a row to the Environment Variables table in [`README.md`](./README.md#environment-variables) (Name, Required, Default, Description).

### PR Description Template

GitHub auto-populates new PRs with this template from [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) — no need to copy it manually.

---

## PR Title Lint

PR titles are linted against the Conventional Commits format by the CI pipeline (see issue [#57](../../issues/57)).

The title **must** match:

```
<type>(<optional-scope>): <summary>
```

**Valid**

```
feat(api): add global leaderboard endpoint with Redis cache
fix(web): prevent double-submit on challenge answer
test(api): unit tests for rate-limit middleware
docs: add CONTRIBUTING guide and fix README env vars
```

**Invalid** — these will fail CI

```
Updated the leaderboard            ← no type prefix
feat: Updated the leaderboard      ← uppercase U, no scope (scope is optional but summary must be lowercase)
WIP: fixing stuff                  ← not a valid type
```

---

## Code Review Expectations

### For authors

- Respond to all review comments before requesting re-review.
- Mark threads as resolved only after the reviewer's concern is addressed in code.
- Keep the PR up to date with `main` — rebase, don't merge.

### For reviewers

- Review within **2 business days** of assignment.
- Use GitHub's suggestion feature for minor one-line fixes — it saves a round-trip.
- Distinguish blocking concerns from non-blocking nits:
  - **Blocking** — correctness, security, missing tests, API contract breakage
  - **Nit** — style preferences that don't affect correctness (prefix with `nit:`)
- Approve once all blocking concerns are addressed. Do not block on unresolved nits.

### Merge criteria

A PR may be merged when it has:
1. At least **1 approving review** from a maintainer
2. All CI checks green (type-check, lint, tests, PR title lint)
3. No unresolved blocking comments

Maintainers may merge with a single approval for documentation-only changes.

---

## Drips Wave Participation Rules

BrandBlitz is built as part of the [Drips programme](https://drips.network). The following rules apply to all Drips Wave contributions in this repository:

1. **All Stellar integrations must run on testnet during development.** Set `STELLAR_NETWORK=testnet` in your `.env`. Never commit mainnet credentials.
2. **Every PR that touches Stellar code must include a testnet transaction hash** in the PR description demonstrating the happy path works end-to-end. Use the `stellar-cli` or Stellar Laboratory to verify.
3. **Payments are real even on testnet.** Use the testnet faucet (`friendbot`) to fund test wallets. Never use real USDC for local testing.
   Run `STELLAR_NETWORK=testnet pnpm fund:testnet-wallet` (`scripts/fund-testnet-wallet.ts`) to generate a keypair and fund it via friendbot in one step — it refuses to run against any network other than testnet.
4. **Smart contract changes require a separate PR.** Changes to `contracts/escrow/` must be reviewed by at least two maintainers and include both `cargo test` and `soroban-cli` deploy output.
5. **Batch payouts must not exceed 50 ops per transaction.** The `MAX_OPS_PER_TX = 50` constant in `packages/stellar/src/constants.ts` is a hard limit — Stellar rejects transactions above this.
6. **Do not change the escrow contract interface without a migration plan.** Breaking changes to `settle()` or `refund()` affect live brand deposits.
7. **Drips Wave submission deadline.** All PRs intended for the current Wave submission must be merged to `main` before the freeze date communicated in the project Discord. PRs open after the freeze are automatically queued for the next Wave.

---

## Issue Templates

Use the appropriate issue template when opening a new issue (see issue [#60](../../issues/60)):

| Template | When to use |
|---|---|
| **Bug report** | Something that was working and now isn't, or produces incorrect output |
| **Feature request** | New functionality or a change to existing behaviour |
| **Test coverage** | A module that lacks tests; specify the file and target coverage % |
| **Documentation** | Incorrect, outdated, or missing docs |
| **Chore / maintenance** | Dependency upgrades, tooling changes, CI fixes |

If no template fits, open a blank issue with at minimum: context, expected behaviour, and actual behaviour.

---

## Operations Runbooks

When you introduce a new failure mode (new queue, new external dependency, new background job), add a runbook in [`docs/runbooks/`](./docs/runbooks/README.md) following the template in the index.

Runbooks cover: symptom → impact → diagnosis → mitigation → remediation.
Link your new runbook from the `docs/runbooks/README.md` index.

---

## Pre-commit Hook

`pnpm install` runs `husky` (the root `prepare` script), which installs
[`.husky/pre-commit`](./.husky/pre-commit). The hook runs two checks on every commit:

1. **Prettier (staged files only).** Runs `prettier --check` on the staged `*.ts`, `*.tsx`, `*.json`,
   and `*.md` files (the same globs and `--ignore-path .gitignore` as `pnpm format`). It never
   scans the whole repo. If a file isn't formatted, the commit is blocked with a message to run
   `pnpm format`. To format only the files you touched, run
   `pnpm exec prettier --write <file>...`. Then re-stage and commit again.
2. **Gitleaks.** Runs `pnpm gitleaks:pre-commit` on the staged diff (see
   [Gitleaks false positives](#gitleaks-false-positives) below).

Some existing files predate the hook and aren't Prettier-formatted yet. The first time you stage
one, the hook asks you to format the whole file. Commit that reformat with your change, or in its
own `style:` commit if the diff gets noisy.

---

## Gitleaks false positives

Commits are blocked by [`scripts/gitleaks.mjs`](../scripts/gitleaks.mjs) via the
[`.husky/pre-commit`](../.husky/pre-commit) hook (`pnpm gitleaks:pre-commit` — pipes
`git diff --cached` into `gitleaks detect --pipe --redact --config .gitleaks.toml`).
If a fixture or test value that *looks* like a secret triggers a false positive (e.g.
a Stellar `S...` key in a test fixture), add a scoped allowlist entry to
[`.gitleaks.toml`](../.gitleaks.toml) instead of bypassing the hook.

### Allowlist syntax (`.gitleaks.toml`)

Gitleaks uses TOML. Add a per-rule `[[rules.allowlist]]` (or a global `[allowlist]`)
with a `description`, `regexes`/`regex`, and/or `paths`. Keep the entry as narrow
as possible — pin it to a single file/path and a single secret-looking pattern.

**Concrete example — allow a fake Stellar secret only inside test fixtures:**

```toml
# .gitleaks.toml
[[rules]]
id = "stellar-secret-key"
description = "Stellar secret key (S...)"
regex = '''\bS[ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55}\b'''
tags = ["stellar", "secret"]

  [[rules.allowlist]]
  description = "test fixture with fake S... key — not a real secret"
  # Only suppress inside fixtures; change the path to the file that holds the false positive.
  paths = ['''apps/api/scripts/fixtures/.*''']
  # Optionally pin to the exact fake value:
  # regexes = ['''SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB''']
```

Alternative global form (use sparingly):

```toml
[allowlist]
description = "allow fake keys in fixtures"
paths = ['''apps/api/scripts/fixtures/.*''']
```

After editing `.gitleaks.toml`, re-stage the config and retry the commit — the
pre-commit hook (`scripts/gitleaks.mjs`) will re-run automatically.

### Do not use `--no-verify`

> **Git Safety Protocol:** never bypass commit hooks with `git commit --no-verify`
> (or `HUSKY=0`) to silence a gitleaks finding. That disables secret scanning for
> the entire commit and risks landing a real credential. Always add a scoped
> allowlist entry as shown above and keep the hook enabled.

See also: [`scripts/gitleaks.mjs`](../scripts/gitleaks.mjs) (binary download + invocation),
[`.gitleaks.toml`](../.gitleaks.toml) (rule definitions), and
[`docs/runbooks/leaked-secret.md`](../docs/runbooks/leaked-secret.md) (what to do if a real secret leaked).

---

## Bundle Size

If your PR touches `apps/web`, check the bundle budget locally before pushing. Run it from the
repo root, after a production build:

```bash
pnpm --filter @brandblitz/web build   # prerequisite: writes apps/web/.next/static/chunks
pnpm check:bundle                     # scripts/check-bundle-budget.mjs vs docs/perf/bundle-baseline.txt
```

The check prints `::warning::Bundle size regressed by more than 10%!` when the built chunks' total
gzip size is more than 10% over the committed baseline. It only warns and does not fail the
command.

**Troubleshooting:** [`docs/perf/README.md`](./docs/perf/README.md#troubleshooting-a-bundle-size-warning)
explains where `scripts/generate-bundle-report.mjs` sends its report (stdout, no file), what the
columns mean, and how to diff it against the baseline to find the chunk that grew. See also
[`apps/web/README.md` → Bundle size check](./apps/web/README.md#bundle-size-check).

---

## Getting Started

```bash
# 1. Fork and clone
git clone https://github.com/<your-fork>/brandblitz.git
cd brandblitz

# 2. Install dependencies
pnpm install

# 3. Copy and configure environment
cp .env.example .env
pnpm setup:secrets
# Auto-generates JWT_SECRET, NEXTAUTH_SECRET, WEBHOOK_SECRET, etc. — skips already-set values in existing .env.
# Fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
# STELLAR_HOT_WALLET_SECRET, and PHONE_HASH_SALT at minimum if not already set.

# 4. Start infrastructure
docker compose --profile infra up

# 4b. (Optional) Seed the database with fixture data — 50 users, 3 brands, 6 challenges, 200 sessions
pnpm --filter @brandblitz/api seed
# Re-run with --reset to wipe and re-seed from scratch:
# pnpm --filter @brandblitz/api seed -- --reset
# Or use SEED_DEV=1 to auto-seed on docker compose up (see docker-compose.override.yml)

# 4c. (Optional) Fully reset local Postgres — drop all data, reapply migrations, optionally re-seed:
#     pnpm db:reset               # wipe + re-migrate
#     pnpm db:reset -- --seed     # ...and re-seed fixtures

# 5. Start all apps (Turborepo parallel)
pnpm dev

# 6. Verify
curl http://localhost:3001/health     # {"status":"ok"}
open http://localhost:3000            # Next.js frontend

# 7. Run tests
pnpm test
pnpm type-check
pnpm lint
```

### Fast feedback while iterating (recommended)

For iterative work on a single package, use watch-mode type-checking instead of the full
monorepo `pnpm type-check`. It runs `tsc --watch --noEmit` in the selected workspace
and re-checks incrementally on every save:

```bash
# API only
pnpm type-check:watch --filter=@brandblitz/api

# Web only
pnpm type-check:watch --filter=@brandblitz/web
# Or directly in the workspace:
pnpm --filter @brandblitz/api type-check:watch
pnpm --filter @brandblitz/web type-check:watch
```

The root `type-check:watch` script is a convenience wrapper around `turbo run type-check:watch`
filtered with `--filter`; pass a different `--filter` value to scope to another workspace.
Each workspace exposes `type-check:watch` as `tsc --watch --noEmit` (see `apps/api/package.json`
and `apps/web/package.json`). The existing full `pnpm type-check` (`turbo run type-check`) is unchanged
and remains the CI gate — use the watch variant only for local iteration.

### Running tasks for a single package

Scope any `turbo.json` task (`build`, `dev`, `lint`, `test`, `type-check`) to one workspace
instead of running it across the whole monorepo.

| Workspace | Package name | Scripts |
|---|---|---|
| `apps/api` | `@brandblitz/api` | build, dev, lint, test, type-check |
| `apps/web` | `@brandblitz/web` | build, dev, lint, test, type-check |
| `apps/deposit-monitor` | `@brandblitz/deposit-monitor` | build, dev, lint, test, type-check |
| `packages/config` | `@brandblitz/config` | build, dev, type-check |
| `packages/stellar` | `@brandblitz/stellar` | build, dev, lint, test, type-check |
| `packages/storage` | `@brandblitz/storage` | build, dev, lint, test, type-check |

```bash
# turbo: honours turbo.json dependsOn (e.g. builds ^dependencies first) and caching
pnpm turbo run build --filter=@brandblitz/api
pnpm turbo run test --filter=@brandblitz/stellar
pnpm turbo run lint --filter=@brandblitz/web

# Include the package's workspace dependencies too
pnpm turbo run build --filter=@brandblitz/api...

# pnpm: runs the script directly in that workspace, no turbo pipeline
pnpm --filter @brandblitz/api build
pnpm --filter @brandblitz/storage test
pnpm --filter @brandblitz/deposit-monitor lint
```

A task a package doesn't define (e.g. `lint` in `@brandblitz/config`) is skipped by turbo
and errors under `pnpm --filter`.

### Common Issues

| Symptom | Fix |
|---|---|
| `Error: STELLAR_HOT_WALLET_SECRET required` | Set `STELLAR_HOT_WALLET_SECRET=SA...` in `.env`. Generate a testnet keypair with `stellar-cli keys generate`. |
| S3 uploads fail locally | Ensure MinIO is running (`docker compose up minio minio-setup`) and `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` match `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in `.env`. |
| `OZ_FACILITATOR_API_KEY required` | Required only for CareGuard services. Not needed for BrandBlitz. |
| PostgreSQL connection refused | Run `docker compose up postgres` and check `DATABASE_URL` points to `localhost:5432`. |
| `pnpm: command not found` | Install with `npm install -g pnpm@10.33.0`. |
| NextAuth `NEXTAUTH_SECRET` error | Set `NEXTAUTH_SECRET` (same value as `JWT_SECRET` is fine for local dev). |

For questions, open a GitHub Discussion or ask in the project Discord.
