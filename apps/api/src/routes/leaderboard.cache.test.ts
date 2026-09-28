import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

jest.mock("../lib/redis", () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    keys: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../lib/metrics", () => ({ metrics: { inc: jest.fn() } }));
jest.mock("../lib/cache", () => ({
  withCoalescing: jest.fn((_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
}));

const mockGetLeaderboard = jest.fn();
jest.mock("../db/queries/sessions", () => ({
  getLeaderboard: mockGetLeaderboard,
  getTopSessionsPerChallenge: jest.fn().mockResolvedValue([]),
  getGlobalLeaderboardFromView: jest.fn().mockResolvedValue([]),
  LEADERBOARD_SORTS: ["score", "earned"],
}));

jest.mock("../db/queries/challenges", () => ({
  getActiveChallenges: jest.fn().mockResolvedValue([]),
}));

jest.mock("../middleware/error", () => ({
  createError: jest.fn((msg: string, code: number) => {
    const e = new Error(msg) as any;
    e.status = code;
    return e;
  }),
}));

import express from "express";
import request from "supertest";
import router from "./leaderboard";

const app = express();
app.use(express.json());
app.use("/leaderboard", router);

const fakeSession = {
  id: "s1",
  user_id: "u1",
  username: "alice",
  display_name: "Alice",
  league: "gold",
  avatar_url: null,
  total_score: 300,
  total_earned_usdc: "1.0",
  completed_at: null,
};

describe("leaderboard cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns cached response and does not call DB on cache HIT", async () => {
    const cached = {
      sessions: [{ rank: 1, userId: "u1", username: "alice", displayName: "Alice", league: "gold", avatarUrl: null, totalScore: 300, totalEarned: "1.0", endedAt: null }],
      data: [],
      nextCursor: null,
    };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

    const res = await request(app).get("/leaderboard/challenge-1");
    expect(res.status).toBe(200);
    expect(mockGetLeaderboard).not.toHaveBeenCalled();
    expect(res.headers["x-cache"]).toBe("HIT");
  });

  it("calls DB on cache MISS and stores result", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockRedisSet.mockResolvedValueOnce("OK");
    mockGetLeaderboard.mockResolvedValueOnce([fakeSession]);

    const res = await request(app).get("/leaderboard/challenge-1");
    expect(res.status).toBe(200);
    expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);
    expect(mockRedisSet).toHaveBeenCalled();
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("sets X-Cache: HIT header on cache hit", async () => {
    const cached = { sessions: [], data: [], nextCursor: null };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

    const res = await request(app).get("/leaderboard/challenge-99");
    expect(res.headers["x-cache"]).toBe("HIT");
  });
});
