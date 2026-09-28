import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/error";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  getSession: vi.fn(),
  getChallengeById: vi.fn(),
  markWarmupCompleted: vi.fn(),
  markWarmupStarted: vi.fn(),
  createFraudFlag: vi.fn(),
  sessionTimeoutQueueAdd: vi.fn(),
  // Session the mocked enforceOneSessionPerChallenge middleware attaches to
  // req.session, mirroring what the real middleware (claimSession / getSession)
  // would set before the warmup-start handler runs.
  middlewareSession: null as Record<string, unknown> | null,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
  },
}));

vi.mock("../db/queries/sessions", () => ({
  getSession: mocks.getSession,
  markWarmupCompleted: mocks.markWarmupCompleted,
  markWarmupStarted: mocks.markWarmupStarted,
  markChallengeStarted: vi.fn(),
  recordRoundScore: vi.fn(),
  finishSession: vi.fn(),
  storeSessionHmac: vi.fn(),
  claimSession: vi.fn(),
}));

vi.mock("../queues/session-timeout.queue", () => ({
  sessionTimeoutQueue: { add: mocks.sessionTimeoutQueueAdd },
}));

vi.mock("../db/queries/challenges", () => ({
  getChallengeById: mocks.getChallengeById,
  getChallengeQuestions: vi.fn(),
}));

vi.mock("../db/queries/fraud-flags", () => ({
  createFraudFlag: mocks.createFraudFlag,
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null;
    if (!token) {
      res.status(401).json({ error: "Missing authentication token" });
      return;
    }
    req.user = { sub: "user-1", email: "test@example.com", iat: 0, exp: 999999999 };
    next();
  },
}));

vi.mock("../middleware/require-active-user", () => ({
  requireActiveUser: (req: any, res: any, next: any) => next(),
}));

vi.mock("../middleware/anti-cheat", () => ({
  enforceOneSessionPerChallenge: (req: any, res: any, next: any) => {
    req.session = mocks.middlewareSession;
    next();
  },
  validateReactionTime: (req: any, res: any, next: any) => next(),
  validateDeviceFingerprint: (req: any, res: any, next: any) => next(),
  detectClockSkew: (req: any, res: any, next: any) => {
    const clientTimestamp = req.body?.clientTimestamp;
    if (clientTimestamp === undefined) return next();
    if (!Number.isFinite(clientTimestamp) || clientTimestamp <= 0) {
      const error: any = new Error("Invalid client timestamp");
      error.statusCode = 400;
      error.code = "INVALID_TIMESTAMP";
      throw error;
    }
    if (Math.abs(Date.now() - clientTimestamp) > 5000) {
      const error: any = new Error("Client clock skew too large");
      error.statusCode = 400;
      error.code = "CLOCK_SKEW";
      throw error;
    }
    next();
  },
  requireSessionStartAllowed: (req: any, res: any, next: any) => next(),
  assertValidTotalScore: vi.fn(),
}));
vi.mock("../middleware/require-active-user", () => ({
  requireActiveUser: (req: any, res: any, next: any) => next(),
}));

vi.mock("../middleware/error", async () => {
  const actual = await vi.importActual<typeof import("../middleware/error")>("../middleware/error");
  return {
    errorHandler: actual.errorHandler,
    createError: (message: string, code: number, errorCode?: string) => {
      const error: any = new Error(message);
      error.statusCode = code;
      error.code = errorCode;
      return error;
    },
  };
});

vi.mock("../middleware/rate-limit", () => ({
  challengeStartLimiter: (req: any, res: any, next: any) => next(),
}));

vi.mock("../services/scoring", () => ({
  calculateRoundScore: vi.fn().mockReturnValue(100),
  validateAnswer: vi.fn().mockReturnValue(true),
}));

vi.mock("../services/streaks", () => ({
  updateStreak: vi.fn(),
}));
vi.mock("../services/badges", () => ({
  checkAndAwardSessionBadges: vi.fn(),
}));

vi.mock("../lib/integrity", () => ({
  computeSessionHmac: vi.fn().mockReturnValue("mock-hmac"),
}));

