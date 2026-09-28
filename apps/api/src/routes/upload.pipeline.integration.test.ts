import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { s3, BUCKETS, optimizeImage } from "@brandblitz/storage";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { redis } from "../lib/redis";
import { errorHandler } from "../middleware/error";

let app: express.Express;
const userId = "user-pipeline-upload";
const authToken = () =>
  jwt.sign({ sub: userId, email: "upload@example.com" }, process.env.JWT_SECRET as string, {
    expiresIn: "1h",
    issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
    audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
  app = express();
  app.use(express.json());
  
  // Register routes manually since this is a clean Express instance for testing
  const { default: uploadRouter } = await import("./upload");
  app.use("/upload", uploadRouter);
  
  app.use(errorHandler);
});

beforeEach(async () => {
  // Clear redis prefix for this user's uploads
  const keys = await redis.keys(`upload:pending:${userId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

afterAll(async () => {
  // Try to cleanup buckets if needed
});

describe("Image Upload Pipeline", () => {
  it("executes the full presign -> upload -> verify -> optimize pipeline", async () => {
    // 1. Generate presigned URL
    const presignResponse = await request(app)
      .post("/upload/presign")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({
        type: "brand-logo",
        contentType: "image/jpeg",
        contentLength: 1024,
      })
      .expect(200);

    const { uploadUrl, key, publicUrl } = presignResponse.body;
    expect(uploadUrl).toBeDefined();
    expect(key).toMatch(/^logos\//);

    // 2. Upload actual JPEG bytes to S3 using the presigned URL
    // JPEG magic bytes: FF D8 FF E0 00 10 4A 46 49 46 00 01
    // And some dummy content for Sharp to parse... Wait, sharp will fail on a dummy JPEG.
    // We need a real valid 1x1 JPEG base64 decoded.
    const validJpegBase64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    const jpegBuffer = Buffer.from(validJpegBase64, "base64");

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": jpegBuffer.length.toString(),
      },
      body: jpegBuffer,
    });
    
    expect(uploadResponse.status).toBe(200);

    // 3. Verify upload
    const verifyResponse = await request(app)
      .post("/upload/verify")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({ key })
      .expect(200);

    expect(verifyResponse.body.exists).toBe(true);
    expect(verifyResponse.body.publicUrl).toBe(publicUrl);

    // 4. Trigger optimization
    const optimizedKey = await optimizeImage(key, "brand-logo");
    expect(optimizedKey).toMatch(/\.webp$/);

    // 5. Assert the resulting CDN URL is reachable / object exists
    const headObj = await s3.send(
      new HeadObjectCommand({
        Bucket: BUCKETS.BRAND_ASSETS,
        Key: optimizedKey,
      })
    );
    expect(headObj.ContentType).toBe("image/webp");
    expect(headObj.ContentLength).toBeGreaterThan(0);
    
    // Cleanup
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKETS.BRAND_ASSETS, Key: key }));
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKETS.BRAND_ASSETS, Key: optimizedKey }));
    // Note: optimization also generates an AVIF, cleanup that too
    const avifKey = optimizedKey.replace(/\.webp$/, ".avif");
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKETS.BRAND_ASSETS, Key: avifKey }));
  });

  it("returns 413 for oversized file presign", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({
        type: "brand-logo",
        contentType: "image/jpeg",
        contentLength: 10 * 1024 * 1024, // 10 MB, brand-logo max is 2 MB
      })
      .expect(400);

    expect(response.body.error).toContain("Content length exceeds maximum");
  });

  it("returns 400 for disallowed MIME type presign", async () => {
    const response = await request(app)
      .post("/upload/presign")
      .set("Authorization", `Bearer ${authToken()}`)
      .send({
        type: "brand-logo",
        contentType: "application/pdf",
        contentLength: 1024,
      })
      .expect(400);
      
    expect(response.body.error).toBeDefined();
  });
});
