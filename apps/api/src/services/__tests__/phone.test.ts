import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  redisIncr: vi.fn(),
  redisExpire: vi.fn(),
  redisDel: vi.fn(),
  createFraudFlag: vi.fn(),
}));

vi.mock("../../db/index", () => ({
  query: mocks.query,
}));

vi.mock("../../lib/redis", () => ({
  redis: {
    incr: mocks.redisIncr,
    expire: mocks.redisExpire,
    del: mocks.redisDel,
  },
}));

vi.mock("../../db/queries/fraud-flags", () => ({
  createFraudFlag: mocks.createFraudFlag,
}));

const mockCreateVerification = vi.fn();
vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: mockCreateVerification },
        })),
      },
    },
  })),
}));

vi.mock("../../lib/config", () => ({
  config: {
    TWILIO_ACCOUNT_SID: "AC_test",
    TWILIO_AUTH_TOKEN: "test_token",
    TWILIO_VERIFY_SERVICE_SID: "VA_test",
    PHONE_HASH_SALT: "test-phone-hash-salt-16",
  },
}));

vi.mock("../../middleware/error", () => ({
  createError: (message: string, statusCode: number, code?: string) => {
    const err = new Error(message) as any;
    err.statusCode = statusCode;
    err.code = code;
    return err;
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  sendOtp,
  verifyOtp,
  generateOtpCode,
  OTP_LENGTH,
  OTP_EXPIRY_SECONDS,
  OTP_HASH_ROUNDS,
  OTP_MAX_ATTEMPTS,
  OTP_WINDOW_SECONDS,
} from "../phone";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("phone service — OTP flow (Issue #400)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisIncr.mockResolvedValue(1);
    mocks.redisExpire.mockResolvedValue(1);
    mocks.redisDel.mockResolvedValue(1);
    mocks.createFraudFlag.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [] });
    mockCreateVerification.mockResolvedValue({ sid: "VSxxx" });
  });

  // ── generateOtpCode ───────────────────────────────────────────────────────

  describe("generateOtpCode", () => {
    it("generates a numeric string of the configured length", () => {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d+$/);
      expect(code).toHaveLength(OTP_LENGTH);
    });

    it("generates codes within the valid numeric range", () => {
      for (let i = 0; i < 50; i++) {
        const code = generateOtpCode();
        const num = parseInt(code, 10);
        expect(num).toBeGreaterThanOrEqual(10 ** (OTP_LENGTH - 1));
        expect(num).toBeLessThanOrEqual(10 ** OTP_LENGTH - 1);
      }
    });
  });

  // ── sendOtp ──────────────────────────────────────────────────────────────

  describe("sendOtp", () => {
    it("generates a numeric OTP and hashes it with bcrypt before storing", async () => {
      const code = await sendOtp("user-1", "+15551234567");

      // OTP should be a numeric string of correct length
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(OTP_LENGTH);

      // The DB call should have been made with a bcrypt hash
      expect(mocks.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.query.mock.calls[0];
      expect(sql).toContain("UPDATE users");
      const storedHash = params[0] as string;
      expect(storedHash).toMatch(/^\$2[abs]\$/); // bcrypt prefix
      expect(storedHash).not.toBe(code); // raw code never stored
    });

    it("persists hash and expiry to the users row", async () => {
      await sendOtp("user-1", "+15551234567");

      const [sql, params] = mocks.query.mock.calls[0];
      expect(sql).toContain("otp_hash");
      expect(sql).toContain("otp_expires_at");
      expect(sql).toContain(`${OTP_EXPIRY_SECONDS} seconds`);
      expect(params[1]).toBe("user-1");
    });

    it("the raw OTP value is never logged or stored in plaintext", async () => {
      const code = await sendOtp("user-1", "+15551234567");

      // Scan all DB params — none should equal the raw code
      for (const call of mocks.query.mock.calls) {
        const params = call[1] as unknown[];
        for (const param of params) {
          if (typeof param === "string") {
            expect(param).not.toBe(code);
          }
        }
      }
    });

    it("sends the verification code via Twilio", async () => {
      await sendOtp("user-1", "+15551234567");

      expect(mockCreateVerification).toHaveBeenCalledWith({
        to: "+15551234567",
        channel: "sms",
      });
    });

    it("returns the plaintext OTP for the caller to deliver", async () => {
      const code = await sendOtp("user-1", "+15551234567");
      expect(typeof code).toBe("string");
      expect(code).toHaveLength(OTP_LENGTH);
    });
  });

  // ── verifyOtp ────────────────────────────────────────────────────────────

  describe("verifyOtp", () => {
    it("returns true when the submitted code matches the stored hash within the TTL", async () => {
      const code = "123456";
      const hash = await bcrypt.hash(code, OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query
        .mockResolvedValueOnce({ rows: [{ otp_hash: hash, otp_expires_at: futureDate }] })
        .mockResolvedValueOnce({ rows: [] }); // clear query

      const result = await verifyOtp("user-1", code);

      expect(result).toBe(true);
      // OTP should be cleared on success
      expect(mocks.query).toHaveBeenCalledTimes(2);
      const clearSql = mocks.query.mock.calls[1][0] as string;
      expect(clearSql).toContain("otp_hash = NULL");
      expect(clearSql).toContain("otp_expires_at = NULL");
    });

    it("returns false when the OTP has passed its expiry timestamp", async () => {
      const code = "123456";
      const hash = await bcrypt.hash(code, OTP_HASH_ROUNDS);
      const pastDate = new Date(Date.now() - 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: hash, otp_expires_at: pastDate }],
      });

      const result = await verifyOtp("user-1", code);

      expect(result).toBe(false);
      // No DB write should occur (no clear, no increment)
      expect(mocks.query).toHaveBeenCalledTimes(1);
    });

    it("returns false for a code that does not match the stored hash", async () => {
      const storedHash = await bcrypt.hash("123456", OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: storedHash, otp_expires_at: futureDate }],
      });
      mocks.redisIncr.mockResolvedValue(1);

      const result = await verifyOtp("user-1", "999999");

      expect(result).toBe(false);
    });

    it("increments the Redis failed-attempt counter on wrong code", async () => {
      const storedHash = await bcrypt.hash("123456", OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: storedHash, otp_expires_at: futureDate }],
      });
      mocks.redisIncr.mockResolvedValue(2);

      await verifyOtp("user-1", "999999");

      expect(mocks.redisIncr).toHaveBeenCalledWith("otp_user_attempts:user-1");
    });

    it("sets a TTL on the Redis key on first failed attempt", async () => {
      const storedHash = await bcrypt.hash("123456", OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: storedHash, otp_expires_at: futureDate }],
      });
      mocks.redisIncr.mockResolvedValue(1); // first attempt

      await verifyOtp("user-1", "999999");

      expect(mocks.redisExpire).toHaveBeenCalledWith(
        "otp_user_attempts:user-1",
        OTP_WINDOW_SECONDS,
      );
    });

    it("does not set TTL on subsequent failed attempts (only on first)", async () => {
      const storedHash = await bcrypt.hash("123456", OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: storedHash, otp_expires_at: futureDate }],
      });
      mocks.redisIncr.mockResolvedValue(3); // not first attempt

      await verifyOtp("user-1", "999999");

      expect(mocks.redisExpire).not.toHaveBeenCalled();
    });

    it("flags the account in fraud_flags after configurable number of failed attempts", async () => {
      const storedHash = await bcrypt.hash("123456", OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: storedHash, otp_expires_at: futureDate }],
      });
      mocks.redisIncr.mockResolvedValue(OTP_MAX_ATTEMPTS);

      await verifyOtp("user-1", "999999");

      expect(mocks.createFraudFlag).toHaveBeenCalledWith({
        sessionId: "otp-brute-force",
        userId: "user-1",
        flagType: "otp_brute_force",
        details: { attempts: OTP_MAX_ATTEMPTS },
      });
    });

    it("does not flag the account before reaching the max attempts threshold", async () => {
      const storedHash = await bcrypt.hash("123456", OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: storedHash, otp_expires_at: futureDate }],
      });
      mocks.redisIncr.mockResolvedValue(OTP_MAX_ATTEMPTS - 1);

      await verifyOtp("user-1", "999999");

      expect(mocks.createFraudFlag).not.toHaveBeenCalled();
    });

    it("returns false when no OTP hash exists for the user", async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{ otp_hash: null, otp_expires_at: null }],
      });

      const result = await verifyOtp("user-1", "123456");

      expect(result).toBe(false);
    });

    it("returns false when the user row does not exist", async () => {
      mocks.query.mockResolvedValueOnce({ rows: [] });

      const result = await verifyOtp("nonexistent", "123456");

      expect(result).toBe(false);
    });

    it("clears the OTP hash after successful verification", async () => {
      const code = "654321";
      const hash = await bcrypt.hash(code, OTP_HASH_ROUNDS);
      const futureDate = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000).toISOString();

      mocks.query
        .mockResolvedValueOnce({ rows: [{ otp_hash: hash, otp_expires_at: futureDate }] })
        .mockResolvedValueOnce({ rows: [] });

      await verifyOtp("user-1", code);

      const clearCall = mocks.query.mock.calls[1];
      expect(clearCall[0]).toContain("otp_hash = NULL");
      expect(clearCall[0]).toContain("otp_expires_at = NULL");
      expect(clearCall[1]).toEqual(["user-1"]);
    });
  });
});
