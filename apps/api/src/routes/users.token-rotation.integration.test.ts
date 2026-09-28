import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `users_token_rotation_integration_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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

const JWT_SECRET = process.env.JWT_SECRET || "dummy_jwt_secret_for_testing_purposes_only";
function signToken(userId: string, email: string) {
  return jwt.sign({ sub: userId, email, role: "player" }, JWT_SECRET, {
    expiresIn: "1h",
    issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
    audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
  });
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

import usersRouter from "./users";
import { errorHandler } from "../middleware/error";

describeIntegration("JWT Token Rotation on Profile Update", () => {
  let app: express.Express;
  let query: typeof import("../../db/index").query;
  let closeDb: typeof import("../../db/index").closeDb;

  beforeAll(async () => {
    const db = await import("../../db/index");
    query = db.query;
    closeDb = db.closeDb;

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    
    const fs = await import("fs");
    const path = await import("path");
    const initSqlPath = path.resolve(__dirname, "../../../../../init.sql");
    const initSql = fs.readFileSync(initSqlPath, "utf8");
    await query(initSql);

    app = express();
    app.use(express.json());
    app.use("/users", usersRouter);
    app.use(errorHandler);
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

  it("rotates token on profile update and invalidates the old one", async () => {
    const userId = randomUUID();
    await query(
      `INSERT INTO users (id, email, username, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, "rotation-test@test.com", "rotationtest", "Rotation Test"]
    );

    const oldToken = signToken(userId, "rotation-test@test.com");

    // 1. Initial check - old token is accepted
    const checkRes = await request(app)
      .get("/users/me")
      .set("Authorization", `Bearer ${oldToken}`);
    expect(checkRes.status).toBe(200);

    // 2. Perform profile update
    const updateRes = await request(app)
      .patch("/users/me/profile")
      .set("Authorization", `Bearer ${oldToken}`)
      .send({ username: "rotation-updated" });
    
    expect(updateRes.status).toBe(200);
    const newToken = updateRes.body.token;
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(oldToken);

    // 3. Old token should now be rejected (401)
    const oldTokenRes = await request(app)
      .get("/users/me")
      .set("Authorization", `Bearer ${oldToken}`);
    expect(oldTokenRes.status).toBe(401);
    expect(oldTokenRes.body.error).toContain("Invalid or expired token");

    // 4. New token should be accepted (200)
    const newTokenRes = await request(app)
      .get("/users/me")
      .set("Authorization", `Bearer ${newToken}`);
    expect(newTokenRes.status).toBe(200);
    expect(newTokenRes.body.user.username).toBe("rotation-updated");

    // 5. Check audit_log
    const auditRes = await query(
      `SELECT * FROM audit_log WHERE entity = 'user' AND entity_key = $1 AND action = 'update_profile'`,
      [userId]
    );
    expect(auditRes.rows).toHaveLength(1);
    expect(auditRes.rows[0].actor_id).toBe(userId);
    expect(auditRes.rows[0].after.username).toBe("rotation-updated");
  });

  it("handles concurrent requests gracefully during the update window", async () => {
    const userId = randomUUID();
    await query(
      `INSERT INTO users (id, email, username, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, "concurrent-test@test.com", "concurrent", "Concurrent Test"]
    );

    const token = signToken(userId, "concurrent-test@test.com");

    // Fire 5 requests at the exact same time: 1 update, 4 GETs
    const results = await Promise.all([
      request(app).patch("/users/me/profile").set("Authorization", `Bearer ${token}`).send({ username: "concurrent-updated" }),
      request(app).get("/users/me").set("Authorization", `Bearer ${token}`),
      request(app).get("/users/me").set("Authorization", `Bearer ${token}`),
      request(app).get("/users/me").set("Authorization", `Bearer ${token}`),
      request(app).get("/users/me").set("Authorization", `Bearer ${token}`)
    ]);

    const updateRes = results[0];
    expect(updateRes.status).toBe(200);

    // The other GET requests will either be 200 (if they ran before revocation) or 401 (if they ran after).
    // None should be 500.
    for (let i = 1; i < results.length; i++) {
      expect([200, 401]).toContain(results[i].status);
    }
  });
});
