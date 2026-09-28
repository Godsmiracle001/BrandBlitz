"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsdc } from "@/lib/format";

interface ReferredUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  joinedAt: string;
  bonusPaid: boolean;
}

interface BonusStatus {
  pendingUsdc: string;
  confirmedUsdc: string;
}

interface ReferralData {
  referralCode: string;
  referredUsers: ReferredUser[];
  bonusStatus: BonusStatus;
}

export default function ReferralsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;

  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const loadReferralData = useCallback(async () => {
    if (!apiToken) return;
    setLoading(true);
    try {
      const api = createApiClient(apiToken);
      const response = await api.get("/users/me/referrals");
      setData(response.data);
    } catch (error) {
      console.error("Failed to load referral data", error);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [apiToken]);

  useEffect(() => {
    if (status === "authenticated" && apiToken) {
      void loadReferralData();
    }
  }, [status, apiToken, loadReferralData]);

  if (status !== "authenticated") return null;

  if (loading) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <div className="mb-8 space-y-2">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>

        {/* Referral Link Skeleton */}
        <Card className="mb-8">
          <CardHeader>
            <Skeleton className="h-6 w-44" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Skeleton className="h-10 flex-1" />
              <Skeleton className="h-10 w-20" />
              <Skeleton className="h-10 w-24" />
            </div>
            <Skeleton className="h-4 w-32" />
          </CardContent>
        </Card>

        {/* Bonus Tracker Skeleton */}
        <div className="mb-8 grid grid-cols-2 gap-4">
          <Card>
            <CardContent className="space-y-2 pt-6">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-8 w-24" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 pt-6">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-24" />
            </CardContent>
          </Card>
        </div>

        {/* Referred Users List Skeleton */}
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent className="p-0">
            <div className="space-y-4 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <EmptyState
          title="Failed to load referral hub"
          description="We couldn't load your referral data. Please try again."
          action={
            <Button onClick={() => void loadReferralData()} variant="outline">
              Try Again
            </Button>
          }
        />
      </main>
    );
  }

  const referralUrl = typeof window !== "undefined" ? `${window.location.origin}?ref=${data.referralCode}` : "";
  const twitterShareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    `Join me on BrandBlitz! Use my referral link: ${referralUrl}`
  )}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(referralUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Referral Hub</h1>
        <p className="text-sm text-[var(--muted-foreground)]">
          Invite friends and earn bonuses{" "}
          <a
            href="/docs/guides/referral-program"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[var(--foreground)]"
          >
            How the referral program works
          </a>
        </p>
      </div>

      {/* Referral Link */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Your Referral Link</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <input
              type="text"
              value={referralUrl}
              readOnly
              className="flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
            />
            <Button onClick={handleCopyLink} variant="outline" size="sm">
              {copied ? "Copied!" : "Copy"}
            </Button>
            <a href={twitterShareUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                Share on X
              </Button>
            </a>
          </div>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            Code: <span className="font-mono font-semibold">{data.referralCode}</span>
          </p>
        </CardContent>
      </Card>

      {/* Bonus Tracker */}
      <div className="mb-8 grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--muted-foreground)]">Pending</p>
            <p className="text-2xl font-bold text-[var(--primary)]">
              {formatUsdc(data.bonusStatus.pendingUsdc)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--muted-foreground)]">Confirmed</p>
            <p className="text-2xl font-bold text-[var(--primary)]">
              {formatUsdc(data.bonusStatus.confirmedUsdc)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Referred Users List */}
      {data.referredUsers.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Referred Users ({data.referredUsers.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    Joined
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.referredUsers.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-[var(--border)] last:border-0"
                  >
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        {user.avatarUrl ? (
                          <Image
                            src={user.avatarUrl}
                            alt={user.displayName}
                            width={32}
                            height={32}
                            className="h-8 w-8 rounded-full object-cover"
                          />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)]/10 text-xs font-semibold">
                            {user.displayName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <p className="font-medium">{user.displayName}</p>
                          <p className="text-xs text-[var(--muted-foreground)]">
                            @{user.username}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-[var(--muted-foreground)]">
                      {new Date(user.joinedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-3">
                      {user.bonusPaid ? (
                        <Badge variant="default">Bonus Paid</Badge>
                      ) : (
                        <Badge variant="secondary">Pending</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              title="No referrals yet"
              description="Share your referral link to start earning bonuses when your friends join."
              action={
                <Button onClick={handleCopyLink}>
                  Copy Referral Link
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
