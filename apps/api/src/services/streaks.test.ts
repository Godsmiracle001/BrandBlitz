import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserStreak: vi.fn(),
  setUserStreak: vi.fn(),
  repairUserStreak: vi.fn(),
  metricsInc: vi.fn(),
}));

vi.mock("../db/queries/users", () => ({
  getUserStreak: mocks.getUserStreak,
  setUserStreak: mocks.setUserStreak,
  repairUserStreak: mocks.repairUserStreak,
}));

vi.mock("../lib/metrics", () => ({
  metrics: { inc: mocks.metricsInc },
}));

import { getStreak, repairStreak, updateStreak } from "./streaks";

describe("streaks service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments across three consecutive days and emits the 3-day milestone", async () => {
    mocks.getUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 2,
      last_play_day: "2026-05-29",
      streak_repairs_this_month: 0,
      streak_repair_available: false,
    });
    mocks.setUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 3,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 0,
      streak_repair_available: true,
    });

    const result = await updateStreak("user-1", new Date("2026-05-30T10:00:00Z"));

    expect(result.streak).toBe(3);
    expect(mocks.setUserStreak).toHaveBeenCalledWith({
      userId: "user-1",
      streak: 3,
      lastPlayDay: "2026-05-30",
      repairAvailable: true,
    });
    expect(mocks.metricsInc).toHaveBeenCalledWith("streaks.milestones_reached_total", {
      milestone: "3",
    });
  });

  it("resets the streak after a gap day", async () => {
    mocks.getUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 5,
      last_play_day: "2026-05-27",
      streak_repairs_this_month: 0,
      streak_repair_available: true,
    });
    mocks.setUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 1,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 0,
      streak_repair_available: false,
    });

    const result = await updateStreak("user-1", new Date("2026-05-30T10:00:00Z"));

    expect(result.streak).toBe(1);
    expect(mocks.setUserStreak).toHaveBeenCalledWith(expect.objectContaining({ streak: 1 }));
  });

  it("repairs a streak when the monthly repair is available", async () => {
    mocks.repairUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 7,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 1,
      streak_repair_available: false,
    });

    const result = await repairStreak("user-1", new Date("2026-05-30T10:00:00Z"));

    expect(result?.streak).toBe(7);
    expect(result?.repairAvailable).toBe(false);
    expect(mocks.repairUserStreak).toHaveBeenCalledWith("user-1", "2026-05-30");
  });

  it("returns null when the monthly repair limit is reached", async () => {
    mocks.repairUserStreak.mockResolvedValue(null);

    await expect(repairStreak("user-1", new Date("2026-05-30T10:00:00Z"))).resolves.toBeNull();
  });

  it("does not increment when the user already played today (UTC)", async () => {
    mocks.getUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 4,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 0,
      streak_repair_available: false,
    });

    const result = await updateStreak("user-1", new Date("2026-05-30T23:59:00Z"));

    expect(result.streak).toBe(4);
    expect(mocks.setUserStreak).not.toHaveBeenCalled();
    expect(mocks.metricsInc).not.toHaveBeenCalled();
  });

  it("treats a play just after UTC midnight as a new day, not a same-day replay", async () => {
    mocks.getUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 4,
      last_play_day: "2026-05-29",
      streak_repairs_this_month: 0,
      streak_repair_available: false,
    });
    mocks.setUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 5,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 0,
      streak_repair_available: true,
    });

    const result = await updateStreak("user-1", new Date("2026-05-30T00:00:30Z"));

    expect(result.streak).toBe(5);
    expect(mocks.setUserStreak).toHaveBeenCalledWith({
      userId: "user-1",
      streak: 5,
      lastPlayDay: "2026-05-30",
      repairAvailable: true,
    });
  });

  it("resets to 1 when the gap since last play exceeds a single day", async () => {
    mocks.getUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 10,
      last_play_day: "2026-05-20",
      streak_repairs_this_month: 0,
      streak_repair_available: true,
    });
    mocks.setUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 1,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 0,
      streak_repair_available: false,
    });

    const result = await updateStreak("user-1", new Date("2026-05-30T10:00:00Z"));

    expect(result.streak).toBe(1);
    expect(mocks.setUserStreak).toHaveBeenCalledWith(
      expect.objectContaining({ streak: 1, repairAvailable: false })
    );
  });

  it("does not repair a streak once the monthly repair allowance is already used", async () => {
    mocks.repairUserStreak.mockResolvedValue(null);

    const result = await repairStreak("user-1", new Date("2026-05-30T10:00:00Z"));

    expect(result).toBeNull();
    expect(mocks.repairUserStreak).toHaveBeenCalledWith("user-1", "2026-05-30");
  });

  it("formats current streak state", async () => {
    mocks.getUserStreak.mockResolvedValue({
      id: "user-1",
      streak: 5,
      last_play_day: "2026-05-30",
      streak_repairs_this_month: 0,
      streak_repair_available: true,
    });

    const result = await getStreak("user-1", new Date("2026-05-30T10:00:00Z"));

    expect(result).toMatchObject({
      streak: 5,
      lastPlayDay: "2026-05-30",
      repairAvailable: true,
      nextMilestone: 7,
      milestoneJustHit: false,
    });
  });
});
