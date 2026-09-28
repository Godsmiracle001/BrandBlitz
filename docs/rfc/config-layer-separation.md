# RFC: Formally Separate Process-Env Configuration from DB-Backed Runtime Configuration

**Status:** Proposed  
**Author:** Engineering Team  
**Created:** 2024  
**Issue:** #1252

## Problem Statement

BrandBlitz has two distinct configuration systems that look similar but serve different purposes:

1. **Environment-based boot-time config** (`apps/api/src/lib/config.ts`, `config-schema.ts`)
2. **DB-backed runtime-tunable config** (`apps/api/src/db/queries/config.ts`, `routes/admin/config.ts`)

There is no documented boundary for which settings belong where, leading to:
- New settings being added to the wrong layer
- Confusion about which config system to use
- Similar naming causing import errors
- Unclear ownership of configuration validation

## Current State

### System 1: Environment-Based Boot-Time Config

**Location:** `apps/api/src/lib/config.ts`, `config-schema.ts`

**Purpose:** Process-level configuration that must be set before the application starts.

**Characteristics:**
- Loaded from environment variables
- Validated at boot time using Zod schemas
- Application fails to start if invalid
- Cannot be changed without restarting the service
- Type-safe access via `getConfig()`

**Example Settings:**
```typescript
{
  port: 3000,
  database: {
    host: "localhost",
    port: 5432,
    name: "brandblitz",
    user: "admin",
    password: "secret"
  },
  redis: {
    host: "localhost",
    port: 6379
  },
  stellar: {
    networkPassphrase: "Test SDF Network",
    horizonUrl: "https://horizon-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org"
  },
  jwt: {
    secret: "jwt-secret-key",
    expiresIn: "7d"
  }
}
```

**Validation:**
```typescript
const configSchema = z.object({
  port: z.coerce.number().int().positive(),
  database: z.object({
    host: z.string(),
    port: z.coerce.number().int().positive(),
    // ...
  }),
  // ...
});
```

### System 2: DB-Backed Runtime Config

**Location:** `apps/api/src/db/queries/config.ts`, `routes/admin/config.ts`

**Purpose:** Application behavior configuration that can be changed at runtime by administrators.

**Characteristics:**
- Stored in PostgreSQL database
- Can be changed via admin API without restart
- May have per-user or per-league overrides
- Values cached in Redis for performance
- Partial validation (some keys use `z.record(z.unknown())`)

**Example Settings:**
```typescript
{
  anti_cheat: {
    enabled: true,
    vpn_detection: true,
    max_accounts_per_ip: 3,
    fingerprint_required: true
  },
  league: {
    entry_fee: "10.00",
    prize_distribution: [50, 30, 20],
    max_participants: 100
  },
  payout: {
    min_threshold: "5.00",
    processing_fee_percent: 2.5,
    batch_size: 100
  },
  deposit_required_confirmations: 1,
  escrow_multisig_threshold: 2
}
```

**Validation (Current):**
```typescript
// Discriminated union with unvalidated fallbacks
const configUpdateSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("anti_cheat"),
    value: antiCheatConfigSchema,
  }),
  z.object({
    key: z.literal("league"),
    value: z.record(z.unknown()), // ⚠️ Not validated
  }),
  z.object({
    key: z.literal("payout"),
    value: z.record(z.unknown()), // ⚠️ Not validated
  }),
  // ...
]);
```

### Problem Areas

**Similar Names, Different Systems:**
- `config.ts` exists in both `lib/` and `db/queries/`
- `config-schema.ts` vs config validation in `routes/admin/config.ts`
- Imports frequently target the wrong file

**No Decision Boundary:**
- Should `MAX_FILE_UPLOAD_SIZE` be env or DB config?
- Should `STELLAR_NETWORK` be tunable at runtime?
- No documented rule for making this choice

**Conflated Admin Surface:**
- `routes/admin/config.ts` mixes both concepts
- Admin UI doesn't clarify which settings require restart

