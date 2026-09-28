# Runbook: Secret Rotation

> **Tabletop exercise**: schedule quarterly (last week of each calendar quarter).
> Verify every section end-to-end in staging, then confirm steps are still accurate.
> Next exercise: **2026-Q3** (week of 2026-09-28).

---

## Secret inventory

| Secret                                | Environment variable    | Store                  | Rotation frequency                 |
| ------------------------------------- | ----------------------- | ---------------------- | ---------------------------------- |
| JWT signing secret                    | `JWT_SECRET`            | Docker secret / `.env` | Every 90 days or on leak           |
| JWT refresh secret                    | `JWT_REFRESH_SECRET`    | Docker secret / `.env` | Same as `JWT_SECRET`               |
| Previous JWT secret (rotation window) | `JWT_SECRET_PREVIOUS`   | Docker secret / `.env` | Cleared after 15 min post-rotation |
| Google OAuth client secret            | `GOOGLE_CLIENT_SECRET`  | Docker secret / `.env` | Google-managed / on leak           |
| Stellar hot-wallet secret             | `HOT_WALLET_SECRET`     | Docker secret / `.env` | On leak or key compromise          |
| Stellar hot-wallet public key         | `HOT_WALLET_PUBLIC_KEY` | Docker secret / `.env` | Changes with `HOT_WALLET_SECRET`   |
| MinIO / S3 access key                 | `S3_ACCESS_KEY_ID`      | Docker secret          | Every 90 days or on leak           |
| MinIO / S3 secret key                 | `S3_SECRET_ACCESS_KEY`  | Docker secret          | Every 90 days or on leak           |
| Twilio auth token                     | `TWILIO_AUTH_TOKEN`     | Docker secret / `.env` | On leak                            |
| Twilio account SID                    | `TWILIO_ACCOUNT_SID`    | Docker secret / `.env` | On leak                            |
| Twilio Verify service SID             | `TWILIO_SERVICE_SID`    | Docker secret / `.env` | On leak                            |
| Session integrity key                 | `SESSION_INTEGRITY_KEY` | Docker secret / `.env` | Every 90 days or on leak           |
| Webhook HMAC secret                   | `WEBHOOK_SECRET`        | Docker secret / `.env` | On leak                            |
| Slack webhook URL                     | `SLACK_WEBHOOK_URL`     | GitHub secret          | On leak                            |
| SSH deploy key                        | `PROD_SSH_KEY`          | GitHub secret          | Annually                           |

---

## 1 — JWT secret (zero-downtime dual-verify rotation)

Access tokens have a 15-minute TTL. The API supports a **dual-verify window**:
tokens signed with the _old_ secret are still accepted for 15 min after the new
secret is deployed, preventing forced sign-outs.

### Steps

1. **Generate a new secret** (≥ 32 bytes, base64-safe):

   ```bash
   NEW_JWT=$(openssl rand -base64 48)
   echo "$NEW_JWT"
   ```

2. **Deploy with both secrets active**:
   - Set `JWT_SECRET_PREVIOUS` = current `JWT_SECRET`
   - Set `JWT_SECRET` = `$NEW_JWT`
   - Redeploy the API service.

   The `verifyAccessToken` function in `apps/api/src/lib/tokens.ts` tries the
   new secret first, then falls back to `JWT_SECRET_PREVIOUS`.

3. **Wait 15 minutes** (access-token TTL). All live tokens are now signed with
   the new secret.

4. **Remove the previous secret**:
   - Unset `JWT_SECRET_PREVIOUS`.
   - Redeploy again (or update the Docker secret; a rolling restart is fine).

5. **Verify**:

   ```bash
   curl -f https://brandblitz.io/api/health
   # Check auth flows in staging first.
   ```

> Rotate `JWT_REFRESH_SECRET` the same way (refresh tokens have a 30-day TTL;
> consider revoking all refresh tokens via `revokeAllUserRefreshTokens` before
> removing the previous refresh secret, or simply wait 30 days).

---

## 2 — Stellar hot-wallet secret

Run the automated rotation script:

```bash
# Dry-run on testnet first
pnpm tsx scripts/rotate-hot-wallet.ts --network testnet

# Production (requires HOT_WALLET_SECRET in env; 10-second abort window)
pnpm tsx scripts/rotate-hot-wallet.ts --network public
```

The script:

1. Generates a fresh keypair.
2. Funds the new account from the old wallet.
3. Sweeps remaining USDC old → new.
4. Merges (closes) the old account — all remaining XLM moves to the new wallet.
5. Prints the new `HOT_WALLET_PUBLIC_KEY` / `HOT_WALLET_SECRET` to update.

After the script succeeds, update Docker secrets and redeploy. See
[scripts/rotate-hot-wallet.ts](../../scripts/rotate-hot-wallet.ts) for full details.

---

## 3 — Google OAuth client secret

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Select the BrandBlitz OAuth 2.0 client.
3. Click **Rotate secret** and copy the new value.
4. Update `GOOGLE_CLIENT_SECRET` in the environment / Docker secret.
5. Redeploy the API.
6. Validate the OAuth login flow in staging, then prod.

---

## 4 — S3 / MinIO credentials

Follow [rotate-s3-credentials.md](rotate-s3-credentials.md) for the full procedure.

---

## 5 — Twilio tokens

1. Log in to [Twilio Console](https://console.twilio.com).
2. Rotate `TWILIO_AUTH_TOKEN` (Account → API keys & tokens → Rotate).
3. Update the env / Docker secret.
4. Validate the SMS verification flow (`POST /auth/send-otp`).

---

## 6 — Webhook HMAC secret (`WEBHOOK_SECRET`)

The webhook HMAC secret signs Stellar Horizon event payloads.

1. Generate: `NEW_WH=$(openssl rand -base64 32)`
2. Update the secret in the environment and any allow-listed webhook senders
   (e.g. if you forward webhooks via a third-party relay, update there too).
3. Redeploy the API worker.
4. Send a test event and confirm `POST /webhooks/stellar` returns 200.

---

## 7 — Session integrity key (`SESSION_INTEGRITY_KEY`)

Used to HMAC-stamp completed session scores for anti-cheat. Rotation is
low-urgency (historical HMACs are stored in the DB and only used for auditing).

1. Generate: `NEW_SIK=$(openssl rand -base64 32)`
2. Update env / Docker secret.
3. Redeploy. Historical stamps remain valid (verified against the old key stored
   in the session row).

---

## 8 — SSH deploy key (`PROD_SSH_KEY`)

1. Generate a new Ed25519 keypair: `ssh-keygen -t ed25519 -C "ci-deploy-$(date +%Y%m%d)" -f /tmp/ci_deploy`
2. Add the public key to `~/.ssh/authorized_keys` on the production host.
3. Update the `PROD_SSH_KEY` GitHub secret with the new private key.
4. Remove the old public key from the prod host.
5. Trigger a test deployment to confirm connectivity.

---

## Post-rotation checklist

- [ ] Health check passes: `curl -f https://brandblitz.io/api/health`
- [ ] Auth flow works (sign-in, token refresh)
- [ ] Old secret removed from all stores (env, Docker secrets, CI)
- [ ] Incident note added to internal tracking (what rotated, when, why)
- [ ] `.gitleaks.toml` rule updated if the old secret pattern was custom

---

## Related runbooks

- [leaked-secret.md](leaked-secret.md) — immediate containment when a secret leaks
- [rotate-s3-credentials.md](rotate-s3-credentials.md) — detailed S3 procedure
- [rotate-minio-certs.md](rotate-minio-certs.md) — MinIO TLS cert rotation
