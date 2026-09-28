import { Worker, type Job, type WorkerOptions } from "bullmq";
import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { metrics } from "../../lib/metrics";
import { markAbandonedSessions } from "../../db/queries/sessions";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

export const sessionTimeoutWorkerOptions = {
  connection: redis,
  concurrency: 1,
} satisfies WorkerOptions;

export async function processSessionTimeoutJob(_job: Job): Promise<void> {
  const abandonedCount = await markAbandonedSessions();
  for (let index = 0; index < abandonedCount; index += 1) {
    metrics.inc("sessions.abandoned_total");
  }
  logger.info("Session timeout sweep completed", { abandonedCount });
}

export function createSessionTimeoutWorker(WorkerImpl: typeof Worker = Worker): Worker {
  const worker = new WorkerImpl(
    "session-timeout",
    processSessionTimeoutJob,
    sessionTimeoutWorkerOptions
  );

  worker.on("completed", (job) => {
    logger.info("Session timeout job completed", { jobId: job.id });
  });

  worker.on("failed", (job, err) => {
    logger.error("Session timeout job failed", {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  setupGracefulShutdown(worker, "session-timeout");

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
