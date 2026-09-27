import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BadgeUnlockModal, type Badge } from "./badge-unlock-modal";

// Mock sessionStorage
const sessionStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, "sessionStorage", { value: sessionStorageMock });

const badge1: Badge = { id: "b1", name: "First Win", description: "You won your first challenge!", iconUrl: undefined };
const badge2: Badge = { id: "b2", name: "Streak Master", description: "7-day streak!", iconUrl: undefined };

describe("BadgeUnlockModal", () => {
  beforeEach(() => {
    sessionStorageMock.clear();
  });

  it("does not render when badges is empty", () => {
    const { container } = render(<BadgeUnlockModal badges={[]} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders badge name and description", () => {
    render(<BadgeUnlockModal badges={[badge1]} onClose={() => {}} />);
    expect(screen.getByText("First Win")).toBeTruthy();
    expect(screen.getByText("You won your first challenge!")).toBeTruthy();
  });

  it("share link uses correct badge name and product name", () => {
    render(<BadgeUnlockModal badges={[badge1]} onClose={() => {}} />);
    const link = screen.getByRole("link", { name: /Share on X/i });
    expect(link.getAttribute("href")).toContain(encodeURIComponent("First Win"));
    expect(link.getAttribute("href")).toContain("BrandBlitz!");
    expect(link.getAttribute("href")).not.toContain("StreamFi!");
    expect(link.getAttribute("href")).toContain("x.com/intent/tweet");
  });

  it("onClose called on close button click", () => {
    const onClose = vi.fn();
    vi.useFakeTimers();
    render(<BadgeUnlockModal badges={[badge1]} onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    vi.advanceTimersByTime(400);
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
