import { query } from "../index";
import { usdcToStroops } from "../../lib/usdc";
import { encodeCursor, buildCursorWhereSimple, decodeCursorSafe } from "../pagination";

export type PayoutStatus = "pending" | "sent" | "confirmed" | "failed";

export interface Payout {
  id: string;
  challenge_id: string;
  user_id: string;
  stellar_address: string;
  amount_stroops: string;
  amount_usdc: string;
  tx_hash: string | null;
  error_message?: string | null;
  status: PayoutStatus;
  created_at: string;
}

export async function createPayout(data: {
  challengeId: string;
  userId: string;
  stellarAddress: string;
  amountStroops?: string | number | bigint;
  amountUsdc?: string;
}): Promise<Payout> {
  if (data.amountStroops === undefined && data.amountUsdc === undefined) {
    throw new Error("Payout amount is required");
  }

  const amountStroops = data.amountStroops?.toString() ?? usdcToStroops(data.amountUsdc!);
  const result = await query<Payout>(
    `INSERT INTO payouts (challenge_id, user_id, stellar_address, amount_stroops)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (challenge_id, user_id) DO UPDATE
       SET stellar_address = EXCLUDED.stellar_address,
           amount_stroops = EXCLUDED.amount_stroops,
           status = CASE
             WHEN payouts.status = 'failed' THEN 'pending'
             ELSE payouts.status
           END,
           error_message = NULL
     RETURNING *, (amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc`,
    [data.challengeId, data.userId, data.stellarAddress, amountStroops]
  );
  return result.rows[0];
}

export async function updatePayoutStatus(
  id: string,
  status: PayoutStatus,
  txHash?: string,
  errorMessage?: string
): Promise<void> {
  if (txHash && errorMessage) {
    await query(
      "UPDATE payouts SET status = $1, tx_hash = $2, error_message = $3 WHERE id = $4",
      [status, txHash, errorMessage, id]
    );
  } else if (txHash) {
    await query(
      "UPDATE payouts SET status = $1, tx_hash = $2 WHERE id = $3",
      [status, txHash, id]
    );
  } else if (errorMessage) {
    await query(
      "UPDATE payouts SET status = $1, error_message = $2 WHERE id = $3",
      [status, errorMessage, id]
    );
  } else {
    await query("UPDATE payouts SET status = $1 WHERE id = $2", [status, id]);
  }
}

export async function failPayoutsForChallenge(
  challengeId: string,
  errorMessage: string
): Promise<void> {
  await query(
    `UPDATE payouts
     SET status = 'failed',
         error_message = $2
     WHERE challenge_id = $1
       AND status IN ('pending', 'processing')`,
    [challengeId, errorMessage]
  );
}

export async function getPendingPayouts(
  challengeId: string,
  limit = 100
): Promise<Payout[]> {
  const result = await query<Payout>(
    "SELECT *, (amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc FROM payouts WHERE challenge_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT $2",
    [challengeId, limit]
  );
  return result.rows;
}

/**
 * Batch fetch payouts by IDs with user data via JOIN.
 * Replaces N+1 SELECT pattern with single batch query.
 */
export async function getPayoutsByIds(payoutIds: string[]): Promise<Payout[]> {
  if (payoutIds.length === 0) return [];
  
  const result = await query<Payout>(
    `SELECT p.*,
            (p.amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc,
            u.stellar_address,
            u.id AS user_id
     FROM payouts p
     JOIN users u ON p.user_id = u.id
     WHERE p.id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], p.id)`,
    [payoutIds]
  );
  return result.rows;
}

export async function findPayoutByTxHash(txHash: string): Promise<Payout | null> {
  const result = await query<Payout>(
    "SELECT *, (amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc FROM payouts WHERE tx_hash = $1 LIMIT 1",
    [txHash]
  );
  return result.rows[0] ?? null;
}

/**
 * Update payout status and fee bump tracking.
 */
export async function updatePayoutFeeBumpStatus(
  payoutId: string,
  status: "fee_bump_pending" | "fee_bump_failed" | "completed",
  feeBumpMaxFee: number,
  originalTxHash?: string
): Promise<void> {
  await query(
    `UPDATE payouts
     SET status = $2,
         fee_bump_attempts = fee_bump_attempts + 1,
         fee_bump_max_fee_stroops = $3,
         original_tx_hash = COALESCE(original_tx_hash, $4),
         updated_at = NOW()
     WHERE id = $1`,
    [payoutId, status, feeBumpMaxFee, originalTxHash]
  );
}

/**
 * Get payouts eligible for fee bump recovery.
 */
export async function getStuckPayouts(limit = 50): Promise<(Payout & { fee_bump_attempts: number })[]> {
  const result = await query<Payout & { fee_bump_attempts: number }>(
    `SELECT *,
            (amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc,
            fee_bump_attempts
     FROM payouts
     WHERE status IN ('failed', 'fee_bump_failed')
       AND fee_bump_attempts < 3
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export interface PayoutDetail extends Payout {
  username: string;
}

export async function getPayouts(opts: {
  status?: string;
  cursor?: string;
  pageSize: number;
}): Promise<{ payouts: PayoutDetail[]; nextCursor: string | null }> {
  const statusParam = opts.status && opts.status !== "all" ? opts.status : null;
  const cursorValues = decodeCursorSafe(opts.cursor, ["created_at", "id"]);

  let whereExtra = "";
  const params: unknown[] = [statusParam];

  if (cursorValues) {
    const { clause, params: cursorParams } = buildCursorWhereSimple(
      "p.created_at",
      "DESC",
      cursorValues.created_at,
      cursorValues.id as string,
      2
    );
    whereExtra = clause;
    params.push(cursorValues.created_at, cursorValues.id);
  }

  params.push(opts.pageSize);

  const result = await query<PayoutDetail>(
    `SELECT
       p.id,
       p.challenge_id,
       p.user_id,
       COALESCE(u.username, u.display_name, 'Unknown') AS username,
       p.stellar_address,
       p.amount_stroops,
       (p.amount_stroops::numeric / 10000000)::numeric(20,7)::text AS amount_usdc,
       p.tx_hash,
       p.status,
       p.error_message,
       p.created_at
     FROM payouts p
     LEFT JOIN users u ON p.user_id = u.id
     WHERE ($1::text IS NULL OR p.status = $1)
     ${whereExtra}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${params.length}`,
    params
  );

  const payouts = result.rows;
  const nextCursor: string | null =
    payouts.length === opts.pageSize
      ? encodeCursor({
          created_at: payouts[payouts.length - 1].created_at,
          id: payouts[payouts.length - 1].id,
        })
      : null;

  return { payouts, nextCursor };
}
