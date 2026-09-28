import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  getActiveChallenges,
  getActiveChallengesCursor,
  getActiveChallengesSorted,
  getFilteredChallenges,
  getChallengeByIdAny,
  getChallengesByBrandId,
  getChallengeQuestions,
  type ActiveChallengesSort,
} from "../db/queries/challenges";
import { getBrandById } from "../db/queries/brands";
import {
  getLeaderboard,
  getArchivedLeaderboard,
  getSession,
  LEADERBOARD_SORTS,
  type LeaderboardSort,
} from "../db/queries/sessions";
import { optionalAuth, authenticate } from "../middleware/authenticate";
import { requireActiveUser } from "../middleware/require-active-user";
import { createError } from "../middleware/error";
import { reportLimiter } from "../middleware/rate-limit";
import { withCoalescing } from "../lib/cache";
import { redis } from "../lib/redis";
import { config } from "../lib/config";
import { CursorQuerySchema } from "../db/pagination";
import { query, pool } from "../db/index";

const router = Router();
const CHALLENGE_DETAIL_CACHE_TTL_SECONDS = 60;

type ChallengeDetailPayload = {
  challenge: Awaited<ReturnType<typeof getChallengeByIdAny>> extends infer T
    ? Exclude<T, null>
    : never;
  questions: Array<Record<string, unknown>>;
};

function challengeDetailCacheKey(id: string): string {
  return `challenge:detail:${id}`;
}

function createEtag(payload: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `"${hash}"`;
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

const CHALLENGES_CACHE_TTL_SEC = 10;

const LeaderboardSortSchema = z.enum(LEADERBOARD_SORTS).default("score");

function parseLeaderboardSort(query: Record<string, unknown>): LeaderboardSort {
  const parsed = LeaderboardSortSchema.safeParse(query.sort_by ?? query.order);
  if (!parsed.success) {
    throw createError(
      `Invalid leaderboard sort. Allowed values: ${LEADERBOARD_SORTS.join(", ")}`,
      400,
      "INVALID_SORT"
    );
  }
  return parsed.data;
}
const ChallengeFilterSchema = CursorQuerySchema.extend({
  brandId: z.string().uuid().optional(),
  status: z.enum(["active", "upcoming", "ended"]).optional(),
  min_pool: z.coerce.number().min(0).optional(),
  end_before: z.string().datetime({ offset: true }).optional(),
});

/**
 * GET /challenges
 * List challenges (public). Supports keyset cursor pagination via ?cursor.
 * Optional filters: ?status=, ?min_pool= (USDC), ?end_before= (ISO datetime).
 * Legacy ?offset parameter is accepted but ignored; clients should migrate to ?cursor.
 */
router.get("/", optionalAuth, async (req, res) => {
  const parsed = ChallengeFilterSchema.safeParse(req.query);
  if (!parsed.success) {
    throw createError("Invalid query parameters", 400, "INVALID_QUERY");
  }

  const { brandId, limit, cursor, status, min_pool, end_before, offset } = parsed.data;

  // Emit deprecation header if legacy offset is used
  if (offset !== undefined) {
    res.setHeader("Deprecation", "offset");
    res.setHeader("Link", '<https://docs.api.brandblitz.com/pagination>; rel="deprecation"; type="text/html"');
  }

  if (brandId) {
    const { challenges, nextCursor } = await getChallengesByBrandId(brandId, limit, cursor);
    res.json({ data: challenges, nextCursor });
    return;
  }

  const hasFilters = status !== undefined || min_pool !== undefined || end_before !== undefined;

  if (!hasFilters) {
    const cacheKey = `challenges:active:global:${cursor ?? "start"}:${limit}`;
    const cacheHit = await redis.get(cacheKey);
    const result = await withCoalescing(cacheKey, CHALLENGES_CACHE_TTL_SEC, () =>
      getActiveChallengesCursor(cursor, limit)
    );
    res.setHeader("X-Cache", cacheHit !== null ? "HIT" : "MISS");
    res.json({ data: result.challenges, nextCursor: result.nextCursor });
    return;
  }

  const { challenges, nextCursor } = await getFilteredChallenges({
    status,
    minPoolUsdc: min_pool,
    endBefore: end_before,
    cursor,
    limit,
  });
  res.json({ data: challenges, nextCursor });
});

const ActiveSortSchema = z.enum(["pool_desc", "pool_asc", "newest", "ending_soon"]).default("pool_desc");

const ActiveQuerySchema = CursorQuerySchema.extend({
  sort: ActiveSortSchema.optional(),
});

/**
 * GET /challenges/active
 * Lobby listing: active challenges sorted and cursor-paginated.
 *
 * Query params:
 *   sort   — pool_desc (default) | pool_asc | newest | ending_soon
 *   limit  — 1–50, default 20
 *   cursor — opaque continuation token from a previous response
 *
 * Each item exposes: id, brand_id, title, reward_pool_xlm (pool_amount_usdc),
 * entry_fee_xlm (null — not a schema column), ends_at, participant_count,
 * plus brand enrichment fields (brand_name, logo_url, primary_color, secondary_color).
 *
 * Returns 200 with empty items array when no active challenges exist.
 * Requires authentication + active account (suspended users receive 403).
 */
router.get(
  "/active",
  authenticate,
  requireActiveUser,
  async (req, res) => {
    const parsed = ActiveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw createError("Invalid query parameters", 400, "INVALID_QUERY");
    }

    const { sort, cursor, limit: rawLimit } = parsed.data;
    // Cap at 50 per the acceptance criteria
    const limit = Math.min(rawLimit, 50);

    const { items, nextCursor } = await getActiveChallengesSorted({
      sort: sort as ActiveChallengesSort | undefined,
      cursor,
      limit,
    });

    res.json({
      items: items.map((c) => ({
        id: c.id,
        brand_id: c.brand_id,
        title: c.title,
        reward_pool_xlm: c.pool_amount_usdc,
        entry_fee_xlm: null,
        ends_at: c.ends_at,
        participant_count: c.participant_count,
        brand_name: c.brand_name,
        logo_url: c.logo_url,
        primary_color: c.primary_color,
        secondary_color: c.secondary_color,
      })),
      nextCursor,
    });
  },
);

