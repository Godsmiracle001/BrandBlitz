import { Queue, type JobsOptions } from "bullmq";
import { redis } from "../lib/redis";

export const recurringChallengesJobOptions = {
  attempts: 2,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
} satisfies JobsOptions;

export const recurringChallengesQueue = new Queue("recurring-challenges", {
  connection: redis,
  defaultJobOptions: recurringChallengesJobOptions,
});

const DEFAULT_SPAWN_CRON = "5 0 * * *"; // Daily, 00:05 UTC

async function getSpawnCron(): Promise<string> {
  try {
    const { getConfig } = await import("../db/queries/config");
    const config = await getConfig("recurring_challenges_cron_spawn");
    if (config && typeof config.cron === "string") {
      return config.cron;
    }
  } catch {
    // Fall back to default
  }
  return DEFAULT_SPAWN_CRON;
}

export async function ensureRecurringChallengesRepeatableJobs(): Promise<void> {
  const spawnCron = await getSpawnCron();

  const repeatableJobs = await recurringChallengesQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await recurringChallengesQueue.removeRepeatableByKey(job.key);
  }

  await recurringChallengesQueue.add(
    "spawn-all-due",
    {},
    {
      jobId: "recurring-challenges:spawn-all-due",
      repeat: { pattern: spawnCron, tz: "UTC" },
    }
  );
}
