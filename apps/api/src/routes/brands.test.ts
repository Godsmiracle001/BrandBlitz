import { readFileSync } from "fs";
import path from "path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import express from "express";

// Mocks MUST be hoisted to run before imports
vi.mock("@brandblitz/storage", () => ({
  optimizeImage: vi.fn().mockResolvedValue("optimized.webp"),
  getPublicUrl: (bucket: string, key: string) =>
    `https://storage.example.com/${bucket}/${key}`,
  BUCKETS: {
    BRAND_ASSETS: "brand-assets",
  },
  StorageError: class StorageError extends Error {
    public code = "STORAGE_ERROR";
    constructor(message: string) {
      super(message);
      this.name = "StorageError";
    }
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  questionPreviewLimiter: (_req: any, _res: any, next: any) => next(),
}));

const JWT_SECRET = "dummy_jwt_secret_for_testing_purposes_only";

vi.hoisted(() => {
  process.env.JWT_SECRET = "dummy_jwt_secret_for_testing_purposes_only";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/db";
  process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
  process.env.GOOGLE_CLIENT_ID = "dummy_id";
  process.env.GOOGLE_CLIENT_SECRET = "dummy_secret";
  process.env.HOT_WALLET_SECRET = "S_DUMMY_SECRET_KEY_FOR_TESTING";
  process.env.HOT_WALLET_PUBLIC_KEY = "G_DUMMY_PUBLIC_KEY_FOR_TESTING";
  process.env.WEBHOOK_SECRET = "dummy_webhook_secret";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY_ID = "dummy_access";
  process.env.S3_SECRET_ACCESS_KEY = "dummy_secret";
  process.env.S3_PUBLIC_URL = "http://localhost:9000";

  // Setup search_path in DATABASE_URL
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const url = new URL(dbUrl);
    const existingOptions = url.searchParams.get("options");
    const searchPath = `brands_int_test_${Math.random().toString(36).substring(7)}`;
    const searchPathOption = `-c search_path=${searchPath}`;
    url.searchParams.set(
      "options",
      existingOptions
        ? `${existingOptions} ${searchPathOption}`
        : searchPathOption,
    );
    process.env.DATABASE_URL = url.toString();
    (globalThis as any).__TEST_SCHEMA_NAME__ = searchPath;
  }
});

const actualSchemaName = (globalThis as any).__TEST_SCHEMA_NAME__;

// Now import app components
import brandsRouter from "./brands";
import { query, closeDb } from "../db/index";
import { errorHandler } from "../middleware/error";

function signToken(userId: string, email: string) {
  return jwt.sign({ sub: userId, email }, JWT_SECRET);
}

