# RFC: Extract Shared BullMQ Queue/Worker Factory

**Status:** Proposed  
**Author:** Engineering Team  
**Created:** 2024  
**Issue:** #1248

## Problem Statement

BrandBlitz has seven independent Queue/Worker definitions in `apps/api/src/queues/`:

1. `payout.queue.ts` - Payment processing
2. `league.queue.ts` - League lifecycle events
3. `referral-bonus.queue.ts` - Referral rewards
4. `session-timeout.queue.ts` - Session cleanup
5. `archive.queue.ts` - Data archival
6. `gdpr-erasure.queue.ts` - User data deletion
7. `leaderboard-refresh.queue.ts` - Leaderboard updates

Plus `dlq.ts` for dead letter queue handling.

Each queue re-implements:
- Redis connection options
- Retry/backoff configuration
- Worker lifecycle wiring
- Error handling patterns
- DLQ registration

This leads to:
- **Inconsistent behavior** - Different retry policies across queues
- **Maintenance burden** - Changes must be replicated 7+ times
- **Copy-paste errors** - Each new queue copies from an arbitrary existing one
- **Testing complexity** - No single place to test queue infrastructure

## Current State

### Typical Queue Setup (Repeated 7 Times)

```typescript
// apps/api/src/queues/payout.queue.ts
import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/lib/redis';

const connection = getRedisConnection();

export const payoutQueue = new Queue('payout', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export const payoutWorker = new Worker(
  'payout',
  async (job: Job) => {
    const { userId, amount, destination } = job.data;
    // Process payout...
  },
  {
    connection,
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000,
    },
  }
);

payoutWorker.on('completed', (job) => {
  console.log(`Payout ${job.id} completed`);
});

payoutWorker.on('failed', (job, err) => {
  console.error(`Payout ${job.id} failed:`, err);
  // DLQ wiring...
});
```

### Divergences Across Queues

| Queue | Attempts | Backoff | Concurrency | Rate Limit | Remove Complete | Remove Fail |
|-------|----------|---------|-------------|------------|-----------------|-------------|
| payout | 3 | exponential (5s) | 5 | 10/1s | 100 | 50 |
| league | 5 | exponential (10s) | 1 | none | 1000 | 100 |
| referral | 3 | exponential (5s) | 10 | 20/1s | 100 | 50 |
| session-timeout | 3 | exponential (2s) | 10 | none | 50 | 25 |
| archive | 2 | fixed (30s) | 2 | 5/10s | 10 | 10 |
| gdpr-erasure | 5 | exponential (60s) | 1 | 1/1s | 1 | 100 |
| leaderboard | 3 | exponential (5s) | 3 | 10/1s | 1000 | 50 |

**Key Observations:**
- No clear reasoning for different values
- Copy-paste from different sources
- Some intentional (gdpr slow, archive rare)
- Some accidental (why does league need 5 attempts?)

### DLQ Wiring (Also Duplicated)

```typescript
// apps/api/src/queues/dlq.ts
export function setupDLQ(worker: Worker, queueName: string) {
  worker.on('failed', async (job, err) => {
    if (!job) return;
    
    const attempts = job.attemptsMade;
    const maxAttempts = job.opts.attempts || 3;
    
    if (attempts >= maxAttempts) {
      await dlqQueue.add(`${queueName}:${job.id}`, {
        originalQueue: queueName,
        originalJob: job.data,
        error: err.message,
        failedAt: new Date(),
      });
    }
  });
}

// Must be manually called in each queue file
setupDLQ(payoutWorker, 'payout');
setupDLQ(leagueWorker, 'league');
// ... etc
```

### Special Cases

**League Queue:**
```typescript
// Uses repeatable jobs for cron-like scheduling
await leagueQueue.add(
  'end-league',
  { leagueId },
  {
    repeat: {
      pattern: '0 0 * * *', // Daily at midnight
    },
  }
);
```

**Archive Queue:**
```typescript
// Very long-running jobs (hours)
export const archiveWorker = new Worker(
  'archive',
  async (job: Job) => {
    // May take 2-3 hours for large archives
    await archiveUserData(job.data.userId);
  },
  {
    connection,
    lockDuration: 10800000, // 3 hours
  }
);
```

**Session Timeout Queue:**
```typescript
// Delay-based jobs
await sessionTimeoutQueue.add(
  'timeout',
  { sessionId },
  { delay: SESSION_TIMEOUT_MS } // 30 minutes
);
```

## Proposal

### Shared Queue/Worker Factory API

