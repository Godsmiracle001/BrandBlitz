"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import { createApiClient } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DepositInfo {
  hotWalletAddress: string;
  memo: string;
  amount: string;
}

interface EscrowTopUpModalProps {
  open: boolean;
  onClose: () => void;
  apiToken?: string;
  /** Brand's challenge awaiting deposit — deposit info comes from the existing endpoint. */
  challengeId: string | null;
  brandId: string;
  /** Suggested amount derived from remaining scheduled payouts (USDC). */
  suggestedAmount: number;
}

/**
 * SEP-7 payment deep link. Encodes destination + amount + memo so wallets
 * opened via the QR code pre-fill the funding transaction.
 */
export function buildPaymentDeepLink(address: string, amount: string, memo: string): string {
  const params = new URLSearchParams();
  params.set("destination", address);
  if (amount) params.set("amount", amount);
  if (memo) params.set("memo", memo);
  return `web+stellar:pay?${params.toString()}`;
}

function sanitizeAmountInput(value: string): string {
  return value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
}

export function EscrowTopUpModal({
  open,
  onClose,
  apiToken,
  challengeId,
  brandId,
  suggestedAmount,
}: EscrowTopUpModalProps) {
  const [depositInfo, setDepositInfo] = useState<DepositInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Pre-fill with the suggested top-up amount each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const suggested =
      suggestedAmount > 0 ? suggestedAmount.toFixed(2) : (depositInfo?.amount ?? "");
    setAmount(suggested);
    setQrDataUrl(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestedAmount]);

  useEffect(() => {
    if (!open || !challengeId || !apiToken) {
      setDepositInfo(null);
      setLoadError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDepositInfo(null);

    void (async () => {
      try {
        const api = createApiClient(apiToken);
        // Reuse the existing deposit-info endpoint — no duplicated address logic.
        const res = await api.get(`/challenges/${challengeId}/deposit-info`, {
          skipErrorToast: true,
        });
        if (cancelled) return;
        setDepositInfo(res.data.depositInfo);
      } catch (err: any) {
        if (cancelled) return;
        const message =
          err?.response?.data?.error ?? "Couldn't load deposit details. Please try again.";
        setLoadError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, challengeId, apiToken]);

  // Render a QR for the payment deep link so funding is one scan away.
  useEffect(() => {
    if (!open || !depositInfo) {
      setQrDataUrl(null);
      return;
    }

    const uri = buildPaymentDeepLink(depositInfo.hotWalletAddress, amount, depositInfo.memo);
    let cancelled = false;

    QRCode.toDataURL(uri, {
      margin: 1,
      width: 220,
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, depositInfo, amount]);

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Couldn't copy ${label.toLowerCase()}`);
    }
  }, []);

  const parsedAmount = Number.parseFloat(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const deepLink =
    depositInfo && amountValid
      ? buildPaymentDeepLink(depositInfo.hotWalletAddress, amount, depositInfo.memo)
      : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md" aria-label="Top up escrow">
        <DialogHeader>
          <DialogTitle>Top Up Escrow</DialogTitle>
          <DialogDescription>Fund your escrow balance with USDC over Stellar.</DialogDescription>
        </DialogHeader>

        {!challengeId ? (
          <div className="space-y-4 text-sm">
            <p className="text-[var(--muted-foreground)]">
              Your scheduled payouts are fully covered right now. Escrow is funded through a
              challenge deposit, so launch a new challenge whenever you&apos;re ready to add funds.
            </p>
            <Link href={`/brand/${brandId}/challenge/new`} onClick={onClose}>
              <Button className="w-full">Launch a Challenge</Button>
            </Link>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            <div className="h-40 animate-pulse rounded-lg bg-[var(--muted)]" />
            <div className="h-10 animate-pulse rounded-lg bg-[var(--muted)]" />
          </div>
        ) : loadError ? (
          <div className="space-y-4 text-sm">
            <p className="text-red-600">{loadError}</p>
            <Button variant="outline" className="w-full" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : depositInfo ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="topup-amount">Top-up amount (USDC)</Label>
              <Input
                id="topup-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
                placeholder={depositInfo.amount}
                aria-describedby="topup-suggested"
              />
              <p id="topup-suggested" className="text-xs text-[var(--muted-foreground)]">
                Suggested: {suggestedAmount > 0 ? suggestedAmount.toFixed(2) : depositInfo.amount}{" "}
                USDC — based on your remaining scheduled payouts.
              </p>
            </div>

            <div className="flex justify-center">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt="QR code for the escrow funding transaction"
                  className="h-44 w-44 rounded-lg border border-[var(--border)]"
                />
              ) : (
                <div className="h-44 w-44 animate-pulse rounded-lg bg-[var(--muted)]" />
              )}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-[var(--muted-foreground)]">Deposit address</p>
                  <p className="truncate font-mono text-xs" title={depositInfo.hotWalletAddress}>
                    {depositInfo.hotWalletAddress}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(depositInfo.hotWalletAddress, "Address")}
                >
                  Copy
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-[var(--muted-foreground)]">Memo (required)</p>
                  <p className="truncate font-mono text-xs" title={depositInfo.memo}>
                    {depositInfo.memo}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(depositInfo.memo, "Memo")}
                >
                  Copy
                </Button>
              </div>
            </div>

            {deepLink && (
              <a href={deepLink} className="block">
                <Button variant="secondary" className="w-full">
                  Open in Stellar wallet
                </Button>
              </a>
            )}

            <p className="text-xs text-[var(--muted-foreground)]">
              Our deposit monitor polls the Stellar network every few seconds, so deposits are
              detected and credited within a couple of minutes after ledger close. Always include
              the memo — it&apos;s how your deposit is matched to your escrow.
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