/**
 * GET /challenges/:id
 * Get challenge details. Questions (without correct answers) included.
 * For pending_deposit challenges, includes confirmation count and requirement.
 */
router.get("/:id", optionalAuth, async (req, res) => {
  const cacheKey = challengeDetailCacheKey(req.params.id);
  const cachedDetail = await redis.get(cacheKey);
  let payload: ChallengeDetailPayload;

  if (cachedDetail !== null) {
    payload = JSON.parse(cachedDetail) as ChallengeDetailPayload;
  } else {
    const challenge = await getChallengeByIdAny(req.params.id);
    if (!challenge) throw createError("Challenge not found", 404);

    // Return questions without correct_answer and correct_option fields
    const questions = await getChallengeQuestions(challenge.id);
    const safeQuestions = questions.map(({ correct_answer, correct_option, ...q }) => q);
    payload = { challenge, questions: safeQuestions };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", CHALLENGE_DETAIL_CACHE_TTL_SECONDS);
  }

  const etag = createEtag(payload);
  res.set({ ETag: etag, "Cache-Control": "no-cache" });
  if (etagMatches(req.get("If-None-Match"), etag)) {
    res.status(304).end();
    return;
  }

  res.json(payload);
});

type ChallengeStatsRow = {
  total_sessions: number;
  completed_sessions: number;
  completion_rate_pct: number;
  disqualification_rate_pct: number;
  avg_score: number;
  avg_accuracy_pct: number;
  avg_time_per_round_ms: number;
  total_paid_out_usdc: number;
  cost_per_completed_session_usdc: number;
  unique_participants: number;
};

