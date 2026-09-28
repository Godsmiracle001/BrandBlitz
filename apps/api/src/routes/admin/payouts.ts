import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { createError } from "../../middleware/error";
import { query, pool } from "../../db/index";
import { getPayouts } from "../../db/queries/payouts";
import { enqueuePayoutJob } from "../../queues/payout.queue";
import { logger } from "../../lib/logger";
import { CursorQuerySchema } from "../../db/pagination";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

const ListPayoutsSchema = CursorQuerySchema.extend({
  status: z.enum(["all", "pending", "processing", "sent", "confirmed", "failed"]).default("all"),
});

router.get("/", async (req, res) => {
  const { status, limit: pageSize, cursor } = ListPayoutsSchema.parse(req.query);

  const { payouts, nextCursor } = await getPayouts({ status, cursor, pageSize });

  // Summary stats
  const statsResult = await query<{
    total_paid_usdc: string;
    total_pending_usdc: string;
    total_failed: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('sent', 'confirmed') THEN amount_stroops ELSE 0 END) / 10000000, 0)::numeric(20,7)::text AS total_paid_usdc,
       COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN amount_stroops ELSE 0 END) / 10000000, 0)::numeric(20,7)::text AS total_pending_usdc,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS total_failed
     FROM payouts`
  );

  res.json({
    payouts,
    pagination: { pageSize, nextCursor },
    stats: statsResult.rows[0],
  });
});

router.post("/:id/retry", async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

  const payout = await query<{
    id: string;
    challenge_id: string;
    status: string;
  }>(
    "SELECT id, challenge_id, status FROM payouts WHERE id = $1",
    [id]
  );

  if (!payout.rows[0]) throw createError("Payout not found", 404);

  const record = payout.rows[0];
  if (record.status !== "failed") {
    throw createError("Only failed payouts can be retried", 409, "NOT_FAILED");
  }

  // Reset status to pending and write the audit entry atomically before the
  // job is enqueued, so a crash between the two never leaves an audit-less
  // status change.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE payouts SET status = 'pending', error_message = NULL WHERE id = $1",
      [id]
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
       VALUES ($1, 'payout_retry', 'payout', $2, $3::jsonb)`,
      [
        req.user!.sub,
        id,
        JSON.stringify({ payoutId: id, challengeId: record.challenge_id, previousStatus: "failed" }),
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Re-enqueue the payout job after the transaction commits.
  await enqueuePayoutJob(record.challenge_id);

  logger.info("Payout retried by admin", {
    payoutId: id,
    challengeId: record.challenge_id,
    adminId: req.user!.sub,
  });

  res.json({ success: true });
});

export default router;
