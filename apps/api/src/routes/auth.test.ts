import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import authRouter from "./auth";
import { createError, errorHandler } from "../middleware/error";
import type { User } from "../db/queries/users";

const mocks = vi.hoisted(() => ({
  upsertUser: vi.fn(),
  findUserById: vi.fn(),
  findUserByReferralCode: vi.fn(),
  getUserReferralCode: vi.fn(),
  setUserReferralCode: vi.fn(),
  updateLastLogin: vi.fn(),
  query: vi.fn(),
  verifyGoogleIdToken: vi.fn(),
  exchangeGoogleAuthorizationCode: vi.fn(),
  createGooglePkceAuthorizationUrl: vi.fn(),
  ensureUserReferralCode: vi.fn(),
  consumePendingReferralAttribution: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisSadd: vi.fn(),
  redisExpire: vi.fn(),
  redisSmembers: vi.fn(),
  redisPipelineSet: vi.fn(),
  redisPipelineDel: vi.fn(),
  redisPipelineExec: vi.fn(),
}));

const TEST_JWT_SECRET = "test-jwt-secret";
const TEST_JWT_REFRESH_SECRET = "test-refresh-secret";

vi.mock("../db/queries/users", () => ({
  upsertUser: mocks.upsertUser,
  findUserById: mocks.findUserById,
  findUserByReferralCode: mocks.findUserByReferralCode,
  getUserReferralCode: mocks.getUserReferralCode,
  setUserReferralCode: mocks.setUserReferralCode,
  updateLastLogin: mocks.updateLastLogin,
}));

vi.mock("../db", () => ({
  query: mocks.query,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    sadd: mocks.redisSadd,
    expire: mocks.redisExpire,
    smembers: mocks.redisSmembers,
    pipeline: () => ({
      set: mocks.redisPipelineSet,
      del: mocks.redisPipelineDel,
      exec: mocks.redisPipelineExec,
    }),
  },
}));

vi.mock("../services/referrals", () => ({
  ensureUserReferralCode: mocks.ensureUserReferralCode,
  consumePendingReferralAttribution: mocks.consumePendingReferralAttribution,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    sadd: mocks.redisSadd,
    expire: mocks.redisExpire,
    smembers: mocks.redisSmembers,
    pipeline: mocks.redisPipeline,
    del: vi.fn(),
  },
}));

vi.mock("../lib/config", () => ({
  config: {
    JWT_SECRET: "test-jwt-secret",
    JWT_REFRESH_SECRET: "test-refresh-secret",
    NODE_ENV: "test",
  },
}));

vi.mock("../services/google-auth", () => ({
  verifyGoogleIdToken: mocks.verifyGoogleIdToken,
  exchangeGoogleAuthorizationCode: mocks.exchangeGoogleAuthorizationCode,
  createGooglePkceAuthorizationUrl: mocks.createGooglePkceAuthorizationUrl,
}));

vi.mock("../services/referrals", () => ({
  ensureUserReferralCode: mocks.ensureUserReferralCode,
  consumePendingReferralAttribution: mocks.consumePendingReferralAttribution,
}));

vi.mock("../middleware/rate-limit", () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  app.use(errorHandler);
  return app;
}

function signAccessToken(user: Pick<User, "id" | "email" | "role">): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role ?? "player",
      iss: "brandblitz-api",
      aud: "brandblitz-client",
    },
    process.env.JWT_SECRET!,
    { expiresIn: "15m" }
  );
}

function signRefreshToken(user: Pick<User, "id" | "email">): string {
  return jwt.sign(
    { sub: user.id, email: user.email, type: "refresh", jti: "seed-refresh-token" },
    TEST_JWT_REFRESH_SECRET,
    { expiresIn: "30d" }
  );
}

const userFixture: User = {
  id: "user-123",
  email: "player@example.com",
  google_id: "google-123",
  display_name: "Player One",
  username: "player1",
  league: "gold",
  total_score: 4200,
  total_earned_usdc: "123.4500000",
  challenges_played: 12,
  role: "player",
  status: "active",
  phone_hash: "secret-phone-hash",
  phone_verified: true,
  age_verified: true,
  kyc_complete: false,
  stellar_address: null,
  embedded_wallet_address: null,
  avatar_url: "https://example.com/avatar.png",
  state_code: null,
  streak: 4,
  last_play_day: null,
  streak_repairs_this_month: 0,
  streak_repair_available: false,
  created_at: "2026-04-24T00:00:00.000Z",
  updated_at: "2026-04-24T00:00:00.000Z",
};

