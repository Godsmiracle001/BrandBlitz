import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisKeys = jest.fn().mockResolvedValue([]);

jest.mock("../lib/redis", () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    keys: mockRedisKeys,
    exists: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock("../lib/metrics", () => ({ metrics: { inc: jest.fn() } }));

const mockGetActiveChallengesCursor = jest.fn();
jest.mock("../db/queries/challenges", () => ({
  getActiveChallenges: jest.fn().mockResolvedValue([]),
  getActiveChallengesCursor: mockGetActiveChallengesCursor,
  getChallengeByIdAny: jest.fn(),
  getChallengesByBrandId: jest.fn().mockResolvedValue([]),
  getChallengeQuestions: jest.fn().mockResolvedValue([]),
}));

jest.mock("../db/queries/brands", () => ({
  getBrandById: jest.fn().mockResolvedValue(null),
}));

jest.mock("../db/queries/sessions", () => ({
  getLeaderboard: jest.fn().mockResolvedValue([]),
  getArchivedLeaderboard: jest.fn().mockResolvedValue([]),
  LEADERBOARD_SORTS: ["score", "earned"],
}));

jest.mock("../middleware/authenticate", () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  authenticate: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/error", () => ({
  createError: jest.fn((msg: string, code: number) => {
    const e = new Error(msg) as any;
    e.status = code;
    return e;
  }),
}));

jest.mock("../lib/cache", () => ({
  withCoalescing: jest.fn((_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
}));

jest.mock("../lib/config", () => ({ config: { HOT_WALLET_PUBLIC_KEY: "GTEST" } }));
jest.mock("../db/index", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));

import express from "express";
import request from "supertest";
import router from "./challenges";
import { invalidateChallengesCache } from "../lib/cache-tags";

const app = express();
app.use(express.json());
app.use("/challenges", router);

describe("challenges cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveChallengesCursor.mockResolvedValue({ challenges: [], nextCursor: null });
  });

  it("does not query DB when cache has a value (HIT)", async () => {
    const cached = { challenges: [{ id: "c1" }], nextCursor: null };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));
    (require("../lib/cache").withCoalescing as jest.Mock).mockImplementationOnce(
      async (_key: string, _ttl: number, _loader: () => Promise<unknown>) => cached
    );

    const res = await request(app).get("/challenges");
    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("HIT");
  });

  it("queries DB on cache MISS", async () => {
    mockRedisGet.mockResolvedValueOnce(null);

    const res = await request(app).get("/challenges");
    expect(res.status).toBe(200);
    expect(mockGetActiveChallengesCursor).toHaveBeenCalled();
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("invalidateChallengesCache deletes all challenges:active:* keys", async () => {
    mockRedisKeys.mockResolvedValueOnce(["challenges:active:global:start:20"]);
    mockRedisDel.mockResolvedValueOnce(1);

    await invalidateChallengesCache();
    expect(mockRedisDel).toHaveBeenCalledWith("challenges:active:global:start:20");
  });
});
