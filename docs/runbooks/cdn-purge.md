# Runbook: CDN Cache Purge

## Background

Brand logos and product images are uploaded to MinIO / Cloudflare R2 and served
from `https://assets.brandblitz.app`. After `optimizeImage` runs, every object
is stored with:

```text
Cache-Control: public, max-age=31536000, immutable
```

This is safe because `optimizeImage` embeds an 8-hex-char SHA-256 content hash
in every optimised key:

```text
logos/<uuid>-<8hexchars>.webp
products/<uuid>-<8hexchars>.webp
```

A re-upload of the **same pixels** produces the **same URL**; different pixels
produce a different URL. Browsers and CDN edge nodes can therefore cache
aggressively without ever serving stale content — no cache-busting query string
needed.

---

## When is a purge needed?

| Event | Action needed? |
| --- | --- |
| Player uploads a new brand logo | **No** — `optimizeImage` creates a new content-hashed URL |
| Brand owner re-submits the same image | **No** — same hash → same URL already in cache |
| A corrupt/bad image was served and needs to be removed immediately | **Yes** — purge the specific key |
| Bucket ACL or object metadata changed without re-uploading | **Yes** — purge the specific key |

---

## How to purge a single object

### Cloudflare R2 (production)

```bash
# Purge via Cloudflare Cache API
curl -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://assets.brandblitz.app/<bucket>/<key>"]}'
```

Confirm the purge succeeded:

```bash
curl -I "https://assets.brandblitz.app/<bucket>/<key>"
# Look for: cf-cache-status: MISS  (first hit after purge)
# Subsequent hits show:  cf-cache-status: HIT
```

### MinIO / nginx (dev & staging)

MinIO doesn't have an HTTP cache layer. Any `Cache-Control` header it returns is
simply passed through to the client — no server-side cache entry to purge. If
the nginx `proxy_cache` directive is enabled:

```bash
# On the nginx host — clear the cache directory for the affected path
find /var/cache/nginx -name "$(echo -n 'GET https://assets.brandblitz.app/<key>' | md5sum | cut -d' ' -f1)" -delete
nginx -s reload
```

---

## Smoke test after purge

```bash
# 1. First request — expect a cache MISS or 200 from origin
curl -sI "https://assets.brandblitz.app/brand-assets/logos/<uuid>-<hash>.webp" \
  | grep -E "HTTP|cache-control|cf-cache-status"

# 2. Second request — expect HIT and immutable header still present
curl -sI "https://assets.brandblitz.app/brand-assets/logos/<uuid>-<hash>.webp" \
  | grep -E "HTTP|cache-control|cf-cache-status"

# Expected on second request:
#   HTTP/2 200
#   cache-control: public, max-age=31536000, immutable
#   cf-cache-status: HIT
```

For a 304 smoke test (client-side validation):

```bash
curl -sI "https://assets.brandblitz.app/brand-assets/logos/<uuid>-<hash>.webp" \
  --header "If-None-Match: <etag-from-first-response>"
# Expected: HTTP/2 304
```

---

## Bulk purge (full brand re-index)

```bash
# List all keys for a brand prefix, then purge in batches of 30 (CF limit)
aws s3 ls s3://brand-assets/logos/ --endpoint-url "${S3_ENDPOINT}" \
  | awk '{print "https://assets.brandblitz.app/brand-assets/logos/" $4}' \
  | xargs -n30 bash -c '
      URLS=$(printf '\''"%.s%s"'\'' "$@" | jq -Rs "split(\"\n\") | map(select(. != \"\"))"); \
      curl -sX POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "{\"files\":${URLS}}"' _
```

---

## Related

- [Storage CDN overview](../storage/cdn.md)
- [Rotate S3 credentials](rotate-s3-credentials.md)
- `packages/storage/src/optimize.ts` — where `Cache-Control` is set and the
  content hash is computed
