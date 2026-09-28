import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { createError } from "../../middleware/error";
import {
  getFraudFlags,
  getFraudFlagById,
  updateFraudFlagStatus,
} from "../../db/queries/fraud-flags";
import { CursorQuerySchema } from "../../db/pagination";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

const ListQuerySchema = CursorQuerySchema.extend({
  status: z.enum(["open", "resolved", "escalated"]).optional(),
}).refine((data) => !("page" in data), {
  message: "Use ?cursor for pagination. Legacy ?page parameter is no longer supported.",
});

const PatchBodySchema = z.object({
  status: z.enum(["resolved", "escalated"]),
  reason: z.string().min(1, "Resolution reason is required"),
}).strict();

/**
 * GET /admin/fraud-flags
 * Paginated list of fraud flags. Supports keyset cursor pagination via ?cursor.
 * Optional ?status= filter.
 */
router.get("/", async (req, res) => {
  const { status, cursor, limit: pageSize } = ListQuerySchema.parse(req.query);
  const { flags, nextCursor } = await getFraudFlags({ status, cursor, pageSize });

  res.json({
    flags: flags.map((f) => ({
      id: f.id,
      sessionId: f.session_id,
      userId: f.user_id,
      userDisplayName: f.user_display_name,
      userEmail: f.user_email,
      challengeId: f.challenge_id,
      flagType: f.flag_type,
      details: f.details,
      status: f.status,
      resolutionReason: f.resolution_reason,
      resolvedBy: f.resolved_by,
      resolvedAt: f.resolved_at,
      createdAt: f.created_at,
      reactionTimes: {
        round1Ms: f.round_1_reaction_ms,
        round2Ms: f.round_2_reaction_ms,
        round3Ms: f.round_3_reaction_ms,
      },
      sessionFlagReasons: f.session_flag_reasons,
      deviceId: f.device_id,
    })),
    pagination: {
      pageSize,
      nextCursor,
    },
  });
});

/**
 * PATCH /admin/fraud-flags/:id
 * Transition flag state: open → resolved | escalated.
 * Resolution reason is required and logged to audit_log.
 */
router.patch("/:id", async (req, res) => {
  const { status, reason } = PatchBodySchema.parse(req.body);

  const existing = await getFraudFlagById(req.params.id);
  if (!existing) throw createError("Fraud flag not found", 404, "NOT_FOUND");

  const updated = await updateFraudFlagStatus(
    req.params.id,
    status,
    reason,
    req.user!.sub
  );

  res.json({
    id: updated!.id,
    status: updated!.status,
    resolutionReason: updated!.resolution_reason,
    resolvedBy: updated!.resolved_by,
    resolvedAt: updated!.resolved_at,
  });
});

export default router;
