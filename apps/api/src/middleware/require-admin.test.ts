import express from "express";
import { describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { requireAdmin } from "./require-admin";

const JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-at-least-32-characters!!";

function token(role: string): string {
  return jwt.sign(
    { sub: "test-user", email: "test@example.com", role },
    JWT_SECRET,
    { expiresIn: "15m" }
  );
}

function tokenWithoutRole(): string {
  return jwt.sign(
    { sub: "test-user", email: "test@example.com" },
    JWT_SECRET,
    { expiresIn: "15m" }
  );
}

describe("requireAdmin middleware", () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const header = req.get("Authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (bearer) {
      req.user = jwt.verify(bearer, JWT_SECRET) as typeof req.user;
    }
    next();
  });
  app.get("/admin/config/test-key", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    (
      err: { statusCode?: number; message?: string; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(err.statusCode ?? 500)
        .set("Content-Type", "application/json")
        .json({ error: err.message, code: err.code });
    },
  );

  it("calls next() when req.user.role === 'admin'", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("admin")}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("calls next() when req.user.role === 'super_admin' (superset of admin)", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("super_admin")}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("responds with 403 when req.user.role === 'user'", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("user")}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
  });

  it("responds with 403 when req.user.role === 'brand'", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("brand")}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("responds with 403 when req.user is missing the role field entirely", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${tokenWithoutRole()}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when req.user is not set (no token)", async () => {
    const res = await request(app).get("/admin/config/test-key");
    expect(res.status).toBe(401);
  });

  it("never calls next() when a 403 is sent", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("player")}`);
    expect(res.status).toBe(403);
    // If next() had been called, we'd get { ok: true } instead of an error
    expect(res.body.ok).toBeUndefined();
    expect(res.body).toHaveProperty("error");
  });

  it("403 response includes Content-Type: application/json header", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("player")}`);
    expect(res.status).toBe(403);
    expect(res.get("Content-Type")).toMatch(/application\/json/);
  });

  it("403 response body contains an error field", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("brand")}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error).toBe("string");
  });

  it("admin role allows access to protected routes", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("admin")}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("error");
  });

  it("super_admin role allows access to protected routes", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("super_admin")}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("error");
  });

  it("player role is rejected with 403", async () => {
    const res = await request(app)
      .get("/admin/config/test-key")
      .set("Authorization", `Bearer ${token("player")}`);
    expect(res.status).toBe(403);
  });
});
