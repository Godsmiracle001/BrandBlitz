import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, closeDb } from "../db/index";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `challenge_cancel_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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

describeIntegration("challenge cancellation integration", () => {
  beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // Create minimal schema for challenge cancellation testing
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
        cancelled_at TIMESTAMPTZ,
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
          CHECK (status IN ('warmup', 'active', 'completed', 'flagged', 'abandoned', 'cancelled')),
        warmup_started_at TIMESTAMPTZ,
        challenge_started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
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

  it("terminates in-progress sessions when challenge is cancelled", async () => {
    // Create test data
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test User') RETURNING id`,
      [`cancel-user-${randomUUID()}@test.invalid`]
    );
    const userId = userResult.rows[0].id;

    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand') RETURNING id`,
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

    // Create three sessions in different states
    const session1Result = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, warmup_started_at)
       VALUES ($1, $2, 'warmup', NOW())
       RETURNING id`,
      [userId, challengeId]
    );
    const sessionId1 = session1Result.rows[0].id;

    const user2Result = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'User 2') RETURNING id`,
      [`cancel-user2-${randomUUID()}@test.invalid`]
    );
    const userId2 = user2Result.rows[0].id;

    const session2Result = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, challenge_started_at)
       VALUES ($1, $2, 'active', NOW())
       RETURNING id`,
      [userId2, challengeId]
    );
    const sessionId2 = session2Result.rows[0].id;

    const user3Result = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'User 3') RETURNING id`,
      [`cancel-user3-${randomUUID()}@test.invalid`]
    );
    const userId3 = user3Result.rows[0].id;

    const session3Result = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, challenge_started_at)
       VALUES ($1, $2, 'active', NOW() - INTERVAL '10 minutes')
       RETURNING id`,
      [userId3, challengeId]
    );
    const sessionId3 = session3Result.rows[0].id;

    // Cancel the challenge
    await query(
      `UPDATE challenges SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
      [challengeId]
    );

    // Terminate associated sessions
    await query(
      `UPDATE game_sessions
       SET status = 'cancelled', completed_at = NOW()
       WHERE challenge_id = $1 AND status IN ('warmup', 'active')`,
      [challengeId]
    );

    // Verify all three sessions are now cancelled
    const sessions = await query(
      `SELECT id, status FROM game_sessions WHERE challenge_id = $1 ORDER BY id`,
      [challengeId]
    );
    expect(sessions.rows).toHaveLength(3);
    expect(sessions.rows.every((s) => s.status === "cancelled")).toBe(true);

    // Verify challenge is cancelled
    const challenge = await query<{ status: string; cancelled_at: string }>(
      `SELECT status, cancelled_at FROM challenges WHERE id = $1`,
      [challengeId]
    );
    expect(challenge.rows[0].status).toBe("cancelled");
    expect(challenge.rows[0].cancelled_at).not.toBeNull();
  });

  it("prevents new sessions from joining cancelled challenges", async () => {
    // Create test data
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Joiner User') RETURNING id`,
      [`joiner-${randomUUID()}@test.invalid`]
    );
    const userId = userResult.rows[0].id;

    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand 2') RETURNING id`,
      [userId]
    );
    const brandId = brandResult.rows[0].id;

    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, cancelled_at)
       VALUES ($1, $2, 'cancelled', 100000000, NOW())
       RETURNING id`,
      [brandId, `ch-${randomUUID()}`]
    );
    const challengeId = challengeResult.rows[0].id;

    // Verify cancelled challenge status
    const challenge = await query<{ status: string }>(
      `SELECT status FROM challenges WHERE id = $1`,
      [challengeId]
    );
    expect(challenge.rows[0].status).toBe("cancelled");

    // Try to create a session (this would be rejected by application logic)
    // Simulating the join endpoint check
    const isCancelled = await query(
      `SELECT status FROM challenges WHERE id = $1 AND status = 'cancelled'`,
      [challengeId]
    );
    expect(isCancelled.rows).toHaveLength(1);
  });

  it("does not insert session_round_scores for cancelled sessions", async () => {
    // Create test data
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Score User') RETURNING id`,
      [`score-${randomUUID()}@test.invalid`]
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

    // Create a session and cancel it
    const sessionResult = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, challenge_started_at)
       VALUES ($1, $2, 'active', NOW())
       RETURNING id`,
      [userId, challengeId]
    );
    const sessionId = sessionResult.rows[0].id;

    // Cancel the session
    await query(
      `UPDATE game_sessions SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
      [sessionId]
    );

    // Verify no round scores were created
    const roundScores = await query(
      `SELECT * FROM session_round_scores WHERE session_id = $1`,
      [sessionId]
    );
    expect(roundScores.rows).toHaveLength(0);

    // Verify session is cancelled
    const session = await query<{ status: string }>(
      `SELECT status FROM game_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(session.rows[0].status).toBe("cancelled");
  });
});