```typescript
// apps/api/src/queues/factory.ts
import { Queue, Worker, Job, QueueOptions, WorkerOptions } from 'bullmq';
import { getRedisConnection } from '@/lib/redis';
import { setupDLQ } from './dlq';

export interface CreateQueueOptions extends Partial<QueueOptions> {
  name: string;
  defaultJobOptions?: {
    attempts?: number;
    backoff?: {
      type: 'exponential' | 'fixed';
      delay: number;
    };
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
  };
}

export interface CreateWorkerOptions extends Partial<WorkerOptions> {
  queueName: string;
  processor: (job: Job) => Promise<any>;
  concurrency?: number;
  limiter?: {
    max: number;
    duration: number;
  };
  useDLQ?: boolean;
  onCompleted?: (job: Job) => void;
  onFailed?: (job: Job, error: Error) => void;
}

// Default configurations based on common patterns
const DEFAULT_QUEUE_OPTIONS: CreateQueueOptions = {
  name: '',
  connection: undefined, // Set at runtime
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
};

const DEFAULT_WORKER_OPTIONS: Omit<CreateWorkerOptions, 'queueName' | 'processor'> = {
  concurrency: 5,
  limiter: {
    max: 10,
    duration: 1000,
  },
  useDLQ: true,
};

/**
 * Create a standardized BullMQ queue
 */
export function createQueue(options: CreateQueueOptions): Queue {
  const connection = getRedisConnection();
  
  const queueOptions: QueueOptions = {
    ...DEFAULT_QUEUE_OPTIONS,
    ...options,
    connection,
  };
  
  return new Queue(options.name, queueOptions);
}

/**
 * Create a standardized BullMQ worker with DLQ support
 */
export function createWorker(options: CreateWorkerOptions): Worker {
  const connection = getRedisConnection();
  
  const {
    queueName,
    processor,
    useDLQ = true,
    onCompleted,
    onFailed,
    ...workerOptions
  } = options;
  
  const finalOptions: WorkerOptions = {
    ...DEFAULT_WORKER_OPTIONS,
    ...workerOptions,
    connection,
  };
  
  const worker = new Worker(queueName, processor, finalOptions);
  
  // Standard event handlers
  worker.on('completed', (job) => {
    console.log(`[${queueName}] Job ${job.id} completed`);
    onCompleted?.(job);
  });
  
  worker.on('failed', (job, error) => {
    console.error(`[${queueName}] Job ${job?.id} failed:`, error);
    onFailed?.(job!, error);
  });
  
  // Automatic DLQ registration
  if (useDLQ) {
    setupDLQ(worker, queueName);
  }
  
  return worker;
}

/**
 * Preset configurations for common queue patterns
 */
export const QUEUE_PRESETS = {
  // Fast, high-volume queues (e.g., notifications, analytics)
  highThroughput: {
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential' as const, delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 100,
    },
    workerOptions: {
      concurrency: 20,
      limiter: { max: 100, duration: 1000 },
    },
  },
  
  // Critical financial operations (e.g., payouts, deposits)
  financial: {
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential' as const, delay: 10000 },
      removeOnComplete: false, // Keep for audit
      removeOnFail: false,
    },
    workerOptions: {
      concurrency: 3,
      limiter: { max: 10, duration: 1000 },
    },
  },
  
  // Long-running, rare jobs (e.g., data export, archival)
  longRunning: {
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed' as const, delay: 60000 },
      removeOnComplete: 10,
      removeOnFail: 10,
    },
    workerOptions: {
      concurrency: 1,
      lockDuration: 10800000, // 3 hours
    },
  },
  
  // Time-sensitive, single-attempt jobs (e.g., real-time updates)
  realtime: {
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
    workerOptions: {
      concurrency: 10,
      limiter: { max: 50, duration: 1000 },
    },
  },
} as const;
```

### Refactored Queue Example

**Before:**
```typescript
// apps/api/src/queues/payout.queue.ts (50+ lines)
import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '@/lib/redis';
import { setupDLQ } from './dlq';

const connection = getRedisConnection();

export const payoutQueue = new Queue('payout', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export const payoutWorker = new Worker(
  'payout',
  async (job: Job) => {
    const { userId, amount, destination } = job.data;
    await processPayoutInternal(userId, amount, destination);
  },
  {
    connection,
    concurrency: 5,
    limiter: { max: 10, duration: 1000 },
  }
);

payoutWorker.on('completed', (job) => {
  console.log(`Payout ${job.id} completed`);
});

payoutWorker.on('failed', (job, err) => {
  console.error(`Payout ${job.id} failed:`, err);
});

setupDLQ(payoutWorker, 'payout');
```

