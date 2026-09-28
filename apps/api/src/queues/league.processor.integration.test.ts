import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUtcWeekStart } from "../../lib/week";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `league_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options");
  const searchPathOption = `-c search_path=${schema}`;
  url.searchParams.set(
    "options",
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption
  );
  return url.toString();
}

if (originalDatabaseUrl) {
  process.env.DATABASE_URL = withSearchPath(originalDatabaseUrl, schemaName);
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

describeIntegration("league weekly recalculation integration", () => {
  let query: typeof import("../../db/index").query;
  let closeDb: typeof import("../../db/index").closeDb;

  async function createUser(emailPrefix: string, initialLeague: string = "bronze") {
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, avatar_url, league)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`${emailPrefix}-${randomUUID()}@example.test`, `https://example.test/${emailPrefix}.png`, initialLeague]
    );
    return result.rows[0].id;
  }

  async function createChallenge() {
    const result = await query<{ id: string }>(
      "INSERT INTO challenges DEFAULT VALUES RETURNING id"
    );
    return result.rows[0].id;
  }

  beforeAll(async () => {
    const db = await import("../../db/index");
    query = db.query;
    closeDb = db.closeDb;

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    
    // Minimal tables for this test
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    
    // Execute init.sql equivalent tables for league test
    const fs = await import("fs");
    const path = await import("path");
    const initSqlPath = path.resolve(__dirname, "../../../../../init.sql");
    const initSql = fs.readFileSync(initSqlPath, "utf8");
    await query(initSql);
  });

  afterAll(async () => {
    if (query) {
      await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    if (closeDb) {
      await closeDb();
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("calculates promotion and demotion correctly", async () => {
    const weekStart = getUtcWeekStart(new Date());

    // 1. Create a group of users
    // We need at least 30 users to fill a group ideally, but let's just make 5 in silver league 
    // Wait, the rule is rank <= 3 promotes, rank > GREATEST(grp_count - 3, 0) demotes.
    // Let's create 6 users in silver league, group 1.
    // 3 promote, 1 unchanged, 2 demote. Wait, demote is bottom 3.
    // For 6 users, count = 6. 
    // rank 1, 2, 3 -> promote
    // rank 4 -> demote? 6-3 = 3. rank > 3 -> 4, 5, 6 demote.
    // Let's create 7 users. 3 promote (1,2,3), 1 retain (4), 3 demote (5,6,7).
    
    const challengeId = await createChallenge();
    const users: { id: string, score: number }[] = [
      { id: await createUser("p1", "silver"), score: 1000 }, // Rank 1
      { id: await createUser("p2", "silver"), score: 900 },  // Rank 2
      { id: await createUser("p3", "silver"), score: 800 },  // Rank 3
      { id: await createUser("mid", "silver"), score: 500 }, // Rank 4
      { id: await createUser("d1", "silver"), score: 300 },  // Rank 5
      { id: await createUser("d2", "silver"), score: 200 },  // Rank 6
      { id: await createUser("d3", "silver"), score: 0 },    // Rank 7 (0 sessions)
    ];

    // Seed assignments manually or via the DB function
    for (const u of users) {
      await query(`
        INSERT INTO league_assignments (user_id, league, group_id, week_start)
        VALUES ($1, 'silver', 1, $2::date)
      `, [u.id, weekStart]);
    }

    // Seed game sessions
    for (const u of users) {
      if (u.score > 0) {
        const sessionRes = await query<{ id: string }>(`
          INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at)
          VALUES ($1, $2, 'completed', $3, $4::date + INTERVAL '1 day')
          RETURNING id
        `, [u.id, challengeId, u.score, weekStart]);
        
        await query(`
          INSERT INTO session_round_scores (session_id, round, score)
          VALUES ($1, 1, $2)
        `, [sessionRes.rows[0].id, u.score]);
      }
    }

    // Trigger recalculation
    await query("SELECT recalculate_league($1::date)", [weekStart]);

    // Check results
    const results = await query<{ user_id: string, rank_in_group: number, promoted: boolean, demoted: boolean, weekly_points: number }>(`
      SELECT user_id, rank_in_group, promoted, demoted, weekly_points
      FROM league_assignments
      WHERE week_start = $1::date
      ORDER BY rank_in_group ASC
    `, [weekStart]);

    expect(results.rows).toHaveLength(7);

    const r1 = results.rows.find(r => r.user_id === users[0].id);
    expect(r1?.rank_in_group).toBe(1);
    expect(r1?.promoted).toBe(true);
    expect(r1?.demoted).toBe(false);

    const rMid = results.rows.find(r => r.user_id === users[3].id);
    expect(rMid?.rank_in_group).toBe(4);
    expect(rMid?.promoted).toBe(false);
    expect(rMid?.demoted).toBe(false);

    const rD1 = results.rows.find(r => r.user_id === users[4].id);
    expect(rD1?.rank_in_group).toBe(5);
    expect(rD1?.promoted).toBe(false);
    expect(rD1?.demoted).toBe(true);

    const zeroScoreUser = results.rows.find(r => r.user_id === users[6].id);
    expect(zeroScoreUser?.weekly_points).toBe("0"); // pg numeric/bigint returns string
    expect(zeroScoreUser?.demoted).toBe(true);
  });
});
