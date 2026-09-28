import { Worker, type Job, type WorkerOptions } from "bullmq";
import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { addUtcDays, getUtcWeekStart } from "../../lib/week";
import { seedWeekAssignments } from "../../db/queries/leagues";
import { query } from "../../db";
import { leagueQueue } from "../league.queue";

const ACTIVE_SESSION_DEFER_MINUTES = 30;
const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

async function countRecentActiveSessions(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM game_sessions
     WHERE status = 'active'
       AND challenge_started_at IS NOT NULL
       AND challenge_started_at >= NOW() - ($1 * INTERVAL '1 minute')`,
    [ACTIVE_SESSION_DEFER_MINUTES]
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

async function deferWeekStartForActiveSessions(weekStart: string): Promise<boolean> {
  const activeSessionCount = await countRecentActiveSessions();
  if (activeSessionCount === 0) {
    return false;
  }

  await leagueQueue.add("start-week", {}, {
    jobId: `league:start-week:deferred:${weekStart}`,
    delay: ACTIVE_SESSION_DEFER_MINUTES * 60 * 1000,
    removeOnComplete: true,
    removeOnFail: 10,
  });

  logger.info("Deferring league week seeding because active sessions are still running", {
    weekStart,
    activeSessionCount,
    deferMinutes: ACTIVE_SESSION_DEFER_MINUTES,
  });

  return true;
}

export function createLeagueWorker(WorkerCtor: typeof Worker = Worker, opts?: WorkerOptions) {
  const worker = new WorkerCtor(
    "league",
    async (job: Job) => {
      if (job.name === "finalize-week") {
        const weekStart = getUtcWeekStart(new Date());
        logger.info("Finalizing league week", { weekStart, weekEndExclusive: addUtcDays(weekStart, 7) });
        await query("SELECT recalculate_league($1)", [weekStart]);
        return;
      }

      if (job.name === "start-week") {
        const weekStart = getUtcWeekStart(new Date());
        if (await deferWeekStartForActiveSessions(weekStart)) {
          return;
        }
        logger.info("Seeding league week", { weekStart });
        await seedWeekAssignments(weekStart);
        return;
      }

      logger.warn("Unknown league job", { name: job.name, id: job.id });
    },
    {
      connection: redis,
      ...opts,
    }
  );

  setupGracefulShutdown(worker, "league");
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

