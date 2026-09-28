import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate";
import { requireAdmin } from "../../middleware/require-admin";
import { query } from "../../db/index";
import { redis } from "../../lib/redis";

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

const StatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  refresh: z.coerce.boolean().default(false),
});

// Cached in Redis to avoid recomputing full-table aggregates on every admin
// dashboard load (issue #465). Keyed per `days` window since results differ.
const STATS_CACHE_TTL_SECONDS = 60;
function statsCacheKey(days: number): string {
  return `admin:stats:${days}`;
}

router.get("/", async (req, res) => {
  const { days, refresh } = StatsQuerySchema.parse(req.query);
  const cacheKey = statsCacheKey(days);

  if (!refresh) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      res.json({ ...JSON.parse(cached), cacheHit: true });
      return;
    }
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [dauResult, usdcResult, topBrandsResult, summaryResult] = await Promise.all([
    // DAU: unique users per day who completed at least one game_session
    query<{ date: string; dau: number }>(
      `SELECT DATE(completed_at) AS date, COUNT(DISTINCT user_id)::int AS dau
       FROM game_sessions
       WHERE completed_at IS NOT NULL AND completed_at >= $1
       GROUP BY DATE(completed_at)
       ORDER BY date ASC`,
      [since]
    ),

    // USDC volume per day from payouts
    query<{ date: string; total_usdc: string }>(
      `SELECT DATE(created_at) AS date,
              (SUM(amount_stroops) / 10000000)::numeric(20,7)::text AS total_usdc
       FROM payouts
       WHERE status IN ('sent', 'confirmed') AND created_at >= $1
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [since]
    ),

    // Top 10 brands by completed sessions
    query<{ brand_id: string; brand_name: string; completed_sessions: number }>(
      `SELECT b.id AS brand_id, b.name AS brand_name,
              COUNT(gs.id)::int AS completed_sessions
       FROM game_sessions gs
       JOIN challenges c ON gs.challenge_id = c.id
       JOIN brands b ON c.brand_id = b.id
       WHERE gs.status = 'completed' AND gs.completed_at >= $1
       GROUP BY b.id, b.name
       ORDER BY completed_sessions DESC
       LIMIT 10`,
      [since]
    ),

    // Summary stats
    query<{
      total_users: number;
      total_paid_usdc: string;
      total_completed_sessions: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE deleted_at IS NULL) AS total_users,
         COALESCE(
           (SELECT (SUM(amount_stroops) / 10000000)::numeric(20,7)::text
            FROM payouts WHERE status IN ('sent', 'confirmed')),
           '0'
         ) AS total_paid_usdc,
         (SELECT COUNT(*)::int FROM game_sessions WHERE status = 'completed') AS total_completed_sessions`
    ),
  ]);

  const payload = {
    dau: dauResult.rows,
    usdcVolume: usdcResult.rows,
    topBrands: topBrandsResult.rows,
    summary: summaryResult.rows[0],
    period: { days, since },
    computedAt: new Date().toISOString(),
  };

  await redis
    .set(cacheKey, JSON.stringify(payload), "EX", STATS_CACHE_TTL_SECONDS)
    .catch(() => {});

  res.json({ ...payload, cacheHit: false });
});

export default router;
