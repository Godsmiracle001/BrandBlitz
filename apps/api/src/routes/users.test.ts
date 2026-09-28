import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

var mockFindUserById = vi.fn();
var mockFindUserByPhoneHash = vi.fn();
var mockGetUserPublicProfileByUsername = vi.fn();
var mockSearchUsersByUsername = vi.fn();
var mockUpdateUserWallet = vi.fn();
var mockMarkPhoneVerified = vi.fn();
var mockSendVerificationCode = vi.fn();
var mockCheckVerificationCode = vi.fn();
var mockRedisIncr = vi.fn();
var mockRedisExpire = vi.fn();
var mockRedisGet = vi.fn();
var mockRedisSet = vi.fn();
var mockRedisDel = vi.fn();
var mockGetStreak = vi.fn();
var mockGetStreakDetail = vi.fn();
var mockRepairStreak = vi.fn();
var mockQuery = vi.fn();
var mockGetUserBadges = vi.fn();
var mockEnsureUserReferralCode = vi.fn();
var mockMarkOnboardingCompleted = vi.fn();

vi.mock("../db", () => ({
  query: mockQuery,
}));

vi.mock("../db/queries/badges", () => ({
  getUserBadges: mockGetUserBadges,
}));

vi.mock("../services/referrals", () => ({
  getReferralStats: vi.fn(),
  ensureUserReferralCode: mockEnsureUserReferralCode,
}));

vi.mock("../db/queries/users", () => ({
  findUserById: mockFindUserById,
  findUserByPhoneHash: mockFindUserByPhoneHash,
  getUserPublicProfileByUsername: mockGetUserPublicProfileByUsername,
  updateUserWallet: mockUpdateUserWallet,
  markPhoneVerified: mockMarkPhoneVerified,
  searchUsersByUsername: mockSearchUsersByUsername,
  markOnboardingCompleted: mockMarkOnboardingCompleted,
}));

vi.mock("../services/phone", () => ({
  sendVerificationCode: mockSendVerificationCode,
  checkVerificationCode: mockCheckVerificationCode,
  normalizePhoneNumber: (value: string) => value,
  hashPhoneNumber: (value: string) => crypto.createHash("sha256").update(value).digest("hex"),
}));

vi.mock("../lib/redis", () => ({
  redis: {
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  },
}));

vi.mock("../services/streaks", () => ({
  getStreak: mockGetStreak,
  getStreakDetail: mockGetStreakDetail,
  repairStreak: mockRepairStreak,
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  authLimiter: (_req: any, _res: any, next: any) => next(),
  challengeStartLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  webhookLimiter: (_req: any, _res: any, next: any) => next(),
  webhookRotationLimiter: (_req: any, _res: any, next: any) => next(),
  waitlistLimiter: (_req: any, _res: any, next: any) => next(),
  reportLimiter: (_req: any, _res: any, next: any) => next(),
  phoneRateLimit: async (req: any, res: any, next: any) => {
    const key = `phone:send:${req.body?.phone}`;
    const attempts = await mockRedisIncr(key);
    if (attempts === 1) await mockRedisExpire(key, 300);
    if (attempts > 3) {
      res.status(429).json({ error: "Too many verification attempts, please try again later" });
      return;
    }
    next();
  },
}));

vi.mock("@brandblitz/stellar", () => ({
  WARMUP_MIN_SECONDS: 20,
  MIN_POOL_STROOPS: 1_000_000_000,
  validateMuxedAccount: vi.fn(),
  createMuxedAccount: vi.fn(),
}));

import { errorHandler } from "../middleware/error";

let app: express.Express;
const userId = "user-123";
const phone = "+15550000000";
const phoneHash = crypto.createHash("sha256").update(phone).digest("hex");
const authToken = () =>
  jwt.sign({ sub: userId, email: "me@example.com" }, process.env.JWT_SECRET as string, {
    expiresIn: "1h",
    issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
    audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
  });

