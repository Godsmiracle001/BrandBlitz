"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";
import { QueueStatsCard, type QueueStats } from "./queue-stats-card";
import { FailedJobsCard, type FailedJob } from "./failed-jobs-card";

interface DauEntry {
  date: string;
  dau: number;
}

interface UsdcEntry {
  date: string;
  total_usdc: string;
}

interface TopBrand {
  brand_id: string;
  brand_name: string;
  completed_sessions: number;
}

interface Summary {
  total_users: number;
  total_paid_usdc: string;
  total_completed_sessions: number;
}

type DateRange = "7" | "30" | "90";

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function LineChart({ data, label }: { data: { x: string; y: number }[]; label: string }) {
  if (data.length === 0)
    return <div className="py-8 text-center text-sm text-gray-400">No data</div>;
  const maxVal = Math.max(...data.map((d) => d.y), 1);
  const width = 600;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 30, left: 40 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const points = data.map((d, i) => {
    const x = padding.left + (i / Math.max(data.length - 1, 1)) * chartW;
    const y = padding.top + chartH - (d.y / maxVal) * chartH;
    return `${x},${y}`;
  });

  const tickCount = Math.min(data.length, 7);
  const tickStep = Math.max(1, Math.floor(data.length / tickCount));
  const ticks = data.filter((_, i) => i % tickStep === 0 || i === data.length - 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={label}>
      <text
        x={padding.left - 5}
        y={padding.top + 4}
        className="fill-current text-xs"
        textAnchor="end"
      >
        {maxVal}
      </text>
      <text
        x={padding.left - 5}
        y={padding.top + chartH + 4}
        className="fill-current text-xs"
        textAnchor="end"
      >
        0
      </text>
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {ticks.map((d, i) => {
        const idx = data.indexOf(d);
        const x = padding.left + (idx / Math.max(data.length - 1, 1)) * chartW;
        return (
          <text
            key={i}
            x={x}
            y={height - 5}
            className="fill-current text-[10px]"
            textAnchor="middle"
          >
            {formatShortDate(d.x)}
          </text>
        );
      })}
    </svg>
  );
}

function BarChart({ data, label }: { data: { x: string; y: number }[]; label: string }) {
  if (data.length === 0)
    return <div className="py-8 text-center text-sm text-gray-400">No data</div>;
  const maxVal = Math.max(...data.map((d) => d.y), 1);
  const width = 600;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 30, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const barWidth = Math.max(4, chartW / data.length - 2);

  const tickCount = Math.min(data.length, 7);
  const tickStep = Math.max(1, Math.floor(data.length / tickCount));
  const ticks = data.filter((_, i) => i % tickStep === 0 || i === data.length - 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={label}>
      <text
        x={padding.left - 5}
        y={padding.top + 4}
        className="fill-current text-xs"
        textAnchor="end"
      >
        {maxVal.toFixed(1)}
      </text>
      <text
        x={padding.left - 5}
        y={padding.top + chartH + 4}
        className="fill-current text-xs"
        textAnchor="end"
      >
        0
      </text>
      {data.map((d, i) => {
        const x = padding.left + (i / data.length) * chartW + 1;
        const barH = (d.y / maxVal) * chartH;
        const y = padding.top + chartH - barH;
        return (
          <rect key={i} x={x} y={y} width={barWidth} height={barH} fill="var(--primary)" rx="2" />
        );
      })}
      {ticks.map((d, i) => {
        const idx = data.indexOf(d);
        const x = padding.left + (idx / data.length) * chartW + barWidth / 2 + 1;
        return (
          <text
            key={i}
            x={x}
            y={height - 5}
            className="fill-current text-[10px]"
            textAnchor="middle"
          >
            {formatShortDate(d.x)}
          </text>
        );
      })}
    </svg>
  );
}

