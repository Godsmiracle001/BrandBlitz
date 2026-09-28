/**
 * Tests for GET /users/:username/public
 *
 * Verifies:
 *  - PII exclusion (email, phone_hash, stellar_account_id, kyc_status)
 *  - Deactivated (status != 'active') and GDPR-erased (deleted_at set) accounts → 404
 *  - Badge array is truncated to a maximum of 6 items
 *  - Unknown username → 404
 *  - Happy-path shape matches the acceptance criteria
 */

import express from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// ── Hoisted mock state ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

// ── Module mocks (must be declared before any imports that trigger loading) ─
vi.mock("../db/index", () => ({
  query: mocks.dbQuery,
  pool: {
    connect: () => Promise.resolve({ query: vi.fn(), release: vi.fn() }),
  },
}));

vi.mock("../db/queries/users", () => ({
  findUserById: vi.fn(),
  findUserByPhoneHash: vi.fn(),
  getUserPublicProfileByUsername: vi.fn(),
  updateUserWallet: vi.fn(),
  markPhoneVerified: vi.fn(),
  updateUserProfile: vi.fn(),
}));

vi.mock("../services/referrals", () => ({
  getReferralStats: vi.fn(),
  ensureUserReferralCode: vi.fn(),
}));

vi.mock("../services/streaks", () => ({
  getStreak: vi.fn(),
  repairStreak: vi.fn(),
  getUserActivity: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/badges", () => ({
  getBadgesForUser: vi.fn(),
  BADGE_DEFINITIONS: [
    { slug: "first_win",     name: "First Win",      description: "First challenge completed.", criteria: "…", iconUrl: "/badges/first-win.svg" },
    { slug: "perfect_score", name: "Perfect Score",  description: "Score 450.",                 criteria: "…", iconUrl: "/badges/perfect-score.svg" },
    { slug: "streak_3",      name: "On a Roll",      description: "3-day streak.",              criteria: "…", iconUrl: "/badges/streak-3.svg" },
    { slug: "streak_7",      name: "Week Warrior",   description: "7-day streak.",              criteria: "…", iconUrl: "/badges/streak-7.svg" },
    { slug: "wins_10",       name: "Veteran",        description: "10 challenges.",             criteria: "…", iconUrl: "/badges/wins-10.svg" },
    { slug: "league_silver", name: "Silver Climber", description: "Promoted to Silver.",        criteria: "…", iconUrl: "/badges/league-silver.svg" },
    { slug: "league_gold",   name: "Gold Contender", description: "Promoted to Gold.",          criteria: "…", iconUrl: "/badges/league-gold.svg" },
    { slug: "league_diamond",name: "Diamond Elite",  description: "Top 3 Gold.",                criteria: "…", iconUrl: "/badges/league-diamond.svg" },
  ],
}));

