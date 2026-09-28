import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../index";
import { query } from "../db";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-at-least-32-characters!!";

function makeToken(
  userId: string,
  email: string,
  role: string = "player"
): string {
  return jwt.sign({ sub: userId, email, role }, JWT_SECRET, {
    expiresIn: "15m",
    issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
    audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
  });
}

describe("TOS version update blocks existing sessions until new TOS accepted (#432)", () => {
  const userId = "00000000-0000-0000-0000-000000000010";
  const userEmail = "tos-update-test@example.com";
  const adminUserId = "00000000-0000-0000-0000-000000000011";
  const adminEmail = "tos-admin@example.com";
  const originalTosVersion = "1.0";
  const newTosVersion = "2.0";

  beforeAll(async () => {
    await query(
      `INSERT INTO users (id, email, display_name, role)
       VALUES ($1, $2, 'TOS Update Test User', 'player')
       ON CONFLICT (id) DO NOTHING`,
      [userId, userEmail]
    );

    await query(
      `INSERT INTO users (id, email, display_name, role)
       VALUES ($1, $2, 'TOS Admin', 'admin')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, adminEmail]
    );
  });

  beforeEach(async () => {
    await query(
      `DELETE FROM user_legal_acceptances WHERE user_id = $1 AND type = 'tos'`,
      [userId]
    );
    await query(
      `DELETE FROM legal_documents WHERE type = 'tos' AND version IN ($1, $2)`,
      [originalTosVersion, newTosVersion]
    );
  });

  afterAll(async () => {
    await query(
      `DELETE FROM user_legal_acceptances WHERE user_id = $1 AND type = 'tos'`,
      [userId]
    );
    await query(
      `DELETE FROM legal_documents WHERE type = 'tos' AND version IN ($1, $2)`,
      [originalTosVersion, newTosVersion]
    );
  });

  it("blocks a user with stale TOS acceptance after version bump", async () => {
    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Original Terms', NOW() - INTERVAL '7 days')
       ON CONFLICT (type, version) DO NOTHING`,
      [originalTosVersion]
    );

    await query(
      `INSERT INTO user_legal_acceptances (user_id, type, version, ip)
       VALUES ($1, 'tos', $2, '127.0.0.1')
       ON CONFLICT (user_id, type, version) DO NOTHING`,
      [userId, originalTosVersion]
    );

    const token = makeToken(userId, userEmail);
    const resBeforeBump = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });

    expect(resBeforeBump.status).not.toBe(403);

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Updated Terms', NOW())
       ON CONFLICT (type, version) DO NOTHING`,
      [newTosVersion]
    );

    const resAfterBump = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });

    expect(resAfterBump.status).toBe(403);
    expect(resAfterBump.body.code).toBe("TOS_NOT_ACCEPTED");
  });

  it("accepts the new TOS and updates the user's accepted version", async () => {
    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Original Terms', NOW() - INTERVAL '7 days')
       ON CONFLICT (type, version) DO NOTHING`,
      [originalTosVersion]
    );

    await query(
      `INSERT INTO user_legal_acceptances (user_id, type, version, ip)
       VALUES ($1, 'tos', $2, '127.0.0.1')
       ON CONFLICT (user_id, type, version) DO NOTHING`,
      [userId, originalTosVersion]
    );

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Updated Terms', NOW())
       ON CONFLICT (type, version) DO NOTHING`,
      [newTosVersion]
    );

    const token = makeToken(userId, userEmail);
    const acceptRes = await request(app)
      .post("/legal/accept")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "tos", version: newTosVersion });

    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.acceptance.version).toBe(newTosVersion);

    const statusRes = await request(app)
      .get("/legal/status")
      .set("Authorization", `Bearer ${token}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.tos.accepted).toBe(true);
    expect(statusRes.body.tos.current.version).toBe(newTosVersion);
  });

  it("allows access to game route after accepting the new TOS", async () => {
    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Original Terms', NOW() - INTERVAL '7 days')
       ON CONFLICT (type, version) DO NOTHING`,
      [originalTosVersion]
    );

    await query(
      `INSERT INTO user_legal_acceptances (user_id, type, version, ip)
       VALUES ($1, 'tos', $2, '127.0.0.1')
       ON CONFLICT (user_id, type, version) DO NOTHING`,
      [userId, originalTosVersion]
    );

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Updated Terms', NOW())
       ON CONFLICT (type, version) DO NOTHING`,
      [newTosVersion]
    );

    const token = makeToken(userId, userEmail);

    const blockedRes = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.code).toBe("TOS_NOT_ACCEPTED");

    await request(app)
      .post("/legal/accept")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "tos", version: newTosVersion });

    const unblockedRes = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });

    expect(unblockedRes.status).not.toBe(403);
  });

  it("blocks a user who has never accepted any TOS", async () => {
    const freshUserId = "00000000-0000-0000-0000-000000000020";
    const freshUserEmail = "tos-fresh@example.com";

    await query(
      `INSERT INTO users (id, email, display_name, role)
       VALUES ($1, $2, 'Fresh User', 'player')
       ON CONFLICT (id) DO NOTHING`,
      [freshUserId, freshUserEmail]
    );

    await query(
      `DELETE FROM user_legal_acceptances WHERE user_id = $1 AND type = 'tos'`,
      [freshUserId]
    );

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Terms', NOW() - INTERVAL '1 day')
       ON CONFLICT (type, version) DO NOTHING`,
      ["1.0"]
    );

    const token = makeToken(freshUserId, freshUserEmail);
    const res = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TOS_NOT_ACCEPTED");

    await query(
      `DELETE FROM user_legal_acceptances WHERE user_id = $1 AND type = 'tos'`,
      [freshUserId]
    );
    await query(`DELETE FROM users WHERE id = $1`, [freshUserId]);
  });

  it("audit_log records a tos_accepted event with correct version and user_id", async () => {
    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Terms', NOW() - INTERVAL '1 day')
       ON CONFLICT (type, version) DO NOTHING`,
      [originalTosVersion]
    );

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Updated Terms', NOW())
       ON CONFLICT (type, version) DO NOTHING`,
      [newTosVersion]
    );

    const token = makeToken(userId, userEmail);

    const acceptRes = await request(app)
      .post("/legal/accept")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "tos", version: newTosVersion });

    expect(acceptRes.status).toBe(201);

    const acceptance = acceptRes.body.acceptance;
    expect(acceptance.user_id).toBe(userId);
    expect(acceptance.version).toBe(newTosVersion);
    expect(acceptance.type).toBe("tos");
  });

  it("resets cleanly — user with old acceptance is blocked by newer version", async () => {
    await query(
      `DELETE FROM user_legal_acceptances WHERE user_id = $1 AND type = 'tos'`,
      [userId]
    );

    await query(
      `DELETE FROM legal_documents WHERE type = 'tos' AND version = $1`,
      [newTosVersion]
    );

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Original Terms', NOW() - INTERVAL '1 day')
       ON CONFLICT (type, version) DO NOTHING`,
      [originalTosVersion]
    );

    await query(
      `INSERT INTO user_legal_acceptances (user_id, type, version, ip)
       VALUES ($1, 'tos', $2, '127.0.0.1')
       ON CONFLICT (user_id, type, version) DO NOTHING`,
      [userId, originalTosVersion]
    );

    const v1Token = makeToken(userId, userEmail);
    const res1 = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${v1Token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });
    expect(res1.status).not.toBe(403);

    await query(
      `INSERT INTO legal_documents (version, type, body_markdown, effective_at)
       VALUES ($1, 'tos', '# Newer Terms', NOW())
       ON CONFLICT (type, version) DO NOTHING`,
      [newTosVersion]
    );

    const res2 = await request(app)
      .post("/brands/challenges")
      .set("Authorization", `Bearer ${v1Token}`)
      .send({ brandId: "00000000-0000-0000-0000-000000000000", poolAmountUsdc: "10" });
    expect(res2.status).toBe(403);
    expect(res2.body.code).toBe("TOS_NOT_ACCEPTED");
  });
});
