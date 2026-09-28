"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatUsdc } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";
import { BenchmarkPanel } from "./benchmark-panel";
import { EscrowPanel } from "./escrow-panel";

interface ChallengeStats {
  total_sessions: number;
  completed_sessions: number;
  completion_rate_pct: number;
  disqualification_rate_pct: number;
  avg_score: number;
  avg_accuracy_pct: number;
  avg_time_per_round_ms: number;
  total_paid_out_usdc: number;
  cost_per_completed_session_usdc: number;
  unique_participants: number;
}

interface BrandWithChallenges {
  id: string;
  name: string;
  logoUrl?: string;
  primaryColor?: string;
  challenges: {
    id: string;
    status: string;
    poolAmountUsdc: string;
    participantCount: number;
    endsAt: string;
    stats?: ChallengeStats;
  }[];
}

interface LicenseOffer {
  challenge_id: string;
  challenge_name: string;
  licensor_brand_name: string;
  fee_bps: number;
}

interface BrandLicense {
  id: string;
  source_challenge_id: string;
  challenge_name?: string;
  fee_bps: number;
  licensor_brand_name?: string;
  licensee_brand_name?: string;
}

interface BrandLicenses {
  offered: LicenseOffer[];
  acquired: BrandLicense[];
  issued: BrandLicense[];
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const [brands, setBrands] = useState<BrandWithChallenges[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [deletingBrandId, setDeletingBrandId] = useState<string | null>(null);
  const [marketplaceOffers, setMarketplaceOffers] = useState<LicenseOffer[]>([]);
  const [licensesByBrand, setLicensesByBrand] = useState<Record<string, BrandLicenses>>({});
  const [licensingAction, setLicensingAction] = useState<string | null>(null);

  async function loadBrands(apiToken: string) {
    setLoading(true);
    setLoadError(false);

    const api = createApiClient(apiToken);

    try {
      const res = await api.get("/brands/mine");
      const brandsData: BrandWithChallenges[] = (res.data.brands ?? res.data.items ?? []).map(
        (brand: BrandWithChallenges) => ({
          ...brand,
          challenges: brand.challenges ?? [],
        })
      );

      const brandsWithStats = await Promise.all(
        brandsData.map(async (brand: BrandWithChallenges) => {
          const challenges = await Promise.all(
            brand.challenges.map(async (challenge) => {
              try {
                const statsResponse = await api.get(`/challenges/${challenge.id}/stats`);
                return {
                  ...challenge,
                  stats: statsResponse.data.stats as ChallengeStats,
                };
              } catch {
                return challenge;
              }
            })
          );
          return { ...brand, challenges };
        })
      );

      setBrands(brandsWithStats);
      try {
        const [marketplace, licenseEntries] = await Promise.all([
          api.get("/brands/license-marketplace"),
          Promise.all(
            brandsWithStats.map(async (brand) => {
              const response = await api.get(`/brands/${brand.id}/licenses`);
              return [brand.id, response.data] as const;
            })
          ),
        ]);
        setMarketplaceOffers(marketplace.data.offers ?? []);
        setLicensesByBrand(Object.fromEntries(licenseEntries));
      } catch {
        // Licensing is supplementary; keep the main dashboard usable if it fails.
        setMarketplaceOffers([]);
        setLicensesByBrand({});
      }
    } catch {
      setBrands([]);
      setLoadError(true);
      toast.error("Couldn't load brands. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshLicensing() {
    if (!apiToken) return;
    const api = createApiClient(apiToken);
    const [marketplace, entries] = await Promise.all([
      api.get("/brands/license-marketplace"),
      Promise.all(
        brands.map(async (brand) => {
          const response = await api.get(`/brands/${brand.id}/licenses`);
          return [brand.id, response.data] as const;
        })
      ),
    ]);
    setMarketplaceOffers(marketplace.data.offers ?? []);
    setLicensesByBrand(Object.fromEntries(entries));
  }

  async function acquireLicense(brandId: string, challengeId: string) {
    if (!apiToken || licensingAction) return;
    setLicensingAction(`acquire:${brandId}:${challengeId}`);
    try {
      await createApiClient(apiToken).post(`/brands/${brandId}/license-challenge`, { challengeId });
      await refreshLicensing();
    } catch {
      toast.error("Couldn't acquire this challenge license.");
    } finally {
      setLicensingAction(null);
    }
  }

  async function setLicenseOffer(brandId: string, challengeId: string, available: boolean) {
    if (!apiToken || licensingAction) return;
    setLicensingAction(`offer:${challengeId}`);
    try {
      await createApiClient(apiToken).patch(
        `/brands/${brandId}/challenges/${challengeId}/licensing`,
        { available, feeBps: 500 }
      );
      await refreshLicensing();
    } catch {
      toast.error("Couldn't update licensing availability.");
    } finally {
      setLicensingAction(null);
    }
  }

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
      return;
    }
    if (status !== "authenticated" || !apiToken) return;

    void loadBrands(apiToken);
  }, [apiToken, status, router]);

