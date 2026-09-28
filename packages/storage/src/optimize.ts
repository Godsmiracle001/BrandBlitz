import { createHash } from "crypto";
import sharp from "sharp";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3, BUCKETS, getPublicUrl, uploadObject } from "./client";

type ImageType = "brand-logo" | "product-image" | "user-avatar";

const SPECS: Record<ImageType, { width: number; height: number; fit: "contain" | "inside" | "cover" }> = {
  "brand-logo":    { width: 400, height: 400, fit: "contain" },
  "product-image": { width: 800, height: 600, fit: "inside" },
  "user-avatar":   { width: 200, height: 200, fit: "cover" },
};

export class StorageError extends Error {
  public code: string;
  constructor(
    message: string,
    public key: string,
    public bucket: string,
    code = "STORAGE_BODY_EMPTY",
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

// Sharp's reported format for each declared MIME type. Used as a secondary,
// decoder-level check that the bytes really are the image type they claim.
const MIME_TO_SHARP_FORMATS: Record<string, string[]> = {
  "image/jpeg": ["jpeg", "jpg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};

/**
 * Secondary defence for issue #505: confirm the Sharp library can actually
 * decode the buffer and that its real format matches the declared MIME type.
 *
 * Magic-byte inspection at the API layer catches renamed files; this catches
 * payloads that begin with a valid signature but are otherwise malformed or a
 * different format than declared. Throws a StorageError on any mismatch.
 */
export async function assertImageMatchesDeclaredType(
  buffer: Buffer,
  declaredMime: string,
  key = "",
  bucket = "",
): Promise<void> {
  const expectedFormats = MIME_TO_SHARP_FORMATS[declaredMime];
  if (!expectedFormats) {
    throw new StorageError(
      `Unsupported declared MIME type: ${declaredMime}`,
      key,
      bucket,
      "STORAGE_MIME_UNSUPPORTED",
    );
  }

  let format: string | undefined;
  try {
    ({ format } = await sharp(buffer).metadata());
  } catch (error) {
    throw new StorageError(
      `Sharp could not parse the buffer as an image: ${(error as Error).message}`,
      key,
      bucket,
      "STORAGE_IMAGE_UNDECODABLE",
    );
  }

  if (!format || !expectedFormats.includes(format)) {
    throw new StorageError(
      `Image content (${format ?? "unknown"}) does not match declared type ${declaredMime}`,
      key,
      bucket,
      "STORAGE_MIME_MISMATCH",
    );
  }
}

/**
 * Optimize an in-memory image Buffer for a given profile ("brand-logo", "product-image", "user-avatar").
 * Validates declared MIME type if provided, resizes according to profile specs,
 * and returns WebP and AVIF output buffers without writing to disk.
 */
export async function optimizeBuffer(
  buffer: Buffer,
  type: ImageType,
  declaredMime?: string,
): Promise<{ webpBuffer: Buffer; avifBuffer: Buffer }> {
  if (declaredMime) {
    await assertImageMatchesDeclaredType(buffer, declaredMime);
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw new StorageError(
      `Sharp could not parse the buffer as an image: ${(error as Error).message}`,
      "",
      "",
      "STORAGE_IMAGE_UNDECODABLE",
    );
  }

  const supportedFormats = ["jpeg", "jpg", "png", "webp", "avif", "tiff"];
  if (!metadata.format || !supportedFormats.includes(metadata.format)) {
    throw new StorageError(
      `Unsupported image format: ${metadata.format ?? "unknown"}`,
      "",
      "",
      "STORAGE_MIME_UNSUPPORTED",
    );
  }

  const spec = SPECS[type];

  const webpBuffer = await sharp(buffer)
    .resize(spec.width, spec.height, {
      fit: spec.fit,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .webp({ quality: 85 })
    .toBuffer();

  const avifBuffer = await sharp(buffer)
    .resize(spec.width, spec.height, {
      fit: spec.fit,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .avif({ quality: 75 })
    .toBuffer();

  return { webpBuffer, avifBuffer };
}

/**
 * Fetch the original image from storage, resize + convert to WebP, overwrite in place.
 * Called after brand kit form submission — not at presign time (keeps presign flow fast).
 *
 * @returns The new key (with .webp extension)
 */
export async function optimizeImage(key: string, type: ImageType): Promise<string> {
  const original = await s3.send(
    new GetObjectCommand({ Bucket: BUCKETS.BRAND_ASSETS, Key: key })
  );

  if (!original.Body) {
    throw new StorageError(
      `Failed to retrieve original image from storage for key: ${key}. Body is empty or missing.`,
      key,
      BUCKETS.BRAND_ASSETS
    );
  }

  const buffer = Buffer.from(await original.Body.transformToByteArray());

  const declaredMime = original.ContentType;
  if (declaredMime && declaredMime in MIME_TO_SHARP_FORMATS) {
    await assertImageMatchesDeclaredType(buffer, declaredMime, key, BUCKETS.BRAND_ASSETS);
  }

  // Check if format is supported and if image is valid
  try {
    const metadata = await sharp(buffer).metadata();
    const supportedFormats = ["jpeg", "jpg", "png", "webp", "avif", "tiff"];
    if (!metadata.format || !supportedFormats.includes(metadata.format)) {
      console.warn(`[storage] Unsupported image format: ${metadata.format}. Skipping optimization for ${key}.`);
      return key;
    }
  } catch (error) {
    console.warn(`[storage] Failed to process image metadata for ${key}. Skipping optimization. Reason: ${(error as Error).message}`);
    return key;
  }

  const { webpBuffer, avifBuffer } = await optimizeBuffer(buffer, type);

  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 8);
  const base = key.replace(/\.[^.]+$/, "");

  const webpKey = `${base}-${hash}.webp`;
  await uploadObject({
    bucket: BUCKETS.BRAND_ASSETS,
    key: webpKey,
    body: webpBuffer,
    contentType: "image/webp",
    immutable: true,
  });

  const avifKey = `${base}-${hash}.avif`;
  await uploadObject({
    bucket: BUCKETS.BRAND_ASSETS,
    key: avifKey,
    body: avifBuffer,
    contentType: "image/avif",
    immutable: true,
  });

  return webpKey;
}
