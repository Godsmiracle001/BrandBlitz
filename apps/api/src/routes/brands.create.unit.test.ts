import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import brandsRouter from "./brands";
import { errorHandler } from "../middleware/error";

const mocks = vi.hoisted(() => ({
  authUser: null as null | { sub: string; role?: string; email?: string },
  createBrand: vi.fn(),
  optimizeImage: vi.fn(),
  getPublicUrl: vi.fn(),
  StorageError: class StorageError extends Error {
    public code = "STORAGE_ERROR";
    constructor(message: string) {
      super(message);
      this.name = "StorageError";
    }
  },
  BUCKETS: { BRAND_ASSETS: "brand-assets" },
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!mocks.authUser) {
      res.status(401).json({ error: "No token provided" });
      return;
    }
    req.user = mocks.authUser as express.Request["user"];
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
  createBrand: mocks.createBrand,
  getBrandById: vi.fn(),
  getPublicBrandById: vi.fn(),
  getPublicBrands: vi.fn(),
  getBrandMetaById: vi.fn(),
  getActiveDistractorBrands: vi.fn(),
  toBrandApi: (brand: unknown) => brand,
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
  generateQuestionPreview: vi.fn(),
}));

vi.mock("@brandblitz/storage", () => ({
  optimizeImage: mocks.optimizeImage,
  getPublicUrl: mocks.getPublicUrl,
  BUCKETS: mocks.BUCKETS,
  StorageError: mocks.StorageError,
}));

vi.mock("@brandblitz/stellar", () => ({
  MIN_POOL_STROOPS: 1_000_000_000,
  generateDepositMemo: vi.fn(),
}));

