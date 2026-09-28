# RFC 1267: Separate referral-bonus business rules from the BullMQ processor that executes them

## Problem Statement

`apps/api/src/queues/processors/referral-bonus.processor.ts` (126+ lines) mixes BullMQ job-handling concerns (retry counts, job data parsing) with referral-bonus eligibility and payout-amount business rules, alongside `services/referrals.ts`, making it unclear which module owns the actual business logic versus queue plumbing. We need to move eligibility/amount-calculation rules fully into `services/referrals.ts` with a narrow interface, leaving the processor as a thin adapter.

## Current State

### Processor Current Responsibilities

1. **Queue plumbing** (should stay):
   - Job parsing and validation
   - Retry/dead-letter queue logic
   - Worker concurrency and timeouts
   - Logging retry attempts

2. **Business logic** (should move):
   - Fraud session detection
   - Eligibility checks
   - Payout status transitions
   - Audit logging for skipped bonuses

### Code Organization Issue

```
referral-bonus.processor.ts (126+ lines)
├── processReferralBonusJob() [~80 lines]
│   ├── Fetch payout from DB
│   ├── Check if already processed
│   ├── Call isFraudSession() [from services/referrals.ts]
│   ├── Call auditReferralBonusSkipped() [from services/referrals.ts]
│   ├── Update status
│   └── Handle errors/retries
└── Worker setup & exports

services/referrals.ts
├── Core referral logic
├── isFraudSession()
├── auditReferralBonusSkipped()
└── [other referral utilities]
```

### Coupling Issues

1. **Unclear ownership**: Is referral eligibility owned by processor or service?
2. **Testing complexity**: Must mock BullMQ job to test business rules
3. **Reusability**: Referral logic can't be easily called from other contexts (admin tools, batch processes)
4. **Drift risk**: Service changes not reflected in processor interface

## Proposed Architecture

### Service Layer Interface

Expand `services/referrals.ts` with explicit business-logic functions:

```typescript
// apps/api/src/services/referrals.ts

export interface ReferralBonusContext {
  payout: ReferralPayout;
  session: GameSession | null;
}

export interface ReferralBonusEvaluation {
  eligible: boolean;
  reason: "FRAUD" | "ALREADY_PROCESSED" | "NOT_FOUND" | "ELIGIBLE";
  auditLogEntry?: {
    action: "referral_bonus_skipped" | "referral_bonus_eligible";
    reason: string;
  };
}

/**
 * Evaluate if a referral bonus payout is eligible.
 * Pure business logic: no side effects, no job handling.
 * 
 * @param context ReferralBonusContext containing payout and session
 * @returns Evaluation with eligibility decision and audit log
 */
export async function evaluateReferralBonusEligibility(
  context: ReferralBonusContext
): Promise<ReferralBonusEvaluation> {
  const { payout, session } = context;

  if (payout.status !== "pending") {
    return {
      eligible: false,
      reason: "ALREADY_PROCESSED",
      auditLogEntry: {
        action: "referral_bonus_skipped",
        reason: `Already processed with status: ${payout.status}`,
      },
    };
  }

  if (!session) {
    return {
      eligible: false,
      reason: "NOT_FOUND",
      auditLogEntry: {
        action: "referral_bonus_skipped",
        reason: "Referred session not found",
      },
    };
  }

  if (await isFraudSession(session.id)) {
    return {
      eligible: false,
      reason: "FRAUD",
      auditLogEntry: {
        action: "referral_bonus_skipped",
        reason: "Referral bonus skipped because session was flagged as fraud",
      },
    };
  }

  return {
    eligible: true,
    reason: "ELIGIBLE",
  };
}

/**
 * Execute the referral bonus payout (side effects).
 * Called only after eligibility is confirmed.
 * 
 * @param referralPayoutId ID of payout to execute
 * @throws on DB error
 */
export async function executeReferralBonus(
  referralPayoutId: string
): Promise<void> {
  // Submit to stellar queue, update status
  // Existing payout logic stays here
}

/**
 * Handle a referral bonus (evaluate, log, execute).
 * Orchestration: can be called from processor or admin tools.
 * 
 * @param referralPayoutId ID of payout
 */
export async function processReferralBonus(
  referralPayoutId: string
): Promise<{ processed: boolean; reason: string }> {
  const payout = await findReferralPayoutById(referralPayoutId);
  if (!payout) {
    return { processed: false, reason: "NOT_FOUND" };
  }

  const session = payout.challenge_id
    ? await getSession(payout.referred_id, payout.challenge_id)
    : null;

  const evaluation = await evaluateReferralBonusEligibility({
    payout,
    session,
  });

  if (evaluation.auditLogEntry) {
    await auditReferralBonusSkipped({
      payoutId: payout.id,
      ...evaluation.auditLogEntry,
    });
  }

  if (!evaluation.eligible) {
    return { processed: false, reason: evaluation.reason };
  }

  await executeReferralBonus(referralPayoutId);
  return { processed: true, reason: "EXECUTED" };
}
```

### Processor Layer (Thin Adapter)

Simplify `apps/api/src/queues/processors/referral-bonus.processor.ts`:

