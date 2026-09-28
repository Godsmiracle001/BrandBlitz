import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  createBrand,
  getBrandById,
  getPublicBrandById,
  getPublicBrands,
  getBrandMetaById,
  getActiveDistractorBrands,
  toBrandApi,
  toPublicBrandApi,
  updateBrand,
  deleteBrand,
  getBrandChallengeStats,
  getBrandsByOwner,
} from "../db/queries/brands";
import { getBrandAnalytics, getBrandBenchmark, BUCKET_LABELS } from "../db/queries/analytics";
import {
  createChallenge,
  insertChallengeQuestions,
  getChallengeQuestions,
  getChallengesByBrandId,
  deleteChallengeQuestion,
  insertChallengeQuestion,
} from "../db/queries/challenges";
import { generateChallengeQuestions, generateQuestionPreview } from "../services/questions";
import { optimizeImage, StorageError } from "@brandblitz/storage";
import { authenticate } from "../middleware/authenticate";
import { requireCurrentTosAccepted } from "../middleware/require-tos";
import { createError } from "../middleware/error";
import { logger } from "../lib/logger";
import { config } from "../lib/config";
import { generateDepositMemo, MIN_POOL_STROOPS } from "@brandblitz/stellar";
import { query } from "../db/index";
import { apiLimiter, questionPreviewLimiter } from "../middleware/rate-limit";
import { decodeCursorSafe, encodeCursor } from "../db/pagination";
import { sanitizeSvgText } from "../lib/svg-sanitize";
import { withCoalescing } from "../lib/cache";
import {
  createBrandWebhook,
  getBrandWebhooks,
  getBrandWebhookDeliveries,
} from "../services/brand-webhooks";
import {
  createChallengeTemplate,
  getChallengeTemplatesByBrandId,
  getChallengeTemplateById,
  pauseChallengeTemplate,
  resumeChallengeTemplate,
  softDeleteChallengeTemplate,
  getUpcomingChallengesFromTemplatesByBrandId,
  type RecurrenceRule,
} from "../db/queries/challenge-templates";
import {
  acquireChallengeLicense,
  getBrandLicenses,
  getUsableLicense,
  listLicenseMarketplace,
  setChallengeLicenseOffer,
} from "../db/queries/challenge-licenses";

const router = Router();
const PublicBrandsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const BrandCatalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "pending"]).optional(),
});

type BrandCatalogRow = {
  id: string;
  name: string;
  logo_url: string | null;
  status: "active" | "inactive" | "pending";
  created_at: string;
};
const BrandKitSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((v) => !/<[^>]*>/.test(v), {
      message: "Brand name must not contain HTML tags",
    }),
  logoKey: z.string().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  tagline: z.string().max(100).optional(),
  brandStory: z.string().max(500).optional(),
  usp: z.string().max(200).optional(),
  productImage1Key: z.string().optional(),
  productImage2Key: z.string().optional(),
});

const ChallengeSchema = z.object({
  brandId: z.string().uuid(),
  poolAmountUsdc: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/)
    .refine(
      (val) => {
        // Convert USDC amount to stroops and check minimum
        const stroops = Math.round(parseFloat(val) * 10_000_000);
        return stroops >= MIN_POOL_STROOPS;
      },
      {
        message: `Pool amount must be at least 100 USDC (${MIN_POOL_STROOPS.toLocaleString()} stroops)`,
      }
    ),
  maxPlayers: z.number().int().positive().optional(),
  endsAt: z.string().datetime(),
  licenseId: z.string().uuid().optional(),
});

const LicenseChallengeSchema = z.object({ challengeId: z.string().uuid() }).strict();
const LicenseOfferSchema = z
  .object({ available: z.boolean(), feeBps: z.number().int().min(0).max(5000) })
  .strict();

const MIN_CHALLENGE_DURATION_MS = 60 * 60 * 1000;
const CHALLENGE_DURATION_GRACE_MS = 5_000;

const QuestionRoundTemplateSchema = z
  .object({
    question_text: z.string().max(500).optional(),
    prompt_type: z.enum(["logo", "tagline", "productImage1"]).optional(),
  })
  .strict();

