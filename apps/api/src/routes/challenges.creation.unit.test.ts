import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import brandsRouter from "./brands";

const mocks = vi.hoisted(() => ({
  authUser: null as null | { sub: string; role?: string },
  tosAccepted: true,
  createChallenge: vi.fn(),
  getBrandById: vi.fn(),
  getActiveDistractorBrands: vi.fn(),
  generateChallengeQuestions: vi.fn(),
  insertChallengeQuestions: vi.fn(),
  generateDepositMemo: vi.fn(),
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!mocks.authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = mocks.authUser as express.Request["user"];
    next();
  },
}));
vi.mock("../middleware/require-tos", () => ({
  requireCurrentTosAccepted: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (!mocks.tosAccepted) {
      res.status(403).json({ error: "Terms of Service acceptance required" });
      return;
    }
    next();
  },
}));
vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  questionPreviewLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}));
vi.mock("../db/index", () => ({ query: vi.fn() }));
vi.mock("../db/queries/brands", () => ({
  createBrand: vi.fn(),
  getBrandById: mocks.getBrandById,
  getPublicBrandById: vi.fn(),
  getPublicBrands: vi.fn(),
  getBrandMetaById: vi.fn(),
  getActiveDistractorBrands: mocks.getActiveDistractorBrands,
  toBrandApi: (brand: unknown) => brand,
  toPublicBrandApi: (brand: unknown) => brand,
  updateBrand: vi.fn(),
  deleteBrand: vi.fn(),
  getBrandChallengeStats: vi.fn(),
}));
vi.mock("../db/queries/analytics", () => ({
  getBrandAnalytics: vi.fn(),
  getBrandBenchmark: vi.fn(),
  BUCKET_LABELS: {
    small: "small (1–4 challenges)",
    medium: "medium (5–19 challenges)",
    large: "large (20+ challenges)",
  },
}));
vi.mock("../db/queries/challenges", () => ({
  createChallenge: mocks.createChallenge,
  insertChallengeQuestions: mocks.insertChallengeQuestions,
  getChallengeQuestions: vi.fn(),
  getChallengesByBrandId: vi.fn(),
  deleteChallengeQuestion: vi.fn(),
  insertChallengeQuestion: vi.fn(),
}));
vi.mock("../services/questions", () => ({
  generateChallengeQuestions: mocks.generateChallengeQuestions,
  generateQuestionPreview: vi.fn(),
}));
vi.mock("@brandblitz/storage", () => ({
  optimizeImage: vi.fn(),
  StorageError: class StorageError extends Error {},
}));
vi.mock("@brandblitz/stellar", () => ({
  MIN_POOL_STROOPS: 1_000_000_000,
  generateDepositMemo: mocks.generateDepositMemo,
}));
vi.mock("../lib/config", () => ({
  config: { HOT_WALLET_PUBLIC_KEY: "GTESTHOTWALLET" },
}));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/brands", brandsRouter);
  app.use(
    (
      error: Error & { statusCode?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
    }
  );
  return app;
}

const brandId = "20000000-0000-4000-8000-000000000001";
const validBody = {
  brandId,
  poolAmountUsdc: "100",
  maxPlayers: 50,
  endsAt: "2099-07-28T12:00:00.000Z",
};

describe("POST /brands/challenges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = { sub: "owner-1", role: "user" };
    mocks.tosAccepted = true;
    mocks.getBrandById.mockResolvedValue({
      id: brandId,
      owner_user_id: "owner-1",
      name: "Acme",
    });
    mocks.getActiveDistractorBrands.mockResolvedValue([]);
    mocks.generateChallengeQuestions.mockReturnValue([]);
    mocks.generateDepositMemo
      .mockReturnValueOnce("deposit-memo-one")
      .mockReturnValueOnce("deposit-memo-two");
    mocks.createChallenge.mockImplementation(async (input) => ({
      id: input.challengeId,
      brand_id: input.brandId,
      pool_amount_usdc: input.poolAmountUsdc,
      deposit_memo: input.depositMemo,
      status: "pending_deposit",
    }));
  });

  it("returns 401 without an auth token", async () => {
    mocks.authUser = null;

    const response = await request(createApp()).post("/brands/challenges").send(validBody);

    expect(response.status).toBe(401);
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });

  it("returns 403 when the user has not accepted the Terms of Service", async () => {
    mocks.tosAccepted = false;

    const response = await request(createApp()).post("/brands/challenges").send(validBody);

    expect(response.status).toBe(403);
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });

  it("returns 422 when required challenge fields are missing", async () => {
    const response = await request(createApp()).post("/brands/challenges").send({});

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });

  it("creates a pending-deposit challenge with a Stellar-compatible text memo", async () => {
    const response = await request(createApp()).post("/brands/challenges").send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.challenge).toMatchObject({
      brand_id: brandId,
      deposit_memo: "deposit-memo-one",
      status: "pending_deposit",
    });
    expect(response.body.depositInstructions.memo).toBe("deposit-memo-one");
    expect(Buffer.byteLength(response.body.depositInstructions.memo, "utf8")).toBeLessThanOrEqual(
      28
    );
    expect(mocks.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId,
        depositMemo: "deposit-memo-one",
        poolAmountUsdc: "100",
      })
    );
    expect(mocks.insertChallengeQuestions).toHaveBeenCalledWith([]);
  });

  it("uses unique memo values for sequential challenge creations", async () => {
    const app = createApp();
    const first = await request(app).post("/brands/challenges").send(validBody);
    const second = await request(app).post("/brands/challenges").send(validBody);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.challenge.deposit_memo).not.toBe(second.body.challenge.deposit_memo);
  });
});
