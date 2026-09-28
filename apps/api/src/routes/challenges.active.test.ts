/**
 * Unit tests for GET /challenges/active
 *
 * Covers:
 *   - Default sort (pool_desc) returns mapped items
 *   - All four sort variants are forwarded to the query layer
 *   - Empty-state response: 200 with items: []
 *   - Cursor and limit parameters are forwarded correctly
 *   - limit is capped at 50
 *   - nextCursor is propagated from the query layer
 *   - 401 when unauthenticated
 *   - 403 when account is suspended
 *   - 400 on invalid sort value
 */

import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that trigger module load
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  getActiveChallengesSorted: vi.fn(),
  // authenticate middleware — controlled per-test via authMockUser
  authMockUser: null as { sub: string; role?: string } | null,
  // requireActiveUser — controlled per-test via suspendUser
  suspendUser: false,
  findUserById: vi.fn(),
  // redis stubs (challenges route uses redis for GET / caching, not /active, but
  // the module imports redis so we need to stub it)
  redisGet: vi.fn().mockResolvedValue(null),
  redisSet: vi.fn().mockResolvedValue("OK"),
}));

vi.mock("../db/queries/challenges", () => ({
  // Stubs for the existing GET / route used in the same router file
  getActiveChallenges: vi.fn().mockResolvedValue({ challenges: [], nextCursor: null }),
  getActiveChallengesCursor: vi.fn().mockResolvedValue({ challenges: [], nextCursor: null }),
  getActiveChallengesSorted: mocks.getActiveChallengesSorted,
  getFilteredChallenges: vi.fn().mockResolvedValue({ challenges: [], nextCursor: null }),
  getChallengeByIdAny: vi.fn().mockResolvedValue(null),
  getChallengesByBrandId: vi.fn().mockResolvedValue({ challenges: [], nextCursor: null }),
  getChallengeQuestions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/queries/brands", () => ({
  getBrandById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/queries/sessions", () => ({
  getLeaderboard: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
  getArchivedLeaderboard: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
  LEADERBOARD_SORTS: ["score", "earnings"],
}));

vi.mock("../db/index", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  pool: {
    connect: () =>
      Promise.resolve({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
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
    HOT_WALLET_PUBLIC_KEY: "GHOTWALLETADDRESS",
    JWT_SECRET: "test-secret",
    JWT_ISSUER: "test",
    JWT_AUDIENCE: "test",
  },
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  reportLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/authenticate", () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    req.user = mocks.authMockUser;
    next();
  },
  authenticate: (req: any, res: any, next: any) => {
    if (!mocks.authMockUser) {
      res.status(401).json({ error: "No token provided" });
      return;
    }
    req.user = mocks.authMockUser;
    next();
  },
}));

vi.mock("../db/queries/users", () => ({
  findUserById: mocks.findUserById,
}));

vi.mock("../middleware/require-active-user", () => ({
  requireActiveUser: async (req: any, _res: any, next: any) => {
    if (mocks.suspendUser) {
      const { createError } = await import("../middleware/error");
      next(createError("Your account has been suspended.", 403, "ACCOUNT_SUSPENDED"));
      return;
    }
    next();
  },
}));

// Import after mocks are registered
import { errorHandler } from "../middleware/error";
import challengesRouter from "./challenges";

