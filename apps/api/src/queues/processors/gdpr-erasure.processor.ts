import { Worker, type Job, type WorkerOptions } from "bullmq";
import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import {
  findPendingErasureRequest,
  anonymizeUser,
  markErasureExecuted,
} from "../../db/queries/gdpr";
import { revokeAllUserRefreshTokens } from "../../lib/tokens";
import type { GdprErasureJobData } from "../gdpr-erasure.queue";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

export const gdprErasureWorkerOptions = {
  connection: redis,
  concurrency: 1,
} satisfies WorkerOptions;

export async function processGdprErasureJob(
  job: Job<GdprErasureJobData>
): Promise<void> {
  const { userId, requestId } = job.data;
  logger.info("Processing GDPR erasure job", { jobId: job.id, userId });

  const request = await findPendingErasureRequest(userId);

  if (!request) {
    // Request was cancelled or already executed — skip silently
    logger.info("GDPR erasure skipped (cancelled or already executed)", { userId });
    return;
  }

  if (request.id !== requestId) {
    // A newer request supersedes this job — let the newer job handle it
    logger.info("GDPR erasure skipped (superseded by newer request)", { userId });
    return;
  }

  await anonymizeUser(userId);
  await revokeAllUserRefreshTokens(userId);
  await markErasureExecuted(requestId);

  logger.info("GDPR erasure completed", { userId });
}

export function createGdprErasureWorker(WorkerImpl: typeof Worker = Worker): Worker {
  const worker = new WorkerImpl(
    "gdpr-erasure",
    processGdprErasureJob,
    gdprErasureWorkerOptions
  );

  worker.on("completed", (job) => {
    logger.info("GDPR erasure job completed", { jobId: job.id });
  });

  worker.on("failed", (job, err) => {
    logger.error("GDPR erasure job failed", {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  setupGracefulShutdown(worker, "gdpr-erasure");

  return worker;
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
