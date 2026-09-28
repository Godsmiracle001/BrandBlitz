import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import type { NextFunction, Request, Response } from "express";

const { mockQuery, mockGetChallengeById, mockEnqueuePayout } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetChallengeById: vi.fn(),
  mockEnqueuePayout: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  user: { sub: "admin-123", role: "admin" } as { sub: string; role: string } | null,
}));

vi.mock("../../middleware/authenticate", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    if (!mocks.user) {
      res.status(401).json({ error: "No token provided" });
      return;
    }
    req.user = mocks.user as Request["user"];
    next();
  },
}));

vi.mock("../../middleware/require-admin", () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    if (req.user!.role !== "admin" && req.user!.role !== "super_admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
}));

vi.mock("../../db/index", () => ({
  query: mockQuery,
}));

vi.mock("../../db/queries/challenges", () => ({
  getChallengeById: mockGetChallengeById,
  softDeleteChallenge: vi.fn(),
  restoreChallenge: vi.fn(),
}));

vi.mock("../../services/payout", () => ({
  enqueuePayout: mockEnqueuePayout,
}));

vi.mock("../../services/refund", () => ({
  refundChallenge: vi.fn(),
}));

import { errorHandler } from "../../middleware/error";

let app: express.Express;
const adminUserId = "admin-123";
const challengeId = "c0ffee00-face-4bad-8ea0-1234567890ab";

beforeAll(async () => {
  app = express();
  app.use(express.json());
  const { default: challengesRouter } = await import("./challenges");
  app.use("/admin/challenges", challengesRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  mockQuery.mockReset();
  mockGetChallengeById.mockReset();
  mockEnqueuePayout.mockReset();
  mocks.user = { sub: adminUserId, role: "admin" };
});

describe("POST /admin/challenges/:id/settle", () => {
  it("enqueues exactly one payout job and writes an audit_log entry on success", async () => {
    mockGetChallengeById.mockResolvedValueOnce({ id: challengeId, status: "ended" });
    mockEnqueuePayout.mockResolvedValueOnce(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await request(app)
      .post(`/admin/challenges/${challengeId}/settle`)
      .expect(202);

    expect(response.body.message).toBeDefined();
    expect(mockEnqueuePayout).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePayout.mock.calls[0][0]).toBe(challengeId);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_log"),
      [adminUserId, challengeId]
    );
    expect(mockQuery.mock.calls[0][0]).toContain("challenge_settle");
  });

  it("returns 409 and does not enqueue a duplicate job when the challenge is already settled", async () => {
    mockGetChallengeById.mockResolvedValueOnce({ id: challengeId, status: "settled" });

    const response = await request(app)
      .post(`/admin/challenges/${challengeId}/settle`)
      .expect(409);

    expect(response.body.error).toBe("Challenge already settled");
    expect(mockEnqueuePayout).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin authenticated request", async () => {
    mocks.user = { sub: "user-456", role: "user" };

    const response = await request(app)
      .post(`/admin/challenges/${challengeId}/settle`)
      .expect(403);

    expect(response.body.error).toBe("Forbidden");
    expect(mockEnqueuePayout).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated request", async () => {
    mocks.user = null;

    const response = await request(app)
      .post(`/admin/challenges/${challengeId}/settle`)
      .expect(401);

    expect(response.body.error).toBeDefined();
    expect(mockEnqueuePayout).not.toHaveBeenCalled();
  });

  it("returns 404 when settling a non-existent challengeId", async () => {
    mockGetChallengeById.mockResolvedValueOnce(null);

    const response = await request(app)
      .post(`/admin/challenges/${challengeId}/settle`)
      .expect(404);

    expect(response.body.error).toBe("Challenge not found");
    expect(mockEnqueuePayout).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 500 and does not commit the audit_log entry when the payout service errors", async () => {
    mockGetChallengeById.mockResolvedValueOnce({ id: challengeId, status: "ended" });
    mockEnqueuePayout.mockRejectedValueOnce(new Error("queue unavailable"));

    const response = await request(app)
      .post(`/admin/challenges/${challengeId}/settle`)
      .expect(500);

    expect(response.body.error).toBeDefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
