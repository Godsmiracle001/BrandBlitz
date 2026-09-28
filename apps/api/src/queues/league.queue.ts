import { Queue, type JobsOptions } from "bullmq";
import { redis } from "../lib/redis";
import { getConfig } from "../db/queries/config";

export const leagueJobOptions = {
  attempts: 2,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
} satisfies JobsOptions;

export const leagueQueue = new Queue("league", {
  connection: redis,
  defaultJobOptions: leagueJobOptions,
});

const DEFAULT_FINALIZE_CRON = "59 23 * * 0"; // Sunday 23:59 UTC
const DEFAULT_START_CRON = "0 0 * * 1"; // Monday 00:00 UTC

async function getLeagueCronSchedule(key: string, fallback: string): Promise<string> {
  try {
    const config = await getConfig(key);
    if (config && typeof config.cron === "string") {
      return config.cron;
    }
  } catch (error) {
    // Fall back to default if config read fails
  }
  return fallback;
}

export async function ensureLeagueRepeatableJobs(): Promise<void> {
  const finalizeCron = await getLeagueCronSchedule("league_cron_finalize", DEFAULT_FINALIZE_CRON);
  const startCron = await getLeagueCronSchedule("league_cron_start", DEFAULT_START_CRON);

  // Remove existing repeatable jobs
  const repeatableJobs = await leagueQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await leagueQueue.removeRepeatableByKey(job.key);
  }

  // Add updated repeatable jobs
  await leagueQueue.add(
    "finalize-week",
    {},
    {
      jobId: "league:finalize-week",
      repeat: { pattern: finalizeCron, tz: "UTC" },
    }
  );

  await leagueQueue.add(
    "start-week",
    {},
    {
      jobId: "league:start-week",
      repeat: { pattern: startCron, tz: "UTC" },
    }
  );
}

