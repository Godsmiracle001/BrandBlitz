import { query } from "../index";
import { usdcToStroops } from "../../lib/usdc";
import { encodeCursor, buildCursorWhereSimple, decodeCursorSafe } from "../pagination";

export type ChallengeStatus =
  | "pending_deposit"
  | "active"
  | "ended"
  | "settled"
  | "payout_failed"
  | "cancelled"
  | "refunded";

export interface Challenge {
  id: string;
  brand_id: string;
  challenge_id: string;
  deposit_memo?: string | null;
  pool_amount_stroops: string;
  pool_amount_usdc: string;
  participant_count?: number;
  brand_name?: string;
  logo_url?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  status: ChallengeStatus;
  deposit_tx_hash: string | null;
  deposit_confirmations: number;
  payout_tx_hashes: string[] | null;
  max_players: number | null;
  starts_at: string;
  ends_at: string | null;
  reported_count: number;
  deleted_at: string | null;
  created_at: string;
  challenge_license_id?: string | null;
}

export interface ChallengeQuestion {
  id: string;
  challenge_id: string;
  round: 1 | 2 | 3;
  question_type: "which_brand" | "which_tagline" | "which_product";
  prompt_type: "logo" | "productImage1" | "tagline";
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: "A" | "B" | "C" | "D";
}

export async function createChallenge(data: {
  brandId: string;
  challengeId: string;
  depositMemo?: string;
  poolAmountUsdc: string;
  maxPlayers?: number;
  endsAt?: string;
  licenseId?: string;
}): Promise<Challenge> {
  const result = await query<Challenge>(
    `INSERT INTO challenges
       (brand_id, challenge_id, deposit_memo, pool_amount_stroops, max_players, ends_at,
        challenge_license_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *, (pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc`,
    [
      data.brandId,
      data.challengeId,
      data.depositMemo ?? data.challengeId,
      usdcToStroops(data.poolAmountUsdc),
      data.maxPlayers ?? null,
      data.endsAt ?? null,
      data.licenseId ?? null,
    ]
  );
  return result.rows[0];
}

export async function getChallengeByMemo(challengeId: string): Promise<Challenge | null> {
  const result = await query<Challenge>(
    "SELECT *, (pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc FROM challenges WHERE deposit_memo = $1 AND deleted_at IS NULL",
    [challengeId]
  );
  return result.rows[0] ?? null;
}

export async function getChallengeByDepositTxHash(txHash: string): Promise<Challenge | null> {
  const result = await query<Challenge>(
    "SELECT *, (pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc FROM challenges WHERE deposit_tx_hash = $1 AND deleted_at IS NULL LIMIT 1",
    [txHash]
  );
  return result.rows[0] ?? null;
}