/** GET /challenges/:id/stats — aggregate performance metrics for brand owners and admins. */
router.get("/:id/stats", authenticate, async (req, res) => {
  const challenge = await getChallengeByIdAny(req.params.id);
  if (!challenge) throw createError("Challenge not found", 404);

  if (req.user?.role !== "admin") {
    const brand = await getBrandById(challenge.brand_id);
    if (!brand || brand.owner_user_id !== req.user?.sub) {
      throw createError("Forbidden", 403, "FORBIDDEN");
    }
  }

  const result = await query<ChallengeStatsRow>(
    `WITH session_stats AS (
       SELECT COUNT(*)::int AS total_sessions,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_sessions,
              COUNT(DISTINCT user_id)::int AS unique_participants,
              COUNT(*) FILTER (WHERE flagged OR status = 'flagged')::int AS disqualified_sessions
       FROM game_sessions
       WHERE challenge_id = $1
     ),
     round_stats AS (
       SELECT COALESCE(ROUND(AVG(srs.score)::numeric, 2), 0)::float8 AS avg_score,
              COALESCE(ROUND(AVG(CASE WHEN srs.answer = cq.correct_option THEN 100.0 ELSE 0 END)::numeric, 2), 0)::float8 AS avg_accuracy_pct,
              COALESCE(ROUND(AVG(srs.reaction_time_ms)::numeric, 2), 0)::float8 AS avg_time_per_round_ms
       FROM session_round_scores srs
       JOIN game_sessions gs ON gs.id = srs.session_id
       JOIN challenge_questions cq ON cq.challenge_id = gs.challenge_id AND cq.round = srs.round
       WHERE gs.challenge_id = $1
     ),
     payout_stats AS (
       SELECT COALESCE(SUM(amount_stroops), 0)::numeric / 10000000 AS total_paid_out_usdc
       FROM payouts
       WHERE challenge_id = $1 AND status IN ('completed', 'sent', 'confirmed')
     )
     SELECT ss.total_sessions,
            ss.completed_sessions,
            CASE WHEN ss.total_sessions = 0 THEN 0 ELSE ROUND(ss.completed_sessions * 100.0 / ss.total_sessions, 2)::float8 END AS completion_rate_pct,
            CASE WHEN ss.total_sessions = 0 THEN 0 ELSE ROUND(ss.disqualified_sessions * 100.0 / ss.total_sessions, 2)::float8 END AS disqualification_rate_pct,
            rs.avg_score,
            rs.avg_accuracy_pct,
            rs.avg_time_per_round_ms,
            ps.total_paid_out_usdc::float8 AS total_paid_out_usdc,
            CASE WHEN ss.completed_sessions = 0 THEN 0 ELSE ROUND(ps.total_paid_out_usdc / ss.completed_sessions, 7)::float8 END AS cost_per_completed_session_usdc,
            ss.unique_participants
     FROM session_stats ss CROSS JOIN round_stats rs CROSS JOIN payout_stats ps`,
    [challenge.id]
  );

  res.json({ stats: result.rows[0] });
});

const ChallengeIdParamSchema = z.object({
  id: z.union([z.string().uuid(), z.string().regex(/^\d+$/)]),
});

/**
 * GET /challenges/:id/session
 * Return the authenticated user's most recent session for this challenge.
 */
router.get("/:id/session", authenticate, async (req, res) => {
  const paramsResult = ChallengeIdParamSchema.safeParse(req.params);
  if (!paramsResult.success) {
    throw createError("Invalid challenge id", 400, "INVALID_CHALLENGE_ID");
  }

  const challenge = await getChallengeByIdAny(paramsResult.data.id);
  if (!challenge) throw createError("Challenge not found", 404);

  const session = await getSession(req.user!.sub, challenge.id);
  if (!session) throw createError("Session not found", 404, "SESSION_NOT_FOUND");

  res.json({
    session: {
      id: session.id,
      status: session.status,
      total_score: session.total_score,
      started_at: session.challenge_started_at ?? session.warmup_started_at,
      completed_at: session.completed_at,
    },
  });
});