const QuestionTemplateSchema = z
  .object({
    round_1: QuestionRoundTemplateSchema.optional(),
    round_2: QuestionRoundTemplateSchema.optional(),
    round_3: QuestionRoundTemplateSchema.optional(),
  })
  .strict()
  .nullable();

const PatchBrandSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    logo_url: z.string().url().nullable().optional(),
    primary_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    secondary_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    tagline: z.string().max(100).nullable().optional(),
    brand_story: z.string().max(500).nullable().optional(),
    usp: z.string().max(200).nullable().optional(),
    question_template: QuestionTemplateSchema.optional(),
  })
  .strict();

function validateChallengeEndsAt(endsAt: string): void {
  const endsAtMs = new Date(endsAt).getTime();
  const nowMs = Date.now();
  const minEndsAtMs = nowMs + MIN_CHALLENGE_DURATION_MS;

  if (endsAtMs <= nowMs) {
    throw createError("Challenge end time must be in the future", 400, "ENDS_AT_PAST");
  }

  if (endsAtMs < minEndsAtMs - CHALLENGE_DURATION_GRACE_MS) {
    throw createError("Challenge duration must be at least 1 hour", 400, "ENDS_AT_TOO_SOON");
  }
}

/**
 * GET /brands/public
 * Public directory of all brands with active challenge counts. No auth required.
 */
router.get("/public", async (req, res) => {
  const result = await query<{
    id: string;
    name: string;
    tagline: string | null;
    logo_url: string | null;
    primary_color: string | null;
    category: string | null;
    active_challenge_count: number;
  }>(
    `SELECT
       b.id,
       b.name,
       b.tagline,
       b.logo_url,
       b.primary_color,
       NULL AS category,
       COUNT(c.id) FILTER (WHERE c.status = 'active')::int AS active_challenge_count
     FROM brands b
     LEFT JOIN challenges c ON c.brand_id = b.id
     WHERE b.deleted_at IS NULL
     GROUP BY b.id
     ORDER BY b.name ASC`
  );

  res.json({ brands: result.rows });
});

/**
 * GET /brands
 * Authenticated, rate-limited brand catalog with forward-only cursor pagination.
 */
router.get("/", authenticate, apiLimiter, async (req, res) => {
  const { limit, cursor, search, status } = BrandCatalogQuerySchema.parse(req.query);
  const filters: string[] = [];
  const filterParams: unknown[] = [];

  if (search) {
    filterParams.push(`%${search}%`);
    filters.push(`name ILIKE $${filterParams.length}`);
  }

  if (status) {
    filterParams.push(status);
    filters.push(`status = $${filterParams.length}`);
  }

  const filterClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const catalogCte = `WITH brand_catalog AS (
    SELECT b.id,
           b.name,
           b.logo_url,
           b.created_at,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM challenges c
               WHERE c.brand_id = b.id AND c.status = 'active' AND c.deleted_at IS NULL
             ) THEN 'active'
             WHEN EXISTS (
               SELECT 1 FROM challenges c
               WHERE c.brand_id = b.id AND c.status = 'pending_deposit' AND c.deleted_at IS NULL
             ) THEN 'pending'
             ELSE 'inactive'
           END AS status
    FROM brands b
    WHERE b.deleted_at IS NULL
  )`;

  const totalResult = await query<{ total: number }>(
    `${catalogCte}
     SELECT COUNT(*)::int AS total
     FROM brand_catalog
     ${filterClause}`,
    filterParams
  );

  const pageParams = [...filterParams];
  let cursorClause = "";
  const cursorValues = decodeCursorSafe(cursor, ["createdAt", "id"]);
  if (cursorValues) {
    pageParams.push(cursorValues.createdAt, cursorValues.id);
    cursorClause = `AND (
      created_at < $${pageParams.length - 1}
      OR (created_at = $${pageParams.length - 1} AND id < $${pageParams.length})
    )`;
  }

  pageParams.push(limit + 1);
  const pageResult = await query<BrandCatalogRow>(
    `${catalogCte}
     SELECT id, name, logo_url, status, created_at
     FROM brand_catalog
     ${filterClause}
     ${filters.length > 0 ? cursorClause : cursorClause.replace(/^AND/, "WHERE")}
     ORDER BY created_at DESC, id DESC
     LIMIT $${pageParams.length}`,
    pageParams
  );

  const hasMore = pageResult.rows.length > limit;
  const items = pageResult.rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  res.json({
    items,
    nextCursor,
    total: totalResult.rows[0]?.total ?? 0,
  });
});

