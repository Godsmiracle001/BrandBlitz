# RFC 1264: Extract challenge scoring/warmup logic into a pure, framework-independent scoring engine

## Problem Statement

`apps/api/src/services/scoring.ts` (with a separate `scoring.warmup.test.ts` suite) currently sits alongside anti-cheat middleware and challenge routes, with scoring rules and warmup-period edge cases only reachable through the services layer's current shape. This makes it hard to reason about scoring logic in isolation or reuse it for offline recalculation (e.g., disputes, admin re-scoring). We need a pure scoring-engine module with explicit inputs/outputs and no DB or Express dependency.

## Current State

### Scoring.ts Structure

```
apps/api/src/services/scoring.ts
├── Constants
│   ├── BASE_POINTS (100)
│   ├── MAX_SPEED_BONUS (50)
│   ├── ROUND_DURATION_MS (15_000)
│   └── MAX_TOTAL_SCORE
├── Validation
│   ├── validateRoundScore()
│   └── validateTotalScore()
├── Business Rules
│   ├── scoring calculations (coupled via withTransaction)
│   └── warmup-period edge cases
└── DB/Service Layer Coupling
    └── withTransaction() — direct DB import
```

### Current Dependencies

- `db` module (PostgreSQL queries)
- `lib/usdc` (currency conversions)
- `db/queries/sessions` (GameSession type)
- `db/queries/challenges` (ChallengeQuestion type)

### Warmup Test Coverage

`scoring.warmup.test.ts` tests edge cases around warmup periods that must be preserved during extraction.

### Related Modules

- `middleware/anti-cheat.ts` — fraud detection, overlaps conceptually with scoring
- Routes that call scoring — need unchanged interface

## Proposed Architecture

### Pure Scoring Engine Module

Create `apps/api/src/services/scoring.engine.ts` with:

```typescript
// Pure input/output, no DB or Express dependency
export interface RoundEvent {
  questionId: string;
  answered: boolean;
  timeToAnswerMs: number;
  isSkipped: boolean;
}

export interface ScoringContext {
  roundDurationMs: number;
  basePoints: number;
  maxSpeedBonus: number;
  warmupPeriodMs?: number; // null = no warmup
  currentTime: Date;
  sessionStartTime: Date;
}

export interface RoundScore {
  raw: number;
  speedBonus: number;
  speedBonusPercentage: number;
  isWarmup: boolean;
}

export interface ChallengeScore {
  rounds: RoundScore[];
  total: number;
  maxPossible: number;
  isFullyWarmup: boolean;
}

// Pure function: no side effects, no DB calls
export function calculateRoundScore(
  event: RoundEvent,
  context: ScoringContext
): RoundScore {
  // Calculate speed bonus based on time to answer
  // Preserve warmup edge case logic from warmup.test.ts
}

// Pure function: aggregates round scores
export function calculateChallengeScore(
  rounds: RoundEvent[],
  context: ScoringContext
): ChallengeScore {
  // Validates total doesn't exceed MAX_TOTAL_SCORE
  // Handles warmup period (no score earned within warmup window)
}

// Pure validation
export function validateScoringContext(ctx: ScoringContext): ValidationError | null {
  // Validate all scoring rules
}
```

### Validation Functions (Pure)

- `validateRoundScore()` — unchanged
- `validateTotalScore()` — unchanged
- `validateScoringContext()` — new, validates inputs before scoring

### Service Layer Wrapper

Keep `apps/api/src/services/scoring.ts` as a thin adapter:

```typescript
import { calculateChallengeScore, calculateRoundScore } from "./scoring.engine";

// Wraps pure engine, handles DB/session layer
export async function calculateScoreForSession(
  sessionId: string
): Promise<ChallengeScore> {
  const session = await getSession(sessionId);
  const events = await getRoundEventsForSession(sessionId);
  
  const context: ScoringContext = {
    roundDurationMs: ROUND_DURATION_MS,
    basePoints: BASE_POINTS,
    maxSpeedBonus: MAX_SPEED_BONUS,
    warmupPeriodMs: session.challenge.warmupPeriodMs,
    currentTime: new Date(),
    sessionStartTime: session.startedAt,
  };
  
  return calculateChallengeScore(events, context);
}
```

