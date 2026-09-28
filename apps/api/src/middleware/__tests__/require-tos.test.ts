import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { requireCurrentTosAccepted } from "../require-tos";
import { errorHandler } from "../error";

/**
 * NOTE ON SCOPE (see PR description):
 * Issue #406 was written against a contract (app_config-based version
 * compare, X-Required-Tos-Version response header, 503 fail-closed on
 * config lookup failure) that does not exist in this file. The actual
 * implementation compares against legal_documents/user_legal_acceptances
 * and has no such header or 503 path. These tests cover the behavior
 * that is actually implemented; criteria that don't apply are called
 * out individually below instead of silently dropped.
 */

const mocks = vi.hoisted(() => ({
  getCurrentLegalDocument: vi.fn(),
  findUserLegalAcceptance: vi.fn(),
}));

vi.mock("../../db/queries/legal", () => ({
  getCurrentLegalDocument: mocks.getCurrentLegalDocument,
  findUserLegalAcceptance: mocks.findUserLegalAcceptance,
}));

const CURRENT_TOS = {
  id: "doc-1",
  version: "3.0",
  type: "tos" as const,
  body_markdown: "# Terms",
  effective_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
};

const TEST_USER = { sub: "user-1", email: "user@example.com", role: "player" };

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = TEST_USER;
    next();
  });
  app.get("/protected", requireCurrentTosAccepted, (_req, res) => {
    res.json({ reached: true });
  });
  app.use(errorHandler);
  return app;
}

describe("requireCurrentTosAccepted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls next() when the user has accepted the current ToS version", async () => {
    mocks.getCurrentLegalDocument.mockResolvedValue(CURRENT_TOS);
    mocks.findUserLegalAcceptance.mockResolvedValue({
      id: "acc-1",
      user_id: TEST_USER.sub,
      type: "tos",
      version: CURRENT_TOS.version,
      accepted_at: "2026-01-02T00:00:00.000Z",
      ip: "127.0.0.1",
    });

    const next = vi.fn();
    await requireCurrentTosAccepted({ user: TEST_USER } as any, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.findUserLegalAcceptance).toHaveBeenCalledWith(TEST_USER.sub, "tos", CURRENT_TOS.version);
  });

  it("returns 403 when the user has only accepted an older ToS version", async () => {
    mocks.getCurrentLegalDocument.mockResolvedValue(CURRENT_TOS);
    // The user has an acceptance row, but not for the current version, so
    // the lookup scoped to CURRENT_TOS.version comes back empty.
    mocks.findUserLegalAcceptance.mockResolvedValue(null);

    const res = await request(buildApp()).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body.reached).toBeUndefined();
  });

  it("returns 403 when the user has never accepted the ToS (no acceptance rows at all)", async () => {
    mocks.getCurrentLegalDocument.mockResolvedValue(CURRENT_TOS);
    mocks.findUserLegalAcceptance.mockResolvedValue(null);

    const res = await request(buildApp()).get("/protected");

    expect(res.status).toBe(403);
  });

  it("returns a 403 JSON body with an error field explaining acceptance is required", async () => {
    mocks.getCurrentLegalDocument.mockResolvedValue(CURRENT_TOS);
    mocks.findUserLegalAcceptance.mockResolvedValue(null);

    const res = await request(buildApp()).get("/protected");

    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(res.body.code).toBe("TOS_NOT_ACCEPTED");
  });

  it("never reaches the downstream handler when a 403 is returned", async () => {
    mocks.getCurrentLegalDocument.mockResolvedValue(CURRENT_TOS);
    mocks.findUserLegalAcceptance.mockResolvedValue(null);

    const res = await request(buildApp()).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body.reached).toBeUndefined();

    const next = vi.fn();
    await expect(
      requireCurrentTosAccepted({ user: TEST_USER } as any, {} as any, next)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed (blocks access, does not call next()) when the legal document lookup fails", async () => {
    // ADAPTED from AC7: the current implementation has no app_config lookup
    // or 503 path. The closest applicable behavior is that a failure while
    // resolving the current ToS document must not silently allow access.
    mocks.getCurrentLegalDocument.mockRejectedValue(new Error("connection terminated"));

    const next = vi.fn();
    await expect(
      requireCurrentTosAccepted({ user: TEST_USER } as any, {} as any, next)
    ).rejects.toThrow("connection terminated");
    expect(next).not.toHaveBeenCalled();

    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.reached).toBeUndefined();
  });
});
