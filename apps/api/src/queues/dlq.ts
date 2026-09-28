import {
  Queue,
  Worker,
  type Job,
  type JobsOptions,
  type WorkerOptions,
} from "bullmq";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";
import { query } from "../db";
import { payoutQueue } from "./payout.queue";
import { referralBonusQueue } from "./referral-bonus.queue";
import { leagueQueue } from "./league.queue";
import { recurringChallengesQueue } from "./recurring-challenges.queue";

/**
 * dlq.ts — Dead-letter queue plumbing for the BullMQ pipelines.
 *
 * BullMQ has no native dead-letter concept: once a job exhausts its retry
 * attempts it is moved to the `failed` set and silently dropped from Redis
 * after the default retention window. When that happens the corresponding
 * database row (e.g. `payouts`) is stranded in a non-terminal state with no
 * observable signal for on-call engineers.
 *
 * To close that gap, each producing worker forwards a job to a named
 * dead-letter queue (`<queue>-dlq`) the moment it exhausts all attempts. A
 * dedicated DLQ worker then reconciles the database (marking the stranded row
 * `failed`) and writes an `audit_log` record so the failure is triageable.
 *
 * DLQ jobs are retained indefinitely (`removeOnComplete: false`). Redis is
 * configured with `volatile-lru`, which only evicts keys carrying a TTL —
 * DLQ keys never expire and therefore survive well beyond the 7-day
 * operational retention requirement.
 */

export const dlqJobOptions = {
  // Keep every dead-lettered job so operators can inspect and manually retry.
  removeOnComplete: false,
  removeOnFail: false,
  // The DLQ worker only reconciles state; it must not retry on its own.
  attempts: 1,
} satisfies JobsOptions;

export const PAYOUT_DLQ_NAME = "payout-dlq";
export const REFERRAL_BONUS_DLQ_NAME = "referral-bonus-dlq";
export const LEAGUE_DLQ_NAME = "league-dlq";
export const RECURRING_CHALLENGES_DLQ_NAME = "recurring-challenges-dlq";

export const payoutDlqQueue = new Queue(PAYOUT_DLQ_NAME, {
  connection: redis,
  defaultJobOptions: dlqJobOptions,
});

export const referralBonusDlqQueue = new Queue(REFERRAL_BONUS_DLQ_NAME, {
  connection: redis,
  defaultJobOptions: dlqJobOptions,
});

export const leagueDlqQueue = new Queue(LEAGUE_DLQ_NAME, {
  connection: redis,
  defaultJobOptions: dlqJobOptions,
});

export const recurringChallengesDlqQueue = new Queue(RECURRING_CHALLENGES_DLQ_NAME, {
  connection: redis,
  defaultJobOptions: dlqJobOptions,
});

/** Lookup of DLQ name → queue, used by the admin inspection endpoint. */
export const DLQ_QUEUES: Record<string, Queue> = {
  [PAYOUT_DLQ_NAME]: payoutDlqQueue,
  [REFERRAL_BONUS_DLQ_NAME]: referralBonusDlqQueue,
  [LEAGUE_DLQ_NAME]: leagueDlqQueue,
  [RECURRING_CHALLENGES_DLQ_NAME]: recurringChallengesDlqQueue,
};

/** Lookup of DLQ name → the original queue jobs should be replayed onto. */
export const DLQ_SOURCE_QUEUES: Record<string, Queue> = {
  [PAYOUT_DLQ_NAME]: payoutQueue,
  [REFERRAL_BONUS_DLQ_NAME]: referralBonusQueue,
  [LEAGUE_DLQ_NAME]: leagueQueue,
  [RECURRING_CHALLENGES_DLQ_NAME]: recurringChallengesQueue,
};

export interface DeadLetterPayload {
  /** Name of the queue the job originally ran on. */
  originalQueue: string;
  /** Original BullMQ job id (used for de-duplication / tracing). */
  originalJobId?: string;
  /** Original BullMQ job name. */
  jobName: string;
  /** Original job payload, replayed verbatim on manual retry. */
  data: unknown;
  /** The final failure reason after all attempts were exhausted. */
  failedReason: string;
  /** How many attempts were made before giving up. */
  attemptsMade: number;
  /** ISO timestamp of when the job was dead-lettered. */
  failedAt: string;
}

/**
 * Forward a job to its dead-letter queue once it has exhausted every retry
 * attempt. No-ops while BullMQ still has retries left so transient failures
 * are not dead-lettered prematurely.
 */
export async function forwardToDlq(
  dlqQueue: Queue,
  job: Job | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) {
    // Not the final attempt — BullMQ will retry; do not dead-letter yet.
    return;
  }

  const payload: DeadLetterPayload = {
    originalQueue: job.queueName,
    originalJobId: job.id,
    jobName: job.name,
    data: job.data,
    failedReason: err.message,
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  };

  await dlqQueue.add(job.name, payload, dlqJobOptions);
  logger.warn("Job moved to dead-letter queue", {
    dlq: dlqQueue.name,
    originalQueue: payload.originalQueue,
    originalJobId: payload.originalJobId,
    jobName: payload.jobName,
  });
}

function truncate(message: string, max = 480): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

