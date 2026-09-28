import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const mockQuery = vi.fn();
const mockFindUserById = vi.fn();

vi.mock("../../db", () => ({
  query: mockQuery,
  pool: {
    connect: vi.fn(),
  },
}));

vi.mock("../../db/queries/users", () => ({
  findUserById: mockFindUserById,
}));

vi.mock("../../middleware/rate-limit", () => ({
  webhookRotationLimiter: (_req: any, _res: any, next: any) => next(),
}));

import { errorHandler } from "../../middleware/error";

let app: express.Express;
const adminUserId = "admin-123";

const adminToken = () =>
  jwt.sign(
    { sub: adminUserId, email: "admin@example.com", role: "admin" },
    process.env.JWT_SECRET as string,
    {
      expiresIn: "1h",
      issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
      audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
    }
  );

const userToken = () =>
  jwt.sign(
    { sub: "user-456", email: "user@example.com", role: "user" },
    process.env.JWT_SECRET as string,
    {
      expiresIn: "1h",
      issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
      audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
    }
  );

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
  app = express();
  app.use(express.json());
  const { default: challengesRouter } = await import("./challenges");
  app.use("/admin/challenges", challengesRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  mockQuery.mockReset();
  mockFindUserById.mockReset();
});

describe("GET /admin/challenges", () => {
  it("returns 200 with a list of all challenges including draft and archived entries for admin", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "challenge-1",
          challenge_id: "memo-1",
          status: "active",
          pool_amount_usdc: "1000.00",
          escrow_address: "GABC123...",
          settlement_status: "pending",
          brand_name: "Brand A",
          brand_logo_url: "https://example.com/logo.png",
        },
        {
          id: "challenge-2",
          challenge_id: "memo-2",
          status: "draft",
          pool_amount_usdc: "500.00",
          escrow_address: "GDEF456...",
          settlement_status: "none",
          brand_name: "Brand B",
          brand_logo_url: "https://example.com/logo2.png",
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 2 }] });

    const response = await request(app)
      .get("/admin/challenges")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.challenges).toHaveLength(2);
    expect(response.body.challenges[0].escrow_address).toBeDefined();
    expect(response.body.challenges[0].settlement_status).toBeDefined();
    expect(response.body.pagination.total).toBe(2);
  });

  it("returns 403 from require-admin middleware when user role is not admin", async () => {
    const response = await request(app)
      .get("/admin/challenges")
      .set("Authorization", `Bearer ${userToken()}`)
      .expect(403);

    expect(response.body.error).toBe("Forbidden");
  });

  it("returns 401 from authenticate middleware when unauthenticated", async () => {
    const response = await request(app)
      .get("/admin/challenges")
      .expect(401);

    expect(response.body.error).toBeDefined();
  });

  it("the response includes internal fields (escrowAddress, settlementStatus) absent from the public challenges endpoint", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "challenge-1",
          challenge_id: "memo-1",
          status: "active",
          pool_amount_usdc: "1000.00",
          escrow_address: "GABC123...",
          settlement_status: "pending",
          brand_name: "Brand A",
          brand_logo_url: "https://example.com/logo.png",
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const response = await request(app)
      .get("/admin/challenges")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.challenges[0].escrow_address).toBe("GABC123...");
    expect(response.body.challenges[0].settlement_status).toBe("pending");
  });

  it("pagination parameters (page, limit) are respected and out-of-range values return 400", async () => {
    const response = await request(app)
      .get("/admin/challenges?page=0")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(400);

    expect(response.body.error).toBe("Invalid pagination parameters");
  });

  it("pagination with limit > 100 returns 400", async () => {
    const response = await request(app)
      .get("/admin/challenges?limit=101")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(400);

    expect(response.body.error).toBe("Invalid pagination parameters");
  });

  it("filtering by status query param correctly scopes the result set", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "challenge-1",
          challenge_id: "memo-1",
          status: "active",
          pool_amount_usdc: "1000.00",
          escrow_address: "GABC123...",
          settlement_status: "pending",
          brand_name: "Brand A",
          brand_logo_url: "https://example.com/logo.png",
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const response = await request(app)
      .get("/admin/challenges?status=active")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.challenges).toHaveLength(1);
    expect(response.body.challenges[0].status).toBe("active");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("AND c.status ="),
      expect.arrayContaining(["active"])
    );
  });

  it("pagination works correctly with default values", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const response = await request(app)
      .get("/admin/challenges")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.pagination.page).toBe(1);
    expect(response.body.pagination.limit).toBe(20);
    expect(response.body.pagination.total).toBe(0);
  });

  it("pagination works correctly with custom values", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const response = await request(app)
      .get("/admin/challenges?page=2&limit=10")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.pagination.page).toBe(2);
    expect(response.body.pagination.limit).toBe(10);
  });
});

