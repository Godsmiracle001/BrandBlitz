import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockGetSignedUrl = vi.fn();

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  authLimiter: (_req: any, _res: any, next: any) => next(),
  challengeStartLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  phoneRateLimit: (_req: any, _res: any, next: any) => next(),
  webhookLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("@brandblitz/storage", () => ({
  s3: { send: vi.fn() },
  BUCKETS: { BRAND_ASSETS: "brand-assets", SHARE_CARDS: "share-cards" },
  PRESIGNED_URL_TTL_SECONDS: 60,
  getPublicUrl: vi.fn((bucket: string, key: string) => `https://public/${bucket}/${key}`),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("../lib/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

import { errorHandler } from "../middleware/error";

let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  const { default: uploadRouter } = await import("./upload");
  app.use("/upload", uploadRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("upload routes — real authenticate middleware", () => {
  it("POST /upload/presign returns 401 for an unauthenticated request and never calls the storage client", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .send({ type: "brand-logo", contentType: "image/png", contentLength: 1024 })
      .expect(401);

    expect(response.body.error).toBeDefined();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
