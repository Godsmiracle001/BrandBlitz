import type { Express } from "express";
import { beforeAll, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { PERMISSIONS_POLICY_HEADER } from "@brandblitz/config";

let app: Express;

vi.mock("@brandblitz/stellar", () => ({
  MIN_POOL_STROOPS: 1_000_000_000,
  WARMUP_MIN_SECONDS: 10,
  EscrowClient: vi.fn(),
  feeBumpTransaction: vi.fn(),
  getHorizonServer: vi.fn(),
  getAccountUsdcBalance: vi.fn(),
  submitBatchPayout: vi.fn(),
  drainSharedAgent: vi.fn(),
}));

vi.mock("./routes/admin/escrow", () => ({
  default: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("./routes/admin", () => ({
  default: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("./routes/docs", () => ({
  default: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("./lib/redis", () => ({
  redis: {
    call: vi.fn(),
    sendCommand: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(["0", []]),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  },
  connectRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./middleware/rate-limit", () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  challengeStartLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  uploadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  webhookLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  phoneRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  webhookRotationLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

describe("Helmet Security Headers", () => {
  beforeAll(async () => {
    app = (await import("./index")).app;
  });

  it("should include security headers on health endpoint", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    
    const csp = response.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets Permissions-Policy disabling camera, microphone, geolocation, payment", async () => {
    const response = await request(app).get("/health");
    const pp = response.headers["permissions-policy"];
    expect(pp).toBeDefined();
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("geolocation=()");
    expect(pp).toContain("payment=()");
    expect(pp).toBe(PERMISSIONS_POLICY_HEADER);
  });

  it.each(["/sessions", "/leaderboard/global", "/challenges"])(
    "sets Referrer-Policy on %s",
    async (path) => {
      const response = await request(app).get(path);

      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    }
  );
});
