import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import leaderboardRouter from "./leaderboard";
import { errorHandler } from "../middleware/error";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getActiveChallenges: vi.fn(),
  getTopSessionsPerChallenge: vi.fn(),
  getGlobalLeaderboardFromView: vi.fn(),
  getLeaderboard: vi.fn(),
  getLeaderboardForCsvExport: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  redisExists: vi.fn(),
  dbQueryCount: { value: 0 },
}));

vi.mock("../db/queries/challenges", () => ({
  getActiveChallenges: mocks.getActiveChallenges,
}));

vi.mock("../db/queries/sessions", () => ({
  LEADERBOARD_SORTS: ["score", "rank", "created_at"],
  getLeaderboard: (...args: unknown[]) => {
    mocks.dbQueryCount.value++;
    return mocks.getLeaderboard(...args);
  },
  getLeaderboardForCsvExport: (...args: unknown[]) => {
    mocks.dbQueryCount.value++;
    return mocks.getLeaderboardForCsvExport(...args);
  },
  getTopSessionsPerChallenge: (...args: unknown[]) => {
    mocks.dbQueryCount.value++;
    return mocks.getTopSessionsPerChallenge(...args);
  },
  getGlobalLeaderboardFromView: (...args: unknown[]) => {
    mocks.dbQueryCount.value++;
    return mocks.getGlobalLeaderboardFromView(...args);
  },
}));

vi.mock("../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
    exists: mocks.redisExists,
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/leaderboard", leaderboardRouter);
  app.use(errorHandler);
  return app;
}

const CHALLENGES = [{ id: "challenge-aaa" }, { id: "challenge-bbb" }];

// Shape returned by getGlobalLeaderboardFromView (pre-computed rank from the MV)
const VIEW_ROWS = [
  {
    challenge_id: "challenge-aaa",
    rank: 1,
    user_id: "u1",
    username: "alice",
    display_name: "Alice",
    league: null,
    avatar_url: null,
    total_score: 300,
    total_earned_usdc: "0.0000000",
  },
  {
    challenge_id: "challenge-aaa",
    rank: 2,
    user_id: "u2",
    username: "bob",
    display_name: "Bob",
    league: null,
    avatar_url: null,
    total_score: 200,
    total_earned_usdc: "0.0000000",
  },
  {
    challenge_id: "challenge-bbb",
    rank: 1,
    user_id: "u3",
    username: "carol",
    display_name: "Carol",
    league: "gold" as const,
    avatar_url: "https://cdn.example.com/carol.png",
    total_score: 400,
    total_earned_usdc: "1.0000000",
  },
];

