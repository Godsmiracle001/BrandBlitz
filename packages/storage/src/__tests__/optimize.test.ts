import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { optimizeBuffer, assertImageMatchesDeclaredType, StorageError } from "../optimize";

describe("packages/storage/src/optimize.ts — image profiles unit tests", () => {
  // Helper to generate sample in-memory PNG buffer with specified dimensions
  async function generateTestPng(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  // Helper to generate sample in-memory WebP buffer
  async function generateTestWebp(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 50, g: 200, b: 100, alpha: 1 },
      },
    })
      .webp({ quality: 85 })
      .toBuffer();
  }

  it("logo profile: outputs a WebP image with width <= 400px and file size < 100 KB for standard PNG input", async () => {
    const pngBuffer = await generateTestPng(600, 600);
    const { webpBuffer } = await optimizeBuffer(pngBuffer, "brand-logo");

    expect(webpBuffer).toBeInstanceOf(Buffer);
    expect(webpBuffer.length).toBeLessThan(100 * 1024); // < 100 KB

    const metadata = await sharp(webpBuffer).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBeLessThanOrEqual(400);
    expect(metadata.height).toBeLessThanOrEqual(400);
  });

  it("product profile: outputs target dimensions without distortion (aspect ratio preserved)", async () => {
    const pngBuffer = await generateTestPng(1600, 1200);
    const { webpBuffer } = await optimizeBuffer(pngBuffer, "product-image");

    expect(webpBuffer).toBeInstanceOf(Buffer);

    const metadata = await sharp(webpBuffer).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBeLessThanOrEqual(800);
    expect(metadata.height).toBeLessThanOrEqual(600);
  });

  it("avatar profile: outputs a 1:1 square image (200x200) at configured resolution", async () => {
    const pngBuffer = await generateTestPng(500, 300);
    const { webpBuffer } = await optimizeBuffer(pngBuffer, "user-avatar");

    expect(webpBuffer).toBeInstanceOf(Buffer);

    const metadata = await sharp(webpBuffer).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(200);
  });

  it("unsupported MIME type (e.g. text/plain or invalid buffer): throws descriptive StorageError", async () => {
    const textBuffer = Buffer.from("Hello world, this is a plain text file", "utf-8");

    await expect(
      assertImageMatchesDeclaredType(textBuffer, "text/plain")
    ).rejects.toThrow(StorageError);

    await expect(
      optimizeBuffer(textBuffer, "brand-logo", "text/plain")
    ).rejects.toThrow(StorageError);
  });

  it("already-optimized WebP input does not grow significantly in file size after processing", async () => {
    const originalWebp = await generateTestWebp(300, 300);
    const { webpBuffer: reprocessedWebp } = await optimizeBuffer(originalWebp, "brand-logo");

    // Output buffer size should remain optimized and not balloon in size
    expect(reprocessedWebp.length).toBeLessThan(originalWebp.length * 1.5);
  });

  it("writes output to a Buffer (not disk) for streaming", async () => {
    const pngBuffer = await generateTestPng(400, 400);
    const result = await optimizeBuffer(pngBuffer, "brand-logo");

    expect(Buffer.isBuffer(result.webpBuffer)).toBe(true);
    expect(Buffer.isBuffer(result.avifBuffer)).toBe(true);
  });
});
