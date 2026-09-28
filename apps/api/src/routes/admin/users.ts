import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { createError } from "../../middleware/error";
import { findUserById, restoreUser, suspendUser, unsuspendUser } from "../../db/queries/users";
import { createErasureRequest, findPendingErasureRequest } from "../../db/queries/gdpr";
import { enqueueGdprErasure } from "../../queues/gdpr-erasure.queue";
import { query } from "../../db/index";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

// ── Schemas ──────────────────────────────────────────────────────────────────

const SuspendBodySchema = z
  .object({
    reason: z.string().min(1, "Suspension reason is required").max(500),
  })
  .strict();

/**
 * PATCH /admin/users/:userId/suspend
 * Suspend a user account. Reason is required and logged to audit_log.
 * Closes #140
 */
router.patch("/:userId/suspend", async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
  const { reason } = SuspendBodySchema.parse(req.body);

  const target = await findUserById(userId);
  if (!target) throw createError("User not found", 404);
  if (target.status === "suspended") {
    throw createError("User is already suspended", 409, "ALREADY_SUSPENDED");
  }
  if (target.role === "admin") {
    throw createError("Cannot suspend an admin user", 403, "FORBIDDEN");
  }

  const updated = await suspendUser(userId, reason, req.user!.sub);
  if (!updated) throw createError("Failed to suspend user", 500);

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES ($1, 'user_suspend', 'user', $2, $3)`,
    [req.user!.sub, userId, JSON.stringify({ reason, suspendedAt: updated.suspended_at })]
  );

  res.json({
    message: "User has been suspended.",
    user: {
      id: updated.id,
      status: updated.status,
      suspensionReason: updated.suspension_reason,
      suspendedAt: updated.suspended_at,
    },
  });
});

// ── Unsuspend user ───────────────────────────────────────────────────────────

/**
 * PATCH /admin/users/:userId/unsuspend
 * Reverse a suspension. Logged to audit_log.
 */
router.patch("/:userId/unsuspend", async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);

  const target = await findUserById(userId);
  if (!target) throw createError("User not found", 404);
  if (target.status !== "suspended") {
    throw createError("User is not currently suspended", 409, "NOT_SUSPENDED");
  }

  const updated = await unsuspendUser(userId);
  if (!updated) throw createError("Failed to unsuspend user", 500);

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, before)
     VALUES ($1, 'user_unsuspend', 'user', $2, $3)`,
    [
      req.user!.sub,
      userId,
      JSON.stringify({
        previousReason: target.suspension_reason,
        suspendedAt: target.suspended_at,
      }),
    ]
  );

  res.json({
    message: "User suspension has been lifted.",
    user: {
      id: updated.id,
      status: updated.status,
    },
  });
});

/**
 * DELETE /admin/users/:userId/suspend
 * Clear a user's suspension by nulling suspendedAt and suspendReason.
 * Performs the operation inside a database transaction that also inserts an
 * audit_log row with action 'unsuspend' so the compliance trail remains
 * intact alongside the original suspension entry.
 *
 * Protected by requireAdmin; non-admins receive 403.
 * The require-active-user middleware must NOT run on admin routes.
 *
 * Closes #461
 */
router.delete("/:userId/suspend", async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);

  const target = await findUserById(userId);
  if (!target) throw createError("User not found", 404);
  if (target.status !== "suspended" || !target.suspended_at) {
    throw createError("User is not currently suspended", 409, "NOT_SUSPENDED");
  }

  const updated = await unsuspendUser(userId);
  if (!updated) throw createError("Failed to unsuspend user", 500);

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, before, after)
     VALUES ($1, 'unsuspend', 'user', $2, $3, $4)`,
    [
      req.user!.sub,
      userId,
      JSON.stringify({
        suspendedAt: target.suspended_at,
        suspensionReason: target.suspension_reason,
      }),
      JSON.stringify({
        suspendedAt: null,
        suspensionReason: null,
      }),
    ],
  );

  res.json({
    message: "User suspension has been lifted.",
    user: {
      id: updated.id,
      status: updated.status,
      suspendedAt: updated.suspended_at,
    },
  });
});

// ── GDPR Erasure ─────────────────────────────────────────────────────────────

/**
 * POST /admin/users/:userId/erase
 * Trigger a GDPR right-to-erasure for a specific user on behalf of legal/compliance.
 * Subject to the same 30-day grace period as a self-serve request.
 * Every invocation is audit-logged.
 */
router.post("/:userId/erase", async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);

  const target = await findUserById(userId);
  if (!target) throw createError("User not found", 404);

  const existing = await findPendingErasureRequest(userId);
  if (existing) throw createError("A deletion request is already pending for this user", 409);

  const erasureRequest = await createErasureRequest(userId, req.user!.sub);
  await enqueueGdprErasure({ userId, requestId: erasureRequest.id });

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
     VALUES ($1, 'gdpr_erasure_request', 'user', $2, $3)`,
    [
      req.user!.sub,
      userId,
      JSON.stringify({ requestId: erasureRequest.id, executeAt: erasureRequest.execute_at }),
    ]
  );

  res.status(202).json({
    message: "GDPR erasure request created. Data will be anonymised after 30 days.",
    requestId: erasureRequest.id,
    executeAt: erasureRequest.execute_at,
  });
});

/**
 * POST /admin/users/:userId/restore
 * Restore a soft-deleted user account.
 */
router.post("/:userId/restore", async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);

  await restoreUser(userId);

  await query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_key)
     VALUES ($1, 'user_restore', 'user', $2)`,
    [req.user!.sub, userId]
  );

  res.json({ message: "User account has been restored." });
});

export default router;
