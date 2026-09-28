import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import {
  findUserById,
  findUserByPhoneHash,
  markPhoneVerified,
  updateUserWallet,
  updateUserProfile,
  getUserPublicProfileByUsername,
  searchUsersByUsername,
  markOnboardingCompleted,
} from "../db/queries/users";
import { getReferralStats, ensureUserReferralCode } from "../services/referrals";
import { stroopsToUsdc } from "../lib/usdc";
import { getStreak, repairStreak, getUserActivity, getStreakDetail } from "../services/streaks";
import { query } from "../db";
import {
  sendVerificationCode,
  hashPhoneNumber,
  normalizePhoneNumber,
  verifyOtpWithBruteForceProtection,
} from "../services/phone";
import { authenticate } from "../middleware/authenticate";
import { requireActiveUser } from "../middleware/require-active-user";
import { createError } from "../middleware/error";
import { redis } from "../lib/redis";
import { apiLimiter, phoneRateLimit } from "../middleware/rate-limit";
import { getBadgesForUser } from "../services/badges";
import { config } from "../lib/config";
import { getSessionHistory, type HistoryStatusFilter } from "../db/queries/sessions";
import { CursorQuerySchema } from "../db/pagination";
import { signAccessToken } from "../lib/tokens";
import { tokenRevocationKey, tokenTtlSeconds } from "../middleware/authenticate";
import { logger } from "../lib/logger";

const router: Router = Router();

/**
 * GET /users/me
 * Full profile of the authenticated user.
 */
router.get("/me", authenticate, async (req, res) => {
  const user = await findUserById(req.user!.sub);
  if (!user) throw createError("User not found", 404);

  const safeUser = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    username: user.username,
    avatar_url: user.avatar_url,
    stellar_address: user.stellar_address,
    embedded_wallet_address: user.embedded_wallet_address,
    phone_verified: user.phone_verified,
    age_verified: user.age_verified,
    kyc_complete: user.kyc_complete,
    state_code: user.state_code,
    streak: user.streak,
    last_play_day: user.last_play_day,
    streak_repairs_this_month: user.streak_repairs_this_month,
    streak_repair_available: user.streak_repair_available,
    onboarding_completed: user.onboarding_completed,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };

  res.json({ user: safeUser });
});

/**
 * POST /users/me/onboarding/complete
 * Marks the first-run challenge tutorial as completed/dismissed for this
 * user (issue #1040). Idempotent — safe to call on every dismissal path.
 */
router.post("/me/onboarding/complete", authenticate, async (req, res) => {
  const completed = await markOnboardingCompleted(req.user!.sub);
  res.json({ success: true, onboardingCompleted: completed });
});

router.get("/me/streak", authenticate, async (req, res) => {
  const streak = await getStreakDetail(req.user!.sub).catch(() => null);
  if (!streak) throw createError("User not found", 404);

  res.json(streak);
});

const HistoryQuerySchema = CursorQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["completed", "disqualified", "all"]).default("completed"),
  include_rounds: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .optional()
    .default("false")
    .transform((v) => (typeof v === "string" ? v === "true" || v === "1" : v)),
});

/**
 * GET /users/me/history
 * Paginated session history for the authenticated user.
 *
 * Query params:
 *   status         — completed (default) | disqualified | all
 *   include_rounds — true | false (default) — appends per-round breakdown
 *   limit          — 1–100 (default 20)
 *   cursor         — opaque continuation token
 *
 * Sessions still in-progress (warmup/active/abandoned) are excluded unless
 * status=all is explicitly requested.
 *
 * Each item includes: session_id, challenge_id, challenge_title, started_at,
 * completed_at, total_score, outcome (won|lost|disqualified|in_progress),
 * payout_amount_usdc.
 */
router.get("/me/history", authenticate, async (req, res) => {
  const parsed = HistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw createError("Invalid query parameters", 400, "INVALID_QUERY");
  }

  const { status, cursor, limit, include_rounds } = parsed.data;

  const { items, nextCursor } = await getSessionHistory(req.user!.sub, {
    status: status as HistoryStatusFilter,
    cursor,
    limit,
    includeRounds: include_rounds,
  });

  res.json({ items, nextCursor });
});

const UserSearchQuerySchema = z.object({
  q: z.string().min(2),
  page: z.coerce.number().int().min(1).default(1),
});

const USER_SEARCH_PAGE_SIZE = 20;

/**
 * GET /users/search
 * Case-insensitive prefix search against username. Authenticated to prevent
 * unauthenticated enumeration. Returns only public-safe fields.
 */