**After:**
```typescript
// apps/api/src/queues/payout.queue.ts (15 lines)
import { createQueue, createWorker, QUEUE_PRESETS } from './factory';
import { processPayoutInternal } from '@/services/payout';

export const payoutQueue = createQueue({
  name: 'payout',
  ...QUEUE_PRESETS.financial,
});

export const payoutWorker = createWorker({
  queueName: 'payout',
  processor: async (job) => {
    const { userId, amount, destination } = job.data;
    await processPayoutInternal(userId, amount, destination);
  },
  ...QUEUE_PRESETS.financial.workerOptions,
});
```

### Handling Special Cases

**League Queue (Repeatable Jobs):**
```typescript
// Factory doesn't prevent direct queue access
export const leagueQueue = createQueue({
  name: 'league',
  ...QUEUE_PRESETS.financial, // Critical business logic
});

// Use queue directly for repeat patterns
await leagueQueue.add(
  'end-league',
  { leagueId },
  {
    repeat: {
      pattern: '0 0 * * *',
    },
  }
);

export const leagueWorker = createWorker({
  queueName: 'league',
  processor: handleLeagueJob,
  concurrency: 1, // Override: only one league job at a time
});
```

**Archive Queue (Long Lock Duration):**
```typescript
export const archiveQueue = createQueue({
  name: 'archive',
  ...QUEUE_PRESETS.longRunning,
});

export const archiveWorker = createWorker({
  queueName: 'archive',
  processor: archiveUserData,
  ...QUEUE_PRESETS.longRunning.workerOptions,
  // Preset already has lockDuration: 10800000
});
```

**Session Timeout (Delayed Jobs):**
```typescript
// Delay is per-job, not queue config
await sessionTimeoutQueue.add(
  'timeout',
  { sessionId },
  { delay: SESSION_TIMEOUT_MS } // Still works!
);
```

## Migration Plan

### Phase 1: Audit & Document (Week 1)
- [ ] Create comparison table of all queue configs (Done above)
- [ ] Document rationale for each divergence
- [ ] Identify which divergences are intentional vs accidental
- [ ] Survey team for any undocumented requirements

**Deliverable:** `docs/queues/config-audit.md`

### Phase 2: Build Factory (Week 2)
- [ ] Implement `createQueue()` and `createWorker()`
- [ ] Add presets based on audit findings
- [ ] Write comprehensive unit tests
- [ ] Add TypeScript strict mode checks
- [ ] Document factory API

**Deliverable:** `apps/api/src/queues/factory.ts` + tests

### Phase 3: Migrate One Queue (Week 3)
- [ ] Choose simplest queue (leaderboard-refresh)
- [ ] Refactor to use factory
- [ ] Run integration tests
- [ ] Monitor in staging for 1 week
- [ ] Document lessons learned

**Deliverable:** Refactored `leaderboard-refresh.queue.ts`

### Phase 4: Migrate Remaining Queues (Weeks 4-6)
Migrate in order of complexity:

1. **referral-bonus** (simple, matches defaults)
2. **session-timeout** (simple with delays)
3. **payout** (financial preset)
4. **gdpr-erasure** (slow processing)
5. **archive** (long-running preset)
6. **league** (repeatable jobs)

For each:
- [ ] Refactor queue file
- [ ] Update tests
- [ ] Deploy to staging
- [ ] Monitor for 2 days
- [ ] Deploy to production

**Deliverable:** All queues refactored

### Phase 5: Remove Old Patterns (Week 7)
- [ ] Add linting rule preventing direct `new Queue()` usage
- [ ] Update contribution guidelines
- [ ] Archive old queue templates
- [ ] Add JSDoc examples to factory

**Deliverable:** Enforced patterns

## Rollout Strategy

**Staging:**
- All refactored queues run in parallel with old code
- Compare metrics: throughput, failure rate, latency
- Switch traffic gradually (10% → 50% → 100%)

**Production:**
- One queue at a time
- Blue-green deployment per queue
- Automated rollback if error rate increases
- 24-hour monitoring period per queue

**Metrics to Watch:**
- Job completion rate
- Retry count
- DLQ size
- Worker memory usage
- Redis connection count

## Edge Cases & Accommodations

### Edge Case 1: Queue-Specific Middleware
**Problem:** Some queues need custom middleware (e.g., auth checks)

**Solution:**
```typescript
export function createWorker(options: CreateWorkerOptions & {
  middleware?: (job: Job, next: () => Promise<any>) => Promise<any>;
}) {
  const { middleware, processor, ...rest } = options;
  
  const wrappedProcessor = middleware
    ? async (job: Job) => middleware(job, () => processor(job))
    : processor;
  
  return new Worker(queueName, wrappedProcessor, workerOptions);
}
```

