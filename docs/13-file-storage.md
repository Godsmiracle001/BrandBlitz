# File Storage

BrandBlitz uses S3-compatible object storage (MinIO in development, Cloudflare R2 in production) for brand logos, product images, and user avatars. Files are uploaded **client-direct** — they never pass through the API server.

---

## Upload Flow

The client executes a three-step flow:

```
1. POST /upload/presign          → { uploadUrl, key, publicUrl, expiresIn: 60 }
2. PUT  <uploadUrl>              → file goes directly to S3/MinIO (no API traffic)
3. POST /upload/verify { key }   → confirms the object exists; returns publicUrl
```

Step 2 uses the presigned PUT URL returned by step 1. The URL expires after **60 seconds**. Step 3 performs a `HeadObject` check server-side before the form accepts the file reference.

---

## Buckets and Key Prefixes

| Upload type | Bucket | Key prefix | Max size |
|---|---|---|---|
| `brand-logo` | `brand-assets` | `logos/` | 2 MB |
| `product-image` | `brand-assets` | `products/` | 5 MB |
| `user-avatar` | `brand-assets` | `avatars/` | 1 MB |

Allowed MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/svg+xml`.

---

## Orphan-Cleanup Policy

An **orphan** is an S3 object where step 2 (PUT) succeeded but step 3 (verify) never confirmed it — typically due to a transient network error or server restart.

### Client-side retry

The client retries `POST /upload/verify` **3 times** before giving up:

| Attempt | Delay before retry |
|---|---|
| 1 | immediate |
| 2 | 200 ms |
| 3 | 500 ms |
| final | 1 000 ms then abort |

### Client-side abort on final failure

If all three verify attempts fail, the client calls:

```
DELETE /upload/abort   { key: "<object-key>" }
```

The API deletes the S3 object immediately using `DeleteObjectCommand`. The user sees:

> "Upload could not be confirmed. The file has been removed. Please try again."

This eliminates the orphan created by the failed flow.

### Server-side orphan reaper (scheduled cleanup)

The client-side abort handles the common case. For orphans that slip through (client closed before the abort call, network error on the DELETE itself), a server-side reaper should run hourly.

#### Recommended implementation (BullMQ)

1. Add a `pending_uploads` table (or a Redis set with TTL) that records `(key, created_at)` when `POST /upload/presign` is called.
2. Remove the entry when `POST /upload/verify` succeeds.
3. A BullMQ repeatable job (`reap-orphan-uploads`) runs every hour:

```typescript
// apps/api/src/queues/processors/orphan-upload.processor.ts
import { Job } from "bullmq";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3, BUCKETS } from "@brandblitz/storage";
import { db } from "../db";

export async function reapOrphanUploads(_job: Job): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

  // Find keys that were presigned but never verified
  const orphans = await db.query<{ key: string }>(
    `SELECT key FROM pending_uploads WHERE created_at < $1`,
    [cutoff]
  );

  for (const { key } of orphans.rows) {
    const bucket = key.startsWith("logos/") || key.startsWith("products/") || key.startsWith("avatars/")
      ? BUCKETS.BRAND_ASSETS
      : BUCKETS.SHARE_CARDS;
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  await db.query(`DELETE FROM pending_uploads WHERE created_at < $1`, [cutoff]);
}
```

4. Register the job in `worker.ts`:

```typescript
await uploadCleanupQueue.add(
  "reap-orphan-uploads",
  {},
  { jobId: "upload:reap-orphans", repeat: { every: 60 * 60 * 1000 } }
);
```

The `pending_uploads` table is not yet in the schema — add a migration when implementing the reaper.

---

## Environment Variables

| Variable | Description |
|---|---|
| `S3_ENDPOINT` | Storage endpoint URL (e.g. `http://localhost:9000` for MinIO) |
| `S3_REGION` | AWS region or `auto` for Cloudflare R2 |
| `S3_ACCESS_KEY_ID` | Access key |
| `S3_SECRET_ACCESS_KEY` | Secret key |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO (path-style URLs) |

---

## Related

- [Upload API reference](./api/upload.md) — Full endpoint reference for presign, verify, complete, abort
- `apps/api/src/routes/upload.ts` — presign, verify, and abort API routes
- `apps/web/src/components/brand/upload-field.tsx` — client upload component with retry logic
- `packages/storage/src/client.ts` — S3 client and bucket constants
- [CDN cache purge runbook](./runbooks/cdn-purge.md)
