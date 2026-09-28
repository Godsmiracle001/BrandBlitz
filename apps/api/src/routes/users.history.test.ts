/**
 * Unit tests for GET /users/me/history
 *
 * Covers:
 *   - 401 when unauthenticated
 *   - Ownership scoping: only the requesting user's sessions are returned
 *   - Default status=completed excludes in-progress sessions
 *   - status=disqualified returns only flagged sessions
 *   - status=all returns every session belonging to the user
 *   - Each item contains all required fields (session_id, challenge_id, etc.)
 *   - Outcome derivation: won / lost / disqualified / in_progress
 *   - include_rounds=true appends rounds array; include_rounds=false (default) omits it
 *   - Cursor pagination forwarded correctly; nextCursor propagated in response
 *   - limit capped at 100 per schema; limit=0 returns 400
 *   - 400 on invalid status value
 *   - 200 with empty items when no sessions match
 */

import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  getSessionHistory: vi.fn(),
  authMockUser: null as { sub: string } | null,
  // Stubs for other dependencies the users router pulls in
  findUserById: vi.fn(),
  getStreak: vi.fn(),
  repairStreak: vi.fn(),
  getUserPublicProfileByUsername: vi.fn(),
  getReferralStats: vi.fn(),
  ensureUserReferralCode: vi.fn(),
  getBadgesForUser: vi.fn(),
  getUserActivity: vi.fn(),
  updateUserWallet: vi.fn(),
  updateUserProfile: vi.fn(),
  dbQuery: vi.fn().mockResolvedValue({ rows: [] }),
  redisGet: vi.fn().mockResolvedValue(null),
  redisSet: vi.fn().mockResolvedValue("OK"),
}));

vi.mock("../db/queries/sessions", () => ({
  getSessionHistory: mocks.getSessionHistory,
}));

vi.mock("../db/queries/users", () => ({
  findUserById: mocks.findUserById,
  findUserByPhoneHash: vi.fn(),
  markPhoneVerified: vi.fn(),
  updateUserWallet: mocks.updateUserWallet,
  updateUserProfile: mocks.updateUserProfile,
  getUserPublicProfileByUsername: mocks.getUserPublicProfileByUsername,
}));

vi.mock("../services/streaks", () => ({
  getStreak: mocks.getStreak,
  repairStreak: mocks.repairStreak,
  getUserActivity: mocks.getUserActivity,
}));

vi.mock("../services/referrals", () => ({
  getReferralStats: mocks.getReferralStats,
  ensureUserReferralCode: mocks.ensureUserReferralCode,
}));

vi.mock("../services/badges", () => ({
  getBadgesForUser: mocks.getBadgesForUser,
}));

vi.mock("../services/phone", () => ({
  sendVerificationCode: vi.fn(),
  normalizePhoneNumber: (v: string) => v,
  hashPhoneNumber: (v: string) => v,
  verifyOtpWithBruteForceProtection: vi.fn(),
}));

vi.mock("../db/index", () => ({
  query: mocks.dbQuery,
  pool: {
    connect: () => Promise.resolve({ query: vi.fn(), release: vi.fn() }),
  },
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: vi.fn(),
  },
}));

vi.mock("../lib/config", () => ({
  config: {
    JWT_SECRET: "test-secret",
    JWT_ISSUER: "brandblitz-api",
    JWT_AUDIENCE: "brandblitz-client",
    WEB_URL: "http://localhost:3000",
    WEBHOOK_SECRET: "test-webhook-secret",
    HOT_WALLET_PUBLIC_KEY: "GTEST",
  },
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  phoneRateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, res: any, next: any) => {
    if (!mocks.authMockUser) {
      res.status(401).json({ error: "No token provided" });
      return;
    }
    req.user = mocks.authMockUser;
    next();
  },
}));

// Import router after mocks are wired
import { errorHandler } from "../middleware/error";
import usersRouter from "./users";

