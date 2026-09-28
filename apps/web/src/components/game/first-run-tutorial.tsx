"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the UI element this step spotlights (if present). */
  highlight?: string;
}

/**
 * Steps walk a first-time player through the key challenge UI elements:
 * timer, scoring, leaderboard, and payout info (issue #1040).
 * `highlight` targets are `data-tutorial` attributes placed on the page —
 * when an element isn't on screen yet its step falls back to the card alone.
 */
export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to your first challenge",
    body: "A quick tour before you play — timer, scoring, leaderboard and payouts. Skip anytime; this only shows once.",
  },
  {
    id: "timer",
    title: "Beat the clock",
    body: "Every round is timed. Answer before the countdown hits zero — faster correct answers score higher.",
    highlight: '[data-tutorial="timer"]',
  },
  {
    id: "score",
    title: "Scoring",
    body: "Your score builds with each correct answer. You have three rounds, and your total score decides your rank.",
    highlight: '[data-tutorial="score"]',
  },
  {
    id: "leaderboard",
    title: "Leaderboard",
    body: "When the challenge ends you're ranked against other players on the leaderboard — top players split the prize pool. Your rank shows on the results screen.",
    highlight: '[data-tutorial="leaderboard"]',
  },
  {
    id: "payouts",
    title: "Payouts",
    body: "Prize payouts are sent to your Stellar wallet address on file. Check the Fair Play guide anytime for details.",
    highlight: '[data-tutorial="payouts"]',
  },
];

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface FirstRunTutorialProps {
  open: boolean;
  /** Called when the user finishes, skips, or dismisses — persists the flag. */
  onDismiss: () => void;
}

/**
 * Dismissible first-run tutorial overlay (issue #1040).
 *
 * The backdrop is deliberately `pointer-events-none` so the overlay never
 * blocks gameplay interactions — only the tutorial card itself receives
 * clicks. Highlighted elements get a spotlight ring positioned over them.
 */
export function FirstRunTutorial({ open, onDismiss }: FirstRunTutorialProps) {
  const [stepIndex, setStepIndex] = React.useState(0);
  const [highlight, setHighlight] = React.useState<HighlightRect | null>(null);

  React.useEffect(() => {
    if (!open) {
      setStepIndex(0);
      setHighlight(null);
    }
  }, [open]);

  // Track the spotlight target across step changes, phase changes, resizes
  // and scrolls. Re-polls briefly because target elements mount as the game
  // moves between preview / warmup / challenge phases.
  React.useEffect(() => {
    if (!open) return;

    const update = () => {
      const selector = TUTORIAL_STEPS[stepIndex]?.highlight;
      if (!selector) {
        setHighlight(null);
        return;
      }
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) {
        setHighlight(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setHighlight({
        top: rect.top - 6,
        left: rect.left - 6,
        width: rect.width + 12,
        height: rect.height + 12,
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const pollId = window.setInterval(update, 500);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearInterval(pollId);
    };
  }, [open, stepIndex]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onDismiss]);

  if (!open) return null;

  const step = TUTORIAL_STEPS[stepIndex];
  const isLast = stepIndex === TUTORIAL_STEPS.length - 1;

  return (
    <>
      {/* Non-blocking backdrop: clicks pass through to the game underneath. */}
      <div className="pointer-events-none fixed inset-0 z-[60] bg-black/30" aria-hidden="true" />

      {highlight && (
        <div
          className="pointer-events-none fixed z-[60] rounded-lg ring-4 ring-[var(--primary)]"
          style={{
            top: highlight.top,
            left: highlight.left,
            width: highlight.width,
            height: highlight.height,
          }}
          aria-hidden="true"
        />
      )}

      <div
        role="dialog"
        aria-modal={false}
        aria-label="Getting started tutorial"
        className="pointer-events-auto fixed bottom-6 left-1/2 z-[60] w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-[var(--border)] bg-[var(--background)] p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Getting started · {stepIndex + 1} of {TUTORIAL_STEPS.length}
          </span>
          <div className="flex gap-1.5" aria-hidden="true">
            {TUTORIAL_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 w-1.5 rounded-full ${
                  i === stepIndex ? "bg-[var(--primary)]" : "bg-[var(--muted)]"
                }`}
              />
            ))}
          </div>
        </div>

        <h2 className="mt-3 text-base font-semibold">{step.title}</h2>
        <p className="mt-1.5 text-sm text-[var(--muted-foreground)]">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Skip tutorial">
            Skip
          </Button>
          <div className="flex gap-2">
            {stepIndex > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              >
                Back
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                if (isLast) {
                  onDismiss();
                } else {
                  setStepIndex((i) => i + 1);
                }
              }}
            >
              {isLast ? "Let's play" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
