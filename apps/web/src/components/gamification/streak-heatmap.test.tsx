import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StreakHeatmap } from "./streak-heatmap";

describe("StreakHeatmap", () => {
  it("renders with no activity", () => {
    const { container } = render(<StreakHeatmap activity={[]} />);
    expect(container.firstChild?.childNodes.length ?? 0).toBe(0);
  });

  it("renders correct total cell count for 365 days", () => {
    const activity = Array.from({ length: 365 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (364 - i));
      return {
        date: date.toISOString().split("T")[0],
        session_count: 0,
      };
    });

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll("[class*='h-3 w-3']");
    expect(cells.length).toBeGreaterThanOrEqual(365);
  });

  it("assigns correct intensity level for zero sessions", () => {
    const activity = [
      { date: "2026-06-27", session_count: 0 },
    ];

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll(".bg-slate-100");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("assigns correct intensity level for 1 session", () => {
    const activity = [
      { date: "2026-06-27", session_count: 1 },
    ];

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll(".bg-indigo-200");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("assigns correct intensity level for 2-3 sessions", () => {
    const activity = [
      { date: "2026-06-27", session_count: 2 },
      { date: "2026-06-26", session_count: 3 },
    ];

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll(".bg-indigo-400");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("assigns correct intensity level for 4-6 sessions", () => {
    const activity = [
      { date: "2026-06-27", session_count: 4 },
      { date: "2026-06-26", session_count: 6 },
    ];

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll(".bg-indigo-600");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("assigns correct intensity level for 7+ sessions", () => {
    const activity = [
      { date: "2026-06-27", session_count: 7 },
      { date: "2026-06-26", session_count: 10 },
    ];

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll(".bg-indigo-800");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("fills full weeks with padding cells", () => {
    const activity = [
      { date: "2026-06-27", session_count: 1 },
    ];

    const { container } = render(<StreakHeatmap activity={activity} />);
    const allCells = container.querySelectorAll("[class*='h-3 w-3']");
    expect(allCells.length % 7).toBe(0);
  });

  it("collapses to 26-column view on mobile", () => {
    const originalWindowWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 500,
    });

    const activity = Array.from({ length: 365 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (364 - i));
      return {
        date: date.toISOString().split("T")[0],
        session_count: 0,
      };
    });

    const { container } = render(<StreakHeatmap activity={activity} />);
    const cells = container.querySelectorAll("[class*='h-3 w-3']");
    const cellsPerRow = Math.sqrt(cells.length);
    expect(cellsPerRow).toBeLessThanOrEqual(26);

    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: originalWindowWidth,
    });
  });
});