describe("auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUserReferralCode.mockResolvedValue("REF123");
    mocks.consumePendingReferralAttribution.mockResolvedValue(undefined);
    mocks.findUserByReferralCode.mockResolvedValue(null);
    mocks.getUserReferralCode.mockResolvedValue("REF123");
    mocks.setUserReferralCode.mockResolvedValue(undefined);
    mocks.updateLastLogin.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisSadd.mockResolvedValue(1);
    mocks.redisExpire.mockResolvedValue(1);
    mocks.redisSmembers.mockResolvedValue([]);
    mocks.redisPipelineSet.mockReturnThis();
    mocks.redisPipelineDel.mockReturnThis();
    mocks.redisPipelineExec.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a JWT and refresh token for a valid Google token", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue({
      googleId: "google-123",
      email: userFixture.email,
      name: userFixture.display_name,
      avatarUrl: userFixture.avatar_url,
    });
    mocks.upsertUser.mockResolvedValue(userFixture);

    const response = await request(createTestApp())
      .post("/auth/google/callback")
      .send({ idToken: "valid-google-token" })
      .expect(200);

    expect(mocks.verifyGoogleIdToken).toHaveBeenCalledWith("valid-google-token");
    expect(mocks.upsertUser).toHaveBeenCalledWith({
      email: userFixture.email,
      googleId: "google-123",
      name: userFixture.display_name,
      avatarUrl: userFixture.avatar_url,
    });
    expect(response.body.user).toEqual({
      id: userFixture.id,
      email: userFixture.email,
      displayName: userFixture.display_name,
      username: userFixture.username,
      avatarUrl: userFixture.avatar_url,
      role: userFixture.role,
      status: "active",
    });

    const accessPayload = jwt.verify(response.body.token, TEST_JWT_SECRET) as {
      sub: string;
      email: string;
    };
    const refreshPayload = jwt.verify(
      response.body.refreshToken,
      TEST_JWT_REFRESH_SECRET
    ) as { sub: string; email: string; type: string };

    expect(accessPayload.sub).toBe(userFixture.id);
    expect(accessPayload.email).toBe(userFixture.email);
    expect(refreshPayload.sub).toBe(userFixture.id);
    expect(refreshPayload.type).toBe("refresh");
  });

  it("starts a Google PKCE authorization flow", async () => {
    mocks.createGooglePkceAuthorizationUrl.mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=state-123",
      state: "state-123",
      codeChallenge: "challenge-123",
      codeChallengeMethod: "S256",
      expiresIn: 300,
    });

    const response = await request(createTestApp())
      .get("/auth/google/authorize")
      .query({ callbackUrl: "/leaderboard" })
      .expect(200);

    expect(mocks.createGooglePkceAuthorizationUrl).toHaveBeenCalledWith("/leaderboard");
    expect(response.body).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=state-123",
      state: "state-123",
      codeChallenge: "challenge-123",
      codeChallengeMethod: "S256",
      expiresIn: 300,
    });
  });

  it("exchanges a Google authorization code with PKCE state", async () => {
    mocks.exchangeGoogleAuthorizationCode.mockResolvedValue({
      googleId: "google-123",
      email: userFixture.email,
      name: userFixture.display_name,
      avatarUrl: userFixture.avatar_url,
    });
    mocks.upsertUser.mockResolvedValue(userFixture);

    const response = await request(createTestApp())
      .post("/auth/google/callback")
      .send({ code: "google-code", state: "oauth-state" })
      .expect(200);

    expect(mocks.exchangeGoogleAuthorizationCode).toHaveBeenCalledWith({
      code: "google-code",
      state: "oauth-state",
    });
    expect(response.body.user.id).toBe(userFixture.id);
  });

  it("returns the existing user record for an existing Google ID", async () => {
    mocks.verifyGoogleIdToken.mockResolvedValue({
      googleId: userFixture.google_id,
      email: userFixture.email,
      name: userFixture.display_name,
      avatarUrl: userFixture.avatar_url,
    });
    mocks.upsertUser.mockResolvedValue(userFixture);

    const response = await request(createTestApp())
      .post("/auth/google/callback")
      .send({ idToken: "existing-user-token" })
      .expect(200);

    expect(response.body.user.id).toBe(userFixture.id);
    expect(mocks.upsertUser).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid Google token", async () => {
    mocks.verifyGoogleIdToken.mockRejectedValue(
      createError("Invalid Google token", 401, "INVALID_GOOGLE_TOKEN")
    );

    const response = await request(createTestApp())
      .post("/auth/google/callback")
      .send({ idToken: "bad-token" })
      .expect(401);

    expect(response.body).toEqual({
      error: "Invalid Google token",
      code: "INVALID_GOOGLE_TOKEN",
    });
  });

  it("returns only safe user fields from /auth/me", async () => {
    mocks.findUserById.mockResolvedValue(userFixture);

    const response = await request(createTestApp())
      .get("/auth/me")
      .set("Authorization", `Bearer ${signAccessToken(userFixture)}`)
      .expect(200);

    expect(mocks.findUserById).toHaveBeenCalledWith(userFixture.id);
    expect(response.body.user).toEqual({
      id: userFixture.id,
      email: userFixture.email,
      displayName: userFixture.display_name,
      username: userFixture.username,
      avatarUrl: userFixture.avatar_url,
      role: userFixture.role,
      status: "active",
    });
    expect(response.body.user.google_id).toBeUndefined();
    expect(response.body.user.phone_hash).toBeUndefined();
  });

  it("rotates access and refresh tokens with a valid refresh token", async () => {
    mocks.findUserById.mockResolvedValue(userFixture);
    const refreshToken = signRefreshToken(userFixture);

    const response = await request(createTestApp())
      .post("/auth/refresh")
      .send({ refreshToken })
      .expect(200);

    expect(response.body.token).not.toBe(refreshToken);
    expect(response.body.refreshToken).not.toBe(refreshToken);

    const nextAccessPayload = jwt.verify(response.body.token, TEST_JWT_SECRET) as {
      sub: string;
      email: string;
    };

    expect(nextAccessPayload.sub).toBe(userFixture.id);
    expect(nextAccessPayload.email).toBe(userFixture.email);
  });

  it("rejects an invalid refresh token", async () => {
    const response = await request(createTestApp())
      .post("/auth/refresh")
      .send({ refreshToken: "not-a-valid-token" })
      .expect(401);

    expect(response.body).toEqual({
      error: "Invalid refresh token",
      code: "INVALID_REFRESH_TOKEN",
    });
  });
});
