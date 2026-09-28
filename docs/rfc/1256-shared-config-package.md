# RFC 1256: Share a common config-loading package between apps/api and apps/deposit-monitor instead of parallel implementations

## Problem Statement

`apps/api/src/lib/config.ts` (backed by `config-schema.ts`) and `apps/deposit-monitor/
src/config.ts` each parse environment variables with independent Zod schemas. Both
implement the same *pattern* — parse `process.env`, redact secrets before logging,
`process.exit(1)` with a formatted error list on validation failure — but as two
separate hand-written copies of that pattern, and their *variable sets* genuinely
overlap in places.

## Current State

### Actual overlap (verified against both schemas, not assumed)

| Env var | `apps/api` (`config-schema.ts`) | `apps/deposit-monitor` (`config.ts`) |
| --- | --- | --- |
| `REDIS_URL` | ✅ required | ✅ required |
| `STELLAR_NETWORK` | ✅ `testnet\|public`, default `testnet` | ✅ same enum + default |
| `HOT_WALLET_PUBLIC_KEY` | ✅ required | ✅ required |
| `WEBHOOK_SECRET` | ✅ required | ✅ required |
| `DATABASE_URL` | ✅ required | ❌ **not present** |
| `HOT_WALLET_SECRET` | ✅ required (api signs) | ❌ **not present** (monitor only reads chain state + signs webhooks, never a Stellar tx) |
| `STELLAR_RPC_URL` | not found in api's schema | optional, in monitor's |

**Correcting the issue's premise**: `DATABASE_URL` and `HOT_WALLET_SECRET` are *not*
actually shared today — `deposit-monitor`'s `index.ts` never touches Postgres directly
and never signs a Stellar transaction; it only polls Horizon for deposits and forwards
a signed HMAC webhook to the API (`apps/deposit-monitor/src/index.ts`'s
`signWebhookPayload`, using `WEBHOOK_SECRET` — a different secret from the wallet key).
The real shared subset is narrower and lower-risk than the issue describes: `REDIS_URL`,
`STELLAR_NETWORK`, `HOT_WALLET_PUBLIC_KEY` (the *public* key only — reading it doesn't
require the ability to sign), and `WEBHOOK_SECRET`.

### The aliasing already drifting inside `apps/api` alone

