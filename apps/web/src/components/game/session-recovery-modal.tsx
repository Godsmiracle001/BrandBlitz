"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export interface SessionRecoveryDetails {
  status: "in_progress" | "expired";
  currentRound: number;
  remainingTimeMs: number;
  totalScore: number;
}

interface SessionRecoveryModalProps {
  session: SessionRecoveryDetails;
  onResume: () => void;
  onForfeit: () => void;
  onStartNew: () => void;
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${seconds}s`;
}

export function SessionRecoveryModal({
  session,
  onResume,
  onForfeit,
  onStartNew,
}: SessionRecoveryModalProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const [confirmingForfeit, setConfirmingForfeit] = React.useState(false);

  React.useEffect(() => {
    const firstButton = dialogRef.current?.querySelector<HTMLButtonElement>("button");
    firstButton?.focus();
  }, [confirmingForfeit]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (buttons.length === 0) return;

    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const expired = session.status === "expired";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-recovery-title"
        aria-describedby="session-recovery-description"
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--background)] p-6 shadow-xl"
      >
        <div className="space-y-2">
          <h2 id="session-recovery-title" className="text-xl font-semibold">
            {expired ? "Session expired" : confirmingForfeit ? "Forfeit session?" : "Resume challenge?"}
          </h2>
          <p id="session-recovery-description" className="text-sm text-[var(--muted-foreground)]">
            {expired
              ? "This challenge session timed out before it was completed."
              : confirmingForfeit
                ? "Are you sure you want to forfeit? Your current score and progress will be lost."
                : "We found an interrupted challenge session for this account."}
          </p>
        </div>

        <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-md border border-[var(--border)] p-3">
            <dt className="text-xs text-[var(--muted-foreground)]">Round</dt>
            <dd className="mt-1 text-lg font-semibold">{session.currentRound}</dd>
          </div>
          <div className="rounded-md border border-[var(--border)] p-3">
            <dt className="text-xs text-[var(--muted-foreground)]">Time</dt>
            <dd className="mt-1 text-lg font-semibold">{formatTime(session.remainingTimeMs)}</dd>
          </div>
          <div className="rounded-md border border-[var(--border)] p-3">
            <dt className="text-xs text-[var(--muted-foreground)]">Score</dt>
            <dd className="mt-1 text-lg font-semibold">{session.totalScore}</dd>
          </div>
        </dl>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          {expired ? (
            <Button type="button" onClick={onStartNew}>
              Start New
            </Button>
          ) : confirmingForfeit ? (
            <>
              <Button type="button" variant="outline" onClick={() => setConfirmingForfeit(false)}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={onForfeit}>
                Confirm Forfeit
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setConfirmingForfeit(true)}>
                Forfeit
              </Button>
              <Button type="button" onClick={onResume}>
                Resume
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
