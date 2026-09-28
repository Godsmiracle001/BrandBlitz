"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CompletionRateChart } from "@/components/brand/completion-rate-chart";
import { AccuracyBreakdownChart } from "@/components/brand/accuracy-breakdown-chart";
import { CostPerSessionChart } from "@/components/brand/cost-per-session-chart";
import { toast } from "@/lib/toast";

interface Brand {
  id: string;
  name: string;
  logoUrl?: string;
  primaryColor?: string;
  tagline?: string;
}

interface QuestionAccuracy {
  round: number;
  questionType: string;
  questionText: string;
  totalAttempts: number;
  correctAttempts: number;
  accuracy: number;
}

interface CostDataPoint {
  date: string;
  totalCost: number;
  sessionCount: number;
  costPerSession: number;
}

interface AnalyticsData {
  totalSessions: number;
  completedSessions: number;
  completionRate: number;
  questionAccuracy: QuestionAccuracy[];
  costPerSession: CostDataPoint[];
}

type DateRange = "7" | "30" | "90";

function getDateRange(range: DateRange): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - parseInt(range));
  return { from, to };
}

export default function AnalyticsPage() {
  const { data: session, status } = useSession();
  const params = useParams();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const brandId = params.id as string;

  const [brand, setBrand] = useState<Brand | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [brandLoadError, setBrandLoadError] = useState(false);
  const [analyticsLoadError, setAnalyticsLoadError] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>("30");

  async function loadAnalytics(apiToken: string, range: DateRange) {
    setLoading(true);
    setBrandLoadError(false);
    setAnalyticsLoadError(false);

    const api = createApiClient(apiToken);
    const { from, to } = getDateRange(range);

    try {
      const [brandResult, analyticsResult] = await Promise.allSettled([
        api.get(`/brands/${brandId}`),
        api.get(`/brands/${brandId}/analytics`, {
          params: {
            from: from.toISOString(),
            to: to.toISOString(),
          },
        }),
      ]);

      if (brandResult.status === "rejected") {
        setBrand(null);
        setAnalytics(null);
        setBrandLoadError(true);
        setLoading(false);
        toast.error("Couldn't load brand details. Please try again.");
        return;
      }

      const brandData = brandResult.value.data.brand;
      setBrand({
        id: brandData.id,
        name: brandData.name,
        logoUrl: brandData.logoUrl ?? brandData.logo_url,
        primaryColor: brandData.primaryColor ?? brandData.primary_color,
        tagline: brandData.tagline,
      });

      if (analyticsResult.status === "rejected") {
        setAnalytics(null);
        setAnalyticsLoadError(true);
        setLoading(false);
        toast.error("Couldn't load analytics. Please try again.");
        return;
      }

      setAnalytics(analyticsResult.value.data.analytics);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
      return;
    }
    if (status !== "authenticated" || !apiToken) return;

    void loadAnalytics(apiToken, dateRange);
  }, [apiToken, status, router, brandId, dateRange]);

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <div className="mb-8">
          <div className="animate-pulse h-8 w-48 rounded bg-[var(--muted)]" />
          <div className="animate-pulse mt-2 h-4 w-64 rounded bg-[var(--muted)]" />
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse h-32 rounded-lg bg-[var(--muted)]" />
          ))}
        </div>
      </main>
    );
  }

  if (!brand) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        {brandLoadError ? (
          <EmptyState
            title="Couldn't load brand"
            description="We couldn't load this brand — tap to retry."
            action={
              <Button
                disabled={!apiToken}
                onClick={() => apiToken && void loadAnalytics(apiToken, dateRange)}
              >
                Try Again
              </Button>
            }
          />
        ) : (
          <p className="text-[var(--muted-foreground)]">Brand not found.</p>
        )}
      </main>
    );
  }

  const hasSessions = analytics && analytics.totalSessions > 0;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/brand/${brandId}`} className="flex items-center gap-4">
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
                style={{ backgroundColor: brand.primaryColor ?? "var(--primary)" }}
              />
            )}
            <div>
              <h1 className="text-2xl font-bold">{brand.name} Analytics</h1>
              <p className="text-[var(--muted-foreground)]">{brand.tagline}</p>
            </div>
          </Link>
        </div>
        <div className="flex gap-2">
          <Link href={`/brand/${brandId}`}>
            <Button variant="outline" size="sm">
              Overview
            </Button>
          </Link>
          <Link href={`/brand/${brandId}/challenge/new`}>
            <Button size="sm">Launch Challenge</Button>
          </Link>
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">Date range:</span>
          {(["7", "30", "90"] as DateRange[]).map((range) => (
            <Button
              key={range}
              variant={dateRange === range ? "default" : "outline"}
              size="sm"
              onClick={() => setDateRange(range)}
            >
              {range} days
            </Button>
          ))}
        </div>
        <a
          href="/docs/guides/brand-analytics-metrics"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--muted-foreground)] underline hover:text-[var(--foreground)]"
        >
          What do these metrics mean?
        </a>
      </div>

      {analyticsLoadError ? (
        <EmptyState
          title="Couldn't load analytics"
          description="We couldn't load the analytics data — tap to retry."
          action={
            <Button
              disabled={!apiToken}
              onClick={() => apiToken && void loadAnalytics(apiToken, dateRange)}
            >
              Try Again
            </Button>
          }
        />
      ) : !hasSessions ? (
        <EmptyState
          title="No sessions yet"
          description="Launch a challenge to start collecting analytics data."
          action={
            <Link href={`/brand/${brandId}/challenge/new`}>
              <Button>Launch a Challenge</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <CardContent className="pt-6">
                <p className="text-3xl font-bold text-[var(--primary)]">
                  {analytics!.totalSessions.toLocaleString()}
                </p>
                <p className="text-sm text-[var(--muted-foreground)]">Total Sessions</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-3xl font-bold text-[var(--primary)]">
                  {analytics!.completionRate}%
                </p>
                <p className="text-sm text-[var(--muted-foreground)]">Completion Rate</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-3xl font-bold text-[var(--primary)]">
                  {analytics!.costPerSession.length > 0
                    ? `$${(
                        analytics!.costPerSession.reduce((sum, d) => sum + d.costPerSession, 0) /
                        analytics!.costPerSession.length
                      ).toFixed(2)}`
                    : "$0.00"}
                </p>
                <p className="text-sm text-[var(--muted-foreground)]">Avg Cost/Session</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <CompletionRateChart
              totalSessions={analytics!.totalSessions}
              completedSessions={analytics!.completedSessions}
              completionRate={analytics!.completionRate}
            />
            <AccuracyBreakdownChart data={analytics!.questionAccuracy} />
          </div>

          <CostPerSessionChart data={analytics!.costPerSession} />
        </div>
      )}
    </main>
  );
}
