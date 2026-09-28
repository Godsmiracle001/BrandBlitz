import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatScore, formatUsdc, safeDivide } from "@/lib/format";
import { StreakBadge } from "@/components/gamification/streak-badge";
import { StreakHeatmap } from "@/components/gamification/streak-heatmap";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import Image from "next/image";
import type { UserProfile } from "@/lib/api";
import {
  BadgeGrid,
  type Badge as UserBadge,
} from "@/components/gamification/badge-grid";
import { OfflineBanner } from "@/components/layout/offline-banner";
import type { Metadata } from "next";

interface ProfilePageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const { username } = await params;
  const { user, redirect: redirectTarget } = await getUserProfile(username);

  if (redirectTarget) {
    return { title: "Redirecting…" };
  }

  if (!user) {
    return {
      title: "Profile Not Found",
    };
  }

  const title = `${user.displayName} (@${user.username}) — Profile`;
  const description = `Check out ${user.displayName}'s profile on BrandBlitz. They have earned ${formatUsdc(user.totalEarned ?? "0")} USDC across ${user.totalChallenges ?? 0} challenges.`;

  return {
    title,
    description,
    alternates: {
      canonical: `/profile/${username}`,
    },
    openGraph: {
      title,
      description,
      images: user.avatarUrl ? [{ url: user.avatarUrl, alt: user.displayName }] : undefined,
    },
    twitter: {
      card: "summary",
      title,
      description,
      images: user.avatarUrl ? [user.avatarUrl] : undefined,
    },
  };
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

interface PublicProfileBadge {
  slug: string;
  name: string;
  description: string;
  iconUrl: string | null;
  awardedAt: string;
}

interface PublicProfileLeague {
  tier: "bronze" | "silver" | "gold";
  rank: number | null;
  season: string;
}

interface PublicProfile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  joinedAt: string;
  winCount: number;
  totalSessionsPlayed: number;
  accuracyPct: number;
  league: PublicProfileLeague | null;
  badges: PublicProfileBadge[];
}

async function getUserProfile(
  username: string,
): Promise<{ user: UserProfile | null; publicProfile: PublicProfile | null; failed: boolean; redirect?: string }> {
  // Check for a username redirect first
  try {
    const redirectRes = await fetch(`${API_URL}/users/profile/${username}`, {
      next: { tags: [`profile-${username}`] },
    });
    if (redirectRes.ok) {
      const data = await redirectRes.json();
      if (data.redirect) {
        return { user: null, publicProfile: null, failed: false, redirect: data.redirect };
      }
    }
  } catch (err) {
    console.error("Failed to check username redirect:", err);
    // fall through to public profile fetch
  }

  // Fetch from the new public endpoint
  try {
    const res = await fetch(`${API_URL}/users/${username}/public`, {
      next: { tags: [`profile-${username}`] },
    });
    if (res.status === 404) {
      return { user: null, publicProfile: null, failed: false };
    }
    if (!res.ok) throw new Error("Failed to fetch");
    const publicProfile: PublicProfile = await res.json();

    // Map PublicProfile to UserProfile for backward-compatible rendering
    const user: UserProfile = {
      displayName: publicProfile.displayName,
      username: publicProfile.username,
      league: publicProfile.league?.tier ?? null,
      totalEarned: "0",
      totalChallenges: publicProfile.totalSessionsPlayed,
      avatarUrl: publicProfile.avatarUrl,
      createdAt: publicProfile.joinedAt,
    };

    return { user, publicProfile, failed: false };
  } catch (err) {
    console.error("Failed to fetch public profile:", err);
    return { user: null, publicProfile: null, failed: true };
  }
}

