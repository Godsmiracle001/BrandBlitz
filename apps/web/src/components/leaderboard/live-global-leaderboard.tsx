"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { api, createApiClient } from "@/lib/api";
import { formatScore, formatUsdc } from "@/lib/format";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import type { LeaderboardEntry } from "@/lib/api";

const MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };
const PAGE_SIZE = 50;
const STORAGE_KEY = "brandblitz:leaderboard:global";

export type LeaderboardScope = "global" | "friends";

async function fetchLeaderboardPage(
  cursor?: string,
  opts?: {
    challengeId?: string;
    scope?: LeaderboardScope;
    apiToken?: string;
  }
): Promise<{
  entries: LeaderboardEntry[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  if (opts?.scope) params.set("scope", opts.scope);

  const client = opts?.apiToken ? createApiClient(opts.apiToken) : api;
  const path = opts?.challengeId
    ? `/leaderboard/${opts.challengeId}?${params.toString()}`
    : `/leaderboard/global?${params.toString()}`;
  const res = await client.get(path);
  const entries: LeaderboardEntry[] = res.data.data || res.data.sessions || [];
  const nextCursor: string | null = res.data.nextCursor ?? null;
  return { entries, nextCursor };
}

function loadSavedState(
  challengeId?: string,
  scope: LeaderboardScope = "global"
): { scrollY: number; loadedCount: number } | null {
  if (typeof window === "undefined") {
    return null;
  }

  const key = `${STORAGE_KEY}:${challengeId ?? "global"}:${scope}`;
  const raw = window.sessionStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { scrollY?: number; loadedCount?: number };
    if (typeof parsed.loadedCount !== "number") {
      return null;
    }
    return {
      scrollY: typeof parsed.scrollY === "number" ? parsed.scrollY : 0,
      loadedCount: parsed.loadedCount,
    };
  } catch {
    return null;
  }
}

