import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  s3,
  BUCKETS,
  getPublicUrl,
  PRESIGNED_URL_TTL_SECONDS,
} from "@brandblitz/storage";
import { redis } from "../lib/redis";
import { authenticate } from "../middleware/authenticate";
import { uploadLimiter } from "../middleware/rate-limit";
import { createError } from "../middleware/error";
import { logger } from "../lib/logger";
import { query } from "../db/index";

/** Redis key that proves a user owns a pending upload. TTL must outlive the
 *  presign window plus the verify-retry window (~1.7 s × 3), so it is anchored
 *  to PRESIGNED_URL_TTL_SECONDS with a 60 s margin. Orphans not aborted within
 *  this window are swept by the server-side reaper (see docs/13-file-storage.md). */
const PENDING_UPLOAD_TTL_SECONDS = PRESIGNED_URL_TTL_SECONDS + 60;

function pendingUploadKey(userId: string, s3Key: string): string {
  return `upload:pending:${userId}:${s3Key}`;
}

const router = Router();

const ALLOWED_UPLOAD_TYPES = {
  "brand-logo":    { bucket: BUCKETS.BRAND_ASSETS, prefix: "logos/",    maxMb: 2 },
  "product-image": { bucket: BUCKETS.BRAND_ASSETS, prefix: "products/", maxMb: 5 },
  "user-avatar":   { bucket: BUCKETS.BRAND_ASSETS, prefix: "avatars/",  maxMb: 1 },
} as const;

const ALLOWED_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

type AllowedMime = typeof ALLOWED_CONTENT_TYPES[number];

/**
 * Maximum allowed size (in bytes) for an uploaded object, derived from the key
 * prefix. Enforced on /verify before any file bytes are read so an oversized
 * object is rejected up front (issue #505).
 */
function maxBytesForKey(key: string): number {
  if (key.startsWith("products/")) return ALLOWED_UPLOAD_TYPES["product-image"].maxMb * 1024 * 1024;
  if (key.startsWith("avatars/")) return ALLOWED_UPLOAD_TYPES["user-avatar"].maxMb * 1024 * 1024;
  return ALLOWED_UPLOAD_TYPES["brand-logo"].maxMb * 1024 * 1024;
}

const PresignSchema = z.object({
  type: z.enum(["brand-logo", "product-image", "user-avatar"]),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  contentLength: z.number().int().positive(),
});

/**
 * Detect MIME type from the first bytes of a buffer using magic numbers.
 * Returns one of the allowed MIME strings, or null if unrecognised.
 */
function detectMime(buf: Buffer): AllowedMime | null {
  if (buf.length < 3) return null;

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // WebP: "RIFF" at 0-3 and "WEBP" at 8-11
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * POST /upload/presign
 * Generate a presigned PUT URL for direct client → storage upload.
 * Files NEVER pass through the API server — no memory pressure.
 */
router.post("/presign", authenticate, uploadLimiter, async (req, res) => {
  const { type, contentType, contentLength } = PresignSchema.parse(req.body);

  const config = ALLOWED_UPLOAD_TYPES[type];
  if (contentLength > config.maxMb * 1024 * 1024) {
    throw createError(
      `Content length exceeds maximum of ${config.maxMb}MB for ${type}`,
      400
    );
  }

  const key = `${config.prefix}${randomUUID()}`;

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  let uploadUrl: string;
  try {
    uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });
  } catch (err) {
    // Never swallow an S3 signing failure — log it and return a structured error.
    logger.error("Failed to generate presigned upload URL", {
      userId: req.user!.sub,
      type,
      error: (err as Error).message,
    });
    throw createError("Failed to generate upload URL", 502, "S3_PRESIGN_FAILED");
  }

  // Record ownership so /abort can verify the caller created this key
  await redis.set(
    pendingUploadKey(req.user!.sub, key),
    "1",
    "EX",
    PENDING_UPLOAD_TTL_SECONDS
  );

  res.json({
    uploadUrl,
    key,
    publicUrl: getPublicUrl(config.bucket, key),
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
  });
});

/**
 * POST /upload/verify
 * Verify a file was actually uploaded and its content matches the declared MIME type.
 *
 * Reads the first 16 bytes via a Range request and validates magic bytes
 * against the declared ContentType. Deletes the object and returns 400 on
 * any validation failure.
 */
