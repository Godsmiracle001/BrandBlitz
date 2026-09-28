"use client";

import { useEffect, useState } from "react";

/**
 * Hook to load FingerprintJS Pro visitorId for anti-cheat device fingerprinting.
 *
 * Returns the visitorId if available, or null if:
 * - FingerprintJS is not configured (NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY missing)
 * - Loading fails (network error, invalid key, etc.)
 *
 * Gracefully handles failures so the game can proceed without device ID.
 * The backend will flag sessions without a device ID for manual review.
 */
export function useFingerprint(): string | null {
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const publicKey = process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY;

    // If not configured, skip loading
    if (!publicKey) {
      setLoaded(true);
      return;
    }

    // Load FingerprintJS Pro dynamically
    const loadFingerprint = async () => {
      try {
        // Dynamically import to avoid bundling if not configured
        const FingerprintJS = await import("@fingerprintjs/fingerprintjs-pro-react");
        // Get the visitorId from the global FingerprintJS instance
        // This assumes the provider is already set up in the layout
        const fpPromise = (window as any).fpPromise;
        if (fpPromise) {
          const fp = await fpPromise;
          const result = await fp.get();
          setVisitorId(result.visitorId);
        }
      } catch (error) {
        // Silently fail — device ID is optional for gameplay
        // Backend will flag sessions without device ID
        console.warn("Failed to load FingerprintJS:", error);
      } finally {
        setLoaded(true);
      }
    };

    void loadFingerprint();
  }, []);

  return loaded ? visitorId : null;
}
