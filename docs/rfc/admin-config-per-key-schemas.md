# RFC: Replace Admin Config Discriminated Union with Per-Key Schema Modules

**Status:** Proposed  
**Author:** Engineering Team  
**Created:** 2024  
**Issue:** #1251

## Problem Statement

The admin config validation in `apps/api/src/routes/admin/config.ts` uses a single large discriminated union covering unrelated config keys:

```typescript
const configUpdateSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("anti_cheat"),
    value: antiCheatConfigSchema,
  }),
  z.object({
    key: z.literal("league"),
    value: z.record(z.unknown()), // ⚠️ No validation!
  }),
  z.object({
    key: z.literal("payout"),
    value: z.record(z.unknown()), // ⚠️ No validation!
  }),
  z.object({
    key: z.literal("deposit_required_confirmations"),
    value: z.number(),
  }),
  z.object({
    key: z.literal("escrow_multisig_threshold"),
    value: z.number(),
  }),
]);
```

**Problems:**
1. **Unvalidated fallbacks** - `league` and `payout` accept any value (`z.record(z.unknown())`)
2. **Monolithic union** - Adding a new config key requires editing a 100+ line union
3. **Scattered schemas** - Some schemas are inline, some imported, no organization
4. **No type safety** - Can't get `ConfigValue<'league'>` type from union
5. **Silent failures** - Invalid config can be saved to database without error

This has led to production incidents where invalid configuration was accepted.

## Current State

### Discriminated Union Approach

**File:** `apps/api/src/routes/admin/config.ts`

```typescript
// Inline schema for anti_cheat (good)
const antiCheatConfigSchema = z.object({
  enabled: z.boolean(),
  vpn_detection: z.boolean(),
  max_accounts_per_ip: z.number().int().positive(),
  fingerprint_required: z.boolean(),
  device_fingerprint_weight: z.number().min(0).max(1),
});

// The monolithic union
const configUpdateSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("anti_cheat"),
    value: antiCheatConfigSchema,
  }),
  z.object({
    key: z.literal("league"),
    value: z.record(z.unknown()), // ⚠️ PROBLEM: No validation
  }),
  z.object({
    key: z.literal("payout"),
    value: z.record(z.unknown()), // ⚠️ PROBLEM: No validation
  }),
  z.object({
    key: z.literal("deposit_required_confirmations"),
    value: z.number().int().positive(),
  }),
  z.object({
    key: z.literal("escrow_multisig_threshold"),
    value: z.number().int().positive().max(10),
  }),
  z.object({
    key: z.literal("min_withdrawal_amount"),
    value: z.string().regex(/^\d+\.\d{2}$/),
  }),
  z.object({
    key: z.literal("max_withdrawal_amount"),
    value: z.string().regex(/^\d+\.\d{2}$/),
  }),
  z.object({
    key: z.literal("kyc_required"),
    value: z.boolean(),
  }),
  z.object({
    key: z.literal("kyc_threshold_usd"),
    value: z.number().positive(),
  }),
  z.object({
    key: z.literal("maintenance_mode"),
    value: z.boolean(),
  }),
  // ... 15+ more entries
]);

// Route handler
app.post("/admin/config", async (req, res) => {
  const { key, value } = configUpdateSchema.parse(req.body);
  await setConfig(key, value);
  res.json({ success: true });
});
```

### Keys Using Unvalidated Fallback

1. **`league`** - Should validate:
   ```typescript
   {
     entry_fee: string; // "10.00" format
     prize_distribution: number[]; // [50, 30, 20]
     max_participants: number;
     min_participants: number;
     duration_hours: number;
     start_time?: string; // ISO 8601
   }
   ```

2. **`payout`** - Should validate:
   ```typescript
   {
     min_threshold: string; // "5.00" format
     processing_fee_percent: number; // 0-100
     batch_size: number;
     retry_attempts: number;
     retry_delay_ms: number;
   }
   ```

### Why This Happened

**Historical Context:**
- Initial config system had 3-4 keys (well-defined)
- `league` and `payout` were added during a sprint with "temp" schemas
- Tech debt ticket to add real schemas was never prioritized
- Pattern became normalized: "just use `z.record(z.unknown())`"

