import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { configSchema } from "../config-schema";

// ── Full valid env fixture ────────────────────────────────────────────────────

const VALID_ENV = {
  NODE_ENV: "test",
  PORT: "3001",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-jwt-secret-that-is-at-least-32-chars-long",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  WEB_URL: "http://localhost:3000",
  ALLOWED_ORIGINS: "http://localhost:3000",
  HOT_WALLET_SECRET: "test-stellar-secret-56chars-placeholder-value-for-testing",
  HOT_WALLET_PUBLIC_KEY: "test-stellar-public-key-56chars-placeholder-value-test",
  WEBHOOK_SECRET: "test-webhook-secret-value",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "test-s3-access-key",
  S3_SECRET_ACCESS_KEY: "test-s3-secret-key",
  S3_PUBLIC_URL: "http://localhost:9000/bucket",
  PHONE_HASH_SALT: "test-phone-hash-salt-16ch",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("config schema validation (Issue #410)", () => {
  // Save and restore process.env to prevent cross-test pollution
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Reset to a clean valid baseline for each test
    for (const key of Object.keys(process.env)) {
      if (!(key in VALID_ENV)) {
        delete (process.env as any)[key];
      }
    }
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    // Restore original process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete (process.env as any)[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  // ── AC 1: omitting DATABASE_URL throws with identifying message ───────────

  describe("DATABASE_URL is required", () => {
    it("throws a validation error when DATABASE_URL is missing", () => {
      const { DATABASE_URL, ...envWithoutDb } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutDb);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("DATABASE_URL");
      }
    });

    it("error message identifies the missing variable", () => {
      const { DATABASE_URL, ...envWithoutDb } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutDb);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod identifies missing fields via the path array
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("DATABASE_URL");
      }
    });
  });

  // ── AC 2: omitting REDIS_URL throws before queue/cache code runs ──────────

  describe("REDIS_URL is required", () => {
    it("throws a validation error when REDIS_URL is missing", () => {
      const { REDIS_URL, ...envWithoutRedis } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutRedis);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("REDIS_URL");
      }
    });
  });

  // ── AC 3: omitting STELLAR_SECRET_KEY (HOT_WALLET_SECRET) throws ─────────

  describe("HOT_WALLET_SECRET is required ( Stellar secret key )", () => {
    it("throws a validation error when HOT_WALLET_SECRET is missing", () => {
      const { HOT_WALLET_SECRET, ...envWithoutStellar } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutStellar);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("HOT_WALLET_SECRET");
      }
    });
  });

  // ── AC 4: all required vars present → successful construction ────────────

  describe("all required env vars present", () => {
    it("parses successfully with correct types", () => {
      const result = configSchema.safeParse(VALID_ENV);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.DATABASE_URL).toBe("string");
        expect(typeof result.data.REDIS_URL).toBe("string");
        expect(typeof result.data.PORT).toBe("number");
        expect(result.data.PORT).toBe(3001);
        expect(typeof result.data.HOT_WALLET_SECRET).toBe("string");
        expect(typeof result.data.JWT_SECRET).toBe("string");
        expect(typeof result.data.WEBHOOK_SECRET).toBe("string");
      }
    });
  });

  // ── AC 5: invalid PORT value throws validation error ─────────────────────

  describe("PORT validation", () => {
    it("throws a validation error when PORT is 'abc' (non-numeric)", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, PORT: "abc" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("PORT");
      }
    });

    it("does not silently default to NaN for invalid PORT", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, PORT: "abc" });
      expect(result.success).toBe(false);
    });

    it("coerces a valid numeric string PORT to a number", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, PORT: "8080" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
        expect(typeof result.data.PORT).toBe("number");
      }
    });
  });

  // ── AC 6: optional env vars do not cause a throw when absent ─────────────

  describe("optional env vars", () => {
    it("does not throw when SENTRY_DSN is absent", () => {
      const { SENTRY_DSN, ...envWithoutSentry } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutSentry);
      expect(result.success).toBe(true);
    });

    it("does not throw when optional Twilio vars are absent", () => {
      const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SERVICE_SID, TWILIO_VERIFY_SERVICE_SID, ...envWithoutTwilio } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutTwilio);
      expect(result.success).toBe(true);
    });

    it("does not throw when SESSION_INTEGRITY_KEY is absent", () => {
      const { SESSION_INTEGRITY_KEY, ...envWithoutIntegrity } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutIntegrity);
      expect(result.success).toBe(true);
    });

    it("does not throw when PHONE_HASH_SALT is absent", () => {
      const { PHONE_HASH_SALT, ...envWithoutSalt } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutSalt);
      expect(result.success).toBe(true);
    });
  });

  // ── Default values ──────────────────────────────────────────────────────

  describe("default values", () => {
    it("defaults NODE_ENV to 'development' when not provided", () => {
      const { NODE_ENV, ...envWithoutNodeEnv } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutNodeEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe("development");
      }
    });

    it("defaults PORT to 3001 when not provided", () => {
      const { PORT, ...envWithoutPort } = VALID_ENV;
      const result = configSchema.safeParse(envWithoutPort);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(3001);
      }
    });
  });

  // ── ALLOWED_ORIGINS validation ──────────────────────────────────────────

  describe("ALLOWED_ORIGINS validation", () => {
    it("rejects wildcard '*' as a value", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, ALLOWED_ORIGINS: "*" });
      expect(result.success).toBe(false);
    });

    it("transforms comma-separated origins into an array", () => {
      const result = configSchema.safeParse({
        ...VALID_ENV,
        ALLOWED_ORIGINS: "http://a.com, http://b.com",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALLOWED_ORIGINS).toEqual(["http://a.com", "http://b.com"]);
      }
    });

    it("throws when ALLOWED_ORIGINS is empty", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, ALLOWED_ORIGINS: "" });
      expect(result.success).toBe(false);
    });
  });

  // ── STELLAR_NETWORK validation ──────────────────────────────────────────

  describe("STELLAR_NETWORK validation", () => {
    it("accepts 'testnet'", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, STELLAR_NETWORK: "testnet" });
      expect(result.success).toBe(true);
    });

    it("accepts 'public'", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, STELLAR_NETWORK: "public" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid network values", () => {
      const result = configSchema.safeParse({ ...VALID_ENV, STELLAR_NETWORK: "devnet" });
      expect(result.success).toBe(false);
    });
  });
});
