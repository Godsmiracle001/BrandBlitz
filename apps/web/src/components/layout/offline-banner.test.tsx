import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "./offline-banner";

const { useNetworkStatus } = vi.hoisted(() => ({ useNetworkStatus: vi.fn() }));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus }));

describe("OfflineBanner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a short recovery confirmation and a retry action after reconnecting", () => {
    useNetworkStatus.mockReturnValue({ isOnline: false });
    const { rerender } = render(<OfflineBanner />);
    expect(screen.getByText(/You are offline/)).toBeTruthy();

    useNetworkStatus.mockReturnValue({ isOnline: true });
    rerender(<OfflineBanner />);
    expect(screen.getByText(/You're back online/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload and retry" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText(/You're back online/)).toBeNull();
  });
});