router.get("/search", authenticate, async (req, res) => {
  const parsed = UserSearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw createError("Query parameter 'q' must be at least 2 characters", 400, "INVALID_QUERY");
  }

  const { q, page } = parsed.data;
  const users = await searchUsersByUsername(q, page, USER_SEARCH_PAGE_SIZE);

  res.json(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      avatar_url: u.avatar_url,
      total_earnings: u.total_earned_usdc,
    }))
  );
});

router.get("/:id/streak", authenticate, async (req, res) => {
  const { id } = z.object({ id: z.string() }).parse(req.params);
  if (id !== req.user!.sub) throw createError("Forbidden", 403, "FORBIDDEN");

  const streak = await getStreak(id).catch(() => null);
  if (!streak) throw createError("User not found", 404);

  res.json({
    streak: streak.streak,
    last_play_day: streak.lastPlayDay,
    repair_available: streak.repairAvailable,
  });
});

router.get("/me/referrals/stats", authenticate, async (req, res) => {
  const stats = await getReferralStats(req.user!.sub);

  res.json({
    referralCode: stats.referralCode,
    invitesSent: stats.invitesSent,
    conversions: stats.conversions,
    totalEarned: stroopsToUsdc(stats.totalEarnedStroops),
    totalEarnedUsdc: stroopsToUsdc(stats.totalEarnedStroops),
  });
});

router.get("/me/referrals", authenticate, async (req, res) => {
  const userId = req.user!.sub;
  const referralCode = await ensureUserReferralCode(userId);

  const referredResult = await query<{
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    created_at: string;
    paid: boolean;
  }>(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.avatar_url,
       u.created_at,
       COALESCE(rp.status = 'sent', FALSE) AS paid
     FROM referrals r
     JOIN users u ON r.referred_id = u.id
     LEFT JOIN referral_payouts rp ON r.id = rp.referral_id AND rp.status = 'sent'
     WHERE r.referrer_id = $1 AND u.deleted_at IS NULL
     ORDER BY u.created_at DESC`,
    [userId]
  );

  const totalsResult = await query<{
    pending_stroops: string;
    confirmed_stroops: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN referrer_id = $1 AND status = 'pending' THEN referrer_amount_stroops ELSE 0 END), 0)::text AS pending_stroops,
       COALESCE(SUM(CASE WHEN referrer_id = $1 AND status = 'sent' THEN referrer_amount_stroops ELSE 0 END), 0)::text AS confirmed_stroops
     FROM referral_payouts
     WHERE referrer_id = $1`,
    [userId]
  );

  const totals = totalsResult.rows[0] || { pending_stroops: "0", confirmed_stroops: "0" };

  res.json({
    referralCode,
    referredUsers: referredResult.rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      joinedAt: row.created_at,
      bonusPaid: row.paid,
    })),
    bonusStatus: {
      pendingUsdc: stroopsToUsdc(BigInt(totals.pending_stroops)),
      confirmedUsdc: stroopsToUsdc(BigInt(totals.confirmed_stroops)),
    },
  });
});

router.post("/streaks/repair", authenticate, async (req, res) => {
  const repaired = await repairStreak(req.user!.sub);
  if (!repaired) {
    throw createError("Monthly streak repair already used", 409, "STREAK_REPAIR_LIMIT");
  }

  res.json(repaired);
});

/**
 * GET /users/profile/:username
 * Public profile — display name, stats. No auth required.
 * Returns a redirect field if the username has been renamed.
 */
router.get("/profile/:username", apiLimiter, async (req, res) => {
  const { username } = z.object({ username: z.string() }).parse(req.params);

  // Check for username redirect first
  const redirectTarget = await redis.get(`username:redirect:${username}`);
  if (redirectTarget) {
    res.json({ redirect: redirectTarget });
    return;
  }

  const user = await getUserPublicProfileByUsername(username);
  if (!user) throw createError("User not found", 404);

  const isOwner = req.user?.sub === user.id;

  res.json({
    user: {
      userId: isOwner ? user.id : undefined,
      displayName: user.display_name,
      username: user.username,
      league: user.league,
      totalEarned: user.total_earned_usdc,
      totalChallenges: user.challenges_played,
      avatarUrl: user.avatar_url,
      streak: user.streak,
      createdAt: user.created_at,
      isOwner,
    },
  });
});

