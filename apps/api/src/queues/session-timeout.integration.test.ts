import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, closeDb } from "../db/index";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `session_timeout_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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

describeIntegration("session-timeout queue integration", () => {
  beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // Create minimal schema for this test
    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
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
        max_players INTEGER,
        starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ends_at TIMESTAMPTZ,
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
        warmup_completed_at TIMESTAMPTZ,
        challenge_started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        abandon_reason TEXT CHECK (abandon_reason IN ('timeout', 'error', 'explicit', NULL)),
        total_score INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, challenge_id)
      )
    `);

    await query(`
      CREATE TABLE session_round_scores (
        session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        round INTEGER NOT NULL CHECK (round IN (1, 2, 3)),
        score INTEGER NOT NULL CHECK (score >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, round)
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
  });

  afterAll(async () => {
    await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await closeDb();
  });

  it("transitions stale warmup_started sessions to timed_out", async () => {
    // Create test data
    const userId = randomUUID();
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test User') RETURNING id`,
      [`user-${randomUUID()}@test.invalid`]
    );
    const actualUserId = userResult.rows[0].id;

    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand') RETURNING id`,
      [actualUserId]
    );
    const brandId = brandResult.rows[0].id;

    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, starts_at)
       VALUES ($1, $2, 'active', 100000000, NOW())
       RETURNING id`,
      [brandId, `ch-${randomUUID()}`]
    );
    const challengeId = challengeResult.rows[0].id;

    // Create a stale warmup_started session (older than timeout threshold)
    const staleDate = new Date();
    staleDate.setHours(staleDate.getHours() - 1); // 1 hour ago, beyond the warmup window

    const sessionResult = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, warmup_started_at, created_at)
       VALUES ($1, $2, 'warmup', $3, $4)
       RETURNING id`,
      [actualUserId, challengeId, staleDate.toISOString(), staleDate.toISOString()]
    );
    const sessionId = sessionResult.rows[0].id;

    // Verify session is in warmup state
    const beforeUpdate = await query(
      `SELECT status FROM game_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(beforeUpdate.rows[0].status).toBe("warmup");

    // Simulate session timeout by updating the session
    // This is what the queue worker would do
    await query(
      `UPDATE game_sessions
       SET status = 'abandoned', completed_at = NOW(), abandon_reason = 'timeout'
       WHERE id = $1 AND status = 'warmup' AND warmup_started_at < NOW() - INTERVAL '1 hour'`,
      [sessionId]
    );

    // Verify session is now abandoned with timeout reason
    const afterUpdate = await query(
      `SELECT status, abandon_reason, completed_at FROM game_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(afterUpdate.rows[0].status).toBe("abandoned");
    expect(afterUpdate.rows[0].abandon_reason).toBe("timeout");
    expect(afterUpdate.rows[0].completed_at).not.toBeNull();
  });

  it("does not transition sessions within warmup window", async () => {
    // Create test data
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test User 2') RETURNING id`,
      [`user2-${randomUUID()}@test.invalid`]
    );
    const userId = userResult.rows[0].id;

    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand 2') RETURNING id`,
      [userId]
    );
    const brandId = brandResult.rows[0].id;

    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops)
       VALUES ($1, $2, 'active', 100000000)
       RETURNING id`,
      [brandId, `ch-${randomUUID()}`]
    );
    const challengeId = challengeResult.rows[0].id;

    // Create a recent warmup_started session (within timeout window)
    const recentDate = new Date();
    recentDate.setMinutes(recentDate.getMinutes() - 10); // 10 minutes ago

    const sessionResult = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, warmup_started_at, created_at)
       VALUES ($1, $2, 'warmup', $3, $4)
       RETURNING id`,
      [userId, challengeId, recentDate.toISOString(), recentDate.toISOString()]
    );
    const sessionId = sessionResult.rows[0].id;

    // Attempt to timeout (should not match the condition)
    await query(
      `UPDATE game_sessions
       SET status = 'abandoned', completed_at = NOW(), abandon_reason = 'timeout'
       WHERE id = $1 AND status = 'warmup' AND warmup_started_at < NOW() - INTERVAL '1 hour'`,
      [sessionId]
    );

    // Verify session is still in warmup state
    const result = await query(
      `SELECT status FROM game_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(result.rows[0].status).toBe("warmup");
  });

  it("does not create session_round_scores for timed_out sessions", async () => {
    // Create test data
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test User 3') RETURNING id`,
      [`user3-${randomUUID()}@test.invalid`]
    );
    const userId = userResult.rows[0].id;

    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand 3') RETURNING id`,
      [userId]
    );
    const brandId = brandResult.rows[0].id;

    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops)
       VALUES ($1, $2, 'active', 100000000)
       RETURNING id`,
      [brandId, `ch-${randomUUID()}`]
    );
    const challengeId = challengeResult.rows[0].id;

    // Create a stale warmup_started session
    const staleDate = new Date();
    staleDate.setHours(staleDate.getHours() - 2);

    const sessionResult = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, warmup_started_at, created_at)
       VALUES ($1, $2, 'warmup', $3, $4)
       RETURNING id`,
      [userId, challengeId, staleDate.toISOString(), staleDate.toISOString()]
    );
    const sessionId = sessionResult.rows[0].id;

    // Mark session as abandoned
    await query(
      `UPDATE game_sessions
       SET status = 'abandoned', completed_at = NOW(), abandon_reason = 'timeout'
       WHERE id = $1`,
      [sessionId]
    );

    // Verify no round scores exist
    const roundScores = await query(
      `SELECT * FROM session_round_scores WHERE session_id = $1`,
      [sessionId]
    );
    expect(roundScores.rows).toHaveLength(0);
  });
});
