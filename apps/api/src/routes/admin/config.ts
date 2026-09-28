import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { createError } from "../../middleware/error";
import { getConfig, getConfigRow, setConfig } from "../../db/queries/config";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

const KnownConfigSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("anti_cheat"),
    value: z.object({
      maxSpeedBonusMs: z.number().optional(),
      minReactionTimeMs: z.number().optional(),
    }),
  }),
  z.object({
    key: z.literal("league"),
    value: z.record(z.unknown()), // Fallback schema for league
  }),
  z.object({
    key: z.literal("payout"),
    value: z.record(z.unknown()), // Fallback schema for payout
  }),
  z.object({
    key: z.literal("deposit_required_confirmations"),
    value: z.object({
      confirmations: z.number().int().min(1).max(100),
    }),
  }),
  z.object({
    key: z.literal("escrow_multisig_threshold"),
    value: z.object({
      required: z.number().int().min(1),
      total: z.number().int().min(1),
    }),
  }),
  z.object({
    key: z.literal("rate_limit_requests_per_minute"),
    value: z.object({
      limit: z.number().int().min(1),
    }),
  }),
]);

// .strict() rejects any extra keys in the PATCH body (e.g. {value: ..., injected: ...}).
// The value shape itself is validated by KnownConfigSchema after body parsing.
const PatchConfigSchema = z.object({
  value: z.any(),
}).strict();

/**
 * PATCH /admin/config/:key
 * Update a runtime config value. Audits every change.
 */
router.patch("/:key", async (req, res) => {
  const { value } = PatchConfigSchema.parse(req.body);
  const key = req.params.key;

  // Write-time validation and Unknown-key rejection
  const validated = KnownConfigSchema.parse({ key, value });

  await setConfig(key, validated.value, req.user!.sub);
  const updated = await getConfig(key);
  res.json({ key, value: updated });
});

/**
 * GET /admin/config/:key
 * Retrieve a single config value with change-tracking metadata.
 */
router.get("/:key", async (req, res) => {
  const row = await getConfigRow(req.params.key);
  if (!row) throw createError("Config key not found", 404, "NOT_FOUND");
  res.json({ key: row.key, value: row.value, updated_at: row.updated_at, updated_by: row.updated_by });
});

export default router;
