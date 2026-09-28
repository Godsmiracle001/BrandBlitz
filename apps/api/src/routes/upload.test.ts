import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn();
const mockGetPublicUrl = vi.fn((bucket: string, key: string) => `https://public/${bucket}/${key}`);
const mockOptimizeImage = vi.fn();

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { sub: "user-123", email: "test@example.com" };
    return next();
  },
  optionalAuth: (req: any, _res: any, next: any) => {
    req.user = { sub: "user-123", email: "test@example.com" };
    return next();
  },
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  authLimiter: (_req: any, _res: any, next: any) => next(),
  challengeStartLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  phoneRateLimit: (_req: any, _res: any, next: any) => next(),
  webhookLimiter: (_req: any, _res: any, next: any) => next(),
  webhookRotationLimiter: (_req: any, _res: any, next: any) => next(),
  waitlistLimiter: (_req: any, _res: any, next: any) => next(),
  questionPreviewLimiter: (_req: any, _res: any, next: any) => next(),
  reportLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("@brandblitz/storage", () => ({
  s3: { send: mockSend },
  BUCKETS: {
    BRAND_ASSETS: "brand-assets",
    SHARE_CARDS: "share-cards",
  },
  PRESIGNED_URL_TTL_SECONDS: 60,
  getPublicUrl: mockGetPublicUrl,
  optimizeImage: mockOptimizeImage,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  },
}));

vi.mock("../db/index", () => ({
  query: mockQuery,
}));

import { errorHandler } from "../middleware/error";

