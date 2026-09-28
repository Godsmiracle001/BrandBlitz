import { Router } from "express";
import { z } from "zod";
import type { Queue } from "bullmq";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { createError } from "../../middleware/error";
import { query } from "../../db/index";
import { logger } from "../../lib/logger";
import { payoutQueue } from "../../queues/payout.queue";
import { leagueQueue } from "../../queues/league.queue";
import { gdprErasureQueue } from "../../queues/gdpr-erasure.queue";
import { referralBonusQueue } from "../../queues/referral-bonus.queue";
import { sessionTimeoutQueue } from "../../queues/session-timeout.queue";
import { archiveQueue } from "../../queues/archive.queue";
import { withCoalescing } from "../../lib/cache";

const router = Router();
router.use(authenticate);
router.use(requireAdmin);

const queues: Record<string, Queue> = {
  payout: payoutQueue,
  league: leagueQueue,
  "gdpr-erasure": gdprErasureQueue,
  "referral-bonus": referralBonusQueue,
  "session-timeout": sessionTimeoutQueue,
  archive: archiveQueue,
};

/**
 * Safe allowlist of queue names an admin may manually requeue jobs from
 * (issue #1041).
 *
 * `gdpr-erasure` is deliberately excluded: erasure jobs irreversibly destroy
 * user data, so blindly re-running an exhausted job is never safe without a
 * fresh review. Every allowlisted processor guards on row state before doing
 * work (e.g. `processPayout` skips challenges that are no longer `ended`),
 * which keeps a manual retry idempotent.
 */
export const RETRYABLE_QUEUE_NAMES = [
  "payout",
  "league",
  "referral-bonus",
  "session-timeout",
  "archive",
] as const;

const retryableQueues: Record<string, Queue> = Object.fromEntries(
  RETRYABLE_QUEUE_NAMES.map((name) => [name, queues[name]])
);

const MAX_FAILED_JOBS_PER_QUEUE = 20;

const RetryBodySchema = z.object({
  queue: z.string().min(1),
});

router.get("/", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const queuesData = await withCoalescing("admin:queue_stats", 5, async () => {
    const entries = await Promise.all(
      Object.entries(queues).map(async ([name, queue]) => {
        try {
          const [counts, logs] = await Promise.all([
            queue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
            queue.getJobLogs("lag"),
          ]);
          return [
            name,
            {
              waiting: counts.waiting ?? 0,
              active: counts.active ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
              delayed: counts.delayed ?? 0,
              lag: logs.count,
            },
          ] as const;
        } catch {
          return [name, { error: "unavailable" }] as const;
        }
      })
    );
    return Object.fromEntries(entries);
  });
  res.json({ queues: queuesData });
});

/**
 * GET /admin/queue-stats/failed
 * List recent failed jobs across all queues so admins can inspect and retry
 * them without dropping into the BullMQ dashboard/CLI (issue #1041).
 */
router.get("/failed", async (_req, res) => {
  res.set("Cache-Control", "no-store");

  const entries = await Promise.all(
    Object.entries(queues).map(async ([name, queue]) => {
      try {
        const jobs = await queue.getJobs(["failed"]);
        return jobs.slice(0, MAX_FAILED_JOBS_PER_QUEUE).map((job) => ({
          id: String(job.id),
          queue: name,
          name: job.name,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason ?? null,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          retryable: (RETRYABLE_QUEUE_NAMES as readonly string[]).includes(name),
        }));
      } catch {
        return [];
      }
    })
  );

  const jobs = entries.flat().sort((a, b) => (b.failedAt ?? "").localeCompare(a.failedAt ?? ""));

  res.json({ jobs });
});

/**
 * POST /admin/queue-stats/:jobId/retry
 * Requeue a specific failed job. Validates the queue is on the retry
 * allowlist, the job exists, and it is actually in the `failed` state before
 * calling BullMQ `job.retry()`. Every retry is audit logged with the job id,
 * queue name, and acting admin id (issue #1041).
 *
 * Body: { queue: string } — the queue the job belongs to.
 */
router.post("/:jobId/retry", async (req, res) => {
  const { jobId } = z.object({ jobId: z.string().min(1).max(200) }).parse(req.params);
  const parsedBody = RetryBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    throw createError("Request body must include a queue name", 400, "VALIDATION_ERROR");
  }
  const { queue: queueName } = parsedBody.data;

  if (!(queueName in retryableQueues)) {
    throw createError(
      `Queue '${queueName}' is not eligible for manual retry`,
      400,
      "QUEUE_NOT_RETRYABLE"
    );
  }

  const queue = retryableQueues[queueName];
  const job = await queue.getJob(jobId);
  if (!job) {
    throw createError("Job not found", 404, "JOB_NOT_FOUND");
  }

  const state = await job.getState();
  if (state !== "failed") {
    throw createError(`Only failed jobs can be retried (job is '${state}')`, 409, "JOB_NOT_FAILED");
  }

  await job.retry();

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES ($1, 'queue_job_retry', 'queue_job', $2, $3::jsonb)`,
    [
      req.user!.sub,
      jobId,
      JSON.stringify({
        jobId,
        queue: queueName,
        jobName: job.name,
        adminId: req.user!.sub,
        previousState: state,
      }),
    ]
  );

  logger.info("Queue job retried by admin", {
    jobId,
    queue: queueName,
    adminId: req.user!.sub,
  });

  res.json({ success: true, jobId, queue: queueName });
});

export default router;