**Validation Gaps:**
- Several DB-backed configs use `z.record(z.unknown())`
- No enforcement of required fields
- Runtime changes can introduce invalid state

## Proposal

### 1. Decision Rule: Where Settings Belong

**Use Environment-Based Config When:**
- ✅ Value is required to start the application (database URL, port)
- ✅ Value is infrastructure-specific (hostnames, credentials)
- ✅ Value rarely changes (once per deployment)
- ✅ Invalid value should prevent startup
- ✅ Value is security-sensitive (secrets, API keys)

**Examples:** Database connection, Redis URL, JWT secret, Stellar network, port numbers

**Use DB-Backed Config When:**
- ✅ Value controls business logic or game rules
- ✅ Value may need per-user or per-league overrides
- ✅ Value changes frequently without code deploy
- ✅ Admins need to tune value in real-time
- ✅ Value affects features, not infrastructure

**Examples:** Anti-cheat thresholds, league entry fees, payout rules, feature flags

### 2. Proposed Naming/Namespacing

**Environment Config (Rename):**
```typescript
// apps/api/src/lib/env-config.ts
export const envConfig = getEnvConfig();

// apps/api/src/lib/env-config-schema.ts
export const envConfigSchema = z.object({...});

// Usage
import { envConfig } from '@/lib/env-config';
console.log(envConfig.database.host);
```

**DB-Backed Config (Rename):**
```typescript
// apps/api/src/db/queries/runtime-config.ts
export async function getRuntimeConfig(key: string) {...}
export async function setRuntimeConfig(key: string, value: unknown) {...}

// apps/api/src/routes/admin/runtime-config.ts
// Admin API for runtime-tunable settings

// Usage
import { getRuntimeConfig } from '@/db/queries/runtime-config';
const antiCheat = await getRuntimeConfig('anti_cheat');
```

**Benefits:**
- Unambiguous naming: `envConfig` vs `runtimeConfig`
- No more accidental imports of wrong config
- Clear separation visible in module paths
- Easier to explain to new developers

### 3. Per-Key Schema Modules

**Current Problem:**
```typescript
// All schemas in one discriminated union
// New keys require editing a large union
// Easy to add keys with z.record(z.unknown())
const configUpdateSchema = z.discriminatedUnion("key", [
  // 20+ entries...
]);
```

**Proposed Registry Pattern:**
```typescript
// apps/api/src/config-schemas/anti-cheat.schema.ts
export const antiCheatSchema = z.object({
  enabled: z.boolean(),
  vpn_detection: z.boolean(),
  max_accounts_per_ip: z.number().int().positive(),
  fingerprint_required: z.boolean(),
});

// apps/api/src/config-schemas/league.schema.ts
export const leagueSchema = z.object({
  entry_fee: z.string().regex(/^\d+\.\d{2}$/),
  prize_distribution: z.array(z.number()).length(3),
  max_participants: z.number().int().positive(),
});

// apps/api/src/config-schemas/index.ts
export const CONFIG_SCHEMAS = {
  anti_cheat: antiCheatSchema,
  league: leagueSchema,
  payout: payoutSchema,
  deposit_required_confirmations: z.number().int().positive(),
  escrow_multisig_threshold: z.number().int().positive(),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;
export type ConfigValue<K extends ConfigKey> = z.infer<typeof CONFIG_SCHEMAS[K]>;

// apps/api/src/routes/admin/runtime-config.ts
import { CONFIG_SCHEMAS } from '@/config-schemas';

export async function updateConfig(key: ConfigKey, value: unknown) {
  const schema = CONFIG_SCHEMAS[key];
  const validated = schema.parse(value); // Type-safe!
  await setRuntimeConfig(key, validated);
}
```

**Benefits:**
- One file per config key (easier to review)
- No monolithic union to edit
- Type-safe access: `ConfigValue<'anti_cheat'>`
- Can't add unvalidated keys accidentally
- Clearer ownership per feature team