describe("Brands Routes Integration", () => {
  let app: express.Express;
  let testUser: { id: string; email: string; token: string };

  beforeAll(async () => {
    try {
      // 1. Create Schema
      await query(`CREATE SCHEMA IF NOT EXISTS ${actualSchemaName}`);

      // 2. Initialize Tables (using root init.sql)
      const initSqlPath = path.resolve(__dirname, "../../../../../init.sql");
      const initSql = readFileSync(initSqlPath, "utf8");
      await query(initSql);

      // 3. Create test user
      const userId = randomUUID();
      const email = `brand-owner-${randomUUID().slice(0, 8)}@example.com`;
      await query(
        `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, $4)`,
        [userId, email, "Brand Owner", "brand"],
      );
      testUser = { id: userId, email, token: signToken(userId, email) };
    } catch (error) {
      console.error("Test setup failed (is Postgres running?):", error);
      throw error;
    }

    // Setup App
    app = express();
    app.use(express.json());
    app.use("/brands", brandsRouter);
    app.use(errorHandler);
  });

  afterAll(async () => {
    try {
      await query(`DROP SCHEMA IF EXISTS ${actualSchemaName} CASCADE`);
    } catch (e) {
      // ignore teardown errors
    }
    await closeDb();
  });

  describe("POST /brands", () => {
    it("creates a brand with valid payload (201)", async () => {
      const payload = {
        name: "Acme Corp",
        tagline: "The best in the west",
        primaryColor: "#ff0000",
        logoKey: "logo.png",
        productImage1Key: "product-1.png",
        productImage2Key: "product-2.png",
      };

      const res = await request(app)
        .post("/brands")
        .set("Authorization", `Bearer ${testUser.token}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.brand).toMatchObject({
        name: "Acme Corp",
        tagline: "The best in the west",
        primary_color: "#ff0000",
        logo_url: "https://storage.example.com/brand-assets/optimized.webp",
        product_image_keys: ["optimized.webp", "optimized.webp"],
        product_image_urls: [
          "https://storage.example.com/brand-assets/optimized.webp",
          "https://storage.example.com/brand-assets/optimized.webp",
        ],
      });

      const dbRes = await query("SELECT * FROM brands WHERE id = $1 /* include_deleted */", [
        res.body.brand.id,
      ]);
      expect(dbRes.rows[0].name).toBe("Acme Corp");
      expect(dbRes.rows[0].product_image_keys).toEqual([
        "optimized.webp",
        "optimized.webp",
      ]);
    });

    it("returns 400 for invalid payload (missing name)", async () => {
      const res = await request(app)
        .post("/brands")
        .set("Authorization", `Bearer ${testUser.token}`)
        .send({ tagline: "Missing name" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Required");
    });
  });

  describe("GET /brands", () => {
    it("lists brands owned by user", async () => {
      await query(`INSERT INTO brands (owner_user_id, name) VALUES ($1, $2)`, [
        testUser.id,
        "Second Brand",
      ]);

      const res = await request(app)
        .get("/brands")
        .set("Authorization", `Bearer ${testUser.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.brands)).toBe(true);
      expect(res.body.brands.some((b: any) => b.name === "Acme Corp")).toBe(
        true,
      );
      expect(res.body.brands.some((b: any) => b.name === "Second Brand")).toBe(
        true,
      );
      expect(
        res.body.brands.every((b: any) => Array.isArray(b.product_image_urls)),
      ).toBe(true);
    });
  });

  describe("GET /brands/:id", () => {
    it("returns the brand kit for the owner", async () => {
      const brandRes = await query(
        `INSERT INTO brands (owner_user_id, name) VALUES ($1, $2) RETURNING id`,
        [testUser.id, "Fetch Me"],
      );
      const brandId = brandRes.rows[0].id;

      const res = await request(app)
        .get(`/brands/${brandId}`)
        .set("Authorization", `Bearer ${testUser.token}`);

      expect(res.status).toBe(200);
      expect(res.body.brand.name).toBe("Fetch Me");
      expect(res.body.brand.product_image_urls).toEqual([]);
    });

    it("returns 403 for non-owner", async () => {
      const otherId = randomUUID();
      await query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
        [otherId, "other2@test.com", "Other"],
      );
      const brandRes = await query(
        `INSERT INTO brands (owner_user_id, name) VALUES ($1, $2) RETURNING id`,
        [otherId, "Secret Brand"],
      );
      const brandId = brandRes.rows[0].id;

      const res = await request(app)
        .get(`/brands/${brandId}`)
        .set("Authorization", `Bearer ${testUser.token}`);

      expect(res.status).toBe(403);
    });

    it("returns 404 for missing brand", async () => {
      const res = await request(app)
        .get(`/brands/${randomUUID()}`)
        .set("Authorization", `Bearer ${testUser.token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("POST /brands/challenges", () => {
    it("generates questions and persists them in challenge_questions", async () => {
      const brandRes = await query(
        `INSERT INTO brands (owner_user_id, name, tagline, usp) VALUES ($1, $2, $3, $4) RETURNING id`,
        [testUser.id, "Challenge Brand", "Top Tagline", "Unique USP"],
      );
      const brandId = brandRes.rows[0].id;

      const payload = {
        brandId,
        poolAmountUsdc: "100.50",
        maxPlayers: 50,
      };

      const res = await request(app)
        .post("/brands/challenges")
        .set("Authorization", `Bearer ${testUser.token}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.challenge.brand_id).toBe(brandId);

      const challengeId = res.body.challenge.id;

      const qRes = await query(
        "SELECT * FROM challenge_questions WHERE challenge_id = $1 ORDER BY round",
        [challengeId],
      );
      expect(qRes.rows.length).toBe(3);
      expect(qRes.rows[0].round).toBe(1);
    });
  });

  describe("SVG sanitization", () => {
    it("escapes XML entities in brand name before storage", async () => {
      const payload = {
        name: 'Ben & Jerry\'s <Brand>"',
        tagline: "The <best> & most \"trusted\" brand",
      };

      const res = await request(app)
        .post("/brands")
        .set("Authorization", `Bearer ${testUser.token}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.brand.name).toBe("Ben &amp; Jerry&apos;s &lt;Brand&gt;&quot;");
      expect(res.body.brand.tagline).toBe("The &lt;best&gt; &amp; most &quot;trusted&quot; brand");
    });

    it("preserves plain text without XML entities", async () => {
      const payload = {
        name: "Acme Corp",
        tagline: "Simply the best",
      };

      const res = await request(app)
        .post("/brands")
        .set("Authorization", `Bearer ${testUser.token}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.brand.name).toBe("Acme Corp");
      expect(res.body.brand.tagline).toBe("Simply the best");
    });
  });

  describe("Unauthenticated access", () => {
    it("returns 401 for GET /brands", async () => {
      const res = await request(app).get("/brands");
      expect(res.status).toBe(401);
    });
  });
});
