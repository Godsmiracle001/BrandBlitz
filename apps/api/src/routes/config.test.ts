import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error";

const mocks = vi.hoisted(() => ({
  getPublicConfig: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  user: null as { sub: string; role: string } | null,
}));

vi.mock("../db/queries/config", () => ({
  getPublicConfig: mocks.getPublicConfig,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
  },
}));

vi.mock("../lib/config", () => ({
  config: { NODE_ENV: "test" },
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
}));

import configRouter, {
  PUBLIC_CONFIG_CACHE_KEY,
  PUBLIC_CONFIG_CACHE_TTL_SECONDS,
} from "./config";
import adminCacheRouter from "./admin/cache";

function createApp() {
  const app = express();
  app.use("/config", configRouter);
  app.use("/admin/cache", adminCacheRouter);
  app.use(errorHandler);
  return app;
}

describe("public config cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = null;
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
  });

  it("queries Postgres once and serves the following request from Redis", async () => {
    const payload = { game_round_duration_seconds: 30 };
    mocks.getPublicConfig.mockResolvedValue(payload);
    mocks.redisGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(payload));

    const app = createApp();
    const first = await request(app).get("/config").expect(200);
    const second = await request(app).get("/config").expect(200);

    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(first.body).toEqual(second.body);
    expect(first.body).toEqual(payload);
    expect(mocks.getPublicConfig).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      PUBLIC_CONFIG_CACHE_KEY,
      JSON.stringify(payload),
      "EX",
      PUBLIC_CONFIG_CACHE_TTL_SECONDS,
    );
  });

  it("sets a Cache-Control header with the expected max-age", async () => {
    mocks.getPublicConfig.mockResolvedValue({});
    mocks.redisGet.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app).get("/config").expect(200);

    expect(res.headers["cache-control"]).toBe(
      `public, max-age=${PUBLIC_CONFIG_CACHE_TTL_SECONDS}`,
    );
  });

  it("returns an empty object when no whitelisted keys exist in app_config", async () => {
    mocks.getPublicConfig.mockResolvedValue({});
    mocks.redisGet.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app).get("/config").expect(200);

    expect(res.body).toEqual({});
  });

  it("allows only admins to flush the public config cache", async () => {
    const app = createApp();

    await request(app).post("/admin/cache/config/flush").expect(401);

    mocks.user = { sub: "player", role: "player" };
    await request(app).post("/admin/cache/config/flush").expect(403);

    mocks.user = { sub: "admin", role: "admin" };
    await request(app).post("/admin/cache/config/flush").expect(204);
    expect(mocks.redisDel).toHaveBeenCalledWith(PUBLIC_CONFIG_CACHE_KEY);
  });
});