// ---------------------------------------------------------------------------
// Server helper
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use("/users", usersRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeHistoryItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    session_id: "00000000-0000-0000-0000-000000000001",
    challenge_id: "00000000-0000-0000-0000-000000000002",
    challenge_title: "BLITZ-DEMO",
    started_at: "2026-01-01T10:00:00.000Z",
    completed_at: "2026-01-01T10:01:30.000Z",
    total_score: 350,
    outcome: "won",
    payout_amount_usdc: "5.0000000",
    ...overrides,
  };
}

function makeRound(round: 1 | 2 | 3, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    round,
    answer: "A",
    score: 120,
    reaction_time_ms: 800,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /users/me/history", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.authMockUser = { sub: "user-abc-123" };
    mocks.getSessionHistory.mockResolvedValue({ items: [], nextCursor: null });

    const s = await startServer();
    server = s.server;
    baseUrl = s.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── Auth guard ────────────────────────────────────────────────────────────

  it("returns 401 when no auth token is provided", async () => {
    mocks.authMockUser = null;
    const res = await fetch(`${baseUrl}/users/me/history`);
    expect(res.status).toBe(401);
  });

  // ── Ownership scoping ─────────────────────────────────────────────────────

  it("passes the authenticated user's id to the query, not a query-string override", async () => {
    await fetch(`${baseUrl}/users/me/history?userId=hacker-id`);

    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.any(Object),
    );
    // Confirm the hacker id was never used
    const callArg = mocks.getSessionHistory.mock.calls[0]?.[0];
    expect(callArg).not.toBe("hacker-id");
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it("returns 200 with empty items array when no sessions exist", async () => {
    const res = await fetch(`${baseUrl}/users/me/history`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  // ── Default status (completed) ─────────────────────────────────────────────

  it("defaults status to 'completed' and passes it to the query layer", async () => {
    await fetch(`${baseUrl}/users/me/history`);
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ status: "completed" }),
    );
  });

  // ── Status filter variants ────────────────────────────────────────────────

  it.each(["completed", "disqualified", "all"] as const)(
    "forwards status=%s to the query layer",
    async (status) => {
      await fetch(`${baseUrl}/users/me/history?status=${status}`);
      expect(mocks.getSessionHistory).toHaveBeenCalledWith(
        "user-abc-123",
        expect.objectContaining({ status }),
      );
    },
  );

  it("returns 400 for an unrecognised status value", async () => {
    const res = await fetch(`${baseUrl}/users/me/history?status=bogus`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("INVALID_QUERY");
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it("returns all required fields in each item", async () => {
    const item = makeHistoryItem();
    mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history`);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    const returned = body.items[0];
    expect(returned).toHaveProperty("session_id");
    expect(returned).toHaveProperty("challenge_id");
    expect(returned).toHaveProperty("challenge_title");
    expect(returned).toHaveProperty("started_at");
    expect(returned).toHaveProperty("completed_at");
    expect(returned).toHaveProperty("total_score");
    expect(returned).toHaveProperty("outcome");
    expect(returned).toHaveProperty("payout_amount_usdc");
  });

  // ── Outcome values ────────────────────────────────────────────────────────

  it.each(["won", "lost", "disqualified", "in_progress"] as const)(
    "surfaces outcome=%s from the query layer unchanged",
    async (outcome) => {
      const item = makeHistoryItem({ outcome, payout_amount_usdc: outcome === "won" ? "5.0" : null });
      mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

      const res = await fetch(`${baseUrl}/users/me/history?status=all`);
      const body: any = await res.json();
      expect(body.items[0].outcome).toBe(outcome);
    },
  );

  // ── Round inclusion ───────────────────────────────────────────────────────

  it("does NOT include rounds array by default (include_rounds omitted)", async () => {
    const item = makeHistoryItem();
    mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history`);
    const body: any = await res.json();

    expect(body.items[0]).not.toHaveProperty("rounds");
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ includeRounds: false }),
    );
  });

  it("passes includeRounds=true when include_rounds=true", async () => {
    const rounds = [makeRound(1), makeRound(2), makeRound(3)];
    const item = { ...makeHistoryItem(), rounds };
    mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history?include_rounds=true`);
    const body: any = await res.json();

    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ includeRounds: true }),
    );

    expect(body.items[0].rounds).toHaveLength(3);
    expect(body.items[0].rounds[0]).toMatchObject({ round: 1, answer: "A", score: 120 });
  });

  it("passes includeRounds=true when include_rounds=1", async () => {
    const item = { ...makeHistoryItem(), rounds: [makeRound(1)] };
    mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

    await fetch(`${baseUrl}/users/me/history?include_rounds=1`);
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ includeRounds: true }),
    );
  });

  it("passes includeRounds=false when include_rounds=false", async () => {
    await fetch(`${baseUrl}/users/me/history?include_rounds=false`);
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ includeRounds: false }),
    );
  });

  // ── Join correctness (field propagation) ──────────────────────────────────

  it("propagates challenge_title from the query result", async () => {
    const item = makeHistoryItem({ challenge_title: "BLITZ-XYZ" });
    mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history`);
    const body: any = await res.json();
    expect(body.items[0].challenge_title).toBe("BLITZ-XYZ");
  });

  it("propagates payout_amount_usdc as null when no completed payout", async () => {
    const item = makeHistoryItem({ outcome: "lost", payout_amount_usdc: null });
    mocks.getSessionHistory.mockResolvedValue({ items: [item], nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history`);
    const body: any = await res.json();
    expect(body.items[0].payout_amount_usdc).toBeNull();
  });

  it("returns multiple items in the response", async () => {
    const items = [
      makeHistoryItem({ session_id: "id-1", total_score: 300 }),
      makeHistoryItem({ session_id: "id-2", total_score: 200 }),
      makeHistoryItem({ session_id: "id-3", total_score: 100 }),
    ];
    mocks.getSessionHistory.mockResolvedValue({ items, nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history`);
    const body: any = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i: any) => i.session_id)).toEqual(["id-1", "id-2", "id-3"]);
  });

  // ── Cursor pagination ─────────────────────────────────────────────────────

  it("forwards cursor parameter to the query layer", async () => {
    const cursor = Buffer.from(JSON.stringify({ completed_at: "2026-01-01", id: "abc" })).toString("base64url");

    await fetch(`${baseUrl}/users/me/history?cursor=${cursor}`);
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ cursor }),
    );
  });

  it("propagates nextCursor from the query layer in the response", async () => {
    const returnedCursor = "dGVzdC1jdXJzb3I";
    mocks.getSessionHistory.mockResolvedValue({
      items: [makeHistoryItem()],
      nextCursor: returnedCursor,
    });

    const res = await fetch(`${baseUrl}/users/me/history`);
    const body: any = await res.json();
    expect(body.nextCursor).toBe(returnedCursor);
  });

  it("returns null nextCursor on the last page", async () => {
    mocks.getSessionHistory.mockResolvedValue({ items: [makeHistoryItem()], nextCursor: null });

    const res = await fetch(`${baseUrl}/users/me/history`);
    const body: any = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  // ── Limit ─────────────────────────────────────────────────────────────────

  it("forwards a custom limit to the query layer", async () => {
    await fetch(`${baseUrl}/users/me/history?limit=50`);
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("rejects limit=0 with 400", async () => {
    const res = await fetch(`${baseUrl}/users/me/history?limit=0`);
    expect(res.status).toBe(400);
  });

  it("rejects limit=101 with 400 (exceeds max 100)", async () => {
    const res = await fetch(`${baseUrl}/users/me/history?limit=101`);
    expect(res.status).toBe(400);
  });

  it("accepts limit=100 (at the boundary)", async () => {
    const res = await fetch(`${baseUrl}/users/me/history?limit=100`);
    expect(res.status).toBe(200);
    expect(mocks.getSessionHistory).toHaveBeenCalledWith(
      "user-abc-123",
      expect.objectContaining({ limit: 100 }),
    );
  });
});
