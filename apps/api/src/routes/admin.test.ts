import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error";
import adminRouter from "./admin";

const mocks = vi.hoisted(() => ({
  user: { sub: "admin-1", role: "admin" } as { sub: string; role: string } | null,
  query: vi.fn(),
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (mocks.user) req.user = mocks.user as express.Request["user"];
    next();
  },
}));

vi.mock("../db/index", () => ({ query: mocks.query }));
vi.mock("../db/queries/challenges", () => ({ getArchivedChallengeById: vi.fn() }));
vi.mock("../db/queries/config", () => ({ setConfig: vi.fn() }));
vi.mock("../queues/league.queue", () => ({ ensureLeagueRepeatableJobs: vi.fn() }));
vi.mock("../lib/config", () => ({ config: { NODE_ENV: "test" } }));

function createApp() {
  const app = express();
  app.use("/admin", adminRouter);
  app.use(errorHandler);
  return app;
}

const rows = [
  {
    id: "user-2",
    username: "risky",
    email: "risky@example.com",
    created_at: "2026-07-02T00:00:00.000Z",
    suspended_at: null,
    fraud_score: 5,
    total_payouts: 3,
  },
  {
    id: "user-1",
    username: null,
    email: "new@example.com",
    created_at: "2026-07-01T00:00:00.000Z",
    suspended_at: "2026-07-03T00:00:00.000Z",
    fraud_score: 2,
    total_payouts: 1,
  },
];

describe("GET /admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { sub: "admin-1", role: "admin" };
    mocks.query.mockResolvedValue({ rows });
  });

  it("returns cursor-paginated users with the default page size", async () => {
    mocks.query.mockResolvedValue({
      rows: Array.from({ length: 26 }, (_, index) => ({
        ...rows[index % rows.length],
        id: `user-${index}`,
        created_at: new Date(Date.UTC(2026, 6, 31 - index)).toISOString(),
      })),
    });

    const response = await request(createApp()).get("/admin/users");

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(25);
    expect(response.body.nextCursor).toEqual(expect.any(String));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $2"), [0, 26]);
  });

  it("filters by minimum fraud score", async () => {
    const response = await request(createApp()).get("/admin/users?minFraudScore=4&limit=10");

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("fraud_score >= $1"), [4, 11]);
    expect(response.body.users[0].fraudScore).toBe(5);
  });

  it("supports fraud-score ordering and cursor continuation", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ fraudScore: 5, createdAt: rows[0].created_at, id: rows[0].id })
    ).toString("base64url");

    const response = await request(createApp()).get(
      `/admin/users?orderBy=fraudScore&cursor=${cursor}&limit=25`
    );

    expect(response.status).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("ORDER BY fraud_score DESC, created_at DESC, id DESC");
    expect(params).toEqual([0, 5, rows[0].created_at, rows[0].id, 26]);
  });

  it("returns 403 for a non-admin caller", async () => {
    mocks.user = { sub: "player-1", role: "player" };

    const response = await request(createApp()).get("/admin/users");

    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
