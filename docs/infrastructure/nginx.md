# nginx Configuration

## Overview

BrandBlitz builds a custom nginx image via `nginx/Dockerfile` that includes the
`ngx_brotli` dynamic module. Both gzip and brotli compression are enabled at the
http level for JSON API responses and static assets. Compression levels are tuned
for CPU efficiency (gzip level 5, brotli level 4).

In production the config is generated from a template so that shell variables
(e.g. `${DOMAIN}`) are substituted at container start rather than baked in at
build time.

## How envsubst works

The official nginx image automatically processes any `*.template` file mounted under
`/etc/nginx/templates/` and writes the rendered output to `/etc/nginx/conf.d/` before
nginx starts. No custom entrypoint is needed.

```text
nginx/templates/nginx.prod.conf.template
        │  (mounted as /etc/nginx/templates/default.conf.template)
        │
        ▼  container start → envsubst runs automatically
/etc/nginx/conf.d/default.conf   (rendered, with ${DOMAIN} resolved)
```

## Required environment variable

| Variable   | Example            | Description                                                       |
|------------|--------------------|-------------------------------------------------------------------|
| `DOMAIN`   | `brandblitz.io`    | Public domain — substituted into `server_name` and TLS cert paths |

Set it in your deploy environment or `.env` file. The prod compose passes it through:

```yaml
# docker-compose.prod.yml
nginx:
  environment:
    DOMAIN: ${DOMAIN}
```

## Local dev

Dev uses `nginx/nginx.dev.conf` directly (no variable substitution needed) via
`docker-compose.yml`. The template is prod-only.

### Local TLS certs (optional)

If you need HTTPS in local dev (e.g. for testing secure cookies or WebAuthn):

```bash
bash scripts/generate-nginx-dev-certs.sh
```

This creates `nginx/certs/server.crt` and `nginx/certs/server.key` (self-signed,
valid 365 days). The script follows the same pattern as `scripts/generate-minio-certs.sh`.

To enable TLS, uncomment the HTTPS server block in `nginx/nginx.dev.conf` and
ensure the certs directory is volume-mounted in `docker-compose.yml`:

```yaml
# docker-compose.yml — nginx service volumes
- ./nginx/certs:/etc/nginx/certs:ro
```

## Updating the config

Edit `nginx/templates/nginx.prod.conf.template`. Do **not** edit `nginx/nginx.prod.conf`
(kept only for reference; it is no longer mounted in prod).

## CI check

`gitleaks.yml` fails the build if `${DOMAIN}` appears without the template file path,
ensuring the old non-substituted conf is never re-mounted accidentally.