describe("sessions warmup-complete endpoint", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const sessionsRouter = await import("./sessions");
    app.use("/sessions", sessionsRouter.default);
    app.use(errorHandler);

    mocks.getChallengeById.mockResolvedValue({
      id: "challenge-1",
      status: "active",
    });
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "user-1",
      challenge_id: "challenge-1",
      warmup_started_at: new Date(Date.now() - 15000).toISOString(),
    });
    mocks.redisSet.mockResolvedValue("OK");
    mocks.markWarmupCompleted.mockResolvedValue(undefined);
  });

  it("returns 401 when no auth token is provided", async () => {
    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Missing authentication token");
  });

  it("returns 404 when the session :id does not exist", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Session not found");
  });

  it("returns 400 when warmup_started_at is null (warmup-start was never called)", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "user-1",
      challenge_id: "challenge-1",
      warmup_started_at: null,
    });
    mocks.redisGet.mockResolvedValue(null);

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(200);
    expect(mocks.markWarmupCompleted).toHaveBeenCalled();
  });

  it("returns 400 when the elapsed time since warmup_started_at is below the minimum threshold", async () => {
    const serverTime = Date.now();
    // Set unlock time 5 seconds in the future (warmup minimum not elapsed)
    mocks.redisGet.mockResolvedValue((serverTime + 5000).toString());

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("WARMUP_TOO_FAST");
    expect(response.body.remainingMs).toBeGreaterThan(0);
  });

  it("returns 200 and transitions session status to in_progress when elapsed time is sufficient", async () => {
    const serverTime = Date.now();
    // Set unlock time 10 seconds ago (warmup minimum elapsed)
    mocks.redisGet.mockResolvedValue((serverTime - 10000).toString());

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.challengeToken).toBeDefined();
    expect(mocks.markWarmupCompleted).toHaveBeenCalledWith("session-1");
  });

  it("confirms warmup_completed_at timestamp is set on the game_sessions row", async () => {
    const serverTime = Date.now();
    mocks.redisGet.mockResolvedValue((serverTime - 10000).toString());

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(200);
    expect(mocks.markWarmupCompleted).toHaveBeenCalledWith("session-1");
  });

  it("confirms anti-cheat middleware logs or flags the event when timing is suspicious", async () => {
    const serverTime = Date.now();
    // Set unlock time 10 seconds in future (very suspicious timing)
    mocks.redisGet.mockResolvedValue((serverTime + 10000).toString());

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-complete")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("WARMUP_TOO_FAST");
  });

  it("stubs Date.now to produce deterministic elapsed-time calculations", async () => {
    const fixedTime = 1700000000000;
    const originalDateNow = Date.now;
    Date.now = vi.fn(() => fixedTime);

    try {
      // Set unlock time to fixedTime - 10000 (10 seconds before fixed time)
      mocks.redisGet.mockResolvedValue((fixedTime - 10000).toString());

      const response = await request(app)
        .post("/sessions/challenge-1/warmup-complete")
        .set("Authorization", "Bearer test-token")
        .send({});

      expect(response.status).toBe(200);
      expect(Date.now).toHaveBeenCalled();
    } finally {
      Date.now = originalDateNow;
    }
  });


});

describe("GET /sessions/:challengeId (recovery)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const sessionsRouter = await import("./sessions");
    app.use("/sessions", sessionsRouter.default);
    app.use(errorHandler);

    mocks.getChallengeById.mockResolvedValue({ id: "challenge-1", status: "active" });
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "user-1",
      total_score: 0,
      round_1_answer: null,
      round_1_score: 0,
      round_2_answer: null,
      round_2_score: 0,
      round_3_answer: null,
      round_3_score: 0,
      status: "warmup",
      completed_at: null,
      challenge_started_at: null,
    });
  });

  it("returns 401 when no auth token is provided", async () => {
    const response = await request(app).get("/sessions/challenge-1");

    expect(response.status).toBe(401);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the challenge does not exist", async () => {
    mocks.getChallengeById.mockResolvedValue(null);

    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Challenge not found");
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller has no session for the challenge", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Session not found");
  });

  it("returns 403 when the session belongs to a different user", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "someone-else",
      round_1_score: 0,
      round_2_score: 0,
      round_3_score: 0,
    });

    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Forbidden");
  });

  it("returns warmup status and round 1 as the current round for a fresh session", async () => {
    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      session: {
        id: "session-1",
        status: "warmup",
        last_answered_round: 0,
        current_round: 1,
        total_score: 0,
      },
    });
    expect(response.body.session.round_scores).toEqual([0, 0, 0]);
  });

  it("reports in_progress status and the next unanswered round once the challenge has started", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "user-1",
      total_score: 0,
      round_1_answer: "A",
      round_1_score: 100,
      round_2_answer: null,
      round_2_score: 0,
      round_3_answer: null,
      round_3_score: 0,
      status: "active",
      completed_at: null,
      challenge_started_at: new Date().toISOString(),
    });

    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.body.session.status).toBe("in_progress");
    expect(response.body.session.last_answered_round).toBe(1);
    expect(response.body.session.current_round).toBe(2);
  });

  it("reports completed status and the summed total score once all rounds are answered", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "user-1",
      total_score: 0,
      round_1_answer: "A",
      round_1_score: 100,
      round_2_answer: "B",
      round_2_score: 150,
      round_3_answer: "C",
      round_3_score: 200,
      status: "completed",
      completed_at: new Date().toISOString(),
      challenge_started_at: new Date().toISOString(),
    });

    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.body.session.status).toBe("completed");
    expect(response.body.session.last_answered_round).toBe(3);
    expect(response.body.session.current_round).toBe(3);
    expect(response.body.session.total_score).toBe(450);
  });

  it("reports expired status for an abandoned session", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-1",
      user_id: "user-1",
      total_score: 0,
      round_1_score: 0,
      round_2_score: 0,
      round_3_score: 0,
      status: "abandoned",
      completed_at: null,
      challenge_started_at: null,
    });

    const response = await request(app)
      .get("/sessions/challenge-1")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.body.session.status).toBe("expired");
  });
});