**Current Impact:**
- Production incident (2024-01): Invalid `league.entry_fee` accepted ("not-a-number")
- Support burden: Invalid config causes runtime errors, not validation errors
- Development friction: Can't trust TypeScript types for these configs

## Proposal

### Per-Key Schema Module Pattern

**Directory Structure:**
```
apps/api/src/config-schemas/
├── index.ts                    # Registry and exports
├── anti-cheat.schema.ts
├── league.schema.ts            # NEW: Replace z.record(z.unknown())
├── payout.schema.ts            # NEW: Replace z.record(z.unknown())
├── deposit.schema.ts
├── escrow.schema.ts
├── kyc.schema.ts
├── maintenance.schema.ts
└── withdrawal.schema.ts
```

**Individual Schema Module:**
```typescript
// apps/api/src/config-schemas/league.schema.ts
import { z } from 'zod';

/**
 * Configuration for league behavior
 */
export const leagueConfigSchema = z.object({
  /**
   * Entry fee in USD (e.g., "10.00")
   */
  entry_fee: z.string().regex(/^\d+\.\d{2}$/, {
    message: "Entry fee must be in format '0.00'",
  }),
  
  /**
   * Prize distribution percentages (must sum to 100)
   */
  prize_distribution: z
    .array(z.number().int().min(0).max(100))
    .min(1)
    .refine(
      (arr) => arr.reduce((sum, val) => sum + val, 0) === 100,
      { message: "Prize distribution must sum to 100" }
    ),
  
  /**
   * Maximum number of participants
   */
  max_participants: z.number().int().positive().max(10000),
  
  /**
   * Minimum number of participants to start
   */
  min_participants: z.number().int().positive().max(1000),
  
  /**
   * League duration in hours
   */
  duration_hours: z.number().int().positive().max(168), // Max 1 week
  
  /**
   * Optional start time (ISO 8601)
   */
  start_time: z.string().datetime().optional(),
}).strict(); // Reject unknown keys

export type LeagueConfig = z.infer<typeof leagueConfigSchema>;

// Example valid values for tests
export const LEAGUE_CONFIG_EXAMPLES = {
  default: {
    entry_fee: "10.00",
    prize_distribution: [50, 30, 20],
    max_participants: 100,
    min_participants: 10,
    duration_hours: 24,
  },
  tournament: {
    entry_fee: "50.00",
    prize_distribution: [60, 25, 10, 5],
    max_participants: 500,
    min_participants: 50,
    duration_hours: 72,
    start_time: "2024-12-01T00:00:00Z",
  },
} as const satisfies Record<string, LeagueConfig>;
```

**Registry (Index File):**
```typescript
// apps/api/src/config-schemas/index.ts
import { z } from 'zod';
import { antiCheatConfigSchema } from './anti-cheat.schema';
import { leagueConfigSchema } from './league.schema';
import { payoutConfigSchema } from './payout.schema';
import { depositConfigSchema } from './deposit.schema';
import { escrowConfigSchema } from './escrow.schema';
import { kycConfigSchema } from './kyc.schema';
import { maintenanceConfigSchema } from './maintenance.schema';
import { withdrawalConfigSchema } from './withdrawal.schema';

/**
 * Registry of all config schemas
 * Add new config keys here
 */
export const CONFIG_SCHEMAS = {
  anti_cheat: antiCheatConfigSchema,
  league: leagueConfigSchema,
  payout: payoutConfigSchema,
  deposit_required_confirmations: depositConfigSchema,
  escrow_multisig_threshold: escrowConfigSchema,
  kyc_required: kycConfigSchema.shape.kyc_required,
  kyc_threshold_usd: kycConfigSchema.shape.kyc_threshold_usd,
  maintenance_mode: maintenanceConfigSchema,
  min_withdrawal_amount: withdrawalConfigSchema.shape.min_amount,
  max_withdrawal_amount: withdrawalConfigSchema.shape.max_amount,
} as const;

// Type-safe config key
export type ConfigKey = keyof typeof CONFIG_SCHEMAS;

// Get the schema for a specific key
export function getConfigSchema<K extends ConfigKey>(key: K): typeof CONFIG_SCHEMAS[K] {
  return CONFIG_SCHEMAS[key];
}

// Get the inferred type for a config key
export type ConfigValue<K extends ConfigKey> = z.infer<typeof CONFIG_SCHEMAS[K]>;

// Validate a config value
export function validateConfig<K extends ConfigKey>(
  key: K,
  value: unknown
): ConfigValue<K> {
  const schema = CONFIG_SCHEMAS[key];
  return schema.parse(value);
}

// Check if a key is valid
export function isValidConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_SCHEMAS;
}

// Get all config keys
export const ALL_CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

// Export all schemas for direct use
export * from './anti-cheat.schema';
export * from './league.schema';
export * from './payout.schema';
export * from './deposit.schema';
export * from './escrow.schema';
export * from './kyc.schema';
export * from './maintenance.schema';
export * from './withdrawal.schema';
```

