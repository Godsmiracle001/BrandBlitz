import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error";
import challengesRouter from "./challenges";

const mocks = vi.hoisted(() => ({
  user: null as { sub: string; role: string } | null,
  getChallengeByIdAny: vi.fn(),
  getBrandById: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../db/queries/challenges", () => ({
  getActiveChallenges: vi.fn(),
  getActiveChallengesCursor: vi.fn(),
  getFilteredChallenges: vi.fn(),
  getChallengeByIdAny: mocks.getChallengeByIdAny,
  getChallengesByBrandId: vi.fn(),
  getChallengeQuestions: vi.fn(),
}));

vi.mock("../db/queries/brands", () => ({
  getBrandById: mocks.getBrandById,
}));

vi.mock("../db/queries/sessions", () => ({
  getLeaderboard: vi.fn(),
  getArchivedLeaderboard: vi.fn(),
  LEADERBOARD_SORTS: ["score"],
}));

vi.mock("../db/index", () => ({
  query: mocks.query,
  pool: { connect: vi.fn() },
}));

vi.mock("../middleware/authenticate", () => ({
  optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!mocks.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = mocks.user as express.Request["user"];
    next();
  },
}));

vi.mock("../middleware/rate-limit", () => ({
  reportLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../lib/cache", () => ({
  withCoalescing: vi.fn(),
}));

vi.mock("../lib/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock("../lib/config", () => ({
  config: { HOT_WALLET_PUBLIC_KEY: "test-wallet", NODE_ENV: "test" },
}));

function createApp() {
  const app = express();
  app.use("/challenges", challengesRouter);
  app.use(errorHandler);
  return app;
}

const challenge = { id: "challenge-1", brand_id: "brand-1", archived: false };
const stats = {
  total_sessions: 10,
  completed_sessions: 8,
  completion_rate_pct: 80,
  disqualification_rate_pct: 10,
  avg_score: 112.5,
  avg_accuracy_pct: 75,
  avg_time_per_round_ms: 850.25,
  total_paid_out_usdc: 24,
  cost_per_completed_session_usdc: 3,
  unique_participants: 9,
};

describe("GET /challenges/:id/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { sub: "owner-1", role: "brand" };
    mocks.getChallengeByIdAny.mockResolvedValue(challenge);
    mocks.getBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: "owner-1" });
    mocks.query.mockResolvedValue({ rows: [stats] });
  });

  it("returns all aggregate metrics for the brand owner", async () => {
    const response = await request(createApp()).get("/challenges/challenge-1/stats");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ stats });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("session_round_scores"), [
      "challenge-1",
    ]);
    const sql = mocks.query.mock.calls[0][0] as string;
    expect(sql).toContain("srs.answer = cq.correct_option");
    expect(sql).toContain("status IN ('completed', 'sent', 'confirmed')");
  });

  it("rejects a caller who does not own the challenge brand", async () => {
    mocks.getBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: "another-user" });

    const response = await request(createApp()).get("/challenges/challenge-1/stats");

    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("allows an admin to inspect any challenge", async () => {
    mocks.user = { sub: "admin-1", role: "admin" };

    const response = await request(createApp()).get("/challenges/challenge-1/stats");

    expect(response.status).toBe(200);
    expect(response.body.stats.completed_sessions).toBe(8);
    expect(mocks.getBrandById).not.toHaveBeenCalled();
  });

  it("returns 404 when the challenge does not exist", async () => {
    mocks.getChallengeByIdAny.mockResolvedValue(null);

    const response = await request(createApp()).get("/challenges/missing/stats");

    expect(response.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    mocks.user = null;

    const response = await request(createApp()).get("/challenges/challenge-1/stats");

    expect(response.status).toBe(401);
  });
});
