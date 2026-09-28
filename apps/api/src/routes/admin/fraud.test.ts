import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fraudRouter from "./fraud";
import { errorHandler } from "../../middleware/error";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  getFraudFlags: vi.fn(),
  getFraudFlagById: vi.fn(),
  updateFraudFlagStatus: vi.fn(),
  jwtVerify: vi.fn(),
}));

vi.mock("../../db/queries/users", () => ({
  findUserById: mocks.findUserById,
}));

vi.mock("../../db/queries/fraud-flags", () => ({
  getFraudFlags: mocks.getFraudFlags,
  getFraudFlagById: mocks.getFraudFlagById,
  updateFraudFlagStatus: mocks.updateFraudFlagStatus,
}));

vi.mock("jsonwebtoken", () => ({
  default: { verify: mocks.jwtVerify },
}));

vi.mock("../../lib/config", () => ({
  config: { JWT_SECRET: "test-secret" },
}));

vi.mock("../../lib/redis", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/fraud-flags", fraudRouter);
  app.use(errorHandler);
  return app;
}

const ADMIN_TOKEN = "Bearer admin-token";
const PLAYER_TOKEN = "Bearer player-token";

const ADMIN_USER = { id: "admin-uuid", role: "admin" };
const PLAYER_USER = { id: "player-uuid", role: "player" };

const SAMPLE_FLAG = {
  id: "flag-uuid",
  session_id: "session-uuid",
  user_id: "user-uuid",
  user_display_name: "Alice",
  user_email: "alice@example.com",
  challenge_id: "challenge-uuid",
  flag_type: "reaction_time_too_fast",
  details: { reaction_ms: 50 },
  status: "open",
  resolution_reason: null,
  resolved_by: null,
  resolved_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  round_1_reaction_ms: 50,
  round_2_reaction_ms: 120,
  round_3_reaction_ms: 200,
  session_flag_reasons: ["reaction_time_too_fast"],
  device_id: "device-abc",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /admin/fraud-flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFraudFlags.mockResolvedValue({ flags: [SAMPLE_FLAG], total: 1 });
  });

  it("returns 401 when no token is provided", async () => {
    const res = await request(createApp()).get("/admin/fraud-flags");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    mocks.jwtVerify.mockReturnValue({ sub: PLAYER_USER.id, email: "player@example.com", role: "player" });
    mocks.findUserById.mockResolvedValue(PLAYER_USER);

    const res = await request(createApp())
      .get("/admin/fraud-flags")
      .set("Authorization", PLAYER_TOKEN);

    expect(res.status).toBe(403);
  });

  it("returns 200 with paginated flags for admin", async () => {
    mocks.jwtVerify.mockReturnValue({ sub: ADMIN_USER.id, email: "admin@example.com", role: "admin" });
    mocks.findUserById.mockResolvedValue(ADMIN_USER);

    const res = await request(createApp())
      .get("/admin/fraud-flags")
      .set("Authorization", ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.flags)).toBe(true);
    expect(res.body.flags[0].id).toBe(SAMPLE_FLAG.id);
    expect(res.body.pagination.total).toBe(1);
  });

  it("passes status filter to getFraudFlags", async () => {
    mocks.jwtVerify.mockReturnValue({ sub: ADMIN_USER.id, email: "admin@example.com", role: "admin" });
    mocks.findUserById.mockResolvedValue(ADMIN_USER);

    await request(createApp())
      .get("/admin/fraud-flags?status=open")
      .set("Authorization", ADMIN_TOKEN);

    expect(mocks.getFraudFlags).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" })
    );
  });
});

describe("PATCH /admin/fraud-flags/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jwtVerify.mockReturnValue({ sub: ADMIN_USER.id, email: "admin@example.com", role: "admin" });
    mocks.findUserById.mockResolvedValue(ADMIN_USER);
    mocks.getFraudFlagById.mockResolvedValue(SAMPLE_FLAG);
    mocks.updateFraudFlagStatus.mockResolvedValue({
      ...SAMPLE_FLAG,
      status: "resolved",
      resolution_reason: "Legitimate user confirmed by manual review",
      resolved_by: ADMIN_USER.id,
      resolved_at: "2026-01-02T00:00:00.000Z",
    });
  });

  it("returns 403 for a non-admin user", async () => {
    mocks.jwtVerify.mockReturnValue({ sub: PLAYER_USER.id, email: "player@example.com", role: "player" });
    mocks.findUserById.mockResolvedValue(PLAYER_USER);

    const res = await request(createApp())
      .patch("/admin/fraud-flags/flag-uuid")
      .set("Authorization", PLAYER_TOKEN)
      .send({ status: "resolved", reason: "ok" });

    expect(res.status).toBe(403);
  });

  it("returns 200 and updated flag on valid resolve", async () => {
    const res = await request(createApp())
      .patch("/admin/fraud-flags/flag-uuid")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "resolved", reason: "Legitimate user confirmed by manual review" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolutionReason).toBe("Legitimate user confirmed by manual review");
    expect(mocks.updateFraudFlagStatus).toHaveBeenCalledWith(
      "flag-uuid",
      "resolved",
      "Legitimate user confirmed by manual review",
      ADMIN_USER.id
    );
  });

  it("returns 200 and updated flag on valid escalate", async () => {
    mocks.updateFraudFlagStatus.mockResolvedValue({
      ...SAMPLE_FLAG,
      status: "escalated",
      resolution_reason: "Needs further investigation",
      resolved_by: ADMIN_USER.id,
      resolved_at: "2026-01-02T00:00:00.000Z",
    });

    const res = await request(createApp())
      .patch("/admin/fraud-flags/flag-uuid")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "escalated", reason: "Needs further investigation" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("escalated");
  });

  it("returns 400 when reason is missing", async () => {
    const res = await request(createApp())
      .patch("/admin/fraud-flags/flag-uuid")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "resolved" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when status value is invalid", async () => {
    const res = await request(createApp())
      .patch("/admin/fraud-flags/flag-uuid")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "deleted", reason: "some reason" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when flag does not exist", async () => {
    mocks.getFraudFlagById.mockResolvedValue(null);

    const res = await request(createApp())
      .patch("/admin/fraud-flags/nonexistent-id")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "resolved", reason: "Not found test" });

    expect(res.status).toBe(404);
  });
});
