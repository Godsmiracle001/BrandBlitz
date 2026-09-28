import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { createError } from "../middleware/error";
import {
  getCurrentLegalDocument,
  getLegalDocumentByVersion,
  recordUserLegalAcceptance,
  findUserLegalAcceptance,
  getAcceptedVersions,
} from "../db/queries/legal";
import {
  GDPR_ERASURE_ACTION,
  GDPR_ERASURE_CLEARED_COLUMNS,
} from "../db/queries/gdpr";

const router = Router();

const ERASURE_GRACE_PERIOD_DAYS = 30;

const AcceptSchema = z.object({
  type: z.enum(["tos", "privacy"]),
  version: z.string().min(1),
});

/**
 * GET /legal/erasure
 * Public GDPR right-to-erasure manifest: the exhaustive list of table.columns
 * that a completed erasure clears. Kept in sync with the erasure worker via the
 * shared GDPR_ERASURE_CLEARED_COLUMNS constant so the disclosure never drifts
 * from what is actually anonymised (includes game_sessions.device_id).
 */
router.get("/erasure", (_req, res) => {
  res.json({
    erasure: {
      action: GDPR_ERASURE_ACTION,
      gracePeriodDays: ERASURE_GRACE_PERIOD_DAYS,
      clearedColumns: GDPR_ERASURE_CLEARED_COLUMNS,
    },
  });
});

/**
 * GET /legal/:type/current
 * Returns the currently-effective document of the given type.
 */
router.get("/:type/current", async (req, res) => {
  const type = z.enum(["tos", "privacy"]).parse(req.params.type);
  const doc = await getCurrentLegalDocument(type);
  if (!doc) throw createError("No current version found", 404);
  res.json({ document: doc });
});

/**
 * GET /legal/:type/:version
 * Returns a specific version of a document.
 */
router.get("/:type/:version", async (req, res) => {
  const type = z.enum(["tos", "privacy"]).parse(req.params.type);
  const doc = await getLegalDocumentByVersion(type, req.params.version);
  if (!doc) throw createError("Document not found", 404);
  res.json({ document: doc });
});

/**
 * POST /legal/accept
 * Record that the user has accepted a specific version.
 */
router.post("/accept", authenticate, async (req, res) => {
  const { type, version } = AcceptSchema.parse(req.body);

  const current = await getCurrentLegalDocument(type);
  if (current && current.version !== version) {
    throw createError(
      `Version mismatch: current ${type} version is ${current.version}`,
      400,
      "LEGAL_VERSION_MISMATCH"
    );
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  const acceptance = await recordUserLegalAcceptance(req.user!.sub, type, version, ip);
  res.status(201).json({ acceptance });
});

/**
 * GET /legal/status
 * Returns whether the user has accepted the latest version of each document type.
 */
router.get("/status", authenticate, async (req, res) => {
  const tos = await getCurrentLegalDocument("tos");
  const privacy = await getCurrentLegalDocument("privacy");

  const [tosAcceptance, privacyAcceptance, tosAcceptedVersions, privacyAcceptedVersions] = await Promise.all([
    tos ? findUserLegalAcceptance(req.user!.sub, "tos", tos.version) : Promise.resolve(null),
    privacy ? findUserLegalAcceptance(req.user!.sub, "privacy", privacy.version) : Promise.resolve(null),
    getAcceptedVersions(req.user!.sub, "tos"),
    getAcceptedVersions(req.user!.sub, "privacy"),
  ]);

  res.json({
    tos: {
      current: tos ?? null,
      accepted: !!tosAcceptance,
      acceptedVersions: tosAcceptedVersions,
    },
    privacy: {
      current: privacy ?? null,
      accepted: !!privacyAcceptance,
      acceptedVersions: privacyAcceptedVersions,
    },
  });
});

export default router;
