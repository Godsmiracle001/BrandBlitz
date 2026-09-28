import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLeagueWorker } from "./league.processor";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  seedWeekAssignments: vi.fn(),
  leagueQueueAdd: vi.fn(),
  getUtcWeekStart: vi.fn(),
  addUtcDays: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../../db", () => ({
  query: mocks.query,
}));

vi.mock("../../db/queries/leagues", () => ({
  seedWeekAssignments: mocks.seedWeekAssignments,
}));

vi.mock("../league.queue", () => ({
  leagueQueue: {
    add: mocks.leagueQueueAdd,
  },
}));

vi.mock("../../lib/week", () => ({
  getUtcWeekStart: mocks.getUtcWeekStart,
  addUtcDays: mocks.addUtcDays,
}));

vi.mock("../../lib/redis", () => ({
  redis: {},
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

describe("league worker start-week handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUtcWeekStart.mockReturnValue("2026-07-27");
    mocks.addUtcDays.mockReturnValue("2026-08-03");
    mocks.leagueQueueAdd.mockResolvedValue({});
    mocks.seedWeekAssignments.mockResolvedValue(undefined);
  });

  it("defers week seeding when active sessions are still in progress", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ count: "3" }] });

    const WorkerCtor = vi.fn().mockImplementation(() => ({ close: vi.fn() }));
    createLeagueWorker(WorkerCtor as any);

    const processor = WorkerCtor.mock.calls[0][1];
    await processor({ name: "start-week", id: "job-1" });

    expect(mocks.seedWeekAssignments).not.toHaveBeenCalled();
    expect(mocks.leagueQueueAdd).toHaveBeenCalledWith(
      "start-week",
      {},
      expect.objectContaining({
        jobId: "league:start-week:deferred:2026-07-27",
        delay: 30 * 60 * 1000,
      }),
    );
  });

  it("seeds the week immediately when no active sessions need a grace period", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const WorkerCtor = vi.fn().mockImplementation(() => ({ close: vi.fn() }));
    createLeagueWorker(WorkerCtor as any);

    const processor = WorkerCtor.mock.calls[0][1];
    await processor({ name: "start-week", id: "job-2" });

    expect(mocks.seedWeekAssignments).toHaveBeenCalledWith("2026-07-27");
    expect(mocks.leagueQueueAdd).not.toHaveBeenCalled();
  });
});
