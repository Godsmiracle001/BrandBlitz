import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app } from "../index";
import { query } from "../db";
import jwt from "jsonwebtoken";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const TEST_EMAIL = "legal-test@example.com";
const JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-at-least-32-characters!!";

function signToken(overrides?: Partial<{ sub: string; email: string; role: string }>): string {
  return jwt.sign(
    { sub: overrides?.sub ?? TEST_USER_ID, email: overrides?.email ?? TEST_EMAIL, role: overrides?.role ?? "player" },
    JWT_SECRET,
    { expiresIn: "15m" }
  );
}

describe("Legal routes", () => {
  beforeAll(async () => {
    // Ensure the test user exists
    await query(
      `INSERT INTO users (id, email, display_name, role)
       VALUES ($1, $2, 'Legal Test', 'player')
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, TEST_EMAIL]
    );
  });

  describe("GET /legal/tos/current", () => {
    it("returns 404 when no current version exists", async () => {
      const res = await request(app).get("/legal/tos/current");
      expect(res.status).toBe(404);
    });

    it("returns the current document when one exists", async () => {
      await query(
        `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
         VALUES ('1.0', 'tos', '# Terms', NOW() - INTERVAL '1 day')
         ON CONFLICT (type, version) DO NOTHING`
      );
      const res = await request(app).get("/legal/tos/current");
      expect(res.status).toBe(200);
      expect(res.body.document.version).toBe("1.0");
    });
  });

  describe("POST /legal/accept", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app)
        .post("/legal/accept")
        .send({ type: "tos", version: "1.0" });
      expect(res.status).toBe(401);
    });

    it("accepts a valid acceptance", async () => {
      const res = await request(app)
        .post("/legal/accept")
        .set("Authorization", `Bearer ${signToken()}`)
        .send({ type: "tos", version: "1.0" });
      expect(res.status).toBe(201);
      expect(res.body.acceptance.version).toBe("1.0");
    });

    // #391
    it("returns 400 when the version field is omitted", async () => {
      const res = await request(app)
        .post("/legal/accept")
        .set("Authorization", `Bearer ${signToken()}`)
        .send({ type: "tos" });
      expect(res.status).toBe(400);
    });

    // #391
    it("returns 400 when the supplied version does not match the current tos version", async () => {
      const res = await request(app)
        .post("/legal/accept")
        .set("Authorization", `Bearer ${signToken()}`)
        .send({ type: "tos", version: "0.9-does-not-exist" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("LEGAL_VERSION_MISMATCH");
    });

    // #391
    it("is idempotent — re-accepting the same version does not create a duplicate row", async () => {
      await request(app)
        .post("/legal/accept")
        .set("Authorization", `Bearer ${signToken()}`)
        .send({ type: "tos", version: "1.0" });
      const secondRes = await request(app)
        .post("/legal/accept")
        .set("Authorization", `Bearer ${signToken()}`)
        .send({ type: "tos", version: "1.0" });
      expect(secondRes.status).toBe(201);

      const rows = await query(
        `SELECT COUNT(*)::int AS count FROM user_legal_acceptances
         WHERE user_id = $1 AND type = 'tos' AND version = '1.0'`,
        [TEST_USER_ID]
      );
      expect(rows.rows[0].count).toBe(1);
    });

    // #391
    it("creates an audit_log entry for the acceptance event", async () => {
      const auditUserId = "00000000-0000-0000-0000-000000000003";
      await query(
        `INSERT INTO users (id, email, display_name, role)
         VALUES ($1, 'legal-audit-test@example.com', 'Legal Audit Test', 'player')
         ON CONFLICT (id) DO NOTHING`,
        [auditUserId]
      );

      await request(app)
        .post("/legal/accept")
        .set("Authorization", `Bearer ${signToken({ sub: auditUserId, email: "legal-audit-test@example.com" })}`)
        .send({ type: "tos", version: "1.0" });

      const rows = await query(
        `SELECT * FROM audit_log
         WHERE actor_id = $1 AND action = 'accept' AND entity = 'user_legal_acceptances' AND entity_key = 'tos:1.0'`,
        [auditUserId]
      );
      expect(rows.rows.length).toBe(1);
    });
  });

  describe("GET /legal/status", () => {
    it("returns status for authenticated user", async () => {
      const res = await request(app)
        .get("/legal/status")
        .set("Authorization", `Bearer ${signToken()}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("tos");
      expect(res.body).toHaveProperty("privacy");
    });
  });
});
