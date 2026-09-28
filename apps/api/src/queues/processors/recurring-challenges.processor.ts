import { Worker, type Job, type WorkerOptions } from "bullmq";
import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { spawnDueChallengesFromAllTemplates } from "../../services/challenge-templates";

const SHUTDOWN_TIMEOUT_MS = 30_000;

export function createRecurringChallengesWorker(
  WorkerCtor: typeof Worker = Worker,
  opts?: WorkerOptions
) {
  const worker = new WorkerCtor(
    "recurring-challenges",
    async (job: Job) => {
      if (job.name === "spawn-all-due") {
        logger.info("Recurring challenges sweep: spawning due challenges from all active templates");
        const result = await spawnDueChallengesFromAllTemplates();
        logger.info("Recurring challenges sweep complete", {
          spawned: result.spawned,
          skipped: result.skipped,
          errors: result.errors,
          errorsList: result.errorsList,
        });
        return result;
      }

      if (job.name === "spawn-template") {
        const templateId = String(job.data?.templateId);
        if (!templateId) {
          logger.warn("spawn-template job missing templateId", { jobId: job.id });
          return null;
        }
        const { spawnChallengeFromTemplate } = await import(
          "../../services/challenge-templates"
        );
        const result = await spawnChallengeFromTemplate(templateId, {
          forcePeriod: job.data?.forcePeriod,
        });
        if (result) {
          logger.info("Spawned challenge from template (ad-hoc)", {
            templateId,
            challengeId: result.challenge.id,
            periodKey: result.periodKey,
          });
        }
        return result;
      }

      logger.warn("Unknown recurring-challenges job", { name: job.name, id: job.id });
    },
    {
      connection: redis,
      ...opts,
    }
  );

  setupGracefulShutdown(worker, "recurring-challenges");
  return worker;
}

function setupGracefulShutdown(worker: Worker, workerName: string): void {
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(
      `${signal} received, gracefully shutting down ${workerName} worker...`
    );

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
