import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ChallengeRound } from "./challenge-round";
import { ROUND_SECONDS } from "./constants";
import type { ChallengeQuestion } from "@/lib/api";

let capturedOnExpire: (() => void) | undefined;

vi.mock("./countdown-timer", () => ({
  CountdownTimer: (props: { durationSeconds: number; onExpire?: () => void; className?: string }) => {
    capturedOnExpire = props.onExpire;
    return <div data-testid="countdown-timer">{props.durationSeconds}</div>;
  },
}));

function buildQuestion(overrides?: Partial<ChallengeQuestion>): ChallengeQuestion {
  return {
    id: "q-1",
    challenge_id: "ch-1",
    round: 1,
    question_type: "brand_recall",
    prompt_type: "text",
    question_text: "Which brand uses this tagline?",
    option_a: "Nike",
    option_b: "Adidas",
    option_c: "Puma",
    option_d: "Reebok",
    ...overrides,
  };
}

describe("ChallengeRound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    capturedOnExpire = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders the question prompt and all 4 options", () => {
    const onAnswer = vi.fn();
    render(<ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} />);

    expect(screen.getByText("Which brand uses this tagline?")).toBeDefined();
    expect(screen.getByText("Nike")).toBeDefined();
    expect(screen.getByText("Adidas")).toBeDefined();
    expect(screen.getByText("Puma")).toBeDefined();
    expect(screen.getByText("Reebok")).toBeDefined();
  });

  it("displays the round indicator", () => {
    const onAnswer = vi.fn();
    render(<ChallengeRound question={buildQuestion()} round={2} onAnswer={onAnswer} />);

    expect(screen.getByText("Round 2 of 3")).toBeDefined();
  });

  it("clicking an option calls onAnswer with the option letter and reactionTimeMs", () => {
    const onAnswer = vi.fn();
    const now = 1000;
    vi.setSystemTime(now);

    render(<ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} />);

    vi.setSystemTime(now + 2500);
    fireEvent.click(screen.getByText("Puma"));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("C", 2500);
  });

  it("prevents double-answering after an option is selected", () => {
    const onAnswer = vi.fn();
    render(<ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByText("Nike"));
    fireEvent.click(screen.getByText("Adidas"));
    fireEvent.click(screen.getByText("Puma"));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("A", expect.any(Number));
  });

  it("shows an optimistic pending state and disables every option", () => {
    render(
      <ChallengeRound
        question={buildQuestion()}
        round={1}
        onAnswer={vi.fn()}
        answerState={{ selectedOption: "B", status: "pending", correct: null }}
      />
    );

    expect(screen.getByLabelText("Submitting answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B: Adidas" })).toHaveAttribute("aria-pressed", "true");
    for (const button of screen.getAllByRole("button", { name: /^[A-D]:/ })) {
      expect(button).toBeDisabled();
    }
  });

  it("rolls back optimistic state when answerState returns to null", () => {
    const onAnswer = vi.fn();
    const { rerender } = render(
      <ChallengeRound
        question={buildQuestion()}
        round={1}
        onAnswer={onAnswer}
        answerState={{ selectedOption: "C", status: "pending", correct: null }}
      />
    );

    rerender(<ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} answerState={null} />);
    fireEvent.click(screen.getByText("Reebok"));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("D", expect.any(Number));
  });

  it("reconciles successful answer state from the server response", () => {
    render(
      <ChallengeRound
        question={buildQuestion()}
        round={1}
        onAnswer={vi.fn()}
        answerState={{ selectedOption: "A", status: "settled", correct: true }}
      />
    );

    const selected = screen.getByRole("button", { name: "A: Nike" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected.className).toContain("green");
  });

  it("timer reaching 0 calls onAnswer with null option and rtMs = ROUND_SECONDS * 1000", () => {
    const onAnswer = vi.fn();
    render(<ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} />);

    expect(capturedOnExpire).toBeDefined();
    capturedOnExpire!();

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(null, ROUND_SECONDS * 1000);
  });

  it("timer expiry does not fire if user already answered", () => {
    const onAnswer = vi.fn();
    render(<ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByText("Adidas"));
    expect(onAnswer).toHaveBeenCalledTimes(1);

    capturedOnExpire!();

    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("renders logo image when prompt_type is 'logo' and brandLogoUrl is provided", () => {
    const onAnswer = vi.fn();
    const question = buildQuestion({ prompt_type: "logo" });

    const { container } = render(
      <ChallengeRound
        question={question}
        round={1}
        onAnswer={onAnswer}
        brandLogoUrl="https://example.com/logo.png"
      />
    );

    const img = container.querySelector('img[alt="Brand prompt"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://example.com/logo.png");
  });

  it("renders product image when prompt_type is 'productImage1' and brandProductImageUrl is provided", () => {
    const onAnswer = vi.fn();
    const question = buildQuestion({ prompt_type: "productImage1" });

    const { container } = render(
      <ChallengeRound
        question={question}
        round={1}
        onAnswer={onAnswer}
        brandProductImageUrl="https://example.com/product.png"
      />
    );

    const img = container.querySelector('img[alt="Product prompt"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://example.com/product.png");
  });

  it("does not render images when prompt_type does not match or URLs are missing", () => {
    const onAnswer = vi.fn();
    const question = buildQuestion({ prompt_type: "text" });

    const { container } = render(
      <ChallengeRound question={question} round={1} onAnswer={onAnswer} />
    );

    expect(container.querySelector('img[alt="Brand prompt"]')).toBeNull();
    expect(container.querySelector('img[alt="Product prompt"]')).toBeNull();
  });

  it("resets state when round prop changes", () => {
    const onAnswer = vi.fn();
    const now = 5000;
    vi.setSystemTime(now);

    const { rerender } = render(
      <ChallengeRound question={buildQuestion()} round={1} onAnswer={onAnswer} />
    );

    fireEvent.click(screen.getByText("Nike"));
    expect(onAnswer).toHaveBeenCalledTimes(1);

    vi.setSystemTime(now + 10000);
    rerender(
      <ChallengeRound question={buildQuestion()} round={2} onAnswer={onAnswer} />
    );

    vi.setSystemTime(now + 10000 + 1200);
    fireEvent.click(screen.getByText("Adidas"));

    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith("B", 1200);
  });

  describe("keyboard navigation", () => {
    it.todo("number keys 1-4 select options (keyboard parity)");
    it.todo("arrow keys navigate between options");
  });

  // ── #154 — answer-submission error UX ────────────────────────────────────

  describe("answer-error surfacing (#154)", () => {
    it("renders the inline friendly error banner when answerError is set and hides raw error details", () => {
      render(
        <ChallengeRound
          question={buildQuestion()}
          round={1}
          onAnswer={vi.fn()}
          answerError="500 Internal Server Error: ERR_CONN_REFUSED"
        />,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/Could not submit your answer/i)).toBeInTheDocument();
      expect(screen.queryByText(/500 Internal Server Error/i)).not.toBeInTheDocument();
    });

    it("does not render the banner when answerError is null/undefined", () => {
      const { rerender } = render(
        <ChallengeRound question={buildQuestion()} round={1} onAnswer={vi.fn()} answerError={null} />,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      rerender(
        <ChallengeRound question={buildQuestion()} round={1} onAnswer={vi.fn()} />,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("invokes onRetry when the Retry button is clicked", () => {
      const onRetry = vi.fn();
      render(
        <ChallengeRound
          question={buildQuestion()}
          round={1}
          onAnswer={vi.fn()}
          answerError="server 500"
          onRetry={onRetry}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("omits the Retry button when onRetry is not supplied", () => {
      render(
        <ChallengeRound
          question={buildQuestion()}
          round={1}
          onAnswer={vi.fn()}
          answerError="permanent failure"
        />,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });
  });
});