// ---------------------------------------------------------------------------
// Server helper
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use("/challenges", challengesRouter);
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
function makeChallenge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    brand_id: "00000000-0000-0000-0000-000000000002",
    title: "BLITZ-DEMO",
    pool_amount_usdc: "100.0000000",
    pool_amount_stroops: "1000000000",
    ends_at: "2030-01-01T00:00:00.000Z",
    participant_count: 42,
    brand_name: "Stellar Pay",
    logo_url: "https://cdn.example.com/logo.png",
    primary_color: "#6366f1",
    secondary_color: "#a5b4fc",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /challenges/active", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.authMockUser = { sub: "user-active-123" };
    mocks.suspendUser = false;
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [], nextCursor: null });

    const s = await startServer();
    server = s.server;
    baseUrl = s.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── Auth / access guard ──────────────────────────────────────────────────

  it("returns 401 when no auth token is provided", async () => {
    mocks.authMockUser = null;
    const res = await fetch(`${baseUrl}/challenges/active`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when the account is suspended", async () => {
    mocks.suspendUser = true;
    const res = await fetch(`${baseUrl}/challenges/active`);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.code).toBe("ACCOUNT_SUSPENDED");
  });

  // ── Empty state ──────────────────────────────────────────────────────────

  it("returns 200 with empty items array when no active challenges exist", async () => {
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active`);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  // ── Default sort (pool_desc) ─────────────────────────────────────────────

  it("defaults to pool_desc sort and returns mapped items", async () => {
    const c = makeChallenge();
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [c], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active`);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    // When sort is omitted, the Zod schema defaults to "pool_desc"
    expect(mocks.getActiveChallengesSorted).toHaveBeenCalledWith({
      sort: "pool_desc",
      cursor: undefined,
      limit: 20,
    });

    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.id).toBe(c.id);
    expect(item.brand_id).toBe(c.brand_id);
    expect(item.title).toBe(c.title);
    expect(item.reward_pool_xlm).toBe(c.pool_amount_usdc);
    expect(item.entry_fee_xlm).toBeNull();
    expect(item.ends_at).toBe(c.ends_at);
    expect(item.participant_count).toBe(c.participant_count);
  });

  it("does not expose pool_amount_stroops in the response", async () => {
    const c = makeChallenge();
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [c], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active`);
    const body: any = await res.json();
    expect(body.items[0]).not.toHaveProperty("pool_amount_stroops");
    expect(body.items[0]).not.toHaveProperty("pool_amount_usdc");
  });

  // ── Sort variants ────────────────────────────────────────────────────────

  it.each(["pool_desc", "pool_asc", "newest", "ending_soon"] as const)(
    "forwards sort=%s to the query layer",
    async (sort) => {
      mocks.getActiveChallengesSorted.mockResolvedValue({ items: [], nextCursor: null });

      const res = await fetch(`${baseUrl}/challenges/active?sort=${sort}`);
      expect(res.status).toBe(200);
      expect(mocks.getActiveChallengesSorted).toHaveBeenCalledWith(
        expect.objectContaining({ sort }),
      );
    },
  );

  it("returns 400 for an unrecognised sort value", async () => {
    const res = await fetch(`${baseUrl}/challenges/active?sort=random_junk`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("INVALID_QUERY");
  });

  // ── Pagination ───────────────────────────────────────────────────────────

  it("forwards limit parameter to the query layer", async () => {
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active?limit=10`);
    expect(res.status).toBe(200);
    expect(mocks.getActiveChallengesSorted).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
  });

  it("caps limit at 50 even if a larger value is requested", async () => {
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active?limit=99`);
    expect(res.status).toBe(200);
    expect(mocks.getActiveChallengesSorted).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("returns 400 for limit=0", async () => {
    const res = await fetch(`${baseUrl}/challenges/active?limit=0`);
    expect(res.status).toBe(400);
  });

  it("forwards cursor parameter to the query layer", async () => {
    const cursor = Buffer.from(JSON.stringify({ pool_amount_stroops: "500", id: "abc" })).toString(
      "base64url",
    );
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(mocks.getActiveChallengesSorted).toHaveBeenCalledWith(
      expect.objectContaining({ cursor }),
    );
  });

  it("propagates nextCursor from the query layer in the response", async () => {
    const returnedCursor = "dGVzdC1jdXJzb3I"; // arbitrary base64url
    mocks.getActiveChallengesSorted.mockResolvedValue({
      items: [makeChallenge()],
      nextCursor: returnedCursor,
    });

    const res = await fetch(`${baseUrl}/challenges/active`);
    const body: any = await res.json();
    expect(body.nextCursor).toBe(returnedCursor);
  });

  // ── Multiple items ───────────────────────────────────────────────────────

  it("returns all items when multiple challenges are active", async () => {
    const challenges = [
      makeChallenge({ id: "id-1", pool_amount_usdc: "200.0000000" }),
      makeChallenge({ id: "id-2", pool_amount_usdc: "100.0000000" }),
      makeChallenge({ id: "id-3", pool_amount_usdc: "50.0000000" }),
    ];
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: challenges, nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active`);
    const body: any = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i: any) => i.id)).toEqual(["id-1", "id-2", "id-3"]);
  });

  // ── Response shape ───────────────────────────────────────────────────────

  it("includes all required fields in each item per acceptance criteria", async () => {
    const c = makeChallenge();
    mocks.getActiveChallengesSorted.mockResolvedValue({ items: [c], nextCursor: null });

    const res = await fetch(`${baseUrl}/challenges/active`);
    const body: any = await res.json();
    const item = body.items[0];

    // Acceptance criteria: id, brand_id, title, reward_pool_xlm, entry_fee_xlm, ends_at, participant_count
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("brand_id");
    expect(item).toHaveProperty("title");
    expect(item).toHaveProperty("reward_pool_xlm");
    expect(item).toHaveProperty("entry_fee_xlm");
    expect(item).toHaveProperty("ends_at");
    expect(item).toHaveProperty("participant_count");
  });
});
