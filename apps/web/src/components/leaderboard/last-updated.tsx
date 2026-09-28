"use client";

import { useEffect, useState } from "react";

function formatAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface LastUpdatedProps {
  /** Epoch milliseconds of the fetch/revalidation that produced the data. */
  fetchedAt: number;
  /** Age in seconds at server render time — keeps SSR and hydration in sync. */
  initialAgeSeconds: number;
  className?: string;
}

export function LastUpdated({ fetchedAt, initialAgeSeconds, className }: LastUpdatedProps) {
  const [ageSeconds, setAgeSeconds] = useState(initialAgeSeconds);

  useEffect(() => {
    const tick = () => setAgeSeconds(Math.floor((Date.now() - fetchedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [fetchedAt]);

  return (
    <time
      dateTime={new Date(fetchedAt).toISOString()}
      className={className ?? "text-xs text-[var(--muted-foreground)]"}
    >
      Updated {formatAge(ageSeconds)}
    </time>
  );
}
