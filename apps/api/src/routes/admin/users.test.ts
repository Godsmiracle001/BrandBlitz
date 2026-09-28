import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../../middleware/error";

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  unsuspendUser: vi.fn(),
  suspendUser: vi.fn(),
  listUsers: vi.fn(),
  query: vi.fn(),
  adminUser: { sub: "admin-001", email: "admin@example.com", role: "admin" },
  playerUser: { sub: "player-001", email: "player@example.com", role: "player" },
}));

vi.mock("../../db/queries/users", () => ({
  findUserById: mocks.findUserById,
  unsuspendUser: mocks.unsuspendUser,
  suspendUser: mocks.suspendUser,
  listUsers: mocks.listUsers,
  restoreUser: vi.fn(),
}));

vi.mock("../../db/queries/gdpr", () => ({
  createErasureRequest: vi.fn(),
  findPendingErasureRequest: vi.fn(),
}));

vi.mock("../../queues/gdpr-erasure.queue", () => ({
  enqueueGdprErasure: vi.fn(),
}));

vi.mock("../../db", () => ({
  query: mocks.query,
}));

vi.mock("../../db/pagination", () => ({
  CursorQuerySchema: {
    parse: (data: any) => ({
      status: data.status,
      search: data.search,
      cursor: data.cursor,
      limit: data.limit ?? 20,
    }),
  },
  encodeCursor: vi.fn(),
  decodeCursorSafe: vi.fn(),
}));

vi.mock("../../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = mocks.adminUser;
    next();
  },
}));

vi.mock("../../middleware/require-admin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    if (req.user?.role !== "admin") {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      err.code = "FORBIDDEN";
      throw err;
    }
    next();
  },
}));

import adminUsersRouter from "./users";

const app = express();
app.use(express.json());
app.use("/admin/users", adminUsersRouter);
app.use(errorHandler);

describe("DELETE /admin/users/:userId/suspend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears suspension and returns updated user with suspendedAt null", async () => {
    mocks.findUserById.mockResolvedValueOnce({
      id: "user-001",
      status: "suspended",
      suspended_at: "2026-06-01T00:00:00Z",
      suspension_reason: "Spamming",
    });

    mocks.unsuspendUser.mockResolvedValueOnce({
      id: "user-001",
      status: "active",
      suspended_at: null,
    });

    mocks.query.mockResolvedValueOnce({});

    const res = await request(app)
      .delete("/admin/users/user-001/suspend")
      .expect(200);

    expect(res.body.message).toBe("User suspension has been lifted.");
    expect(res.body.user.id).toBe("user-001");
    expect(res.body.user.status).toBe("active");
    expect(res.body.user.suspendedAt).toBeNull();

    expect(mocks.unsuspendUser).toHaveBeenCalledWith("user-001");

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("'unsuspend'"),
      [
        "admin-001",
        "user-001",
        JSON.stringify({
          suspendedAt: "2026-06-01T00:00:00Z",
          suspensionReason: "Spamming",
        }),
        JSON.stringify({
          suspendedAt: null,
          suspensionReason: null,
        }),
      ],
    );
  });

  it("returns 404 when the user ID does not exist", async () => {
    mocks.findUserById.mockResolvedValueOnce(null);

    const res = await request(app)
      .delete("/admin/users/nonexistent-uuid/suspend")
      .expect(404);

    expect(res.body.error).toBe("User not found");
    expect(mocks.unsuspendUser).not.toHaveBeenCalled();
  });

  it("returns 409 when the user is not currently suspended", async () => {
    mocks.findUserById.mockResolvedValueOnce({
      id: "user-002",
      status: "active",
      suspended_at: null,
      suspension_reason: null,
    });

    const res = await request(app)
      .delete("/admin/users/user-002/suspend")
      .expect(409);

    expect(res.body.error).toBe("User is not currently suspended");
    expect(res.body.code).toBe("NOT_SUSPENDED");
    expect(mocks.unsuspendUser).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin user", async () => {
    vi.mocked(
      (await import("../../middleware/authenticate")).authenticate
    );
    const app2 = express();
    app2.use(express.json());
    app2.use("/admin/users", (req: any, _res: any, next: any) => {
      req.user = mocks.playerUser;
      next();
    }, adminUsersRouter);
    app2.use(errorHandler);

    const res = await request(app2)
      .delete("/admin/users/user-001/suspend")
      .expect(403);

    expect(res.body.error).toBe("Forbidden");
  });

  it("writes audit_log with action unsuspend and performedBy", async () => {
    mocks.findUserById.mockResolvedValueOnce({
      id: "user-003",
      status: "suspended",
      suspended_at: "2026-06-15T12:00:00Z",
      suspension_reason: "ToS violation",
    });

    mocks.unsuspendUser.mockResolvedValueOnce({
      id: "user-003",
      status: "active",
      suspended_at: null,
    });

    mocks.query.mockResolvedValueOnce({});

    await request(app)
      .delete("/admin/users/user-003/suspend")
      .expect(200);

    const auditCall = mocks.query.mock.calls.find(
      (call: any) => typeof call[0] === "string" && call[0].includes("audit_log"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1][0]).toBe("admin-001");
    expect(auditCall[1][1]).toBe("user-003");
  });
});
