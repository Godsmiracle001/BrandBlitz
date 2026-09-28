"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { createApiClient, type Challenge, type ChallengeQuestion } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useFingerprint } from "@/hooks/use-fingerprint";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { TOTAL_ROUNDS } from "@/components/game/constants";
import type { AnswerOptionKey } from "@/components/game/answer-option";
import type { ChallengeAnswerState } from "@/components/game/challenge-round";
import { OfflineBanner } from "@/components/layout/offline-banner";
import {
  SessionRecoveryModal,
  type SessionRecoveryDetails,
} from "@/components/game/session-recovery-modal";
import { scoresForResume, shouldShowRecoveryModal } from "@/components/game/session-recovery";
import { BrandKitPreview } from "@/components/brand/brand-kit-preview";
import { ReportModal } from "@/components/game/report-modal";
import { FirstRunTutorial } from "@/components/game/first-run-tutorial";

const WarmupPhase = dynamic(
  () => import("@/components/game/warmup-phase").then((m) => m.WarmupPhase),
  {
    loading: () => (
      <div className="flex min-h-screen items-center justify-center">Loading warmup...</div>
    ),
  }
);

const ChallengeRound = dynamic(
  () => import("@/components/game/challenge-round").then((m) => m.ChallengeRound),
  {
    loading: () => (
      <div className="flex min-h-screen items-center justify-center">Loading round...</div>
    ),
  }
);

const ResultScreen = dynamic(
  () => import("@/components/game/result-screen").then((m) => m.ResultScreen),
  {
    loading: () => (
      <div className="flex min-h-screen items-center justify-center">Preparing results...</div>
    ),
  }
);

type GamePhase = "loading" | "preview" | "warmup" | "challenge" | "result";

type CachedChallengeDetail = {
  etag: string;
  challenge: Challenge;
  questions: ChallengeQuestion[];
};

function challengeDetailStorageKey(challengeId: string): string {
  return `brandblitz:challenge-detail:${challengeId}`;
}

function getCachedChallengeDetail(challengeId: string): CachedChallengeDetail | null {
  try {
    const stored = window.sessionStorage.getItem(challengeDetailStorageKey(challengeId));
    return stored ? (JSON.parse(stored) as CachedChallengeDetail) : null;
  } catch {
    return null;
  }
}

function storeChallengeDetail(challengeId: string, detail: CachedChallengeDetail): void {
  try {
    window.sessionStorage.setItem(challengeDetailStorageKey(challengeId), JSON.stringify(detail));
  } catch {
    // Session storage may be unavailable (private browsing or quota pressure).
  }
}

interface Props {
  params: Promise<{ id: string }>;
}

interface RecoverySessionResponse {
  id: string;
  status: "warmup" | "in_progress" | "completed" | "expired";
  last_answered_round: number;
  current_round: number;
  remaining_time_ms: number;
  total_score: number;
  round_scores?: number[];
}

const ANSWER_MAX_ATTEMPTS = 3;
const ANSWER_RETRY_DELAY_MS = 500;
const ANSWER_SETTLED_DELAY_MS = 450;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function errorMessage(err: any): string {
  return (
    err?.response?.data?.message ??
    err?.response?.data?.error ??
    err?.message ??
    "Failed to submit answer. Check your connection and try again."
  );
}

function toRecoveryDetails(session: RecoverySessionResponse): SessionRecoveryDetails {
  return {
    status: session.status === "expired" ? "expired" : "in_progress",
    currentRound: session.current_round,
    remainingTimeMs: session.remaining_time_ms,
    totalScore: session.total_score,
  };
}