### Edge Case 2: Multiple Workers Per Queue
**Problem:** Some queues need different workers for different job types

**Solution:** Factory doesn't prevent this:
```typescript
const payoutQueue = createQueue({ name: 'payout' });

const regularPayouts = createWorker({
  queueName: 'payout',
  processor: handleRegularPayout,
});

const batchPayouts = createWorker({
  queueName: 'payout',
  processor: handleBatchPayout,
  concurrency: 1, // Process batches serially
});
```

### Edge Case 3: Dynamic Configuration
**Problem:** Some queues need runtime-adjustable config

**Solution:** Support function-based options:
```typescript
export function createQueue(options: CreateQueueOptions | (() => CreateQueueOptions)) {
  const resolvedOptions = typeof options === 'function' ? options() : options;
  // ...
}

// Usage with runtime config
const payoutQueue = createQueue(() => ({
  name: 'payout',
  defaultJobOptions: {
    attempts: getRuntimeConfig('payout.max_attempts'), // From DB
  },
}));
```

## Testing Strategy

### Unit Tests
```typescript
describe('createQueue', () => {
  it('applies default options', () => {
    const queue = createQueue({ name: 'test' });
    expect(queue.defaultJobOptions.attempts).toBe(3);
  });
  
  it('overrides defaults with custom options', () => {
    const queue = createQueue({
      name: 'test',
      defaultJobOptions: { attempts: 10 },
    });
    expect(queue.defaultJobOptions.attempts).toBe(10);
  });
  
  it('applies presets correctly', () => {
    const queue = createQueue({
      name: 'test',
      ...QUEUE_PRESETS.financial,
    });
    expect(queue.defaultJobOptions.attempts).toBe(5);
  });
});

describe('createWorker', () => {
  it('registers DLQ by default', () => {
    const worker = createWorker({
      queueName: 'test',
      processor: jest.fn(),
    });
    expect(worker.listeners('failed').length).toBeGreaterThan(0);
  });
  
  it('skips DLQ when disabled', () => {
    const worker = createWorker({
      queueName: 'test',
      processor: jest.fn(),
      useDLQ: false,
    });
    // Assert no DLQ handler registered
  });
});
```

### Integration Tests
```typescript
describe('Queue Factory Integration', () => {
  it('processes jobs end-to-end', async () => {
    const processed: string[] = [];
    
    const queue = createQueue({ name: 'test' });
    const worker = createWorker({
      queueName: 'test',
      processor: async (job) => {
        processed.push(job.data.value);
      },
    });
    
    await queue.add('job1', { value: 'test' });
    await waitForJob(queue, 'job1');
    
    expect(processed).toContain('test');
    
    await worker.close();
    await queue.close();
  });
});
```

## Success Metrics

**Code Quality:**
- ✅ All queues use factory (0 direct `new Queue()` outside factory)
- ✅ DLQ setup is automatic (no manual `setupDLQ()` calls)
- ✅ All queues have consistent error handling
- ✅ Retry policies follow documented reasoning

**Maintainability:**
- ✅ Adding new queue takes <10 lines of code
- ✅ Changing retry policy requires 1 file edit (factory), not 7
- ✅ New team members can add queues without asking

**Reliability:**
- ✅ No increase in job failure rate post-migration
- ✅ DLQ size remains stable or decreases
- ✅ Redis connection count stable or decreases

## Risks & Mitigations

**Risk:** Factory doesn't support an edge case  
**Mitigation:** Allow direct queue/worker creation, document when to use each

**Risk:** Migration breaks existing jobs  
**Mitigation:** Blue-green deployment per queue, automated rollback

**Risk:** Performance regression  
**Mitigation:** Load testing before production, gradual rollout

**Risk:** Team unfamiliar with new pattern  
**Mitigation:** Pair programming during migration, comprehensive docs

## Future Enhancements

**Phase 2 Features:**
- Job priority queues
- Batch job processing
- Queue metrics dashboard
- Auto-scaling workers
- Queue health monitoring

**Phase 3 Features:**
- Queue-specific tracing (OpenTelemetry)
- Job cost estimation
- SLA tracking per queue
- Automatic retry policy tuning

## References

- Issue #1248
- [BullMQ Documentation](https://docs.bullmq.io/)
- `apps/api/src/queues/` - Current implementations
- `apps/api/src/queues/dlq.ts` - DLQ pattern

## Approval

- [ ] Backend Team Review
- [ ] DevOps Review (Redis capacity planning)
- [ ] QA Review (test strategy)
- [ ] Product Review (no user-facing changes)
