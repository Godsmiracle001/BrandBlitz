"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import confetti from "canvas-confetti";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatScore, formatUsdc } from "@/lib/format";

interface ResultScreenProps {
  totalScore: number;
  rank?: number;
  estimatedUsdc?: string;
  challengeId: string;
  primaryColor?: string;
  secondaryColor?: string;
}

const COUNTER_DURATION_MS = 1200;

const DEFAULT_CONFETTI_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
];

function useAnimatedValue(target: number, durationMs: number): number {
  const [value, setValue] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (hasStartedRef.current) {
      return;
    }
    hasStartedRef.current = true;

    startTimeRef.current = null;
    lastTimestampRef.current = null;

    function easeOutCubic(t: number): number {
      return 1 - Math.pow(1 - t, 3);
    }

    function step(rawTimestamp: number) {
      let timestamp = rawTimestamp;
      if (lastTimestampRef.current !== null && timestamp <= lastTimestampRef.current) {
        timestamp = lastTimestampRef.current + 16;
      }
      lastTimestampRef.current = timestamp;

      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }
      const elapsed = timestamp - startTimeRef.current;
      const safeDuration = Math.max(durationMs, 1);
      const progress = Math.min(elapsed / safeDuration, 1);
      const easedProgress = easeOutCubic(progress);
      setValue(Math.round(easedProgress * target));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      hasStartedRef.current = false;
    };
  }, [target, durationMs]);

  return value;
}

function useConfetti(show: boolean, primaryColor?: string, secondaryColor?: string) {
  useEffect(() => {
    if (!show || typeof window === "undefined") return;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    const colors =
      primaryColor && secondaryColor ? [primaryColor, secondaryColor] : DEFAULT_CONFETTI_COLORS;

    const end = Date.now() + 3000;

    const frame = () => {
      confetti({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors,
      });
      confetti({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors,
      });

      if (Date.now() < end) {
        requestAnimationFrame(frame);
      }
    };

    requestAnimationFrame(frame);
  }, [show, primaryColor, secondaryColor]);
}

export function ResultScreen({
  totalScore,
  rank,
  estimatedUsdc,
  challengeId,
  primaryColor,
  secondaryColor,
}: ResultScreenProps) {
  const [shareToast, setShareToast] = useState<string | null>(null);
  const animatedScore = useAnimatedValue(totalScore, COUNTER_DURATION_MS);
  const isRankOne = rank === 1;
  useConfetti(isRankOne, primaryColor, secondaryColor);

  const shareText = `I just scored ${formatScore(totalScore)} in a BrandBlitz challenge${estimatedUsdc ? ` and earned ~${formatUsdc(estimatedUsdc)}` : ""}! 🏆`;

  async function handleShare(): Promise<void> {
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText, url: window.location.href });
        setShareToast("Result shared successfully.");
      } catch {
        // The native share sheet was dismissed or failed — show no confirmation.
      }
      return;
    }

    await navigator.clipboard.writeText(shareText);
    setShareToast("Result copied to clipboard.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle className="text-2xl">
            {isRankOne ? "Congratulations #1!" : "Challenge Complete!"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <p className="text-6xl font-bold text-[var(--primary)]">{formatScore(animatedScore)}</p>
            <p className="mt-1 text-[var(--muted-foreground)]">points</p>
          </div>

          {rank && <p className="text-lg font-medium">Rank #{rank}</p>}

          {estimatedUsdc && (
            <div className="usdc-pulse rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm text-green-700">Estimated earnings</p>
              <p className="text-2xl font-bold text-green-800">{formatUsdc(estimatedUsdc)}</p>
              <p className="mt-1 text-xs text-green-600">Paid out when challenge ends</p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <Button
              onClick={() => {
                void handleShare();
              }}
              variant="outline"
              className="w-full"
            >
              Share Result
            </Button>

            <div className="flex gap-2" data-tutorial="leaderboard">
              <Button asChild variant="secondary" className="flex-1">
                <Link href="/leaderboard">Global Leaderboard</Link>
              </Button>
              <Button asChild variant="secondary" className="flex-1">
                <Link href={`/leaderboard/${challengeId}`}>Challenge Leaderboard</Link>
              </Button>
            </div>

            <Button asChild className="w-full">
              <Link href="/">Play Another Challenge</Link>
            </Button>
          </div>

          {shareToast ? (
            <p role="status" aria-live="polite" className="text-sm font-medium text-green-700">
              {shareToast}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
