import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { query, closeDb } from "../db/index";
import leaderboardRoutes from "./leaderboard";
import sessionsRoutes from "./sessions";
import { errorHandler } from "../middleware/error";
import { redis } from "../lib/redis";

// Import authenticate to mock it
vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    const sub = req.headers["x-test-user-id"];
    if (sub) {
      req.user = { sub };
    }
    next();
  },
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `leaderboard_cache_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  
  app.use("/leaderboard", leaderboardRoutes);
  app.use("/sessions", sessionsRoutes);
  
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describeIntegration("Leaderboard Cache Invalidation", () => {
  let server: Server;
  let baseUrl: string;
  let testUserId: string;
  let challengeId: string;
  let sessionId: string;

  beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    
    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
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
        status TEXT NOT NULL DEFAULT 'active',
        pool_amount_usdc TEXT NOT NULL DEFAULT '10.0000000',
        pool_amount_stroops BIGINT NOT NULL DEFAULT 100000000,
        deposit_tx TEXT,
        activated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE game_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        challenge_started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        total_score INTEGER NOT NULL DEFAULT 0,
        is_practice BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, challenge_id)
      )
    `);

    await query(`
      CREATE TABLE challenge_questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        round INTEGER NOT NULL,
        correct_option TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE session_round_scores (
        session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        round INTEGER NOT NULL CHECK (round IN (1, 2, 3)),
        score INTEGER NOT NULL CHECK (score >= 0),
        answer TEXT,
        reaction_time_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, round)
      )
    `);

    // Create user and challenge
    const userRes = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ('user@test.invalid', 'Test User') RETURNING id`
    );
    testUserId = userRes.rows[0].id;

    const brandRes = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand') RETURNING id`,
      [testUserId]
    );

    const challengeRes = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id) VALUES ($1, $2) RETURNING id`,
      [brandRes.rows[0].id, randomUUID()]
    );
    challengeId = challengeRes.rows[0].id;

    // Create question for round 3
    await query(
      `INSERT INTO challenge_questions (challenge_id, round, correct_option) VALUES ($1, 3, 'A')`,
      [challengeId]
    );

    // Create active session
    const sessionRes = await query<{ id: string }>(
      `INSERT INTO game_sessions (user_id, challenge_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [testUserId, challengeId]
    );
    sessionId = sessionRes.rows[0].id;

    const { server: srv, baseUrl: url } = await startServer();
    server = srv;
    baseUrl = url;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await closeDb();
  });

  it("invalidates the leaderboard cache on session completion", async () => {
    // 1. Prime the Redis leaderboard cache
    const cacheKey = `leaderboard:score:${challengeId}:10:`;
    // Simulate setting the cache in redis to guarantee it's primed
    await redis.set(cacheKey, JSON.stringify({ cached: true, sessions: [] }), "EX", 300);
    
    // Verify it's cached
    const cached = await redis.get(cacheKey);
    expect(cached).not.toBeNull();

    // 2. Complete the game session (round 3 answer)
    const completeRes = await fetch(`${baseUrl}/sessions/${challengeId}/answer/3`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-user-id": testUserId,
      },
      body: JSON.stringify({
        selectedOption: "A",
        reactionTimeMs: 100,
      })
    });
    
    expect(completeRes.status).toBe(200);

    // 3. Verify Redis key is absent immediately after completion
    const cachedAfter = await redis.get(cacheKey);
    expect(cachedAfter).toBeNull();
  });
});