/**
 * GET /challenges/:id/leaderboard
 * Paginated leaderboard for a challenge. Supports keyset cursor pagination.
 */
router.get("/:id/leaderboard", async (req, res) => {
  const challenge = await getChallengeByIdAny(req.params.id);
  if (!challenge) throw createError("Challenge not found", 404);

  const sortBy = parseLeaderboardSort(req.query);
  const { limit, cursor } = CursorQuerySchema.parse(req.query);
  const result = challenge.archived
    ? await getArchivedLeaderboard(challenge.id, limit, cursor)
    : await getLeaderboard(challenge.id, limit, cursor, sortBy);

  res.json({
    challengeId: challenge.id,
    nextCursor: result.nextCursor,
    sessions: result.sessions.map((s, i) => ({
      userId: s.user_id,
      username: s.username,
      displayName: s.display_name,
      league: s.league,
      avatarUrl: s.avatar_url,
      totalScore: s.total_score,
      totalEarned: s.total_earned_usdc,
      endedAt: s.completed_at,
    })),
  });
});

/**
 * GET /challenges/:id/deposit-info
 * Get deposit instructions for a challenge (memo, address, amount).
 * Only accessible to the brand owner.
 * Returns 404 if requester is not the brand owner.
 */
router.get("/:id/deposit-info", authenticate, async (req, res) => {
  const challenge = await getChallengeByIdAny(req.params.id);
  if (!challenge) throw createError("Challenge not found", 404);

  // Verify requester is the brand owner
  const brand = await getBrandById(challenge.brand_id);
  if (!brand || brand.owner_user_id !== req.user?.sub) {
    throw createError("Forbidden", 403);
  }

  // Only return deposit info if challenge is pending deposit
  if (challenge.status !== "pending_deposit") {
    throw createError("Challenge is not pending deposit", 400);
  }

  res.json({
    depositInfo: {
      hotWalletAddress: config.HOT_WALLET_PUBLIC_KEY,
      // Return the dedicated deposit_memo — the value reconciliation matches on
      // (getChallengeByMemo) and which is generated to fit Stellar's 28-byte text
      // memo limit. Fall back to the id only if a legacy row lacks a memo.
      memo: challenge.deposit_memo ?? challenge.id,
      amount: challenge.pool_amount_usdc,
    },
  });
});

/**
 * POST /challenges/:id/report
 * Report inappropriate challenge content.
 * Requires authentication + active user account.
 * Rate-limited to 5 per user per hour.
 * Returns 409 if same user already reported this challenge (duplicate detection).
 */
router.post("/:id/report", authenticate, requireActiveUser, reportLimiter, async (req, res) => {
  const { id: challengeId } = z.object({ id: z.string().uuid() }).parse(req.params);
  const challenge = await getChallengeByIdAny(challengeId);
  if (!challenge) throw createError("Challenge not found", 404);

  if (challenge.status !== "active") {
    throw createError("Challenge is not active", 404);
  }

  const ReportSchema = z.object({
    reason: z.enum(["misleading", "offensive", "spam", "trademark_violation", "other"]),
    details: z.string().max(500).optional(),
  });

  const body = ReportSchema.parse(req.body);
  const userId = req.user!.sub;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id FROM challenge_reports WHERE challenge_id = $1 AND user_id = $2`,
      [challengeId, userId]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      throw createError("You have already reported this challenge", 409, "ALREADY_REPORTED");
    }

    const reportId = crypto.randomUUID();

    await client.query(
      `INSERT INTO challenge_reports (id, challenge_id, user_id, reason, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [reportId, challengeId, userId, body.reason, body.details ?? null]
    );

    await client.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, metadata)
       VALUES ('content_report', 'challenge', $1, $2::jsonb)`,
      [challengeId, JSON.stringify({ reporter_user_id: userId, reason: body.reason, details: body.details })]
    );

    await client.query("COMMIT");
    res.status(201).json({ report_id: reportId });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

export default router;