export function LiveGlobalLeaderboard({
  initial,
  initialHasMore = initial.length === PAGE_SIZE,
  challengeId,
  scope = "global",
}: {
  initial: LeaderboardEntry[];
  initialHasMore?: boolean;
  challengeId?: string;
  scope?: LeaderboardScope;
}) {
  const { data: session } = useSession();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;

  const [entries, setEntries] = useState(initial);
  const [nextCursor, setNextCursor] = useState<string | null>(initialHasMore ? "first" : null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const prevRankByUserRef = useRef<Map<string, number>>(new Map());
  const [changedUsers, setChangedUsers] = useState<Set<string>>(new Set());
  const restoreOnceRef = useRef(false);

  const rows = useMemo(() => {
    return entries.map((entry) => {
      const userKey = entry.userId ?? entry.username;
      return { ...entry, _key: userKey };
    });
  }, [entries]);

  useEffect(() => {
    setEntries(initial);
    setNextCursor(initialHasMore ? "first" : null);
    restoreOnceRef.current = false;
    prevRankByUserRef.current.clear();
    setChangedUsers(new Set());
  }, [initial, initialHasMore, challengeId, scope]);

  useEffect(() => {
    const saved = loadSavedState(challengeId, scope);
    if (restoreOnceRef.current || !saved) {
      return;
    }
    restoreOnceRef.current = true;

    let cancelled = false;

    const restore = async () => {
      setIsRestoring(true);
      let currentEntries = initial.slice();
      let cursor: string | undefined = currentEntries.length > 0 ? undefined : "first";

      while (currentEntries.length < saved.loadedCount) {
        const page = await fetchLeaderboardPage(cursor === "first" ? undefined : cursor, {
          challengeId,
          scope,
          apiToken,
        });
        if (cancelled || page.entries.length === 0) {
          break;
        }

        currentEntries = currentEntries.concat(page.entries);
        cursor = page.nextCursor ?? undefined;
        setEntries(currentEntries);
        setNextCursor(page.nextCursor);

        if (!page.nextCursor) {
          break;
        }
      }

      if (!cancelled) {
        window.requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
        setIsRestoring(false);
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [initial, challengeId, scope, apiToken]);

  useEffect(() => {
    const persistState = () => {
      const key = `${STORAGE_KEY}:${challengeId ?? "global"}:${scope}`;
      window.sessionStorage.setItem(
        key,
        JSON.stringify({
          scrollY: window.scrollY,
          loadedCount: entries.length,
        })
      );
    };

    window.addEventListener("pagehide", persistState);
    window.addEventListener("beforeunload", persistState);
    return () => {
      window.removeEventListener("pagehide", persistState);
      window.removeEventListener("beforeunload", persistState);
      persistState();
    };
  }, [entries.length, challengeId, scope]);

  useEffect(() => {
    const prev = prevRankByUserRef.current;
    const changed = new Set<string>();

    for (const row of rows) {
      const prevRank = prev.get(row._key);
      if (prevRank !== undefined && prevRank !== row.rank) {
        changed.add(row._key);
      }
      prev.set(row._key, row.rank);
    }

    if (changed.size === 0) {
      return;
    }

    setChangedUsers(changed);
    const timeout = window.setTimeout(() => setChangedUsers(new Set()), 600);
    return () => window.clearTimeout(timeout);
  }, [rows]);

  const loadMore = async () => {
    if (isLoadingMore || !nextCursor) return;
    setIsLoadingMore(true);
    try {
      const page = await fetchLeaderboardPage(nextCursor === "first" ? undefined : nextCursor, {
        challengeId,
        scope,
        apiToken,
      });
      if (page.entries.length === 0) {
        setNextCursor(null);
        return;
      }
      setEntries((current) => current.concat(page.entries));
      setNextCursor(page.nextCursor);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const sentinelRef = useInfiniteScroll({
    hasNextPage: !!nextCursor,
    isLoading: isLoadingMore,
    onLoadMore: loadMore,
  });

  if (isDisconnected) {
    return (
      <div className="p-6">
        <EmptyState
          title="Connection lost"
          description="We couldn't connect to the live leaderboard. Please refresh the page to try again."
          action={
            <Button onClick={() => window.location.reload()}>Refresh to Retry</Button>
          }
        />
      </div>
    );
  }

  if (rows.length === 0) {
    if (scope === "friends") {
      return (
        <div className="p-6">
          <EmptyState
            title="No friends on the leaderboard yet"
            description="Invite friends using your referral code or play a challenge to see them here."
            action={
              <Link href="/challenge">
                <Button>Browse Challenges</Button>
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="p-6">
        <EmptyState
          title="No games played yet"
          description="Be the first to climb the leaderboard."
          action={
            <Link href="/challenge">
              <Button>Browse Challenges</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isRestoring && (
        <div className="px-6 pt-4 text-sm text-[var(--muted-foreground)]">
          Restoring your place on the board...
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="px-6 py-3 text-left font-medium text-[var(--muted-foreground)]">Rank</th>
            <th className="px-6 py-3 text-left font-medium text-[var(--muted-foreground)]">Player</th>
            <th className="px-6 py-3 text-right font-medium text-[var(--muted-foreground)]">Score</th>
            <th className="px-6 py-3 text-right font-medium text-[var(--muted-foreground)]">Earned</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr
              key={entry._key}
              className={[
                "border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/50 transition-colors",
                changedUsers.has(entry._key) ? "bg-[var(--muted)]" : "",
              ].join(" ")}
            >
              <td className="px-6 py-4 font-bold">{MEDAL[entry.rank] ?? `#${entry.rank}`}</td>
              <td className="px-6 py-4">
                <div className="flex items-center gap-3">
                  {entry.avatarUrl ? (
                    <Image
                      src={entry.avatarUrl}
                      alt={entry.displayName ?? entry.username}
                      width={32}
                      height={32}
                      sizes="32px"
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-bold text-white">
                      {(entry.displayName ?? entry.username).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="font-medium">{entry.displayName ?? entry.username}</span>
                  {entry.league && (
                    <Badge variant={entry.league as "gold" | "silver" | "bronze"}>
                      {entry.league}
                    </Badge>
                  )}
                </div>
              </td>
              <td className="px-6 py-4 text-right font-mono">{formatScore(entry.totalScore)}</td>
              <td className="px-6 py-4 text-right font-medium text-green-600">
                {entry.totalEarned ? `${formatUsdc(entry.totalEarned)} USDC` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between gap-4 px-6 pb-2">
        <p className="text-sm text-[var(--muted-foreground)]">
          Showing {rows.length} players
        </p>
        {!nextCursor && rows.length > 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">You&apos;ve seen everything</p>
        ) : null}
      </div>

      {isLoadingMore && (
        <div className="flex justify-center py-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--border)] border-t-[var(--primary)]" />
        </div>
      )}

      {/* Sentinel element for IntersectionObserver */}
      <div ref={sentinelRef} className="h-4" />
    </div>
  );
}
