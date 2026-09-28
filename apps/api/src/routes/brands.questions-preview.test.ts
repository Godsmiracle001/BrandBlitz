import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import brandsRouter from "./brands";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getBrandById: vi.fn(),
  getActiveDistractorBrands: vi.fn(),
  generateQuestionPreview: vi.fn(),
  currentUserId: "owner-1",
}));

vi.mock("../db/index", () => ({ query: mocks.query }));
vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { sub: mocks.currentUserId } as express.Request["user"];
    next();
  },
}));
vi.mock("../db/queries/brands", () => ({
  createBrand: vi.fn(),
  getBrandsByOwner: vi.fn(),
  getBrandById: mocks.getBrandById,
  getPublicBrandById: vi.fn(),
  getPublicBrands: vi.fn(),
  getBrandMetaById: vi.fn(),
  getActiveDistractorBrands: mocks.getActiveDistractorBrands,
  toBrandApi: vi.fn(),
  toPublicBrandApi: vi.fn(),
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
  createChallenge: vi.fn(),
  insertChallengeQuestions: vi.fn(),
  getChallengeQuestions: vi.fn(),
  getChallengesByBrandId: vi.fn(),
  deleteChallengeQuestion: vi.fn(),
  insertChallengeQuestion: vi.fn(),
}));
vi.mock("../services/questions", () => ({
  generateChallengeQuestions: vi.fn(),
  generateQuestionPreview: mocks.generateQuestionPreview,
}));
vi.mock("@brandblitz/storage", () => ({
  optimizeImage: vi.fn(),
  StorageError: class StorageError extends Error {},
}));
vi.mock("@brandblitz/stellar", () => ({ MIN_POOL_STROOPS: 1_000_000_000 }));
vi.mock("../lib/config", () => ({ config: {} }));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/brands", brandsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

const brand = {
  id: "brand-1",
  owner_user_id: "owner-1",
  name: "Acme",
  logo_url: null,
  primary_color: null,
  secondary_color: null,
  tagline: "Get it done",
  brand_story: null,
  usp: "Fast and reliable",
  product_image_keys: [],
  question_template: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const validBody = { topic: "brand recognition", difficulty: "medium", count: 3 };

describe("POST /brands/:id/questions/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = "owner-1";
    mocks.getBrandById.mockResolvedValue(brand);
    mocks.getActiveDistractorBrands.mockResolvedValue([]);
    mocks.generateQuestionPreview.mockReturnValue([
      {
        text: "Which tagline belongs to this brand?",
        options: ["Get it done", "A", "B", "C"],
        correctIndex: 0,
        explanation: 'The correct answer is "Get it done".',
      },
    ]);
  });

  it("returns a draft questions array without persisting anything", async () => {
    const response = await request(createApp())
      .post("/brands/brand-1/questions/preview")
      .send(validBody);

    expect(response.status).toBe(200);
    expect(response.body.questions).toHaveLength(1);
    expect(response.body.questions[0]).toEqual({
      text: expect.any(String),
      options: expect.any(Array),
      correctIndex: expect.any(Number),
      explanation: expect.any(String),
    });
    expect(mocks.generateQuestionPreview).toHaveBeenCalledWith(brand, [], 3);
    // No writes to challenge_questions (or any table) should occur.
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 404 when the brand does not exist", async () => {
    mocks.getBrandById.mockResolvedValue(null);

    const response = await request(createApp())
      .post("/brands/missing-brand/questions/preview")
      .send(validBody);

    expect(response.status).toBe(404);
    expect(mocks.generateQuestionPreview).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller does not own the brand", async () => {
    mocks.currentUserId = "someone-else";

    const response = await request(createApp())
      .post("/brands/brand-1/questions/preview")
      .send(validBody);

    expect(response.status).toBe(403);
    expect(mocks.generateQuestionPreview).not.toHaveBeenCalled();
  });

  it("rejects an invalid body (count out of range)", async () => {
    const response = await request(createApp())
      .post("/brands/brand-1/questions/preview")
      .send({ ...validBody, count: 20 });

    expect(response.status).toBe(500);
    expect(mocks.generateQuestionPreview).not.toHaveBeenCalled();
  });

  it("is rate-limited to 10 requests per brand per hour", async () => {
    // Unique brand id per run so the shared (possibly Redis-backed) rate
    // limit counter starts fresh regardless of prior test runs.
    const rateLimitedBrandId = `brand-rate-limit-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    mocks.getBrandById.mockResolvedValue({ ...brand, id: rateLimitedBrandId });

    for (let i = 0; i < 10; i++) {
      const ok = await request(createApp())
        .post(`/brands/${rateLimitedBrandId}/questions/preview`)
        .send(validBody);
      expect(ok.status).toBe(200);
    }

    const limited = await request(createApp())
      .post(`/brands/${rateLimitedBrandId}/questions/preview`)
      .send(validBody);

    expect(limited.status).toBe(429);
  });
});
