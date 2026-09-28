import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeaderboardEntry } from "@/lib/api";
import { LiveGlobalLeaderboard } from "@/components/leaderboard/live-global-leaderboard";
import { LastUpdated } from "@/components/leaderboard/last-updated";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { OfflineBanner } from "@/components/layout/offline-banner";

export const metadata: Metadata = {
  title: "Global Leaderboard",
  description: "See the top performers across all BrandBlitz challenges and their USDC earnings.",
  openGraph: {
    title: "Global Leaderboard | BrandBlitz",
    description: "See the top performers across all BrandBlitz challenges and their USDC earnings.",
  },
};

// Enable ISR with 30-second revalidation
export const revalidate = 30;

async function getGlobalLeaderboard(): Promise<{
  entries: LeaderboardEntry[];
  hasMore: boolean;
  failed: boolean;
  fetchedAt: number;
}> {
  try {
    const res = await api.get("/leaderboard/global?limit=50&offset=0");
    return {
      entries: res.data.leaderboard,
      hasMore: Boolean(res.data.pagination?.hasMore),
      failed: false,
      fetchedAt: Date.now(),
    };
  } catch {
    return {
      entries: [],
      hasMore: false,
      failed: true,
      fetchedAt: Date.now(),
    };
  }
}

function LeaderboardSkeleton() {
  return (
    <div className="border-b border-[var(--border)] last:border-0 px-6 py-4 space-y-4">
      {Array.from({ length: 6 }).map((_, idx) => (
        <div
          key={idx}
          className="grid grid-cols-[80px_1fr_120px_120px] gap-4 items-center"
        >
          <Skeleton className="h-5 w-10" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-4 w-36" />
          </div>
          <Skeleton className="h-4 w-20 ml-auto" />
          <Skeleton className="h-4 w-16 ml-auto" />
        </div>
      ))}
    </div>
  );
}

async function LeaderboardContent() {
  const { entries, hasMore, failed, fetchedAt } = await getGlobalLeaderboard();

  if (failed) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load leaderboard"
          description="We couldn't load the rankings right now. Please try again."
          action={
            <Link href="/leaderboard">
              <Button variant="outline">Try Again</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const initialAgeSeconds = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));

  return (
    <div>
      <div className="flex justify-end px-6 pt-4">
        <LastUpdated fetchedAt={fetchedAt} initialAgeSeconds={initialAgeSeconds} />
      </div>
      <LiveGlobalLeaderboard initial={entries} initialHasMore={hasMore} />
    </div>
  );
}

export default function LeaderboardPage() {
  return (
    <>
      <OfflineBanner />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="mb-2 text-3xl font-bold">Global Leaderboard</h1>
        <p className="mb-8 text-[var(--muted-foreground)]">
          Top performers across all challenges{" "}
          <Link
            href="/docs/guides/scoring-explained"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[var(--foreground)]"
          >
            How scoring works
          </Link>
        </p>

        <Card>
          <CardHeader>
            <CardTitle>All-Time Rankings</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Suspense fallback={<LeaderboardSkeleton />}>
              <LeaderboardContent />
            </Suspense>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