/**
 * GET /users/:username/public
 * Public profile — username, avatar, join date, win count, total sessions,
 * accuracy, league, and the 6 most recently awarded badges.
 * No authentication required. Returns 404 for unknown, deleted, or suspended users.
 */
router.get("/:username/public", apiLimiter, async (req, res) => {
  const { username } = z.object({ username: z.string() }).parse(req.params);

  // Fetch the user row — only active, non-deleted accounts are visible.
  const userResult = await query<{
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    created_at: string;
    league: "bronze" | "silver" | "gold" | null;
    status: string;
    deleted_at: string | null;
  }>(
    `SELECT id, username, display_name, avatar_url, created_at, league, status, deleted_at
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username]
  );

  const user = userResult.rows[0];

  // 404 for unknown, GDPR-erased (deleted_at set), or suspended accounts.
  // We return 404 in all cases — never 403 — to avoid user enumeration.
  if (!user || user.deleted_at !== null || user.status !== "active") {
    throw createError("User not found", 404);
  }

  // Session stats: win_count (completed, non-practice), total_sessions_played,
  // and accuracy_pct (rounds with score > 0 / total rounds across completed sessions).
  const statsResult = await query<{
    win_count: string;
    total_sessions_played: string;
    correct_rounds: string;
    total_rounds: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed' AND is_practice = FALSE)  AS win_count,
       COUNT(*) FILTER (WHERE status = 'completed')                          AS total_sessions_played,
       (
         COUNT(*) FILTER (WHERE status = 'completed' AND round_1_score > 0)
         + COUNT(*) FILTER (WHERE status = 'completed' AND round_2_score > 0)
         + COUNT(*) FILTER (WHERE status = 'completed' AND round_3_score > 0)
       )                                                                      AS correct_rounds,
       (COUNT(*) FILTER (WHERE status = 'completed') * 3)                    AS total_rounds
     FROM game_sessions
     WHERE user_id = $1`,
    [user.id]
  );

  const stats = statsResult.rows[0];
  const winCount = parseInt(stats.win_count, 10);
  const totalSessionsPlayed = parseInt(stats.total_sessions_played, 10);
  const correctRounds = parseInt(stats.correct_rounds, 10);
  const totalRounds = parseInt(stats.total_rounds, 10);
  const accuracyPct = totalRounds > 0 ? Math.round((correctRounds / totalRounds) * 100) : 0;

  // League: most recent assignment for the current (or last) week.
  const leagueResult = await query<{
    league: string;
    rank_in_group: number | null;
    week_start: string;
    weekly_points: string;
  }>(
    `SELECT league, rank_in_group, week_start, weekly_points
     FROM league_assignments
     WHERE user_id = $1
     ORDER BY week_start DESC
     LIMIT 1`,
    [user.id]
  );

  const leagueRow = leagueResult.rows[0] ?? null;
  const league = leagueRow
    ? {
        tier: leagueRow.league,
        rank: leagueRow.rank_in_group,
        season: leagueRow.week_start,
      }
    : null;

  // Badges: 6 most recently awarded, enriched with definition metadata.
  const badgesResult = await query<{
    badge_slug: string;
    awarded_at: string;
  }>(
    `SELECT badge_slug, awarded_at
     FROM user_badges
     WHERE user_id = $1
     ORDER BY awarded_at DESC
     LIMIT 6`,
    [user.id]
  );

  const { BADGE_DEFINITIONS } = await import("../services/badges");
  const defMap = new Map(BADGE_DEFINITIONS.map((d) => [d.slug, d]));

  const badges = badgesResult.rows.map((row) => {
    const def = defMap.get(row.badge_slug);
    return {
      slug: row.badge_slug,
      name: def?.name ?? row.badge_slug,
      description: def?.description ?? "",
      iconUrl: def?.iconUrl ?? null,
      awardedAt: row.awarded_at,
    };
  });

  res.json({
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    joinedAt: user.created_at,
    winCount,
    totalSessionsPlayed,
    accuracyPct,
    league,
    badges,
  });
});

/**
 * GET /users/:id/badges
 * Returns all 8 badge definitions merged with the user's earned status.
 * Earned badges include awarded_at; locked badges are included with earned=false.
 */
router.get("/:id/badges", authenticate, async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  if (id !== req.user!.sub) throw createError("Forbidden", 403, "FORBIDDEN");

  const badges = await getBadgesForUser(id);
  res.json({ badges });
});

/**
 * GET /users/:username/activity
 * Returns 365 days of activity (date and session_count) for the trailing year.
 * Public endpoint - no authentication required.
 */
