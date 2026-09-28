"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { formatUsdc } from "@/lib/format";
import { EscrowTopUpModal } from "@/components/brand/escrow-topup-modal";

export interface EscrowChallenge {
  id: string;
  status: string;
  poolAmountUsdc: string;
  stats?: { total_paid_out_usdc: number };
}

interface EscrowPanelProps {
  brandId: string;
  challenges: EscrowChallenge[];
  apiToken?: string;
}

function poolNumber(challenge: EscrowChallenge): number {
  const parsed = Number.parseFloat(challenge.poolAmountUsdc);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Remaining scheduled payouts: full pool for challenges still awaiting a
 * deposit, plus any active challenge pool not yet paid out. Doubles as the
 * suggested top-up amount for the funding modal (issue #1039).
 */
export function remainingScheduledPayouts(challenges: EscrowChallenge[]): number {
  return challenges.reduce((total, challenge) => {
    if (challenge.status === "pending_deposit") {
      return total + poolNumber(challenge);
    }
    if (challenge.status === "active") {
      const paid = challenge.stats?.total_paid_out_usdc ?? 0;
      return total + Math.max(0, poolNumber(challenge) - paid);
    }
    return total;
  }, 0);
}

/**
 * Escrow status panel with a one-click top-up shortcut (issue #1039).
 * The modal reuses the existing /challenges/:id/deposit-info endpoint for the
 * deposit address and memo rather than duplicating address logic.
 */
export function EscrowPanel({ brandId, challenges, apiToken }: EscrowPanelProps) {
  const [topUpOpen, setTopUpOpen] = useState(false);

  const pendingDeposit = useMemo(
    () => challenges.find((c) => c.status === "pending_deposit") ?? null,
    [challenges]
  );
  const remaining = useMemo(() => remainingScheduledPayouts(challenges), [challenges]);
  const shortfall = useMemo(
    () =>
      challenges
        .filter((c) => c.status === "active")
        .reduce((sum, c) => {
          const paid = c.stats?.total_paid_out_usdc ?? 0;
          return sum + Math.max(0, poolNumber(c) - paid);
        }, 0),
    [challenges]
  );

  const status = pendingDeposit
    ? { label: "Awaiting deposit", variant: "secondary" as const }
    : shortfall > 0
      ? { label: "Below scheduled payouts", variant: "destructive" as const }
      : { label: "Covered", variant: "outline" as const };

  return (
    <CardContent className="border-t border-[var(--border)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">Escrow</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="text-[var(--muted-foreground)]">
            Remaining scheduled payouts:{" "}
            <span className="font-semibold text-[var(--foreground)]">{formatUsdc(remaining)}</span>
          </span>
        </div>
        <Button size="sm" onClick={() => setTopUpOpen(true)} aria-label="Top up escrow">
          Top Up
        </Button>
      </div>

      <EscrowTopUpModal
        open={topUpOpen}
        onClose={() => setTopUpOpen(false)}
        apiToken={apiToken}
        challengeId={pendingDeposit?.id ?? null}
        brandId={brandId}
        suggestedAmount={remaining}
      />
    </CardContent>
  );
}
