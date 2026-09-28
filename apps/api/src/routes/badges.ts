import { Router } from "express";
import { z } from "zod";
import { redis } from "../lib/redis";
import { authenticateOptional } from "../middleware/authenticate";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/require-admin";
import { createError } from "../middleware/error";
import { getUserBadges } from "../db/queries/badges";

const router = Router();

const BADGES_CACHE_TTL_SEC = 300;
const BADGES_CACHE_KEY = "badges:definitions";

interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  category: string;
  unlockCriteria: string;
}

const BADGE_CATALOG: BadgeDefinition[] = [
  {
    id: "first_win",
    name: "First Win",
    description: "You completed your first challenge.",
    iconUrl: "/badges/first-win.svg",
    category: "achievement",
    unlockCriteria: "Complete your first non-practice challenge.",
  },
  {
    id: "perfect_score",
    name: "Perfect Score",
    description: "You answered every question correctly with maximum speed.",
    iconUrl: "/badges/perfect-score.svg",
    category: "accuracy",
    unlockCriteria: "Score 450 points in a single challenge.",
  },
  {
    id: "streak_3",
    name: "On a Roll",
    description: "You played 3 days in a row.",
    iconUrl: "/badges/streak-3.svg",
    category: "streak",
    unlockCriteria: "Maintain a 3-day streak.",
  },
  {
    id: "streak_7",
    name: "Week Warrior",
    description: "You played 7 days in a row.",
    iconUrl: "/badges/streak-7.svg",
    category: "streak",
    unlockCriteria: "Maintain a 7-day streak.",
  },
  {
    id: "wins_10",
    name: "Veteran",
    description: "You have completed 10 challenges.",
    iconUrl: "/badges/wins-10.svg",
    category: "achievement",
    unlockCriteria: "Complete 10 non-practice challenges.",
  },
  {
    id: "league_silver",
    name: "Silver Climber",
    description: "You earned promotion to the Silver League.",
    iconUrl: "/badges/league-silver.svg",
    category: "league",
    unlockCriteria: "Finish in the top 3 of your Bronze league group.",
  },
  {
    id: "league_gold",
    name: "Gold Contender",
    description: "You earned promotion to the Gold League.",
    iconUrl: "/badges/league-gold.svg",
    category: "league",
    unlockCriteria: "Finish in the top 3 of your Silver league group.",
  },
  {
    id: "league_diamond",
    name: "Diamond Elite",
    description: "You finished in the top 3 of the Gold League.",
    iconUrl: "/badges/league-diamond.svg",
    category: "league",
    unlockCriteria: "Finish in the top 3 of your Gold league group.",
  },
];

/**
 * GET /api/badges
 * Returns all badge definitions. When authenticated, includes earned status and earnedAt timestamp.
 * Optional ?category= query parameter filters by category.
 * Unauthenticated responses cached for 5 minutes at CDN layer.
 */
router.get("/", authenticateOptional, async (req, res) => {
  const parsed = z
    .object({
      category: z.string().optional(),
    })
    .strict()
    .safeParse(req.query);

  if (!parsed.success) {
    throw createError("Invalid query parameters", 400, "INVALID_QUERY");
  }

  const { category } = parsed.data;

  let badges = [...BADGE_CATALOG];

  if (category) {
    badges = badges.filter((b) => b.category === category);
  }

  if (!req.user) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(badges);
    return;
  }

  const earnedBadges = await getUserBadges(req.user.sub);
  const earnedMap = new Map(earnedBadges.map((b) => [b.badge_slug, b]));

  const withStatus = badges.map((badge) => {
    const earned = earnedMap.get(badge.id);
    return {
      ...badge,
      earned: !!earned,
      earnedAt: earned?.awarded_at ?? null,
    };
  });

  res.json(withStatus);
});

/**
 * POST /api/admin/cache/badges/flush
 * Admin-only: flush the badges definitions cache.
 */
router.post("/flush", authenticate, requireAdmin, async (_req, res) => {
  // UNLINK reclaims memory off the event loop, so a flush never stalls concurrent reads.
  await redis.unlink(BADGES_CACHE_KEY);
  res.status(204).send();
});

export default router;