router.get("/:username/activity", apiLimiter, async (req, res) => {
  const { username } = z.object({ username: z.string() }).parse(req.params);

  const user = await getUserPublicProfileByUsername(username);
  if (!user) throw createError("User not found", 404);

  const activity = await getUserActivity(user.id);
  res.json(activity);
});

/**
 * PATCH /users/me/wallet
 */
router.patch("/me/wallet", authenticate, async (req, res) => {
  const { stellarAddress } = z
    .object({ stellarAddress: z.string().min(56).max(70) })
    .strict()
    .parse(req.body);

  await updateUserWallet(req.user!.sub, stellarAddress);
  res.json({ success: true });
});

/**
 * PATCH /users/me/profile
 * Update display name and/or username. Triggers cache revalidation
 * so Next.js pages reflect the new values immediately.
 */
router.patch("/me/profile", authenticate, async (req, res) => {
  const body = z
    .object({
      displayName: z.string().trim().min(1).max(100).optional(),
      username: z
        .string()
        .trim()
        .min(1)
        .max(30)
        .regex(/^[a-z0-9-]+$/, "Username may only contain lowercase letters, numbers, and hyphens")
        .optional(),
    })
    .parse(req.body);

  if (!body.displayName && !body.username) {
    throw createError("Nothing to update", 400);
  }

  const { oldUsername, newUsername } = await updateUserProfile(req.user!.sub, body);

  // Store redirect for old username (so visiting /profile/<old> redirects to new URL)
  if (oldUsername && oldUsername !== newUsername) {
    await redis.set(`username:redirect:${oldUsername}`, newUsername, "EX", 86400 * 365);
  }

  // Trigger Next.js cache revalidation so profile pages reflect the new data
  const revalidatePaths = [`/profile/${oldUsername}`, `/profile/${newUsername}`];

  try {
    await fetch(`${config.WEB_URL}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: config.WEBHOOK_SECRET,
        paths: revalidatePaths,
        tags: [`profile-${oldUsername}`, `profile-${newUsername}`],
      }),
    });
  } catch {
    // Non-critical — stale cache will eventually expire
    logger.warn("Failed to trigger cache revalidation for profile update", {
      oldUsername,
      newUsername,
    });
  }

  // Token rotation: revoke the old token and issue a new one
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    await redis.set(tokenRevocationKey(token), "1", "EX", tokenTtlSeconds(req.user!));
  }

  const updatedUser = await findUserById(req.user!.sub);
  const newToken = signAccessToken({
    id: updatedUser!.id,
    email: updatedUser!.email,
    role: req.user!.role,
  });

  res.json({ success: true, oldUsername, newUsername, token: newToken });
});

/**
 * POST /users/me/phone/send
 * Send SMS verification code via Twilio.
 */
router.post("/me/phone/send", authenticate, phoneRateLimit, async (req, res) => {
  const { phone } = z.object({ phone: z.string().min(1) }).parse(req.body);
  const normalizedPhone = normalizePhoneNumber(phone);

  await sendVerificationCode(normalizedPhone);
  res.json({ success: true });
});

/**
 * POST /users/me/phone/verify
 * Confirm SMS verification code. Marks phone as verified.
 */
router.post("/me/phone/verify", authenticate, async (req, res) => {
  const { phone, code } = z
    .object({ phone: z.string(), code: z.string().length(6) })
    .parse(req.body);

  const normalizedPhone = normalizePhoneNumber(phone);
  const phoneHash = hashPhoneNumber(normalizedPhone);

  const existingUser = await findUserByPhoneHash(phoneHash);
  if (existingUser && existingUser.id !== req.user!.sub) {
    throw createError("Phone number already associated with another account", 409);
  }

  // verifyOtpWithBruteForceProtection throws 429 (with retryAfter) on lockout,
  // 400 on wrong code, and nothing on success.
  try {
    await verifyOtpWithBruteForceProtection(normalizedPhone, code);
  } catch (err: any) {
    if (err.statusCode === 429 && err.retryAfter != null) {
      res.set("Retry-After", String(err.retryAfter));
    }
    throw err;
  }

  const existingKey = `phone:hash:${phoneHash}`;
  await markPhoneVerified(req.user!.sub, phoneHash);
  await redis.set(existingKey, req.user!.sub, "EX", 86400 * 365);

  res.json({ success: true });
});

/**
 * GET /users/me/notifications
 * Returns the 50 most recent unread notifications for the authenticated user.
 */
router.get("/me/notifications", authenticate, async (req, res) => {
  const result = await query<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    read_at: string | null;
    created_at: string;
  }>(
    `SELECT id, type, payload, read_at, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user!.sub]
  );

  res.json({ notifications: result.rows });
});

