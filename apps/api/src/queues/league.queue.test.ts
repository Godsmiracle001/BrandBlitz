import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureLeagueRepeatableJobs } from "./league.queue";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  queueAdd: vi.fn(),
  queueGetRepeatableJobs: vi.fn(),
  queueRemoveRepeatableByKey: vi.fn(),
}));

vi.mock("../lib/redis", () => ({
  redis: { connect: vi.fn() },
}));

vi.mock("../db/queries/config", () => ({
  getConfig: mocks.getConfig,
}));

// Mock the Queue class
vi.mock("bullmq", async () => {
  const actual = await vi.importActual("bullmq");
  return {
    ...actual,
    Queue: vi.fn().mockImplementation(() => ({
      add: mocks.queueAdd,
      getRepeatableJobs: mocks.queueGetRepeatableJobs,
      removeRepeatableByKey: mocks.queueRemoveRepeatableByKey,
    })),
  };
});

describe("league queue configurable schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueGetRepeatableJobs.mockResolvedValue([]);
    mocks.queueAdd.mockResolvedValue({});
    mocks.queueRemoveRepeatableByKey.mockResolvedValue(undefined);
  });

  it("uses default cron schedules when config is not set", async () => {
    mocks.getConfig.mockResolvedValue(null);

    await ensureLeagueRepeatableJobs();

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "finalize-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "59 23 * * 0", tz: "UTC" },
      })
    );

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "start-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "0 0 * * 1", tz: "UTC" },
      })
    );
  });

  it("uses custom cron schedule from app_config when available", async () => {
    mocks.getConfig
      .mockResolvedValueOnce({ cron: "30 22 * * 0" }) // Custom finalize
      .mockResolvedValueOnce({ cron: "15 0 * * 1" }); // Custom start

    await ensureLeagueRepeatableJobs();

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "finalize-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "30 22 * * 0", tz: "UTC" },
      })
    );

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "start-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "15 0 * * 1", tz: "UTC" },
      })
    );
  });

  it("removes existing repeatable jobs before adding new ones", async () => {
    const existingJobs = [
      { key: "old-finalize-key" },
      { key: "old-start-key" },
    ];

    mocks.queueGetRepeatableJobs.mockResolvedValue(existingJobs);
    mocks.getConfig.mockResolvedValue(null);

    await ensureLeagueRepeatableJobs();

    expect(mocks.queueRemoveRepeatableByKey).toHaveBeenCalledTimes(2);
    expect(mocks.queueRemoveRepeatableByKey).toHaveBeenCalledWith("old-finalize-key");
    expect(mocks.queueRemoveRepeatableByKey).toHaveBeenCalledWith("old-start-key");
  });

  it("falls back to defaults when config read fails", async () => {
    mocks.getConfig.mockRejectedValue(new Error("Redis unavailable"));

    await ensureLeagueRepeatableJobs();

    // Should still succeed with defaults
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "finalize-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "59 23 * * 0", tz: "UTC" },
      })
    );
  });

  it("allows runtime schedule updates without redeployment", async () => {
    // First call uses defaults
    mocks.getConfig.mockResolvedValue(null);
    await ensureLeagueRepeatableJobs();

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "finalize-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "59 23 * * 0", tz: "UTC" },
      })
    );

    vi.clearAllMocks();

    // Second call uses updated config
    mocks.getConfig.mockResolvedValue({ cron: "0 22 * * 0" });
    mocks.queueGetRepeatableJobs.mockResolvedValue([{ key: "existing-key" }]);

    await ensureLeagueRepeatableJobs();

    expect(mocks.queueRemoveRepeatableByKey).toHaveBeenCalled();
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "finalize-week",
      {},
      expect.objectContaining({
        repeat: { pattern: "0 22 * * 0", tz: "UTC" },
      })
    );
  });
});