### 4. Migration Plan

**Phase 1: Audit Current Settings**
- [ ] List all environment variables in use
- [ ] List all DB-backed config keys in use
- [ ] Identify settings in wrong layer

**Phase 2: Close Validation Gaps**
- [ ] Create schema for `league` config (currently `z.record(z.unknown())`)
- [ ] Create schema for `payout` config (currently `z.record(z.unknown())`)
- [ ] Add tests verifying all runtime config keys have real schemas

**Phase 3: Rename Modules**
- [ ] Rename `lib/config.ts` → `lib/env-config.ts`
- [ ] Rename `db/queries/config.ts` → `db/queries/runtime-config.ts`
- [ ] Update all imports across codebase
- [ ] Run full test suite to catch breakages

**Phase 4: Extract Per-Key Schemas**
- [ ] Create `config-schemas/` directory
- [ ] Move each config key to its own schema file
- [ ] Build registry in `config-schemas/index.ts`
- [ ] Update admin routes to use registry
- [ ] Remove discriminated union

**Phase 5: Documentation**
- [ ] Update README with decision rule
- [ ] Document how to add new env config
- [ ] Document how to add new runtime config
- [ ] Add JSDoc comments to config functions

**Rollout:**
- One phase per PR to keep changes reviewable
- Tests must pass at each phase
- No breaking changes to API or behavior
- Backward compatibility during migration

### 5. Settings Potentially in Wrong Layer

**Should Move to Environment Config:**
- None identified (DB-backed configs are appropriately runtime-tunable)

**Should Move to DB-Backed Config:**
- `MAX_FILE_UPLOAD_SIZE` (currently env) - Could be tuned per deployment without restart
- `SESSION_TIMEOUT_MS` (currently hardcoded) - Should be admin-tunable

**Borderline Cases:**
- `STELLAR_NETWORK` - Infrastructure concern (env) but affects behavior (runtime)
  - **Decision:** Keep as env - changing networks requires data migration
- `REDIS_CACHE_TTL` - Performance tuning but infrastructure-related
  - **Decision:** Keep as env - cache behavior is infrastructure

## Implementation Checklist

- [ ] Write tests for current config behavior (baseline)
- [ ] Create decision flowchart for config layer choice
- [ ] Audit and document all existing config keys
- [ ] Create `league` and `payout` schemas
- [ ] Rename `config.ts` → `env-config.ts`
- [ ] Rename `config.ts` (queries) → `runtime-config.ts`
- [ ] Update all imports
- [ ] Create `config-schemas/` directory structure
- [ ] Migrate to per-key schema modules
- [ ] Build schema registry
- [ ] Update admin API routes
- [ ] Add JSDoc documentation
- [ ] Update developer guides
- [ ] Remove old discriminated union code

## Risks & Mitigations

**Risk:** Large refactor touches many files  
**Mitigation:** Phase by phase with tests passing at each step

**Risk:** Breaking admin API during migration  
**Mitigation:** Keep old endpoints working, deprecate gradually

**Risk:** Losing type safety during transition  
**Mitigation:** Use TypeScript strict mode, add runtime validation

**Risk:** Confusion during migration period  
**Mitigation:** Clear comments marking old vs new code

## Success Metrics

- ✅ Zero config keys with `z.record(z.unknown())`
- ✅ All imports use `env-config` or `runtime-config` (no bare `config`)
- ✅ New config keys added with <5 minute decision time
- ✅ New developers can add config without asking team
- ✅ Zero config-related bugs in production post-migration

## References

- Issue #1252
- `apps/api/src/lib/config.ts`
- `apps/api/src/db/queries/config.ts`
- `apps/api/src/routes/admin/config.ts`
- [Twelve-Factor App: Config](https://12factor.net/config)

## Approval

- [ ] Tech Lead Review
- [ ] Security Review (for secret handling)
- [ ] Product Review (for admin UX)
- [ ] DevOps Review (for deployment impact)
