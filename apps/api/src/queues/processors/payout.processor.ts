import { Worker, UnrecoverableError, type Job, type WorkerOptions } from "bullmq";
import { redis } from "../../lib/redis";
import { processPayout, isFraudBlockError } from "../../services/payout";
import { logger } from "../../lib/logger";
import { failPayoutsForChallenge } from "../../db/queries/payouts";
import { query } from "../../db";
import { payoutJobOptions } from "../payout.queue";
import { config } from "../../lib/config";
import { forwardToDlq, payoutDlqQueue } from "../dlq";

export const PAYOUT_WORKER_CONCURRENCY = config.PAYOUT_WORKER_CONCURRENCY;
const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

export const payoutWorkerOptions = {
  connection: redis,
  concurrency: PAYOUT_WORKER_CONCURRENCY,
} satisfies WorkerOptions;

export async function processPayoutJob(job: Job<{ challengeId: string; requestId?: string }>): Promise<void> {
  logger.info("Processing payout job", { jobId: job.id, challengeId: job.data.challengeId, requestId: job.data.requestId });
  try {
    await processPayout(job.data.challengeId);
  } catch (err) {
    // Fraud-blocked payouts must not be retried — re-running them won't change
    // the DB trigger's decision and would hammer the audit log unnecessarily.
    if (isFraudBlockError(err)) {
      logger.warn("Payout job terminated by fraud block — not retrying", {
        jobId: job.id,
        challengeId: job.data.challengeId,
      });
      throw new UnrecoverableError(
        err instanceof Error ? err.message : String(err)
      );
    }
    throw err;
  }
}

export function createPayoutWorker(WorkerImpl: typeof Worker = Worker): Worker {
  const worker = new WorkerImpl(
    "payout",
    processPayoutJob,
    payoutWorkerOptions
  );

  worker.on("completed", (job) => {
    logger.info("Payout job completed", { jobId: job.id });
  });

  worker.on("failed", (job, err) => {
    logger.error("Payout job failed", {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
    });
    // Once all retries are exhausted, dead-letter the job so the stranded
    // payout row is reconciled and an audit_log record is written.
    void forwardToDlq(payoutDlqQueue, job, err).catch((dlqErr) => {
      logger.error("Failed to forward payout job to DLQ", {
        jobId: job?.id,
        error: (dlqErr as Error).message,
      });
    });
  });

  setupGracefulShutdown(worker, "payout");

  return worker;
}

export async function handleExhaustedPayoutJob(
  job: Job<{ challengeId: string; requestId?: string }>,
  err: Error
): Promise<void> {
  await failPayoutsForChallenge(job.data.challengeId, err.message);
  await query(
    `INSERT INTO audit_log (action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      "payout_failed",
      "challenge",
      job.data.challengeId,
      JSON.stringify({
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        error: err.message,
      }),
    ]
  );
}

function setupGracefulShutdown(worker: Worker, workerName: string): void {
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received, gracefully shutting down ${workerName} worker...`);

    const shutdownTimer = setTimeout(() => {
      logger.warn(`${workerName} worker shutdown timeout exceeded, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await worker.close();
      clearTimeout(shutdownTimer);
      logger.info(`${workerName} worker closed gracefully`);
      process.exit(0);
    } catch (error) {
      clearTimeout(shutdownTimer);
      logger.error(`Error during ${workerName} worker shutdown`, {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}
