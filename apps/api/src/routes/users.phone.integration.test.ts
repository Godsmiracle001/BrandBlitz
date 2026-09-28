import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `users_phone_integration_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

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
  return jwt.sign({ sub: userId, email }, JWT_SECRET, {
    expiresIn: "1h",
    issuer: process.env.JWT_ISSUER ?? "brandblitz-api",
    audience: process.env.JWT_AUDIENCE ?? "brandblitz-client",
  });
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

import usersRouter from "./users";
import { errorHandler } from "../middleware/error";

// Mock Twilio (only Twilio)
const mockTwilioVerifyCreate = vi.fn();
const mockTwilioVerificationCheckCreate = vi.fn();

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: mockTwilioVerifyCreate },
          verificationChecks: { create: mockTwilioVerificationCheckCreate },
        })),
      },
    },
  })),
}));

describeIntegration("Phone Verification Full Integration", () => {
  let app: express.Express;
  let query: typeof import("../../db/index").query;
  let closeDb: typeof import("../../db/index").closeDb;
  let redis: typeof import("../../lib/redis").redis;
  let userId: string;
  let userToken: string;

  beforeAll(async () => {
    const db = await import("../../db/index");
    query = db.query;
    closeDb = db.closeDb;
    redis = (await import("../../lib/redis")).redis;

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

    userId = randomUUID();
    await query(`INSERT INTO users (id, email, username, phone_verified) VALUES ($1, $2, $3, false)`, [userId, "phone-test@test.com", "phonetester"]);
    userToken = signToken(userId, "phone-test@test.com");
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

  it("sends an OTP via twilio and rate limits excess requests", async () => {
    mockTwilioVerifyCreate.mockResolvedValue({ status: "pending" });

    const phone = "+15551234567";

    // 1. Send OTP 1st time
    const res1 = await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ phone });
    expect(res1.status).toBe(200);

    // 2. Send OTP 2nd time
    const res2 = await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ phone });
    expect(res2.status).toBe(200);

    // 3. Send OTP 3rd time
    const res3 = await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ phone });
    expect(res3.status).toBe(200);

    // 4. Send OTP 4th time -> Rate limited
    const res4 = await request(app)
      .post("/users/me/phone/send")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ phone });
    expect(res4.status).toBe(429);
    
    expect(mockTwilioVerifyCreate).toHaveBeenCalledTimes(3);
  });

  it("verifies OTP and sets phone_verified = true in Postgres", async () => {
    const phone = "+15551234567";
    const code = "123456";

    mockTwilioVerificationCheckCreate.mockResolvedValueOnce({ status: "approved" });

    const res = await request(app)
      .post("/users/me/phone/verify")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ phone, code });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const userRow = await query(`SELECT phone_verified, phone_hash FROM users WHERE id = $1`, [userId]);
    expect(userRow.rows[0].phone_verified).toBe(true);
    expect(userRow.rows[0].phone_hash).not.toBeNull();
    
    // Also verify redis is updated
    const redisVal = await redis.get(`phone:hash:${userRow.rows[0].phone_hash}`);
    expect(redisVal).toBe(userId);
  });

  it("rejects invalid OTP with 400", async () => {
    const phone = "+15559999999";
    const code = "000000";

    mockTwilioVerificationCheckCreate.mockResolvedValueOnce({ status: "pending" }); // Not approved

    const res = await request(app)
      .post("/users/me/phone/verify")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ phone, code });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid verification code");
  });
});