/** GET /brands/mine — owned brands with their challenges for the management dashboard. */
router.get("/mine", authenticate, async (req, res) => {
  const ownedBrands = await getBrandsByOwner(req.user!.sub);
  const brands = await Promise.all(
    ownedBrands.map(async (brand) => ({
      ...toBrandApi(brand),
      challenges: (await getChallengesByBrandId(brand.id)).map((challenge) => ({
        id: challenge.id,
        status: challenge.status,
        poolAmountUsdc: challenge.pool_amount_usdc,
        participantCount: challenge.participant_count ?? 0,
        endsAt: challenge.ends_at,
      })),
    }))
  );
  res.json({ brands });
});

/** GET /brands/license-marketplace — challenges explicitly offered for licensing. */
router.get("/license-marketplace", authenticate, async (req, res) => {
  const ownedBrands = await getBrandsByOwner(req.user!.sub);
  const offers = await listLicenseMarketplace(ownedBrands.map((brand) => brand.id));
  res.json({ offers });
});

/** GET /brands/:id/licenses — offered, issued, and acquired licenses for a dashboard. */
router.get("/:id/licenses", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);
  res.json(await getBrandLicenses(brand.id));
});

/** POST /brands/:id/license-challenge — acquire an immutable fee snapshot. */
router.post("/:id/license-challenge", authenticate, async (req, res) => {
  const licensee = await getBrandById(req.params.id);
  if (!licensee) throw createError("Brand not found", 404);
  if (licensee.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const body = LicenseChallengeSchema.parse(req.body);
  const license = await acquireChallengeLicense({
    sourceChallengeId: body.challengeId,
    licenseeBrandId: licensee.id,
  });
  if (!license) {
    throw createError("Challenge is unavailable or already licensed", 409, "LICENSE_UNAVAILABLE");
  }
  res.status(201).json({ license });
});

/** PATCH /brands/:id/challenges/:challengeId/licensing — opt in/out for future licenses. */
router.patch("/:id/challenges/:challengeId/licensing", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);
  const body = LicenseOfferSchema.parse(req.body);
  const offer = await setChallengeLicenseOffer({
    challengeId: req.params.challengeId,
    brandId: brand.id,
    available: body.available,
    feeBps: body.feeBps,
  });
  if (!offer) throw createError("Challenge not found", 404);
  res.json({ offer });
});

/**
 * GET /brands/:id/distractors
 * Return up to three public-safe alternate brands for a game round.
 */
router.get("/:id/distractors", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);

  const distractors = (await getActiveDistractorBrands(brand.id))
    .slice(0, 3)
    .map(({ id, name, logo_url }) => ({ id, name, logo_url }));

  res.json({ distractors });
});
/**
 * GET /brands/:id
 */
router.get("/:id", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);
  res.json({ brand: toBrandApi(brand) });
});

/**
 * GET /brands/:id/analytics
 * Returns aggregated analytics data for the brand's challenges.
 */
router.get("/:id/analytics", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const fromParam = req.query.from as string | undefined;
  const toParam = req.query.to as string | undefined;

  let from: Date | undefined;
  let to: Date | undefined;

  if (fromParam) {
    from = new Date(fromParam);
    if (isNaN(from.getTime())) throw createError("Invalid from date", 400);
  }
  if (toParam) {
    to = new Date(toParam);
    if (isNaN(to.getTime())) throw createError("Invalid to date", 400);
  }

  const cacheKey = `brand_analytics:${brand.id}:${fromParam || "all"}:${toParam || "all"}`;
  const analytics = await withCoalescing(cacheKey, 900, () =>
    getBrandAnalytics(brand.id, from, to)
  );
  res.json({ analytics });
});

