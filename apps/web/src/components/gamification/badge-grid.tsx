"use client";

import * as React from "react";
import Image from "next/image";

export interface Badge {
  id: string;
  slug: string;
  name: string;
  description: string;
  criteria: string;
  iconUrl: string;
  earned: boolean;
  earnedAt?: string | null;
}

interface BadgeGridProps {
  badges: Badge[];
  previouslyEarned?: string[];
  onNewBadge?: (badge: Badge) => void;
}

function LockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-5 w-5 text-white"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3A5.25 5.25 0 0012 1.5zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function BadgeItem({ badge, isNew }: { badge: Badge; isNew: boolean }) {
  const [showTooltip, setShowTooltip] = React.useState(false);
  const prefersReduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <div
      className="relative flex flex-col items-center gap-1"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onFocus={() => setShowTooltip(true)}
      onBlur={() => setShowTooltip(false)}
      tabIndex={0}
      role="img"
      aria-label={
        badge.earned ? `${badge.name} (earned)` : `${badge.name} (locked) — ${badge.criteria}`
      }
    >
      <div
        className={[
          "relative h-14 w-14 rounded-full border-2 transition-all duration-200",
          badge.earned
            ? "border-[var(--primary)] shadow-md"
            : "border-[var(--border)] opacity-40 grayscale",
          isNew && !prefersReduced ? "animate-bounce" : "",
        ].join(" ")}
      >
        <Image
          src={badge.iconUrl}
          alt={badge.name}
          fill
          sizes="56px"
          className="rounded-full object-cover"
        />
        {!badge.earned && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
            <LockIcon />
          </div>
        )}
      </div>
      <span className="max-w-[72px] text-center text-[10px] font-medium leading-tight">
        {badge.name}
      </span>
      {!badge.earned && (
        <p className="max-w-40 text-center text-xs text-[var(--muted-foreground)]">
          {badge.criteria}
        </p>
      )}
      {showTooltip && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 z-10 mb-2 w-44 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--popover)] px-3 py-2 text-xs shadow-lg"
        >
          <p className="font-semibold text-[var(--popover-foreground)]">{badge.name}</p>
          <p className="mt-0.5 text-[var(--muted-foreground)]">
            {badge.earned ? badge.description : `How to earn: ${badge.criteria}`}
          </p>
          {badge.earnedAt && (
            <p className="mt-1 text-[var(--muted-foreground)]">
              Earned {new Date(badge.earnedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Deduplicate badge entries by slug, keeping the earliest-awarded entry.
 * The user_badges table can accumulate duplicate rows when a scoring event
 * fires more than once (e.g. on a network retry); this guard prevents the
 * same badge card from appearing twice in the grid (#358).
 */
export function deduplicateBadges(badges: Badge[]): Badge[] {
  const seen = new Map<string, Badge>();
  for (const badge of badges) {
    const existing = seen.get(badge.slug);
    if (!existing) {
      seen.set(badge.slug, badge);
      continue;
    }
    // Keep the earliest-awarded entry.
    if (badge.earnedAt && existing.earnedAt && badge.earnedAt < existing.earnedAt) {
      seen.set(badge.slug, badge);
    }
  }
  return Array.from(seen.values());
}

export function BadgeGrid({ badges, previouslyEarned = [], onNewBadge }: BadgeGridProps) {
  const deduplicated = React.useMemo(() => deduplicateBadges(badges), [badges]);
  const prevSet = React.useRef(new Set(previouslyEarned));

  React.useEffect(() => {
    const newlyEarned = deduplicated.filter((b) => b.earned && !prevSet.current.has(b.id));
    for (const badge of newlyEarned) {
      onNewBadge?.(badge);
    }
    prevSet.current = new Set(deduplicated.filter((b) => b.earned).map((b) => b.id));
  }, [deduplicated, onNewBadge]);

  if (deduplicated.length === 0) return null;

  return (
    <section aria-label="Badges">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {deduplicated.map((badge) => (
          <BadgeItem
            key={badge.slug}
            badge={badge}
            isNew={badge.earned && !previouslyEarned.includes(badge.id)}
          />
        ))}
      </div>
    </section>
  );
}
