import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeaderboardEntry } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { OfflineBanner } from "@/components/layout/offline-banner";
import { ChallengeLeaderboardClient } from "./challenge-leaderboard-client";

interface Props {
  params: {
    challengeId: string;
  };
}

export const metadata: Metadata = {
  title: "Challenge Leaderboard",
  description: "See the top performers for this challenge and their USDC earnings.",
};

export const revalidate = 30;

async function getChallengeLeaderboard(challengeId: string): Promise<{
  entries: LeaderboardEntry[];
  hasMore: boolean;
  failed: boolean;
}> {
  try {
    const res = await api.get(`/leaderboard/${challengeId}?limit=50`);
    return {
      entries: res.data.data || res.data.sessions || [],
      hasMore: Boolean(res.data.nextCursor),
      failed: false,
    };
  } catch {
    return {
      entries: [],
      hasMore: false,
      failed: true,
    };
  }
}

function LeaderboardSkeleton() {
  return (
    <div className="space-y-4 border-b border-[var(--border)] px-6 py-4 last:border-0">
      {Array.from({ length: 6 }).map((_, idx) => (
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
  );
}

async function LeaderboardContent({ challengeId }: { challengeId: string }) {
  const { entries, hasMore, failed } = await getChallengeLeaderboard(challengeId, "global");

  if (failed) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load leaderboard"
          description="We couldn't load the rankings right now. Please try again."
          action={
            <Link href={`/leaderboard/${challengeId}`}>
              <Button variant="outline">Try Again</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <ChallengeLeaderboardClient
      challengeId={challengeId}
      initialEntries={entries}
      initialHasMore={hasMore}
    />
  );
}

export default function ChallengeLeaderboardPage({ params }: Props) {
  return (
    <>
      <OfflineBanner />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="mb-2 text-3xl font-bold">Challenge Leaderboard</h1>
        <p className="mb-8 text-[var(--muted-foreground)]">Top performers for this challenge</p>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Rankings</CardTitle>
            <a
              href={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api"}/leaderboard/${params.challengeId}/export.csv`}
              download
            >
              <Button variant="outline" size="sm">
                Export CSV
              </Button>
            </a>
          </CardHeader>
          <CardContent className="p-0">
            <Suspense fallback={<LeaderboardSkeleton />}>
              <LeaderboardContent challengeId={params.challengeId} />
            </Suspense>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
