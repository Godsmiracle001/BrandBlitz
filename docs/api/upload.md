# Upload API Reference

Brand asset uploads use a presigned S3 flow — files **never** pass through the API server, eliminating memory pressure on the backend.

---

## Upload Types

| Type | Bucket | Key Prefix | Max Size |
|------|--------|------------|----------|
| `brand-logo` | `brand-assets` | `logos/` | 2 MB |
| `product-image` | `brand-assets` | `products/` | 5 MB |
| `user-avatar` | `brand-assets` | `avatars/` | 1 MB |

**Allowed MIME types:** `image/png`, `image/jpeg`, `image/webp`

---

## Endpoints

### 1. `POST /upload/presign`

Generate a presigned PUT URL for direct client-to-storage upload.

**Auth:** Required (Bearer JWT)  
**Rate limit:** `uploadLimiter` — 20 requests per 15 minutes per IP

**Request Body:**

```json
{
  "type": "brand-logo",
  "contentType": "image/png",
  "contentLength": 512000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"brand-logo" \| "product-image" \| "user-avatar"` | Yes | Upload category |
| `contentType` | `"image/png" \| "image/jpeg" \| "image/webp"` | Yes | MIME type |
| `contentLength` | `integer` | Yes | File size in bytes |

**Response (200):**

```json
{
  "uploadUrl": "https://minio:9000/brand-assets/logos/uuid?X-Amz-Signature=...",
  "key": "logos/a1b2c3d4-...",
  "publicUrl": "http://localhost:9000/brand-assets/logos/a1b2c3d4-...",
  "expiresIn": 60
}
```

**Error Codes:**

| Status | Code | Cause |
|--------|------|-------|
| 400 | — | Content length exceeds max for type |
| 409 | — | Rate limit exceeded |
| 502 | `S3_PRESIGN_FAILED` | S3 signing failed |

---

### 2. `POST /upload/verify`

Verify a file was uploaded and its content matches the declared MIME type.

**Auth:** Required (Bearer JWT)

**Request Body:**

```json
{
  "key": "logos/a1b2c3d4-..."
}
```

**How it works:**

1. `HeadObject` to confirm existence and get declared MIME type
2. `GetObject` with `Range: bytes=0-15` to read magic bytes
3. Validates magic bytes against declared MIME
4. Deletes the object if validation fails

**Response (200):**

```json
{
  "exists": true,
  "publicUrl": "http://localhost:9000/brand-assets/logos/a1b2c3d4-..."
}
```

**Error Codes:**

| Status | Code | Cause |
|--------|------|-------|
| 404 | — | File not found in storage |
| 400 | — | Content type not allowed |
| 413 | `FILE_TOO_LARGE` | Exceeds max size for key prefix |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Magic bytes don't match declared MIME |
| 502 | `S3_READ_FAILED` | Failed to read file from storage |

---

### 3. `POST /upload/complete`

Finalize an upload by verifying S3 object existence, enqueuing optimization, and updating the associated DB record.

**Auth:** Required (Bearer JWT)

**Request Body:**

```json
{
  "uploadId": "a1b2c3d4-...",
  "resourceType": "brand-logo",
  "resourceId": "f5e6d7c8-..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `uploadId` | `UUID` | Yes | The S3 object key from presign |
| `resourceType` | `"brand-logo" \| "challenge-asset" \| "user-avatar"` | Yes | Resource type to update |
| `resourceId` | `UUID` | Yes | Brand, challenge, or user ID |

**Response (200):**

```json
{
  "assetUrl": "http://localhost:9000/brand-assets/logos/a1b2c3d4-optimized.webp",
  "optimizedKey": "logos/a1b2c3d4-optimized.webp"
}
```

**Error Codes:**

| Status | Code | Cause |
|--------|------|-------|
| 403 | — | Upload not found or not owned by user |
| 422 | `OBJECT_NOT_FOUND` | Object does not exist in storage |

---

### 4. `DELETE /upload/abort`

Remove an orphan S3 object when verify could not be confirmed.

**Auth:** Required (Bearer JWT)

**Request Body:**

```json
{
  "key": "logos/a1b2c3d4-..."
}
```

**Response:** `204 No Content`

**Error Codes:**

| Status | Code | Cause |
|--------|------|-------|
| 403 | — | Not authorised to abort this upload |

---

## Full Upload Sequence

```bash
# Step 1: Presign
PRESIGN=$(curl -s -X POST http://localhost/api/upload/presign \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"brand-logo","contentType":"image/png","contentLength":50000}')

UPLOAD_URL=$(echo $PRESIGN | jq -r '.uploadUrl')
KEY=$(echo $PRESIGN | jq -r '.key')

# Step 2: PUT to S3 (client-direct, no API traffic)
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: image/png" \
  --data-binary @logo.png

# Step 3: Verify (optional but recommended)
curl -X POST http://localhost/api/upload/verify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"$KEY\"}"

# Step 4: Complete
curl -X POST http://localhost/api/upload/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"uploadId\":\"$KEY\",\"resourceType\":\"brand-logo\",\"resourceId\":\"$BRAND_ID\"}"
```

---

## Orphan Cleanup

If the client fails after PUT but before verify:

1. Client retries `POST /verify` up to 3 times (immediate, 200ms, 500ms)
2. If all retries fail, call `DELETE /upload/abort` with the key
3. Server deletes the S3 object and clears the Redis ownership record

See [13-file-storage.md](../13-file-storage.md) for the full orphan-cleanup policy.

---

## Rate Limiting

The `uploadLimiter` middleware restricts presign requests to **20 per 15 minutes per IP**. The verify, complete, and abort endpoints use the default API rate limiter.

---

## Related

- [File Storage docs](../13-file-storage.md) — Orphan cleanup, buckets, environment variables
- [rate-limits-and-errors.md](./rate-limits-and-errors.md) — Rate limit buckets and error envelope
- `apps/api/src/routes/upload.ts` — Route implementation
- `apps/web/src/components/brand/upload-field.tsx` — Client upload component
