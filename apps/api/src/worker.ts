import { initSentry } from "./lib/sentry";
void initSentry();
import { connectDb, closeDb } from "./db";
import { connectRedis, redis, startRedisEvictionMonitor } from "./lib/redis";
import { createPayoutWorker } from "./queues/processors/payout.processor";
import {
  createArchiveWorker,
  scheduleArchiveJob,
} from "./queues/archive.queue";
import { createLeagueWorker } from "./queues/processors/league.processor";
import { createGdprErasureWorker } from "./queues/processors/gdpr-erasure.processor";
import { createReferralBonusWorker } from "./queues/processors/referral-bonus.processor";
import { ensureLeagueRepeatableJobs } from "./queues/league.queue";
import { createSessionTimeoutWorker } from "./queues/processors/session-timeout.processor";
import {
  createLeaderboardRefreshWorker,
  leaderboardRefreshQueue,
} from "./queues/leaderboard-refresh.queue";
import { createRecurringChallengesWorker } from "./queues/processors/recurring-challenges.processor";
import { ensureRecurringChallengesRepeatableJobs } from "./queues/recurring-challenges.queue";
import { referralBonusQueue } from "./queues/referral-bonus.queue";
import { recurringChallengesQueue } from "./queues/recurring-challenges.queue";
import {
  ensureSessionTimeoutSweepJob,
  sessionTimeoutQueue,
} from "./queues/session-timeout.queue";
import {
  createDlqWorkers,
  payoutDlqQueue,
  referralBonusDlqQueue,
  leagueDlqQueue,
  recurringChallengesDlqQueue,
} from "./queues/dlq";
import { drainSharedAgent } from "@brandblitz/stellar";
import { logger } from "./lib/logger";

async function startWorker(): Promise<void> {
  await connectDb();
  await connectRedis();

  const payoutWorker = createPayoutWorker();
  const archiveWorker = createArchiveWorker();
  const leagueWorker = createLeagueWorker();
  const gdprErasureWorker = createGdprErasureWorker();
  const referralBonusWorker = createReferralBonusWorker();
  const sessionTimeoutWorker = createSessionTimeoutWorker();
  const recurringChallengesWorker = createRecurringChallengesWorker();
  const dlqWorkers = createDlqWorkers();
  await scheduleArchiveJob();
  await ensureLeagueRepeatableJobs();
  await ensureSessionTimeoutSweepJob();
  await ensureRecurringChallengesRepeatableJobs();
  const evictionMonitor = startRedisEvictionMonitor();
  logger.info(
    "BullMQ worker started — processing payout + archive + league + gdpr-erasure + referral-bonus + session-timeout + recurring-challenges jobs + dead-letter queues",
  );

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — closing worker`);
    clearInterval(evictionMonitor);
    await payoutWorker.close();
    await archiveWorker.close();
    await leagueWorker.close();
    await gdprErasureWorker.close();
    await referralBonusWorker.close();
    await sessionTimeoutWorker.close();
    await recurringChallengesWorker.close();
    await Promise.all(dlqWorkers.map((w) => w.close()));
    await referralBonusQueue.close();
    await sessionTimeoutQueue.close();
    await recurringChallengesQueue.close();
    await payoutDlqQueue.close();
    await referralBonusDlqQueue.close();
    await leagueDlqQueue.close();
    await recurringChallengesDlqQueue.close();
    await closeDb();
    await redis.disconnect();
    drainSharedAgent();
    logger.info("Worker shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startWorker().catch((err) => {
  logger.error("Worker failed to start", { err });
  process.exit(1);
});