**Updated Route Handler:**
```typescript
// apps/api/src/routes/admin/config.ts
import { validateConfig, isValidConfigKey, type ConfigKey } from '@/config-schemas';

// Simple request schema (no discriminated union)
const configUpdateRequestSchema = z.object({
  key: z.string(),
  value: z.unknown(), // Validated by per-key schema
});

app.post("/admin/config", async (req, res) => {
  const { key, value } = configUpdateRequestSchema.parse(req.body);
  
  // Type-safe validation
  if (!isValidConfigKey(key)) {
    return res.status(400).json({
      error: "Invalid config key",
      validKeys: ALL_CONFIG_KEYS,
    });
  }
  
  try {
    // Validate with key-specific schema
    const validatedValue = validateConfig(key, value);
    
    // Save to database
    await setConfig(key, validatedValue);
    
    res.json({
      success: true,
      key,
      value: validatedValue,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        details: error.errors,
      });
    }
    throw error;
  }
});

// Type-safe GET endpoint
app.get<{ key: ConfigKey }>("/admin/config/:key", async (req, res) => {
  const { key } = req.params;
  
  if (!isValidConfigKey(key)) {
    return res.status(404).json({ error: "Config key not found" });
  }
  
  const value = await getConfig(key);
  
  // value has type ConfigValue<typeof key> - fully type-safe!
  res.json({ key, value });
});
```

## Benefits

### 1. Type Safety

**Before:**
```typescript
const config = await getConfig("league");
// config: any (no type information)
```

**After:**
```typescript
const config = await getConfig("league");
// config: LeagueConfig (fully typed)
// TypeScript knows: config.entry_fee, config.prize_distribution, etc.
```

### 2. Adding New Config Keys

**Before (Discriminated Union):**
```typescript
// Must edit 100+ line union in routes/admin/config.ts
const configUpdateSchema = z.discriminatedUnion("key", [
  // ... existing 20+ entries
  z.object({
    key: z.literal("new_feature"),
    value: z.record(z.unknown()), // ⚠️ Tempting to use fallback
  }),
]);
```

**After (Registry):**
```typescript
// 1. Create new schema file
// apps/api/src/config-schemas/new-feature.schema.ts
export const newFeatureSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number(),
});

// 2. Add to registry
// apps/api/src/config-schemas/index.ts
export const CONFIG_SCHEMAS = {
  // ... existing
  new_feature: newFeatureSchema, // ✅ One line
};
```

### 3. Validation Errors

**Before:**
```typescript
// Invalid value silently accepted
await setConfig("league", { entry_fee: "not-a-number" }); // ✅ Succeeds
// Runtime error later when reading config
```

**After:**
```typescript
// Validation error at write time
await setConfig("league", { entry_fee: "not-a-number" });
// ❌ ZodError: entry_fee must be in format '0.00'
```

### 4. Self-Documenting

**Before:**
```typescript
// What fields does league config have? 🤷
// Need to check database or ask someone
```

**After:**
```typescript
// JSDoc + TypeScript = self-documenting
import { type LeagueConfig } from '@/config-schemas';
// Hover over LeagueConfig to see all fields with descriptions
```

## Migration Plan

### Phase 1: Create Schema Infrastructure (Week 1)

**Tasks:**
- [ ] Create `apps/api/src/config-schemas/` directory
- [ ] Create `index.ts` registry
- [ ] Write helper functions (`validateConfig`, `isValidConfigKey`)
- [ ] Add comprehensive tests for registry

**Deliverable:** Schema infrastructure ready

