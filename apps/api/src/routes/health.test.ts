import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  redisPing: vi.fn(),
  horizonRoot: vi.fn(),
}));

vi.mock("../db", () => ({
  pool: { query: mocks.dbQuery },
}));

vi.mock("../lib/redis", () => ({
  redis: { ping: mocks.redisPing },
}));

vi.mock("../lib/config", () => ({
  config: { STELLAR_NETWORK: "testnet" },
}));

vi.mock("@brandblitz/stellar", () => ({
  getHorizonServer: vi.fn(() => ({ root: mocks.horizonRoot })),
}));

import healthRoutes from "./health";

function buildApp() {
  const app = express();
  app.use("/health", healthRoutes);
  app.use(errorHandler);
  return app;
}

describe("GET /health — dependency health checks (#392)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQuery.mockResolvedValue({ rows: [] });
    mocks.redisPing.mockResolvedValue("PONG");
    mocks.horizonRoot.mockResolvedValue({ horizon_version: "1.0" });
  });

  it("returns 200 with status ok when DB, Redis, and Stellar are all healthy", async () => {
    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("includes per-dependency db/redis/stellar status fields when healthy", async () => {
    const res = await request(buildApp()).get("/health");

    expect(res.body.db).toBe("ok");
    expect(res.body.redis).toBe("ok");
    expect(res.body.stellar).toBe("ok");
  });

  it("returns 503 when the PostgreSQL check throws", async () => {
    mocks.dbQuery.mockRejectedValue(new Error("connection terminated"));

    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.db).toBe("error");
    expect(res.body.redis).toBe("ok");
    expect(res.body.stellar).toBe("ok");
  });

  it("returns 503 when the Redis ping fails", async () => {
    mocks.redisPing.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.redis).toBe("error");
    expect(res.body.db).toBe("ok");
    expect(res.body.stellar).toBe("ok");
  });

  it("returns 503 when the Stellar Horizon reachability check fails", async () => {
    mocks.horizonRoot.mockRejectedValue(new Error("Horizon unreachable"));

    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.stellar).toBe("error");
    expect(res.body.db).toBe("ok");
    expect(res.body.redis).toBe("ok");
  });

  it("returns status degraded with a non-empty body when a dependency is down, not an empty response", async () => {
    mocks.dbQuery.mockRejectedValue(new Error("timeout"));

    const res = await request(buildApp()).get("/health");

    expect(res.body.status).toBe("degraded");
    expect(Object.keys(res.body).length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty("db");
    expect(res.body).toHaveProperty("redis");
    expect(res.body).toHaveProperty("stellar");
  });

  it("does not require authentication — no Authorization header is sent or needed", async () => {
    const res = await request(buildApp()).get("/health");

    // No Authorization header was set on this request at all, and the route
    // is mounted with no auth middleware in front of it — a 401/403 here
    // would mean auth got applied where the route contract says it shouldn't.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
