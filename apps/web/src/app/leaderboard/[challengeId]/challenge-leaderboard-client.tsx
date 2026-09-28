"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { LiveGlobalLeaderboard, LeaderboardScope } from "@/components/leaderboard/live-global-leaderboard";
import { createApiClient, api } from "@/lib/api";
import type { LeaderboardEntry } from "@/lib/api";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  challengeId: string;
  initialEntries: LeaderboardEntry[];
  initialHasMore: boolean;
}

export function ChallengeLeaderboardClient({
  challengeId,
  initialEntries,
  initialHasMore,
}: Props) {
  const { data: session, status } = useSession();
  const [scope, setScope] = useState<LeaderboardScope>("global");
  const [entries, setEntries] = useState<LeaderboardEntry[]>(initialEntries);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isLoadingFriends, setIsLoadingFriends] = useState(false);
  const [friendsFailed, setFriendsFailed] = useState(false);

  const isLoggedIn = status === "authenticated";

  useEffect(() => {
    if (scope !== "friends") {
      setEntries(initialEntries);
      setHasMore(initialHasMore);
      setFriendsFailed(false);
      return;
    }

    if (!isLoggedIn) {
      setEntries([]);
      setHasMore(false);
      return;
    }

    const loadFriendsLeaderboard = async () => {
      setIsLoadingFriends(true);
      setFriendsFailed(false);
      try {
        const token = session?.apiToken;
        const client = token ? createApiClient(token) : api;
        const res = await client.get(
          `/leaderboard/${challengeId}?limit=50&scope=friends`
        );
        const data: LeaderboardEntry[] = res.data.data || res.data.sessions || [];
        setEntries(data);
        setHasMore(Boolean(res.data.nextCursor));
      } catch {
        setFriendsFailed(true);
        setEntries([]);
        setHasMore(false);
      } finally {
        setIsLoadingFriends(false);
      }
    };

    void loadFriendsLeaderboard();
  }, [scope, isLoggedIn, challengeId, initialEntries, initialHasMore, session?.apiToken]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-6 py-4">
        <div
          role="tablist"
          aria-label="Leaderboard scope"
          className="inline-flex items-center rounded-md bg-[var(--muted)] p-1"
        >
          <Button
            role="tab"
            aria-selected={scope === "global"}
            size="sm"
            variant={scope === "global" ? "default" : "ghost"}
            className="h-8"
            onClick={() => setScope("global")}
          >
            Global
          </Button>
          <Button
            role="tab"
            aria-selected={scope === "friends"}
            size="sm"
            variant={scope === "friends" ? "default" : "ghost"}
            className="h-8"
            onClick={() => setScope("friends")}
          >
            Friends
          </Button>
        </div>

        {scope === "friends" && !isLoggedIn && (
          <p className="text-sm text-[var(--muted-foreground)]">
            Sign in to view your friends leaderboard
          </p>
        )}
      </div>

      {scope === "friends" && !isLoggedIn ? (
        <div className="p-6">
          <EmptyState
            title="Sign in to view friends"
            description="Log in with Google to see how your referred friends rank on this challenge."
            action={
              <Link href={`/login?callbackUrl=${encodeURIComponent(`/leaderboard/${challengeId}`)}`}>
                <Button>Sign In</Button>
              </Link>
            }
          />
        </div>
      ) : scope === "friends" && isLoadingFriends ? (
        <div className="space-y-4 px-6 py-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="grid grid-cols-[80px_1fr_120px_120px] items-center gap-4">
              <Skeleton className="h-5 w-10" />
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 w-36" />
              </div>
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : scope === "friends" && friendsFailed ? (
        <div className="p-6">
          <EmptyState
            title="Couldn't load friends leaderboard"
            description="We couldn't load your friends rankings right now. Please try again."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  const token = session?.apiToken;
                  const client = token ? createApiClient(token) : api;
                  setIsLoadingFriends(true);
                  setFriendsFailed(false);
                  client
                    .get(`/leaderboard/${challengeId}?limit=50&scope=friends`)
                    .then((res) => {
                      const data: LeaderboardEntry[] =
                        res.data.data || res.data.sessions || [];
                      setEntries(data);
                      setHasMore(Boolean(res.data.nextCursor));
                      setFriendsFailed(false);
                    })
                    .catch(() => setFriendsFailed(true))
                    .finally(() => setIsLoadingFriends(false));
                }}
              >
                Try Again
              </Button>
            }
          />
        </div>
      ) : (
        <LiveGlobalLeaderboard
          initial={entries}
          initialHasMore={hasMore}
          challengeId={challengeId}
          scope={scope}
        />
      )}
    </div>
  );
}
