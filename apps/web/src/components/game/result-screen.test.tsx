import type { AnchorHTMLAttributes } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultScreen } from "./result-screen";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === "string" ? href : undefined} {...props}>
      {children}
    </a>
  ),
}));

const confettiMock = vi.fn();
vi.mock("canvas-confetti", () => ({
  default: (...args: unknown[]) => confettiMock(...args),
}));

// Mock matchMedia for jsdom
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock requestAnimationFrame: only call each unique callback once to avoid infinite loops
const calledOnce = new WeakSet<FrameRequestCallback>();
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  if (!calledOnce.has(cb)) {
    calledOnce.add(cb);
    cb(Date.now());
  }
  return 0;
});
vi.stubGlobal("cancelAnimationFrame", vi.fn());

describe("ResultScreen", () => {
  let clipboardWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    confettiMock.mockClear();
    window.history.pushState({}, "", "/challenge/challenge-123/results");

    if (!navigator.clipboard) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => undefined,
        } as unknown as Clipboard,
      });
    }

    clipboardWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
  });

  it("renders the total score, rank, and estimated earnings when provided", () => {
    render(
      <ResultScreen
        totalScore={12345}
        rank={7}
        estimatedUsdc="42.5"
        challengeId="challenge-123"
      />
    );

    expect(screen.getByText("Challenge Complete!")).toBeInTheDocument();
    expect(screen.getByText("Rank #7")).toBeInTheDocument();
    expect(screen.getByText("Estimated earnings")).toBeInTheDocument();
    expect(screen.getByText("42.50 USDC")).toBeInTheDocument();
  });

  it("hides optional rank and earnings details when they are not provided", () => {
    render(<ResultScreen totalScore={9000} challengeId="challenge-123" />);

    expect(screen.getByText("Challenge Complete!")).toBeInTheDocument();
    expect(screen.queryByText(/Rank #/)).not.toBeInTheDocument();
    expect(screen.queryByText("Estimated earnings")).not.toBeInTheDocument();
    expect(screen.queryByText(/USDC/)).not.toBeInTheDocument();
  });

  it("uses the Web Share API when it is available", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });

    render(<ResultScreen totalScore={1500} estimatedUsdc="10" challengeId="challenge-123" />);

    await user.click(screen.getByRole("button", { name: "Share Result" }));

    expect(share).toHaveBeenCalledWith({
      text: expect.stringContaining("1,500"),
      url: "http://localhost:3000/challenge/challenge-123/results",
    });
    expect(clipboardWrite).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Result shared successfully.");
    });
  });

  it("shows no confirmation when the user cancels the native share sheet", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockRejectedValue(new DOMException("Share cancelled.", "AbortError"));

    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });

    render(<ResultScreen totalScore={1500} challengeId="challenge-123" />);

    await user.click(screen.getByRole("button", { name: "Share Result" }));

    expect(share).toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("falls back to the clipboard and shows a success toast when Web Share is unavailable", async () => {
    const user = userEvent.setup();

    render(<ResultScreen totalScore={2000} challengeId="challenge-123" />);

    await user.click(screen.getByRole("button", { name: "Share Result" }));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Result copied to clipboard.");
  });

  it("links to the challenge leaderboard", () => {
    render(<ResultScreen totalScore={1234} challengeId="challenge-123" />);

    expect(screen.getByRole("link", { name: "View Leaderboard" })).toHaveAttribute(
      "href",
      "/challenge/challenge-123"
    );
  });

  it("shows Congratulations heading for rank 1", () => {
    render(
      <ResultScreen totalScore={5000} rank={1} challengeId="challenge-123" />
    );

    expect(screen.getByText("Congratulations #1!")).toBeInTheDocument();
  });

  it("shows standard heading for rank 2 or higher", () => {
    render(
      <ResultScreen totalScore={5000} rank={2} challengeId="challenge-123" />
    );

    expect(screen.getByText("Challenge Complete!")).toBeInTheDocument();
  });

  it("fires confetti when rank is 1", () => {
    render(
      <ResultScreen totalScore={5000} rank={1} challengeId="challenge-123" />
    );

    expect(confettiMock).toHaveBeenCalled();
  });

  it("does not fire confetti when rank is 2 or greater", () => {
    render(
      <ResultScreen totalScore={5000} rank={2} challengeId="challenge-123" />
    );

    expect(confettiMock).not.toHaveBeenCalled();
  });

  it("does not fire confetti when rank is undefined", () => {
    render(<ResultScreen totalScore={500} challengeId="challenge-123" />);

    expect(confettiMock).not.toHaveBeenCalled();
  });

  it("uses brand colors for confetti when provided", () => {
    render(
      <ResultScreen
        totalScore={5000}
        rank={1}
        challengeId="challenge-123"
        primaryColor="#ff0000"
        secondaryColor="#00ff00"
      />
    );

    expect(confettiMock).toHaveBeenCalled();
    const callArgs = confettiMock.mock.calls[0][0];
    expect(callArgs.colors).toContain("#ff0000");
    expect(callArgs.colors).toContain("#00ff00");
  });
});
