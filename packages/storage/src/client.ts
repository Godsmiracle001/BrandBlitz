import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "auto",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY!,
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_KEY!,
  },
  // true for MinIO (dev), false for Cloudflare R2 or AWS S3 (prod)
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
});

export const BUCKETS = {
  BRAND_ASSETS: process.env.S3_BUCKET_BRAND_ASSETS ?? "brand-assets",
  SHARE_CARDS: process.env.S3_BUCKET_SHARE_CARDS ?? "share-cards",
} as const;

/**
 * Lifetime (in seconds) of a presigned upload URL.
 *
 * This is the single source of truth for the presign window: the API uses it
 * when calling `getSignedUrl`, and the web upload UI must use the same value
 * for its countdown so the client never lets a user submit against an expired
 * URL (which S3 answers with a swallowed 403). Keep this in sync with the UI
 * timeout in apps/web's upload component.
 */
export const PRESIGNED_URL_TTL_SECONDS = 600;

export type BucketKey = (typeof BUCKETS)[keyof typeof BUCKETS];

/**
 * Returns the publicly accessible URL for a stored object.
 * When CDN_BASE_URL is set, returns a CDN-prefixed URL.
 * In dev: http://localhost:9000/brand-assets/logos/uuid.webp
 * In prod: https://assets.brandblitz.app/logos/uuid.webp
 */
export function getPublicUrl(bucket: string, key: string): string {
  const cdnBase = process.env.CDN_BASE_URL;
  if (cdnBase) {
    return `${cdnBase}/${bucket}/${key}`;
  }
  const base = process.env.S3_PUBLIC_URL || process.env.S3_ENDPOINT || "";
  return `${base}/${bucket}/${key}`;
}

export interface UploadObjectOptions {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  /**
   * Set to true for content-addressed objects (hashed key).
   * Enables `Cache-Control: public, max-age=31536000, immutable`.
   * Defaults to false for mutable objects (e.g. pre-optimisation originals).
   */
  immutable?: boolean;
}

/**
 * Raised when a buffer fails server-side validation before being written to
 * storage (issue #505). Storage writes are rejected for empty buffers or image
 * content whose magic bytes do not match the declared content type.
 */
export class StorageValidationError extends Error {
  public code = "STORAGE_VALIDATION_FAILED";
  constructor(message: string, public key: string, public contentType: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

// Magic-byte validators for the raster image types we accept. Content types not
// listed here (e.g. image/avif produced by Sharp) are only checked for being
// non-empty, since their signatures are container-dependent.
const IMAGE_MAGIC_VALIDATORS: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) =>
    b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.length >= 6 && b.toString("ascii", 0, 4) === "GIF8",
  "image/webp": (b) =>
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP",
};

/**
 * Upload a buffer to S3-compatible storage.
 * When `immutable` is true the object is stored with a one-year immutable
 * cache header — safe whenever the key contains a content hash.
 *
 * Rejects empty buffers and image content whose magic bytes contradict the
 * declared content type before any bytes leave the process (issue #505).
 */
export async function uploadObject({
  bucket,
  key,
  body,
  contentType,
  immutable = false,
}: UploadObjectOptions): Promise<void> {
  if (!body || body.length === 0) {
    throw new StorageValidationError(
      "Refusing to store an empty file buffer",
      key,
      contentType,
    );
  }

  const validator = IMAGE_MAGIC_VALIDATORS[contentType];
  if (validator && !validator(body)) {
    throw new StorageValidationError(
      `Buffer magic bytes do not match declared content type ${contentType}`,
      key,
      contentType,
    );
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(immutable
        ? { CacheControl: "public, max-age=31536000, immutable" }
        : {}),
    }),
  );
}
