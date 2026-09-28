import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../middleware/error";
import { getUtcWeekStart, addUtcDays } from "../lib/week";

const mocks = vi.hoisted(() => ({
  user: { sub: "user-1", email: "user@example.com", role: "user" } as
    | { sub: string; email: string; role: string }
    | null,
  ensureAssignmentForUserThisWeek: vi.fn(),
  getCurrentLeagueGroup: vi.fn(),
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, res: any, next: any) => {
    if (!mocks.user) {
      res.status(401).json({ error: "No token provided" });
      return;
    }
    req.user = mocks.user;
    next();
  },
}));

vi.mock("../db/queries/leagues", () => ({
  ensureAssignmentForUserThisWeek: mocks.ensureAssignmentForUserThisWeek,
  getCurrentLeagueGroup: mocks.getCurrentLeagueGroup,
}));

import leaguesRouter from "./leagues";

function createApp() {
  const app = express();
  app.use("/leagues", leaguesRouter);
  app.use(errorHandler);
  return app;
}

const group = [
  {
    user_id: "user-1",
    display_name: "Alice",
    avatar_url: null,
    league: "silver" as const,
    week_start: "2026-07-20",
    group_id: 3,
    weekly_points: 420,
    rank_in_group: 1,
  },
  {
    user_id: "user-2",
    display_name: "Bob",
    avatar_url: null,
    league: "silver" as const,
    week_start: "2026-07-20",
    group_id: 3,
    weekly_points: 300,
    rank_in_group: 2,
  },
];

describe("GET /leagues/current", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { sub: "user-1", email: "user@example.com", role: "user" };
    mocks.ensureAssignmentForUserThisWeek.mockResolvedValue({ league: "silver", group_id: 3 });
    mocks.getCurrentLeagueGroup.mockResolvedValue({
      league: "silver",
      group_id: 3,
      group,
    });
  });

  it("returns 401 for an unauthenticated request", async () => {
    mocks.user = null;

    const response = await request(createApp()).get("/leagues/current");

    expect(response.status).toBe(401);
    expect(mocks.ensureAssignmentForUserThisWeek).not.toHaveBeenCalled();
  });

  it("ensures a weekly assignment exists before reading the league group", async () => {
    await request(createApp()).get("/leagues/current");

    const expectedWeekStart = getUtcWeekStart(new Date());
    expect(mocks.ensureAssignmentForUserThisWeek).toHaveBeenCalledWith(
      "user-1",
      expectedWeekStart
    );
    expect(mocks.getCurrentLeagueGroup).toHaveBeenCalledWith("user-1", expectedWeekStart);
    expect(mocks.ensureAssignmentForUserThisWeek.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getCurrentLeagueGroup.mock.invocationCallOrder[0]
    );
  });

  it("returns the caller's league tier, group id, and the 30-player group with points", async () => {
    const response = await request(createApp()).get("/leagues/current");

    const expectedWeekStart = getUtcWeekStart(new Date());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      weekStart: expectedWeekStart,
      weekEndExclusive: addUtcDays(expectedWeekStart, 7),
      league: "silver",
      groupId: 3,
    });
    expect(response.body.group).toEqual(group);
  });

  it("returns competitors ordered by weekly score as provided by the query layer", async () => {
    const response = await request(createApp()).get("/leagues/current");

    const points = response.body.group.map((entry: { weekly_points: number }) => entry.weekly_points);
    expect(points).toEqual([...points].sort((a, b) => b - a));
  });

  it("returns 404 when the user has no league assignment for the current week", async () => {
    mocks.getCurrentLeagueGroup.mockResolvedValue(null);

    const response = await request(createApp()).get("/leagues/current");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("League not found");
  });
});
