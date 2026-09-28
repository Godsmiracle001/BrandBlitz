import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/require-admin";
import { getArchivedChallengeById } from "../db/queries/challenges";
import { setConfig } from "../db/queries/config";
import { ensureLeagueRepeatableJobs } from "../queues/league.queue";
import { decodeCursorSafe, encodeCursor } from "../db/pagination";
import { createError } from "../middleware/error";
import { logger } from "../lib/logger";
import { DLQ_QUEUES, DLQ_SOURCE_QUEUES, type DeadLetterPayload } from "../queues/dlq";
import { feeBumpTransaction } from "@brandblitz/stellar";
import { updatePayoutFeeBumpStatus } from "../db/queries/payouts";
import { config } from "../lib/config";
import { pool, query } from "../db/index";
import { webhookRotationLimiter } from "../middleware/rate-limit";
import { sessionTimeoutQueue } from "../queues/session-timeout.queue";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  minFraudScore: z.coerce.number().int().min(0).default(0),
  orderBy: z.enum(["createdAt", "fraudScore"]).default("createdAt"),
});

type AdminUserRow = {
  id: string;
  username: string | null;
  email: string;
  created_at: string;
  suspended_at: string | null;
  fraud_score: number;
  total_payouts: number;
};

router.get("/users", async (req, res) => {
  const { limit, cursor, minFraudScore, orderBy } = ListUsersQuerySchema.parse(req.query);
  const expectedCursorKeys =
    orderBy === "fraudScore" ? ["fraudScore", "createdAt", "id"] : ["createdAt", "id"];
  const cursorValues = decodeCursorSafe(cursor, expectedCursorKeys);

  const params: unknown[] = [minFraudScore];
  let cursorClause = "";

  if (cursorValues) {
    if (orderBy === "fraudScore") {
      params.push(cursorValues.fraudScore, cursorValues.createdAt, cursorValues.id);
      cursorClause = `
        AND (
          fraud_score < $2
          OR (fraud_score = $2 AND created_at < $3)
          OR (fraud_score = $2 AND created_at = $3 AND id < $4)
        )`;
    } else {
      params.push(cursorValues.createdAt, cursorValues.id);
      cursorClause = `
        AND (
          created_at < $2
          OR (created_at = $2 AND id < $3)
        )`;
    }
  }

  params.push(limit + 1);
  const limitParam = params.length;
  const orderClause =
    orderBy === "fraudScore"
      ? "fraud_score DESC, created_at DESC, id DESC"
      : "created_at DESC, id DESC";

  const result = await query<AdminUserRow>(
    `WITH fraud_totals AS (
       SELECT user_id, COUNT(*)::int AS fraud_score
       FROM fraud_flags
       GROUP BY user_id
     ),
     payout_totals AS (
       SELECT user_id, COUNT(*)::int AS total_payouts
       FROM payouts
       GROUP BY user_id
     ),
     user_metrics AS (
       SELECT u.id,
              u.username,
              u.email,
              u.created_at,
              u.suspended_at,
              COALESCE(ft.fraud_score, 0)::int AS fraud_score,
              COALESCE(pt.total_payouts, 0)::int AS total_payouts
       FROM users u
       LEFT JOIN fraud_totals ft ON ft.user_id = u.id
       LEFT JOIN payout_totals pt ON pt.user_id = u.id
       WHERE u.deleted_at IS NULL
     )
     SELECT *
     FROM user_metrics
     WHERE fraud_score >= $1
     ${cursorClause}
     ORDER BY ${orderClause}
     LIMIT $${limitParam}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          ...(orderBy === "fraudScore" ? { fraudScore: last.fraud_score } : {}),
          createdAt: last.created_at,
          id: last.id,
        })
      : null;

  res.json({
    users: rows.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.created_at,
      suspendedAt: user.suspended_at,
      fraudScore: user.fraud_score,
      totalPayouts: user.total_payouts,
    })),
    nextCursor,
  });
});

router.get("/archive/challenges/:id", async (req, res) => {
  const challenge = await getArchivedChallengeById(req.params.id);
  if (!challenge) throw createError("Archived challenge not found", 404);
  res.json({ challenge });
});

const LeagueScheduleSchema = z.object({
  finalizeCron: z
    .string()
    .regex(/^[\d\s\*\/\-\,]+$/)
    .optional(),
  startCron: z
    .string()
    .regex(/^[\d\s\*\/\-\,]+$/)
    .optional(),
});

router.patch("/config/league-schedule", async (req, res) => {
  const body = LeagueScheduleSchema.parse(req.body);

  if (body.finalizeCron) {
    await setConfig("league_cron_finalize", { cron: body.finalizeCron }, req.user!.sub);
  }

  if (body.startCron) {
    await setConfig("league_cron_start", { cron: body.startCron }, req.user!.sub);
  }

  await ensureLeagueRepeatableJobs();

  res.json({
    status: "updated",
    finalizeCron: body.finalizeCron,
    startCron: body.startCron,
  });
});

/**
 * GET /admin/users/:id
 * Full user view with sessions, fraud flags, and payout history.
 * Protected by admin middleware.
 * Response includes profile, recent sessions (last 20), fraud flags, and payout history.
 */
router.get("/users/:id", async (req, res) => {
  const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);

  const userResult = await query<{
    id: string;
    email: string;
    display_name: string;
    username: string;
    avatar_url: string | null;
    status: string;
    suspended_at: string | null;
    suspension_reason: string | null;
    created_at: string;
    total_earned_usdc: string;
    challenges_played: number;
  }>(
    `SELECT id, email, display_name, username, avatar_url, status, suspended_at, suspension_reason, created_at, total_earned_usdc, challenges_played
     FROM users
     WHERE id = $1`,
    [userId]
  );

  if (userResult.rows.length === 0) {
    throw createError("User not found", 404);
  }

  const user = userResult.rows[0];

  const sessionsResult = await query<{
    id: string;
    challenge_id: string;
    score: number;
    completed_at: string;
    duration_ms: number;
  }>(
    `SELECT id, challenge_id, total_score as score, completed_at,
            EXTRACT(EPOCH FROM (completed_at - started_at))::int * 1000 as duration_ms
     FROM game_sessions
     WHERE user_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC
     LIMIT 20`,
    [userId]
  );

  const fraudFlagsResult = await query<{
    id: string;
    flag_type: string;
    severity: string | null;
    created_at: string;
    resolved_at: string | null;
  }>(
    `SELECT id, flag_type,
            CASE WHEN flag_type = 'content_report' THEN 'high' ELSE 'medium' END as severity,
            created_at, resolved_at
     FROM fraud_flags
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  const payoutsResult = await query<{
    id: string;
    amount_usdc: string;
    status: string;
    created_at: string;
    updated_at: string;
    challenge_id: string;
  }>(
    `SELECT id, (amount_stroops::numeric / 10000000)::numeric(20,7)::text as amount_usdc,
            status, created_at, updated_at, challenge_id
     FROM payouts
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  res.json({
    profile: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      username: user.username,
      avatar_url: user.avatar_url,
      status: user.status,
      suspended_at: user.suspended_at,
      suspension_reason: user.suspension_reason,
      created_at: user.created_at,
      total_earned_usdc: user.total_earned_usdc,
      challenges_played: user.challenges_played,
    },
    recentSessions: sessionsResult.rows.map((s) => ({
      sessionId: s.id,
      challengeId: s.challenge_id,
      score: s.score,
      completedAt: s.completed_at,
      durationMs: s.duration_ms,
    })),
    fraudFlags: fraudFlagsResult.rows.map((f) => ({
      id: f.id,
      flagType: f.flag_type,
      severity: f.severity,
      detectedAt: f.created_at,
      resolvedAt: f.resolved_at,
    })),
    payoutHistory: payoutsResult.rows.map((p) => ({
      id: p.id,
      amount_usdc: p.amount_usdc,
      status: p.status,
      created_at: p.created_at,
      updated_at: p.updated_at,
      challenge_id: p.challenge_id,
    })),
  });
});

/**
 * POST /admin/users/:id/suspend
 * Suspend a user account with reason.
 * Sets suspendedAt and suspendReason, enqueues session terminations, logs to audit_log.
 * Protected by admin middleware.
 */
router.post("/users/:id/suspend", async (req, res) => {
  const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);

  const bodySchema = z.object({
    reason: z.string().min(1).max(500),
    durationDays: z.number().int().positive().optional(),
  });

  const body = bodySchema.parse(req.body);

  const userResult = await query<{
    id: string;
    status: string;
    suspended_at: string | null;
  }>(`SELECT id, status, suspended_at FROM users WHERE id = $1`, [userId]);

  if (userResult.rows.length === 0) {
    throw createError("User not found", 404);
  }

  const user = userResult.rows[0];

  if (user.status === "suspended" && user.suspended_at) {
    throw createError("User is already suspended", 409);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE users SET status = 'suspended', suspended_at = NOW(), suspension_reason = $1, suspended_by = $2
       WHERE id = $3`,
      [body.reason, req.user!.sub, userId]
    );

    await client.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, metadata)
       VALUES ('suspend', 'user', $1, $2::jsonb)`,
      [
        userId,
        JSON.stringify({
          reason: body.reason,
          duration_days: body.durationDays || null,
          performed_by: req.user!.sub,
        }),
      ]
    );

    const sessionsResult = await client.query(
      `SELECT id FROM game_sessions WHERE user_id = $1 AND status != 'completed'`,
      [userId]
    );

    for (const session of sessionsResult.rows) {
      await sessionTimeoutQueue.add(
        "terminate-session",
        { sessionId: session.id },
        { attempts: 2, removeOnComplete: true }
      );
    }

    await client.query("COMMIT");
    res.status(200).json({ success: true, suspended_user_id: userId });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /admin/brands/:id/webhooks/deliveries
 * Admin route to view brand webhook delivery status and history.
 */
router.get("/brands/:id/webhooks/deliveries", async (req, res) => {
  const { getBrandWebhookDeliveries } = await import("../services/brand-webhooks");
  const deliveries = await getBrandWebhookDeliveries(req.params.id);
  res.json({ deliveries });
});

export default router;