/**
 * GET /brands/:id/benchmark
 * Anonymized benchmark comparison: the brand's completion rate and
 * cost-per-session next to platform-wide medians for its size bucket.
 *
 * Only aggregate medians are returned — individual competitor brand data is
 * never exposed. Brands with fewer than BENCHMARK_MIN_CHALLENGES challenges
 * are excluded from the platform medians (statistical noise guard) and get
 * `platform.sampleSize === 0` until they qualify.
 */
router.get("/:id/benchmark", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const benchmark = await withCoalescing(`brand_benchmark:${brand.id}`, 900, () =>
    getBrandBenchmark(brand.id)
  );

  res.json({
    benchmark: {
      ...benchmark,
      platform: {
        ...benchmark.platform,
        bucketLabel: BUCKET_LABELS[benchmark.platform.sizeBucket],
      },
    },
  });
});

/**
 * PATCH /brands/:id
 * Update mutable brand fields. Currently accepts question_template to allow
 * brand owners to override question text and prompt type per round.
 * Sends 422 on invalid question_template shape.
 */
router.patch("/:id", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const result = PatchBrandSchema.safeParse(req.body);
  if (!result.success) {
    throw createError("Invalid request body", 422, "INVALID_QUESTION_TEMPLATE");
  }

  const updates = result.data;
  if (Object.keys(updates).length === 0) {
    res.json({ brand: toBrandApi(brand) });
    return;
  }

  const updated = await updateBrand(req.params.id, req.user!.sub, {
    ...updates,
    question_template: updates.question_template as Record<string, unknown> | null | undefined,
  } as Parameters<typeof updateBrand>[2]);

  if (!updated) throw createError("Brand not found", 404);
  res.json({ brand: toBrandApi(updated) });
});

/**
 * DELETE /brands/:id
 * Soft-delete a brand kit (prevents new activity; existing challenges continue).
 */
router.delete("/:id", authenticate, async (req, res) => {
  const meta = await getBrandMetaById(req.params.id);
  if (!meta || meta.deleted_at) throw createError("Brand not found", 404);
  const isAdmin = req.user!.role === "admin" || req.user!.role === "super_admin";
  if (meta.owner_user_id !== req.user!.sub && !isAdmin) {
    throw createError("Forbidden", 403);
  }

  const deleted = await deleteBrand(req.params.id, isAdmin ? undefined : req.user!.sub);
  if (!deleted) throw createError("Brand not found", 404);

  res.status(200).json({
    brand: { id: req.params.id, deleted_at: deleted.deletedAt },
    cancelledChallenges: deleted.cancelledChallenges,
  });
});

/**
 * GET /brands/:id/dashboard
 * Get aggregated challenge stats for a brand's dashboard.
 * Uses the brand_challenge_stats view for efficient single-query aggregation.
 */
router.get("/:id/dashboard", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const stats = await getBrandChallengeStats(brand.id);
  res.json({ stats });
});

/**
 * GET /brands/:id/questions/preview
 * Returns questions (with correct answers) for the latest challenge of a brand.
 * Accessible only to the brand owner for previewing before launch.
 */
router.get("/:id/questions/preview", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const { challenges } = await getChallengesByBrandId(brand.id, 1);
  if (challenges.length === 0) {
    res.json({ questions: [], challenge: null });
    return;
  }

  const challenge = challenges[0];
  const questions = await getChallengeQuestions(challenge.id);
  res.json({ questions, challenge });
});

const QuestionPreviewSchema = z.object({
  topic: z.string().min(1).max(200),
  difficulty: z.enum(["easy", "medium", "hard"]),
  count: z.number().int().min(3).max(10),
});

/**
 * POST /brands/:id/questions/preview
 * Generate a draft set of questions from the brand's brief without
 * persisting anything to challenge_questions. Lets a brand owner review AI
 * questions before committing to a challenge. Idempotent — no DB writes.
 */
