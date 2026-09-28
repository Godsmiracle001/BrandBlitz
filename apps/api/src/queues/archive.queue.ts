import { Queue, Worker } from "bullmq";
import { redis } from "../lib/redis";
import { pool } from "../db";
import { logger } from "../lib/logger";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

export const archiveQueue = new Queue("archive", {
  connection: redis,
});

export async function scheduleArchiveJob(): Promise<void> {
  await archiveQueue.add(
    "monthly-archive",
    {},
    {
      jobId: "archive-monthly",
      repeat: { cron: "0 0 0 1 * *" },
      removeOnComplete: true,
    }
  );
}

/** Challenges eligible for archival: settled and ended more than 90 days ago. */
const ARCHIVE_PREDICATE = `status = 'settled' AND ended_at < NOW() - INTERVAL '90 days'`;

export function createArchiveWorker(): Worker {
  const worker = new Worker(
    "archive",
    async () => {
      logger.info("Running monthly archive job");

      // Run the whole archival inside one transaction so the child round-score
      // deletions and the parent session/challenge moves either all commit or
      // all roll back together.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Collect the ids of every session about to be archived/deleted.
        const sessionRows = await client.query<{ id: string }>(
          `SELECT id FROM game_sessions
            WHERE challenge_id IN (SELECT id FROM challenges WHERE ${ARCHIVE_PREDICATE})`,
        );
        const sessionIds = sessionRows.rows.map((r) => r.id);

        // 2. Delete child session_round_scores rows BEFORE their parent
        //    game_sessions rows so referential integrity is respected even if
        //    the FK cascade is ever removed. This is the leak the archive job
        //    previously left behind.
        let deletedRoundScores = 0;
        if (sessionIds.length > 0) {
          const scoreResult = await client.query(
            `DELETE FROM session_round_scores WHERE session_id = ANY($1::uuid[])`,
            [sessionIds],
          );
          deletedRoundScores = scoreResult.rowCount ?? 0;
        }

        // 3. Archive + delete the sessions, then the challenges.
        await client.query(`
          WITH moved_sessions AS (
            DELETE FROM game_sessions
            WHERE challenge_id IN (SELECT id FROM challenges WHERE ${ARCHIVE_PREDICATE})
            RETURNING *
          ),
          archived_sessions AS (
            INSERT INTO game_sessions_archive SELECT * FROM moved_sessions RETURNING id
          ),
          moved_challenges AS (
            DELETE FROM challenges
            WHERE ${ARCHIVE_PREDICATE}
            RETURNING *
          )
          INSERT INTO challenges_archive SELECT * FROM moved_challenges
        `);

        await client.query("COMMIT");
        logger.info("Monthly archive job completed", {
          archivedSessions: sessionIds.length,
          deletedRoundScores,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error("Monthly archive job failed — transaction rolled back", {
          error: (err as Error).message,
        });
        throw err;
      } finally {
        client.release();
      }
    },
    { connection: redis }
  );

  setupGracefulShutdown(worker, "archive");

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