### Phase 2: Create Missing Schemas (Week 1-2)

**Priority 1: Close Validation Gaps**
- [ ] `league.schema.ts` - Currently uses `z.record(z.unknown())`
- [ ] `payout.schema.ts` - Currently uses `z.record(z.unknown())`

**Priority 2: Migrate Inline Schemas**
- [ ] `anti-cheat.schema.ts` - Extract from route file
- [ ] `kyc.schema.ts` - Extract from route file
- [ ] `withdrawal.schema.ts` - Extract from route file
- [ ] `deposit.schema.ts` - Extract from route file
- [ ] `escrow.schema.ts` - Extract from route file
- [ ] `maintenance.schema.ts` - Extract from route file

**For Each Schema:**
1. Create schema file with JSDoc
2. Add example valid values for tests
3. Write unit tests
4. Add to registry

**Deliverable:** All config keys have real schemas

### Phase 3: Update Route Handlers (Week 2)

**Tasks:**
- [ ] Replace discriminated union with registry lookup
- [ ] Update POST `/admin/config` endpoint
- [ ] Update GET `/admin/config/:key` endpoint
- [ ] Update GET `/admin/config` (list all) endpoint
- [ ] Add integration tests

**Deliverable:** Routes use per-key schemas

### Phase 4: Update Database Queries (Week 2)

**Tasks:**
- [ ] Update `apps/api/src/db/queries/config.ts`
- [ ] Use `validateConfig()` before writing to DB
- [ ] Add validation to read path (optional defense)
- [ ] Migrate existing invalid data (if any)

**Deliverable:** Database layer validated

### Phase 5: Update Admin UI (Week 3)

**Tasks:**
- [ ] Update web admin panel to show schema-driven forms
- [ ] Generate form fields from Zod schemas
- [ ] Show validation errors inline
- [ ] Add example values in UI

**Deliverable:** Admin UI schema-aware

### Phase 6: Cleanup (Week 3)

**Tasks:**
- [ ] Remove old discriminated union code
- [ ] Update documentation
- [ ] Add linting rule preventing `z.record(z.unknown())`
- [ ] Archive migration notes

**Deliverable:** Migration complete

## Schema Examples

### Complete League Schema

```typescript
// apps/api/src/config-schemas/league.schema.ts
import { z } from 'zod';

export const leagueConfigSchema = z.object({
  entry_fee: z.string().regex(/^\d+\.\d{2}$/, {
    message: "Entry fee must be in format '0.00'",
  }),
  
  prize_distribution: z
    .array(z.number().int().min(0).max(100))
    .min(1)
    .max(10)
    .refine(
      (arr) => arr.reduce((sum, val) => sum + val, 0) === 100,
      { message: "Prize distribution must sum to 100" }
    ),
  
  max_participants: z.number().int().positive().max(10000),
  
  min_participants: z.number().int().positive().max(1000)
    .refine(
      function(val) {
        // Access sibling field via 'this' in refine context
        return val <= (this as any).parent?.max_participants;
      },
      { message: "min_participants must be <= max_participants" }
    ),
  
  duration_hours: z.number().int().positive().max(168),
  
  start_time: z.string().datetime().optional(),
  
  auto_start: z.boolean().default(true),
  
  entry_fee_distribution: z.object({
    prize_pool_percent: z.number().min(0).max(100),
    platform_fee_percent: z.number().min(0).max(100),
    creator_reward_percent: z.number().min(0).max(100),
  }).refine(
    (obj) => 
      obj.prize_pool_percent + 
      obj.platform_fee_percent + 
      obj.creator_reward_percent === 100,
    { message: "Entry fee distribution must sum to 100%" }
  ).default({
    prize_pool_percent: 85,
    platform_fee_percent: 10,
    creator_reward_percent: 5,
  }),
}).strict();

export type LeagueConfig = z.infer<typeof leagueConfigSchema>;
```

### Complete Payout Schema

