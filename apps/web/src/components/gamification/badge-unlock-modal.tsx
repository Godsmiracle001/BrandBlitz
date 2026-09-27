"use client";

import * as React from "react";

export interface Badge {
  id: string;
  name: string;
  description: string;
  iconUrl?: string;
}

interface BadgeUnlockModalProps {
  badges: Badge[];
  onClose: () => void;
}

function isAlreadyDismissed(badgeId: string): boolean {
  try {
    return sessionStorage.getItem(`dismissed_badges_${badgeId}`) === "true";
  } catch {
    return false;
  }
}

function markDismissed(badgeId: string): void {
  try {
    sessionStorage.setItem(`dismissed_badges_${badgeId}`, "true");
  } catch {
    // ignore
  }
}

export function BadgeUnlockModal({ badges, onClose }: BadgeUnlockModalProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [visible, setVisible] = React.useState(false);

  // Filter out already-dismissed badges
  const undismissed = React.useMemo(
    () => badges.filter((b) => !isAlreadyDismissed(b.id)),
    [badges]
  );

  React.useEffect(() => {
    if (undismissed.length > 0) {
      // Small delay to allow CSS transition
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    }
  }, [undismissed.length]);

  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  function handleClose() {
    undismissed.forEach((b) => markDismissed(b.id));
    setVisible(false);
    setTimeout(onClose, 310);
  }

  if (undismissed.length === 0) return null;

  const badge = undismissed[currentIndex];

  function goPrev() {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }

  function goNext() {
    setCurrentIndex((i) => Math.min(undismissed.length - 1, i + 1));
  }

  const shareUrl = `https://x.com/intent/tweet?text=I+just+earned+${encodeURIComponent(badge.name)}+on+BrandBlitz!`;

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={handleClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 999,
          opacity: visible ? 1 : 0,
          transition: "opacity 300ms ease-out",
        }}
      />
      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Badge unlocked"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
          background: "#fff",
          borderRadius: "16px 16px 0 0",
          padding: "24px",
          transform: visible ? "translateY(0)" : "translateY(100%)",
          transition: "transform 300ms ease-out",
          textAlign: "center",
        }}
      >
        <button
          aria-label="Close"
          onClick={handleClose}
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "none",
            border: "none",
            fontSize: 20,
            cursor: "pointer",
          }}
        >
          ×
        </button>

        <h2 style={{ marginBottom: 8 }}>Badge Unlocked!</h2>

        {badge.iconUrl ? (
          // External badge icon URLs; next/image would require domain config for each source
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={badge.iconUrl}
            alt={badge.name}
            style={{ width: 80, height: 80, margin: "0 auto 12px", display: "block" }}
          />
        ) : (
          <div
            aria-label={badge.name}
            style={{
              width: 80,
              height: 80,
              background: "#e2e8f0",
              borderRadius: "50%",
              margin: "0 auto 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
            }}
          >
            🏅
          </div>
        )}

        <h3 style={{ margin: "8px 0 4px" }}>{badge.name}</h3>
        <p style={{ margin: "0 0 16px", color: "#666" }}>{badge.description}</p>

        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            padding: "10px 20px",
            background: "#000",
            color: "#fff",
            borderRadius: 8,
            textDecoration: "none",
            marginBottom: 12,
          }}
        >
          Share on X
        </a>

        {undismissed.length > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 8 }}>
            <button onClick={goPrev} disabled={currentIndex === 0} aria-label="Previous badge">
              ‹ Prev
            </button>
            <span>
              {currentIndex + 1} / {undismissed.length}
            </span>
            <button onClick={goNext} disabled={currentIndex === undismissed.length - 1} aria-label="Next badge">
              Next ›
            </button>
          </div>
        )}
      </div>
    </>
  );
}