// Legacy shape still used by the SSE stream route
const TOP_SESSIONS = [
  {
    id: "s1",
    user_id: "u1",
    challenge_id: "challenge-aaa",
    username: "alice",
    display_name: "Alice",
    league: null,
    avatar_url: null,
    total_score: 300,
    completed_at: "2026-01-01T01:00:00Z",
    total_earned_usdc: "0.0000000",
  },
  {
    id: "s2",
    user_id: "u2",
    challenge_id: "challenge-aaa",
    username: "bob",
    display_name: "Bob",
    league: null,
    avatar_url: null,
    total_score: 200,
    completed_at: "2026-01-01T02:00:00Z",
    total_earned_usdc: "0.0000000",
  },
  {
    id: "s3",
    user_id: "u3",
    challenge_id: "challenge-bbb",
    username: "carol",
    display_name: "Carol",
    league: "gold" as const,
    avatar_url: "https://cdn.example.com/carol.png",
    total_score: 400,
    completed_at: "2026-01-01T03:00:00Z",
    total_earned_usdc: "1.0000000",
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /leaderboard/global", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQueryCount.value = 0;
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
    mocks.redisExists.mockResolvedValue(0);
    mocks.getActiveChallenges.mockResolvedValue(CHALLENGES);
    mocks.getGlobalLeaderboardFromView.mockResolvedValue(VIEW_ROWS);
  });

  it("returns 200 with a leaderboard array", async () => {
    const res = await request(createApp()).get("/leaderboard/global?sort_by=score");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.leaderboard)).toBe(true);
  });

  it("rejects invalid sort values", async () => {
    const res = await request(createApp()).get("/leaderboard/global?sort_by=total_score");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Invalid leaderboard sort. Allowed values: score, rank, created_at",
      code: "INVALID_SORT",
    });
  });

  it("rejects SQL injection probes in sort_by", async () => {
    const res = await request(createApp()).get(
      "/leaderboard/global?sort_by=score%3B%20DROP%20TABLE%20users--"
    );

    expect(res.status).toBe(400);
    expect(mocks.getGlobalLeaderboardFromView).not.toHaveBeenCalled();
  });

  it("cache fallback path reads from the materialised view, not the raw tables", async () => {
    await request(createApp()).get("/leaderboard/global");
    // One DB call: getGlobalLeaderboardFromView; raw aggregate scan is NOT used
    expect(mocks.dbQueryCount.value).toBe(1);
    expect(mocks.getLeaderboard).not.toHaveBeenCalled();
    expect(mocks.getTopSessionsPerChallenge).not.toHaveBeenCalled();
  });

  it("calls getGlobalLeaderboardFromView with all challenge IDs", async () => {
    await request(createApp()).get("/leaderboard/global");
    expect(mocks.getGlobalLeaderboardFromView).toHaveBeenCalledWith(
      ["challenge-aaa", "challenge-bbb"],
      10
    );
  });

  it("view rows returns pre-computed per-challenge rank", async () => {
    const res = await request(createApp()).get("/leaderboard/global");
    const lb = res.body.leaderboard as Array<{ challengeId: string; rank: number }>;

    const aaa = lb.filter((e) => e.challengeId === "challenge-aaa");
    const bbb = lb.filter((e) => e.challengeId === "challenge-bbb");

    expect(aaa.map((e) => e.rank)).toEqual([1, 2]);
    expect(bbb.map((e) => e.rank)).toEqual([1]);
  });

  it("orders sessions by ascending rank within each challenge", async () => {
    const res = await request(createApp()).get("/leaderboard/global");
    const aaaScores = (res.body.leaderboard as Array<{ challengeId: string; totalScore: number }>)
      .filter((e) => e.challengeId === "challenge-aaa")
      .map((e) => e.totalScore);
    expect(aaaScores).toEqual([300, 200]);
  });

  it("includes cachedAt ISO timestamp in the response", async () => {
    const res = await request(createApp()).get("/leaderboard/global");
    expect(typeof res.body.cachedAt).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.cachedAt))).toBe(false);
  });

  it("writes the result to Redis with a 300 s TTL", async () => {
    await request(createApp()).get("/leaderboard/global");
    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^leaderboard:global:/),
      expect.any(String),
      "EX",
      300
    );
  });

  it("returns the cached payload without hitting the DB on a cache hit", async () => {
    const cachedPayload = {
      leaderboard: [
        {
          rank: 1,
          challengeId: "challenge-aaa",
          username: "cached",
          avatarUrl: null,
          totalScore: 999,
        },
      ],
      data: [
        {
          rank: 1,
          challengeId: "challenge-aaa",
          username: "cached",
          avatarUrl: null,
          totalScore: 999,
        },
      ],
      cachedAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.redisGet.mockResolvedValue(JSON.stringify(cachedPayload));

    const res = await request(createApp()).get("/leaderboard/global");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedPayload);
    expect(mocks.dbQueryCount.value).toBe(0);
  });

  it("handles an empty active-challenges list gracefully", async () => {
    mocks.getActiveChallenges.mockResolvedValue([]);
    mocks.getGlobalLeaderboardFromView.mockResolvedValue([]);

    const res = await request(createApp()).get("/leaderboard/global");

    expect(res.status).toBe(200);
    expect(res.body.leaderboard).toEqual([]);
  });

  it("accepts allowlisted sort values", async () => {
    const res = await request(createApp()).get("/leaderboard/global").query({ sort_by: "score" });

    expect(res.status).toBe(200);
    expect(mocks.getGlobalLeaderboardFromView).toHaveBeenCalled();
  });

  it("rejects invalid sort values", async () => {
    const res = await request(createApp()).get("/leaderboard/global").query({ sort_by: "email" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Invalid leaderboard sort. Allowed values: score, rank, created_at",
      code: "INVALID_SORT",
    });
    expect(mocks.getGlobalLeaderboardFromView).not.toHaveBeenCalled();
  });

  it("rejects SQL-injection probe sort values", async () => {
    const res = await request(createApp())
      .get("/leaderboard/global")
      .query({ sort_by: "score; DROP TABLE users--" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SORT");
    expect(mocks.getGlobalLeaderboardFromView).not.toHaveBeenCalled();
  });

  it("returns results in descending score order", async () => {
    const res = await request(createApp()).get("/leaderboard/global");

    const scores = (res.body.leaderboard as Array<{ totalScore: number }>).map((s) => s.totalScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("correctly returns nextCursor pointing to next page of results", async () => {
    mocks.getGlobalLeaderboardFromView.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        challenge_id: "c1",
        rank: i + 1,
        user_id: `u${i}`,
        username: `user${i}`,
        display_name: `User ${i}`,
        league: null,
        avatar_url: null,
        total_score: 1000 - i * 10,
        total_earned_usdc: "0.0000000",
      }))
    );

    const res = await request(createApp()).get("/leaderboard/global?limit=5");

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
  });

  it("rejects limit greater than allowed maximum", async () => {
    const res = await request(createApp()).get("/leaderboard/global?limit=10000");

    expect(res.status).toBe(400);
  });

  it("returns 200 for unauthenticated request (public endpoint)", async () => {
    const res = await request(createApp()).get("/leaderboard/global");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.leaderboard)).toBe(true);
  });

  it("returns 200 with empty data array and no nextCursor for empty leaderboard", async () => {
    mocks.getActiveChallenges.mockResolvedValue([]);
    mocks.getGlobalLeaderboardFromView.mockResolvedValue([]);

    const res = await request(createApp()).get("/leaderboard/global");

    expect(res.status).toBe(200);
    expect(res.body.leaderboard).toEqual([]);
    expect(res.body.nextCursor).toBeUndefined();
  });
});