```typescript
// apps/api/src/config-schemas/payout.schema.ts
import { z } from 'zod';

export const payoutConfigSchema = z.object({
  min_threshold: z.string().regex(/^\d+\.\d{2}$/, {
    message: "Min threshold must be in format '0.00'",
  }),
  
  processing_fee_percent: z.number().min(0).max(100),
  
  batch_size: z.number().int().positive().max(1000),
  
  retry_attempts: z.number().int().min(0).max(10),
  
  retry_delay_ms: z.number().int().positive().max(3600000), // Max 1 hour
  
  daily_limit_usd: z.number().positive().optional(),
  
  require_kyc_above_usd: z.number().positive().optional(),
  
  auto_process: z.boolean().default(true),
  
  processing_window: z.object({
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(0).max(23),
    timezone: z.string().default('UTC'),
  }).optional(),
}).strict();

export type PayoutConfig = z.infer<typeof payoutConfigSchema>;
```

## Testing Strategy

### Unit Tests (Per Schema)

```typescript
// apps/api/src/config-schemas/__tests__/league.schema.test.ts
import { leagueConfigSchema, LEAGUE_CONFIG_EXAMPLES } from '../league.schema';

describe('leagueConfigSchema', () => {
  it('accepts valid default config', () => {
    expect(() => 
      leagueConfigSchema.parse(LEAGUE_CONFIG_EXAMPLES.default)
    ).not.toThrow();
  });
  
  it('rejects invalid entry_fee format', () => {
    expect(() => 
      leagueConfigSchema.parse({
        ...LEAGUE_CONFIG_EXAMPLES.default,
        entry_fee: "10", // Missing decimal places
      })
    ).toThrow('Entry fee must be in format');
  });
  
  it('rejects prize_distribution not summing to 100', () => {
    expect(() => 
      leagueConfigSchema.parse({
        ...LEAGUE_CONFIG_EXAMPLES.default,
        prize_distribution: [50, 30, 15], // Sums to 95
      })
    ).toThrow('must sum to 100');
  });
  
  it('rejects min_participants > max_participants', () => {
    expect(() => 
      leagueConfigSchema.parse({
        ...LEAGUE_CONFIG_EXAMPLES.default,
        min_participants: 200,
        max_participants: 100,
      })
    ).toThrow('min_participants must be <= max_participants');
  });
});
```

### Integration Tests (Registry)

```typescript
// apps/api/src/config-schemas/__tests__/index.test.ts
import { validateConfig, isValidConfigKey, ALL_CONFIG_KEYS } from '../index';

describe('Config Schema Registry', () => {
  it('validates all config keys', () => {
    expect(ALL_CONFIG_KEYS.length).toBeGreaterThan(0);
    ALL_CONFIG_KEYS.forEach(key => {
      expect(isValidConfigKey(key)).toBe(true);
    });
  });
  
  it('rejects invalid config keys', () => {
    expect(isValidConfigKey('nonexistent')).toBe(false);
  });
  
  it('validates league config', () => {
    const validConfig = {
      entry_fee: "10.00",
      prize_distribution: [50, 30, 20],
      max_participants: 100,
      min_participants: 10,
      duration_hours: 24,
    };
    
    expect(() => 
      validateConfig('league', validConfig)
    ).not.toThrow();
  });
  
  it('provides type-safe error messages', () => {
    try {
      validateConfig('league', { entry_fee: "invalid" });
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect(error.errors[0].path).toContain('entry_fee');
    }
  });
});
```

## Success Metrics

**Validation Coverage:**
- ✅ 0 config keys use `z.record(z.unknown())`
- ✅ 100% of config keys have explicit schemas
- ✅ All schemas have JSDoc documentation
- ✅ All schemas have example valid values

**Code Quality:**
- ✅ No monolithic union (removed discriminated union)
- ✅ Each config key has own module (<200 lines)
- ✅ Registry provides type-safe access
- ✅ Adding new key takes <50 lines of code

**Production Safety:**
- ✅ Invalid config rejected at write time, not runtime
- ✅ Zero production incidents from invalid config (6 months post-migration)
- ✅ Admin UI shows validation errors before submission
- ✅ Database contains only valid config values

## References

- Issue #1251
- `apps/api/src/routes/admin/config.ts` - Current discriminated union
- `apps/api/src/db/queries/config.ts` - Config storage
- [Zod Documentation](https://zod.dev/)

## Approval

- [ ] Backend Team Review
- [ ] Security Review (config validation)
- [ ] Product Review (admin UX)
- [ ] QA Review (test strategy)
