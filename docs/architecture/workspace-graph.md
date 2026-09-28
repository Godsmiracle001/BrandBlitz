# Workspace Graph

Internal dependency graph for the BrandBlitz pnpm + Turborepo monorepo.
Verified against actual `package.json` `dependencies` (workspace:`*`) in each workspace
and against `pnpm-workspace.yaml` / `turbo.json` ordering.

## Workspaces

Declared in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml):

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Turborepo build ordering in [`turbo.json`](../../turbo.json):

```json
"build": { "dependsOn": ["^build"] }
```

This means a package build runs before any app that depends on it. The graph below
shows *which* apps depend on *which* packages.

## Internal `@brandblitz/*` dependencies

| Workspace | Internal dependencies (`@brandblitz/*`) | What it imports | Source |
|---|---|---|---|
| **`apps/api`** (`@brandblitz/api`) | `@brandblitz/config`, `@brandblitz/stellar`, `@brandblitz/storage` | Config constants (`PERMISSIONS_POLICY_HEADER`), Stellar SDK helpers (`payout`, `deposit`, `muxed accounts`), S3/MinIO storage + image optimisation | [`apps/api/package.json`](../../apps/api/package.json) |
| **`apps/web`** (`@brandblitz/web`) | `@brandblitz/config` | Shared config (Permissions-Policy header, etc.) | [`apps/web/package.json`](../../apps/web/package.json) |
| **`apps/deposit-monitor`** (`@brandblitz/deposit-monitor`) | `@brandblitz/stellar` | Stellar deposit detection (`getEvents`) via Soroban RPC | [`apps/deposit-monitor/package.json`](../../apps/deposit-monitor/package.json) |
| **`packages/stellar`** (`@brandblitz/stellar`) | *(none)* — leaf package | Exports Horizon/Soroban clients, payout, deposit, accounts, constants | [`packages/stellar/package.json`](../../packages/stellar/package.json) |
| **`packages/storage`** (`@brandblitz/storage`) | *(none)* — leaf package | S3 client + `sharp` WebP optimisation | [`packages/storage/package.json`](../../packages/storage/package.json) |
| **`packages/config`** (`@brandblitz/config`) | *(none)* — leaf package | Shared constants, no external package deps | [`packages/config/package.json`](../../packages/config/package.json) |

> **Verified 2026-09-23:** table generated manually against `apps/*/package.json` and
> `packages/*/package.json`; no other `@brandblitz/*` dependencies exist.

## Impact radius

```
packages/config  ─┬─→ apps/api
                  └─→ apps/web

packages/stellar ─┬─→ apps/api
                  └─→ apps/deposit-monitor   ← stellar changes affect both API and deposit-monitor

packages/storage ───→ apps/api
```

- **Changing `packages/stellar`** affects **`apps/api` and `apps/deposit-monitor` specifically.**
  Both workspaces import `@brandblitz/stellar` (`apps/api` for payouts + deposits,
  `apps/deposit-monitor` for deposit polling). Run `pnpm --filter @brandblitz/api test`
  and `pnpm --filter @brandblitz/deposit-monitor test` (or `turbo run test --filter=@brandblitz/stellar...`)
  to cover the impact radius. The downstream `^build` edge in `turbo.json` ensures
  `packages/stellar` builds before those apps in CI.

- **Changing `packages/storage`** affects only `apps/api`.

- **Changing `packages/config`** affects `apps/api` and `apps/web`.

## How to regenerate / verify

```bash
# List all internal deps
grep -R '"@brandblitz' apps/*/package.json packages/*/package.json

# Or via pnpm
pnpm ls --depth=Infinity | grep brandblitz

# Turbo dry-run shows the build order
pnpm turbo run build --dry-run
```

Update this file when adding a new workspace or a new `@brandblitz/*` dependency.
