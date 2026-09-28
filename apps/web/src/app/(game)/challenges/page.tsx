"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/utils";
import { generateColoredBlurPlaceholder } from "@/lib/blur-placeholder";
import type { Challenge } from "@/lib/api";

const PAGE_SIZE = 20;

type StatusFilter = "all" | "active" | "upcoming" | "ended";

function timeRemaining(endsAt: string | null): string {
  if (!endsAt) return "";
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "Ended";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

function statusBadgeVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "pending_deposit") return "secondary";
  return "outline";
}

function statusLabel(status: string): string {
  if (status === "active") return "Active";
  if (status === "pending_deposit") return "Upcoming";
  return "Ended";
}

export default function ChallengesDiscoveryPage() {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [requerying, setRequerying] = useState(false);
  const [failed, setFailed] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [minPool, setMinPool] = useState("");
  const [endBefore, setEndBefore] = useState("");

  const buildParams = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (statusFilter !== "all") p.set("status", statusFilter);
      if (minPool) p.set("min_pool", minPool);
      if (endBefore) p.set("end_before", new Date(endBefore).toISOString());
      if (cursor) p.set("cursor", cursor);
      return p;
    },
    [statusFilter, minPool, endBefore]
  );

  const loadPage = useCallback(
    async (cursor?: string) => {
      const res = await api.get(`/challenges?${buildParams(cursor).toString()}`);
      return {
        page: res.data.data as Challenge[],
        nextCursor: res.data.nextCursor as string | null,
      };
    },
    [buildParams]
  );

  const loadInitial = useCallback(async (isRequery = false) => {
    if (isRequery) {
      setRequerying(true);
    } else {
      setLoading(true);
    }
    setFailed(false);
    try {
      const { page, nextCursor: nc } = await loadPage();
      setChallenges(page);
      setNextCursor(nc);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRequerying(false);
    }
  }, [loadPage]);

  const isFirstLoad = !challenges.length && !failed;
  useEffect(() => {
    void loadInitial(!isFirstLoad);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadInitial]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const { page, nextCursor: nc } = await loadPage(nextCursor);
      setChallenges((prev) => [...prev, ...page]);
      setNextCursor(nc);
    } catch {
      /* ignore incremental failures */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, loadPage]);

  function clearFilters() {
    setStatusFilter("all");
    setMinPool("");
    setEndBefore("");
  }

  const hasFilters = statusFilter !== "all" || minPool !== "" || endBefore !== "";

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="mb-2 text-3xl font-bold">Challenges</h1>
      <p className="mb-8 text-[var(--muted-foreground)]">
        Browse and filter brand challenges — earn USDC by topping the leaderboard
      </p>

      {/* Filter controls */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          {(["all", "active", "upcoming", "ended"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              disabled={requerying}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3 py-1 text-sm capitalize transition-colors disabled:opacity-50 ${
                statusFilter === s
                  ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                  : "border-[var(--border)] hover:border-[var(--primary)]"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          {requerying && (
            <span className="text-xs text-[var(--muted-foreground)] animate-pulse">
              Updating…
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <label className="text-sm text-[var(--muted-foreground)]">Min pool (USDC)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={minPool}
            disabled={requerying}
            onChange={(e) => setMinPool(e.target.value)}
            placeholder="e.g. 100"
            className="w-28 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-1">
          <label className="text-sm text-[var(--muted-foreground)]">Ends before</label>
          <input
            type="date"
            value={endBefore}
            disabled={requerying}
            onChange={(e) => setEndBefore(e.target.value)}
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
          />
        </div>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="text-sm text-[var(--muted-foreground)] underline hover:text-[var(--foreground)]"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Results */}
      {loading && !requerying ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            // Heights mirror the loaded card: logo h-12, badge 22px, title/description
            // line heights, remaining-time line, and h-10 button.
            <Card key={i} className="animate-pulse" aria-hidden="true">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="h-12 w-32 rounded-lg bg-[var(--muted)]" />
                  <div className="h-[22px] w-16 rounded-full bg-[var(--muted)]" />
                </div>
                <div className="h-4 w-40 rounded bg-[var(--muted)]" />
                <div className="h-5 w-48 rounded bg-[var(--muted)]" />
              </CardHeader>
              <CardContent>
                <div className="mb-3 h-5 w-24 rounded bg-[var(--muted)]" />
                <div className="h-10 w-full rounded-md bg-[var(--muted)]" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : failed && challenges.length === 0 ? (
        <div className="text-center py-16">
          <p className="mb-4 text-[var(--muted-foreground)]">Couldn&apos;t load challenges. Refresh and try again.</p>
          <Button variant="outline" onClick={loadInitial}>Retry</Button>
        </div>
      ) : challenges.length === 0 ? (
        <div className="text-center py-16">
          <p className="mb-4 text-[var(--muted-foreground)]">No challenges match the active filters.</p>
          {hasFilters && (
            <Button variant="outline" onClick={clearFilters}>Clear filters</Button>
          )}
        </div>
      ) : (
        <div className={requerying ? "pointer-events-none opacity-50 transition-opacity" : "transition-opacity"}>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {challenges.map((c, index) => {
              const remaining = timeRemaining(c.ends_at ?? null);
              return (
                <Card key={c.id} className="transition-shadow hover:shadow-lg">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      {c.logo_url ? (
                        <Image
                          src={c.logo_url}
                          alt={c.brand_name ?? "Brand logo"}
                          width={160}
                          height={48}
                          sizes="160px"
                          className="h-12 w-auto object-contain"
                          loading={index < 3 ? "eager" : "lazy"}
                          placeholder="blur"
                          blurDataURL={generateColoredBlurPlaceholder(c.primary_color)}
                          priority={index < 3}
                        />
                      ) : (
                        <div
                          className="h-12 w-12 rounded-lg"
                          style={{ backgroundColor: c.primary_color ?? "var(--primary)" }}
                        />
                      )}
                      <Badge variant={statusBadgeVariant(c.status)}>
                        {statusLabel(c.status)}
                      </Badge>
                    </div>
                    <CardTitle>{c.brand_name ?? "Untitled brand"}</CardTitle>
                    <CardDescription>
                      Prize pool: {formatUsdc(c.pool_amount_usdc)} USDC
                      {c.participant_count !== undefined && (
                        <> · {c.participant_count} players</>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {remaining && (
                      <p className="mb-3 text-sm text-[var(--muted-foreground)]">{remaining}</p>
                    )}
                    <Link href={`/challenge/${c.id}`}>
                      <Button
                        className="w-full"
                        style={{ backgroundColor: c.primary_color ?? undefined }}
                        disabled={c.status !== "active"}
                      >
                        {c.status === "active" ? "Accept Challenge" : statusLabel(c.status)}
                      </Button>
                    </Link>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {nextCursor && (
            <div className="mt-8 flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}

          {!nextCursor && challenges.length > 0 && (
            <p className="mt-8 text-center text-sm text-[var(--muted-foreground)]">
              You&apos;ve seen all {challenges.length} challenge{challenges.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
