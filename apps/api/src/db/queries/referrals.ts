import { query } from "../index";

export interface Referral {
  id: string;
  referrer_id: string;
  referred_id: string;
  rewarded: boolean;
  created_at: string;
  updated_at: string;
}

export async function findReferralByReferredId(
  referredId: string,
): Promise<Referral | null> {
  const result = await query<Referral>(
    "SELECT * FROM referrals WHERE referred_id = $1 LIMIT 1",
    [referredId],
  );
  return result.rows[0] ?? null;
}

export async function findReferralByReferrerAndReferred(
  referrerId: string,
  referredId: string,
): Promise<Referral | null> {
  const result = await query<Referral>(
    "SELECT * FROM referrals WHERE referrer_id = $1 AND referred_id = $2 LIMIT 1",
    [referrerId, referredId],
  );
  return result.rows[0] ?? null;
}

export async function createReferral(
  referrerId: string,
  referredId: string,
): Promise<Referral> {
  const result = await query<Referral>(
    `INSERT INTO referrals (referrer_id, referred_id)
     VALUES ($1, $2)
     ON CONFLICT (referred_id) DO UPDATE
       SET updated_at = referrals.updated_at
     RETURNING *`,
    [referrerId, referredId],
  );
  return result.rows[0];
}

export async function markReferralRewarded(referralId: string): Promise<void> {
  await query(
    `UPDATE referrals
     SET rewarded = TRUE,
         updated_at = NOW()
     WHERE id = $1`,
    [referralId],
  );
}

export async function countReferralInvites(
  referrerId: string,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
     FROM referrals r
     JOIN users u ON r.referred_id = u.id
     WHERE r.referrer_id = $1 AND u.deleted_at IS NULL`,
    [referrerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function countReferralConversions(
  referrerId: string,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
     FROM referrals r
     JOIN users u ON r.referred_id = u.id
     WHERE r.referrer_id = $1 AND r.rewarded = TRUE AND u.deleted_at IS NULL`,
    [referrerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getReferralNetworkUserIds(
  userId: string,
): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id
     FROM (
       SELECT referred_id AS user_id
       FROM referrals
       WHERE referrer_id = $1
       UNION
       SELECT referrer_id AS user_id
       FROM referrals
       WHERE referred_id = $1
     ) AS network
     JOIN users u ON network.user_id = u.id
     WHERE u.deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map((r) => r.user_id);
}
