import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { errorHandler } from "../../middleware/error";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  client: { query: vi.fn(), release: vi.fn() },
  poolConnect: vi.fn(),
  enqueuePayoutJob: vi.fn(),
  currentUser: { sub: "admin-1", email: "admin@example.com", role: "admin" },
}));

mocks.poolConnect.mockImplementation(async () => mocks.client);

vi.mock("../../db/index", () => ({
  query: mocks.query,
  pool: { connect: mocks.poolConnect },
}));

vi.mock("../../queues/payout.queue", () => ({
  enqueuePayoutJob: mocks.enqueuePayoutJob,
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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

import payoutsRouter from "./payouts";

function createApp() {
  const app = express();
  app.use("/admin/payouts", payoutsRouter);
  app.use(errorHandler);
  return app;
}

describe("POST /admin/payouts/:id/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { sub: "admin-1", email: "admin@example.com", role: "admin" };
    mocks.poolConnect.mockImplementation(async () => mocks.client);
    mocks.client.query.mockResolvedValue({ rows: [] });
    mocks.enqueuePayoutJob.mockResolvedValue(undefined);
  });

  it("returns 403 for non-admins", async () => {
    mocks.currentUser = { sub: "user-1", email: "user@example.com", role: "player" } as any;
    const payoutId = randomUUID();

    const response = await request(createApp()).post(`/admin/payouts/${payoutId}/retry`);

    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 404 when the payout does not exist", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const payoutId = randomUUID();

    const response = await request(createApp()).post(`/admin/payouts/${payoutId}/retry`);

    expect(response.status).toBe(404);
    expect(mocks.enqueuePayoutJob).not.toHaveBeenCalled();
  });

  it("returns 409 when the payout is not currently failed", async () => {
    const payoutId = randomUUID();
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: payoutId, challenge_id: "challenge-1", status: "pending" }],
    });

    const response = await request(createApp()).post(`/admin/payouts/${payoutId}/retry`);

    expect(response.status).toBe(409);
    expect(mocks.enqueuePayoutJob).not.toHaveBeenCalled();
  });

  it("resets status, writes an audit entry, and enqueues the job for a failed payout", async () => {
    const payoutId = randomUUID();
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: payoutId, challenge_id: "challenge-1", status: "failed" }],
    });

    const response = await request(createApp()).post(`/admin/payouts/${payoutId}/retry`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });

    expect(mocks.client.query).toHaveBeenCalledWith("BEGIN");
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE payouts SET status = 'pending'"),
      [payoutId]
    );
    expect(mocks.client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_log"),
      expect.arrayContaining(["admin-1", payoutId])
    );
    expect(mocks.client.query).toHaveBeenCalledWith("COMMIT");
    expect(mocks.client.release).toHaveBeenCalled();

    expect(mocks.enqueuePayoutJob).toHaveBeenCalledWith("challenge-1");
  });

  it("rolls back the transaction if the audit insert fails", async () => {
    const payoutId = randomUUID();
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: payoutId, challenge_id: "challenge-1", status: "failed" }],
    });
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.startsWith("INSERT INTO audit_log")) {
        throw new Error("insert failed");
      }
      return { rows: [] };
    });

    const response = await request(createApp()).post(`/admin/payouts/${payoutId}/retry`);

    expect(response.status).toBe(500);
    expect(mocks.client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.enqueuePayoutJob).not.toHaveBeenCalled();
  });
});