  async function handleDeleteBrand(brand: BrandWithChallenges) {
    if (deletingBrandId) return;
    const ok = window.confirm(`Delete "${brand.name}"? This can't be undone.`);
    if (!ok) return;
    if (!apiToken) return;

    setDeletingBrandId(brand.id);
    try {
      const api = createApiClient(apiToken);
      await api.delete(`/brands/${brand.id}`);
      setBrands((prev) => prev.filter((b) => b.id !== brand.id));
    } catch {
      toast.error(`Couldn't delete "${brand.name}". Please try again.`);
    } finally {
      setDeletingBrandId(null);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <div className="mb-8 flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="space-y-6">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-12 w-12 rounded-lg" />
                    <div className="space-y-1">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-28" />
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-8 w-16" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="grid grid-cols-9 gap-4 border-b border-[var(--border)] pb-2">
                    {Array.from({ length: 9 }).map((_, ci) => (
                      <Skeleton key={ci} className="h-4 w-full" />
                    ))}
                  </div>
                  {[0, 1].map((row) => (
                    <div key={row} className="grid grid-cols-9 gap-4">
                      {Array.from({ length: 9 }).map((_, ci) => (
                        <Skeleton key={ci} className="h-4 w-full" />
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Brand Dashboard</h1>
          <p className="mt-1 text-[var(--muted-foreground)]">
            Manage your brand kits and challenges
          </p>
          <div className="mt-2 flex gap-4 text-xs text-[var(--muted-foreground)]">
            <Link
              href="/docs/guides/question-review-workflow"
              className="underline hover:text-[var(--foreground)]"
            >
              Review questions guide
            </Link>
            <Link
              href="/docs/guides/funding-a-challenge"
              className="underline hover:text-[var(--foreground)]"
            >
              Funding guide
            </Link>
          </div>
        </div>
        <Link href="/brand/new">
          <Button>+ New Brand</Button>
        </Link>
      </div>

      {loadError ? (
        <EmptyState
          title="Couldn't load brands"
          description="We couldn't load your brands — tap to retry."
          action={
            <Button disabled={!apiToken} onClick={() => apiToken && void loadBrands(apiToken)}>
              Try Again
            </Button>
          }
        />
      ) : brands.length === 0 ? (
        <EmptyState
          title="No brands yet"
          description="Create your first brand kit and launch a challenge in minutes."
          action={
            <Link href="/brand/new">
              <Button>Create Brand Kit</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Challenge licensing marketplace</CardTitle>
              <CardDescription>
                License proven formats from other brands. Fees are split automatically at payout.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {marketplaceOffers.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)]">
                  No challenge formats are currently offered by other brands.
                </p>
              ) : (
                <div className="space-y-3">
                  {marketplaceOffers.map((offer) => (
                    <div
                      key={offer.challenge_id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3"
                    >
                      <div>
                        <p className="font-medium">{offer.licensor_brand_name}</p>
                        <p className="text-xs text-[var(--muted-foreground)]">
                          {offer.challenge_name} · {(offer.fee_bps / 100).toFixed(2)}% licensing fee
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {brands.map((brand) => (
                          <Button
                            key={brand.id}
                            size="sm"
                            variant="outline"
                            disabled={Boolean(licensingAction)}
                            onClick={() => void acquireLicense(brand.id, offer.challenge_id)}
                          >
                            License for {brand.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {brands.map((brand) => {
                const licenses = licensesByBrand[brand.id];
                if (!licenses || (licenses.acquired.length === 0 && licenses.issued.length === 0)) {
                  return null;
                }
                return (
                  <div key={brand.id} className="space-y-2 border-t border-[var(--border)] pt-4">
                    <p className="font-medium">{brand.name}</p>
                    {licenses.acquired.map((license) => (
                      <p key={license.id} className="text-sm text-[var(--muted-foreground)]">
                        Acquired {license.challenge_name ?? "challenge format"} from{" "}
                        {license.licensor_brand_name}
                        {" · "}
                        {(license.fee_bps / 100).toFixed(2)}% fee
                      </p>
                    ))}
                    {licenses.issued.map((license) => (
                      <p key={license.id} className="text-sm text-[var(--muted-foreground)]">
                        Licensed {license.challenge_name ?? "challenge format"} to{" "}
                        {license.licensee_brand_name}
                        {" · "}
                        {(license.fee_bps / 100).toFixed(2)}% fee
                      </p>
                    ))}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {brands.map((brand) => (
            <Card key={brand.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {brand.logoUrl ? (
                      <Image
                        src={brand.logoUrl}
                        alt={brand.name}
                        width={160}
                        height={48}
                        sizes="160px"
                        className="h-12 w-auto object-contain"
                      />
                    ) : (
                      <div
                        className="h-12 w-12 rounded-lg"
                        style={{
                          backgroundColor: brand.primaryColor ?? "var(--primary)",
                        }}
                      />
                    )}
                    <div>
                      <CardTitle>{brand.name}</CardTitle>
                      <CardDescription>{brand.challenges.length} challenge(s)</CardDescription>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/brand/${brand.id}`}>
                      <Button variant="outline" size="sm">
                        View Analytics
                      </Button>
                    </Link>
                    <Link href={`/brand/${brand.id}/challenge/new`}>
                      <Button size="sm">Launch Challenge</Button>
                    </Link>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deletingBrandId === brand.id}
                      onClick={() => handleDeleteBrand(brand)}
                    >
                      {deletingBrandId === brand.id ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {brand.challenges.length === 0 ? (
                <CardContent>
                  <EmptyState
                    title="No challenges yet"
                    description="Launch your first challenge to start collecting brand insights."
                    action={
                      <Link href={`/brand/${brand.id}/challenge/new`}>
                        <Button size="sm">Launch Challenge</Button>
                      </Link>
                    }
                  />
                </CardContent>
              ) : (
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] text-sm">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          <th className="py-2 text-left font-medium text-[var(--muted-foreground)]">
                            Status
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Pool
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Participants
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Sessions
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Completion
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Accuracy
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Paid out
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Cost / completion
                          </th>
                          <th className="py-2 text-right font-medium text-[var(--muted-foreground)]">
                            Ends
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {brand.challenges.map((c) => {
                          const stats = c.stats;
                          return (
                            <tr
                              key={c.id}
                              className="border-b border-[var(--border)] last:border-0"
                            >
                              <td className="py-2">
                                <Badge
                                  variant={
                                    c.status === "active"
                                      ? "default"
                                      : c.status === "pending_deposit"
                                        ? "secondary"
                                        : "outline"
                                  }
                                >
                                  {c.status.replace("_", " ")}
                                </Badge>
                              </td>
                              <td className="py-2 text-right">{formatUsdc(c.poolAmountUsdc)}</td>
                              <td className="py-2 text-right">
                                {stats?.unique_participants ?? c.participantCount}
                              </td>
                              <td className="py-2 text-right">
                                {stats
                                  ? `${stats.completed_sessions}/${stats.total_sessions}`
                                  : "—"}
                              </td>
                              <td className="py-2 text-right">
                                {stats ? `${stats.completion_rate_pct}%` : "—"}
                              </td>
                              <td className="py-2 text-right">
                                {stats ? `${stats.avg_accuracy_pct}%` : "—"}
                              </td>
                              <td className="py-2 text-right">
                                {stats ? formatUsdc(stats.total_paid_out_usdc) : "—"}
                              </td>
                              <td className="py-2 text-right">
                                {stats ? formatUsdc(stats.cost_per_completed_session_usdc) : "—"}
                              </td>
                              <td className="py-2 text-right text-[var(--muted-foreground)]">
                                {new Date(c.endsAt).toLocaleDateString()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
                    {brand.challenges.map((challenge) => {
                      const offered = licensesByBrand[brand.id]?.offered.some(
                        (offer) => offer.challenge_id === challenge.id
                      );
                      return (
                        <Button
                          key={`license-${challenge.id}`}
                          size="sm"
                          variant="outline"
                          disabled={Boolean(licensingAction)}
                          onClick={() => void setLicenseOffer(brand.id, challenge.id, !offered)}
                        >
                          {offered ? "Revoke future licenses" : "Offer format (5% fee)"}
                        </Button>
                      );
                    })}
                  </div>
                </CardContent>
              )}

              <EscrowPanel
                brandId={brand.id}
                challenges={brand.challenges ?? []}
                apiToken={apiToken}
              />

              <CardContent>
                <BenchmarkPanel brandId={brand.id} apiToken={apiToken} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