export function ChallengePage({ params }: Props) {
  const { id: challengeId } = React.use(params);
  const { data: session, status } = useSession();
  const router = useRouter();
  const visitorId = useFingerprint();
  const { isOnline } = useNetworkStatus();

  const [challenge, setChallenge] = React.useState<Challenge | null>(null);
  const [questions, setQuestions] = React.useState<ChallengeQuestion[]>([]);
  const [phase, setPhase] = React.useState<GamePhase>("loading");
  const [currentRound, setCurrentRound] = React.useState<1 | 2 | 3>(1);
  const [scores, setScores] = React.useState<number[]>([]);
  const [finalRank, setFinalRank] = React.useState<number | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [answerError, setAnswerError] = React.useState<string | null>(null);
  const [answerState, setAnswerState] = React.useState<ChallengeAnswerState | null>(null);
  const [recoverySession, setRecoverySession] = React.useState<RecoverySessionResponse | null>(
    null
  );
  const [showTooltip, setShowTooltip] = React.useState(false);
  const [showReportModal, setShowReportModal] = React.useState(false);
  const [showTutorial, setShowTutorial] = React.useState(false);

  const mountedRef = React.useRef(true);
  const currentRoundRef = React.useRef(currentRound);
  const answerStateRef = React.useRef(answerState);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const lastAnswerRef = React.useRef<{
    option: AnswerOptionKey | null;
    reactionTimeMs: number;
  } | null>(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    currentRoundRef.current = currentRound;
  }, [currentRound]);

  React.useEffect(() => {
    answerStateRef.current = answerState;
  }, [answerState]);

  const apiToken = (session as any)?.apiToken as string | undefined;

  // Issue #1040 — show the first-run tutorial once per account until the
  // player completes (or skips) it. Flag lives server-side on the user row.
  React.useEffect(() => {
    if (status !== "authenticated" || !apiToken) return;
    const api = createApiClient(apiToken);
    let cancelled = false;

    void (async () => {
      try {
        const res = await api.get("/users/me", { skipErrorToast: true });
        if (!cancelled && !res.data.user?.onboarding_completed) {
          setShowTutorial(true);
        }
      } catch {
        // Never block gameplay on a tutorial flag fetch failure.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, apiToken]);

  const handleTutorialDismiss = React.useCallback(() => {
    setShowTutorial(false);
    if (!apiToken) return;
    const api = createApiClient(apiToken);
    // Fire-and-forget: dismissal is optimistic, the flag syncs in background.
    void api.post("/users/me/onboarding/complete", {}, { skipErrorToast: true }).catch(() => {});
  }, [apiToken]);

  const clearOpenSession = React.useCallback(async () => {
    if (!apiToken) return;
    const api = createApiClient(apiToken);
    await api.delete(`/sessions/${challengeId}`, { skipErrorToast: true });
  }, [apiToken, challengeId]);

  React.useEffect(() => {
    if (!challengeId) return;
    if (status === "unauthenticated") {
      router.push(`/login?callbackUrl=/challenge/${challengeId}`);
      return;
    }
    if (status !== "authenticated" || !apiToken) return;

    const api = createApiClient(apiToken);
    let cancelled = false;

    void (async () => {
      setPhase("loading");
      setLoadError(null);
      setRecoverySession(null);

      try {
        const res = await api.get(`/challenges/${challengeId}`);
        if (cancelled) return;
        setChallenge(res.data.challenge);
        setQuestions(res.data.questions);
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load challenge:", err);
          setLoadError("Couldn't load the challenge. Check your connection and try again.");
        }
        return;
      }

      try {
        const res = await api.get(`/sessions/${challengeId}`, { skipErrorToast: true });
        const existing = res.data.session as RecoverySessionResponse;
        if (cancelled) return;

        if (shouldShowRecoveryModal(existing)) {
          setRecoverySession(existing);
          return;
        }
      } catch (err: any) {
        if (err?.response?.status && err.response.status !== 404) {
          console.error("Failed to check session status:", err);
          if (!cancelled) setLoadError("Couldn't check your session status. Please try again.");
          return;
        }
      }

      try {
        const r = await api.post(`/sessions/${challengeId}/warmup-start`, { deviceId: visitorId });
        if (cancelled) return;
        setPhase("preview");
      } catch (err) {
        console.error("Failed to start warmup:", err);
        if (!cancelled) setLoadError("Couldn't start the game session. Please try again.");
      }
    })();

    // #557 — Preload first round images during preview/warmup
    React.useEffect(() => {
      if (phase !== "preview" || !challenge || questions.length === 0) return;

      const links: HTMLLinkElement[] = [];
      const imageUrls: string[] = [];

      const firstQuestion = questions[0];
      if (firstQuestion) {
        if (firstQuestion.prompt_type === "logo" && challenge.logo_url) {
          imageUrls.push(challenge.logo_url);
        }
      }

      for (const url of imageUrls) {
        const link = document.createElement("link");
        link.rel = "preload";
        link.as = "image";
        link.href = url;
        link.fetchPriority = "high";
        document.head.appendChild(link);
        links.push(link);
      }

      return () => {
        for (const link of links) {
          document.head.removeChild(link);
        }
      };
    }, [phase, challenge, questions]);

    return () => {
      cancelled = true;
    };
  }, [apiToken, challengeId, router, status, visitorId]);

  const handlePreviewStart = React.useCallback(() => {
    setPhase("warmup");
  }, []);

  const handlePreviewSkip = React.useCallback(() => {
    setPhase("warmup");
  }, []);

  React.useEffect(() => {
    if (phase !== "challenge") return;
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem("brandblitz:keyboard-tooltip-dismissed");
    if (!dismissed) {
      setShowTooltip(true);
    }
  }, [phase]);

  React.useEffect(() => {
    if (!showTooltip) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowTooltip(false);
        try {
          window.localStorage.setItem("brandblitz:keyboard-tooltip-dismissed", "1");
        } catch {}
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showTooltip]);

  const dismissTooltip = React.useCallback(() => {
    setShowTooltip(false);
    try {
      window.localStorage.setItem("brandblitz:keyboard-tooltip-dismissed", "1");
    } catch {}
  }, []);

  const handleWarmupComplete = async (challengeToken: string) => {
    if (!apiToken) return;
    const api = createApiClient(apiToken);

    try {
      await api.post(`/sessions/${challengeId}/start`, { challengeToken });
      setScores([]);
      setAnswerError(null);
      setAnswerState(null);
      setCurrentRound(1);
      setPhase("challenge");
    } catch {
      setLoadError("Couldn't start the challenge. Please try again.");
    }
  };

  const submitAnswer = async (
    option: AnswerOptionKey | null,
    reactionTimeMs: number,
    signal: AbortSignal
  ): Promise<{ score: number; correct: boolean }> => {
    if (!apiToken) throw new Error("Missing API token");
    const api = createApiClient(apiToken);
    let lastError: unknown;

    for (let attempt = 0; attempt < ANSWER_MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw new Error("Aborted");
      try {
        const res = await api.post(
          `/sessions/${challengeId}/answer/${currentRoundRef.current}`,
          { selectedOption: option, reactionTimeMs },
          { signal, skipErrorToast: true }
        );
        return { score: res.data.score as number, correct: Boolean(res.data.correct) };
      } catch (err: any) {
        if (err.name === "CanceledError" || err.message === "Aborted") throw err;
        lastError = err;
        if (attempt < ANSWER_MAX_ATTEMPTS - 1) {
          await sleep(ANSWER_RETRY_DELAY_MS);
        }
      }
    }

    throw lastError;
  };

  const handleAnswer = async (option: AnswerOptionKey | null, reactionTimeMs: number) => {
    if (!isOnline) {
      toast.error("You are offline. Reconnect before submitting an answer.");
      return;
    }
    if (answerStateRef.current?.status === "pending") return;

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    lastAnswerRef.current = { option, reactionTimeMs };

    setAnswerError(null);
    setAnswerState({ selectedOption: option, status: "pending", correct: null });

    try {
      const result = await submitAnswer(option, reactionTimeMs, abortController.signal);
      if (!mountedRef.current) return;

      setAnswerState({ selectedOption: option, status: "settled", correct: result.correct });
      setScores((prev) => [...prev, result.score]);
      await sleep(ANSWER_SETTLED_DELAY_MS);
      if (!mountedRef.current || abortController.signal.aborted) return;

      setAnswerState(null);
      if (currentRoundRef.current < TOTAL_ROUNDS) {
        setCurrentRound((round) => (round + 1) as 1 | 2 | 3);
      } else {
        setPhase("result");
      }
    } catch (err: any) {
      if (!mountedRef.current || err.name === "CanceledError" || err.message === "Aborted") return;
      const message = errorMessage(err);
      setAnswerState(null);
      setAnswerError(message);
      toast.error(message);
    }
  };

  const retryLastAnswer = () => {
    const last = lastAnswerRef.current;
    if (!last) return;
    void handleAnswer(last.option, last.reactionTimeMs);
  };

  const handleResume = () => {
    if (!recoverySession) return;
    const nextRound = Math.min(Math.max(recoverySession.current_round, 1), 3) as 1 | 2 | 3;
    const priorScores = scoresForResume(recoverySession);

    setScores(priorScores.length > 0 ? priorScores : [recoverySession.total_score].filter(Boolean));
    setCurrentRound(nextRound);
    setAnswerError(null);
    setAnswerState(null);
    setRecoverySession(null);
    setPhase("challenge");
  };

  const handleForfeit = async () => {
    try {
      await clearOpenSession();
      setRecoverySession(null);
      setScores([]);
      setCurrentRound(1);
      setAnswerError(null);
      setAnswerState(null);
      setPhase("warmup");
      router.replace(`/challenge/${challengeId}`);
    } catch {
      toast.error("Couldn't forfeit this session. Please try again.");
    }
  };

  const handleStartNew = async () => {
    try {
      await clearOpenSession();
      setRecoverySession(null);
      setScores([]);
      setCurrentRound(1);
      setAnswerError(null);
      setAnswerState(null);
      setPhase("warmup");
    } catch {
      toast.error("Couldn't start a new session. Please try again.");
    }
  };

  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-lg font-medium text-[var(--foreground)]">{loadError}</p>
        <button
          className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          onClick={() => {
            setLoadError(null);
            router.refresh();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (
    recoverySession &&
    (recoverySession.status === "expired" || recoverySession.last_answered_round > 0)
  ) {
    return (
      <>
        <div className="min-h-screen bg-[var(--background)]" />
        <SessionRecoveryModal
          session={toRecoveryDetails(recoverySession)}
          onResume={handleResume}
          onForfeit={handleForfeit}
          onStartNew={handleStartNew}
        />
      </>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-[var(--muted-foreground)]">Loading challenge...</div>
      </div>
    );
  }

  if (phase === "preview" && challenge) {
    return (
      <>
        <BrandKitPreview
          logoUrl={challenge.logo_url ?? null}
          primaryColor={challenge.primary_color ?? null}
          secondaryColor={challenge.secondary_color ?? null}
          tagline={challenge.tagline ?? null}
          brandName={challenge.brand_name ?? "Brand"}
          onStart={handlePreviewStart}
          onSkip={handlePreviewSkip}
        />
        <FirstRunTutorial open={showTutorial} onDismiss={handleTutorialDismiss} />
      </>
    );
  }

  if (phase === "warmup" && challenge && apiToken) {
    return (
      <>
        <WarmupPhase
          challenge={challenge}
          apiToken={apiToken}
          deviceId={visitorId ?? "unknown-device"}
          onComplete={handleWarmupComplete}
        />
        <FirstRunTutorial open={showTutorial} onDismiss={handleTutorialDismiss} />
      </>
    );
  }

  if (phase === "challenge" && challenge) {
    const question = questions[currentRound - 1];
    if (!question) return null;

    return (
      <div className="min-h-screen p-6 pt-16">
        <div className="fixed right-4 top-4 z-40 flex gap-2">
          <a
            href="/docs/guides/fair-play-for-players"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] shadow-sm transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Learn about fair play and payouts"
            data-tutorial="payouts"
          >
            Fair Play
          </a>
          <button
            onClick={() => setShowReportModal(true)}
            className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] shadow-sm transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Report this challenge"
          >
            Report
          </button>
        </div>
        {showTooltip && (
          <div
            className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-5 py-3 text-sm shadow-lg"
            role="tooltip"
            aria-label="Keyboard shortcut hint"
          >
            <kbd
              className="hidden h-5 w-5 items-center justify-center rounded border border-[var(--border)] bg-[var(--muted)] text-xs font-bold text-[var(--muted-foreground)] md:inline-flex"
              aria-hidden="true"
            >
              ⌨
            </kbd>
            <span>
              Use{" "}
              <kbd
                className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-[var(--border)] bg-[var(--muted)] px-1 text-xs font-bold"
                aria-hidden="true"
              >
                A
              </kbd>
              /
              <kbd
                className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-[var(--border)] bg-[var(--muted)] px-1 text-xs font-bold"
                aria-hidden="true"
              >
                B
              </kbd>
              /
              <kbd
                className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-[var(--border)] bg-[var(--muted)] px-1 text-xs font-bold"
                aria-hidden="true"
              >
                C
              </kbd>
              /
              <kbd
                className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-[var(--border)] bg-[var(--muted)] px-1 text-xs font-bold"
                aria-hidden="true"
              >
                D
              </kbd>{" "}
              keys to answer faster
            </span>
            <button
              onClick={dismissTooltip}
              className="ml-2 rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              aria-label="Dismiss"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <OfflineBanner blocking />
        <ReportModal
          challengeId={challengeId}
          open={showReportModal}
          onOpenChange={setShowReportModal}
        />
        <ChallengeRound
          question={question}
          round={currentRound}
          onAnswer={handleAnswer}
          brandLogoUrl={challenge.logo_url ?? undefined}
          answerError={answerError}
          onRetry={retryLastAnswer}
          answerState={answerState}
          disabled={!isOnline}
          pauseTimer={!isOnline}
        />
        <FirstRunTutorial open={showTutorial} onDismiss={handleTutorialDismiss} />
      </div>
    );
  }

  if (phase === "result") {
    return (
      <>
        <ResultScreen
          totalScore={scores.reduce((a, b) => a + b, 0)}
          challengeId={challengeId}
          rank={finalRank ?? undefined}
          primaryColor={challenge?.primary_color ?? undefined}
          secondaryColor={challenge?.secondary_color ?? undefined}
        />
        <FirstRunTutorial open={showTutorial} onDismiss={handleTutorialDismiss} />
      </>
    );
  }

  return null;
}
