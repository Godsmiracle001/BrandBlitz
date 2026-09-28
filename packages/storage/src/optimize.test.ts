import { createHash } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { optimizeImage, StorageError, assertImageMatchesDeclaredType } from "./optimize";
import { s3, uploadObject } from "./client";
import sharp from "sharp";

vi.mock("./client", () => ({
  s3: {
    send: vi.fn(),
  },
  BUCKETS: {
    BRAND_ASSETS: "brand-assets",
  },
  uploadObject: vi.fn().mockResolvedValue(undefined),
}));

// We'll mock sharp for some tests but keep it real for others if needed.
// Actually, for unit tests, it's better to mock it completely to avoid binary dependencies in some environments.
vi.mock("sharp", () => {
  const mSharp = vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ format: "png" }),
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    avif: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("optimized")),
  }));
  return { default: mSharp };
});

describe("optimizeImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const dummyBuffer = Buffer.from("dummy");

  it("should process the image successfully (happy path)", async () => {
    const optimizedContent = Buffer.from("optimized");
    const expectedHash = createHash("sha256").update(dummyBuffer).digest("hex").slice(0, 8);
    const expectedKey = `test-image-${expectedHash}.webp`;
    const expectedAvifKey = `test-image-${expectedHash}.avif`;

    vi.mocked(s3.send).mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => dummyBuffer,
      },
    });

    const optimizedKey = await optimizeImage("test-image.png", "brand-logo");

    // Key must contain a content hash and use .webp extension
    expect(optimizedKey).toBe(expectedKey);
    // s3.send called once only (GetObjectCommand); upload goes through uploadObject
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(sharp).toHaveBeenCalledWith(dummyBuffer);
    // uploadObject called twice: once for webp, once for avif
    expect(uploadObject).toHaveBeenCalledTimes(2);
    expect(uploadObject).toHaveBeenCalledWith({
      bucket: "brand-assets",
      key: expectedKey,
      body: optimizedContent,
      contentType: "image/webp",
      immutable: true,
    });
    expect(uploadObject).toHaveBeenCalledWith({
      bucket: "brand-assets",
      key: expectedAvifKey,
      body: optimizedContent,
      contentType: "image/avif",
      immutable: true,
    });
  });

  it("uses different fingerprinted keys when the original content changes", async () => {
    const buffer1 = Buffer.from("first original image");
    const buffer2 = Buffer.from("second original image");
    vi.mocked(s3.send)
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => buffer1 },
      })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => buffer2 },
      });
    vi.mocked(sharp)
      .mockReturnValueOnce({
        metadata: vi.fn().mockResolvedValue({ format: "png" }),
        resize: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        avif: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from("optimized")),
      } as any);

    const first = await optimizeImage("logos/logo.png", "brand-logo");
    const second = await optimizeImage("logos/logo.png", "brand-logo");

    expect(first).toMatch(/^logos\/logo-[a-f0-9]{8}\.webp$/);
    expect(second).toMatch(/^logos\/logo-[a-f0-9]{8}\.webp$/);
    expect(first).not.toBe(second);
  });

  it("should throw a StorageError if the object body is null/undefined (missing object)", async () => {
    vi.mocked(s3.send).mockResolvedValue({
      Body: undefined,
    });

    await expect(optimizeImage("missing-image.png", "brand-logo"))
      .rejects.toThrow(StorageError);
  });

  it("should skip optimization and return original key for unsupported formats", async () => {
    vi.mocked(s3.send).mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => dummyBuffer,
      },
    });

    // Mock metadata to return unsupported format
    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockResolvedValue({ format: "gif" }),
    } as any);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resultKey = await optimizeImage("test-image.gif", "brand-logo");

    expect(resultKey).toBe("test-image.gif");
    expect(s3.send).toHaveBeenCalledTimes(1); // Only GetObjectCommand
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported image format: gif"));
    
    warnSpy.mockRestore();
  });

  it("should skip optimization and return original key when metadata processing fails", async () => {
    vi.mocked(s3.send).mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => dummyBuffer,
      },
    });

    // Mock sharp to throw on metadata
    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockRejectedValue(new Error("Sharp error")),
    } as any);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resultKey = await optimizeImage("corrupt.png", "brand-logo");

    expect(resultKey).toBe("corrupt.png");
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to process image metadata"));

    warnSpy.mockRestore();
  });

  it("should skip optimization and return original key if metadata has no format", async () => {
    vi.mocked(s3.send).mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => dummyBuffer,
      },
    });

    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockResolvedValue({}), // No format
    } as any);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resultKey = await optimizeImage("no-format.png", "brand-logo");

    expect(resultKey).toBe("no-format.png");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported image format: undefined"));

    warnSpy.mockRestore();
  });

  it("throws when the declared ContentType does not match the decoded format", async () => {
    vi.mocked(s3.send).mockResolvedValueOnce({
      ContentType: "image/png",
      Body: { transformToByteArray: async () => dummyBuffer },
    });
    // Sharp decodes the bytes as a JPEG, contradicting the declared image/png.
    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockResolvedValue({ format: "jpeg" }),
    } as never);

    await expect(optimizeImage("forged.png", "brand-logo")).rejects.toThrow(StorageError);
  });
});

describe("assertImageMatchesDeclaredType (issue #505)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const buf = Buffer.from("img");

  it("resolves when Sharp's format matches the declared MIME", async () => {
    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockResolvedValue({ format: "png" }),
    } as never);
    await expect(assertImageMatchesDeclaredType(buf, "image/png")).resolves.toBeUndefined();
  });

  it("throws when Sharp's format differs from the declared MIME", async () => {
    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockResolvedValue({ format: "gif" }),
    } as never);
    await expect(assertImageMatchesDeclaredType(buf, "image/png")).rejects.toThrow(StorageError);
  });

  it("throws when Sharp cannot decode the buffer", async () => {
    vi.mocked(sharp).mockReturnValueOnce({
      metadata: vi.fn().mockRejectedValue(new Error("bad image")),
    } as never);
    await expect(assertImageMatchesDeclaredType(buf, "image/png")).rejects.toThrow(StorageError);
  });

  it("throws for an unsupported declared MIME type", async () => {
    await expect(assertImageMatchesDeclaredType(buf, "application/pdf")).rejects.toThrow(StorageError);
  });
});
