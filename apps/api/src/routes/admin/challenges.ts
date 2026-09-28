import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { createError } from "../../middleware/error";
import { softDeleteChallenge, restoreChallenge, getChallengeById } from "../../db/queries/challenges";
import { refundChallenge } from "../../services/refund";
import { enqueuePayout } from "../../services/payout";
import { query } from "../../db/index";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

/**
 * GET /admin/challenges
 * Returns all challenges across all brands for administrative review,
 * including draft and archived challenges not visible through public routes.
 */
router.get("/", async (req, res) => {
  const { page = 1, limit = 20, status } = z.object({
    page: z.string().optional().transform((val) => val ? parseInt(val, 10) : 1),
    limit: z.string().optional().transform((val) => val ? parseInt(val, 10) : 20),
    status: z.enum(["active", "pending_deposit", "ended", "settled", "cancelled", "refunded", "payout_failed"]).optional(),
  }).parse(req.query);

  // Validate pagination parameters
  if (page < 1 || limit < 1 || limit > 100) {
    throw createError("Invalid pagination parameters", 400, "INVALID_PAGINATION");
  }

  const offset = (page - 1) * limit;
  const params: unknown[] = [limit, offset];
  let whereClause = "WHERE c.deleted_at IS NULL";
  let paramCount = 2;

  if (status) {
    paramCount++;
    params.unshift(status);
    whereClause += ` AND c.status = $${paramCount}`;
  }

  const result = await query(
    `SELECT c.*, 
            (c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc,
            b.name AS brand_name,
            b.logo_url AS brand_logo_url
     FROM challenges c
     JOIN brands b ON c.brand_id = b.id
     ${whereClause}
     ORDER BY c.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM challenges c
     ${whereClause}`,
    status ? [status] : []
  );

  const total = countResult.rows[0]?.total ?? 0;

  res.json({
    challenges: result.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

/**
 * GET /admin/challenges/:id/fraud
 * Queries the fraud_flags table joined with game_sessions and users to return
 * sessions flagged by anti-cheat middleware for a given challenge.
 */
router.get("/:id/fraud", async (req, res) => {
  const { id: challengeId } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { page = 1, limit = 20 } = z.object({
    page: z.string().optional().transform((val) => val ? parseInt(val, 10) : 1),
    limit: z.string().optional().transform((val) => val ? parseInt(val, 10) : 20),
  }).parse(req.query);

  // Validate pagination parameters
  if (page < 1 || limit < 1 || limit > 100) {
    throw createError("Invalid pagination parameters", 400, "INVALID_PAGINATION");
  }

  const offset = (page - 1) * limit;

  const result = await query(
    `SELECT 
      ff.id,
      ff.session_id AS "sessionId",
      ff.user_id AS "userId",
      u.username,
      u.email,
      ff.flag_type AS "flagReason",
      ff.details,
      ff.created_at AS "flaggedAt",
      gs.challenge_id AS "challengeId"
     FROM fraud_flags ff
     JOIN game_sessions gs ON ff.session_id = gs.id
     JOIN users u ON ff.user_id = u.id
     WHERE gs.challenge_id = $1
     ORDER BY ff.created_at DESC
     LIMIT $2 OFFSET $3`,
    [challengeId, limit, offset]
  );

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM fraud_flags ff
     JOIN game_sessions gs ON ff.session_id = gs.id
     WHERE gs.challenge_id = $1`,
    [challengeId]
  );

  const total = countResult.rows[0]?.total ?? 0;

  // Verify challenge exists
  const challengeExists = await query(
    "SELECT id FROM challenges WHERE id = $1 AND deleted_at IS NULL",
    [challengeId]
  );

  if (challengeExists.rows.length === 0) {
    throw createError("Challenge not found", 404);
  }

  res.json({
    data: result.rows.map((row: any) => ({
      sessionId: row.sessionId,
      userId: row.userId,
      username: row.username,
      flagReason: row.flagReason,
      flaggedAt: row.flaggedAt,
      details: row.details,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

router.post("/:id/refund", async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { reason } = z
    .object({ reason: z.string().min(1).max(500).default("manual_refund") })
    .parse(req.body ?? {});

  try {
    const refund = await refundChallenge({ challengeId: id, adminId: req.user!.sub, reason });
    res.status(201).json({ refund });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refund failed";
    if (message === "Challenge not found") throw createError(message, 404);
    if (message === "Challenge already settled")
      throw createError(message, 409, "CHALLENGE_SETTLED");
    if (message === "No deposit found") throw createError(message, 404, "NO_DEPOSIT_FOUND");
    throw error;
  }
});

/**
 * POST /admin/challenges/:id/settle
 * Manually trigger payout settlement for a challenge: enqueues the payout
 * BullMQ job and records the action in audit_log.
 */
router.post("/:id/settle", async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

  const challenge = await getChallengeById(id);
  if (!challenge) throw createError("Challenge not found", 404);
  if (challenge.status === "settled") {
    throw createError("Challenge already settled", 409, "CHALLENGE_SETTLED");
  }

  try {
    await enqueuePayout(id, res.locals.requestId);
  } catch (error) {
    throw createError("Settlement failed", 500, "SETTLEMENT_FAILED");
  }

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key)
     VALUES ($1, 'challenge_settle', 'challenge', $2)`,
    [req.user!.sub, id]
  );

  res.status(202).json({ message: "Settlement job enqueued." });
});

/**
 * DELETE /admin/challenges/:id
 * Soft-delete a challenge.
 */
router.delete("/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  await softDeleteChallenge(id);

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key)
     VALUES ($1, 'challenge_soft_delete', 'challenge', $2)`,
    [req.user!.sub, id]
  );

  res.status(204).send();
});

/**
 * POST /admin/challenges/:id/restore
 * Restore a soft-deleted challenge.
 */
router.post("/:id/restore", async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  await restoreChallenge(id);

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key)
     VALUES ($1, 'challenge_restore', 'challenge', $2)`,
    [req.user!.sub, id]
  );

  res.json({ message: "Challenge has been restored." });
});

export default router;
