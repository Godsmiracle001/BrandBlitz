import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateReactionTime, validateDeviceFingerprint, enforceOneSessionPerChallenge, BOT_REACTION_THRESHOLD_MS, MIN_HUMAN_REACTION_MS, validateRoundScore, assertValidTotalScore } from "./anti-cheat";
import * as fraudQueries from "../db/queries/fraud-flags";
import { metrics } from "../lib/metrics";
import * as sessionQueries from "../db/queries/sessions";

vi.mock("../db/queries/fraud-flags");
vi.mock("../db/queries/sessions");
vi.mock("../db/queries/config", () => ({ getConfig: vi.fn().mockResolvedValue(null) }));
vi.mock("../db/index", () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock("../lib/redis", () => ({
  redis: {
    sadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(1),
    get: vi.fn(),
    set: vi.fn(),
    ttl: vi.fn().mockResolvedValue(-2),
    incr: vi.fn().mockResolvedValue(1),
  },
}));
vi.mock("../lib/metrics", () => ({
  metrics: { inc: vi.fn() }
}));
vi.mock("../lib/fingerprint", () => ({
  computeFingerprint: vi.fn().mockReturnValue("test-fingerprint-hash"),
}));

import { redis } from "../lib/redis";
import { computeFingerprint } from "../lib/fingerprint";
import { requireSessionStartAllowed } from "./anti-cheat";
import { getConfig } from "../db/queries/config";
import { query } from "../db/index";

// A minimal Express-like response that records headers and dispatches the
// "finish" event the lockout middleware listens on.
function makeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
      return this;
    },
    emit(event: string) {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("anti-cheat middleware", () => {
  let req: any;
  let res: any;
  let next: any;

  beforeEach(() => {
    req = {
      body: {},
      user: { sub: "user-1" },
      params: { challengeId: "challenge-1" },
      headers: {
        "x-device-id": "device-abc",
      },
      ip: "1.2.3.4",
      sessionId: "session-1"
    };
    res = {};
    next = vi.fn();
    vi.clearAllMocks();
    (computeFingerprint as any).mockReturnValue("test-fingerprint-hash");
    (redis.sadd as any).mockResolvedValue(1);
    (redis.expire as any).mockResolvedValue(1);
    (redis.scard as any).mockResolvedValue(1);
  });

  describe("detectClockSkew", () => {
    it("allows request with no client timestamp", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      
      await detectClockSkew(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(fraudQueries.createFraudFlag).not.toHaveBeenCalled();
    });

    it("allows request with client timestamp within tolerance", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      req.body.clientTimestamp = Date.now();

      await detectClockSkew(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(fraudQueries.createFraudFlag).not.toHaveBeenCalled();
    });

    it("rejects negative client timestamp", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      req.body.clientTimestamp = -1000;

      await expect(detectClockSkew(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_TIMESTAMP",
      });

      expect(fraudQueries.createFraudFlag).toHaveBeenCalledWith(
        expect.objectContaining({
          flagType: "invalid_client_timestamp",
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects zero client timestamp", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      req.body.clientTimestamp = 0;

      await expect(detectClockSkew(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_TIMESTAMP",
      });
    });

    it("flags and rejects client timestamp >5 seconds in past", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      req.body.clientTimestamp = Date.now() - 10000; // 10 seconds ago

      await expect(detectClockSkew(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        code: "CLOCK_SKEW",
      });

      expect(fraudQueries.createFraudFlag).toHaveBeenCalledWith(
        expect.objectContaining({
          flagType: "clock_skew",
          details: expect.objectContaining({
            severity: "warning",
            clockSkewMs: expect.any(Number),
          }),
        })
      );
    });

    it("flags and rejects client timestamp >5 seconds in future", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      req.body.clientTimestamp = Date.now() + 10000; // 10 seconds in future

      await expect(detectClockSkew(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        code: "CLOCK_SKEW",
      });

      expect(fraudQueries.createFraudFlag).toHaveBeenCalledWith(
        expect.objectContaining({
          flagType: "clock_skew",
        })
      );
    });

    it("flags and rejects client timestamp 10+ minutes in past", async () => {
      const { detectClockSkew } = await import("./anti-cheat");
      req.body.clientTimestamp = Date.now() - 600000; // 10 minutes ago

      await expect(detectClockSkew(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        code: "CLOCK_SKEW",
      });
    });
  });

  describe("validateReactionTime", () => {
    it("blocks with 403 if reaction time is below bot threshold", async () => {
      req.body.reactionTimeMs = BOT_REACTION_THRESHOLD_MS - 1;

      await expect(validateReactionTime(req, res, next)).rejects.toMatchObject({
        statusCode: 403,
        code: "REACTION_IMPOSSIBLE"
      });

      expect(fraudQueries.createFraudFlag).toHaveBeenCalled();
      expect(metrics.inc).toHaveBeenCalledWith("antiCheat.flags_total", expect.objectContaining({ severity: "critical" }));
    });

    it("flags but allows if reaction time is between bot and human minimum", async () => {
      req.body.reactionTimeMs = MIN_HUMAN_REACTION_MS - 10;

      await validateReactionTime(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(fraudQueries.createFraudFlag).toHaveBeenCalled();
      expect(metrics.inc).toHaveBeenCalledWith("antiCheat.flags_total", expect.objectContaining({ severity: "warning" }));
    });

    it("flags with info severity if reaction time is above maximum", async () => {
      req.body.reactionTimeMs = 35000;

      await validateReactionTime(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(fraudQueries.createFraudFlag).toHaveBeenCalled();
      expect(metrics.inc).toHaveBeenCalledWith("antiCheat.flags_total", expect.objectContaining({ severity: "info" }));
    });
  });

  describe("validateDeviceFingerprint", () => {
    it("rejects with 400 when neither x-device-id nor x-visitor-id is provided", async () => {
      req.headers = {};

      await expect(validateDeviceFingerprint(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        code: "MISSING_DEVICE_ID",
      });
    });

    it("passes and calls next when fingerprint has <3 accounts", async () => {
      (redis.scard as any).mockResolvedValue(2);

      await validateDeviceFingerprint(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(metrics.inc).not.toHaveBeenCalledWith("antiCheat.fingerprint_collision_total", expect.anything());
    });

    it("rejects with 403 FINGERPRINT_COLLISION when fingerprint has >=3 accounts", async () => {
      (redis.scard as any).mockResolvedValue(3);

      await expect(validateDeviceFingerprint(req, res, next)).rejects.toMatchObject({
        statusCode: 403,
        code: "FINGERPRINT_COLLISION",
      });

      expect(metrics.inc).toHaveBeenCalledWith(
        "antiCheat.fingerprint_collision_total",
        expect.objectContaining({ fingerprint: expect.any(String) })
      );
    });

    it("combines x-visitor-id and x-device-id in the fingerprint", async () => {
      req.headers["x-visitor-id"] = "fp-visitor-id";
      (redis.scard as any).mockResolvedValue(1);

      await validateDeviceFingerprint(req, res, next);

      expect(computeFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({
          visitorId: "fp-visitor-id",
          deviceId: "device-abc",
        })
      );
    });

    it("normalizes IPv6 addresses before computing the fingerprint", async () => {
      req.ip = "2001:db8:abcd:ef12::1234";
      (redis.scard as any).mockResolvedValue(1);

      await validateDeviceFingerprint(req, res, next);

      expect(computeFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: "2001:db8:abcd:ef12::/64",
        })
      );
    });

    it("calls next without checking Redis when there is no authenticated user", async () => {
      req.user = undefined;

      await validateDeviceFingerprint(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(redis.sadd).not.toHaveBeenCalled();
    });

    it("fails open when Redis is unavailable", async () => {
      (redis.sadd as any).mockRejectedValue(new Error("Redis down"));

      await validateDeviceFingerprint(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe("enforceOneSessionPerChallenge", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("attaches new session to req and calls next when claimSession succeeds", async () => {
      const mockSession = { id: "s1", user_id: "user-1", challenge_id: "challenge-1" };
      (sessionQueries.claimSession as any).mockResolvedValue(mockSession);

      await enforceOneSessionPerChallenge(req, res, next);

      expect(sessionQueries.claimSession).toHaveBeenCalledWith({
        userId: "user-1",
        challengeId: "challenge-1",
        deviceId: "device-abc",
        isPractice: false,
      });
      expect((req as any).session).toEqual(mockSession);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("fetches existing session on conflict and attaches it to req", async () => {
      (sessionQueries.claimSession as any).mockResolvedValue(null);
      const existing = { id: "s1", user_id: "user-1", challenge_id: "challenge-1" };
      (sessionQueries.getSession as any).mockResolvedValue(existing);

      await enforceOneSessionPerChallenge(req, res, next);

      expect(sessionQueries.getSession).toHaveBeenCalledWith("user-1", "challenge-1");
      expect((req as any).session).toEqual(existing);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("throws 404 when claimSession fails AND no existing session found", async () => {
      (sessionQueries.claimSession as any).mockResolvedValue(null);
      (sessionQueries.getSession as any).mockResolvedValue(null);

      await expect(enforceOneSessionPerChallenge(req, res, next)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("validateRoundScore", () => {
    it("calls next when roundScore is not in body", async () => {
      req.body = {};
      await validateRoundScore(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("calls next for valid roundScore = 0", async () => {
      req.body.roundScore = 0;
      await validateRoundScore(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("calls next for valid roundScore = 150", async () => {
      req.body.roundScore = 150;
      await validateRoundScore(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("rejects with 422 when roundScore = 151", async () => {
      req.body.roundScore = 151;
      await expect(validateRoundScore(req, res, next)).rejects.toMatchObject({
        statusCode: 422,
        code: "ROUND_SCORE_OUT_OF_RANGE",
      });
      expect(fraudQueries.createFraudFlag).toHaveBeenCalled();
    });

    it("rejects with 422 when roundScore = -1", async () => {
      req.body.roundScore = -1;
      await expect(validateRoundScore(req, res, next)).rejects.toMatchObject({
        statusCode: 422,
        code: "ROUND_SCORE_OUT_OF_RANGE",
      });
      expect(fraudQueries.createFraudFlag).toHaveBeenCalled();
    });
  });

  describe("requireSessionStartAllowed", () => {
    let lockReq: any;
    let lockRes: ReturnType<typeof makeRes>;
    let lockNext: any;

    beforeEach(() => {
      vi.clearAllMocks();
      lockReq = { user: { sub: "user-1" } };
      lockRes = makeRes();
      lockNext = vi.fn();
      (getConfig as any).mockResolvedValue(null);
      (redis.get as any).mockResolvedValue(null);
      (redis.ttl as any).mockResolvedValue(-2);
      (redis.incr as any).mockResolvedValue(1);
      (redis.expire as any).mockResolvedValue(1);
      (query as any).mockResolvedValue({ rows: [] });
    });

    it("allows the request when under the threshold", async () => {
      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);
      expect(lockNext).toHaveBeenCalledTimes(1);
    });

    it("increments the failure counter only when the start attempt fails", async () => {
      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);

      lockRes.statusCode = 400;
      lockRes.emit("finish");
      await flush();

      expect(redis.incr).toHaveBeenCalledWith("lockout:session_start:user-1");
    });

    it("does NOT increment the counter on a successful start", async () => {
      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);

      lockRes.statusCode = 200;
      lockRes.emit("finish");
      await flush();

      expect(redis.incr).not.toHaveBeenCalled();
    });

    it("sets a 1-hour expiry when recording the first failure", async () => {
      (redis.incr as any).mockResolvedValue(1);
      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);

      lockRes.statusCode = 429;
      lockRes.emit("finish");
      await flush();

      expect(redis.expire).toHaveBeenCalledWith("lockout:session_start:user-1", 3600);
    });

    it("blocks with 429 and Retry-After once the threshold is reached", async () => {
      (redis.get as any).mockResolvedValue("10");
      (redis.ttl as any).mockResolvedValue(1800);

      await expect(
        requireSessionStartAllowed(lockReq, lockRes as any, lockNext)
      ).rejects.toMatchObject({ statusCode: 429, code: "SESSION_START_LOCKED" });

      expect(lockRes.headers["Retry-After"]).toBe("1800");
      expect(lockNext).not.toHaveBeenCalled();
    });

    it("writes a session_start_lockout audit event when the counter hits the threshold", async () => {
      (redis.get as any).mockResolvedValue("9");
      (redis.incr as any).mockResolvedValue(10);

      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);
      lockRes.statusCode = 400;
      lockRes.emit("finish");
      await flush();

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO audit_log"),
        expect.arrayContaining(["user-1"])
      );
      const auditCall = (query as any).mock.calls.find((c: any[]) =>
        String(c[0]).includes("session_start_lockout")
      );
      expect(auditCall).toBeDefined();
    });

    it("honours app_config overrides for threshold and window", async () => {
      (getConfig as any).mockResolvedValue({ threshold: 2, window_seconds: 60 });
      (redis.get as any).mockResolvedValue("2");
      (redis.ttl as any).mockResolvedValue(60);

      await expect(
        requireSessionStartAllowed(lockReq, lockRes as any, lockNext)
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(lockRes.headers["Retry-After"]).toBe("60");
    });

    it("fails open when Redis is unavailable", async () => {
      (redis.get as any).mockRejectedValue(new Error("Redis down"));

      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);

      expect(lockNext).toHaveBeenCalledTimes(1);
    });

    it("skips the check for unauthenticated requests", async () => {
      lockReq.user = undefined;

      await requireSessionStartAllowed(lockReq, lockRes as any, lockNext);

      expect(lockNext).toHaveBeenCalledTimes(1);
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  describe("assertValidTotalScore", () => {
    it("does not throw for score = 0", () => {
      expect(() => assertValidTotalScore(0)).not.toThrow();
    });

    it("does not throw for score = 450", () => {
      expect(() => assertValidTotalScore(450)).not.toThrow();
    });

    it("throws 422 for score = 451", () => {
      expect(() => assertValidTotalScore(451)).toThrow();
      try {
        assertValidTotalScore(451);
      } catch (err: any) {
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe("TOTAL_SCORE_OUT_OF_RANGE");
      }
    });

    it("throws 422 for score = -1", () => {
      expect(() => assertValidTotalScore(-1)).toThrow();
      try {
        assertValidTotalScore(-1);
      } catch (err: any) {
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe("TOTAL_SCORE_OUT_OF_RANGE");
      }
    });
  });
});
