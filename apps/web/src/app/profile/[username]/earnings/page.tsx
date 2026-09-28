"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createApiClient } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface EarningsRecord {
  challenge_title: string;
  amount_usdc: string;
  payout_at: string;
  stellar_tx_id: string | null;
  status: string;
}

interface EarningsResponse {
  earnings: EarningsRecord[];
  total_usdc: string;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

const STELLAR_EXPERT_BASE = "https://stellar.expert/explorer/public/tx";

function formatUsdc(amount: string): string {
  return `${parseFloat(amount).toFixed(2)} USDC`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function EarningsPage() {
  const { data: session } = useSession();
  const params = useParams<{ username: string }>();
  const router = useRouter();
  const username = params.username;

  const apiToken = (session as { apiToken?: string } | null)?.apiToken;

  const [data, setData] = useState<EarningsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: number) => {
      if (!apiToken) return;
      setLoading(true);
      setError(null);
      try {
        const api = createApiClient(apiToken);
        const res = await api.get<EarningsResponse>(`/users/${username}/earnings`, {
          params: { page: p, pageSize: 20 },
        });
        setData(res.data);
        setPage(p);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to load earnings";
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [apiToken, username],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8 flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => router.push(`/profile/${username}`)}>
          ← Back to profile
        </Button>
        <h1 className="text-2xl font-bold">Earnings History</h1>
      </div>

      <p className="-mt-4 mb-8 text-xs text-[var(--muted-foreground)]">
        Only sessions with zero fraud flags share in a challenge&apos;s prize pool.{" "}
        <Link
          href="/docs/guides/fair-play-for-players"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-[var(--foreground)]"
        >
          How fair play affects payouts
        </Link>
      </p>

      {/* Cumulative summary */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-base text-[var(--muted-foreground)]">
            Total lifetime earnings
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <p className="text-3xl font-bold text-[var(--primary)]">
              {formatUsdc(data?.total_usdc ?? "0")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-5 top-0 bottom-0 w-px bg-[var(--border)]" />

        {loading && !data
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="relative flex items-start gap-4 mb-6 pl-12">
                <div className="absolute left-3.5 top-1.5 h-3 w-3 rounded-full border-2 border-[var(--border)] bg-[var(--background)]" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            ))
          : null}

        {error && (
          <p className="text-sm text-red-500 pl-12">{error}</p>
        )}

        {data?.earnings.length === 0 && (
          <p className="pl-12 text-sm text-[var(--muted-foreground)]">No payouts yet.</p>
        )}

        {data?.earnings.map((record, i) => (
          <div key={i} className="relative flex items-start gap-4 mb-6 pl-12">
            <div className="absolute left-3.5 top-1.5 h-3 w-3 rounded-full border-2 border-[var(--primary)] bg-[var(--background)]" />
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-sm">{record.challenge_title}</p>
                <p className="text-sm font-bold text-[var(--primary)] whitespace-nowrap">
                  +{formatUsdc(record.amount_usdc)}
                </p>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                {formatDate(record.payout_at)}
              </p>
              {record.stellar_tx_id && (
                <Link
                  href={`${STELLAR_EXPERT_BASE}/${record.stellar_tx_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--primary)] hover:underline mt-0.5 inline-block"
                >
                  View on Stellar Expert ↗
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-8 text-sm">
          <span className="text-[var(--muted-foreground)]">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => void load(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= data.pagination.totalPages || loading}
              onClick={() => void load(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
