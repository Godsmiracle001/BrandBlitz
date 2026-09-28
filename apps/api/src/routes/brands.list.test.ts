import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import brandsRouter from "./brands";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  limiter: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next()
  ),
}));

vi.mock("../db/index", () => ({ query: mocks.query }));
vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { sub: "user-1" } as express.Request["user"];
    next();
  },
}));
vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: mocks.limiter,
  questionPreviewLimiter: mocks.limiter,
}));
vi.mock("../db/queries/brands", () => ({
  createBrand: vi.fn(),
  getBrandsByOwner: vi.fn(),
  getBrandById: vi.fn(),
  getPublicBrandById: vi.fn(),
  getPublicBrands: vi.fn(),
  getBrandMetaById: vi.fn(),
  getActiveDistractorBrands: vi.fn(),
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
vi.mock("../services/questions", () => ({ generateChallengeQuestions: vi.fn() }));
vi.mock("@brandblitz/storage", () => ({
  optimizeImage: vi.fn(),
  StorageError: class StorageError extends Error {},
}));
vi.mock("@brandblitz/stellar", () => ({ MIN_POOL_STROOPS: 1_000_000_000 }));
vi.mock("../lib/config", () => ({ config: {} }));

function createApp() {
  const app = express();
  app.use("/brands", brandsRouter);
  return app;
}

const brandRows = [
  {
    id: "brand-2",
    name: "Beta",
    logo_url: null,
    status: "active",
    created_at: "2026-07-02T00:00:00.000Z",
  },
  {
    id: "brand-1",
    name: "Alpha",
    logo_url: "alpha.png",
    status: "inactive",
    created_at: "2026-07-01T00:00:00.000Z",
  },
];

describe("GET /brands catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ total: brandRows.length }] })
      .mockResolvedValueOnce({ rows: brandRows });
  });

  it("applies a case-insensitive name search", async () => {
    const response = await request(createApp()).get("/brands?search=alpha");
    expect(response.status).toBe(200);
    expect(mocks.query.mock.calls[0][0]).toContain("name ILIKE $1");
    expect(mocks.query.mock.calls[0][1]).toEqual(["%alpha%"]);
    expect(mocks.limiter).toHaveBeenCalled();
  });

  it("filters by derived brand status", async () => {
    const response = await request(createApp()).get("/brands?status=pending");
    expect(response.status).toBe(200);
    expect(mocks.query.mock.calls[1][0]).toContain("status = $1");
    expect(mocks.query.mock.calls[1][1]).toEqual(["pending", 21]);
  });

  it("returns a forward cursor only when another page exists", async () => {
    const page = Array.from({ length: 21 }, (_, index) => ({
      ...brandRows[index % brandRows.length],
      id: `brand-${index}`,
      created_at: new Date(Date.UTC(2026, 6, 31 - index)).toISOString(),
    }));
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ total: 21 }] })
      .mockResolvedValueOnce({ rows: page });

    const response = await request(createApp()).get("/brands");
    expect(response.body.items).toHaveLength(20);
    expect(response.body.total).toBe(21);
    expect(response.body.nextCursor).toEqual(expect.any(String));
    expect(mocks.query.mock.calls[1][1]).toEqual([21]);
  });

  it("returns no cursor for the final partial page", async () => {
    const response = await request(createApp()).get("/brands?limit=20");
    expect(response.body.items).toEqual(brandRows);
    expect(response.body.nextCursor).toBeNull();
  });
});
