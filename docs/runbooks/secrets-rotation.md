# Secrets Rotation Runbook

This runbook provides step-by-step procedures for rotating long-lived secrets across BrandBlitz services. Follow these procedures to minimize exposure window and ensure service continuity when a credential is compromised or reaches its rotation deadline.

## Overview

Secrets are rotated on a schedule to limit the blast radius of a potential compromise:

| Secret | Interval | Service(s) | Restart Required |
| ------ | --------- | ----------- | ------------------ |
| `JWT_SECRET` | 90 days | `apps/api` | Yes |
| `STELLAR_HOT_WALLET_SECRET` | 60 days | `packages/stellar` (payout.ts) | Yes (migration required) |
| `GOOGLE_CLIENT_SECRET` | 180 days | `apps/api`, `apps/web` | Yes |
| `WEBHOOK_SECRET` | 90 days | `apps/api`, webhooks, revalidation | Yes |
| `DATABASE_URL` (password) | 90 days | `apps/api` | Yes |
| `SESSION_INTEGRITY_KEY` | 90 days | `apps/api` | Yes |
| `PHONE_HASH_SALT` | 180 days | `apps/api` | Yes (breaks existing hashes) |
| `TWILIO_AUTH_TOKEN` | 180 days | `apps/api`, phone service | Yes |

## Pre-Rotation Checklist

Before rotating any secret:

