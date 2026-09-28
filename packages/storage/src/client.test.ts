import { describe, it, expect, beforeEach, vi } from "vitest";
import { getPublicUrl, BUCKETS, uploadObject, StorageValidationError, s3 } from "./client";

describe("storage client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  describe("BUCKETS", () => {
    it("has required bucket constants", () => {
      expect(BUCKETS.BRAND_ASSETS).toBeDefined();
      expect(BUCKETS.SHARE_CARDS).toBeDefined();
    });

    it("uses environment variables for bucket names if provided", async () => {
      process.env.S3_BUCKET_BRAND_ASSETS = "custom-brand-assets";
      process.env.S3_BUCKET_SHARE_CARDS = "custom-share-cards";
      
      // We need to re-import because BUCKETS is a constant evaluated at load time
      const { BUCKETS: customBuckets } = await import("./client");
      expect(customBuckets.BRAND_ASSETS).toBe("custom-brand-assets");
      expect(customBuckets.SHARE_CARDS).toBe("custom-share-cards");
    });
  });

  describe("getPublicUrl", () => {
    it("returns correctly formatted URL using S3_PUBLIC_URL", () => {
      process.env.S3_PUBLIC_URL = "https://cdn.example.com";
      expect(getPublicUrl("my-bucket", "path/to/image.webp")).toBe(
        "https://cdn.example.com/my-bucket/path/to/image.webp"
      );
    });

    it("falls back to S3_ENDPOINT if S3_PUBLIC_URL is missing", () => {
      process.env.S3_PUBLIC_URL = "";
      process.env.S3_ENDPOINT = "https://s3.example.com";
      expect(getPublicUrl("my-bucket", "image.webp")).toBe(
        "https://s3.example.com/my-bucket/image.webp"
      );
    });

    it("falls back to empty string if both are missing", () => {
      process.env.S3_PUBLIC_URL = "";
      process.env.S3_ENDPOINT = "";
      expect(getPublicUrl("my-bucket", "image.webp")).toBe(
        "/my-bucket/image.webp"
      );
    });
  });

  describe("uploadObject validation (issue #505)", () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it("rejects an empty buffer before writing to storage", async () => {
      const sendSpy = vi.spyOn(s3, "send");
      await expect(
        uploadObject({ bucket: "b", key: "k", body: Buffer.alloc(0), contentType: "image/png" }),
      ).rejects.toBeInstanceOf(StorageValidationError);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("rejects image content whose magic bytes contradict the declared type", async () => {
      const sendSpy = vi.spyOn(s3, "send");
      const notPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG bytes, declared PNG
      await expect(
        uploadObject({ bucket: "b", key: "k", body: notPng, contentType: "image/png" }),
      ).rejects.toBeInstanceOf(StorageValidationError);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("writes a valid image whose magic bytes match the declared type", async () => {
      const sendSpy = vi.spyOn(s3, "send").mockResolvedValue({} as never);
      await uploadObject({ bucket: "b", key: "k", body: PNG, contentType: "image/png" });
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });
});