/**
 * PATCH /users/me/notifications/:id/read
 * Marks a single notification as read.
 */
router.patch("/me/notifications/:id/read", authenticate, async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

  const result = await query<{ id: string }>(
    `UPDATE notifications
     SET read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING id`,
    [id, req.user!.sub]
  );

  if (result.rows.length === 0) {
    throw createError("Notification not found", 404);
  }

  res.json({ success: true });
});

/**
 * PATCH /users/me/notifications/read-all
 * Marks all unread notifications as read.
 */
router.patch("/me/notifications/read-all", authenticate, async (req, res) => {
  await query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [
    req.user!.sub,
  ]);

  res.json({ success: true });
});

/**
 * GET /users/me/badges
 * Returns all badges earned by the authenticated user, ordered by awarded_at descending.
 * Supports optional ?category= filter.
 */
router.get("/me/badges", authenticate, async (req, res) => {
  const parsed = z
    .object({
      category: z.string().optional(),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    throw createError("Invalid query parameters", 400, "INVALID_QUERY");
  }

  const { category } = parsed.data;

  const result = await query<{
    id: string;
    badge_id: string;
    badge_name: string;
    badge_description: string;
    icon_url: string;
    awarded_at: string;
    trigger_event: string;
    category: string;
  }>(
    `SELECT
       ub.id,
       ub.badge_slug AS badge_id,
       bd.name AS badge_name,
       bd.description AS badge_description,
       bd.icon_url,
       ub.awarded_at,
       bd.category,
       bd.criteria AS trigger_event
     FROM user_badges ub
     LEFT JOIN badge_definitions bd ON ub.badge_slug = bd.slug
     WHERE ub.user_id = $1
     ${category ? "AND bd.category = $2" : ""}
     ORDER BY ub.awarded_at DESC`,
    category ? [req.user!.sub, category] : [req.user!.sub]
  );

  res.json({
    items: result.rows,
    total: result.rows.length,
  });
});

/**
 * GET /users/me/earnings
 * Returns paginated USDC payout history for the authenticated user.
 * Supports status filtering (pending | settled | failed | all).
 * Cursor-based pagination with default limit 25, max 100.
 */
router.get("/me/earnings", authenticate, requireActiveUser, async (req, res) => {
  const parsed = z
    .object({
      status: z.enum(["pending", "settled", "failed", "all"]).default("all"),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    throw createError("Invalid query parameters", 400, "INVALID_QUERY");
  }

  const { status, cursor, limit } = parsed.data;
  const userId = req.user!.sub;

  let statusFilter = "";
  const params: unknown[] = [userId];
  let paramIndex = 2;

  if (status !== "all") {
    statusFilter = `AND p.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  const decodeCursorSafe = (c: string | undefined) => {
    if (!c) return null;
    try {
      const decoded = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
      return decoded;
    } catch {
      return null;
    }
  };

  let cursorWhere = "";
  if (cursor) {
    const decoded = decodeCursorSafe(cursor);
    if (decoded && decoded.created_at && decoded.id) {
      cursorWhere = `AND (p.created_at < $${paramIndex} OR (p.created_at = $${paramIndex} AND p.id < $${paramIndex + 1}))`;
      params.push(decoded.created_at, decoded.id);
      paramIndex += 2;
    }
  }

  const payoutsResult = await query<{
    payout_id: string;
    amount_usdc: string;
    status: string;
    created_at: string;
    settled_at: string | null;
    stellar_tx_hash: string | null;
    challenge_id: string;
    id: string;
  }>(
    `SELECT
       p.id AS payout_id,
       (p.amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc,
       p.status,
       p.created_at,
       p.updated_at AS settled_at,
       p.tx_hash AS stellar_tx_hash,
       p.challenge_id,
       p.id
     FROM payouts p
     WHERE p.user_id = $1 ${statusFilter} ${cursorWhere}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${paramIndex}`,
    [...params, limit + 1]
  );

  const payouts = payoutsResult.rows.slice(0, limit);
  const hasMore = payoutsResult.rows.length > limit;

  const totalsResult = await query<{
    lifetime_earned_usdc: string;
    pending_usdc: string;
  }>(
    `SELECT
       COALESCE((SUM(CASE WHEN p.status IN ('sent', 'confirmed') THEN p.amount_stroops ELSE 0 END)::numeric / 10000000)::numeric(20,7)::text, '0') AS lifetime_earned_usdc,
       COALESCE((SUM(CASE WHEN p.status = 'pending' THEN p.amount_stroops ELSE 0 END)::numeric / 10000000)::numeric(20,7)::text, '0') AS pending_usdc
     FROM payouts
     WHERE user_id = $1`,
    [userId]
  );

  const totals = totalsResult.rows[0] || {
    lifetime_earned_usdc: "0",
    pending_usdc: "0",
  };

  const nextCursor =
    hasMore && payouts.length > 0
      ? Buffer.from(
          JSON.stringify({
            created_at: payouts[payouts.length - 1]!.created_at,
            id: payouts[payouts.length - 1]!.payout_id,
          })
        ).toString("base64url")
      : null;

  res.json({
    items: payouts.map((p) => ({
      payout_id: p.payout_id,
      amount_usdc: p.amount_usdc,
      status: p.status,
      created_at: p.created_at,
      settled_at: p.settled_at,
      stellar_tx_hash: p.stellar_tx_hash,
      challenge_id: p.challenge_id,
    })),
    totals: {
      lifetime_earned_usdc: totals.lifetime_earned_usdc,
      pending_usdc: totals.pending_usdc,
    },
    nextCursor,
  });
});

/**
 * GET /users/me/referrals (enhanced)
 * Returns referrals where the authenticated user is the referrer.
 * Each item includes bonus_status (pending | paid | expired) derived from referral_payouts table.
 * Supports optional status filter (pending | paid | expired | all).
 */
router.get("/me/referrals", authenticate, async (req, res) => {
  const parsed = z
    .object({
      status: z.enum(["pending", "paid", "expired", "all"]).default("all"),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    throw createError("Invalid query parameters", 400, "INVALID_QUERY");
  }

  const { status } = parsed.data;
  const userId = req.user!.sub;

  const referralCode = await ensureUserReferralCode(userId);

  let statusFilter = "";
  const params: unknown[] = [userId];

  if (status !== "all") {
    statusFilter = `AND rp.status = $2`;
    params.push(status);
  }

  const referralsResult = await query<{
    referral_id: string;
    referred_user_id: string;
    referred_username: string;
    joined_at: string;
    activated_at: string | null;
    bonus_status: string;
    bonus_amount_usdc: string;
  }>(
    `SELECT
       r.id AS referral_id,
       r.referred_id AS referred_user_id,
       CASE WHEN u.deleted_at IS NOT NULL THEN '[deleted]' ELSE u.username END AS referred_username,
       u.created_at AS joined_at,
       CASE WHEN r.rewarded = TRUE THEN u.created_at ELSE NULL END AS activated_at,
       COALESCE(rp.status, 'pending') AS bonus_status,
       COALESCE((rp.referrer_amount_stroops::numeric / 10000000)::numeric(20,7)::text, '0') AS bonus_amount_usdc
     FROM referrals r
     JOIN users u ON r.referred_id = u.id
     LEFT JOIN referral_payouts rp ON r.id = rp.referral_id
     WHERE r.referrer_id = $1 ${statusFilter}
     ORDER BY u.created_at DESC`,
    params
  );

  const totalsResult = await query<{
    total_referrals: string;
    total_paid: string;
    total_pending_bonuses_usdc: string;
  }>(
    `SELECT
       COUNT(DISTINCT r.id)::text AS total_referrals,
       COUNT(DISTINCT CASE WHEN rp.status = 'sent' THEN r.id END)::text AS total_paid,
       COALESCE((SUM(CASE WHEN rp.status = 'pending' THEN rp.referrer_amount_stroops ELSE 0 END)::numeric / 10000000)::numeric(20,7)::text, '0') AS total_pending_bonuses_usdc
     FROM referrals r
     LEFT JOIN referral_payouts rp ON r.id = rp.referral_id
     WHERE r.referrer_id = $1`,
    [userId]
  );

  const totals = totalsResult.rows[0] || {
    total_referrals: "0",
    total_paid: "0",
    total_pending_bonuses_usdc: "0",
  };

  res.json({
    referralCode,
    referrals: referralsResult.rows,
    summary: {
      total_referrals: parseInt(totals.total_referrals, 10),
      total_paid: parseInt(totals.total_paid, 10),
      total_pending_bonuses_usdc: totals.total_pending_bonuses_usdc,
    },
  });
});

export default router;