- [ ] Verify you have access to the secret management system (e.g., GitHub Secrets, HashiCorp Vault, 1Password)
- [ ] Ensure all services are healthy and monitoring is active
- [ ] Notify the team (Slack #ops or email) of the planned rotation
- [ ] Identify peak traffic hours and plan rotation during low-traffic windows
- [ ] Have rollback credentials ready in case of emergency

## Rotation Procedures

### JWT_SECRET

Used by `apps/api` to sign session tokens. Rotating invalidates all outstanding tokens; plan for user re-authentication.

**Services:** `apps/api`

**Steps:**

1. Generate a new secret:

   ```bash
   openssl rand -hex 32
   ```

2. Update `JWT_SECRET` in your secret manager (GitHub Secrets, Vault, etc.)

3. Trigger a deployment of `apps/api`:

   ```bash
   # For Vercel/GitHub Actions:
   # Push a commit or use the deployment UI to redeploy apps/api
   ```

4. Monitor logs for errors:

   ```bash
   # Check API logs for JWT validation failures
   tail -f logs/api.log | grep -i jwt
   ```

5. Users will see a "session expired" error on their next request (expected behavior). They must log in again.

**Rollback:** If users report widespread authentication failures, revert `JWT_SECRET` to the previous value and redeploy immediately.

---

### STELLAR_HOT_WALLET_SECRET

The Ed25519 private key used to sign Stellar payouts. Rotating this requires coordination with the escrow contract and careful transaction sequencing.

**Services:** `packages/stellar/src/payout.ts`, payout worker

**Complexity:** HIGH - affects asset security and requires contract migration

**Steps:**

1. Generate a new Stellar keypair on testnet:

   ```bash
   stellar-cli keys generate
   # Outputs: Public Key: GXXXXX, Secret Key: SAXXXX
   ```

2. Fund the new public key with sufficient XLM for transaction fees:

   ```bash
   # On testnet, use FriendBot: https://laboratory.stellar.org/#account-creator
   ```

3. Migrate existing escrow balances to the new hot wallet:
   - Coordinate with the smart contract maintainer to authorize the new key
   - Use `soroban contract` to invoke a contract migration or key rotation function (if available)
   - Verify all existing account balances are accessible from the new key

4. Update `STELLAR_HOT_WALLET_SECRET` and `HOT_WALLET_PUBLIC_KEY` in your secret manager

5. Update the payout worker configuration to use the new keys and restart:

   ```bash
   # Deploy apps/deposit-monitor and any payout background jobs
   ```

6. Run a test payout to verify the new key works:

   ```bash
   # Trigger a small manual payout and verify it broadcasts to Stellar
   ```

7. Verify no pending payouts are orphaned (check the payout queue)

8. Monitor Stellar payouts for 24 hours to ensure transactions continue to broadcast

**Rollback:** If the new key fails and you have pending payouts, immediately revert to the old key, restore the previous public key configuration, and investigate the root cause before trying again.

---

### GOOGLE_CLIENT_SECRET

OAuth 2.0 client secret issued by Google Cloud Console. Used for user authentication via Google.

**Services:** `apps/api/src/services/google-auth.ts`, `apps/web`

**Steps:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and navigate to the OAuth 2.0 credentials

2. Click on the BrandBlitz OAuth client ID and generate a new secret:
   - Credentials > OAuth 2.0 Client IDs > Edit > Generate new secret

3. Copy the new secret (Google does not display it again)

4. Update `GOOGLE_CLIENT_SECRET` in your secret manager

5. Redeploy `apps/api` and `apps/web`:

   ```bash
   # Trigger a full deployment of both services
   ```

6. Delete the old secret in Google Cloud Console (to prevent accidental reuse)

7. Monitor authentication logs for errors:

   ```bash
   # Check for "invalid_client" or credential mismatch errors
   tail -f logs/api.log | grep -i google
   ```

**Rollback:** If Google auth stops working, Google Cloud Console allows you to quickly add back the old secret within 24 hours. Revert the env var and redeploy.

---

### WEBHOOK_SECRET

Shared HMAC secret for authenticating incoming webhooks from the Stellar listener and Next.js revalidation requests.

**Services:** `apps/api/src/middleware/webhook.ts`, deposit listener, revalidation API

**Steps:**

1. Generate a new secret:

   ```bash
   openssl rand -hex 32
   ```

2. Update `WEBHOOK_SECRET` in your secret manager

3. Redeploy `apps/api`:

   ```bash
   # API must recognize the new secret for revalidation and listener webhooks
   ```

4. If you manage the Stellar listener or deposit monitor service, update its `WEBHOOK_SECRET` to match and redeploy

5. Test a webhook manually:

   ```bash
   # Send a test webhook with the new secret HMAC-signed
   curl -X POST https://your-api.com/webhooks/deposits \
     -H "Content-Type: application/json" \
     -H "X-Signature: <new-secret-hmac>" \
     -d '{"test": true}'
   ```

6. Monitor for rejected webhooks (408 or signature mismatch errors)

**Rollback:** If webhooks stop being delivered, check the listener service logs for signature validation errors. Revert the secret and redeploy if the listener has not yet been updated.

---

### DATABASE_URL (PostgreSQL Password)

The password embedded in the PostgreSQL connection string. Rotating this requires careful coordination with the database.

**Services:** `apps/api` (all database access)

**Steps:**

1. Connect to your PostgreSQL instance as a superuser:

   ```bash
   psql postgresql://postgres:current_pass@localhost:5432/postgres
   ```

2. Create a new password and update the `brandblitz` role:

   ```sql
   ALTER ROLE brandblitz WITH PASSWORD 'new-secure-password';
   ```

3. Test the connection with the new password from a local client:

   ```bash
   psql postgresql://brandblitz:new-secure-password@localhost:5432/brandblitz -c "SELECT 1"
   ```

4. Update `DATABASE_URL` in your secret manager with the new password:

   ```text
   postgresql://brandblitz:new-secure-password@localhost:5432/brandblitz
   ```

5. Redeploy `apps/api`:

   ```bash
   # API must use the new connection string
   ```

6. Monitor for connection pool errors:

   ```bash
   tail -f logs/api.log | grep -i "connect\|pool"
   ```

7. After 5-10 minutes of stable operation, revoke the old password:

   ```sql
   -- If your database doesn't support multiple passwords, the new one takes effect immediately
   ```

**Rollback:** If database connections fail, revert `DATABASE_URL` to the old password and redeploy immediately. Investigate connection pool configuration before trying again.

---

### SESSION_INTEGRITY_KEY

HMAC secret used to sign completed game sessions. Payouts verify this signature before broadcasting to Stellar.

**Services:** `apps/api`, payout worker

**Steps:**

1. Generate a new key:

   ```bash
   openssl rand -hex 32
   ```

2. Update `SESSION_INTEGRITY_KEY` in your secret manager

3. Redeploy `apps/api` and any payout worker services:

   ```bash
   # Both must use the same new key to maintain signature verification
   ```

4. Play a test game session and verify the payout processes correctly:

   ```bash
   # Manually trigger a payout for the test session and confirm no "signature verification failed" errors
   ```

5. Monitor payout logs for signature validation failures:

   ```bash
   tail -f logs/payout-worker.log | grep -i signature
   ```

**Rollback:** If payouts fail with "signature invalid" errors, revert both `SESSION_INTEGRITY_KEY` and redeploy both services.

---

### PHONE_HASH_SALT

Salt for hashing phone numbers in the user table. Rotating this breaks all existing phone hashes and requires a migration.

**Services:** `apps/api/src/services/phone.ts`

**Complexity:** VERY HIGH - affects all existing phone verifications

**Steps:**

1. Coordinate with the team to plan a database migration during a maintenance window

2. Generate a new salt:

   ```bash
   openssl rand -hex 32
   ```

3. Create a database migration to:
   - Add a `phone_hash_v2` column
   - Re-hash all existing phone numbers using the new salt (in a transaction)
   - Migrate `phone_hash` to `phone_hash_v2`
   - Drop the old `phone_hash` column

   Example migration:

   ```sql
   BEGIN;
   ALTER TABLE users ADD COLUMN phone_hash_v2 VARCHAR(255);
   UPDATE users SET phone_hash_v2 = encode(
     hmac(phone_hash, 'new-salt', 'sha256'), 'hex'
   ) WHERE phone_hash IS NOT NULL;
   ALTER TABLE users DROP COLUMN phone_hash;
   ALTER TABLE users RENAME COLUMN phone_hash_v2 TO phone_hash;
   COMMIT;
   ```

4. Update `PHONE_HASH_SALT` in your secret manager

5. Redeploy `apps/api`

6. During the next user phone verification, the new salt is used

7. Monitor phone verification for failures

**Rollback:** This rotation is very difficult to roll back. If failures occur, you must revert the migration and the old salt simultaneously.

---

### TWILIO_AUTH_TOKEN

Authentication token for Twilio SMS verification service. Obtained from Twilio Console.

**Services:** `apps/api/src/services/phone.ts`

**Steps:**

1. Log in to [Twilio Console](https://www.twilio.com/console)

2. Navigate to Account > API Keys & Tokens > API Keys

3. Create a new API key and copy the token (Twilio does not display it again)

4. Update `TWILIO_AUTH_TOKEN` in your secret manager

5. Redeploy `apps/api`:

   ```bash
   # API must authenticate with Twilio using the new token
   ```

6. Test phone verification:

   ```bash
   # Trigger a phone verification flow and confirm the SMS is sent
   ```

7. In Twilio Console, revoke the old API key after confirming the new one works

8. Monitor for Twilio auth failures:

   ```bash
   tail -f logs/api.log | grep -i twilio
   ```

**Rollback:** In Twilio Console, add back the old API key temporarily and revert the env var.

---

## Post-Rotation Verification

After each rotation:

- [ ] Check service logs for auth/validation errors (10-15 minutes post-deployment)
- [ ] Verify dependent services are not showing increased error rates
- [ ] Test the affected feature end-to-end (e.g., user login for JWT, phone verification for TWILIO_AUTH_TOKEN)
- [ ] Confirm monitoring alerts are not firing
- [ ] Update your password manager with the new secret (if applicable)
- [ ] Document the rotation date and time in your change log

## Monitoring

Monitor these logs and metrics during and after rotation:

- **API logs:** `tail -f apps/api/logs.log`
- **Payout logs:** `tail -f apps/deposit-monitor/logs.log`
- **Error rates:** Check your monitoring dashboard for increased error rates
- **Authentication failures:** Filter logs for "Unauthorized", "invalid_signature", "invalid_client"
- **Webhook rejections:** Search logs for "signature mismatch" or "unauthorized webhook"

## Emergency Procedure

If a secret is **known to be compromised:**

1. Immediately update the secret in your secret manager
2. Trigger an emergency deployment of all affected services
3. If a database password is compromised, revoke all old passwords immediately (do not wait for gradual rotation)
4. For Stellar key compromise, rotate the hot wallet and freeze existing balances if possible (coordinate with the contract)
5. Post-incident, review logs for unauthorized activity during the compromise window

## Questions?

Contact the security team or file an issue in the BrandBlitz repo with the `security` label for questions about rotation procedures.
