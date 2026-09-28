"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { LeaderboardEntry } from "@/lib/api";
import { toast } from "@/lib/toast";

type LiveState =
  | { status: "idle" | "connecting" | "polling"; entries: LeaderboardEntry[] }
  | { status: "live"; entries: LeaderboardEntry[]; updatedAt?: string }
  | { status: "disconnected"; entries: LeaderboardEntry[] };

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost/api";

function buildStreamUrl(challengeId?: string) {
  const url = new URL("/leaderboard/stream", API_BASE);
  if (challengeId) url.searchParams.set("challengeId", challengeId);
  return url.toString();
}

export function useLiveLeaderboard(opts?: {
  challengeId?: string;
  initial?: LeaderboardEntry[];
}): LiveState {
  const challengeId = opts?.challengeId;
  const [state, setState] = useState<LiveState>({
    status: "idle",
    entries: opts?.initial ?? [],
  });

  const pollTimerRef = useRef<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const hasShownConnectionErrorRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  const pollUrl = useMemo(() => {
    if (challengeId) return `/leaderboard/${challengeId}?limit=100`;
    return "/leaderboard/global";
  }, [challengeId]);

  useEffect(() => {
    setState((prev: LiveState) => ({ ...prev, status: "connecting" as const }));
    reconnectAttemptsRef.current = 0;

    const reportConnectionError = () => {
      if (hasShownConnectionErrorRef.current) return;
      hasShownConnectionErrorRef.current = true;
      toast.error(
        challengeId
          ? "Couldn't refresh the challenge leaderboard. Retrying..."
          : "Couldn't refresh the leaderboard. Retrying..."
      );
    };

    const clearConnectionError = () => {
      hasShownConnectionErrorRef.current = false;
    };

    const stopPolling = () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const stopReconnect = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const startPolling = () => {
      stopPolling();
      setState((prev: LiveState) => ({ ...prev, status: "polling" as const }));

      const fetchOnce = async () => {
        try {
          const res = await api.get(pollUrl);
          const nextEntries: LeaderboardEntry[] = challengeId
            ? res.data.sessions
            : res.data.leaderboard;
          clearConnectionError();
          setState({ status: "polling", entries: nextEntries });
        } catch (err) {
          console.error("Failed to fetch leaderboard:", err);
          reportConnectionError();
        }
      };

      void fetchOnce();
      pollTimerRef.current = window.setInterval(() => {
        void fetchOnce();
      }, 5000);
    };

    const calculateBackoff = (attempt: number): number => {
      const baseDelay = 1000;
      const maxDelay = 30000;
      const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = exponentialDelay * 0.5 * Math.random();
      return exponentialDelay + jitter;
    };

    const reconnect = () => {
      const attempts = reconnectAttemptsRef.current;
      if (attempts >= 10) {
        setState((prev: LiveState) => ({ ...prev, status: "disconnected" as const }));
        return;
      }

      const delay = calculateBackoff(attempts);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectAttemptsRef.current = attempts + 1;
        connect();
      }, delay);
    };

    const connect = () => {
      stopPolling();
      stopReconnect();
      sourceRef.current?.close();
      sourceRef.current = null;

      let closed = false;

      try {
        const source = new EventSource(buildStreamUrl(challengeId));
        sourceRef.current = source;

        source.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (closed) return;
            const nextEntries: LeaderboardEntry[] = challengeId ? data.sessions : data.leaderboard;
            clearConnectionError();
            reconnectAttemptsRef.current = 0;
            setState({ status: "live", entries: nextEntries, updatedAt: data.updatedAt });
          } catch {
            // ignore parse errors
          }
        };

        source.onerror = () => {
          if (closed) return;
          source.close();
          reportConnectionError();
          reconnect();
        };
      } catch {
        reportConnectionError();
        reconnect();
      }

      return () => {
        closed = true;
      };
    };

    connect();

    return () => {
      stopPolling();
      stopReconnect();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [challengeId, pollUrl]);

  return state;
}