router.post("/:id/questions/preview", authenticate, questionPreviewLimiter, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const { count } = QuestionPreviewSchema.parse(req.body);

  const distractorBrands = await getActiveDistractorBrands(brand.id);
  const questions = generateQuestionPreview(brand, distractorBrands, count);

  res.json({ questions });
});

/**
 * POST /brands/:id/questions/:questionId/regenerate
 * Delete a question and regenerate it for the same round.
 * Returns the new question with correct_answer.
 */
router.post("/:id/questions/:questionId/regenerate", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const { questionId } = req.params;
  const allQuestions = await query<{
    id: string;
    challenge_id: string;
    round: 1 | 2 | 3;
  }>("SELECT id, challenge_id, round FROM challenge_questions WHERE id = $1", [questionId]);
  const existing = allQuestions.rows[0];
  if (!existing) throw createError("Question not found", 404);

  const challenge = await getBrandById(brand.id);
  if (!challenge) throw createError("Brand not found", 404);

  const distractorBrands = await getActiveDistractorBrands(brand.id);
  const regenerated = generateChallengeQuestions(existing.challenge_id, brand, distractorBrands);
  const newDraft = regenerated.find((q) => q.round === existing.round) ?? regenerated[0];

  await deleteChallengeQuestion(questionId);
  const inserted = await insertChallengeQuestion({
    ...newDraft,
    challenge_id: existing.challenge_id,
  });

  res.json({ question: inserted });
});

/**
 * POST /brands/:id/questions/:questionId/approve
 * Mark a question as approved.
 */
router.post("/:id/questions/:questionId/approve", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const { questionId } = req.params;
  await query("UPDATE challenge_questions SET approved = true WHERE id = $1", [questionId]);
  res.json({ success: true });
});

/**
 * POST /brands/:id/questions/:questionId/flag
 * Mark a question as flagged for regeneration.
 */
router.post("/:id/questions/:questionId/flag", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const { questionId } = req.params;
  await query("UPDATE challenge_questions SET approved = false WHERE id = $1", [questionId]);
  res.json({ success: true });
});

/**
 * POST /brands
 * Create a brand kit. Optimizes uploaded images immediately.
 */
router.post("/", authenticate, async (req, res) => {
  const body = BrandKitSchema.parse(req.body);
  const userId = req.user!.sub;

  let logoUrl: string | undefined;
  const productImageKeys: string[] = [];

  // Optimize uploaded images server-side (converts to WebP, resizes)
  try {
    if (body.logoKey) {
      const optimizedKey = await optimizeImage(body.logoKey, "brand-logo");
      const { getPublicUrl, BUCKETS } = await import("@brandblitz/storage");
      logoUrl = getPublicUrl(BUCKETS.BRAND_ASSETS, optimizedKey);
    }
    if (body.productImage1Key) {
      const optimizedKey = await optimizeImage(body.productImage1Key, "product-image");
      productImageKeys.push(optimizedKey);
    }
    if (body.productImage2Key) {
      const optimizedKey = await optimizeImage(body.productImage2Key, "product-image");
      productImageKeys.push(optimizedKey);
    }
  } catch (error) {
    if (error instanceof StorageError || (error as any).name === "StorageError") {
      console.error(
        `[api] Image optimization failed for body key. Reason: ${(error as Error).message}`
      );
      throw createError(
        "Image upload could not be processed. Please try again with a valid image.",
        400
      );
    }
    throw error;
  }

  const brand = await createBrand({
    owner_user_id: userId,
    name: sanitizeSvgText(body.name),
    logo_url: logoUrl ?? null,
    primary_color: body.primaryColor ?? null,
    secondary_color: body.secondaryColor ?? null,
    tagline: body.tagline ? sanitizeSvgText(body.tagline) : null,
    brand_story: body.brandStory ?? null,
    usp: body.usp ?? null,
    product_image_keys: productImageKeys,
  });

  res.status(201).json({ brand: toBrandApi(brand) });
});