router.post("/verify", authenticate, async (req, res) => {
  const { key } = z.object({ key: z.string() }).parse(req.body);

  const bucket = key.startsWith("logos/") || key.startsWith("products/") || key.startsWith("avatars/")
    ? BUCKETS.BRAND_ASSETS
    : BUCKETS.SHARE_CARDS;

  // Step 1: confirm object exists and get its declared ContentType + size
  let declaredMime: string;
  let contentLength: number | undefined;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    declaredMime = head.ContentType ?? "";
    contentLength = head.ContentLength;
  } catch {
    throw createError("File not found in storage", 404);
  }

  // Enforce the maximum file size before reading any bytes for magic-byte
  // inspection, so an oversized object can never trigger byte reads (issue #505).
  const maxBytes = maxBytesForKey(key);
  if (typeof contentLength === "number" && contentLength > maxBytes) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    throw createError(
      `File exceeds maximum allowed size of ${Math.floor(maxBytes / (1024 * 1024))}MB`,
      413,
      "FILE_TOO_LARGE"
    );
  }

  // Only validate MIME for the explicitly allowed types
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(declaredMime)) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    throw createError("Declared content type is not allowed", 400);
  }

  // Step 2: fetch file header for magic-byte validation
  let buf: Buffer;
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-15" })
    );
    const bytes = await (obj.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    buf = Buffer.from(bytes);
  } catch (err) {
    // Surface S3 read failures server-side rather than letting them vanish.
    logger.error("Failed to read uploaded file from storage", {
      userId: req.user!.sub,
      key,
      bucket,
      error: (err as Error).message,
    });
    throw createError("Failed to read file from storage", 502, "S3_READ_FAILED");
  }

  // Step 3: validate detected MIME against declared MIME
  const detected = detectMime(buf);
  if (detected !== declaredMime) {
    // Renamed/forged upload: log as a security event with the actor and request
    // correlation id, then reject with 415 Unsupported Media Type (issue #505).
    logger.warn("Upload rejected: file signature does not match declared type", {
      event: "upload_mime_mismatch",
      userId: req.user!.sub,
      requestId: res.locals.requestId,
      key,
      bucket,
      declaredMime,
      detectedMime: detected,
    });
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    throw createError(
      "File content does not match declared content type",
      415,
      "UNSUPPORTED_MEDIA_TYPE"
    );
  }

  // Remove ownership record now that the upload is committed
  await redis.del(pendingUploadKey(req.user!.sub, key));
  res.json({ exists: true, publicUrl: getPublicUrl(bucket, key) });
});

/**
 * DELETE /upload/abort
 * Remove an orphan S3 object when /upload/verify could not be confirmed.
 * Called by the client after exhausting verify retries so the file does not
 * sit in storage indefinitely.
 */
router.delete("/abort", authenticate, async (req, res) => {
  const { key } = z.object({ key: z.string().min(1) }).parse(req.body);

  // IDOR guard: only the user who created the presign may abort it
  const ownershipKey = pendingUploadKey(req.user!.sub, key);
  const owned = await redis.get(ownershipKey);
  if (!owned) {
    throw createError("Not authorised to abort this upload", 403);
  }

  const bucket =
    key.startsWith("logos/") ||
    key.startsWith("products/") ||
    key.startsWith("avatars/")
      ? BUCKETS.BRAND_ASSETS
      : BUCKETS.SHARE_CARDS;

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await redis.del(ownershipKey);
  res.status(204).end();
});

/**
 * POST /upload/complete
 * Finalizes an upload by verifying S3 object existence, enqueuing optimization,
 * and updating the associated DB record (brand logo, challenge asset, etc.).
 */
router.post("/complete", authenticate, async (req, res) => {
  const { uploadId, resourceType, resourceId } = z.object({
    uploadId: z.string().uuid(),
    resourceType: z.enum(["brand-logo", "challenge-asset", "user-avatar"]),
    resourceId: z.string().uuid(),
  }).parse(req.body);

  // Verify the upload exists and the user owns it
  const uploadKey = pendingUploadKey(req.user!.sub, uploadId);
  const owned = await redis.get(uploadKey);
  if (!owned) {
    throw createError("Upload not found or not owned by user", 403);
  }

  const bucket =
    uploadId.startsWith("logos/") ||
    uploadId.startsWith("products/") ||
    uploadId.startsWith("avatars/")
      ? BUCKETS.BRAND_ASSETS
      : BUCKETS.SHARE_CARDS;

  // Verify the object exists in S3
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: uploadId }));
  } catch {
    throw createError("Object does not exist in storage", 422, "OBJECT_NOT_FOUND");
  }

  // Enqueue optimization job
  const { optimizeImage } = await import("@brandblitz/storage");
  const optimizedKey = await optimizeImage(uploadId, resourceType);

  // Update the associated DB record
  const publicUrl = getPublicUrl(bucket, optimizedKey);
  
  if (resourceType === "brand-logo") {
    await query(
      "UPDATE brands SET logo_url = $1 WHERE id = $2",
      [publicUrl, resourceId]
    );
  } else if (resourceType === "user-avatar") {
    await query(
      "UPDATE users SET avatar_url = $1 WHERE id = $2",
      [publicUrl, resourceId]
    );
  } else if (resourceType === "challenge-asset") {
    await query(
      "UPDATE challenges SET asset_url = $1 WHERE id = $2",
      [publicUrl, resourceId]
    );
  }

  // Clear ownership record
  await redis.del(uploadKey);

  res.json({ assetUrl: publicUrl, optimizedKey });
});

export default router;
