import { Router } from "express";
import { z } from "zod";
import { getActiveChallenges } from "../db/queries/challenges";
import {
  getLeaderboard,
  getLeaderboardForCsvExport,
  getTopSessionsPerChallenge,
  getGlobalLeaderboardFromView,
  LEADERBOARD_SORTS,
  type LeaderboardSort,
} from "../db/queries/sessions";
import { getReferralNetworkUserIds } from "../db/queries/referrals";
import { withCoalescing } from "../lib/cache";
import { CursorQuerySchema } from "../db/pagination";
import { createError } from "../middleware/error";
import { optionalAuth } from "../middleware/authenticate";

const router = Router();

const LEADERBOARD_CACHE_TTL_SEC = 30;

// Keep leaderboard ORDER BY clauses static or selected from this allowlist only.
// User query params must never be concatenated directly into SQL strings.
const LeaderboardSortSchema = z.enum(LEADERBOARD_SORTS).default("score");

function parseLeaderboardSort(query: unknown): LeaderboardSort {
  const raw =
    typeof query === "object" && query !== null
      ? ((query as Record<string, unknown>).sort_by ?? (query as Record<string, unknown>).order)
      : undefined;
  const parsed = LeaderboardSortSchema.safeParse(raw);
  if (!parsed.success) {
    throw createError(
      `Invalid leaderboard sort. Allowed values: ${LEADERBOARD_SORTS.join(", ")}`,
      400,
      "INVALID_SORT"
    );
  }
  return parsed.data;
}

