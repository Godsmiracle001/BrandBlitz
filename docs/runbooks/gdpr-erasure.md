# Runbook: GDPR Right-to-Erasure

## Overview

BrandBlitz supports the GDPR right to erasure (Article 17) via a two-step pseudonymisation process. User identity (PII) is wiped, while financial and fraud records are retained for regulatory compliance (Article 17(3)(b)).

---

## How Erasure Works

### Step 1 — Request

The user (or an admin acting on a legal request) initiates deletion:

- **Self-serve:** `POST /me/delete-account` with `{ "email": "<confirmed email>" }`
- **Admin/legal:** `POST /admin/users/:userId/erase` (requires admin role; audit-logged)

Both endpoints return `202 Accepted` with an `executeAt` timestamp 30 days in the future.

A row is inserted into `gdpr_erasure_requests` and a BullMQ job is enqueued with a 30-day delay (`jobId: gdpr:<userId>`).

### Step 2 — Grace period (30 days)

During the grace window the user can cancel:

```http
DELETE /me/delete-account
```

This sets `cancelled_at` on the request row and removes the pending BullMQ job.

### Step 3 — Anonymisation

After 30 days the `gdpr-erasure` BullMQ worker fires and:

1. Confirms the request is still pending (not cancelled, not already executed).
2. Calls `anonymizeUser(userId)` which nulls / randomises all PII columns:
   - `email` → `deleted_<uuid>@gdpr.invalid`
   - `display_name` → `Deleted User`
   - `username` → `deleted_<uuid>`
   - `phone_hash`, `avatar_url`, `google_id`, `stellar_address`, `embedded_wallet_address`, `muxed_id` → `NULL`
3. Calls `revokeAllUserRefreshTokens(userId)` to invalidate all active sessions.
4. Sets `executed_at` on the request row.

**The user row is NOT deleted.** It acts as an anonymised shell so that `game_sessions` and `payouts` retain their foreign-key linkage for financial/regulatory record-keeping.

---

## Hard-Deleting a User (DBA-only)

If a full row deletion is required (e.g., test data cleanup or a court order):

1. **Delete fraud flags first** — `fraud_flags.user_id` has `ON DELETE RESTRICT`. Deleting a user with open fraud flags will fail until they are removed:

   ```sql
   DELETE FROM fraud_flags WHERE user_id = '<userId>';
   ```

2. **Delete the user row:**

   ```sql
   DELETE FROM users WHERE id = '<userId>';
   ```

3. After deletion:
   - `game_sessions.user_id` → `NULL` (SET NULL)
   - `payouts.user_id` → `NULL` (SET NULL)
   - Brands, league assignments, badges, referrals → cascade-deleted

---

## Relevant Database Objects

| Object | Purpose |
| --- | --- |
| `gdpr_erasure_requests` | Tracks pending / cancelled / executed erasure requests |
| `gdpr_erasure_requests.execute_at` | Timestamp when anonymisation fires |
| `gdpr_erasure_requests.cancelled_at` | Set when user cancels within grace window |
| `gdpr_erasure_requests.executed_at` | Set after successful anonymisation |
| `gdpr_erasure_requests.admin_id` | Non-null for admin-initiated requests |
| BullMQ queue `gdpr-erasure` | Delayed jobs (`gdpr:<userId>`) fired after 30 days |

---

## Monitoring

Check pending requests:

```sql
SELECT id, user_id, execute_at, cancelled_at, executed_at
FROM gdpr_erasure_requests
WHERE cancelled_at IS NULL
ORDER BY execute_at;
```

Check failed BullMQ jobs in the `gdpr-erasure` queue via the Bull dashboard or Redis:

```bash
KEYS gdpr:*
```

---

## Failure Recovery

If a BullMQ job fails after all retries (3 attempts with exponential backoff):

1. Identify the `requestId` from the `gdpr_erasure_requests` row.
2. Manually re-run anonymisation:

   ```sql
   -- Verify the request is still pending
   SELECT * FROM gdpr_erasure_requests WHERE id = '<requestId>';
   ```

3. Run the anonymisation SQL directly if the worker cannot be restarted:

   ```sql
   UPDATE users SET
     email                   = 'deleted_' || gen_random_uuid()::text || '@gdpr.invalid',
     google_id               = NULL,
     display_name            = 'Deleted User',
     username                = 'deleted_' || gen_random_uuid()::text,
     avatar_url              = NULL,
     phone_hash              = NULL,
     phone_verified          = FALSE,
     phone_verified_at       = NULL,
     stellar_address         = NULL,
     embedded_wallet_address = NULL,
     muxed_id                = NULL,
     updated_at              = NOW()
   WHERE id = '<userId>';

   UPDATE gdpr_erasure_requests
   SET executed_at = NOW(), updated_at = NOW()
   WHERE id = '<requestId>';
   ```

---

## See Also

- Issue #142 — GDPR right-to-erasure implementation
- Issue #103 — FK ON DELETE audit (ensures financial records survive user deletion)
- `apps/api/src/db/queries/gdpr.ts` — DB query layer
- `apps/api/src/queues/gdpr-erasure.queue.ts` — BullMQ queue
- `apps/api/src/queues/processors/gdpr-erasure.processor.ts` — Worker logic