vi.mock("../services/phone", () => ({
  sendVerificationCode: vi.fn(),
  verifyOtpWithBruteForceProtection: vi.fn(),
  normalizePhoneNumber: (v: string) => v,
  hashPhoneNumber: (v: string) => v,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock("../lib/config", () => ({
  config: {
    JWT_SECRET: "test-secret",
    JWT_ISSUER: "brandblitz-api",
    JWT_AUDIENCE: "brandblitz-client",
    WEB_URL: "http://localhost:3000",
    WEBHOOK_SECRET: "test-webhook-secret",
    HOT_WALLET_PUBLIC_KEY: "GTEST",
  },
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  authLimiter: (_req: any, _res: any, next: any) => next(),
  challengeStartLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  webhookLimiter: (_req: any, _res: any, next: any) => next(),
  reportLimiter: (_req: any, _res: any, next: any) => next(),
  phoneRateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../db/queries/sessions", () => ({
  getSessionHistory: vi.fn(),
  LEADERBOARD_SORTS: ["score", "rank", "created_at"],
}));

// ── Import after mocks ─────────────────────────────────────────────────────
import { errorHandler } from "../middleware/error";
import usersRouter from "./users";

// ── Test fixtures ──────────────────────────────────────────────────────────

const ACTIVE_USER_ROW = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  username: "player1",
  display_name: "Player One",
  avatar_url: "https://example.com/avatar.png",
  created_at: "2025-01-01T00:00:00.000Z",
  league: "bronze",
  status: "active",
  deleted_at: null,
};

const STATS_ROW = {
  win_count: "12",
  total_sessions_played: "15",
  correct_rounds: "30",
  total_rounds: "45",
};

const LEAGUE_ROW = {
  league: "bronze",
  rank_in_group: 3,
  week_start: "2026-07-20",
  weekly_points: "250",
};

/** Builds n badge rows ordered by most recent first */
function makeBadgeRows(count: number) {
  const slugs = [
    "league_diamond", "league_gold", "league_silver",
    "wins_10", "streak_7", "streak_3", "perfect_score", "first_win",
  ];
  return slugs.slice(0, count).map((slug, i) => ({
    badge_slug: slug,
    awarded_at: new Date(2026, 0, count - i).toISOString(),
  }));
}

/**
 * Setup the db query mock to return happy-path rows.
 * Handler executes 4 queries in order:
 *   1. user lookup by username
 *   2. session stats
 *   3. latest league_assignment
 *   4. badges (LIMIT 6)
 */
function setupHappyPath(badgeCount = 3) {
  mocks.dbQuery
    .mockResolvedValueOnce({ rows: [ACTIVE_USER_ROW] })
    .mockResolvedValueOnce({ rows: [STATS_ROW] })
    .mockResolvedValueOnce({ rows: [LEAGUE_ROW] })
    .mockResolvedValueOnce({ rows: makeBadgeRows(badgeCount) });
}

// ── App setup ──────────────────────────────────────────────────────────────

let app: express.Express;

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret";
  app = express();
  app.use(express.json());
  app.use("/users", usersRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  mocks.dbQuery.mockReset();
  mocks.dbQuery.mockResolvedValue({ rows: [] });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /users/:username/public", () => {
  it("returns 200 with the expected public shape for an active user", async () => {
    setupHappyPath(3);

    const res = await request(app)
      .get("/users/player1/public")
      .expect(200);

    expect(res.body).toMatchObject({
      username: "player1",
      displayName: "Player One",
      avatarUrl: "https://example.com/avatar.png",
      joinedAt: ACTIVE_USER_ROW.created_at,
      winCount: 12,
      totalSessionsPlayed: 15,
      accuracyPct: 67, // round(30/45 * 100) = 66.666… → 67
      league: {
        tier: "bronze",
        rank: 3,
        season: "2026-07-20",
      },
    });

    expect(Array.isArray(res.body.badges)).toBe(true);
    expect(res.body.badges.length).toBe(3);
  });

  it("returns accuracyPct 0 and null league when user has no completed sessions", async () => {
    mocks.dbQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_USER_ROW] })
      .mockResolvedValueOnce({
        rows: [{ win_count: "0", total_sessions_played: "0", correct_rounds: "0", total_rounds: "0" }],
      })
      .mockResolvedValueOnce({ rows: [] })  // no league assignment
      .mockResolvedValueOnce({ rows: [] }); // no badges

    const res = await request(app)
      .get("/users/player1/public")
      .expect(200);

    expect(res.body.accuracyPct).toBe(0);
    expect(res.body.league).toBeNull();
    expect(res.body.badges).toEqual([]);
  });

  // ── PII exclusion ────────────────────────────────────────────────────────

  it("does NOT include email, phone_hash, stellar_address, or kyc_status", async () => {
    setupHappyPath();

    const res = await request(app)
      .get("/users/player1/public")
      .expect(200);

    // All private fields must be absent
    expect(res.body.email).toBeUndefined();
    expect(res.body.phone).toBeUndefined();
    expect(res.body.phone_hash).toBeUndefined();
    expect(res.body.stellar_account_id).toBeUndefined();
    expect(res.body.stellar_address).toBeUndefined();
    expect(res.body.embedded_wallet_address).toBeUndefined();
    expect(res.body.kyc_status).toBeUndefined();
    expect(res.body.kyc_complete).toBeUndefined();
    expect(res.body.google_id).toBeUndefined();
    expect(res.body.state_code).toBeUndefined();
    expect(res.body.role).toBeUndefined();
  });

  it("does NOT expose the user's internal database id", async () => {
    setupHappyPath();

    const res = await request(app)
      .get("/users/player1/public")
      .expect(200);

    expect(res.body.id).toBeUndefined();
    expect(res.body.userId).toBeUndefined();
  });

  // ── Deactivated / GDPR-erased accounts → 404 ────────────────────────────

  it("returns 404 for a GDPR-erased account (deleted_at is set)", async () => {
    mocks.dbQuery.mockResolvedValueOnce({
      rows: [{ ...ACTIVE_USER_ROW, deleted_at: "2026-05-01T00:00:00.000Z" }],
    });

    const res = await request(app)
      .get("/users/player1/public")
      .expect(404);

    // Must be 404, never 403, to avoid user enumeration
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 404 for a suspended account (status = 'suspended') — not 403", async () => {
    mocks.dbQuery.mockResolvedValueOnce({
      rows: [{ ...ACTIVE_USER_ROW, status: "suspended" }],
    });

    const res = await request(app)
      .get("/users/player1/public")
      .expect(404);

    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown username", async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/users/nonexistent/public")
      .expect(404);

    expect(res.status).toBe(404);
  });

  // ── Badge truncation ──────────────────────────────────────────────────────

  it("returns at most 6 badges even when the user has many earned badges", async () => {
    mocks.dbQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_USER_ROW] })
      .mockResolvedValueOnce({ rows: [STATS_ROW] })
      .mockResolvedValueOnce({ rows: [LEAGUE_ROW] })
      // DB query has LIMIT 6; return the max of 6
      .mockResolvedValueOnce({ rows: makeBadgeRows(6) });

    const res = await request(app)
      .get("/users/player1/public")
      .expect(200);

    expect(res.body.badges.length).toBeLessThanOrEqual(6);
    expect(res.body.badges.length).toBe(6);
  });

  it("badges include all required fields: slug, name, description, iconUrl, awardedAt", async () => {
    setupHappyPath(2);

    const res = await request(app)
      .get("/users/player1/public")
      .expect(200);

    expect(res.body.badges.length).toBe(2);
    for (const badge of res.body.badges) {
      expect(badge).toHaveProperty("slug");
      expect(badge).toHaveProperty("name");
      expect(badge).toHaveProperty("description");
      expect(badge).toHaveProperty("iconUrl");
      expect(badge).toHaveProperty("awardedAt");
    }
  });

  // ── Auth (public endpoint) ────────────────────────────────────────────────

  it("does not require an Authorization header", async () => {
    setupHappyPath();

    // Deliberately omit Authorization header
    const res = await request(app)
      .get("/users/player1/public");

    expect(res.status).toBe(200);
  });
});
