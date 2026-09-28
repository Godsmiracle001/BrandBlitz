import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { errorHandler } from "../../middleware/error";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  currentUser: { sub: "admin-1", email: "admin@example.com", role: "admin" },
}));

vi.mock("../../db", () => ({ query: mocks.query }));

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

import auditLogRouter from "./audit-log";

function createApp() {
  const app = express();
  app.use("/admin/audit-log", auditLogRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /admin/audit-log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { sub: "admin-1", email: "admin@example.com", role: "admin" };
  });

  it("returns 403 for non-admins", async () => {
    mocks.currentUser = { sub: "user-1", email: "user@example.com", role: "player" } as any;

    const response = await request(createApp()).get("/admin/audit-log");

    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("applies combined entityType + performedBy filter", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "log-1",
            actor_id: "admin-1",
            actor_username: "admin1",
            action: "user_suspend",
            entity: "user",
            entity_key: "user-42",
            before: null,
            after: null,
            created_at: "2026-07-01T00:00:00.000Z",
          },
        ],
      });

    const adminId = randomUUID();
    const response = await request(createApp()).get(
      `/admin/audit-log?entityType=user&performedBy=${adminId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0].entity).toBe("user");

    const [countSql, countParams] = mocks.query.mock.calls[0];
    expect(countSql).toContain("al.entity = $1");
    expect(countSql).toContain("al.actor_id = $2");
    // params is the same array reused (and later extended) for the SELECT
    // call, so only assert the leading where-clause values here.
    expect(countParams.slice(0, 2)).toEqual(["user", adminId]);
  });

  it("rejects entityId without entityType", async () => {
    const response = await request(createApp()).get("/admin/audit-log?entityId=user-42");

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
