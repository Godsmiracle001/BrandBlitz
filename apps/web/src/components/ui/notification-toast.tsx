"use client";

import { useEffect, useRef } from "react";

export type NotificationType = "payout_received" | "badge_earned" | "streak_milestone";

export interface Notification {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

interface NotificationToastProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}

const ICONS: Record<NotificationType, string> = {
  payout_received: "💸",
  badge_earned: "🏅",
  streak_milestone: "🔥",
};

function toastSummary(n: Notification): string {
  switch (n.type) {
    case "payout_received": {
      const amount = n.payload.amount_usdc as string | undefined;
      return amount ? `You received ${amount} USDC!` : "USDC payout received!";
    }
    case "badge_earned": {
      const badge = n.payload.badge_name as string | undefined;
      return badge ? `Badge earned: ${badge}` : "New badge earned!";
    }
    case "streak_milestone": {
      const days = n.payload.milestone as number | undefined;
      return days ? `${days}-day streak milestone reached!` : "Streak milestone reached!";
    }
  }
}

const AUTO_DISMISS_MS = 5000;

export function NotificationToast({ notification, onDismiss }: NotificationToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(notification.id), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [notification.id, onDismiss]);

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--background)] px-4 py-3 shadow-lg text-sm w-72 animate-in slide-in-from-right-4 duration-300"
    >
      <span className="text-xl leading-none mt-0.5">{ICONS[notification.type]}</span>
      <p className="flex-1 text-[var(--foreground)]">{toastSummary(notification)}</p>
      <button
        aria-label="Dismiss notification"
        onClick={() => onDismiss(notification.id)}
        className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors leading-none"
      >
        ✕
      </button>
    </div>
  );
}
