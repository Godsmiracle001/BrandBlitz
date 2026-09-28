import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// In-memory Redis stand-in so the rolling failure counter behaves like the real
// thing across requests within a single test.
const store: Record<string, number> = {};

vi.mock("../lib/redis", () => ({
  redis: {
    get: vi.fn(async (k: string) => (k in store ? String(store[k]) : null)),
    ttl: vi.fn(async (k: string) => (k in store ? 3600 : -2)),
    incr: vi.fn(async (k: string) => {
      store[k] = (store[k] ?? 0) + 1;
      return store[k];
    }),
    expire: vi.fn(async () => 1),
  },
}));

vi.mock("../db/queries/config", () => ({ getConfig: vi.fn().mockResolvedValue(null) }));
vi.mock("../db/index", () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock("../lib/metrics", () => ({ metrics: { inc: vi.fn() } }));

import { requireSessionStartAllowed } from "../middleware/anti-cheat";
import { errorHandler } from "../middleware/error";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: "user-1", email: "u@example.com" };
    next();
  });
  // Handler always fails the start, mimicking invalid challenge / bad token.
  app.post("/sessions/:challengeId/start", requireSessionStartAllowed, (_req, res) => {
    res.status(400).json({ error: "Invalid challenge token" });
  });
  app.use(errorHandler);
  return app;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("POST /sessions/:challengeId/start lockout (issue #509)", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
  });

  it("returns 429 on the 11th attempt after 10 failed starts", async () => {
    const app = buildApp();

    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await request(app).post("/sessions/c1/start").send({ challengeToken: "bad" });
      expect(res.status).toBe(400);
      // Let the res "finish" listener record the failure before the next attempt.
      await flush();
    }

    expect(store["lockout:session_start:user-1"]).toBe(10);

    const blocked = await request(app).post("/sessions/c1/start").send({ challengeToken: "bad" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("does not lock out when starts succeed", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { sub: "user-2", email: "u2@example.com" };
      next();
    });
    app.post("/sessions/:challengeId/start", requireSessionStartAllowed, (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(errorHandler);

    for (let attempt = 1; attempt <= 15; attempt++) {
      const res = await request(app).post("/sessions/c1/start").send({});
      expect(res.status).toBe(200);
      await flush();
    }

    expect(store["lockout:session_start:user-2"]).toBeUndefined();
  });
});
