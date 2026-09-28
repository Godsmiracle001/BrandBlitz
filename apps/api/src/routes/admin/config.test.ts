import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../../middleware/error";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getConfigRow: vi.fn(),
  setConfig: vi.fn(),
  adminUser: { sub: "admin-001", email: "admin@example.com", role: "admin" },
}));

vi.mock("../../db/queries/config", () => ({
  getConfig: mocks.getConfig,
  getConfigRow: mocks.getConfigRow,
  setConfig: mocks.setConfig,
}));

vi.mock("../../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = mocks.adminUser;
    next();
  },
}));

vi.mock("../../middleware/require-admin", () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import configAdminRouter from "./config";

const app = express();
app.use(express.json());
app.use("/admin/config", configAdminRouter);
app.use(errorHandler);

describe("GET /admin/config/:key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns value, updated_at, and updated_by for an existing key", async () => {
    const now = new Date().toISOString();
    mocks.getConfigRow.mockResolvedValueOnce({
      key: "anti_cheat",
      value: { minReactionTimeMs: 150 },
      updated_at: now,
      updated_by: "admin-001",
    });

    const res = await request(app).get("/admin/config/anti_cheat");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: "anti_cheat",
      value: { minReactionTimeMs: 150 },
      updated_by: "admin-001",
    });
    expect(res.body.updated_at).toBeDefined();
  });

  it("returns updated_by as null when no admin has modified the key yet", async () => {
    const now = new Date().toISOString();
    mocks.getConfigRow.mockResolvedValueOnce({
      key: "payout",
      value: {},
      updated_at: now,
      updated_by: null,
    });

    const res = await request(app).get("/admin/config/payout");

    expect(res.status).toBe(200);
    expect(res.body.updated_by).toBeNull();
  });

  it("returns 404 for an unknown config key", async () => {
    mocks.getConfigRow.mockResolvedValueOnce(null);

    const res = await request(app).get("/admin/config/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("PATCH /admin/config/:key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls setConfig with the actor sub and returns updated value", async () => {
    const updatedRow = {
      key: "deposit_required_confirmations",
      value: { confirmations: 3 },
      updated_at: new Date().toISOString(),
      updated_by: "admin-001",
    };
    mocks.setConfig.mockResolvedValueOnce(undefined);
    mocks.getConfig.mockResolvedValueOnce(updatedRow.value);

    const res = await request(app)
      .patch("/admin/config/deposit_required_confirmations")
      .send({ value: { confirmations: 3 } });

    expect(res.status).toBe(200);
    expect(mocks.setConfig).toHaveBeenCalledWith(
      "deposit_required_confirmations",
      { confirmations: 3 },
      "admin-001"
    );
  });

  it("returns 400 for an unknown config key", async () => {
    const res = await request(app)
      .patch("/admin/config/unknown_key")
      .send({ value: { foo: "bar" } });

    expect(res.status).toBe(400);
  });

  it("returns 400 when a value violates the key's type constraints", async () => {
    const res = await request(app)
      .patch("/admin/config/deposit_required_confirmations")
      .send({ value: { confirmations: "three" } }); // must be a number

    expect(res.status).toBe(400);
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload contains unexpected top-level keys", async () => {
    const res = await request(app)
      .patch("/admin/config/deposit_required_confirmations")
      .send({ value: { confirmations: 3 }, injected: "nope" });

    expect(res.status).toBe(400);
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });
});

describe("PATCH /admin/config/:key — admin role enforcement", () => {
  // These tests exercise the real requireAdmin middleware (not the passthrough
  // mock used above) to confirm non-admin callers are rejected before setConfig
  // is ever reached.
  let appWithRealGuard: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock("../../middleware/authenticate", () => ({
      authenticate: (req: any, _res: any, next: any) => {
        req.user = mocks.adminUser;
        next();
      },
    }));
    vi.doUnmock("../../middleware/require-admin");
    const { default: realGuardRouter } = await import("./config");
    appWithRealGuard = express();
    appWithRealGuard.use(express.json());
    appWithRealGuard.use("/admin/config", realGuardRouter);
    appWithRealGuard.use(errorHandler);
  });

  it("rejects a non-admin caller with 403 from the require-admin middleware", async () => {
    mocks.adminUser.role = "player";

    const res = await request(appWithRealGuard)
      .patch("/admin/config/deposit_required_confirmations")
      .send({ value: { confirmations: 3 } });

    expect(res.status).toBe(403);
    expect(mocks.setConfig).not.toHaveBeenCalled();

    mocks.adminUser.role = "admin"; // restore for subsequent tests
  });

  it("allows an admin caller through to setConfig", async () => {
    mocks.setConfig.mockResolvedValueOnce(undefined);
    mocks.getConfig.mockResolvedValueOnce({ confirmations: 3 });

    const res = await request(appWithRealGuard)
      .patch("/admin/config/deposit_required_confirmations")
      .send({ value: { confirmations: 3 } });

    expect(res.status).toBe(200);
    expect(mocks.setConfig).toHaveBeenCalledWith(
      "deposit_required_confirmations",
      { confirmations: 3 },
      "admin-001"
    );
  });
});
