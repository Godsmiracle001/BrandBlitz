/**
 * config.test.ts — Unit tests for the Zod-validated config module.
 *
 * Uses a separate .env.test file (loaded via vitest env) so the real
 * process.env is never polluted between test runs.
 *
 * Closes #96
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ZodError } from "zod";
import { configSchema } from "./config-schema";

// ── Minimal valid env fixture ─────────────────────────────────────────────────

const VALID_ENV: Record<string, string> = {
  PORT: "3001",
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "a-very-long-jwt-secret-that-is-at-least-32-chars",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  WEB_URL: "http://localhost:3000",
  ALLOWED_ORIGINS: "http://localhost:3000",
  STELLAR_NETWORK: "testnet",
  HOT_WALLET_SECRET: "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  HOT_WALLET_PUBLIC_KEY: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  WEBHOOK_SECRET: "webhook-secret-value",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
  S3_PUBLIC_URL: "http://localhost:9000/bucket",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("configSchema — valid env", () => {
  it("parses a complete valid env without throwing", () => {
    const result = configSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
  });

  it("applies defaults for optional numeric fields", () => {
    const result = configSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.PORT).toBe(3001);
    expect(result.data.DB_POOL_MAX).toBe(10);
    expect(result.data.PAYOUT_WORKER_CONCURRENCY).toBe(2);
    expect(result.data.GOOGLE_OAUTH_PKCE_TTL_SECONDS).toBe(300);
    expect(result.data.REFERRER_POLICY).toBe("strict-origin-when-cross-origin");
  });

  it("coerces PORT from string to number", () => {
    const result = configSchema.safeParse({ ...VALID_ENV, PORT: "4000" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.PORT).toBe(4000);
  });

  it("accepts testnet and public for STELLAR_NETWORK", () => {
    for (const network of ["testnet", "public"] as const) {
      const result = configSchema.safeParse({ ...VALID_ENV, STELLAR_NETWORK: network });
      expect(result.success).toBe(true);
    }
  });

  it("defaults E2E_MOCK_GOOGLE_OAUTH to 'false'", () => {
    const result = configSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.E2E_MOCK_GOOGLE_OAUTH).toBe("false");
  });
});

describe("configSchema — missing required vars", () => {
  it("throws ZodError when DATABASE_URL is absent", () => {
    const { DATABASE_URL: _omit, ...env } = VALID_ENV;
    const result = configSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("DATABASE_URL");
  });

  it("throws ZodError when JWT_SECRET is too short", () => {
    const result = configSchema.safeParse({ ...VALID_ENV, JWT_SECRET: "short" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("JWT_SECRET");
  });

  it("throws ZodError when multiple required vars are missing", () => {
    const { DATABASE_URL: _db, REDIS_URL: _redis, JWT_SECRET: _jwt, ...env } = VALID_ENV;
    const result = configSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("DATABASE_URL");
    expect(paths).toContain("REDIS_URL");
    expect(paths).toContain("JWT_SECRET");
  });

  it("rejects an invalid NODE_ENV value", () => {
    const result = configSchema.safeParse({ ...VALID_ENV, NODE_ENV: "staging" });
    expect(result.success).toBe(false);
  });
});

describe("loadConfig — process.exit on invalid env", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("calls process.exit(1) when a required var is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    // Provide an env missing DATABASE_URL
    const { DATABASE_URL: _omit, ...partialEnv } = VALID_ENV;
    vi.stubEnv("DATABASE_URL", "");
    for (const [k, v] of Object.entries(partialEnv)) {
      vi.stubEnv(k, v);
    }

    // config.ts logs the validation failure via a local winston logger
    // (not the shared ../lib/logger — see config.ts's comment on why that
    // would be a circular import) whose Console transport writes through
    // console.log by default.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Re-import the module so loadConfig() runs with the stubbed env
    await expect(import("./config?bust=" + Date.now())).rejects.toThrow(
      "process.exit called"
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalled();
    const loggedOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(loggedOutput).toContain("Invalid or missing environment variables");
  });

  it("logs a hint to run pnpm setup:secrets and lists missing required keys", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    const { DATABASE_URL: _db, JWT_SECRET: _jwt, ...partialEnv } = VALID_ENV;
    for (const [k, v] of Object.entries(partialEnv)) {
      vi.stubEnv(k, v);
    }
    // Simulate truly missing vars (undefined, not empty string) so the
    // "Missing required env vars" line is exercised.
    vi.stubEnv("DATABASE_URL", undefined as unknown as string);
    vi.stubEnv("JWT_SECRET", undefined as unknown as string);
    // vi.stubEnv with undefined may leave the key as "undefined" string on some
    // Vitest versions — delete to guarantee it's absent.
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;

    await expect(import("./config?bust-hint-" + Date.now())).rejects.toThrow(
      "process.exit called"
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("Missing required env vars");
    expect(errorOutput).toContain("DATABASE_URL");
    expect(errorOutput).toContain("JWT_SECRET");
    expect(errorOutput).toContain("pnpm setup:secrets");
    expect(errorOutput).toContain("scripts/setup-dev-secrets.ts");
    expect(errorOutput).toContain(".env.example");
  });
});