/**
 * POST /brands/challenges
 * Create a new challenge and generate questions from brand kit.
 * Returns a unique Stellar text memo for the deposit instructions.
 */
router.post("/challenges", authenticate, requireCurrentTosAccepted, async (req, res) => {
  const parsedBody = ChallengeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    throw createError("Invalid challenge fields", 422, "VALIDATION_ERROR");
  }
  const body = parsedBody.data;
  validateChallengeEndsAt(body.endsAt);

  const brand = await getBrandById(body.brandId);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const license = body.licenseId ? await getUsableLicense(body.licenseId, brand.id) : null;
  if (body.licenseId && !license) {
    throw createError("License not found for this brand", 422, "INVALID_LICENSE");
  }

  const challengeId = randomUUID();
  const depositMemo = generateDepositMemo();
  const challenge = await createChallenge({
    brandId: body.brandId,
    challengeId,
    depositMemo,
    poolAmountUsdc: body.poolAmountUsdc,
    maxPlayers: body.maxPlayers,
    endsAt: body.endsAt,
    licenseId: license?.id,
  });

  const distractorBrands = await getActiveDistractorBrands(body.brandId);
  if (distractorBrands.length === 0) {
    logger.warn("Distractor pool is empty; using fallback options for generated questions", {
      brandId: body.brandId,
      challengeId: challenge.id,
    });
  }

  // Auto-generate questions from brand kit (uses other brands as distractors if available)
  const questions = generateChallengeQuestions(challenge.id, brand, distractorBrands);
  await insertChallengeQuestions(questions);

  res.status(201).json({
    challenge,
    depositInstructions: {
      hotWalletAddress: config.HOT_WALLET_PUBLIC_KEY,
      memo: depositMemo,
      amount: body.poolAmountUsdc,
      asset: "USDC",
      note: `Send exactly ${body.poolAmountUsdc} USDC to the hot wallet with memo: ${depositMemo}`,
    },
  });
});

const RecurrenceRuleSchema: z.ZodType<RecurrenceRule> = z.enum([
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "custom",
]);

const ChallengeTemplateSchema = z
  .object({
    poolAmountUsdc: z
      .string()
      .regex(/^\d+(\.\d{1,7})?$/)
      .refine(
        (val) => {
          const stroops = Math.round(parseFloat(val) * 10_000_000);
          return stroops >= MIN_POOL_STROOPS;
        },
        {
          message: `Pool amount must be at least 100 USDC (${MIN_POOL_STROOPS.toLocaleString()} stroops)`,
        }
      ),
    maxPlayers: z.number().int().positive().optional(),
    durationHours: z.number().int().min(1),
    recurrenceRule: RecurrenceRuleSchema,
    recurrenceCron: z.string().optional(),
    recurrenceTimezone: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.recurrenceRule === "custom" && !val.recurrenceCron) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recurrenceCron is required for custom recurrence rule",
        path: ["recurrenceCron"],
      });
    }
  });

const WebhookSubscriptionSchema = z.object({
  url: z.string().url("url must be a valid URL"),
  secret: z.string().min(16).optional(),
  eventTypes: z.array(z.string()).optional(),
});

/**
 * POST /brands/:id/challenge-templates
 * Create a recurring challenge template that auto-spawns challenges on a schedule.
 */
router.post(
  "/:id/challenge-templates",
  authenticate,
  requireCurrentTosAccepted,
  async (req, res) => {
    const brand = await getBrandById(req.params.id);
    if (!brand) throw createError("Brand not found", 404);
    if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
      throw createError("Forbidden", 403);
    }

    const parsed = ChallengeTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        422,
        "VALIDATION_ERROR"
      );
    }
    const body = parsed.data;

    const template = await createChallengeTemplate({
      brandId: brand.id,
      poolAmountUsdc: body.poolAmountUsdc,
      maxPlayers: body.maxPlayers,
      durationHours: body.durationHours,
      recurrenceRule: body.recurrenceRule,
      recurrenceCron: body.recurrenceCron,
      recurrenceTimezone: body.recurrenceTimezone,
    });

    res.status(201).json({ template });
  }
);

