# RFC 1263: Formalize the integration-test vs unit-test naming/boundary convention across apps/api

## Problem Statement

`apps/api/src` mixes `*.test.ts`, `*.unit.test.ts`, and `*.integration.test.ts` naming inconsistently across routes, services, and queues without a documented rule for when a suffix is required or what DB/Redis dependencies each tier is allowed to use. This makes it unclear which tests require external services and which are truly isolated, complicating CI configuration and local development.

## Current State

### Naming Inconsistencies

| File | Pattern | Actual Tier |
|------|---------|-------------|
| `brands.create.unit.test.ts` | explicit unit suffix | unit (no DB) |
| `brands.test.ts` | no suffix | integration (uses DB) |
| `payout.processor.test.ts` | no suffix | integration (uses BullMQ/Redis) |
| `scoring.warmup.test.ts` | no suffix | integration |
| `auth.test.ts` | no suffix | mixed (auth is stateless) |

### Problematic Patterns

1. **No suffix convention**: Most tests lack tier designation
2. **Mixed dependencies in no-suffix files**: Both unit and integration logic share test files
3. **Unclear fixture requirements**: Tests reference DB/Redis setup without clear documentation
4. **CI impact**: Cannot reliably split fast (unit) vs slow (integration) test runs

## Proposed Convention

### Test Tier Definitions

#### Unit Tests (`.unit.test.ts`)
- **Dependencies**: None (no DB, Redis, network, filesystem)
- **Speed**: < 100ms typically
- **Fixtures**: Pure functions, mocked/stubbed external dependencies
- **Scope**: Single function/module behavior, error cases, business logic
- **Examples**: `scoring.engine.unit.test.ts`, `fingerprint.unit.test.ts`

#### Integration Tests (`.integration.test.ts`)
- **Dependencies**: Database (PostgreSQL), Redis, file storage (S3/MinIO)
- **Speed**: 100ms-several seconds per test
- **Fixtures**: Real Docker services via docker-compose, fixtures loaded per-test
- **Scope**: Multi-layer workflows, queue processing, real DB constraints, external services
- **Examples**: `brands.deposit-info.integration.test.ts`, `session-timeout.integration.test.ts`

#### No Suffix (`.test.ts`) — Deprecated Path
- **Use only for**: Small, isolated tests that fit no tier (e.g. one-off middleware checks)
- **Phasing**: Gradually rename to explicit suffixes over time; no new `.test.ts` files

### Allowed Dependencies by Tier

| Dependency | Unit | Integration |
|------------|------|-------------|
| Database (PostgreSQL) | ❌ Mock/stub | ✅ Real DB |
| Redis/BullMQ | ❌ Mock/stub | ✅ Real Redis |
| File storage (S3/MinIO) | ❌ Mock/stub | ✅ Real S3/MinIO |
| External HTTP API | ❌ Mock/stub | ✅ Real (if testnet/sandbox) |
| Express middleware | ❌ Mock req/res | ✅ Real if part of route test |
| Zod schemas/validators | ✅ Direct call | ✅ Direct call |
| Pure utility functions | ✅ Direct call | ✅ Direct call |

## Implementation Guidance

### For New Tests

1. **Identify dependencies**: Does the test need DB, Redis, or S3?
   - No external dependencies → `.unit.test.ts`
   - Uses DB, Redis, or file storage → `.integration.test.ts`
2. **Choose file location**: Keep tests adjacent to source (or in `__tests__` for multiple suites)
3. **Use correct suffix**: File name must match tier
4. **Write fixtures**: Integration tests should use database fixtures; unit tests should mock

### For Existing Tests (Gradual Migration)

1. **Tier assessment**: Review what each test actually does
2. **Rename or split**: If a `.test.ts` file has both unit and integration tests:
   - Refactor integration logic into `.integration.test.ts`
   - Keep pure logic in `.unit.test.ts` (or new files)
3. **No breaking changes**: This is a gradual improvement; existing tests stay until refactored

### CI Configuration

#### Run Unit Tests Locally (Fast Feedback)

```bash
pnpm test --testPathPattern="\\.unit\\.test\\.ts$"
```

#### Run Integration Tests (Requires Docker Services)

```bash
docker compose up postgres redis minio
pnpm test --testPathPattern="\\.integration\\.test\\.ts$"
```

#### Full Suite (CI Only)

```bash
pnpm test  # runs both unit and integration
```

## Examples

### Unit Test Example

```typescript
// apps/api/src/lib/fingerprint.unit.test.ts
import { computeFingerprint } from "./fingerprint";

describe("computeFingerprint", () => {
  it("returns consistent hash for same input", () => {
    const fp1 = computeFingerprint("test-ua");
    const fp2 = computeFingerprint("test-ua");
    expect(fp1).toBe(fp2);
  });

  it("produces different hash for different input", () => {
    const fp1 = computeFingerprint("ua-1");
    const fp2 = computeFingerprint("ua-2");
    expect(fp1).not.toBe(fp2);
  });
});
```

### Integration Test Example

```typescript
// apps/api/src/routes/brands.create.integration.test.ts
import { pool } from "../../db";
import { insertBrand } from "../../db/queries/brands";

describe("POST /brands (create)", () => {
  beforeAll(async () => {
    await pool.query("BEGIN");
  });

  afterAll(async () => {
    await pool.query("ROLLBACK");
  });

  it("creates brand and stores in DB", async () => {
    const response = await request(app)
      .post("/brands")
      .send({ name: "Test Brand" });

    expect(response.status).toBe(201);

    const brand = await pool.query(
      "SELECT * FROM brands WHERE id = $1",
      [response.body.id]
    );
    expect(brand.rowCount).toBe(1);
  });
});
```

## Timeline

1. **Phase 1 (immediate)**: Document this convention in `CONTRIBUTING.md`
2. **Phase 2 (ongoing)**: For any new test file, use correct suffix
3. **Phase 3 (next 2-3 sprints)**: Audit and rename existing test files (no logic changes)
4. **Phase 4 (future)**: Update CI to split test runs by tier

## Open Questions for Discussion

1. Should `.test.ts` (no suffix) be rejected entirely by CI, or gradually phased out?
2. For route tests that have both unit-like and integration-like logic, should they be split into two files or kept together?
3. Should CI explicitly fail if a `.unit.test.ts` file tries to connect to the database?

## References

- Current test files: `apps/api/src/routes/**/*.{unit,integration,}test.ts`
- CONTRIBUTING.md: Will be updated with this convention
- Related: #1264 (scoring extraction), #1266 (web API client), #1267 (referral processor)
