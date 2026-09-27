"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { CountdownTimer } from "./countdown-timer";
import { ROUND_SECONDS } from "./constants";
import type { ChallengeQuestion } from "@/lib/api";
import { AnswerOption, type AnswerOptionKey } from "./answer-option";
import { useKeyboardAnswers } from "@/hooks/use-keyboard-answers";

export interface ChallengeAnswerState {
  selectedOption: AnswerOptionKey | null;
  status: "pending" | "settled";
  correct?: boolean | null;
}

interface ChallengeRoundProps {
  question: ChallengeQuestion;
  round: 1 | 2 | 3;
  onAnswer: (option: AnswerOptionKey | null, reactionTimeMs: number) => void;
  brandLogoUrl?: string;
  brandProductImageUrl?: string;
  answerState?: ChallengeAnswerState | null;
  disabled?: boolean;
  pauseTimer?: boolean;
  /** #154 — inline error banner when the parent's answer submission
   *  fails after retries. Null / undefined = no error. */
  answerError?: string | null;
  /** #154 — replay the last submitted answer with fresh network
   *  calls. The parent owns the retry payload; the component just
   *  wires the click. */
  onRetry?: () => void;
  /** Called each second when countdown is ≤5 s for tick sound. */
  onTick?: () => void;
}

const OPTIONS: ("A" | "B" | "C" | "D")[] = ["A", "B", "C", "D"];

export function ChallengeRound({
  question,
  round,
  onAnswer,
  brandLogoUrl,
  brandProductImageUrl,
  answerState = null,
  disabled = false,
  pauseTimer = false,
  answerError = null,
  onRetry,
  onTick,
}: ChallengeRoundProps) {
  const [localSelected, setLocalSelected] = useState<AnswerOptionKey | null>(null);
  const [localLocked, setLocalLocked] = useState(false);
  const startTimeRef = useRef(Date.now());
  const previousAnswerStateRef = useRef<ChallengeAnswerState | null>(null);
  const answered = answerState !== null || localLocked;

  useEffect(() => {
    startTimeRef.current = Date.now();
    setLocalSelected(null);
    setLocalLocked(false);
  }, [round]);

  useEffect(() => {
    if (previousAnswerStateRef.current && !answerState && !answerError) {
      setLocalSelected(null);
      setLocalLocked(false);
    }
    previousAnswerStateRef.current = answerState;
  }, [answerState, answerError]);

  const handleSelect = useCallback(
    (option: AnswerOptionKey) => {
      if (answered || disabled) return;
      const reactionTimeMs = Date.now() - startTimeRef.current;
      setLocalSelected(option);
      setLocalLocked(true);
      onAnswer(option, reactionTimeMs);
    },
    [answered, disabled, onAnswer]
  );

  useKeyboardAnswers({
    onAnswer: handleSelect,
    disabled: answered || disabled,
  });

  const handleTimeExpire = () => {
    if (!answered && !disabled) {
      const reactionTimeMs = ROUND_SECONDS * 1000;
      onAnswer(null, reactionTimeMs);
    }
  };

  const getOptionLabel = (opt: "A" | "B" | "C" | "D") => {
    const map = {
      A: question.option_a,
      B: question.option_b,
      C: question.option_c,
      D: question.option_d,
    };
    return map[opt];
  };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      {/* Round indicator */}
      <div className="flex items-center justify-between" data-tutorial="score">
        <span className="text-sm font-medium text-[var(--muted-foreground)]">
          Round {round} of 3
        </span>
        <CountdownTimer
          durationSeconds={ROUND_SECONDS}
          onExpire={handleTimeExpire}
          onTick={onTick}
          className="w-32"
          paused={pauseTimer}
        />
      </div>

      {/* Prompt image */}
      {question.prompt_type === "logo" && brandLogoUrl && (
        <div className="flex justify-center py-4">
          <Image
            src={brandLogoUrl}
            alt="Brand prompt"
            width={320}
            height={96}
            sizes="320px"
            className="h-24 w-auto object-contain"
          />
        </div>
      )}
      {question.prompt_type === "productImage1" && brandProductImageUrl && (
        <div className="flex justify-center py-4">
          <Image
            src={brandProductImageUrl}
            alt="Product prompt"
            width={480}
            height={320}
            sizes="480px"
            className="h-40 w-auto rounded-lg object-contain"
          />
        </div>
      )}

      {/* Question text */}
      <p className="text-center text-xl font-semibold">{question.question_text}</p>

      {/* Answer options */}
      <div className="grid grid-cols-1 gap-3">
        {OPTIONS.map((opt) => {
          const selected = answerState ? answerState.selectedOption === opt : localSelected === opt;
          const pending = answerState
            ? selected && answerState.status === "pending"
            : selected && localLocked;
          return (
            <AnswerOption
              key={opt}
              option={opt}
              label={getOptionLabel(opt)}
              selected={selected}
              pending={pending}
              correct={
                selected && answerState?.status === "settled" ? (answerState.correct ?? null) : null
              }
              disabled={disabled || answered}
              onSelect={handleSelect}
            />
          );
        })}
      </div>

      {/* #154 — Answer submission error banner with retry. */}
      {answerError && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-500/50 bg-red-500/10 p-4 text-sm"
        >
          <p className="text-red-500">Could not submit your answer. Check your connection and try again.</p>
          {onRetry && (
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