function writeSse(res: any, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * GET /leaderboard/stream
 * Server-Sent Events feed for global or per-challenge leaderboard snapshots.
 *
 * Query params:
 *  - challengeId?: string
 *  - intervalMs?: number (default 2000, min 500)
 */
router.get("/stream", async (req, res) => {
  parseLeaderboardSort(req.query);
  const { challengeId, intervalMs } = z
    .object({
      challengeId: z.string().optional(),
      intervalMs: z.coerce.number().min(500).max(30_000).default(2000),
    })
    .parse(req.query);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendSnapshot = async () => {
    if (challengeId) {
      const { sessions } = await getLeaderboard(challengeId, 100);
      writeSse(res, {
        challengeId,
        sessions: sessions.map((s, i) => ({
          rank: i + 1,
          userId: s.user_id,
          username: s.username,
          displayName: s.display_name,
          league: s.league,
          avatarUrl: s.avatar_url,
          totalScore: s.total_score,
          totalEarned: s.total_earned_usdc,
          endedAt: s.completed_at,
        })),
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const { challenges } = await getActiveChallenges(10);
    const challengeIds = challenges.map((c) => c.id);
    const topSessions = await getTopSessionsPerChallenge(challengeIds, 10);

    const rankPerChallenge = new Map<string, number>();
    const leaderboard = topSessions.map((s) => {
      const rank = (rankPerChallenge.get(s.challenge_id) ?? 0) + 1;
      rankPerChallenge.set(s.challenge_id, rank);
      return {
        rank,
        challengeId: s.challenge_id,
        userId: s.user_id,
        username: s.username,
        displayName: s.display_name,
        league: s.league,
        avatarUrl: s.avatar_url,
        totalScore: s.total_score,
        totalEarned: s.total_earned_usdc,
      };
    });

    writeSse(res, { leaderboard, updatedAt: new Date().toISOString() });
  };

  const heartbeat = setInterval(() => res.write(`:keep-alive\n\n`), 15_000);

  try {
    await sendSnapshot();
  } catch {
    // ignore initial snapshot error; clients will fall back to polling
  }

  const timer = setInterval(() => {
    sendSnapshot().catch(() => {});
  }, intervalMs);

  req.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
});

/**
 * GET /leaderboard/global
 * Cross-challenge leaderboard (cached in Redis, 5 min TTL).
 * Single aggregated query via ROW_NUMBER() — no N+1.
 */
router.get("/global", async (req, res) => {
  const sortBy = parseLeaderboardSort(req.query);
  const { limit } = CursorQuerySchema.parse(req.query);

  const response = await withCoalescing(`leaderboard:global:${sortBy}:${limit}`, 300, async () => {
    const { challenges } = await getActiveChallenges(10);
    const challengeIds = challenges.map((c) => c.id);

    const viewRows = await getGlobalLeaderboardFromView(challengeIds, 10);

    const data = viewRows.map((s) => ({
      rank: s.rank,
      challengeId: s.challenge_id,
      userId: s.user_id,
      username: s.username,
      displayName: s.display_name,
      league: s.league,
      avatarUrl: s.avatar_url,
      totalScore: s.total_score,
      totalEarned: s.total_earned_usdc,
    }));

    return {
      data,
      nextCursor: null,
      cachedAt: new Date().toISOString(),
    };
  });

  res.json(response);
});

function escapeCsv(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * GET /leaderboard/:challengeId/export.csv
 * Export challenge leaderboard standings as CSV stream.
 */
router.get("/:challengeId/export.csv", optionalAuth, async (req, res, next) => {
  try {
    const { challengeId } = req.params;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leaderboard-${challengeId}.csv"`);
    res.setHeader("Cache-Control", "no-cache, no-transform");

    res.write("rank,username,score,payout_amount_usdc\n");

    const batchSize = 500;
    let cursor: string | undefined = undefined;
    let rankCounter = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await getLeaderboardForCsvExport(challengeId, batchSize, cursor);
      if (!result.sessions || result.sessions.length === 0) {
        break;
      }

      for (const s of result.sessions) {
        const rank = rankCounter++;
        const username = escapeCsv(s.username || s.display_name || "Anonymous");
        const score = s.total_score;
        const payout = escapeCsv(s.payout_amount_usdc || "0");

        res.write(`${rank},${username},${score},${payout}\n`);
      }

      if (!result.nextCursor || result.sessions.length < batchSize) {
        hasMore = false;
      } else {
        cursor = result.nextCursor;
      }
    }

    res.end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /leaderboard/:challengeId
 * Paginated leaderboard for a challenge. Supports keyset cursor pagination.
 *
 * Query params:
 *  - scope: "global" (default) | "friends" — filter to referral network
 */
router.get("/:challengeId", optionalAuth, async (req, res) => {
  const sortBy = parseLeaderboardSort(req.query);
  const { limit, cursor, offset } = CursorQuerySchema.parse(req.query);
  const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : undefined;
  const scope = scopeRaw === "friends" ? "friends" : "global";
  const userId = req.user?.sub;

  if (offset !== undefined) {
    res.setHeader("Deprecation", "offset");
    res.setHeader(
      "Link",
      '<https://docs.api.brandblitz.com/pagination>; rel="deprecation"; type="text/html"'
    );
  }

  const friendUserIds: string[] = [];
  if (scope === "friends" && userId) {
    const ids = await getReferralNetworkUserIds(userId);
    friendUserIds.push(...ids);
  }

  const scopeKey = scope === "friends" ? `friends:${userId ?? "anon"}` : "global";
  const cacheKey = `leaderboard:${sortBy}:${req.params.challengeId}:${limit}:${cursor ?? ""}:${scopeKey}`;

  const responseBody = await withCoalescing(cacheKey, LEADERBOARD_CACHE_TTL_SEC, async () => {
    const scopeFriendIds = scope === "friends" ? friendUserIds : undefined;
    const result = await getLeaderboard(
      req.params.challengeId,
      limit,
      cursor,
      sortBy,
      scopeFriendIds
    );

    const mappedSessions = result.sessions.map((s, i) => ({
      rank: i + 1,
      userId: s.user_id,
      username: s.username,
      displayName: s.display_name,
      league: s.league,
      avatarUrl: s.avatar_url,
      totalScore: s.total_score,
      totalEarned: s.total_earned_usdc,
    }));

    return {
      sessions: mappedSessions,
      data: mappedSessions,
      nextCursor: result.nextCursor,
      scope,
    };
  });

  res.json(responseBody);
});

export default router;
