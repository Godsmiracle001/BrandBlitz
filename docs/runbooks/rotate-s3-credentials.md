# Runbook: Rotate S3 / MinIO Credentials

## Overview

In production, the MinIO root password and the API's S3 secret key are stored as
**Docker secrets** (never in plain-text env vars or `.env` files). This runbook covers
generating, rotating, and verifying those secrets.

## Initial provisioning

Run once on the Swarm manager (or any node with `docker secret` access):

```bash
# Generate a 40-character random secret
NEW_SECRET=$(openssl rand -base64 30)

# Create Docker secrets
printf '%s' "$NEW_SECRET" | docker secret create minio_root_password -
printf '%s' "$NEW_SECRET" | docker secret create s3_secret_key -
```

> `minio_root_password` and `s3_secret_key` should be **the same value** — MinIO
> uses the root password as the S3 secret access key.

## Rotation procedure

1. **Generate a new credential:**

   ```bash
   NEW_SECRET=$(openssl rand -base64 30)
   ```

2. **Update MinIO via the mc CLI:**

   ```bash
   mc alias set prod https://s3.brandblitz.io $MINIO_ROOT_USER $OLD_SECRET
   mc admin user add prod brandblitz_svc "$NEW_SECRET"
   mc admin policy attach prod readwrite --user brandblitz_svc
   ```

3. **Replace Docker secrets** (secrets are immutable — create new then update service):

   ```bash
   printf '%s' "$NEW_SECRET" | docker secret create s3_secret_key_v2 -
   docker service update \
     --secret-rm s3_secret_key \
     --secret-add source=s3_secret_key_v2,target=s3_secret_key \
     brandblitz_api
   docker service update \
     --secret-rm s3_secret_key \
     --secret-add source=s3_secret_key_v2,target=s3_secret_key \
     brandblitz_worker
   docker secret rm s3_secret_key
   docker secret create s3_secret_key <<< "$NEW_SECRET"
   ```

4. **Verify services are healthy:**

   ```bash
   docker service ls
   curl -f https://brandblitz.io/api/health
   ```

5. **Revoke the old MinIO user** (if you created a service account in step 2):

   ```bash
   mc admin user disable prod old_service_account
   mc admin user rm prod old_service_account
   ```

## Development setup

For local dev, credentials are plain env-var defaults in `docker-compose.yml`.
Run the helper script to generate per-developer `.env` values:

```bash
npx tsx scripts/setup-dev-secrets.ts
```

## Pre-commit protection

A `gitleaks` pre-commit hook (`scripts/gitleaks.mjs`) scans staged files for secrets
before every commit. Install it once:

```bash
npx husky install
```

If a secret is flagged, rotate it immediately using this runbook — do not just remove
it from the commit; the value is compromised once it touches git history.
