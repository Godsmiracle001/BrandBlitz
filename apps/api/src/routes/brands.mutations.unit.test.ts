import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import brandsRouter from "./brands";

const mocks = vi.hoisted(() => ({
  authUser: null as null | { sub: string; role?: string },
  tosAccepted: true,
  getBrandById: vi.fn(),
  getBrandMetaById: vi.fn(),
  getActiveDistractorBrands: vi.fn(),
  updateBrand: vi.fn(),
  deleteBrand: vi.fn(),
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
  getBrandMetaById: mocks.getBrandMetaById,
  getActiveDistractorBrands: mocks.getActiveDistractorBrands,
  toBrandApi: (brand: unknown) => brand,
  toPublicBrandApi: (brand: unknown) => brand,
  updateBrand: mocks.updateBrand,
  deleteBrand: mocks.deleteBrand,
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
  generateQuestionPreview: vi.fn(),
}));
vi.mock("@brandblitz/storage", () => ({
  optimizeImage: vi.fn(),
  StorageError: class StorageError extends Error {},
}));
vi.mock("@brandblitz/stellar", () => ({
  MIN_POOL_STROOPS: 1_000_000_000,
  generateDepositMemo: vi.fn(),
}));
vi.mock("../lib/config", () => ({ config: {} }));
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

const owner = { sub: "owner-1", role: "user" };
const brand = {
  id: "brand-1",
  owner_user_id: owner.sub,
  name: "Original",
  logo_url: "https://example.com/original.png",
  tagline: "Keep me",
  deleted_at: null,
};

describe("brand mutation and distractor routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = owner;
    mocks.tosAccepted = true;
    mocks.getBrandById.mockResolvedValue(brand);
    mocks.getBrandMetaById.mockResolvedValue(brand);
    mocks.getActiveDistractorBrands.mockResolvedValue([]);
  });

  it("requires authentication for PATCH, DELETE, and distractors", async () => {
    mocks.authUser = null;

    const responses = await Promise.all([
      request(createApp()).patch("/brands/brand-1").send({ name: "New" }),
      request(createApp()).delete("/brands/brand-1"),
      request(createApp()).get("/brands/brand-1/distractors"),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
  });

  it("prevents a non-owner from patching a brand", async () => {
    mocks.authUser = { sub: "other-user", role: "user" };

    const response = await request(createApp()).patch("/brands/brand-1").send({ name: "Hijacked" });

    expect(response.status).toBe(403);
    expect(mocks.updateBrand).not.toHaveBeenCalled();
  });

  it("returns 404 when PATCH targets a missing brand", async () => {
    mocks.getBrandById.mockResolvedValue(null);

    const response = await request(createApp()).patch("/brands/missing").send({ name: "New" });

    expect(response.status).toBe(404);
  });

  it("updates only supplied fields and preserves unmentioned values", async () => {
    const updated = { ...brand, name: "Updated" };
    mocks.updateBrand.mockResolvedValue(updated);

    const response = await request(createApp()).patch("/brands/brand-1").send({ name: "Updated" });

    expect(response.status).toBe(200);
    expect(mocks.updateBrand).toHaveBeenCalledWith("brand-1", owner.sub, {
      name: "Updated",
      question_template: undefined,
    });
    expect(response.body.brand).toMatchObject({
      name: "Updated",
      tagline: "Keep me",
      logo_url: "https://example.com/original.png",
    });
  });

  it("returns 422 for an invalid logo URL", async () => {
    const response = await request(createApp())
      .patch("/brands/brand-1")
      .send({ logo_url: "not-a-url" });

    expect(response.status).toBe(422);
    expect(mocks.updateBrand).not.toHaveBeenCalled();
  });

  it("returns 404 when the distractor brand does not exist", async () => {
    mocks.getBrandById.mockResolvedValue(null);

    const response = await request(createApp()).get("/brands/missing/distractors");

    expect(response.status).toBe(404);
  });

  it("returns three public-safe distractors and excludes the requested brand", async () => {
    mocks.getActiveDistractorBrands.mockResolvedValue([
      { id: "brand-2", name: "Two", logo_url: "two.png", owner_user_id: "secret" },
      { id: "brand-3", name: "Three", logo_url: "three.png", owner_user_id: "secret" },
      { id: "brand-4", name: "Four", logo_url: null, owner_user_id: "secret" },
      { id: "brand-5", name: "Five", logo_url: null, owner_user_id: "secret" },
    ]);

    const response = await request(createApp()).get("/brands/brand-1/distractors");

    expect(response.status).toBe(200);
    expect(response.body.distractors).toHaveLength(3);
    expect(response.body.distractors.map(({ id }: { id: string }) => id)).not.toContain("brand-1");
    expect(response.body.distractors[0]).toEqual({
      id: "brand-2",
      name: "Two",
      logo_url: "two.png",
    });
  });

  it("returns all available distractors when the catalog is sparse", async () => {
    mocks.getActiveDistractorBrands.mockResolvedValue([
      { id: "brand-2", name: "Two", logo_url: null },
    ]);

    const response = await request(createApp()).get("/brands/brand-1/distractors");

    expect(response.status).toBe(200);
    expect(response.body.distractors).toHaveLength(1);
  });

  it("prevents non-owners who are not admins from deleting a brand", async () => {
    mocks.authUser = { sub: "other-user", role: "user" };

    const response = await request(createApp()).delete("/brands/brand-1");

    expect(response.status).toBe(403);
    expect(mocks.deleteBrand).not.toHaveBeenCalled();
  });

  it("returns 404 for missing and already deleted brands", async () => {
    mocks.getBrandMetaById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...brand, deleted_at: new Date().toISOString() });

    const missing = await request(createApp()).delete("/brands/missing");
    const deleted = await request(createApp()).delete("/brands/brand-1");

    expect(missing.status).toBe(404);
    expect(deleted.status).toBe(404);
  });

  it("soft-deletes a brand and reports cancelled challenges", async () => {
    const deletedAt = "2026-07-27T12:00:00.000Z";
    mocks.deleteBrand.mockResolvedValue({ deletedAt, cancelledChallenges: 2 });

    const response = await request(createApp()).delete("/brands/brand-1");

    expect(response.status).toBe(200);
    expect(mocks.deleteBrand).toHaveBeenCalledWith("brand-1", owner.sub);
    expect(response.body).toEqual({
      brand: { id: "brand-1", deleted_at: deletedAt },
      cancelledChallenges: 2,
    });
  });
});