```typescript
import { Worker, type Job } from "bullmq";
import { config } from "../../lib/config";
import { logger } from "../../lib/logger";
import { referralBonusQueue } from "../referral-bonus.queue";
import { forwardToDlq } from "../dlq";
import { processReferralBonus } from "../../services/referrals";

const SHUTDOWN_TIMEOUT_MS = 30000;

export const referralBonusWorkerOptions = {
  concurrency: 2,
} as const;

/**
 * Process a referral bonus job.
 * Thin adapter: delegates business logic to services/referrals.ts.
 */
export async function processReferralBonusJob(
  job: Job<{ referralPayoutId: string }>
): Promise<void> {
  try {
    const { processed, reason } = await processReferralBonus(
      job.data.referralPayoutId
    );

    logger.info("Referral bonus processed", {
      referralPayoutId: job.data.referralPayoutId,
      processed,
      reason,
    });
  } catch (error) {
    logger.error("Failed to process referral bonus", {
      referralPayoutId: job.data.referralPayoutId,
      error,
      attempt: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });

    if (job.attemptsMade >= (job.opts.attempts || 3)) {
      await forwardToDlq(job, error);
    }

    throw error; // Let BullMQ handle retry
  }
}

export async function createReferralBonusWorker() {
  return new Worker(
    referralBonusQueue.name,
    processReferralBonusJob,
    {
      connection: config.redis,
      ...referralBonusWorkerOptions,
    }
  );
}
```

### Comparison

| Aspect | Before | After |
|--------|--------|-------|
| Processor lines | ~80 | ~30 |
| Business logic location | Processor | Service |
| Testability | Needs BullMQ mock | Pure function test |
| Reusability | Tightly coupled to queue | Callable from anywhere |
| Audit logging | Inline in processor | Centralized in service |

## Test Migration

### Service Layer Tests

```typescript
// apps/api/src/services/referrals.unit.test.ts
describe("evaluateReferralBonusEligibility", () => {
  it("marks as eligible when conditions are met", async () => {
    const payout: ReferralPayout = {
      id: "rp-123",
      status: "pending",
      referred_id: "user-456",
      challenge_id: "ch-789",
    };
    const session: GameSession = { id: "sess-000" };

    jest.spyOn(referralsService, "isFraudSession").mockResolvedValue(false);

    const result = await evaluateReferralBonusEligibility({
      payout,
      session,
    });

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("ELIGIBLE");
  });

  it("marks as fraud when session is flagged", async () => {
    const payout: ReferralPayout = { status: "pending" };
    const session: GameSession = { id: "sess-fraud" };

    jest.spyOn(referralsService, "isFraudSession").mockResolvedValue(true);

    const result = await evaluateReferralBonusEligibility({
      payout,
      session,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("FRAUD");
    expect(result.auditLogEntry).toBeDefined();
  });
});
```

### Processor Tests

```typescript
// apps/api/src/queues/processors/referral-bonus.processor.test.ts
describe("processReferralBonusJob", () => {
  it("calls service and handles success", async () => {
    const job = {
      data: { referralPayoutId: "rp-123" },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as Job;

    jest.spyOn(referralsService, "processReferralBonus").mockResolvedValue({
      processed: true,
      reason: "EXECUTED",
    });

    await processReferralBonusJob(job);
    
    expect(referralsService.processReferralBonus).toHaveBeenCalledWith("rp-123");
  });

  it("forwards to DLQ on max retries", async () => {
    const job = {
      data: { referralPayoutId: "rp-123" },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as Job;

    jest.spyOn(referralsService, "processReferralBonus").mockRejectedValue(new Error("DB error"));
    jest.spyOn(dlq, "forwardToDlq").mockResolvedValue(undefined);

    await expect(processReferralBonusJob(job)).rejects.toThrow();
    expect(dlq.forwardToDlq).toHaveBeenCalled();
  });
});
```

## Implementation Steps

1. **Add service functions**:
   - `evaluateReferralBonusEligibility()` — decision logic
   - `executeReferralBonus()` — payout execution
   - `processReferralBonus()` — orchestration

2. **Write service tests**:
   - Unit tests for eligibility evaluation
   - Mock dependencies (isFraudSession, DB queries)
   - No BullMQ required

3. **Simplify processor**:
   - Remove inline business logic
   - Call `processReferralBonus()` from service
   - Handle BullMQ retry/DLQ logic only

4. **Update processor tests**:
   - Test processor calls service correctly
   - Verify retry/DLQ behavior

5. **Migrate existing tests**:
   - Move business-logic tests to service unit tests
   - Keep processor tests focused on queue behavior

## Benefits

1. **Separation of concerns**: Business rules decoupled from queue plumbing
2. **Testability**: Service functions unit-testable without BullMQ
3. **Reusability**: Referral logic callable from admin tools, batch processes
4. **Clarity**: Each module has one responsibility
5. **Maintainability**: Changes to eligibility rules don't touch processor

## Audit & Logging

Centralize audit logging in service:

```typescript
// Before (scattered)
// in processor
await updateReferralPayoutStatus(..., "failed", ..., "Referral bonus skipped because...");

// After (centralized)
// in service
await auditReferralBonusSkipped({
  payoutId: payout.id,
  action: "referral_bonus_skipped",
  reason: "Referral bonus skipped because session was flagged as fraud",
});
```

## Open Questions

1. Should `executeReferralBonus()` be a pure function or also handle Stellar queue integration?
2. Should audit logs be returned from service or written internally (side effect)?
3. For admin re-processing a failed bonus, should it call `processReferralBonus()` or `executeReferralBonus()`?

## References

- Processor: `apps/api/src/queues/processors/referral-bonus.processor.ts`
- Service: `apps/api/src/services/referrals.ts`
- Related RFCs: #1263 (test naming), #1264 (scoring), #1266 (web API)
