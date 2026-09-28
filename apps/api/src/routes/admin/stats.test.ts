import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../../middleware/error";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  currentUser: { sub: "admin-1", email: "admin@example.com", role: "admin" },
}));

vi.mock("../../db/index", () => ({ query: mocks.query }));
vi.mock("../../lib/redis", () => ({
  redis: { get: mocks.redisGet, set: mocks.redisSet },
}));

vi.mock("../../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = mocks.currentUser;
    next();
  },
}));

vi.mock("../../middleware/require-admin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    if (req.user?.role !== "admin") {
      const err: any = new Error("Forbidden");
      err.statusCode = 403;
      throw err;
    }
    next();
  },
}));

import statsRouter from "./stats";

function createApp() {
  const app = express();
  app.use("/admin/stats", statsRouter);
  app.use(errorHandler);
  return app;
}

const dbRows = {
  dau: [{ date: "2026-07-20", dau: 5 }],
  usdc: [{ date: "2026-07-20", total_usdc: "10.0000000" }],
  topBrands: [{ brand_id: "b1", brand_name: "Acme", completed_sessions: 3 }],
  summary: { total_users: 100, total_paid_usdc: "10.0000000", total_completed_sessions: 3 },
};

describe("GET /admin/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { sub: "admin-1", email: "admin@example.com", role: "admin" };
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.query
      .mockResolvedValueOnce({ rows: dbRows.dau })
      .mockResolvedValueOnce({ rows: dbRows.usdc })
      .mockResolvedValueOnce({ rows: dbRows.topBrands })
      .mockResolvedValueOnce({ rows: [dbRows.summary] });
  });

  it("returns 403 for non-admins", async () => {
    mocks.currentUser = { sub: "user-1", email: "user@example.com", role: "player" } as any;

    const response = await request(createApp()).get("/admin/stats");

    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("computes and caches aggregates on a cache miss", async () => {
    const response = await request(createApp()).get("/admin/stats");

    expect(response.status).toBe(200);
    expect(response.body.cacheHit).toBe(false);
    expect(response.body.computedAt).toEqual(expect.any(String));
    expect(response.body.summary).toEqual(dbRows.summary);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      "admin:stats:30",
      expect.any(String),
      "EX",
      60
    );
  });

  it("returns the cached payload on a cache hit without querying the DB", async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({
        dau: dbRows.dau,
        usdcVolume: dbRows.usdc,
        topBrands: dbRows.topBrands,
        summary: dbRows.summary,
        period: { days: 30, since: "2026-06-24T00:00:00.000Z" },
        computedAt: "2026-07-24T00:00:00.000Z",
      })
    );

    const response = await request(createApp()).get("/admin/stats");

    expect(response.status).toBe(200);
    expect(response.body.cacheHit).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("bypasses the cache when refresh=true", async () => {
    mocks.redisGet.mockResolvedValue(JSON.stringify({ summary: dbRows.summary }));

    const response = await request(createApp()).get("/admin/stats?refresh=true");

    expect(response.status).toBe(200);
    expect(response.body.cacheHit).toBe(false);
    expect(mocks.query).toHaveBeenCalled();
  });
});