/**
 * GET /brands/:id/challenge-templates
 * List challenge templates for a brand (ordered by most recently created).
 */
router.get("/:id/challenge-templates", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const templates = await getChallengeTemplatesByBrandId(brand.id);
  res.json({ templates });
});

/**
 * GET /brands/:id/challenge-templates/upcoming
 * Preview upcoming auto-generated challenges (start/end times and pools)
 * derived from active templates.
 */
router.get("/:id/challenge-templates/upcoming", authenticate, async (req, res) => {
  const brand = await getBrandById(req.params.id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? "5"), 10) || 5));
  const upcoming = await getUpcomingChallengesFromTemplatesByBrandId(brand.id, limit);
  res.json({ upcoming });
});

/**
 * PATCH /brands/challenge-templates/:templateId/pause
 * Pause a template so it no longer spawns new challenges.
 * Existing spawned challenges are unaffected.
 */
router.patch("/challenge-templates/:templateId/pause", authenticate, async (req, res) => {
  const template = await getChallengeTemplateById(req.params.templateId);
  if (!template) throw createError("Template not found", 404);

  const brand = await getBrandById(template.brand_id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const updated = await pauseChallengeTemplate(template.id);
  if (!updated) {
    throw createError("Template is not active", 400, "INVALID_STATE");
  }
  res.json({ template: updated });
});

/**
 * PATCH /brands/challenge-templates/:templateId/resume
 * Resume a paused template so it continues spawning new challenges
 * for future periods.
 */
router.patch("/challenge-templates/:templateId/resume", authenticate, async (req, res) => {
  const template = await getChallengeTemplateById(req.params.templateId);
  if (!template) throw createError("Template not found", 404);

  const brand = await getBrandById(template.brand_id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const updated = await resumeChallengeTemplate(template.id);
  if (!updated) {
    throw createError("Template is not paused", 400, "INVALID_STATE");
  }
  res.json({ template: updated });
});

/**
 * DELETE /brands/challenge-templates/:templateId
 * Soft-delete a template. Previously spawned challenges remain unchanged.
 */
router.delete("/challenge-templates/:templateId", authenticate, async (req, res) => {
  const template = await getChallengeTemplateById(req.params.templateId);
  if (!template) throw createError("Template not found", 404);

  const brand = await getBrandById(template.brand_id);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  await softDeleteChallengeTemplate(template.id);
  res.status(204).send();
});

/**
 * POST /brands/:id/webhooks
 * Register an outbound webhook subscription for challenge lifecycle events.
 */
router.post("/:id/webhooks", authenticate, async (req, res) => {
  const brandId = req.params.id;
  const brand = await getBrandById(brandId);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const parsed = WebhookSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError("Invalid webhook subscription fields", 422, "VALIDATION_ERROR");
  }

  const subscription = await createBrandWebhook({
    brandId,
    url: parsed.data.url,
    secret: parsed.data.secret,
    eventTypes: parsed.data.eventTypes,
  });

  res.status(201).json({ webhook: subscription });
});

/**
 * GET /brands/:id/webhooks
 * List registered webhooks for a brand.
 */
router.get("/:id/webhooks", authenticate, async (req, res) => {
  const brandId = req.params.id;
  const brand = await getBrandById(brandId);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const webhooks = await getBrandWebhooks(brandId);
  res.json({ webhooks });
});

/**
 * GET /brands/:id/webhooks/deliveries
 * View delivery status and logs per brand.
 */
router.get("/:id/webhooks/deliveries", authenticate, async (req, res) => {
  const brandId = req.params.id;
  const brand = await getBrandById(brandId);
  if (!brand) throw createError("Brand not found", 404);
  if (brand.owner_user_id !== req.user!.sub && req.user!.role !== "admin") {
    throw createError("Forbidden", 403);
  }

  const deliveries = await getBrandWebhookDeliveries(brandId);
  res.json({ deliveries });
});

export default router;
