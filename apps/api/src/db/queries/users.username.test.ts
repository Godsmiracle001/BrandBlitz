// Issue #202 / #972: Test username UNIQUE constraint with case-insensitivity and NULL handling against real schema migration
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `users_username_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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

describeIntegration("Username UNIQUE constraint migration 0024 (Issue #202 / #972)", () => {
  let query: typeof import("../index").query;
  let closeDb: typeof import("../index").closeDb;

  beforeAll(async () => {
    const db = await import("../index");
    query = db.query;
    closeDb = db.closeDb;

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // 1. Initial users table as defined in apps/api/migrations/00000-initial.sql
    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        username TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 2. Apply migration 0024 (apps/api/migrations/0024-username-unique-partial.sql)
    await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique 
        ON users (LOWER(username)) 
        WHERE username IS NOT NULL
    `);
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

  it("allows multiple NULL usernames", async () => {
    const result1 = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, username) 
       VALUES ($1, $2, NULL) 
       RETURNING id`,
      [`test-null-1-${randomUUID()}@example.com`, "Test User 1"]
    );
    expect(result1.rows[0].id).toBeDefined();

    const result2 = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, username) 
       VALUES ($1, $2, NULL) 
       RETURNING id`,
      [`test-null-2-${randomUUID()}@example.com`, "Test User 2"]
    );
    expect(result2.rows[0].id).toBeDefined();
  });

  it("rejects duplicate usernames case-insensitively (e.g. 'alice' vs 'Alice')", async () => {
    await query(
      `INSERT INTO users (email, display_name, username) 
       VALUES ($1, $2, $3)`,
      [`test-alice-1-${randomUUID()}@example.com`, "Alice One", "alice"]
    );

    await expect(
      query(
        `INSERT INTO users (email, display_name, username) 
         VALUES ($1, $2, $3)`,
        [`test-alice-2-${randomUUID()}@example.com`, "Alice Two", "Alice"]
      )
    ).rejects.toThrow(/duplicate key value violates unique constraint/i);
  });

  it("rejects duplicate usernames with exact same case", async () => {
    await query(
      `INSERT INTO users (email, display_name, username) 
       VALUES ($1, $2, $3)`,
      [`test-bob-1-${randomUUID()}@example.com`, "Bob One", "bob"]
    );

    await expect(
      query(
        `INSERT INTO users (email, display_name, username) 
         VALUES ($1, $2, $3)`,
        [`test-bob-2-${randomUUID()}@example.com`, "Bob Two", "bob"]
      )
    ).rejects.toThrow(/duplicate key value violates unique constraint/i);
  });

  it("allows setting username after NULL", async () => {
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, username) 
       VALUES ($1, $2, NULL) 
       RETURNING id`,
      [`test-update-${randomUUID()}@example.com`, "Test Update"]
    );
    const userId = result.rows[0].id;

    await query(`UPDATE users SET username = $1 WHERE id = $2`, ["uniqueuser", userId]);

    const updated = await query<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(updated.rows[0].username).toBe("uniqueuser");
  });

  it("allows updating username to NULL", async () => {
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, display_name, username) 
       VALUES ($1, $2, $3) 
       RETURNING id`,
      [`test-null-update-${randomUUID()}@example.com`, "Test Null Update", "tempuser"]
    );
    const userId = result.rows[0].id;

    await query(`UPDATE users SET username = NULL WHERE id = $1`, [userId]);

    const updated = await query<{ username: string | null }>(
      `SELECT username FROM users WHERE id = $1`,
      [userId]
    );
    expect(updated.rows[0].username).toBeNull();
  });
});
