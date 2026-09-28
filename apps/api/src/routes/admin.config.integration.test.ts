import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { query, closeDb } from "../db/index";
import adminConfigRoutes from "./admin/config";
import challengesRoutes from "./challenges"; // Any route that uses apiLimiter
import { errorHandler } from "../middleware/error";

// Import authenticate to mock it
import { authenticate } from "../middleware/authenticate";

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    // If there's a custom header x-test-user-id, mock that user
    const sub = req.headers["x-test-user-id"];
    if (sub) {
      req.user = { sub };
    }
    next();
  },
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `admin_config_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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
  
  app.use("/admin/config", adminConfigRoutes);
  
  // We need an endpoint with apiLimiter. /challenges is fine, but we'll mock it if it's too complex.
  // Actually, we can just use the rate-limit middleware directly on a dummy route to keep the test focused.
  const { apiLimiter } = await import("../middleware/rate-limit");
  app.get("/test-limited", apiLimiter, (_req, res) => {
    res.json({ ok: true });
  });
  
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describeIntegration("Admin Config Update - Rate Limit", () => {
  let server: Server;
  let baseUrl: string;
  let adminUserId: string;
  let regularUserId: string;

  beforeAll(async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    
    await query(`
      CREATE TABLE app_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID
      )
    `);

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
      CREATE TABLE audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_key TEXT,
        before JSONB,
        after JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Insert admin and regular user
    const adminRes = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, role) VALUES ('admin@test.invalid', 'Admin', 'admin') RETURNING id`
    );
    adminUserId = adminRes.rows[0].id;
    
    const regRes = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, role) VALUES ('user@test.invalid', 'User', 'user') RETURNING id`
    );
    regularUserId = regRes.rows[0].id;

    // Default rate limit config
    await query(
      `INSERT INTO app_config (key, value) VALUES ('rate_limit_requests_per_minute', '{"limit": 200}')`
    );

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

  it("updates rate limit dynamically via admin endpoint", async () => {
    // 1. Fire requests to trigger a 429 response using a new limit
    // Initially the limit is 200, so we update it to 2 first.
    const patchRes = await fetch(`${baseUrl}/admin/config/rate_limit_requests_per_minute`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-test-user-id": adminUserId,
      },
      body: JSON.stringify({
        value: { limit: 2 }
      })
    });
    expect(patchRes.status).toBe(200);

    // Wait a brief moment in case the rate limit fetch hasn't updated its cache (TTL is 10s)
    // Actually, our getApiRateLimit cache is TTL based. We might have to wait 10s or reset the TTL?
    // In our test environment, we might want to wait slightly or since it's the first time it fetches, it might just work if it wasn't fetched yet.
    // Wait, the test initializes the server before fetching, so the cache might be empty, and it will fetch instantly.
    
    const userA = randomUUID(); // Random user ID so they have their own rate limit bucket
    
    // Request 1: Should succeed
    const r1 = await fetch(`${baseUrl}/test-limited`, { headers: { "x-test-user-id": userA } });
    expect(r1.status).toBe(200);

    // Request 2: Should succeed
    const r2 = await fetch(`${baseUrl}/test-limited`, { headers: { "x-test-user-id": userA } });
    expect(r2.status).toBe(200);

    // Request 3: Should fail (limit is 2)
    const r3 = await fetch(`${baseUrl}/test-limited`, { headers: { "x-test-user-id": userA } });
    expect(r3.status).toBe(429);

    // Verify audit log
    const auditRes = await query(`SELECT * FROM audit_log WHERE entity = 'app_config' AND entity_key = 'rate_limit_requests_per_minute'`);
    expect(auditRes.rows.length).toBeGreaterThan(0);
    expect(auditRes.rows[0].actor_id).toBe(adminUserId);
    expect(auditRes.rows[0].after.limit).toBe(2);

    // Non-admin fails to update
    const nonAdminRes = await fetch(`${baseUrl}/admin/config/rate_limit_requests_per_minute`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-test-user-id": regularUserId, // regular user
      },
      body: JSON.stringify({ value: { limit: 100 } })
    });
    expect(nonAdminRes.status).toBe(403);
  });
});
