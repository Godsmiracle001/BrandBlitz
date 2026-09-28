"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { CountdownTimer } from "./countdown-timer";
import { WARMUP_MIN_SECONDS } from "./constants";
import { createApiClient } from "@/lib/api";
import { useSubmitting } from "@/hooks/use-submitting";
import type { Challenge } from "@/lib/api";

interface WarmupPhaseProps {
  challenge: Challenge;
  apiToken: string;
  onComplete: (challengeToken: string) => void;
  deviceId?: string;
}

export function WarmupPhase({ challenge, apiToken, onComplete, deviceId }: WarmupPhaseProps) {
  const [unlocked, setUnlocked] = useState(false);
  const { submitting, wrap } = useSubmitting();
  const handleTimerExpire = useCallback(() => setUnlocked(true), []);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [deadlineAt, setDeadlineAt] = useState<number | undefined>(undefined);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const api = createApiClient(apiToken);
    api.post(
      `/sessions/${challenge.id}/warmup-start`,
      {},
      deviceId ? { headers: { "X-Device-Id": deviceId } } : undefined,
    ).then((res) => {
      if (res.data?.unlockAt) {
        setDeadlineAt(res.data.unlockAt);
      }
    }).catch(() => {
      setStatusMessage("Failed to initialize warmup. Please refresh.");
    });
  }, [apiToken, challenge.id, deviceId]);

  const handleStartChallenge = async () => {
    setStatusMessage(null);
    setShowRetry(false);

    try {
      await wrap(async () => {
        const api = createApiClient(apiToken);
        const res = await api.post(`/sessions/${challenge.id}/warmup-complete`);
        const data = res.data;

        if (!data?.challengeToken) {
          throw new Error("Missing challenge token");
        }

        onComplete(data.challengeToken);
      });
    } catch (error: any) {
      if (error?.response?.status === 400 && typeof error?.response?.data?.remainingMs === "number") {
        setStatusMessage(
          `Not yet ready. Please wait ${Math.ceil(error.response.data.remainingMs / 1000)} more seconds and try again.`
        );
        return;
      }

      setStatusMessage("Couldn't start the challenge. Check your connection and try again.");
      setShowRetry(true);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-6"
      style={{
        background: `linear-gradient(135deg, ${challenge.primary_color ?? "var(--primary)"} 0%, ${challenge.secondary_color ?? "var(--background)"} 100%)`,
      }}
    >
      <div className="max-w-lg w-full bg-white/90 backdrop-blur-sm rounded-2xl shadow-2xl p-8 space-y-6">
        {/* Brand logo */}
        {challenge.logo_url && (
          <div className="flex justify-center">
            <Image
              src={challenge.logo_url}
              alt={challenge.brand_name ?? "Brand logo"}
              width={120}
              height={120}
              sizes="120px"
              className="object-contain rounded-xl"
              priority
            />
          </div>
        )}

        {/* Brand name */}
        <h1 className="text-3xl font-bold text-center text-slate-900">
          {challenge.brand_name}
        </h1>

        {challenge.tagline ? (
          <p className="text-center text-base font-medium text-slate-700">{challenge.tagline}</p>
        ) : null}

        {/* Warmup instructions */}
        <p className="text-center text-slate-600 text-sm">
          Study this brand carefully — you&#39;ll be tested on it in a moment.
          Top scorers win USDC instantly.
        </p>

        {/* Countdown */}
        <div className="py-4">
          <CountdownTimer
            durationSeconds={WARMUP_MIN_SECONDS}
            deadlineAt={deadlineAt}
            onExpire={handleTimerExpire}
            onPausedChange={setIsPaused}
          />
          {unlocked ? (
            <p
              role="status"
              className="text-center text-sm font-semibold text-green-700 mt-2 motion-safe:animate-pulse motion-reduce:animate-none"
            >
              <span aria-hidden="true">✓ </span>Ready!
            </p>
          ) : (
            <p className="text-center text-xs text-slate-500 mt-2">
              Study time remaining
            </p>
          )}
        </div>

        {/* Start button — unlocked after minimum warmup and not paused */}
        <Button
          onClick={handleStartChallenge}
          disabled={!unlocked || submitting || isPaused}
          size="lg"
          className="w-full text-lg"
          style={{ backgroundColor: challenge.primary_color ?? undefined }}
        >
          {submitting ? "Starting..." : isPaused ? "Paused — Wait to resume" : unlocked ? "Start Challenge →" : "Preparing..."}
        </Button>

        {statusMessage ? (
          <p role="alert" className="text-center text-sm text-slate-700">
            {statusMessage}
          </p>
        ) : null}

        {showRetry ? (
          <Button
            onClick={handleStartChallenge}
            disabled={submitting}
            variant="outline"
            className="w-full"
          >
            Retry
          </Button>
        ) : null}

        <p className="text-center text-xs text-slate-400">
          Prize pool: <strong>{challenge.pool_amount_usdc} USDC</strong>
        </p>
      </div>
    </div>
  );
}
