import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisUnlink = jest.fn();

jest.mock("../lib/redis", () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    unlink: mockRedisUnlink,
  },
}));

const mockQuery = jest.fn();
jest.mock("../db/index", () => ({ query: mockQuery }));

jest.mock("../middleware/authenticate", () => ({
  authenticate: (_req: any, _res: any, next: any) => {
    _req.user = { sub: "admin-user", role: "admin" };
    next();
  },
}));

jest.mock("../middleware/require-admin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    if (!req.user || req.user.role !== "admin") {
      const err: any = new Error("Forbidden");
      err.status = 403;
      throw err;
    }
    next();
  },
}));

import express from "express";
import request from "supertest";
import router from "./badges";

const app = express();
app.use(express.json());
app.use("/badges", router);

// Admin app with admin user
const adminApp = express();
adminApp.use(express.json());
adminApp.use("/badges", router);

// Non-admin app
const noAuthApp = express();
noAuthApp.use(express.json());
noAuthApp.use((req: any, _res: any, next: any) => {
  req.user = { sub: "user-1", role: "user" };
  next();
});
noAuthApp.use("/badges", router);

const fakeBadges = [
  { id: "b1", slug: "first-win", name: "First Win", description: "Win first challenge", iconUrl: null },
];

describe("badges cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("skips DB on second request within TTL (cache HIT)", async () => {
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(fakeBadges));

    const res = await request(app).get("/badges");
    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res.headers["x-cache"]).toBe("HIT");
    expect(res.body.badges).toHaveLength(1);
  });

  it("calls DB on cache MISS and caches the result", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({ rows: fakeBadges });
    mockRedisSet.mockResolvedValueOnce("OK");

    const res = await request(app).get("/badges");
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockRedisSet).toHaveBeenCalledWith("badges:definitions", JSON.stringify(fakeBadges), "EX", 86400);
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("flush endpoint returns 204 and calls redis.unlink", async () => {
    mockRedisUnlink.mockResolvedValueOnce(1);

    const res = await request(adminApp).post("/badges/flush");
    expect(res.status).toBe(204);
    expect(mockRedisUnlink).toHaveBeenCalledWith("badges:definitions");
  });

  it("flush endpoint returns 403 for non-admin", async () => {
    const res = await request(noAuthApp).post("/badges/flush");
    expect(res.status).toBe(403);
  });
});