describe("GET /admin/challenges/:id/fraud", () => {
  it("returns 200 with all fraud_flags rows associated with the given challengeId", async () => {
    const challengeId = "challenge-123";
    
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "flag-1",
          sessionId: "session-1",
          userId: "user-1",
          username: "user1",
          email: "user1@example.com",
          flagReason: "reaction_time_bot_threshold",
          details: { reactionTimeMs: 50 },
          flaggedAt: "2026-01-01T00:00:00Z",
          challengeId,
        },
        {
          id: "flag-2",
          sessionId: "session-2",
          userId: "user-2",
          username: "user2",
          email: "user2@example.com",
          flagReason: "clock_skew",
          details: { clockSkewMs: 10000 },
          flaggedAt: "2026-01-02T00:00:00Z",
          challengeId,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: challengeId }] });

    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0].sessionId).toBe("session-1");
    expect(response.body.data[0].userId).toBe("user-1");
    expect(response.body.data[0].username).toBe("user1");
    expect(response.body.data[0].flagReason).toBe("reaction_time_bot_threshold");
    expect(response.body.data[0].flaggedAt).toBeDefined();
  });

  it("each item in the response includes sessionId, userId, username, flagReason, and flaggedAt fields", async () => {
    const challengeId = "challenge-123";
    
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "flag-1",
          sessionId: "session-1",
          userId: "user-1",
          username: "user1",
          email: "user1@example.com",
          flagReason: "reaction_time_bot_threshold",
          details: {},
          flaggedAt: "2026-01-01T00:00:00Z",
          challengeId,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: challengeId }] });

    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.data[0]).toHaveProperty("sessionId");
    expect(response.body.data[0]).toHaveProperty("userId");
    expect(response.body.data[0]).toHaveProperty("username");
    expect(response.body.data[0]).toHaveProperty("flagReason");
    expect(response.body.data[0]).toHaveProperty("flaggedAt");
  });

  it("a challenge with no fraud flags returns 200 with an empty data array", async () => {
    const challengeId = "challenge-123";
    
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: challengeId }] });

    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.pagination.total).toBe(0);
  });

  it("requesting fraud flags for a non-existent challengeId returns 404", async () => {
    const challengeId = "challenge-123";
    
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // Challenge doesn't exist

    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(404);

    expect(response.body.error).toBe("Challenge not found");
  });

  it("a non-admin authenticated request returns 403 from require-admin middleware", async () => {
    const challengeId = "challenge-123";
    
    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud`)
      .set("Authorization", `Bearer ${userToken()}`)
      .expect(403);

    expect(response.body.error).toBe("Forbidden");
  });

  it("an unauthenticated request returns 401", async () => {
    const challengeId = "challenge-123";
    
    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud`)
      .expect(401);

    expect(response.body.error).toBeDefined();
  });

  it("the page and limit query parameters correctly paginate results and out-of-range values return 400", async () => {
    const challengeId = "challenge-123";
    
    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud?page=0`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(400);

    expect(response.body.error).toBe("Invalid pagination parameters");
  });

  it("pagination with limit > 100 returns 400", async () => {
    const challengeId = "challenge-123";
    
    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud?limit=101`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(400);

    expect(response.body.error).toBe("Invalid pagination parameters");
  });

  it("pagination works correctly with custom values", async () => {
    const challengeId = "challenge-123";
    
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: challengeId }] });

    const response = await request(app)
      .get(`/admin/challenges/${challengeId}/fraud?page=2&limit=10`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    expect(response.body.pagination.page).toBe(2);
    expect(response.body.pagination.limit).toBe(10);
  });
});