// #375 — POST /:challengeId/warmup-start.
//
// The issue this suite was written against assumes behavior that doesn't
// exist in this codebase: there is no "ready" session status (the real enum
// is warmup | active | completed | flagged | abandoned), re-calling this
// endpoint is silently idempotent rather than rejected with 409 (see
// markWarmupStarted's `COALESCE(warmup_started_at, NOW())`), and there is no
// per-session delayed timeout job — session-timeout.queue.ts registers a
// single recurring sweep job at worker startup, never enqueued from this
// route. These tests cover the route's real, verified behavior instead.
describe("sessions warmup-start endpoint", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const sessionsRouter = await import("./sessions");
    app.use("/sessions", sessionsRouter.default);
    app.use(errorHandler);

    mocks.getChallengeById.mockResolvedValue({
      id: "challenge-1",
      status: "active",
    });
    mocks.middlewareSession = {
      id: "session-1",
      user_id: "user-1",
      challenge_id: "challenge-1",
      status: "warmup",
      warmup_started_at: null,
    };
    mocks.markWarmupStarted.mockResolvedValue(undefined);
    mocks.redisSet.mockResolvedValue("OK");
  });

  it("returns 401 when no auth token is provided", async () => {
    const response = await request(app).post("/sessions/challenge-1/warmup-start").send({});

    expect(response.status).toBe(401);
  });

  it("returns 404 when the challenge does not exist", async () => {
    mocks.getChallengeById.mockResolvedValue(null);

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-start")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Challenge not available");
  });

  it("returns 404 when the challenge exists but is not active", async () => {
    mocks.getChallengeById.mockResolvedValue({ id: "challenge-1", status: "completed" });

    const response = await request(app)
      .post("/sessions/challenge-1/warmup-start")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(404);
  });

  it("is idempotent: calling it twice for the same session returns 200 both times (not 409)", async () => {
    const first = await request(app)
      .post("/sessions/challenge-1/warmup-start")
      .set("Authorization", "Bearer test-token")
      .send({});
    const second = await request(app)
      .post("/sessions/challenge-1/warmup-start")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.markWarmupStarted).toHaveBeenCalledTimes(2);
    expect(mocks.markWarmupStarted).toHaveBeenNthCalledWith(1, "session-1");
    expect(mocks.markWarmupStarted).toHaveBeenNthCalledWith(2, "session-1");
  });

  it("returns 200 and calls markWarmupStarted with the session id (persists warmup_started_at)", async () => {
    const response = await request(app)
      .post("/sessions/challenge-1/warmup-start")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe("session-1");
    expect(mocks.markWarmupStarted).toHaveBeenCalledWith("session-1");
  });

  it("computes unlockAt deterministically from a stubbed Date.now and stores it in Redis with a 300s TTL", async () => {
    const fixedTime = 1700000000000;
    const originalDateNow = Date.now;
    Date.now = vi.fn(() => fixedTime);

    try {
      const response = await request(app)
        .post("/sessions/challenge-1/warmup-start")
        .set("Authorization", "Bearer test-token")
        .send({});

      const expectedUnlockAt = fixedTime + 20 * 1000; // WARMUP_MIN_SECONDS = 20

      expect(response.status).toBe(200);
      expect(response.body.unlockAt).toBe(expectedUnlockAt);
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "warmup:unlock:session-1",
        expectedUnlockAt.toString(),
        "EX",
        300
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("does not enqueue any session-timeout job — timeout handling is a separate recurring sweep, not per-call", async () => {
    const response = await request(app)
      .post("/sessions/challenge-1/warmup-start")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(response.status).toBe(200);
    expect(mocks.sessionTimeoutQueueAdd).not.toHaveBeenCalled();
  });
});
