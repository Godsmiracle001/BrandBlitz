import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionRecoveryModal } from "./session-recovery-modal";

describe("SessionRecoveryModal", () => {
  it("calls resume directly and requires confirmation before forfeiting", () => {
    const onResume = vi.fn();
    const onForfeit = vi.fn();

    render(
      <SessionRecoveryModal
        session={{ status: "in_progress", currentRound: 2, remainingTimeMs: 17000, totalScore: 120 }}
        onResume={onResume}
        onForfeit={onForfeit}
        onStartNew={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: /resume challenge/i })).toBeInTheDocument();
    expect(screen.getByText("17s")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalledTimes(1);

    // Initial click on forfeit shows confirmation step
    fireEvent.click(screen.getByRole("button", { name: /forfeit/i }));
    expect(onForfeit).not.toHaveBeenCalled();
    expect(screen.getByText(/Are you sure you want to forfeit\? Your current score and progress will be lost\./i)).toBeInTheDocument();

    // Confirm forfeit executes onForfeit
    fireEvent.click(screen.getByRole("button", { name: /confirm forfeit/i }));
    expect(onForfeit).toHaveBeenCalledTimes(1);
  });

  it("only offers start new for expired sessions", () => {
    const onStartNew = vi.fn();

    render(
      <SessionRecoveryModal
        session={{ status: "expired", currentRound: 3, remainingTimeMs: 0, totalScore: 210 }}
        onResume={vi.fn()}
        onForfeit={vi.fn()}
        onStartNew={onStartNew}
      />,
    );

    expect(screen.getByRole("dialog", { name: /session expired/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /forfeit/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /start new/i }));
    expect(onStartNew).toHaveBeenCalledTimes(1);
  });
});
