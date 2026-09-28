"use client";

import { useEffect, useRef, useState } from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNetworkStatus } from "@/hooks/use-network-status";

interface OfflineBannerProps {
  blocking?: boolean;
  className?: string;
}

export function OfflineBanner({ blocking = false, className }: OfflineBannerProps) {
  const { isOnline } = useNetworkStatus();
  const wasOffline = useRef(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true;
      setRestored(false);
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setRestored(true);
    const timeout = window.setTimeout(() => setRestored(false), 6000);
    return () => window.clearTimeout(timeout);
  }, [isOnline]);

  if (isOnline && !restored) return null;

  return (
    <div
      className={cn(
        "z-50 w-full border-b px-4 py-3 shadow-sm",
        isOnline
          ? "border-green-700 bg-green-100 text-green-950"
          : "border-amber-700 bg-amber-300 text-amber-950",
        blocking ? "fixed left-0 top-0" : "sticky top-0",
        className
      )}
      role="status"
      aria-live={isOnline ? "polite" : "assertive"}
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-2 text-sm font-semibold">
        {!isOnline && <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />}
        <span>
          {isOnline
            ? "You're back online. Retry any action that failed while disconnected."
            : "You are offline. We will reconnect automatically when your connection returns."}
        </span>
        {isOnline && (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => window.location.reload()}
          >
            Reload and retry
          </button>
        )}
      </div>
    </div>
  );
}
