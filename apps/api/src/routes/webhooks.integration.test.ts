import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { query, closeDb } from "../db/index";
import webhooksRouter from "./webhooks";
import { errorHandler } from "../middleware/error";
import { signWebhookPayload } from "../middleware/verify-webhook";

vi.mock("@brandblitz/stellar", () => ({
  getAccountUsdcBalance: vi.fn().mockResolvedValue(100_000_000n), // 100 USDC in stroops
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `webhook_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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
  // Provide rawBody for verifyWebhook middleware
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );
  app.use("/webhooks", webhooksRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describeIntegration("Webhooks Integration", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { server: srv, baseUrl: url } = await startServer();
    server = srv;
    baseUrl = url;

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await query(`
      CREATE TABLE app_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID
      )
    `);

    // Insert current webhook secret
    await query(
      `INSERT INTO app_config (key, value) VALUES ('webhook_secret_current', '{"secret": "test-secret"}')`
    );

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
        pool_amount_usdc TEXT NOT NULL DEFAULT '0.0000000',
        pool_amount_stroops BIGINT NOT NULL DEFAULT 0,
        deposit_tx TEXT,
        activated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tx_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      )
    `);
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

  function createHeaders(body: string, secret: string = "test-secret") {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(body, timestamp, secret);
    return {
      "Content-Type": "application/json",
      "X-Webhook-Signature": `sha256=${signature}`,
      "X-Webhook-Timestamp": timestamp.toString(),
      "X-Webhook-Id": randomUUID(),
    };
  }

  it("activates a challenge on a valid webhook", async () => {
    // 1. Seed a challenge
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test User') RETURNING id`,
      [`user-${randomUUID()}@test.invalid`]
    );
    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand') RETURNING id`,
      [userResult.rows[0].id]
    );
    const memo = randomUUID();
    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_usdc)
       VALUES ($1, $2, 'pending_deposit', '10.0000000')
       RETURNING id`,
      [brandResult.rows[0].id, memo]
    );
    const challengeId = challengeResult.rows[0].id;

    const payload = JSON.stringify({
      memo,
      txHash: "a".repeat(64),
      amount: "10.0000000",
    });

    const res = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
      method: "POST",
      headers: createHeaders(payload),
      body: payload,
    });

    expect(res.status).toBe(200);

    const updated = await query<{ status: string; deposit_tx: string; activated_at: string }>(
      `SELECT status, deposit_tx, activated_at FROM challenges WHERE id = $1`,
      [challengeId]
    );

    expect(updated.rows[0].status).toBe("active");
    expect(updated.rows[0].deposit_tx).toBe("a".repeat(64));
    expect(updated.rows[0].activated_at).not.toBeNull();

    // Idempotent retry
    const res2 = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
      method: "POST",
      headers: createHeaders(payload),
      body: payload,
    });
    expect(res2.status).toBe(200);
    const res2Body = await res2.json();
    expect(res2Body.status).toBe("duplicate_tx_ignored");
  });

  it("returns 401 for an invalid HMAC signature", async () => {
    const payload = JSON.stringify({
      memo: randomUUID(),
      txHash: "b".repeat(64),
      amount: "10.0000000",
    });

    const res = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
      method: "POST",
      headers: createHeaders(payload, "wrong-secret"),
      body: payload,
    });

    expect(res.status).toBe(401);
  });

  it("leaves challenge in pending_deposit if escrow balance is insufficient", async () => {
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test User 2') RETURNING id`,
      [`user-${randomUUID()}@test.invalid`]
    );
    const brandResult = await query<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name) VALUES ($1, 'Test Brand 2') RETURNING id`,
      [userResult.rows[0].id]
    );
    const memo = randomUUID();
    const challengeResult = await query<{ id: string }>(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_usdc)
       VALUES ($1, $2, 'pending_deposit', '1000.0000000') -- Requires 1000 USDC
       RETURNING id`,
      [brandResult.rows[0].id, memo]
    );
    const challengeId = challengeResult.rows[0].id;

    const payload = JSON.stringify({
      memo,
      txHash: "c".repeat(64),
      amount: "1000.0000000",
    });

    const res = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
      method: "POST",
      headers: createHeaders(payload),
      body: payload,
    });

    // Our mocked balance is 100 USDC, but the requirement is 1000.
    expect(res.status).toBe(422);

    const updated = await query<{ status: string }>(`SELECT status FROM challenges WHERE id = $1`, [
      challengeId,
    ]);
    expect(updated.rows[0].status).toBe("pending_deposit");
  });
});
