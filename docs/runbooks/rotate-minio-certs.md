# Runbook: Rotate MinIO TLS Certificates

## Overview

MinIO in production serves over HTTPS using a TLS certificate mounted at `/certs` inside the container (host path `/etc/minio/certs`). This runbook covers initial setup and certificate rotation.

---

## Initial Setup

1. **Generate the certificate** on the host that runs the MinIO container:

   ```bash
   pnpm minio:certs /etc/minio/certs
   ```

   (The `minio:certs` alias wraps `bash scripts/generate-minio-certs.sh` — see the root `package.json`.)

   For production, replace the self-signed cert with one issued by your CA or Let's Encrypt (see [Obtain a CA-signed certificate](#obtain-a-ca-signed-certificate) below).

2. **Verify** the cert is in place:

   ```bash
   ls -la /etc/minio/certs/
   # public.crt   (certificate)
   # private.key  (private key, mode 600)
   ```

3. **Bring up the stack**:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d minio
   ```

4. **Confirm TLS is active**:

   ```bash
   curl -k https://localhost:9000/minio/health/live
   # → HTTP 200
   ```

---

## Rotation Procedure

Rotate before the certificate expiry date (check with `openssl x509 -in /etc/minio/certs/public.crt -noout -dates`).

1. **Back up the current certificate**:

   ```bash
   sudo cp -a /etc/minio/certs /etc/minio/certs.bak-$(date +%Y%m%d)
   ```

2. **Generate a new certificate** (or obtain one from your CA):

   ```bash
   pnpm minio:certs /etc/minio/certs
   ```

3. **Reload MinIO** — it picks up new certs on restart:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml restart minio
   ```

4. **Verify** the new certificate is active:

   ```bash
   openssl s_client -connect localhost:9000 -servername minio </dev/null 2>/dev/null \
     | openssl x509 -noout -dates
   ```

5. **Update trust stores** on any service that validates the MinIO cert (e.g., API and worker containers that use `S3_FORCE_PATH_STYLE=true`). If using a self-signed cert, add `public.crt` to each container's CA bundle or set `NODE_TLS_REJECT_UNAUTHORIZED=0` only in a controlled internal network.

6. **Remove the backup** once rotation is confirmed stable (≥24 h):

   ```bash
   sudo rm -rf /etc/minio/certs.bak-*
   ```

---

## Obtain a CA-signed Certificate

For public-facing MinIO or strict internal PKI:

```bash
# Using Certbot (Let's Encrypt):
sudo certbot certonly --standalone -d minio.yourdomain.com

# Copy to the expected paths:
sudo cp /etc/letsencrypt/live/minio.yourdomain.com/fullchain.pem /etc/minio/certs/public.crt
sudo cp /etc/letsencrypt/live/minio.yourdomain.com/privkey.pem   /etc/minio/certs/private.key
sudo chmod 600 /etc/minio/certs/private.key
```

Then restart MinIO as in step 3 above.

---

## Environment Variables

| Variable | Default (prod) | Description |
| --- | --- | --- |
| `S3_ENDPOINT` | `https://minio:9000` | Must use `https://` in production |
| `MINIO_OPTS` | `--certs-dir /certs` | Passed to the MinIO server command |

The prod compose override (`docker-compose.prod.yml`) sets `S3_ENDPOINT` to `https://minio:9000` by default. Override via the host environment if MinIO is on a different hostname.

---

## Alerts

If clients log `certificate has expired` or TLS handshake errors, treat this as P1. Run the rotation procedure above immediately.
