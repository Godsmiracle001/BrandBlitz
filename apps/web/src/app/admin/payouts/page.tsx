"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { createApiClient } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Payout {
  id: string;
  challenge_id: string;
  user_id: string;
  username: string;
  stellar_address: string;
  amount_usdc: string;
  tx_hash: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

interface PayoutStats {
  total_paid_usdc: string;
  total_pending_usdc: string;
  total_failed: number;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type StatusFilter = "all" | "pending" | "processing" | "sent" | "confirmed" | "failed";

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "sent" || status === "confirmed") return "default";
  if (status === "pending" || status === "processing") return "secondary";
  return "outline";
}

export default function AdminPayoutsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const userRole = (session?.user as { role?: string } | undefined)?.role;

  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [stats, setStats] = useState<PayoutStats | null>(null);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    } else if (status === "authenticated" && userRole !== "admin") {
      router.push("/dashboard");
    }
  }, [status, userRole, router]);

  const loadPayouts = useCallback(
    async (page = 1) => {
      if (!apiToken) return;
      setLoading(true);
      try {
        const api = createApiClient(apiToken);
        const params: Record<string, string | number> = { page, pageSize: 20 };
        if (statusFilter !== "all") params.status = statusFilter;

        const res = await api.get("/admin/payouts", { params });
        setPayouts(res.data.payouts);
        setPagination(res.data.pagination);
        setStats(res.data.stats);
      } catch {
        setPayouts([]);
      } finally {
        setLoading(false);
      }
    },
    [apiToken, statusFilter]
  );

  useEffect(() => {
    if (status === "authenticated" && userRole === "admin") {
      void loadPayouts(1);
    }
  }, [loadPayouts, status, userRole]);

  const handleRetry = async (payoutId: string) => {
    if (!apiToken) return;
    setRetryingIds((prev) => new Set(prev).add(payoutId));
    try {
      const api = createApiClient(apiToken);
      await api.post(`/admin/payouts/${payoutId}/retry`);
      await loadPayouts(pagination.page);
      toast.success("Payout retry submitted.");
    } catch {
      toast.error("Payout retry failed. Please try again.");
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(payoutId);
        return next;
      });
    }
  };

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border p-4">
              <Skeleton className="mb-2 h-4 w-24" />
              <Skeleton className="h-7 w-32" />
            </div>
          ))}
        </div>
        <Skeleton className="mb-6 h-14 w-full rounded-lg" />
        <div className="rounded-lg border">
          <div className="border-b px-6 py-4">
            <Skeleton className="h-5 w-24" />
          </div>
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="ml-auto h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Payout Management</h1>
        <span className="text-sm text-gray-500">{pagination.total} total payouts</span>
      </div>

      {stats && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold text-green-600">
                {Number(stats.total_paid_usdc).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} USDC
              </p>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">Total Paid</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold text-amber-600">
                {Number(stats.total_pending_usdc).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} USDC
              </p>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">Total Pending</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold text-red-600">{stats.total_failed}</p>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">Failed Payouts</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="mb-6">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Status:</span>
            {(["all", "pending", "processing", "sent", "confirmed", "failed"] as StatusFilter[]).map(
              (s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFilter(s)}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </Button>
              )
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payouts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-500">Loading...</div>
          ) : payouts.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">No payouts found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs font-medium text-gray-500">
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Amount (USDC)</th>
                    <th className="px-4 py-3">Stellar TX</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Error</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((payout) => (
                    <tr key={payout.id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="font-medium">{payout.username}</div>
                        <div className="max-w-[150px] truncate font-mono text-xs text-gray-500">
                          {payout.stellar_address}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {Number(payout.amount_usdc).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 7,
                        })}
                      </td>
                      <td className="px-4 py-3">
                        {payout.tx_hash ? (
                          <a
                            href={`https://stellar.expert/explorer/public/tx/${payout.tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {payout.tx_hash.slice(0, 8)}...
                          </a>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(payout.status)}>{payout.status}</Badge>
                      </td>
                      <td className="max-w-[200px] px-4 py-3">
                        {payout.error_message ? (
                          <span
                            className="cursor-help text-xs text-red-600"
                            title={payout.error_message}
                          >
                            {payout.error_message.slice(0, 40)}...
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(payout.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        {payout.status === "failed" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryingIds.has(payout.id)}
                            onClick={() => void handleRetry(payout.id)}
                          >
                            {retryingIds.has(payout.id) ? "Retrying..." : "Retry"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-gray-500">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pagination.page <= 1}
              onClick={() => void loadPayouts(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => void loadPayouts(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