### Integration Points

#### Challenge Routes
- Continue calling `services/scoring.ts` public API (unchanged)
- No changes needed to route handlers

#### Batch Re-scoring Tool
- Calls pure `scoring.engine` directly
- Loads round events from DB, builds context, calls engine
- Example: admin dispute resolution, result auditing

```typescript
// Hypothetical admin tool
async function rescorerChallenge(sessionId: string) {
  const session = await getSession(sessionId);
  const events = await getRoundEventsForSession(sessionId);
  
  const context: ScoringContext = {
    // ... build context
  };
  
  const newScore = calculateChallengeScore(events, context);
  return newScore; // No DB write yet; admin reviews then decides
}
```

#### Anti-Cheat Overlap
- Fraud detection (anti-cheat) remains in middleware
- Scoring engine does NOT handle fraud; that's a separate check
- Fraud → session marked invalid; scoring not called

## Test Migration Plan

### Unit Tests (Pure Engine)

Move all logic tests from `scoring.warmup.test.ts` to `scoring.engine.unit.test.ts`:

```typescript
// apps/api/src/services/scoring.engine.unit.test.ts
describe("calculateRoundScore", () => {
  it("applies speed bonus for fast correct answers", () => {
    const event: RoundEvent = {
      answered: true,
      timeToAnswerMs: 1000,
      isSkipped: false,
    };
    const context: ScoringContext = { /* ... */ };
    
    const score = calculateRoundScore(event, context);
    expect(score.raw).toBe(BASE_POINTS);
    expect(score.speedBonus).toBeGreaterThan(0);
  });

  it("handles warmup period (no score earned)", () => {
    // Existing warmup.test.ts logic moves here
    const event: RoundEvent = { /* answered during warmup */ };
    const context: ScoringContext = {
      warmupPeriodMs: 60000,
      currentTime: new Date(sessionStart.getTime() + 30000), // 30s in
    };
    
    const score = calculateRoundScore(event, context);
    expect(score.isWarmup).toBe(true);
  });
});

describe("calculateChallengeScore", () => {
  it("sums round scores without exceeding max", () => {
    const rounds: RoundEvent[] = [ /* ... */ ];
    const context: ScoringContext = { /* ... */ };
    
    const total = calculateChallengeScore(rounds, context);
    expect(total.total).toBeLessThanOrEqual(total.maxPossible);
  });
});
```

### Integration Tests (Service Layer)

Keep `scoring.test.ts` for service-layer integration:

```typescript
// apps/api/src/services/scoring.integration.test.ts
describe("calculateScoreForSession (service layer)", () => {
  it("loads session, fetches events, calculates score", async () => {
    // Create real session in DB
    // Insert round events
    // Call service
    // Verify DB state unchanged (pure calculation)
  });
});
```

### Migration Steps

1. Extract pure engine logic → `scoring.engine.ts`
2. Write unit tests → `scoring.engine.unit.test.ts` (copy warmup.test.ts logic)
3. Update service wrapper → `scoring.ts` calls engine
4. Refactor existing tests → migrate warmup.test.ts to unit tests
5. Delete warmup.test.ts (coverage moved to scoring.engine.unit.test.ts)

## Benefits

1. **Reusability**: Admin tools, dispute resolution, offline recalculation all call same engine
2. **Testability**: Pure functions; no DB mocking needed for business logic
3. **Clarity**: Scoring rules are explicit; no Express/DB coupling to reason about
4. **Warmup preservation**: All warmup edge cases stay in tests; coverage unaffected
5. **Maintenance**: Changes to scoring math don't require DB changes

## Open Questions

1. Should anti-cheat logic (currently in middleware) also move into scoring engine, or stay separate?
2. For dispute resolution, should re-scoring produce an audit log entry?
3. Should scoring context include challenge metadata (e.g., difficulty modifier), or stay round-event-only?

## References

- Current files:
  - `apps/api/src/services/scoring.ts`
  - `apps/api/src/services/scoring.warmup.test.ts`
  - `apps/api/src/middleware/anti-cheat.ts`
- Related RFCs: #1263 (test naming), #1266 (web API), #1267 (referral processor)
