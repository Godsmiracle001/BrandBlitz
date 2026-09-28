import { render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "unauthenticated", data: null }),
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: (m: string) => toastError(m) },
}));

import { LoginButton } from "./login-button";

// The button label flips to "Signing in…" while loading, so match by role only.
function getButton(): HTMLButtonElement {
  return screen.getByRole("button") as HTMLButtonElement;
}

describe("LoginButton popup-blocked handling (issue #347)", () => {
  beforeEach(() => {
    toastError.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resets the loading state when the popup is blocked (window.open returns null)", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    render(<LoginButton />);
    const button = getButton();
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    // Button must be usable again immediately — no permanent spinner.
    expect(getButton().disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/allow popups/i);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/allow popups/i));
  });

  it("re-enables the button after a blocked popup without a page reload", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<LoginButton />);

    fireEvent.click(getButton());
    const button = getButton();
    expect(button.disabled).toBe(false);
    // Focusable again
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("resets the loading state within 500ms when the user closes the popup", () => {
    vi.useFakeTimers();
    const fakePopup = { closed: false } as Window;
    vi.spyOn(window, "open").mockReturnValue(fakePopup);

    render(<LoginButton />);
    fireEvent.click(getButton());

    // Still loading while the popup is open.
    expect(getButton().disabled).toBe(true);

    // User closes the popup.
    (fakePopup as { closed: boolean }).closed = true;
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(getButton().disabled).toBe(false);
  });

  it("keeps loading while the popup remains open", () => {
    vi.useFakeTimers();
    const fakePopup = { closed: false } as Window;
    vi.spyOn(window, "open").mockReturnValue(fakePopup);

    render(<LoginButton />);
    fireEvent.click(getButton());

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(getButton().disabled).toBe(true);
  });
});
