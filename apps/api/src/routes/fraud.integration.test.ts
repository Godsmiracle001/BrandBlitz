import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { query, closeDb } from "../db/index";
import sessionsRoutes from "./sessions";
import { errorHandler } from "../middleware/error";
import { redis } from "../lib/redis";

// Mock authentication to respect custom headers
vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    const sub = req.headers["x-test-user-id"];
    if (sub) {
      req.user = { sub };
    }
    next();
  },
}));

vi.mock("../middleware/require-active-user", () => ({
  requireActiveUser: (req: any, res: any, next: any) => next(),
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `fraud_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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
  
  app.set("trust proxy", true);
  app.use((req, res, next) => {
    req.ip = "192.168.1.1";
    Object.defineProperty(req, 'ip', { value: "192.168.1.1" });
    next();
  });
  
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

describeIntegration("Fraud Detection - Multi-Account Fingerprint", () => {
  let server: Server;
  let baseUrl: string;
  let challengeId: string;

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
        status TEXT NOT NULL DEFAULT 'warmup',
        device_id TEXT,
        is_practice BOOLEAN NOT NULL DEFAULT FALSE,
        warmup_started_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, challenge_id)
      )
    `);

    await query(`
      CREATE TABLE fraud_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID,
        user_id UUID,
        flag_type TEXT NOT NULL,
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (session_id, flag_type)
      )
    `);

    // Create a brand and challenge
    const ownerRes = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ('owner@test.invalid', 'Owner') RETURNING id`
    );
    const brandRes = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand') RETURNING id`,
      [ownerRes.rows[0].id]
    );
    const chalRes = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id) VALUES ($1, $2) RETURNING id`,
      [brandRes.rows[0].id, randomUUID()]
    );
    challengeId = chalRes.rows[0].id;

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

  it("blocks the 3rd account using the same device fingerprint", async () => {
    const deviceId = "test-device-id-123";

    // Create 3 users
    const users: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await query<{ id: string }>(
        `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
        [`user${i}@test.invalid`, `User ${i}`]
      );
      users.push(res.rows[0].id);
    }

    // 1st request
    const req1 = await fetch(`${baseUrl}/sessions/${challengeId}/warmup-start`, {
      method: "POST",
      headers: {
        "x-test-user-id": users[0],
        "x-device-id": deviceId,
        "User-Agent": "test-agent",
      },
    });
    expect(req1.status).toBe(200);

    // 2nd request
    const req2 = await fetch(`${baseUrl}/sessions/${challengeId}/warmup-start`, {
      method: "POST",
      headers: {
        "x-test-user-id": users[1],
        "x-device-id": deviceId,
        "User-Agent": "test-agent",
      },
    });
    expect(req2.status).toBe(200);

    // 3rd request should fail
    const req3 = await fetch(`${baseUrl}/sessions/${challengeId}/warmup-start`, {
      method: "POST",
      headers: {
        "x-test-user-id": users[2],
        "x-device-id": deviceId,
        "User-Agent": "test-agent",
      },
    });
    expect(req3.status).toBe(403);
    const body3 = await req3.json();
    expect(body3.error).toBe("Session rejected due to fingerprint collision");

    // Verify fraud flag is recorded in the database
    const flags = await query(`SELECT * FROM fraud_flags WHERE user_id = $1 AND flag_type = 'multi_account_fingerprint'`, [users[2]]);
    expect(flags.rows.length).toBeGreaterThan(0);
    expect(flags.rows[0].details.accountCount).toBeGreaterThanOrEqual(3);
  });
});