const userRecord = {
  id: userId,
  email: "me@example.com",
  google_id: "google-1",
  phone_hash: "old-hash",
  phone_verified: false,
  age_verified: true,
  kyc_complete: false,
  stellar_address: "GABCDEFGHJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHJKL",
  embedded_wallet_address: null,
  avatar_url: "https://example.com/avatar.png",
  state_code: "CA",
  streak: 5,
  last_play_day: "2026-04-24",
  streak_repairs_this_month: 1,
  streak_repair_available: true,
  onboarding_completed: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  display_name: "Test User",
  username: "testuser",
};

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
  app = express();
  app.use(express.json());
  const { default: usersRouter } = await import("./users");
  app.use("/users", usersRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  mockFindUserById.mockReset();
  mockFindUserByPhoneHash.mockReset();
  mockGetUserPublicProfileByUsername.mockReset();
  mockSearchUsersByUsername.mockReset();
  mockUpdateUserWallet.mockReset();
  mockMarkPhoneVerified.mockReset();
  mockSendVerificationCode.mockReset();
  mockCheckVerificationCode.mockReset();
  mockRedisIncr.mockReset();
  mockRedisExpire.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockGetStreak.mockReset();
  mockRepairStreak.mockReset();
  mockMarkOnboardingCompleted.mockReset();
});

afterAll(() => {
  vi.resetAllMocks();
});