`apps/api/src/lib/config.ts`'s `loadConfig()` already juggles legacy env-var aliases
before validation:
```typescript
HOT_WALLET_SECRET: process.env.HOT_WALLET_SECRET ?? process.env.STELLAR_HOT_WALLET_SECRET,
S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY,
S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_KEY,
TWILIO_SERVICE_SID: process.env.TWILIO_SERVICE_SID ?? process.env.TWILIO_VERIFY_SERVICE_SID,
```
This is exactly the kind of drift a second, independently-written schema
(`deposit-monitor`'s) is at risk of reproducing for the variables the two apps share —
today `deposit-monitor` names its Redis/webhook/network vars identically to `api`'s,
but nothing enforces that stays true as either schema evolves independently.

### `packages/config` today

Currently hosts one unrelated concern — `PERMISSIONS_POLICY_HEADER`, a static string
built from a `DISABLED_PERMISSIONS` list, imported by both `apps/api` and `apps/web` so
the feature-policy list is defined once. This establishes the precedent (a small,
genuinely-shared constant living in `packages/config`) this RFC extends to environment
schemas.

## Proposed Solution

### Extend `packages/config` with a shared schema fragment, not a shared schema

Rather than one shared `Config` type both apps import wholesale (which would force
`deposit-monitor` to either provide dummy values for api-only vars like `DATABASE_URL`
or vice versa), export a composable Zod schema *fragment* covering only the verified
overlap:

```typescript
// packages/config/src/shared-env.ts
import { z } from "zod";

export const sharedEnvSchema = z.object({
  REDIS_URL: z.string().url(),
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  HOT_WALLET_PUBLIC_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;

// Shared secret-redaction helper, currently reimplemented in both apps' config.ts.
export function redactSecrets<T extends Record<string, unknown>>(
  parsed: T,
  secretKeys: ReadonlySet<keyof T>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    redacted[k] = secretKeys.has(k as keyof T) ? "[redacted]" : v;
  }
  return redacted;
}
```

Each app's own schema extends the shared fragment with its app-specific vars, using
Zod's `.merge()`:

```typescript
// apps/deposit-monitor/src/config.ts
import { sharedEnvSchema, redactSecrets } from "@brandblitz/config";

const configSchema = sharedEnvSchema.merge(z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  STELLAR_RPC_URL: z.string().url().optional(),
  API_URL: z.string().url(),
  DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"]).default("info"),
}));
```

```typescript
// apps/api/src/lib/config-schema.ts
import { sharedEnvSchema } from "@brandblitz/config";

export const configSchema = sharedEnvSchema.merge(z.object({
  DATABASE_URL: z.string().url(),
  HOT_WALLET_SECRET: z.string().min(1),
  // ...every other api-only var, unchanged
}));
```

Both apps validate `REDIS_URL`/`STELLAR_NETWORK`/`HOT_WALLET_PUBLIC_KEY`/
`WEBHOOK_SECRET` with the exact same rules by construction — a future edit to the
shared enum or a new required shared var is a one-file change instead of two schemas
that need remembering to update in lockstep.

## Migration Path — No Breaking Env-Var Rename

1. Add `sharedEnvSchema` and `redactSecrets` to `packages/config`, with no consumer yet.
2. Switch `apps/deposit-monitor/src/config.ts` to `.merge()` the shared fragment.
   Because the field names and validation rules are identical to what it already
   parses today, this is a type-level refactor with no runtime behavior change — no
   env var needs renaming in any deployment.
3. Switch `apps/api/src/lib/config-schema.ts` similarly. The existing legacy-alias
   juggling (`HOT_WALLET_SECRET ?? STELLAR_HOT_WALLET_SECRET`, etc.) stays exactly
   where it is in `config.ts`'s `loadConfig()` — it's api-only aliasing for api-only
   vars and isn't part of the shared fragment.
4. Both apps' `SECRET_KEYS`/secret-redaction lists switch to `redactSecrets()`.

No step requires an operator to rename or add an env var — the shared schema validates
the same variable names both apps already read.

## Benefits

1. `REDIS_URL`/`STELLAR_NETWORK`/`HOT_WALLET_PUBLIC_KEY`/`WEBHOOK_SECRET` validated
   identically in both apps by construction, not by two authors remembering to keep
   them in sync.
2. Secret-redaction logic (`redactSecrets`) de-duplicated instead of hand-copied.
3. A future third worker process (following the `deposit-monitor` precedent for
   #1249's proposed payout-worker) starts from the same shared fragment instead of a
   third independent copy.
4. Doesn't force an artificial shared schema onto vars that are genuinely app-specific
   (`DATABASE_URL`, `HOT_WALLET_SECRET` correctly stay api-only, matching the verified
   current reality that `deposit-monitor` doesn't use either).

## Open Questions

1. Should `HOT_WALLET_SECRET` (the *private* signing key, api-only today) join the
   shared fragment pre-emptively for #1249's proposed payout-worker, or wait until
   that RFC is actually adopted and a second consumer of the private key exists? This
   RFC defaults to waiting — adding it speculatively risks the shared fragment
   granting the deposit-monitor process an unused capability to read a signing secret
   it has no current need for.
2. `STELLAR_RPC_URL` exists in `deposit-monitor`'s schema but not `api`'s — is that a
   genuine current gap in `api` (does anything in `api` talk to Horizon/RPC directly
   and rely on an unvalidated env var), or intentionally out of scope for api today?
   Worth a quick check before finalizing which vars belong in the shared fragment vs
   staying app-specific.

## References

- Current files:
  - `apps/api/src/lib/config.ts`, `apps/api/src/lib/config-schema.ts`
  - `apps/deposit-monitor/src/config.ts`
  - `packages/config/src/index.ts` — existing shared package, currently hosts only
    `PERMISSIONS_POLICY_HEADER`