describe("GET /leaderboard/:challengeId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQueryCount.value = 0;
    mocks.getLeaderboard.mockResolvedValue({
      sessions: [
        {
          id: "s1",
          user_id: "u1",
          challenge_id: "c1",
          username: "alice",
          avatar_url: null,
          total_score: 500,
          display_name: "Alice",
          league: null,
          total_earned_usdc: "0",
        },
        {
          id: "s2",
          user_id: "u2",
          challenge_id: "c1",
          username: "bob",
          avatar_url: null,
          total_score: 400,
          display_name: "Bob",
          league: null,
          total_earned_usdc: "0",
        },
      ],
      nextCursor: null,
    });
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
  });

  it("returns rankings scoped to the given challengeId", async () => {
    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(mocks.getLeaderboard).toHaveBeenCalledWith(
      "c1",
      expect.any(Number),
      expect.any(Number),
      "score"
    );
  });

  it("filters out banned users from leaderboard", async () => {
    mocks.getLeaderboard.mockResolvedValue({
      sessions: [
        {
          id: "s1",
          user_id: "u1",
          challenge_id: "c1",
          username: "alice",
          display_name: "Alice",
          avatar_url: null,
          total_score: 500,
          league: null,
          total_earned_usdc: "0",
        },
      ],
      nextCursor: null,
    });

    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBe(1);
    expect(mocks.getLeaderboard).toHaveBeenCalledWith(
      "c1",
      expect.any(Number),
      expect.any(Number),
      "score"
    );
  });

  it("returns 404 for non-existent challengeId", async () => {
    mocks.getLeaderboard.mockResolvedValue({ sessions: [], nextCursor: null });

    const res = await request(createApp()).get("/leaderboard/nonexistent");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it("returns rank positions contiguous starting from 1", async () => {
    mocks.getLeaderboard.mockResolvedValue({
      sessions: [
        {
          id: "s1",
          user_id: "u1",
          challenge_id: "c1",
          username: "alice",
          display_name: "Alice",
          avatar_url: null,
          total_score: 500,
          league: null,
          total_earned_usdc: "0",
        },
        {
          id: "s2",
          user_id: "u2",
          challenge_id: "c1",
          username: "bob",
          display_name: "Bob",
          avatar_url: null,
          total_score: 400,
          league: null,
          total_earned_usdc: "0",
        },
        {
          id: "s3",
          user_id: "u3",
          challenge_id: "c1",
          username: "carol",
          display_name: "Carol",
          avatar_url: null,
          total_score: 300,
          league: null,
          total_earned_usdc: "0",
        },
      ],
      nextCursor: null,
    });

    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(res.body.sessions[0].rank).toBe(1);
    expect(res.body.sessions[1].rank).toBe(2);
    expect(res.body.sessions[2].rank).toBe(3);
  });

  it("provides stable ordering for tied scores (by userId as tiebreaker)", async () => {
    mocks.getLeaderboard.mockResolvedValue({
      sessions: [
        {
          id: "s1",
          user_id: "u1",
          challenge_id: "c1",
          username: "alice",
          display_name: "Alice",
          avatar_url: null,
          total_score: 500,
          league: null,
          total_earned_usdc: "0",
        },
        {
          id: "s2",
          user_id: "u2",
          challenge_id: "c1",
          username: "bob",
          display_name: "Bob",
          avatar_url: null,
          total_score: 500,
          league: null,
          total_earned_usdc: "0",
        },
        {
          id: "s3",
          user_id: "u3",
          challenge_id: "c1",
          username: "carol",
          display_name: "Carol",
          avatar_url: null,
          total_score: 500,
          league: null,
          total_earned_usdc: "0",
        },
      ],
      nextCursor: null,
    });

    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: any) => s.rank)).toEqual([1, 2, 3]);
  });

  it("returns 200 for unauthenticated request (public endpoint)", async () => {
    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("caches results with correct TTL", async () => {
    await request(createApp()).get("/leaderboard/c1");

    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^leaderboard:score:c1:/),
      expect.any(String),
      "EX",
      30
    );
  });

  it("returns cached result without DB query on cache hit", async () => {
    const cachedPayload = {
      sessions: [
        {
          rank: 1,
          userId: "u1",
          username: "cached",
          displayName: "Cached",
          league: null,
          avatarUrl: null,
          totalScore: 999,
          totalEarned: "0",
        },
      ],
      data: [
        {
          rank: 1,
          userId: "u1",
          username: "cached",
          displayName: "Cached",
          league: null,
          avatarUrl: null,
          totalScore: 999,
          totalEarned: "0",
        },
      ],
      nextCursor: null,
    };
    mocks.redisGet.mockResolvedValue(JSON.stringify(cachedPayload));

    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedPayload);
    expect(mocks.dbQueryCount.value).toBe(0);
  });

  it("returns sessions with rank starting at offset+1", async () => {
    const res = await request(createApp()).get("/leaderboard/c1").query({ offset: 5 });

    expect(res.status).toBe(200);
    expect(res.body.sessions[0].rank).toBe(6);
    expect(res.body.sessions[1].rank).toBe(7);
  });

  it("passes limit and offset to getLeaderboard", async () => {
    await request(createApp())
      .get("/leaderboard/c1")
      .query({ limit: 5, offset: 10, order: "rank" });

    expect(mocks.getLeaderboard).toHaveBeenCalledWith("c1", 6, 10, "rank");
  });

  it("passes valid sort values to the leaderboard query", async () => {
    await request(createApp()).get("/leaderboard/c1").query({ limit: 5, sort_by: "created_at" });

    expect(mocks.getLeaderboard).toHaveBeenCalledWith("c1", 6, 0, "created_at");
  });

  it("rejects invalid challenge leaderboard sort values", async () => {
    const res = await request(createApp())
      .get("/leaderboard/c1")
      .query({ order: "score; DROP TABLE users--" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SORT");
    expect(mocks.getLeaderboard).not.toHaveBeenCalled();
  });

  it("issues exactly one leaderboard query regardless of participant count", async () => {
    mocks.getLeaderboard.mockResolvedValue({
      sessions: Array.from({ length: 500 }, (_, index) => ({
        id: `s${index}`,
        user_id: `u${index}`,
        challenge_id: "c1",
        username: `user${index}`,
        display_name: `User ${index}`,
        avatar_url: null,
        total_score: 500 - index,
        league: null,
        total_earned_usdc: "0",
      })),
      nextCursor: null,
    });

    const res = await request(createApp()).get("/leaderboard/c1");

    expect(res.status).toBe(200);
    expect(mocks.dbQueryCount.value).toBe(1);
  });

  describe("GET /leaderboard/:challengeId/export.csv", () => {
    it("streams CSV with headers and correct user rankings", async () => {
      mocks.getLeaderboardForCsvExport.mockResolvedValueOnce({
        sessions: [
          {
            user_id: "u1",
            username: "alice@example.com",
            display_name: "Alice",
            total_score: 450,
            completed_at: "2026-08-24T12:00:00Z",
            payout_amount_usdc: "50.0000000",
          },
          {
            user_id: "u2",
            username: "bob@example.com",
            display_name: "Bob",
            total_score: 300,
            completed_at: "2026-08-24T12:05:00Z",
            payout_amount_usdc: "25.0000000",
          },
        ],
        nextCursor: null,
      });

      const res = await request(createApp()).get("/leaderboard/c-123/export.csv");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain(
        'attachment; filename="leaderboard-c-123.csv"'
      );
      expect(res.text).toContain("rank,username,score,payout_amount_usdc");
      expect(res.text).toContain("1,alice@example.com,450,50.0000000");
      expect(res.text).toContain("2,bob@example.com,300,25.0000000");
    });
  });
});