export default function AdminStatsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const userRole = (session?.user as { role?: string } | undefined)?.role;

  const [dau, setDau] = useState<DauEntry[]>([]);
  const [usdcVolume, setUsdcVolume] = useState<UsdcEntry[]>([]);
  const [topBrands, setTopBrands] = useState<TopBrand[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats>({});
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>("30");

  const loadFailedJobs = useCallback(async (token: string) => {
    try {
      const api = createApiClient(token);
      const res = await api.get("/admin/queue-stats/failed");
      setFailedJobs(res.data.jobs ?? []);
    } catch {
      // Failed-job listing is supplementary — don't fail the whole page for it.
      setFailedJobs([]);
    }
  }, []);

  const handleRetryJob = useCallback(
    async (job: FailedJob) => {
      if (!apiToken || retryingJobId) return;
      setRetryingJobId(job.id);
      try {
        const api = createApiClient(apiToken);
        await api.post(
          `/admin/queue-stats/${encodeURIComponent(job.id)}/retry`,
          { queue: job.queue },
          { skipErrorToast: true }
        );
        toast.success(`Requeued job ${job.id}`);
        await loadFailedJobs(apiToken);
      } catch (err: any) {
        const message =
          err?.response?.data?.error ?? err?.response?.data?.message ?? "Retry failed.";
        toast.error(message);
      } finally {
        setRetryingJobId(null);
      }
    },
    [apiToken, retryingJobId, loadFailedJobs]
  );

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    } else if (status === "authenticated" && userRole !== "admin") {
      router.push("/dashboard");
    }
  }, [status, userRole, router]);

  const loadStats = useCallback(
    async (days: DateRange) => {
      if (!apiToken) return;
      setLoading(true);
      setError(false);
      try {
        const api = createApiClient(apiToken);
        const [statsResponse, queueResponse] = await Promise.all([
          api.get("/admin/stats", { params: { days: Number(days) } }),
          api.get("/admin/queue-stats"),
        ]);
        setDau(statsResponse.data.dau);
        setUsdcVolume(statsResponse.data.usdcVolume);
        setTopBrands(statsResponse.data.topBrands);
        setSummary(statsResponse.data.summary);
        setQueueStats(queueResponse.data.queues);
        await loadFailedJobs(apiToken);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [apiToken, loadFailedJobs]
  );

  useEffect(() => {
    if (status === "authenticated" && userRole === "admin") {
      void loadStats(dateRange);
    }
  }, [loadStats, status, userRole, dateRange]);

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return null;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Platform Stats</h1>
        <div className="flex gap-2">
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
      </div>

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[var(--muted-foreground)]">Failed to load stats.</p>
            <Button className="mt-4" onClick={() => void loadStats(dateRange)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {summary && (
            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <p className="text-3xl font-bold text-[var(--primary)]">
                    {summary.total_users.toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">Total Users</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-3xl font-bold text-green-600">
                    {Number(summary.total_paid_usdc).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{" "}
                    USDC
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">Total USDC Paid</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-3xl font-bold text-[var(--primary)]">
                    {summary.total_completed_sessions.toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">Completed Sessions</p>
                </CardContent>
              </Card>
            </div>
          )}

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Daily Active Users</CardTitle>
              </CardHeader>
              <CardContent>
                <LineChart data={dau.map((d) => ({ x: d.date, y: d.dau }))} label="DAU" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">USDC Payout Volume</CardTitle>
              </CardHeader>
              <CardContent>
                <BarChart
                  data={usdcVolume.map((d) => ({ x: d.date, y: Number(d.total_usdc) }))}
                  label="USDC Volume"
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top Brands</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {topBrands.length === 0 ? (
                <div className="py-8 text-center text-sm text-gray-400">No brand data</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50 text-left text-xs font-medium text-gray-500">
                        <th className="px-4 py-3">#</th>
                        <th className="px-4 py-3">Brand</th>
                        <th className="px-4 py-3">Completed Sessions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topBrands.map((brand, i) => (
                        <tr key={brand.brand_id} className="border-b hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium">{i + 1}</td>
                          <td className="px-4 py-3 font-medium">{brand.brand_name}</td>
                          <td className="px-4 py-3">{brand.completed_sessions.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <QueueStatsCard queues={queueStats} />

          <FailedJobsCard
            jobs={failedJobs}
            retryingJobId={retryingJobId}
            onRetry={(job) => void handleRetryJob(job)}
          />
        </>
      )}
    </div>
  );
}