let app: express.Express;
let registerRoutes: (app: express.Express) => void;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  const routes = await import("../routes");
  registerRoutes = routes.registerRoutes;
  registerRoutes(app);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.resetAllMocks();
  // Default: Redis set/del succeed silently
  mockRedisSet.mockResolvedValue("OK");
  mockRedisDel.mockResolvedValue(1);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("upload routes integration", () => {
  it("POST /upload/presign returns signed URL and public URL for valid brand-logo uploads", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://signed-url");

    const response = await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentType: "image/png",
        contentLength: 1024 * 1024,
      })
      .expect(200);

    expect(response.body).toEqual({
      uploadUrl: "https://signed-url",
      key: expect.stringMatching(/^logos\/[\w-]{36}$/),
      publicUrl: expect.stringContaining("https://public/brand-assets/logos/"),
      expiresIn: 60,
    });
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);

    const command = mockGetSignedUrl.mock.calls[0][1];
    expect(command.input).toMatchObject({
      Bucket: "brand-assets",
      ContentType: "image/png",
      Key: response.body.key,
    });

    expect(mockGetPublicUrl).toHaveBeenCalledWith(
      "brand-assets",
      response.body.key
    );

    // Ownership record must be created in Redis
    expect(mockRedisSet).toHaveBeenCalledOnce();
    const [redisKey, , , ttl] = mockRedisSet.mock.calls[0];
    expect(redisKey).toContain(`user-123:${response.body.key}`);
    expect(ttl).toBeGreaterThan(0);
  });

  it("POST /upload/presign rejects disallowed MIME types with 400", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentType: "image/gif",
        contentLength: 1024,
      })
      .expect(400);

    expect(response.body.error).toBe("Validation Error");
  });

  it("POST /upload/presign rejects oversize contentLength with 400", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentType: "image/png",
        contentLength: 3 * 1024 * 1024,
      })
      .expect(400);

    expect(response.body.error).toBe(
      "Content length exceeds maximum of 2MB for brand-logo"
    );
  });

  it("POST /upload/verify returns 200 when the object exists and MIME matches", async () => {
    // HeadObject → ContentType: image/png
    mockSend.mockResolvedValueOnce({ ContentType: "image/png" });
    // GetObject Range → PNG magic bytes
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => pngMagic },
    });

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/test-key" })
      .expect(200);

    expect(response.body).toEqual({
      exists: true,
      publicUrl: "https://public/brand-assets/logos/test-key",
    });
    expect(mockSend.mock.calls[0][0]?.input).toMatchObject({
      Bucket: "brand-assets",
      Key: "logos/test-key",
    });
    // Ownership record must be cleared after successful verify
    expect(mockRedisDel).toHaveBeenCalledOnce();
  });

  it("POST /upload/verify returns 404 when the object does not exist", async () => {
    mockSend.mockRejectedValueOnce(new Error("Not found"));

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/test-key" })
      .expect(404);

    expect(response.body.error).toBe("File not found in storage");
  });

  // ── MIME magic-byte validation ─────────────────────────────────────────────

  it("POST /upload/verify returns 200 for a valid PNG (magic bytes match)", async () => {
    mockSend.mockResolvedValueOnce({ ContentType: "image/png" });
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => pngMagic },
    });

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/valid.png" })
      .expect(200);

    expect(response.body.exists).toBe(true);
  });

  it("POST /upload/verify returns 415 and deletes when magic bytes mismatch declared MIME", async () => {
    mockSend.mockResolvedValueOnce({ ContentType: "image/png" });
    // JPEG magic bytes — mismatch with declared image/png
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => jpegMagic },
    });
    mockSend.mockResolvedValueOnce({}); // DeleteObject

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/bad.png" })
      .expect(415);

    expect(response.body.error).toBe("File content does not match declared content type");
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("POST /upload/verify returns 415 for a renamed non-image file (.jpg with text content)", async () => {
    mockSend.mockResolvedValueOnce({ ContentType: "image/jpeg" });
    // A PHP webshell renamed to .jpg — no valid image signature.
    const phpShell = Buffer.from("<?php system($_GET['c']); ?>", "ascii");
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => phpShell },
    });
    mockSend.mockResolvedValueOnce({}); // DeleteObject

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "products/webshell.jpg" })
      .expect(415);

    expect(response.body.error).toBe("File content does not match declared content type");
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("POST /upload/verify returns 413 and deletes when the object exceeds the size cap", async () => {
    // brand-logo cap is 2MB; HeadObject reports 3MB.
    mockSend.mockResolvedValueOnce({
      ContentType: "image/png",
      ContentLength: 3 * 1024 * 1024,
    });
    mockSend.mockResolvedValueOnce({}); // DeleteObject

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/huge.png" })
      .expect(413);

    expect(response.body.error).toMatch(/exceeds maximum allowed size/i);
    // Rejected before any byte read — only Head + Delete were issued.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("POST /upload/presign returns 400 and never calls the storage client when contentType is missing from the body", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentLength: 1024,
      })
      .expect(400);

    expect(response.body.error).toBe("Validation Error");
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("POST /upload/presign returns a well-formed HTTPS uploadUrl containing the expected bucket hostname", async () => {
    mockGetSignedUrl.mockResolvedValueOnce(
      "https://brand-assets.s3.amazonaws.com/logos/abc-123?X-Amz-Signature=deadbeef"
    );

    const response = await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentType: "image/png",
        contentLength: 1024,
      })
      .expect(200);

    const uploadUrl = new URL(response.body.uploadUrl);
    expect(uploadUrl.protocol).toBe("https:");
    expect(uploadUrl.hostname).toContain("brand-assets");
  });

  it("POST /upload/presign calls the storage client's presign function exactly once on success", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://signed-url");

    await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentType: "image/png",
        contentLength: 1024,
      })
      .expect(200);

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("POST /upload/presign calls the storage client zero times when validation fails (oversize)", async () => {
    await request(app)
      .post("/upload/presign")
      .send({
        type: "brand-logo",
        contentType: "image/png",
        contentLength: 3 * 1024 * 1024,
      })
      .expect(400);

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("POST /upload/presign rejects SVG files at the API layer", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .set("Authorization", "Bearer test-token")
      .send({ type: "brand-logo", contentType: "image/svg+xml", contentLength: 1000 })
      .expect(400);

    expect(response.body.error).toBeDefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("POST /upload/verify rejects SVG files at the API layer", async () => {
    mockSend.mockResolvedValueOnce({ ContentType: "image/svg+xml" });
    const svgContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#6366f1"/></svg>');
    mockSend.mockResolvedValueOnce({ Body: { transformToByteArray: async () => svgContent } });

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/clean.svg" })
      .expect(400);

    expect(response.body.error).toBe("Declared content type is not allowed");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("POST /upload/verify returns 200 for a valid JPEG", async () => {
    mockSend.mockResolvedValueOnce({ ContentType: "image/jpeg" });
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => jpegMagic },
    });

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "avatars/photo.jpg" })
      .expect(200);

    expect(response.body.exists).toBe(true);
  });

  it("POST /upload/verify returns 400 and deletes when declared MIME is not in the allow-list", async () => {
    mockSend.mockResolvedValueOnce({ ContentType: "application/pdf" });
    mockSend.mockResolvedValueOnce({}); // DeleteObject

    const response = await request(app)
      .post("/upload/verify")
      .send({ key: "logos/document.pdf" })
      .expect(400);

    expect(response.body.error).toBe("Declared content type is not allowed");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  // ── Orphan abort (issue #161) ──────────────────────────────────────────────

  it("DELETE /upload/abort deletes the object and returns 204 when caller owns the key", async () => {
    mockRedisGet.mockResolvedValueOnce("1"); // ownership confirmed
    mockSend.mockResolvedValueOnce({});

    await request(app)
      .delete("/upload/abort")
      .send({ key: "logos/orphan-key" })
      .expect(204);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]?.input).toMatchObject({
      Bucket: "brand-assets",
      Key: "logos/orphan-key",
    });
    // Ownership record must be removed after successful delete
    expect(mockRedisDel).toHaveBeenCalledOnce();
  });

  it("DELETE /upload/abort targets the correct bucket for avatars/", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    mockSend.mockResolvedValueOnce({});

    await request(app)
      .delete("/upload/abort")
      .send({ key: "avatars/orphan-key" })
      .expect(204);

    expect(mockSend.mock.calls[0][0]?.input).toMatchObject({
      Bucket: "brand-assets",
      Key: "avatars/orphan-key",
    });
  });

  it("DELETE /upload/abort returns 403 when the caller did not create the key (IDOR guard)", async () => {
    mockRedisGet.mockResolvedValueOnce(null); // no ownership record

    const response = await request(app)
      .delete("/upload/abort")
      .send({ key: "logos/someone-elses-key" })
      .expect(403);

    expect(response.body.error).toBe("Not authorised to abort this upload");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("DELETE /upload/abort returns 400 when key is missing", async () => {
    const response = await request(app)
      .delete("/upload/abort")
      .send({})
      .expect(400);

    expect(response.body.error).toBe("Validation Error");
  });

  describe("POST /upload/complete", () => {
    beforeEach(() => {
      mockOptimizeImage.mockResolvedValue("logos/optimized-abc123.webp");
      mockQuery.mockResolvedValue({ rows: [] });
    });

    it("returns 200 and the associated DB record is updated with the new asset URL", async () => {
      mockRedisGet.mockResolvedValueOnce("1"); // ownership confirmed
      mockSend.mockResolvedValueOnce({}); // HeadObject success

      const response = await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "logos/test-upload-id",
          resourceType: "brand-logo",
          resourceId: "brand-123",
        })
        .expect(200);

      expect(response.body.assetUrl).toBeDefined();
      expect(response.body.optimizedKey).toBe("logos/optimized-abc123.webp");
      expect(mockQuery).toHaveBeenCalledWith(
        "UPDATE brands SET logo_url = $1 WHERE id = $2",
        [expect.any(String), "brand-123"]
      );
    });

    it("the image optimisation pipeline is invoked exactly once per successful completion", async () => {
      mockRedisGet.mockResolvedValueOnce("1");
      mockSend.mockResolvedValueOnce({});

      await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "logos/test-upload-id",
          resourceType: "brand-logo",
          resourceId: "brand-123",
        })
        .expect(200);

      expect(mockOptimizeImage).toHaveBeenCalledTimes(1);
      expect(mockOptimizeImage).toHaveBeenCalledWith("logos/test-upload-id", "brand-logo");
    });

    it("if S3 reports the object does not exist, the endpoint returns 422 and neither the DB nor the optimiser are called", async () => {
      mockRedisGet.mockResolvedValueOnce("1");
      mockSend.mockRejectedValueOnce(new Error("Not found"));

      const response = await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "logos/test-upload-id",
          resourceType: "brand-logo",
          resourceId: "brand-123",
        })
        .expect(422);

      expect(response.body.error).toBe("Object does not exist in storage");
      expect(mockOptimizeImage).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("an unauthenticated request returns 401", async () => {
      const response = await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "logos/test-upload-id",
          resourceType: "brand-logo",
          resourceId: "brand-123",
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    it("completing an upload for a resource the authenticated user does not own returns 403", async () => {
      mockRedisGet.mockResolvedValueOnce(null); // no ownership record

      const response = await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "logos/test-upload-id",
          resourceType: "brand-logo",
          resourceId: "brand-123",
        })
        .expect(403);

      expect(response.body.error).toBe("Upload not found or not owned by user");
      expect(mockOptimizeImage).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("a malformed uploadId in the request body returns 400", async () => {
      const response = await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "not-a-uuid",
          resourceType: "brand-logo",
          resourceId: "brand-123",
        })
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it("updates user avatar when resourceType is user-avatar", async () => {
      mockRedisGet.mockResolvedValueOnce("1");
      mockSend.mockResolvedValueOnce({});

      await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "avatars/test-upload-id",
          resourceType: "user-avatar",
          resourceId: "user-123",
        })
        .expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        "UPDATE users SET avatar_url = $1 WHERE id = $2",
        [expect.any(String), "user-123"]
      );
    });

    it("updates challenge asset when resourceType is challenge-asset", async () => {
      mockRedisGet.mockResolvedValueOnce("1");
      mockSend.mockResolvedValueOnce({});

      await request(app)
        .post("/upload/complete")
        .send({
          uploadId: "products/test-upload-id",
          resourceType: "challenge-asset",
          resourceId: "challenge-123",
        })
        .expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        "UPDATE challenges SET asset_url = $1 WHERE id = $2",
        [expect.any(String), "challenge-123"]
      );
    });
  });
});
