import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  redisScan: vi.fn(),
  redisDel: vi.fn(),
  metricsInc: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mocks.dbQuery,
}));

vi.mock("../lib/redis", () => ({
  redis: {
    scan: mocks.redisScan,
    del: mocks.redisDel,
  },
}));

vi.mock("../lib/metrics", () => ({
  metrics: { inc: mocks.metricsInc },
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return {
    add: mocks.queueAdd,
    };
  }),
  Worker: vi.fn(function Worker() {
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { refreshLeaderboardView, enqueueLeaderboardRefresh } from "./leaderboard-refresh.queue";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("refreshLeaderboardView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: single scan iteration returns no keys
    mocks.redisScan.mockResolvedValue(["0", []]);
  });

  it("calls REFRESH MATERIALIZED VIEW CONCURRENTLY", async () => {
    await refreshLeaderboardView();

    expect(mocks.dbQuery).toHaveBeenCalledWith(
      "REFRESH MATERIALIZED VIEW CONCURRENTLY v_leaderboard_global"
    );
  });

  it("increments the refresh metric", async () => {
    await refreshLeaderboardView();

    expect(mocks.metricsInc).toHaveBeenCalledWith("leaderboard.view_refresh_total");
  });

  it("deletes all leaderboard:global:* Redis keys found by SCAN", async () => {
    mocks.redisScan
      .mockResolvedValueOnce(["42", ["leaderboard:global:50:0", "leaderboard:global:20:0"]])
      .mockResolvedValueOnce(["0", []]);

    await refreshLeaderboardView();

    expect(mocks.redisDel).toHaveBeenCalledWith(
      "leaderboard:global:50:0",
      "leaderboard:global:20:0"
    );
  });

  it("does not call del when no matching keys exist", async () => {
    mocks.redisScan.mockResolvedValue(["0", []]);

    await refreshLeaderboardView();

    expect(mocks.redisDel).not.toHaveBeenCalled();
  });

  it("iterates SCAN until cursor returns to 0", async () => {
    mocks.redisScan
      .mockResolvedValueOnce(["1", ["leaderboard:global:50:0"]])
      .mockResolvedValueOnce(["2", ["leaderboard:global:100:0"]])
      .mockResolvedValueOnce(["0", []]);

    await refreshLeaderboardView();

    expect(mocks.redisScan).toHaveBeenCalledTimes(3);
    expect(mocks.redisDel).toHaveBeenCalledTimes(2);
  });
});

describe("enqueueLeaderboardRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a refresh job to the queue with the challengeId", async () => {
    mocks.queueAdd.mockResolvedValue({ id: "job-1" });

    await enqueueLeaderboardRefresh("challenge-xyz");

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "refresh",
      { challengeId: "challenge-xyz" },
      expect.objectContaining({ attempts: 3 })
    );
  });
});