async function getUserActivity(username: string) {
  try {
    const res = await fetch(`${API_URL}/users/${username}/activity`);
    if (!res.ok) throw new Error("Failed to fetch");
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch user activity:", err);
    return [];
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

const LEAGUE_CONFIG = {
  bronze: { label: "Bronze League", color: "bg-amber-600", textColor: "text-white" },
  silver: { label: "Silver League", color: "bg-slate-300", textColor: "text-slate-800" },
  gold: { label: "Gold League", color: "bg-yellow-400", textColor: "text-yellow-900" },
} as const;

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { username } = await params;
  if (!username?.trim()) notFound();
  const { user, publicProfile, failed, redirect: redirectTarget } = await getUserProfile(username);

  if (redirectTarget) {
    redirect(`/profile/${redirectTarget}`);
  }

  if (!user && failed) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <EmptyState
          title="Couldn't load profile"
          description="We couldn't load this profile right now. Please try again."
          action={
            <Link href={`/profile/${username}`}>
              <Button variant="outline">Try Again</Button>
            </Link>
          }
        />
      </main>
    );
  }

  if (!user) notFound();

  // Badges come from the public endpoint (already limited to 6 most recent).
  // Map them to the BadgeGrid shape expected by the component.
  const badges: UserBadge[] = (publicProfile?.badges ?? []).map((b) => ({
    id: b.slug,
    slug: b.slug,
    name: b.name,
    description: b.description,
    iconUrl: b.iconUrl ?? "",
    earned: true,
    earnedAt: b.awardedAt,
    criteria: "",
  }));
  const earnedIds = badges.map((b) => b.id);
  const activity = await getUserActivity(username);

  const streak = user.streak ?? 0;
  const recentSessions = user.recentSessions ?? [];
  const milestones = [3, 7, 14, 30];
  const nextMilestone =
    milestones.find((m) => m > streak) ?? milestones[milestones.length - 1];
  const progress = Math.min(1, safeDivide(streak, nextMilestone, 0));

  return (
    <>
      <OfflineBanner />
      <main className="mx-auto max-w-2xl px-6 py-12">
      {/* Profile header */}
      <div className="mb-10 flex items-center gap-6">
        {user.avatarUrl ? (
          <Image
            src={user.avatarUrl}
            alt={user.displayName}
            width={80}
            height={80}
            sizes="80px"
            className="h-20 w-20 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--primary)] text-2xl font-bold text-white">
            {user.displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{user.displayName}</h1>
          <p className="text-[var(--muted-foreground)]">@{user.username}</p>
          {user.createdAt && (
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              Member since {formatDate(user.createdAt)}
            </p>
          )}
        </div>
        {user.isOwner && (
          <div className="flex gap-2">
            <Link href={`/profile/${user.username}/earnings`}>
              <Button variant="outline" size="sm">
                Earnings
              </Button>
            </Link>
            <Link href="/settings/profile">
              <Button variant="outline" size="sm">
                Edit Profile
              </Button>
            </Link>
          </div>
        )}
      </div>

      {/* League banner */}
      {(user.league ?? publicProfile?.league?.tier) && (
        <Card className={`mb-8 border-0 ${LEAGUE_CONFIG[user.league ?? publicProfile!.league!.tier].color}`}>
          <CardContent className="flex items-center gap-4 py-4">
            <div className={`flex h-14 w-14 items-center justify-center rounded-full ${LEAGUE_CONFIG[user.league ?? publicProfile!.league!.tier].color} border-2 border-white/30 text-2xl`}>
              {(user.league ?? publicProfile?.league?.tier) === "gold" ? "🏆" : (user.league ?? publicProfile?.league?.tier) === "silver" ? "🥈" : "🥉"}
            </div>
            <div>
              <p className={`text-lg font-bold ${LEAGUE_CONFIG[user.league ?? publicProfile!.league!.tier].textColor}`}>
                {LEAGUE_CONFIG[user.league ?? publicProfile!.league!.tier].label}
              </p>
              {publicProfile?.league?.rank != null ? (
                <p className={`text-sm ${LEAGUE_CONFIG[user.league ?? publicProfile!.league!.tier].textColor}/80`}>
                  Rank #{publicProfile.league.rank} this week
                </p>
              ) : (
                <p className={`text-sm ${LEAGUE_CONFIG[user.league ?? publicProfile!.league!.tier].textColor}/80`}>
                  Unranked this week — play a challenge to enter standings or{" "}
                  <Link href="/leaderboard" className="underline font-medium hover:opacity-90">
                    view leaderboard
                  </Link>
                  .
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {streak > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Streak Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-[var(--muted-foreground)]">
                  Current streak
                </p>
                <p className="text-3xl font-bold text-[var(--primary)]">
                  {streak} days
                </p>
              </div>
              <StreakBadge streak={streak} label="Current streak" />
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-400 to-red-500"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">
              Next milestone: {nextMilestone} days ({Math.round(progress * 100)}
              %)
            </p>
          </CardContent>
        </Card>
      )}

      {isOwner && (
        <p className="mb-8 text-xs text-[var(--muted-foreground)]">
          <Link href="/docs/guides/streaks-explained" className="underline hover:text-[var(--foreground)]">
            How do streaks work?
          </Link>
        </p>
      )}

      {/* Stats */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        {[
          { label: "Sessions Played", value: publicProfile?.totalSessionsPlayed ?? user.totalChallenges ?? 0 },
          { label: "Wins", value: publicProfile?.winCount ?? 0 },
          { label: "Accuracy", value: `${publicProfile?.accuracyPct ?? 0}%` },
        ].map(({ label, value }) => (
          <Card key={label} className="text-center">
            <CardContent className="pb-4 pt-6">
              <p className="text-2xl font-bold text-[var(--primary)]">
                {value}
              </p>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                {label}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Badges */}
      {badges.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Badges</CardTitle>
          </CardHeader>
          <CardContent>
            <BadgeGrid badges={badges} previouslyEarned={earnedIds} />
          </CardContent>
        </Card>
      )}

      {/* Activity heatmap */}
      {activity.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <StreakHeatmap activity={activity} />
          </CardContent>
        </Card>
      )}

      {/* Win history */}
      <Card>
        <CardHeader>
          <CardTitle>Win History</CardTitle>
        </CardHeader>
        {recentSessions.length > 0 ? (
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    Brand
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    Score
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.slice(0, 10).map((session) => (
                  <tr
                    key={session.id}
                    className="border-b border-[var(--border)] last:border-0"
                  >
                    <td className="px-6 py-3 font-medium">
                      {session.brandName}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {formatScore(session.totalScore)}
                    </td>
                    <td className="px-6 py-3 text-right text-[var(--muted-foreground)]">
                      {session.completedAt
                        ? new Date(session.completedAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })
                        : (
                          <span title="Not completed yet — session still in progress">
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">Not completed yet</span>
                          </span>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        ) : (
          <CardContent>
            <EmptyState
              title="No history yet"
              description="Play a challenge to start building your stats."
              action={
                <Link href="/challenge">
                  <Button>Browse Challenges</Button>
                </Link>
              }
            />
          </CardContent>
        )}
      </Card>
      </main>
    </>
  );
}
