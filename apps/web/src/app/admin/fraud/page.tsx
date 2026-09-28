"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReactionTimes {
  round1Ms: number | null;
  round2Ms: number | null;
  round3Ms: number | null;
}

interface FraudFlag {
  id: string;
  sessionId: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  challengeId: string;
  flagType: string;
  details: Record<string, unknown> | null;
  status: "open" | "resolved" | "escalated";
  resolutionReason: string | null;
  resolvedAt: string | null;
  createdAt: string;
  reactionTimes: ReactionTimes;
  sessionFlagReasons: string[] | null;
  deviceId: string | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type StatusFilter = "all" | "open" | "resolved" | "escalated";
type ActionType = "resolved" | "escalated";

const MAX_REASON_LENGTH = 500;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "open") return "destructive";
  if (status === "resolved") return "default";
  return "secondary";
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return `${ms} ms`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminFraudPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const userRole = (session?.user as { role?: string } | undefined)?.role;

  const [flags, setFlags] = useState<FraudFlag[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Resolution dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAction, setDialogAction] = useState<ActionType>("resolved");
  const [dialogReason, setDialogReason] = useState("");
  const [dialogTargetIds, setDialogTargetIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [copiedDetailsId, setCopiedDetailsId] = useState<string | null>(null);

  const isNearLimit = dialogReason.length >= MAX_REASON_LENGTH * 0.85;
  const isAtLimit = dialogReason.length >= MAX_REASON_LENGTH;

  // ─── Auth guard ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    } else if (status === "authenticated" && userRole !== "admin") {
      router.push("/dashboard");
    }
  }, [status, userRole, router]);

  // ─── Data loading ────────────────────────────────────────────────────────

  const loadFlags = useCallback(
    async (page = 1) => {
      if (!apiToken) return;
      setLoading(true);
      try {
        const api = createApiClient(apiToken);
        const params: Record<string, string | number> = { page, pageSize: 20 };
        if (statusFilter !== "all") params.status = statusFilter;

        const res = await api.get("/admin/fraud-flags", { params });
        setFlags(res.data.flags);
        setPagination(res.data.pagination);
        setSelectedIds(new Set());
      } catch {
        setFlags([]);
      } finally {
        setLoading(false);
      }
    },
    [apiToken, statusFilter]
  );

  useEffect(() => {
    if (status === "authenticated" && userRole === "admin") {
      void loadFlags(1);
    }
  }, [loadFlags, status, userRole]);

  // ─── Selection helpers ───────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === flags.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(flags.map((f) => f.id)));
    }
  }

  // ─── Dialog helpers ──────────────────────────────────────────────────────

  function openDialog(action: ActionType, ids: string[]) {
    setDialogAction(action);
    setDialogTargetIds(ids);
    setDialogReason("");
    setDialogOpen(true);
  }

  async function handleSubmitAction() {
    if (!apiToken || !dialogReason.trim()) return;
    setSubmitting(true);
    const api = createApiClient(apiToken);

    try {
      await Promise.all(
        dialogTargetIds.map((id) =>
          api.patch(`/admin/fraud-flags/${id}`, {
            status: dialogAction,
            reason: dialogReason.trim(),
          })
        )
      );
      setDialogOpen(false);
      await loadFlags(pagination.page);
    } catch {
      setDialogOpen(true);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="mb-6 h-14 w-full rounded-lg" />
        <div className="rounded-lg border">
          <div className="border-b px-6 py-4">
            <Skeleton className="h-5 w-28" />
          </div>
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="ml-auto h-4 w-16" />
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
        <h1 className="text-2xl font-bold">Fraud Review Dashboard</h1>
        <span className="text-sm text-gray-500">{pagination.total} total flags</span>
      </div>

      {/* Filter bar */}
      <Card className="mb-6">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Label className="text-sm font-medium">Status:</Label>
            {(["all", "open", "resolved", "escalated"] as StatusFilter[]).map((s) => (
              <Button
                key={s}
                variant={statusFilter === s ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setStatusFilter(s);
                }}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Batch actions */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-md border bg-gray-50 px-4 py-2">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <Button
            size="sm"
            variant="default"
            onClick={() => openDialog("resolved", [...selectedIds])}
          >
            Resolve Selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openDialog("escalated", [...selectedIds])}
          >
            Escalate Selected
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Flags table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fraud Flags</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-500">Loading…</div>
          ) : flags.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">No fraud flags found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs font-medium text-gray-500">
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.size === flags.length}
                        onChange={toggleSelectAll}
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-4 py-3">Flag type</th>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Session</th>
                    <th className="px-4 py-3">Reaction times</th>
                    <th className="px-4 py-3">Details</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((flag) => (
                    <tr key={flag.id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(flag.id)}
                          onChange={() => toggleSelect(flag.id)}
                          aria-label={`Select flag ${flag.id}`}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{flag.flagType}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{flag.userDisplayName}</div>
                        <div className="text-xs text-gray-500">{flag.userEmail}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/challenge/${flag.challengeId}`}
                          className="text-blue-600 hover:underline"
                          title={`Session ${flag.sessionId}`}
                        >
                          View session ↗
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <div>R1: {formatMs(flag.reactionTimes.round1Ms)}</div>
                        <div>R2: {formatMs(flag.reactionTimes.round2Ms)}</div>
                        <div>R3: {formatMs(flag.reactionTimes.round3Ms)}</div>
                      </td>
                      <td className="max-w-[260px] px-4 py-3">
                        {flag.details ? (
                          <details className="text-xs">
                            <summary className="max-w-[200px] cursor-pointer truncate text-gray-600">
                              {JSON.stringify(flag.details).slice(0, 80)}
                            </summary>
                            <pre className="my-2 max-h-64 max-w-[min(32rem,70vw)] overflow-auto whitespace-pre-wrap break-all rounded border bg-gray-50 p-2">
                              {JSON.stringify(flag.details, null, 2)}
                            </pre>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(
                                    JSON.stringify(flag.details, null, 2)
                                  );
                                  setCopiedDetailsId(flag.id);
                                } catch {
                                  setCopiedDetailsId(null);
                                }
                              }}
                            >
                              {copiedDetailsId === flag.id ? "Copied" : "Copy JSON"}
                            </Button>
                          </details>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(flag.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(flag.status)}>{flag.status}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {flag.status === "open" && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="default"
                              onClick={() => openDialog("resolved", [flag.id])}
                            >
                              Resolve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openDialog("escalated", [flag.id])}
                            >
                              Escalate
                            </Button>
                          </div>
                        )}
                        {flag.status !== "open" && flag.resolutionReason && (
                          <span
                            className="cursor-help text-xs text-gray-400"
                            title={flag.resolutionReason}
                          >
                            Reason on file
                          </span>
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

      {/* Pagination */}
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
              onClick={() => void loadFlags(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => void loadFlags(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Resolution / Escalation dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogAction === "resolved" ? "Resolve" : "Escalate"}{" "}
              {dialogTargetIds.length > 1 ? `${dialogTargetIds.length} flags` : "flag"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="reason">
              Resolution reason <span className="text-red-500">*</span>
            </Label>
            <Input
              id="reason"
              placeholder={
                dialogAction === "resolved"
                  ? "e.g. Legitimate user confirmed by manual review"
                  : "e.g. Needs manual account investigation"
              }
              value={dialogReason}
              maxLength={MAX_REASON_LENGTH}
              onChange={(e) => {
                if (e.target.value.length <= MAX_REASON_LENGTH) {
                  setDialogReason(e.target.value);
                }
              }}
            />
            <p
              className={`mt-1 text-right text-xs transition-colors ${
                isAtLimit
                  ? "font-semibold text-red-600"
                  : isNearLimit
                    ? "font-medium text-amber-600"
                    : "text-[var(--muted-foreground)]"
              }`}
            >
              {dialogReason.length}/{MAX_REASON_LENGTH}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmitAction} disabled={!dialogReason.trim() || submitting}>
              {submitting ? "Saving…" : dialogAction === "resolved" ? "Mark resolved" : "Escalate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
