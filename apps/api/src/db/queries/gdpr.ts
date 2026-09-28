import { randomUUID } from "crypto";
import { query, pool } from "../index";

export interface GdprErasureRequest {
  id: string;
  user_id: string;
  requested_at: string;
  execute_at: string;
  cancelled_at: string | null;
  executed_at: string | null;
  admin_id: string | null;
  created_at: string;
  updated_at: string;
}

const GRACE_PERIOD_DAYS = 30;

export async function createErasureRequest(
  userId: string,
  adminId?: string
): Promise<GdprErasureRequest> {
  const executeAt = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const result = await query<GdprErasureRequest>(
    `INSERT INTO gdpr_erasure_requests (user_id, execute_at, admin_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, executeAt.toISOString(), adminId ?? null]
  );
  return result.rows[0];
}

export async function findPendingErasureRequest(
  userId: string
): Promise<GdprErasureRequest | null> {
  const result = await query<GdprErasureRequest>(
    `SELECT * FROM gdpr_erasure_requests
     WHERE user_id = $1
       AND cancelled_at IS NULL
       AND executed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find a pending erasure request that was self-initiated (admin_id IS NULL).
 * Used by the self-serve cancel endpoint so users cannot see or interact with
 * admin-initiated legal erasure requests.
 */
export async function findPendingSelfErasureRequest(
  userId: string
): Promise<GdprErasureRequest | null> {
  const result = await query<GdprErasureRequest>(
    `SELECT * FROM gdpr_erasure_requests
     WHERE user_id = $1
       AND admin_id IS NULL
       AND cancelled_at IS NULL
       AND executed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Cancel a self-initiated erasure request (admin_id IS NULL).
 * Admin-initiated requests may only be cancelled through an admin endpoint.
 */
export async function cancelErasureRequest(userId: string): Promise<void> {
  await query(
    `UPDATE gdpr_erasure_requests
     SET cancelled_at = NOW(), updated_at = NOW()
     WHERE user_id = $1
       AND admin_id IS NULL
       AND cancelled_at IS NULL
       AND executed_at IS NULL`,
    [userId]
  );
}

export async function markErasureExecuted(requestId: string): Promise<void> {
  await query(
    `UPDATE gdpr_erasure_requests
     SET executed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [requestId]
  );
}

/**
 * Audit-log action recorded when a user's data has been fully anonymised.
 * Written to `audit_log` as compliance evidence at erasure completion.
 */
export const GDPR_ERASURE_ACTION = "gdpr_erasure_completed";

/**
 * The exhaustive list of `table.column` values cleared by {@link anonymizeUser}.
 * Exposed via `GET /legal/erasure` as a data-subject-facing manifest and written
 * into the completion audit-log entry so compliance can prove what was erased.
 *
 * Note: the server-side device fingerprint is persisted on `game_sessions.device_id`
 * (there is no `device_fingerprint` column in this schema); stored fingerprint hashes
 * live under the `fingerprint` key of the `fraud_flags.details` JSONB blob.
 */
export const GDPR_ERASURE_CLEARED_COLUMNS = [
  "users.email",
  "users.google_id",
  "users.display_name",
  "users.username",
  "users.avatar_url",
  "users.phone_hash",
  "users.phone_verified",
  "users.phone_verified_at",
  "users.stellar_address",
  "users.embedded_wallet_address",
  "game_sessions.device_id",
  "fraud_flags.details.fingerprint",
] as const;

/**
 * Anonymise all PII linked to a user in a single transaction.
 *
 * The users row is retained (not deleted) so FK references from game_sessions and
 * payouts remain valid and financial records are preserved for compliance. Within
 * the same transaction we also:
 *   - null the device fingerprint (`game_sessions.device_id`) on every session,
 *   - strip stored fingerprint hashes from the user's `fraud_flags` rows,
 *   - write completion evidence (timestamp + cleared table.columns) to `audit_log`.
 *
 * Atomicity guarantees the compliance evidence is only recorded if — and only if —
 * every PII field was actually cleared.
 */
export async function anonymizeUser(userId: string): Promise<void> {
  const token = randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE users SET
         email                   = $2,
         google_id               = NULL,
         display_name            = 'Deleted User',
         username                = $3,
         avatar_url              = NULL,
         phone_hash              = NULL,
         phone_verified          = FALSE,
         phone_verified_at       = NULL,
         stellar_address         = NULL,
         embedded_wallet_address = NULL,
         updated_at              = NOW()
       WHERE id = $1`,
      [userId, `deleted_${token}@gdpr.invalid`, `deleted_${token}`]
    );

    // Anonymise the device fingerprint stored on the user's game sessions.
    await client.query(
      `UPDATE game_sessions
         SET device_id = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    // Clear stored fingerprint hashes from the user's fraud flags (kept in details JSONB).
    await client.query(
      `UPDATE fraud_flags
         SET details = details - 'fingerprint', updated_at = NOW()
       WHERE user_id = $1 AND details ? 'fingerprint'`,
      [userId]
    );

    // Compliance evidence: completion timestamp + list of cleared table.columns.
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_key, after)
       VALUES (NULL, $2, 'user', $1, $3)`,
      [
        userId,
        GDPR_ERASURE_ACTION,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          clearedColumns: GDPR_ERASURE_CLEARED_COLUMNS,
        }),
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