export async function getChallengeById(id: string): Promise<Challenge | null> {
  const result = await query<Challenge>(
    "SELECT *, (pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc FROM challenges WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getArchivedChallengeById(id: string): Promise<Challenge | null> {
  const result = await query<Challenge>("SELECT * FROM challenges_archive WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function getChallengeByIdAny(
  id: string
): Promise<(Challenge & { archived: boolean }) | null> {
  const result = await query<Challenge & { archived: boolean }>(
    `SELECT *, false AS archived FROM challenges WHERE id = $1 AND deleted_at IS NULL
     UNION ALL
     SELECT *, true AS archived FROM challenges_archive WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getActiveChallengesCursor(
  cursor?: string,
  limit = 20
): Promise<{ challenges: Challenge[]; nextCursor: string | null }> {
  const result = await query<Challenge>(
    `SELECT c.*, (c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc,
            b.name as brand_name, b.logo_url, b.primary_color, b.secondary_color
     FROM challenges c
     JOIN brands b ON c.brand_id = b.id
     WHERE c.status = 'active' AND c.deleted_at IS NULL AND b.deleted_at IS NULL
       AND ($1::uuid IS NULL OR c.id > $1::uuid)
     ORDER BY c.id
     LIMIT $2`,
    [cursor ?? null, limit + 1]
  );

  const hasMore = result.rows.length > limit;
  const challenges = result.rows.slice(0, limit);
  const nextCursor = challenges.length > 0 ? challenges[challenges.length - 1].id : null;

  return { challenges, nextCursor: hasMore ? nextCursor : null };
}

export async function getActiveChallenges(
  limit = 20,
  cursor?: string
): Promise<{ challenges: Challenge[]; nextCursor: string | null }> {
  const cursorValues = decodeCursorSafe(cursor, ["pool_amount_stroops", "id"]);

  let whereExtra = "";
  const params: unknown[] = [];

  if (cursorValues) {
    const { clause } = buildCursorWhereSimple(
      "c.pool_amount_stroops",
      "DESC",
      cursorValues.pool_amount_stroops,
      cursorValues.id as string,
      3
    );
    whereExtra = clause;
    params.push(cursorValues.pool_amount_stroops, cursorValues.id);
  }

  params.push(limit);
  const result = await query<Challenge>(
    `SELECT c.*, (c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc,
            b.name as brand_name, b.logo_url, b.primary_color, b.secondary_color
     FROM challenges c
     JOIN brands b ON c.brand_id = b.id
     WHERE c.status = 'active' AND c.deleted_at IS NULL AND b.deleted_at IS NULL
     ${whereExtra}
     ORDER BY c.pool_amount_stroops DESC, c.id DESC
     LIMIT $${params.length}`,
    params
  );

  const challenges = result.rows;
  const nextCursor: string | null =
    challenges.length === limit
      ? encodeCursor({
          pool_amount_stroops: challenges[challenges.length - 1].pool_amount_stroops,
          id: challenges[challenges.length - 1].id,
        })
      : null;

  return { challenges, nextCursor };
}

export async function getFilteredChallenges(opts: {
  status?: "active" | "upcoming" | "ended";
  minPoolUsdc?: number;
  endBefore?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ challenges: Challenge[]; nextCursor: string | null }> {
  const { status, minPoolUsdc, endBefore, cursor, limit = 20 } = opts;

  const conditions: string[] = ["c.deleted_at IS NULL", "b.deleted_at IS NULL"];
  const params: unknown[] = [];

  if (status === "active") {
    conditions.push("c.status = 'active'");
  } else if (status === "upcoming") {
    conditions.push("c.status = 'pending_deposit'");
  } else if (status === "ended") {
    conditions.push("c.status IN ('ended', 'settled', 'payout_failed', 'cancelled', 'refunded')");
  } else {
    conditions.push(
      "c.status IN ('active', 'pending_deposit', 'ended', 'settled', 'payout_failed', 'cancelled', 'refunded')"
    );
  }

  if (minPoolUsdc !== undefined) {
    params.push(String(Math.round(minPoolUsdc * 10_000_000)));
    conditions.push(`c.pool_amount_stroops >= $${params.length}`);
  }

  if (endBefore) {
    params.push(endBefore);
    conditions.push(`c.ends_at < $${params.length}`);
  }

  if (cursor) {
    params.push(cursor);
    conditions.push(`c.id > $${params.length}::uuid`);
  }

  params.push(limit + 1);

  const result = await query<Challenge>(
    `SELECT c.*, (c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc,
            b.name AS brand_name, b.logo_url, b.primary_color, b.secondary_color
     FROM challenges c
     JOIN brands b ON c.brand_id = b.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.pool_amount_stroops DESC, c.id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const challenges = result.rows.slice(0, limit);
  const nextCursor = hasMore && challenges.length > 0 ? challenges[challenges.length - 1].id : null;
  return { challenges, nextCursor };
}

export async function getChallengesByBrandId(
  brandId: string,
  limit = 20,
  cursor?: string
): Promise<{ challenges: Challenge[]; nextCursor: string | null }> {
  const cursorValues = decodeCursorSafe(cursor, ["created_at", "id"]);

  let whereExtra = "";
  const params: unknown[] = [brandId];

  if (cursorValues) {
    const { clause, params: cursorParams } = buildCursorWhereSimple(
      "c.created_at",
      "DESC",
      cursorValues.created_at,
      cursorValues.id as string,
      3
    );
    whereExtra = clause;
    params.push(cursorValues.created_at, cursorValues.id);
  }

  params.push(limit);

  const result = await query<Challenge>(
    `SELECT c.*, (c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc,
            b.name as brand_name, b.logo_url, b.primary_color, b.secondary_color
     FROM challenges c
     JOIN brands b ON c.brand_id = b.id
     WHERE c.brand_id = $1 AND c.deleted_at IS NULL
     ${whereExtra}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${params.length}`,
    params
  );

  const challenges = result.rows;
  const nextCursor: string | null =
    challenges.length === limit
      ? encodeCursor({
          created_at: challenges[challenges.length - 1].created_at,
          id: challenges[challenges.length - 1].id,
        })
      : null;

  return { challenges, nextCursor };
}
export type ActiveChallengesSort = "pool_desc" | "pool_asc" | "newest" | "ending_soon";

export interface ActiveChallengeSortedRow {
  id: string;
  brand_id: string;
  title: string | null;
  pool_amount_usdc: string;
  ends_at: string | null;
  participant_count: number;
  brand_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  // cursor fields kept for internal use
  pool_amount_stroops: string;
  created_at: string;
}

const SORT_CONFIG: Record<
  ActiveChallengesSort,
  { orderBy: string; cursorKeys: [string, string]; cursorDir: "ASC" | "DESC" }
> = {
  pool_desc: {
    orderBy: "c.pool_amount_stroops DESC, c.id DESC",
    cursorKeys: ["pool_amount_stroops", "id"],
    cursorDir: "DESC",
  },
  pool_asc: {
    orderBy: "c.pool_amount_stroops ASC, c.id ASC",
    cursorKeys: ["pool_amount_stroops", "id"],
    cursorDir: "ASC",
  },
  newest: {
    orderBy: "c.created_at DESC, c.id DESC",
    cursorKeys: ["created_at", "id"],
    cursorDir: "DESC",
  },
  ending_soon: {
    orderBy: "c.ends_at ASC NULLS LAST, c.id ASC",
    cursorKeys: ["ends_at", "id"],
    cursorDir: "ASC",
  },
};

/**
 * Get active challenges sorted by one of four modes with cursor pagination.
 *
 * Sort modes:
 *   pool_desc    — highest reward pool first (default)
 *   pool_asc     — lowest reward pool first
 *   newest       — most recently created first
 *   ending_soon  — soonest end time first (NULLs last)
 */
export async function getActiveChallengesSorted(opts: {
  sort?: ActiveChallengesSort;
  cursor?: string;
  limit?: number;
}): Promise<{ items: ActiveChallengeSortedRow[]; nextCursor: string | null }> {
  const { sort = "pool_desc", cursor, limit = 20 } = opts;
  const cfg = SORT_CONFIG[sort];
  const [primaryKey, secondaryKey] = cfg.cursorKeys;
  const dir = cfg.cursorDir === "DESC" ? "<" : ">";
  const oppDir = cfg.cursorDir === "DESC" ? "DESC" : "ASC";

  const params: unknown[] = [];
  let cursorClause = "";

  if (cursor) {
    const decoded = decodeCursorSafe(cursor, [primaryKey, secondaryKey]);
    if (decoded !== null) {
      const primaryVal = decoded[primaryKey];
      const secondaryVal = decoded[secondaryKey];
      params.push(primaryVal, secondaryVal);

      if (sort === "ending_soon") {
        // ends_at can be NULL (sorted NULLS LAST); rows with NULL ends_at always come after non-null ones
        cursorClause = `AND (
          c.ends_at IS NOT NULL AND (
            c.ends_at ${dir} $1
            OR (c.ends_at = $1 AND c.id ${dir} $2::uuid)
          )
          OR (c.ends_at IS NULL AND $1::timestamptz IS NULL AND c.id ${dir} $2::uuid)
        )`;
      } else {
        cursorClause = `AND (
          c.${primaryKey} ${dir} $1
          OR (c.${primaryKey} = $1 AND c.id ${dir} $2::uuid)
        )`;
      }
    }
  }

  params.push(limit + 1);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT
      c.id,
      c.brand_id,
      c.challenge_id AS title,
      (c.pool_amount_stroops::numeric / 10000000)::numeric(20,7)::text AS pool_amount_usdc,
      c.ends_at,
      c.participant_count,
      c.pool_amount_stroops::text AS pool_amount_stroops,
      c.created_at,
      b.name  AS brand_name,
      b.logo_url,
      b.primary_color,
      b.secondary_color
    FROM challenges c
    JOIN brands b ON c.brand_id = b.id
    WHERE c.status = 'active'
      AND c.deleted_at IS NULL
      AND b.deleted_at IS NULL
      ${cursorClause}
    ORDER BY ${cfg.orderBy}
    LIMIT ${limitParam}
  `;

  const result = await query<ActiveChallengeSortedRow>(sql, params);

  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      [primaryKey]: last[primaryKey as keyof ActiveChallengeSortedRow],
      id: last.id,
    });
  }

  return { items, nextCursor };
}

/**
 * Soft-delete a challenge.
 */
export async function softDeleteChallenge(id: string): Promise<void> {
  await query(
    "UPDATE challenges SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
}

/**
 * Restore a soft-deleted challenge.
 */
export async function restoreChallenge(id: string): Promise<void> {
  await query("UPDATE challenges SET deleted_at = NULL, updated_at = NOW() WHERE id = $1", [id]);
}

export async function updateChallengeStatus(
  id: string,
  status: ChallengeStatus,
  extras?: { depositTx?: string; payoutTxHashes?: string[] }
): Promise<void> {
  if (extras?.depositTx) {
    await query("UPDATE challenges SET status = $1, deposit_tx_hash = $2 WHERE id = $3", [
      status,
      extras.depositTx,
      id,
    ]);
  } else if (extras?.payoutTxHashes) {
    await query("UPDATE challenges SET status = $1, payout_tx_hashes = $2 WHERE id = $3", [
      status,
      extras.payoutTxHashes,
      id,
    ]);
  } else {
    await query("UPDATE challenges SET status = $1 WHERE id = $2", [status, id]);
  }

  try {
    const res = await query<{ brand_id: string }>(
      "SELECT brand_id FROM challenges WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    if (res.rows[0]?.brand_id) {
      const { dispatchBrandWebhookEvent } = await import("../../services/brand-webhooks");
      void dispatchBrandWebhookEvent(res.rows[0].brand_id, id, status, extras);
    }
  } catch {
    // Ignore webhook dispatch lookup errors so status update never fails
  }
}

export async function insertChallengeQuestions(
  questions: Omit<ChallengeQuestion, "id">[]
): Promise<void> {
  for (const q of questions) {
    await query(
      `INSERT INTO challenge_questions
         (challenge_id, round, question_type, prompt_type, question_text,
          option_a, option_b, option_c, option_d, correct_option)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        q.challenge_id,
        q.round,
        q.question_type,
        q.prompt_type,
        q.question_text,
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
        q.correct_option,
      ]
    );
  }
}

export async function getChallengeQuestions(challengeId: string): Promise<ChallengeQuestion[]> {
  const result = await query<ChallengeQuestion>(
    "SELECT * FROM challenge_questions WHERE challenge_id = $1 ORDER BY round",
    [challengeId]
  );
  return result.rows;
}

export async function deleteChallengeQuestion(questionId: string): Promise<void> {
  await query("DELETE FROM challenge_questions WHERE id = $1", [questionId]);
}

export async function insertChallengeQuestion(
  question: Omit<ChallengeQuestion, "id">
): Promise<ChallengeQuestion> {
  const result = await query<ChallengeQuestion>(
    `INSERT INTO challenge_questions
       (challenge_id, round, question_type, prompt_type, question_text,
        option_a, option_b, option_c, option_d, correct_option)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      question.challenge_id,
      question.round,
      question.question_type,
      question.prompt_type,
      question.question_text,
      question.option_a,
      question.option_b,
      question.option_c,
      question.option_d,
      question.correct_option,
    ]
  );
  return result.rows[0];
}

/**
 * Increment deposit confirmations for a challenge.
 * Returns the updated confirmation count.
 * If confirmations reach required threshold, transitions to active status.
 */
export async function incrementDepositConfirmations(
  challengeId: string,
  requiredConfirmations: number
): Promise<{ confirmations: number; activated: boolean }> {
  const result = await query<{
    deposit_confirmations: number;
    status: ChallengeStatus;
  }>(
    `UPDATE challenges
     SET deposit_confirmations = LEAST(deposit_confirmations + 1, $2),
         status = CASE 
           WHEN (deposit_confirmations + 1) >= $2 AND status = 'pending_deposit'
             THEN 'active'
           ELSE status
         END,
         updated_at = NOW()
     WHERE id = $1 AND status IN ('pending_deposit', 'active')
     RETURNING deposit_confirmations, status`,
    [challengeId, requiredConfirmations]
  );

  if (!result.rows[0]) {
    throw new Error(`Challenge ${challengeId} not found or not in pending/active status`);
  }

  const { deposit_confirmations, status } = result.rows[0];
  return {
    confirmations: deposit_confirmations,
    activated: status === "active" && deposit_confirmations >= requiredConfirmations,
  };
}

/**
 * Get current deposit confirmation count for a challenge.
 */
export async function getDepositConfirmations(challengeId: string): Promise<number | null> {
  const result = await query<{ deposit_confirmations: number }>(
    "SELECT deposit_confirmations FROM challenges WHERE id = $1 AND deleted_at IS NULL AND status IN ('pending_deposit', 'active')",
    [challengeId]
  );
  return result.rows[0]?.deposit_confirmations ?? null;
}