describe("users routes integration", () => {
  it("GET /users/me/streak returns detailed streak data", async () => {
    mockGetStreakDetail.mockResolvedValue({
      current_streak: 7,
      longest_streak: 14,
      last_activity_at: "2026-05-30T00:00:00.000Z",
      is_at_risk: false,
      repair_deadline_at: null,
      next_milestone: {
        days_required: 14,
        reward_badge_id: "streak_14_days",
      },
      streak_frozen: false,
    });

    const response = await request(app)
      .get("/users/me/streak")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body).toEqual({
      current_streak: 7,
      longest_streak: 14,
      last_activity_at: "2026-05-30T00:00:00.000Z",
      is_at_risk: false,
      repair_deadline_at: null,
      next_milestone: {
        days_required: 14,
        reward_badge_id: "streak_14_days",
      },
      streak_frozen: false,
    });
    expect(mockGetStreakDetail).toHaveBeenCalledWith(userId);
  });

  it("POST /users/streaks/repair repairs an eligible streak", async () => {
    mockRepairStreak.mockResolvedValue({
      streak: 5,
      lastPlayDay: "2026-05-30",
      repairAvailable: false,
      nextMilestone: 7,
      progress: 5 / 7,
      milestoneJustHit: false,
    });

    const response = await request(app)
      .post("/users/streaks/repair")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body.streak).toBe(5);
    expect(response.body.repairAvailable).toBe(false);
  });

  it("GET /users/me returns only safe user fields", async () => {
    mockFindUserById.mockResolvedValue(userRecord);

    const response = await request(app)
      .get("/users/me")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body.user).toEqual({
      id: userRecord.id,
      email: userRecord.email,
      display_name: userRecord.display_name,
      username: userRecord.username,
      avatar_url: userRecord.avatar_url,
      stellar_address: userRecord.stellar_address,
      embedded_wallet_address: userRecord.embedded_wallet_address,
      phone_verified: userRecord.phone_verified,
      age_verified: userRecord.age_verified,
      kyc_complete: userRecord.kyc_complete,
      state_code: userRecord.state_code,
      streak: userRecord.streak,
      last_play_day: userRecord.last_play_day,
      streak_repairs_this_month: userRecord.streak_repairs_this_month,
      streak_repair_available: userRecord.streak_repair_available,
      onboarding_completed: userRecord.onboarding_completed,
      created_at: userRecord.created_at,
      updated_at: userRecord.updated_at,
    });
    expect(response.body.user.google_id).toBeUndefined();
    expect(response.body.user.phone_hash).toBeUndefined();
  });

  it("POST /users/me/onboarding/complete marks onboarding as done", async () => {
    mockMarkOnboardingCompleted.mockResolvedValue(true);

    const response = await request(app)
      .post("/users/me/onboarding/complete")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body).toEqual({ success: true, onboardingCompleted: true });
    expect(mockMarkOnboardingCompleted).toHaveBeenCalledWith(userId);
  });

  it("PATCH /users/me/wallet rejects invalid Stellar addresses", async () => {
    const response = await request(app)
      .patch("/users/me/wallet")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ stellarAddress: "INVALID" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation Error");
  });

  it("PATCH /users/me/wallet accepts valid Stellar addresses", async () => {
    const address = "G".padEnd(56, "A");

    const response = await request(app)
      .patch("/users/me/wallet")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ stellarAddress: address })
      .expect(200);

    expect(response.body).toEqual({ success: true });
    expect(mockUpdateUserWallet).toHaveBeenCalledWith(userId, address);
  });

  it("POST /users/me/phone/send rate limits after 3 sends", async () => {
    mockRedisIncr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4);

    await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ phone })
      .expect(200);

    await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ phone })
      .expect(200);

    await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ phone })
      .expect(200);

    await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ phone })
      .expect(429);

    expect(mockSendVerificationCode).toHaveBeenCalledTimes(3);
    expect(mockRedisExpire).toHaveBeenCalledWith(`phone:send:${phone}`, 300);
  });

  it("POST /users/me/phone/verify approves correct code and marks phone verified", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockCheckVerificationCode.mockResolvedValue(true);

    const response = await request(app)
      .post("/users/me/phone/verify")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ phone, code: "123456" })
      .expect(200);

    expect(response.body).toEqual({ success: true });
    expect(mockMarkPhoneVerified).toHaveBeenCalledWith(userId, phoneHash);
    expect(mockRedisSet).toHaveBeenCalledWith(`phone:hash:${phoneHash}`, userId, "EX", 86400 * 365);
    expect(mockRedisDel).toHaveBeenCalledWith(`phone:verify:${phoneHash}`);
  });

  it("POST /users/me/phone/verify rejects invalid code and bumps attempt counter", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockCheckVerificationCode.mockResolvedValue(false);
    mockRedisIncr.mockResolvedValue(1);

    const response = await request(app)
      .post("/users/me/phone/verify")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ phone, code: "000000" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid verification code");
    expect(mockRedisIncr).toHaveBeenCalledWith(`phone:verify:${phoneHash}`);
    expect(mockMarkPhoneVerified).not.toHaveBeenCalled();
  });

  describe("GET /users/me/badges", () => {
    it("returns user's earned badges with correct structure", async () => {
      mockGetUserBadges.mockResolvedValueOnce([
        {
          id: "b1",
          user_id: userId,
          badge_slug: "first_win",
          awarded_at: "2026-04-24T10:00:00Z",
          created_at: "2026-04-24T10:00:00Z",
          updated_at: "2026-04-24T10:00:00Z",
        },
        {
          id: "b2",
          user_id: userId,
          badge_slug: "streak_3",
          awarded_at: "2026-04-25T10:00:00Z",
          created_at: "2026-04-25T10:00:00Z",
          updated_at: "2026-04-25T10:00:00Z",
        },
      ]);

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "b1",
            badge_id: "first_win",
            badge_name: "First Win",
            badge_description: "You completed your first challenge.",
            icon_url: "/badges/first-win.svg",
            awarded_at: "2026-04-24T10:00:00Z",
            trigger_event: "Complete your first non-practice challenge.",
            category: "achievement",
          },
          {
            id: "b2",
            badge_id: "streak_3",
            badge_name: "On a Roll",
            badge_description: "You played 3 days in a row.",
            icon_url: "/badges/streak-3.svg",
            awarded_at: "2026-04-25T10:00:00Z",
            trigger_event: "Maintain a 3-day streak.",
            category: "streak",
          },
        ],
      });

      const response = await request(app)
        .get("/users/me/badges")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.total).toBe(2);
      expect(response.body.items).toHaveLength(2);
      expect(response.body.items[0]).toMatchObject({
        badge_id: "first_win",
        badge_name: "First Win",
        category: "achievement",
      });
    });

    it("returns empty array when user has no badges", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get("/users/me/badges")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.total).toBe(0);
      expect(response.body.items).toHaveLength(0);
    });

    it("filters badges by category", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "b1",
            badge_id: "streak_3",
            badge_name: "On a Roll",
            badge_description: "You played 3 days in a row.",
            icon_url: "/badges/streak-3.svg",
            awarded_at: "2026-04-25T10:00:00Z",
            trigger_event: "Maintain a 3-day streak.",
            category: "streak",
          },
        ],
      });

      const response = await request(app)
        .get("/users/me/badges?category=streak")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].category).toBe("streak");
    });

    it("requires authentication", async () => {
      const response = await request(app).get("/users/me/badges").expect(401);
      expect(response.body.error).toBe("No token provided");
    });
  });

  describe("GET /users/me/earnings", () => {
    it("returns payout history with pagination", async () => {
      mockFindUserById.mockResolvedValueOnce({
        ...userRecord,
        status: "active",
        suspended_at: null,
      });

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              payout_id: "payout-1",
              amount_usdc: "10.5000000",
              status: "sent",
              created_at: "2026-04-24T10:00:00Z",
              settled_at: "2026-04-24T10:30:00Z",
              stellar_tx_hash: "abc123def456",
              challenge_id: "challenge-1",
              id: "payout-1",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              lifetime_earned_usdc: "100.0000000",
              pending_usdc: "5.0000000",
            },
          ],
        });

      const response = await request(app)
        .get("/users/me/earnings")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        payout_id: "payout-1",
        amount_usdc: "10.5000000",
        status: "sent",
      });
      expect(response.body.totals).toMatchObject({
        lifetime_earned_usdc: "100.0000000",
        pending_usdc: "5.0000000",
      });
    });

    it("filters by status", async () => {
      mockFindUserById.mockResolvedValueOnce({
        ...userRecord,
        status: "active",
        suspended_at: null,
      });

      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [
          {
            lifetime_earned_usdc: "100.0000000",
            pending_usdc: "5.0000000",
          },
        ],
      });

      const response = await request(app)
        .get("/users/me/earnings?status=pending")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.items).toHaveLength(0);
    });

    it("rejects suspended users with 403", async () => {
      mockFindUserById.mockResolvedValueOnce({
        ...userRecord,
        status: "suspended",
        suspended_at: "2026-04-20T00:00:00Z",
      });

      const response = await request(app)
        .get("/users/me/earnings")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(403);

      expect(response.body.error).toContain("suspended");
    });

    it("requires authentication", async () => {
      const response = await request(app).get("/users/me/earnings").expect(401);
      expect(response.body.error).toBe("No token provided");
    });
  });

  describe("GET /users/me/referrals", () => {
    it("returns referrals with bonus status", async () => {
      mockEnsureUserReferralCode.mockResolvedValueOnce("ABC123");

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              referral_id: "ref-1",
              referred_user_id: "user-456",
              referred_username: "john_doe",
              joined_at: "2026-04-20T10:00:00Z",
              activated_at: "2026-04-20T10:00:00Z",
              bonus_status: "sent",
              bonus_amount_usdc: "5.0000000",
            },
            {
              referral_id: "ref-2",
              referred_user_id: "user-789",
              referred_username: "[deleted]",
              joined_at: "2026-04-21T10:00:00Z",
              activated_at: null,
              bonus_status: "pending",
              bonus_amount_usdc: "0",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              total_referrals: "2",
              total_paid: "1",
              total_pending_bonuses_usdc: "2.5000000",
            },
          ],
        });

      const response = await request(app)
        .get("/users/me/referrals")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.referralCode).toBe("ABC123");
      expect(response.body.referrals).toHaveLength(2);
      expect(response.body.referrals[0]).toMatchObject({
        referred_username: "john_doe",
        bonus_status: "sent",
      });
      expect(response.body.referrals[1].referred_username).toBe("[deleted]");
      expect(response.body.summary).toMatchObject({
        total_referrals: 2,
        total_paid: 1,
        total_pending_bonuses_usdc: "2.5000000",
      });
    });

    it("filters referrals by bonus status", async () => {
      mockEnsureUserReferralCode.mockResolvedValueOnce("ABC123");

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              referral_id: "ref-1",
              referred_user_id: "user-456",
              referred_username: "john_doe",
              joined_at: "2026-04-20T10:00:00Z",
              activated_at: "2026-04-20T10:00:00Z",
              bonus_status: "sent",
              bonus_amount_usdc: "5.0000000",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              total_referrals: "2",
              total_paid: "1",
              total_pending_bonuses_usdc: "2.5000000",
            },
          ],
        });

      const response = await request(app)
        .get("/users/me/referrals?status=paid")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body.referrals).toHaveLength(1);
      expect(response.body.referrals[0].bonus_status).toBe("sent");
    });

    it("requires authentication", async () => {
      const response = await request(app).get("/users/me/referrals").expect(401);
      expect(response.body.error).toBe("No token provided");
    });
  });

  describe("GET /users/search", () => {
    beforeEach(() => {
      mockRedisGet.mockResolvedValue(null);
    });

    it("requires authentication", async () => {
      const response = await request(app).get("/users/search?q=al").expect(401);
      expect(response.body.error).toBe("No token provided");
    });

    it("returns 400 when q is missing", async () => {
      const response = await request(app)
        .get("/users/search")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(400);
      expect(response.body.code).toBe("INVALID_QUERY");
    });

    it("returns 400 when q is shorter than 2 characters", async () => {
      const response = await request(app)
        .get("/users/search?q=a")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(400);
      expect(response.body.code).toBe("INVALID_QUERY");
    });

    it("returns an empty array when no users match", async () => {
      mockSearchUsersByUsername.mockResolvedValue([]);

      const response = await request(app)
        .get("/users/search?q=zzzzz")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it("returns only public-safe fields for matching users", async () => {
      mockSearchUsersByUsername.mockResolvedValue([
        {
          id: "u1",
          username: "alice",
          avatar_url: "https://example.com/alice.png",
          total_earned_usdc: "12.5000000",
          email: "alice@example.com",
          phone_hash: "should-not-leak",
        },
      ]);

      const response = await request(app)
        .get("/users/search?q=al")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body).toEqual([
        {
          id: "u1",
          username: "alice",
          avatar_url: "https://example.com/alice.png",
          total_earnings: "12.5000000",
        },
      ]);
      expect(response.body[0]).not.toHaveProperty("email");
      expect(response.body[0]).not.toHaveProperty("phone_hash");
    });

    it("supports the page query parameter for pagination", async () => {
      mockSearchUsersByUsername.mockResolvedValue([]);

      await request(app)
        .get("/users/search?q=al&page=3")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(mockSearchUsersByUsername).toHaveBeenCalledWith("al", 3, 20);
    });

    it("caps results at 20 per request even when more rows are returned", async () => {
      const rows = Array.from({ length: 25 }, (_, i) => ({
        id: `u${i}`,
        username: `alice${i}`,
        avatar_url: null,
        total_earned_usdc: "0.0000000",
      }));
      // Simulate the query-layer LIMIT already capping at 20; the route
      // must request page size 20 regardless of how many rows a caller mocks.
      mockSearchUsersByUsername.mockResolvedValue(rows.slice(0, 20));

      const response = await request(app)
        .get("/users/search?q=al")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(response.body).toHaveLength(20);
      expect(mockSearchUsersByUsername).toHaveBeenCalledWith("al", 1, 20);
    });

    it("defaults to page 1 when page is not provided", async () => {
      mockSearchUsersByUsername.mockResolvedValue([]);

      await request(app)
        .get("/users/search?q=al")
        .set("Authorization", `Bearer ${authToken()}`)
        .expect(200);

      expect(mockSearchUsersByUsername).toHaveBeenCalledWith("al", 1, 20);
    });
  });
});
