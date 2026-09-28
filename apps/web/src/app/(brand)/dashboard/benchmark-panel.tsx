"use client";

import { useEffect, useState } from "react";
import { createApiClient } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

interface BenchmarkData {
  brand: {
    challengeCount: number;
    sizeBucket: string;
    qualified: boolean;
    completionRate: number | null;
    costPerSessionUsdc: number | null;
  };
  platform: {
    sizeBucket: string;
    bucketLabel: string;
    medianCompletionRate: number | null;
    medianCostPerSessionUsdc: number | null;
    sampleSize: number;
    minChallenges: number;
  };
}

interface BenchmarkPanelProps {
  brandId: string;
  apiToken?: string;
}

function MetricRow({
  label,
  value,
  median,
  format,
  betterWhen,
}: {
  label: string;
  value: number | null;
  median: number | null;
  format: (n: number) => string;
  betterWhen: "higher" | "lower";
}) {
  const hasBoth = value !== null && median !== null;
  const delta = hasBoth ? value - median : null;
  const favorable = delta !== null && (betterWhen === "higher" ? delta >= 0 : delta <= 0);

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-[var(--muted-foreground)]">{label}</span>
      <div className="flex items-center gap-3 text-sm">
        <span className="font-semibold" data-testid={`your-${label}`}>
          {value !== null ? format(value) : "—"}
        </span>
        <span className="text-[var(--muted-foreground)]">vs median</span>
        <span className="font-medium" data-testid={`median-${label}`}>
          {median !== null ? format(median) : "—"}
        </span>
        {hasBoth && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              favorable ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
            }`}
          >
            {delta! >= 0 ? "+" : ""}
            {format(delta!)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Anonymized benchmark comparison panel (issue #1042).
 *
 * Shows the brand's completion rate and cost-per-session next to
 * platform-wide medians for similarly sized brands. Only aggregate medians
 * are ever displayed — no individual competitor data leaves the API.
 */
export function BenchmarkPanel({ brandId, apiToken }: BenchmarkPanelProps) {
  const [data, setData] = useState<BenchmarkData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "hidden">("loading");

  useEffect(() => {
    if (!apiToken) return;
    let cancelled = false;

    void (async () => {
      try {
        const api = createApiClient(apiToken);
        const res = await api.get(`/brands/${brandId}/benchmark`, {
          skipErrorToast: true,
        });
        if (cancelled) return;
        setData(res.data.benchmark);
        setState("ready");
      } catch {
        if (!cancelled) setState("hidden");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [brandId, apiToken]);

  if (state === "hidden") return null;
  if (state === "loading") return <Skeleton className="mt-4 h-24 w-full" />;
  if (!data) return null;

  const { brand, platform } = data;
  const enoughData =
    platform.sampleSize > 0 &&
    platform.medianCompletionRate !== null &&
    platform.medianCostPerSessionUsdc !== null;

  return (
    <section
      className="mt-4 rounded-lg border border-[var(--border)] p-4"
      aria-label="Industry benchmark"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">How you compare</h3>
        <span className="text-xs text-[var(--muted-foreground)]">
          Anonymized platform medians · {platform.bucketLabel}
        </span>
      </div>

      {enoughData ? (
        <div className="mt-2 divide-y divide-[var(--border)]">
          <MetricRow
            label="Completion rate"
            value={brand.completionRate}
            median={platform.medianCompletionRate}
            format={(n) => `${n}%`}
            betterWhen="higher"
          />
          <MetricRow
            label="Cost / session"
            value={brand.costPerSessionUsdc}
            median={platform.medianCostPerSessionUsdc}
            format={(n) => `$${n.toFixed(2)}`}
            betterWhen="lower"
          />
        </div>
      ) : (
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          {brand.qualified
            ? "Not enough platform data yet to show a benchmark for your size bucket."
            : `Launch at least ${platform.minChallenges} challenges to be benchmarked against similar-sized brands (currently ${brand.challengeCount}).`}
        </p>
      )}

      <p className="mt-3 text-xs text-[var(--muted-foreground)]">
        Compared against {platform.sampleSize} anonymized brand
        {platform.sampleSize === 1 ? "" : "s"} with {platform.minChallenges}+ challenges. No
        individual brand data is shown.
      </p>
    </section>
  );
}
