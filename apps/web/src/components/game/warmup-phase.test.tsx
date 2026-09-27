import type { ImgHTMLAttributes } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WARMUP_MIN_SECONDS } from "./constants";
import { WarmupPhase } from "./warmup-phase";
import type { Challenge } from "@/lib/api";

const apiPostMock = vi.fn();

vi.mock("next/image", () => ({
  default: ({
    alt,
    src,
    ...props
  }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) => (
    <img alt={alt} src={src} {...props} />
  ),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");

  return {
    ...actual,
    createApiClient: () => ({
      post: apiPostMock,
    }),
  };
});

const challenge: Challenge = {
  id: "session-123",
  brand_id: "brand-123",
  challenge_id: "challenge-123",
  pool_amount_usdc: "250",
  pool_amount_stroops: "2500000000",
  status: "active",
  starts_at: "2026-04-24T00:00:00.000Z",
  ends_at: "2026-04-25T00:00:00.000Z",
  brand_name: "Acme",
  tagline: "Launch faster.",
  logo_url: "https://example.com/logo.png",
  primary_color: "#112233",
  secondary_color: "#ddeeff",
};

describe("WarmupPhase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiPostMock.mockReset();
    // warmup-start is called in the mount effect; return a resolved promise by
    // default so tests that don't care about it don't crash on `.catch()`.
    apiPostMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the brand logo, name, tagline, and warmup copy", () => {
    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={vi.fn()} />);

    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      "https://example.com/logo.png"
    );
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("Launch faster.")).toBeInTheDocument();
    expect(
      screen.getByText(/Study this brand carefully/i)
    ).toBeInTheDocument();
  });

  it("omits optional brand assets when absent", () => {
    render(
      <WarmupPhase
        challenge={{
          ...challenge,
          logo_url: undefined,
          tagline: undefined,
        }}
        apiToken="test-token"
        onComplete={vi.fn()}
      />
    );

    expect(screen.queryByRole("img", { name: "Acme" })).not.toBeInTheDocument();
    expect(screen.queryByText("Launch faster.")).not.toBeInTheDocument();
  });

  it("counts down from WARMUP_MIN_SECONDS and keeps the start button disabled until zero", async () => {
    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={vi.fn()} />);

    const startButton = screen.getByRole("button", { name: "Preparing..." });

    expect(screen.getByText(String(WARMUP_MIN_SECONDS))).toBeInTheDocument();
    expect(startButton).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText(String(WARMUP_MIN_SECONDS - 1))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preparing..." })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync((WARMUP_MIN_SECONDS - 1) * 1000);
    });

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Challenge →" })).toBeEnabled();
    expect(screen.getByText(/Ready!/i)).toBeInTheDocument();
  });

  it("posts warmup completion and invokes onComplete with the challenge token", async () => {
    const onComplete = vi.fn();
    apiPostMock.mockResolvedValue({
      data: { challengeToken: "token-abc" },
    });

    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={onComplete} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_MIN_SECONDS * 1000);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Challenge →" }));
      await Promise.resolve();
    });

    expect(apiPostMock).toHaveBeenCalledWith("/sessions/session-123/warmup-complete");
    expect(onComplete).toHaveBeenCalledWith("token-abc");
  });

  it("shows a not-yet-ready message for a 400 response with remainingMs and does not invoke onComplete", async () => {
    const onComplete = vi.fn();
    apiPostMock.mockRejectedValue({
      response: {
        status: 400,
        data: { remainingMs: 1500 },
      },
    });

    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={onComplete} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_MIN_SECONDS * 1000);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Challenge →" }));
      await Promise.resolve();
    });

    expect(screen.getByText(/Not yet ready\. Please wait 2 more seconds and try again\./i)).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("shows a retry button after a network error and retries the request successfully", async () => {
    const onComplete = vi.fn();

    // Slot 1: warmup-start (mount effect) → success
    // Slot 2: warmup-complete (button click) → network failure
    // Slot 3: warmup-complete (retry click) → success
    apiPostMock
      .mockResolvedValueOnce({}) // warmup-start
      .mockRejectedValueOnce(new Error("Network error")) // first warmup-complete
      .mockResolvedValueOnce({
        data: { challengeToken: "token-retry" },
      }); // retry warmup-complete

    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={onComplete} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_MIN_SECONDS * 1000);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Challenge →" }));
      await Promise.resolve();
    });

    expect(screen.getByText(/Couldn't start the challenge\. Check your connection and try again\./i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });

    // 3 calls total: warmup-start + 2 × warmup-complete (fail + retry)
    expect(apiPostMock).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledWith("token-retry");
  });

  it("treats non-400 server failures as retryable errors", async () => {
    apiPostMock.mockRejectedValue({
      response: {
        status: 500,
        data: {},
      },
    });

    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_MIN_SECONDS * 1000);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Challenge →" }));
      await Promise.resolve();
    });

    expect(screen.getByText(/Couldn't start the challenge\. Check your connection and try again\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("start button is disabled when countdown is paused due to visibility change", async () => {
    render(<WarmupPhase challenge={challenge} apiToken="test-token" onComplete={vi.fn()} />);

    // Advance 5 seconds into warmup (timer active)
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Simulate tab hidden (visibilitychange)
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true, writable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(100);
    });

    // Button should now be disabled and show paused text
    expect(screen.getByRole("button", { name: "Paused — Wait to resume" })).toBeDisabled();

    // Simulate tab visible again
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true, writable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(100);
    });

    // Complete remaining warmup
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARMUP_MIN_SECONDS * 1000);
    });

    // Button should be enabled once completed
    expect(screen.getByRole("button", { name: "Start Challenge →" })).toBeEnabled();
  });
});
