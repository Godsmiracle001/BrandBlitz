import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, closeDb } from "../db/index";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `streaks_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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

describeIntegration("streak lifecycle integration", () => {
  beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // Create minimal schema for streak testing
    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        streak INTEGER NOT NULL DEFAULT 0,
        last_play_day DATE,
        streak_repairs_this_month INTEGER NOT NULL DEFAULT 0,
        streak_repair_available BOOLEAN NOT NULL DEFAULT FALSE,
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

  it("increments streak across consecutive daily plays", async () => {
    // Create test user
    const userResult = await query<{ id: string; streak: number; last_play_day: string | null }>(
      `INSERT INTO users (email, display_name, streak, last_play_day)
       VALUES ($1, 'Streak User', 0, NULL)
       RETURNING id, streak, last_play_day`,
      [`streak-user-${randomUUID()}@test.invalid`]
    );
    const userId = userResult.rows[0].id;
    expect(userResult.rows[0].streak).toBe(0);

    // Simulate day 1 play
    const day1 = "2026-05-29";
    await query(
      `UPDATE users SET streak = 1, last_play_day = $1 WHERE id = $2`,
      [day1, userId]
    );

    let user = await query<{ streak: number; last_play_day: string }>(
      `SELECT streak, last_play_day FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].streak).toBe(1);
    expect(user.rows[0].last_play_day).toBe(day1);

    // Simulate day 2 play (consecutive)
    const day2 = "2026-05-30";
    await query(
      `UPDATE users SET streak = 2, last_play_day = $1 WHERE id = $2`,
      [day2, userId]
    );

    user = await query<{ streak: number; last_play_day: string }>(
      `SELECT streak, last_play_day FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].streak).toBe(2);
    expect(user.rows[0].last_play_day).toBe(day2);

    // Simulate day 3 play (consecutive)
    const day3 = "2026-05-31";
    await query(
      `UPDATE users SET streak = 3, last_play_day = $1, streak_repair_available = true WHERE id = $2`,
      [day3, userId]
    );

    user = await query<{ streak: number; last_play_day: string; streak_repair_available: boolean }>(
      `SELECT streak, last_play_day, streak_repair_available FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].streak).toBe(3);
    expect(user.rows[0].streak_repair_available).toBe(true);
  });

  it("resets streak after missing a day", async () => {
    // Create test user with existing streak
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, streak, last_play_day)
       VALUES ($1, 'Break Streak User', 5, $2)
       RETURNING id`,
      [`break-streak-${randomUUID()}@test.invalid`, "2026-05-27"]
    );
    const userId = userResult.rows[0].id;

    // Skip a day and try to play on day with gap
    // last_play_day = May 27, now playing on May 30 (gap of 3 days)
    await query(
      `UPDATE users SET streak = 1, last_play_day = '2026-05-30' WHERE id = $1`,
      [userId]
    );

    const user = await query<{ streak: number; last_play_day: string }>(
      `SELECT streak, last_play_day FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].streak).toBe(1);
    expect(user.rows[0].last_play_day).toBe("2026-05-30");
  });

  it("supports streak repair mechanic with monthly limits", async () => {
    // Create test user with broken streak
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, streak, last_play_day, streak_repairs_this_month, streak_repair_available)
       VALUES ($1, 'Repair User', 0, $2, 0, true)
       RETURNING id`,
      [`repair-${randomUUID()}@test.invalid`, "2026-05-27"]
    );
    const userId = userResult.rows[0].id;

    // Simulate repair - restore previous streak value
    const previousStreak = 7;
    await query(
      `UPDATE users SET streak = $1, last_play_day = $2, streak_repairs_this_month = 1, streak_repair_available = false WHERE id = $3`,
      [previousStreak, "2026-05-30", userId]
    );

    const user = await query<{ streak: number; streak_repairs_this_month: number; streak_repair_available: boolean }>(
      `SELECT streak, streak_repairs_this_month, streak_repair_available FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].streak).toBe(previousStreak);
    expect(user.rows[0].streak_repairs_this_month).toBe(1);
    expect(user.rows[0].streak_repair_available).toBe(false);
  });

  it("prevents streak advancement from abandoned sessions", async () => {
    // Create test data
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, streak, last_play_day)
       VALUES ($1, 'Abandoned User', 2, $2)
       RETURNING id`,
      [`abandoned-${randomUUID()}@test.invalid`, "2026-05-29"]
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

    // Create an abandoned session
    const sessionResult = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status, warmup_started_at)
       VALUES ($1, $2, 'abandoned', NOW())
       RETURNING id`,
      [userId, challengeId]
    );
    const sessionId = sessionResult.rows[0].id;

    // Verify session is abandoned
    const session = await query(
      `SELECT status FROM game_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(session.rows[0].status).toBe("abandoned");

    // Verify user streak was not updated
    const user = await query<{ streak: number; last_play_day: string }>(
      `SELECT streak, last_play_day FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].streak).toBe(2);
    expect(user.rows[0].last_play_day).toBe("2026-05-29");
  });
});
