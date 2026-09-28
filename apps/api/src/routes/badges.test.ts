import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

var mockGetUserBadges = vi.fn();
var mockRedisGet = vi.fn();
var mockRedisSet = vi.fn();
var mockRedisDel = vi.fn();

vi.mock("../db/queries/badges", () => ({
  getUserBadges: mockGetUserBadges,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  },
}));

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

vi.mock("../middleware/authenticate", () => {
  const JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const JWTModule = require("jsonwebtoken");
  return {
    authenticateOptional: (req: any, _res: any, next: any) => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (token) {
        try {
          const payload = JWTModule.verify(token, JWT_SECRET);
          req.user = payload;
        } catch {
          // Ignore
        }
      }
      next();
    },
    authenticate: (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) {
        res.status(401).json({ error: "No token provided" });
        return;
      }
      try {
        const payload = JWTModule.verify(token, JWT_SECRET);
        req.user = payload;
        next();
      } catch {
        res.status(401).json({ error: "Invalid token" });
      }
    },
  };
});

vi.mock("../middleware/require-admin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    if (!req.user || req.user.role !== "admin") {
      const err: any = new Error("Forbidden");
      err.statusCode = 403;
      throw err;
    }
    next();
  },
}));

import router from "./badges";
import { errorHandler } from "../middleware/error";

let app: express.Express;
const userId = "user-123";

const authToken = (role = "user") =>
  jwt.sign({ sub: userId, email: "me@example.com", role }, process.env.JWT_SECRET as string, {
    expiresIn: "1h",
  });

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use("/badges", router);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /badges", () => {
  it("returns all badge definitions without authentication", async () => {
    mockRedisGet.mockResolvedValueOnce(null);

    const response = await request(app)
      .get("/badges")
      .expect(200);

    expect(response.body).toHaveLength(8);
    expect(response.body[0]).toMatchObject({
      id: "first_win",
      name: "First Win",
      description: expect.any(String),
      iconUrl: expect.any(String),
      category: "achievement",
      unlockCriteria: expect.any(String),
    });
    expect(response.body[0].earned).toBeUndefined();
    expect(response.body[0].earnedAt).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("returns badges with earned status when authenticated", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockGetUserBadges.mockResolvedValueOnce([
      {
        id: "b1",
        user_id: userId,
        badge_slug: "first_win",
        awarded_at: "2026-04-24T10:00:00Z",
        created_at: "2026-04-24T10:00:00Z",
        updated_at: "2026-04-24T10:00:00Z",
      },
    ]);

    const response = await request(app)
      .get("/badges")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body).toHaveLength(8);
    const firstWin = response.body.find((b: any) => b.id === "first_win");
    expect(firstWin).toMatchObject({
      earned: true,
      earnedAt: "2026-04-24T10:00:00Z",
    });

    const perfect = response.body.find((b: any) => b.id === "perfect_score");
    expect(perfect).toMatchObject({
      earned: false,
      earnedAt: null,
    });
  });

  it("filters badges by category", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockGetUserBadges.mockResolvedValueOnce([]);

    const response = await request(app)
      .get("/badges?category=streak")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body).toHaveLength(2);
    expect(response.body[0].category).toBe("streak");
    expect(response.body[1].category).toBe("streak");
  });

  it("returns empty array for non-existent category", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockGetUserBadges.mockResolvedValueOnce([]);

    const response = await request(app)
      .get("/badges?category=nonexistent")
      .set("Authorization", `Bearer ${authToken()}`)
      .expect(200);

    expect(response.body).toHaveLength(0);
  });

  it("rejects invalid query parameters", async () => {
    const response = await request(app)
      .get("/badges?category=123&invalid=param")
      .expect(400);

    expect(response.body.error).toBe("Invalid query parameters");
  });
});