// ── DLQ processors ──────────────────────────────────────────────────────────

async function processPayoutDlqJob(job: Job<DeadLetterPayload>): Promise<void> {
  const challengeId = (job.data.data as { challengeId?: string } | undefined)
    ?.challengeId;
  const message = truncate(
    `Payout job exhausted all ${job.data.attemptsMade} retries: ${job.data.failedReason}`,
  );

  let affected: string[] = [];
  if (challengeId) {
    const result = await query<{ id: string }>(
      `UPDATE payouts
          SET status = 'failed', error_message = $2, updated_at = NOW()
        WHERE challenge_id = $1 AND status IN ('pending', 'processing')
        RETURNING id`,
      [challengeId, message],
    );
    affected = result.rows.map((r) => r.id);
  } else {
    logger.error("Payout DLQ job missing challengeId", { dlqJobId: job.id });
  }

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES (NULL, 'payout.dead_letter', 'challenge', $1, $2)`,
    [
      challengeId ?? null,
      JSON.stringify({
        failedReason: job.data.failedReason,
        attemptsMade: job.data.attemptsMade,
        originalJobId: job.data.originalJobId,
        affectedPayouts: affected,
      }),
    ],
  );

  logger.error("Payout permanently failed — dead-lettered", {
    challengeId,
    affectedPayouts: affected.length,
  });
}

async function processReferralBonusDlqJob(
  job: Job<DeadLetterPayload>,
): Promise<void> {
  const referralPayoutId = (
    job.data.data as { referralPayoutId?: string } | undefined
  )?.referralPayoutId;
  const message = truncate(
    `Referral bonus job exhausted all ${job.data.attemptsMade} retries: ${job.data.failedReason}`,
  );

  if (referralPayoutId) {
    await query(
      `UPDATE referral_payouts
          SET status = 'failed', error_message = $2
        WHERE id = $1 AND status NOT IN ('sent', 'failed')`,
      [referralPayoutId, message],
    );
  } else {
    logger.error("Referral-bonus DLQ job missing referralPayoutId", {
      dlqJobId: job.id,
    });
  }

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES (NULL, 'referral_bonus.dead_letter', 'referral_payout', $1, $2)`,
    [
      referralPayoutId ?? null,
      JSON.stringify({
        failedReason: job.data.failedReason,
        attemptsMade: job.data.attemptsMade,
        originalJobId: job.data.originalJobId,
      }),
    ],
  );

  logger.error("Referral bonus permanently failed — dead-lettered", {
    referralPayoutId,
  });
}

async function processLeagueDlqJob(job: Job<DeadLetterPayload>): Promise<void> {
  // League jobs (finalize-week / start-week) have no per-row DB state to
  // reconcile; the audit_log record is the on-call triage signal.
  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES (NULL, 'league.dead_letter', 'league', $1, $2)`,
    [
      job.data.jobName,
      JSON.stringify({
        failedReason: job.data.failedReason,
        attemptsMade: job.data.attemptsMade,
        originalJobId: job.data.originalJobId,
      }),
    ],
  );

  logger.error("League job permanently failed — dead-lettered", {
    jobName: job.data.jobName,
  });
}

async function processRecurringChallengesDlqJob(
  job: Job<DeadLetterPayload>,
): Promise<void> {
  const templateId = (
    job.data.data as { templateId?: string } | undefined
  )?.templateId;
  const message = truncate(
    `Recurring-challenges job exhausted all ${job.data.attemptsMade} retries: ${job.data.failedReason}`,
  );

  if (templateId) {
    try {
      await query(
        `UPDATE challenge_templates
         SET status = 'paused', updated_at = NOW()
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [templateId],
      );
    } catch (err) {
      logger.error("Failed to auto-pause dead-lettered template", {
        templateId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES (NULL, 'recurring_challenges.dead_letter', 'challenge_template', $1, $2)`,
    [
      templateId ?? null,
      JSON.stringify({
        jobName: job.data.jobName,
        failedReason: job.data.failedReason,
        attemptsMade: job.data.attemptsMade,
        originalJobId: job.data.originalJobId,
      }),
    ],
  );

  logger.error("Recurring challenges job permanently failed — dead-lettered", {
    jobName: job.data.jobName,
    templateId,
    message,
  });
}

const dlqWorkerOptions = {
  connection: redis,
  concurrency: 1,
} satisfies WorkerOptions;

/** Create DLQ workers. Returns them so the caller can close them. */
export function createDlqWorkers(WorkerImpl: typeof Worker = Worker): Worker[] {
  return [
    new WorkerImpl(PAYOUT_DLQ_NAME, processPayoutDlqJob, dlqWorkerOptions),
    new WorkerImpl(
      REFERRAL_BONUS_DLQ_NAME,
      processReferralBonusDlqJob,
      dlqWorkerOptions,
    ),
    new WorkerImpl(LEAGUE_DLQ_NAME, processLeagueDlqJob, dlqWorkerOptions),
    new WorkerImpl(
      RECURRING_CHALLENGES_DLQ_NAME,
      processRecurringChallengesDlqJob,
      dlqWorkerOptions,
    ),
  ];
}
