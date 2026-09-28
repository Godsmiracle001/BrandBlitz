import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/error";

const mocks = vi.hoisted(() => ({
  getJobCounts: vi.fn(),
  getJobLogs: vi.fn(),
  getJobs: vi.fn(),
  getJob: vi.fn(),
  query: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  redisExists: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(function QueueMock() {
    return {
      getJobCounts: mocks.getJobCounts,
      getJobLogs: mocks.getJobLogs,
      getJobs: mocks.getJobs,
      getJob: mocks.getJob,
    };
  }),
  Worker: vi.fn(function WorkerMock() {}),
}));

vi.mock("../../middleware/authenticate", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { sub: "admin-1", role: "admin" } as express.Request["user"];
    next();
  },
}));

vi.mock("../../db/index", () => ({
  query: mocks.query,
  pool: { connect: vi.fn() },
}));

vi.mock("../../lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
    exists: mocks.redisExists,
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import queueStatsRouter, { RETRYABLE_QUEUE_NAMES } from "./queue-stats";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/queue-stats", queueStatsRouter);
  app.use(errorHandler);
  return app;
}

function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    name: "process-payout",
    attemptsMade: 5,
    failedReason: "boom",
    finishedOn: Date.now(),
    getState: vi.fn().mockResolvedValue("failed"),
    retry: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("GET /admin/queue-stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
    mocks.getJobCounts.mockResolvedValue({
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
    });
    mocks.getJobLogs.mockResolvedValue({ logs: [], count: 250 });
  });

  it("returns all queue counts and lag without caching", async () => {
    const response = await request(createApp()).get("/admin/queue-stats");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.body.queues)).toEqual([
      "payout",
      "league",
      "gdpr-erasure",
      "referral-bonus",
      "session-timeout",
      "archive",
    ]);
    expect(response.body.queues.payout).toEqual({
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
      lag: 250,
    });
    expect(mocks.getJobCounts).toHaveBeenCalledTimes(6);
    expect(mocks.getJobLogs).toHaveBeenCalledTimes(6);
  });

  it("marks only an unreachable queue as unavailable", async () => {
    mocks.getJobCounts.mockRejectedValueOnce(new Error("Redis unavailable"));
    const response = await request(createApp()).get("/admin/queue-stats");
    expect(response.status).toBe(200);
    expect(response.body.queues.payout).toEqual({ error: "unavailable" });
    expect(response.body.queues.league.waiting).toBe(1);
  });
});

describe("GET /admin/queue-stats/failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
    mocks.getJobs.mockResolvedValue([]);
  });

  it("lists failed jobs with retryability flags", async () => {
    const payoutJob = makeJob({ id: "payout:abc", finishedOn: 1_700_000_000_000 });
    const erasureJob = makeJob({ id: "erasure-1", finishedOn: 1_700_000_100_000 });

    mocks.getJobs.mockImplementation(async (types: string[]) => {
      expect(types).toEqual(["failed"]);
      // First queue iterated is payout, then league, gdpr-erasure, ...
      if (mocks.getJobs.mock.calls.length === 1) return [payoutJob];
      if (mocks.getJobs.mock.calls.length === 3) return [erasureJob];
      return [];
    });

    const response = await request(createApp()).get("/admin/queue-stats/failed");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const jobs = response.body.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);

    const payoutRow = jobs.find((j) => j.id === "payout:abc")!;
    expect(payoutRow.queue).toBe("payout");
    expect(payoutRow.retryable).toBe(true);
    expect(payoutRow.failedReason).toBe("boom");

    const erasureRow = jobs.find((j) => j.id === "erasure-1")!;
    expect(erasureRow.queue).toBe("gdpr-erasure");
    expect(erasureRow.retryable).toBe(false);
  });

  it("returns an empty list when queues are healthy", async () => {
    const response = await request(createApp()).get("/admin/queue-stats/failed");
    expect(response.status).toBe(200);
    expect(response.body.jobs).toEqual([]);
  });
});

describe("POST /admin/queue-stats/:jobId/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("rejects queues outside the retry allowlist", async () => {
    const response = await request(createApp())
      .post("/admin/queue-stats/job-1/retry")
      .send({ queue: "gdpr-erasure" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("QUEUE_NOT_RETRYABLE");
    expect(mocks.getJob).not.toHaveBeenCalled();
  });

  it("rejects requests without a queue name", async () => {
    const response = await request(createApp()).post("/admin/queue-stats/job-1/retry").send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the job does not exist", async () => {
    mocks.getJob.mockResolvedValue(null);

    const response = await request(createApp())
      .post("/admin/queue-stats/missing-job/retry")
      .send({ queue: "payout" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("JOB_NOT_FOUND");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 409 when the job is not in the failed state", async () => {
    mocks.getJob.mockResolvedValue(makeJob({ getState: vi.fn().mockResolvedValue("active") }));

    const response = await request(createApp())
      .post("/admin/queue-stats/job-1/retry")
      .send({ queue: "payout" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("JOB_NOT_FAILED");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("retries a failed job and audit logs job id + admin id", async () => {
    const job = makeJob();
    mocks.getJob.mockResolvedValue(job);

    const response = await request(createApp())
      .post("/admin/queue-stats/job-1/retry")
      .send({ queue: "payout" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, jobId: "job-1", queue: "payout" });
    expect(job.retry).toHaveBeenCalledTimes(1);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO audit_log");
    expect(sql).toContain("queue_job_retry");
    expect(params[0]).toBe("admin-1"); // actor/admin id
    expect(params[1]).toBe("job-1"); // job id
    const metadata = JSON.parse(params[2] as string);
    expect(metadata).toMatchObject({
      jobId: "job-1",
      queue: "payout",
      adminId: "admin-1",
    });
  });

  it("keeps gdpr-erasure off the allowlist", () => {
    expect(RETRYABLE_QUEUE_NAMES).not.toContain("gdpr-erasure");
    expect(RETRYABLE_QUEUE_NAMES).toContain("payout");
  });
});