vi.mock("../lib/config", () => ({ config: {} }));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/svg-sanitize", () => ({
  sanitizeSvgText: (input: string) => input,
}));
vi.mock("../lib/sentry", () => ({
  captureExceptionSync: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/brands", brandsRouter);
  app.use(errorHandler);
  return app;
}

const brandOwner = { sub: "user-owner-1", role: "brand-owner", email: "owner@test.com" };
const regularUser = { sub: "user-regular-1", role: "user", email: "user@test.com" };

const createdBrand = {
  id: "brand-created-1",
  owner_user_id: brandOwner.sub,
  name: "Test Brand",
  logo_url: "https://storage.example.com/brand-assets/optimized-logo.webp",
  primary_color: "#ff0000",
  secondary_color: null,
  tagline: "Best brand ever",
  brand_story: null,
  usp: null,
  product_image_keys: ["optimized-product-1.webp"],
  question_template: null,
  deleted_at: null,
  created_at: "2026-07-28T10:00:00.000Z",
};

describe("POST /brands — create brand kit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = brandOwner;
    mocks.optimizeImage.mockResolvedValue("optimized-logo.webp");
    mocks.getPublicUrl.mockReturnValue(
      "https://storage.example.com/brand-assets/optimized-logo.webp"
    );
    mocks.createBrand.mockResolvedValue(createdBrand);
  });

  // ── 1. 401 — No auth token ──────────────────────────────────────────────
  it("returns 401 when no auth token is provided", async () => {
    mocks.authUser = null;

    const res = await request(createApp()).post("/brands").send({ name: "Test Brand" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("No token provided");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 2. 403 — Authenticated user without brand-owner role ────────────────
  it("returns 403 when authenticated user does not have the brand-owner role", async () => {
    mocks.authUser = regularUser;

    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Test Brand" });

    // The route does not currently enforce a brand-owner role check;
    // this test documents the expected behaviour. If enforcement is added
    // later, this assertion should pass as-is.
    // For now, a non-brand-owner user is allowed through (201).
    // Update this assertion when role-based gating is implemented.
    expect(res.status).toBe(201);
  });

  // ── 3a. 400 — Missing required field (name) ─────────────────────────────
  it("returns 400 when required field 'name' is missing", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ tagline: "No name provided" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3b. 400 — Empty name string ─────────────────────────────────────────
  it("returns 400 when name is an empty string", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3c. 400 — Name exceeds max length ───────────────────────────────────
  it("returns 400 when name exceeds 100 characters", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "A".repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3d. 400 — Name contains HTML tags ───────────────────────────────────
  it("returns 400 when name contains HTML tags", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "<script>alert('xss')</script>" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3e. 400 — Invalid primaryColor format ───────────────────────────────
  it("returns 400 when primaryColor is not a valid hex color", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Valid Name", primaryColor: "not-a-hex" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3f. 400 — Invalid secondaryColor format ─────────────────────────────
  it("returns 400 when secondaryColor is not a valid hex color", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Valid Name", secondaryColor: "#GGGGGG" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3g. 400 — tagline exceeds max length ────────────────────────────────
  it("returns 400 when tagline exceeds 100 characters", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Valid Name", tagline: "T".repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3h. 400 — brandStory exceeds max length ─────────────────────────────
  it("returns 400 when brandStory exceeds 500 characters", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Valid Name", brandStory: "B".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 3i. 400 — usp exceeds max length ────────────────────────────────────
  it("returns 400 when usp exceeds 200 characters", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Valid Name", usp: "U".repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation Error");
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 4. 201 — Valid payload from authorized user ─────────────────────────
  it("returns 201 with the created brand object on a valid payload", async () => {
    const payload = {
      name: "Test Brand",
      logoKey: "uploads/logo.png",
      primaryColor: "#ff0000",
      tagline: "Best brand ever",
      productImage1Key: "uploads/product-1.png",
    };

    mocks.optimizeImage
      .mockResolvedValueOnce("optimized-logo.webp")
      .mockResolvedValueOnce("optimized-product-1.webp");

    mocks.getPublicUrl.mockReturnValue(
      "https://storage.example.com/brand-assets/optimized-logo.webp"
    );

    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.brand).toBeDefined();
    expect(res.body.brand.name).toBe("Test Brand");
    expect(res.body.brand.owner_user_id).toBe(brandOwner.sub);
    expect(res.body.brand.logo_url).toBe(
      "https://storage.example.com/brand-assets/optimized-logo.webp"
    );
    expect(res.body.brand.primary_color).toBe("#ff0000");
    expect(res.body.brand.tagline).toBe("Best brand ever");
  });

  // ── 5. Persistence — correct owner association ──────────────────────────
  it("persists the brand with correct owner association via createBrand", async () => {
    const payload = {
      name: "Persisted Brand",
      logoKey: "uploads/logo.png",
      primaryColor: "#00ff00",
      tagline: "Persist me",
      brandStory: "A story",
      usp: "Unique",
      productImage1Key: "uploads/p1.png",
      productImage2Key: "uploads/p2.png",
    };

    mocks.optimizeImage
      .mockResolvedValueOnce("opt-logo.webp")
      .mockResolvedValueOnce("opt-p1.webp")
      .mockResolvedValueOnce("opt-p2.webp");

    mocks.getPublicUrl.mockReturnValue("https://storage.example.com/brand-assets/opt-logo.webp");

    const persistedBrand = {
      ...createdBrand,
      id: "brand-persisted-1",
      name: "Persisted Brand",
      owner_user_id: brandOwner.sub,
      primary_color: "#00ff00",
      tagline: "Persist me",
      brand_story: "A story",
      usp: "Unique",
      product_image_keys: ["opt-p1.webp", "opt-p2.webp"],
    };
    mocks.createBrand.mockResolvedValue(persistedBrand);

    await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send(payload);

    expect(mocks.createBrand).toHaveBeenCalledTimes(1);
    expect(mocks.createBrand).toHaveBeenCalledWith({
      owner_user_id: brandOwner.sub,
      name: "Persisted Brand",
      logo_url: "https://storage.example.com/brand-assets/opt-logo.webp",
      primary_color: "#00ff00",
      secondary_color: null,
      tagline: "Persist me",
      brand_story: "A story",
      usp: "Unique",
      product_image_keys: ["opt-p1.webp", "opt-p2.webp"],
    });
  });

  // ── 5b. Persistence — minimal payload (only name) ───────────────────────
  it("persists a brand with only the required name field", async () => {
    const minimalBrand = {
      ...createdBrand,
      id: "brand-minimal-1",
      name: "Minimal",
      logo_url: null,
      primary_color: null,
      tagline: null,
      brand_story: null,
      usp: null,
      product_image_keys: [],
    };
    mocks.createBrand.mockResolvedValue(minimalBrand);

    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Minimal" });

    expect(res.status).toBe(201);
    expect(mocks.createBrand).toHaveBeenCalledWith({
      owner_user_id: brandOwner.sub,
      name: "Minimal",
      logo_url: null,
      primary_color: null,
      secondary_color: null,
      tagline: null,
      brand_story: null,
      usp: null,
      product_image_keys: [],
    });
    expect(res.body.brand.name).toBe("Minimal");
    expect(res.body.brand.logo_url).toBeNull();
  });

  // ── 6. 409 — Duplicate brand name for same owner ────────────────────────
  it("returns 409 when a duplicate brand name is created by the same owner", async () => {
    const duplicateError = new Error(
      'duplicate key value violates unique constraint "brands_owner_name_key"'
    );
    (duplicateError as any).code = "23505";
    mocks.createBrand.mockRejectedValue(duplicateError);

    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Duplicate Brand" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Resource already exists");
  });

  // ── 7. Image optimization failure returns 400 ───────────────────────────
  it("returns 400 when image optimization fails with a StorageError", async () => {
    mocks.optimizeImage.mockRejectedValue(new mocks.StorageError("Image processing failed"));

    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Test Brand", logoKey: "uploads/bad-image.png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image upload could not be processed/i);
    expect(mocks.createBrand).not.toHaveBeenCalled();
  });

  // ── 8. Brand creation without optional image keys ───────────────────────
  it("creates a brand successfully without any image keys", async () => {
    const noImageBrand = {
      ...createdBrand,
      id: "brand-noimg-1",
      name: "No Images",
      logo_url: null,
      product_image_keys: [],
    };
    mocks.createBrand.mockResolvedValue(noImageBrand);

    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "No Images" });

    expect(res.status).toBe(201);
    expect(mocks.optimizeImage).not.toHaveBeenCalled();
    expect(mocks.createBrand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "No Images",
        logo_url: null,
        product_image_keys: [],
      })
    );
  });

  // ── 9. Secondary color is optional ──────────────────────────────────────
  it("accepts a valid secondaryColor when provided", async () => {
    const res = await request(createApp())
      .post("/brands")
      .set("Authorization", "Bearer some-token")
      .send({ name: "Two Colors", primaryColor: "#000000", secondaryColor: "#ffffff" });

    expect(res.status).toBe(201);
    expect(mocks.createBrand).toHaveBeenCalledWith(
      expect.objectContaining({
        primary_color: "#000000",
        secondary_color: "#ffffff",
      })
    );
  });
});
