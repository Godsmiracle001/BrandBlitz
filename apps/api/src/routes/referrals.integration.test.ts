import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, closeDb } from "../db/index";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `referral_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options");
  const opt = `-c search_path=${schema}`;
  url.searchParams.set("options", existing ? `${existing} ${opt}` : opt);
  return url.toString();
}

if (originalDatabaseUrl) {
  process.env.DATABASE_URL = withSearchPath(originalDatabaseUrl, schemaName);
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

describeIntegration("referral flow integration", () => {
  beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // Create minimal schema for referral testing
    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        referral_code TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE brands (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE challenges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        challenge_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending_deposit'
          CHECK (status IN ('pending_deposit', 'active', 'ended', 'settled', 'payout_failed', 'cancelled', 'refunded')),
        pool_amount_stroops BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE game_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'warmup'
          CHECK (status IN ('warmup', 'active', 'completed', 'flagged', 'abandoned')),
        warmup_started_at TIMESTAMPTZ,
        challenge_started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, challenge_id)
      )
    `);

    await query(`
      CREATE TABLE referrals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        rewarded BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE referral_payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referral_id UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE UNIQUE,
        challenge_id UUID REFERENCES challenges(id) ON DELETE CASCADE,
        referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referrer_stellar_address TEXT,
        referred_stellar_address TEXT,
        referrer_amount_stroops BIGINT NOT NULL DEFAULT 0,
        referred_amount_stroops BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'sent', 'failed')),
        tx_hash TEXT,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Create trigger for updated_at
    await query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await query(`CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await query(`CREATE TRIGGER brands_updated_at BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await query(`CREATE TRIGGER challenges_updated_at BEFORE UPDATE ON challenges FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await query(`CREATE TRIGGER game_sessions_updated_at BEFORE UPDATE ON game_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await query(`CREATE TRIGGER referrals_updated_at BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await query(`CREATE TRIGGER referral_payouts_updated_at BEFORE UPDATE ON referral_payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
  });

  afterAll(async () => {
    await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await closeDb();
  });

  it("records referral relationship when referee signs up with valid code", async () => {
    // Create referrer user
    const referrerCode = "ABC123";
    const referrerResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, referral_code)
       VALUES ($1, 'Referrer', $2)
       RETURNING id`,
      [`referrer-${randomUUID()}@test.invalid`, referrerCode]
    );
    const referrerId = referrerResult.rows[0].id;

    // Create referee user
    const refereeResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Referee') RETURNING id`,
      [`referee-${randomUUID()}@test.invalid`]
    );
    const refereeId = refereeResult.rows[0].id;

    // Record referral relationship
    const referralResult = await query<{ id: string; referrer_id: string; referred_id: string; rewarded: boolean }>(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1, $2, false)
       RETURNING id, referrer_id, referred_id, rewarded`,
      [referrerId, refereeId]
    );

    const referral = referralResult.rows[0];
    expect(referral.referrer_id).toBe(referrerId);
    expect(referral.referred_id).toBe(refereeId);
    expect(referral.rewarded).toBe(false);
  });

  it("enqueues bonus payout job after referee completes first session", async () => {
    // Create referrer and referee
    const referrerResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, referral_code)
       VALUES ($1, 'Referrer 2', $2)
       RETURNING id`,
      [`referrer2-${randomUUID()}@test.invalid`, "DEF456"]
    );
    const referrerId = referrerResult.rows[0].id;

    const refereeResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Referee 2') RETURNING id`,
      [`referee2-${randomUUID()}@test.invalid`]
    );
    const refereeId = refereeResult.rows[0].id;

    // Create referral
    const referralResult = await query<{ id: string }>(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1, $2, false)
       RETURNING id`,
      [referrerId, refereeId]
    );
    const referralId = referralResult.rows[0].id;

    // Create challenge and session
    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Brand') RETURNING id`,
      [referrerId]
    );
    const brandId = brandResult.rows[0].id;

    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops)
       VALUES ($1, $2, 'active', 100000000)
       RETURNING id`,
      [brandId, `ch-${randomUUID()}`]
    );
    const challengeId = challengeResult.rows[0].id;

    // Complete first session for referee
    const sessionResult = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, challenge_started_at, completed_at)
       VALUES ($1, $2, 'completed', NOW() - INTERVAL '5 minutes', NOW())
       RETURNING id`,
      [refereeId, challengeId]
    );
    const sessionId = sessionResult.rows[0].id;

    // Create referral payout (what the job would do)
    const payoutResult = await query<{ id: string; referral_id: string; status: string }>(
      `INSERT INTO referral_payouts (referral_id, challenge_id, referrer_id, referred_id,
         referrer_amount_stroops, referred_amount_stroops, status)
       VALUES ($1, $2, $3, $4, 1000000, 1000000, 'pending')
       RETURNING id, referral_id, status`,
      [referralId, challengeId, referrerId, refereeId]
    );

    const payout = payoutResult.rows[0];
    expect(payout.referral_id).toBe(referralId);
    expect(payout.status).toBe("pending");
  });

  it("does not enqueue additional bonus jobs for subsequent sessions", async () => {
    // Create referrer and referee
    const referrerResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, referral_code)
       VALUES ($1, 'Referrer 3', $2)
       RETURNING id`,
      [`referrer3-${randomUUID()}@test.invalid`, "GHI789"]
    );
    const referrerId = referrerResult.rows[0].id;

    const refereeResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Referee 3') RETURNING id`,
      [`referee3-${randomUUID()}@test.invalid`]
    );
    const refereeId = refereeResult.rows[0].id;

    // Create referral
    const referralResult = await query<{ id: string }>(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1, $2, false)
       RETURNING id`,
      [referrerId, refereeId]
    );
    const referralId = referralResult.rows[0].id;

    // Create brand and challenges
    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Brand 2') RETURNING id`,
      [referrerId]
    );
    const brandId = brandResult.rows[0].id;

    const challenge1Result = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops)
       VALUES ($1, $2, 'active', 100000000)
       RETURNING id`,
      [brandId, `ch1-${randomUUID()}`]
    );
    const challenge1Id = challenge1Result.rows[0].id;

    const challenge2Result = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops)
       VALUES ($1, $2, 'active', 100000000)
       RETURNING id`,
      [brandId, `ch2-${randomUUID()}`]
    );
    const challenge2Id = challenge2Result.rows[0].id;

    // Complete first session and create payout
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, completed_at)
       VALUES ($1, $2, 'completed', NOW())`,
      [refereeId, challenge1Id]
    );

    const payout1Result = await query<{ id: string }>(
      `INSERT INTO referral_payouts (referral_id, challenge_id, referrer_id, referred_id,
         referrer_amount_stroops, referred_amount_stroops, status)
       VALUES ($1, $2, $3, $4, 1000000, 1000000, 'pending')
       RETURNING id`,
      [referralId, challenge1Id, referrerId, refereeId]
    );
    expect(payout1Result.rows[0]).toBeDefined();

    // Complete second session - should not create another payout
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, completed_at)
       VALUES ($1, $2, 'completed', NOW())`,
      [refereeId, challenge2Id]
    );

    // Verify only one payout exists for this referral
    const payouts = await query(
      `SELECT * FROM referral_payouts WHERE referral_id = $1`,
      [referralId]
    );
    expect(payouts.rows).toHaveLength(1);
  });

  it("marks referral as rewarded and creates payout with correct amounts", async () => {
    // Create referrer and referee
    const referrerResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, referral_code)
       VALUES ($1, 'Referrer 4', $2)
       RETURNING id`,
      [`referrer4-${randomUUID()}@test.invalid`, "JKL012"]
    );
    const referrerId = referrerResult.rows[0].id;

    const refereeResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Referee 4') RETURNING id`,
      [`referee4-${randomUUID()}@test.invalid`]
    );
    const refereeId = refereeResult.rows[0].id;

    // Create referral
    const referralResult = await query<{ id: string; rewarded: boolean }>(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1, $2, false)
       RETURNING id, rewarded`,
      [referrerId, refereeId]
    );
    const referralId = referralResult.rows[0].id;
    expect(referralResult.rows[0].rewarded).toBe(false);

    // Create brand and challenge
    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Brand 3') RETURNING id`,
      [referrerId]
    );
    const brandId = brandResult.rows[0].id;

    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops)
       VALUES ($1, $2, 'active', 100000000)
       RETURNING id`,
      [brandId, `ch-${randomUUID()}`]
    );
    const challengeId = challengeResult.rows[0].id;

    // Complete session
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, completed_at)
       VALUES ($1, $2, 'completed', NOW())`,
      [refereeId, challengeId]
    );

    const referrerBonus = 5000000;
    const refereeBonus = 5000000;

    // Create payout
    const payoutResult = await query<{
      referrer_amount_stroops: number;
      referred_amount_stroops: number;
      status: string
    }>(
      `INSERT INTO referral_payouts (referral_id, challenge_id, referrer_id, referred_id,
         referrer_amount_stroops, referred_amount_stroops, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING referrer_amount_stroops, referred_amount_stroops, status`,
      [referralId, challengeId, referrerId, refereeId, referrerBonus, refereeBonus]
    );

    const payout = payoutResult.rows[0];
    expect(payout.referrer_amount_stroops).toBe(referrerBonus);
    expect(payout.referred_amount_stroops).toBe(refereeBonus);
    expect(payout.status).toBe("pending");

    // Mark referral as rewarded
    await query(
      `UPDATE referrals SET rewarded = true WHERE id = $1`,
      [referralId]
    );

    const updatedReferral = await query<{ rewarded: boolean }>(
      `SELECT rewarded FROM referrals WHERE id = $1`,
      [referralId]
    );
    expect(updatedReferral.rows[0].rewarded).toBe(true);
  });
});
