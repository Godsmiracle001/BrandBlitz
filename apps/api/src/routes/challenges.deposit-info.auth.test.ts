import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

// ── mocks ────────────────────────────────────────────────────────────────────
// Deterministic unit tests for GET /challenges/:id/deposit-info (issue #373).
//
// The route runs the REAL `authenticate` middleware (so 401 is genuinely
// exercised) while the DB layer and config are mocked for reproducible output.
//
// Note on the issue text vs. the real code:
//   - The escrow/hot-wallet address comes from `config.HOT_WALLET_PUBLIC_KEY`
//     (there is no escrow-address constant in packages/stellar/src/constants.ts),
//     so we assert against the configured value.
//   - The route does not import packages/stellar/src/accounts.ts, so there is
//     nothing from that module to mock; the deterministic surface is the DB + config.
//   - The response shape is { depositInfo: { hotWalletAddress, memo, amount } }.

const JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-at-least-32-characters!!";
const JWT_ISSUER = "brandblitz-api";
const JWT_AUDIENCE = "brandblitz-client";
const ESCROW_ADDRESS = "GESCROWTESTADDRESS00000000000000000000000000000000000A";

const mockGetChallengeByIdAny = vi.fn();
const mockGetBrandById = vi.fn();
const mockRedisGet = vi.fn().mockResolvedValue(null);

vi.mock("../db/queries/challenges", () => ({
  getChallengeByIdAny: mockGetChallengeByIdAny,
  getActiveChallenges: vi.fn(),
  getChallengesByBrandId: vi.fn(),
  getChallengeQuestions: vi.fn(),
}));

vi.mock("../db/queries/brands", () => ({
  getBrandById: mockGetBrandById,
}));

vi.mock("../lib/cache", () => ({
  cached: vi.fn((_key, _ttl, fn) => fn()),
}));

vi.mock("../lib/config", () => ({
  config: {
    NODE_ENV: "test",
    JWT_SECRET,
    JWT_ISSUER,
    JWT_AUDIENCE,
    HOT_WALLET_PUBLIC_KEY: ESCROW_ADDRESS,
  },
}));

vi.mock("../lib/redis", () => ({
  redis: { get: mockRedisGet },
  stellarSequenceStore: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    setIfAbsent: vi.fn(),
  },
  emitCounterMetric: vi.fn(),
  startRedisEvictionMonitor: vi.fn(),
  connectRedis: vi.fn(),
}));

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const CHALLENGE_UUID = "22222222-2222-2222-2222-222222222222";
const DEPOSIT_MEMO = "dep_AbC123XyZ-memo90";

function signToken(sub: string): string {
  return jwt.sign(
    { sub, email: "brand@example.com", role: "player", iss: JWT_ISSUER, aud: JWT_AUDIENCE },
    JWT_SECRET,
    { expiresIn: "15m" }
  );
}

function bearer(sub: string): [string, string] {
  return ["Authorization", `Bearer ${signToken(sub)}`];
}

describe("GET /challenges/:id/deposit-info — auth & memo validation (issue #373)", () => {
  let app: express.Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);

    app = express();
    app.use(express.json());
    const challengesRouter = (await import("./challenges")).default;
    app.use("/challenges", challengesRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || 500).json({ error: err.message });
    });
  });

  it("returns 401 when no auth token is provided", async () => {
    const res = await request(app).get(`/challenges/${CHALLENGE_UUID}/deposit-info`);

    expect(res.status).toBe(401);
    expect(mockGetChallengeByIdAny).not.toHaveBeenCalled();
  });

  it("returns 401 when the token issuer/audience does not match", async () => {
    const badToken = jwt.sign(
      { sub: OWNER_ID, email: "x@y.z", role: "player", iss: "attacker", aud: "attacker" },
      JWT_SECRET,
      { expiresIn: "15m" }
    );
    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set("Authorization", `Bearer ${badToken}`);

    expect(res.status).toBe(401);
  });

  it("returns 404 when the challenge id does not exist", async () => {
    mockGetChallengeByIdAny.mockResolvedValue(null);

    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set(...bearer(OWNER_ID));

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Challenge not found");
  });

  it("returns 403 when an authenticated non-owner requests deposit info", async () => {
    mockGetChallengeByIdAny.mockResolvedValue({
      id: CHALLENGE_UUID,
      brand_id: "brand-1",
      status: "pending_deposit",
      deposit_memo: DEPOSIT_MEMO,
      pool_amount_usdc: "100.00",
    });
    mockGetBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: OWNER_ID });

    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set(...bearer("99999999-9999-9999-9999-999999999999"));

    expect(res.status).toBe(403);
    expect(res.body.depositInfo).toBeUndefined();
  });

  it("returns 200 with memo + stellar_account fields for the owner", async () => {
    mockGetChallengeByIdAny.mockResolvedValue({
      id: CHALLENGE_UUID,
      brand_id: "brand-1",
      status: "pending_deposit",
      deposit_memo: DEPOSIT_MEMO,
      pool_amount_usdc: "100.00",
    });
    mockGetBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: OWNER_ID });

    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set(...bearer(OWNER_ID));

    expect(res.status).toBe(200);
    expect(res.body.depositInfo).toBeDefined();
    expect(res.body.depositInfo.memo).toBeTruthy();
    expect(res.body.depositInfo.hotWalletAddress).toBeTruthy();
  });

  it("returns the configured escrow (hot wallet) address as stellar_account", async () => {
    mockGetChallengeByIdAny.mockResolvedValue({
      id: CHALLENGE_UUID,
      brand_id: "brand-1",
      status: "pending_deposit",
      deposit_memo: DEPOSIT_MEMO,
      pool_amount_usdc: "100.00",
    });
    mockGetBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: OWNER_ID });

    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set(...bearer(OWNER_ID));

    expect(res.body.depositInfo.hotWalletAddress).toBe(ESCROW_ADDRESS);
  });

  it("returns a non-empty deposit memo of at most 28 UTF-8 bytes (Stellar text memo limit)", async () => {
    mockGetChallengeByIdAny.mockResolvedValue({
      id: CHALLENGE_UUID, // 36-byte UUID — must NOT be leaked as the memo
      brand_id: "brand-1",
      status: "pending_deposit",
      deposit_memo: DEPOSIT_MEMO,
      pool_amount_usdc: "100.00",
    });
    mockGetBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: OWNER_ID });

    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set(...bearer(OWNER_ID));

    const memo: string = res.body.depositInfo.memo;
    expect(typeof memo).toBe("string");
    expect(memo.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(28);
    // The reconciliation memo (deposit_memo) is returned, never the 36-byte UUID.
    expect(memo).toBe(DEPOSIT_MEMO);
    expect(memo).not.toBe(CHALLENGE_UUID);
  });

  it("returns 400 when the challenge is not pending deposit", async () => {
    mockGetChallengeByIdAny.mockResolvedValue({
      id: CHALLENGE_UUID,
      brand_id: "brand-1",
      status: "active",
      deposit_memo: DEPOSIT_MEMO,
      pool_amount_usdc: "100.00",
    });
    mockGetBrandById.mockResolvedValue({ id: "brand-1", owner_user_id: OWNER_ID });

    const res = await request(app)
      .get(`/challenges/${CHALLENGE_UUID}/deposit-info`)
      .set(...bearer(OWNER_ID));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not pending deposit");
  });
});
