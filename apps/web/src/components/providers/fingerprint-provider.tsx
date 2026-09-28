"use client";

import { ReactNode, useEffect } from "react";

/**
 * FingerprintProvider initializes FingerprintJS Pro for device fingerprinting.
 *
 * Sets up the global fpPromise so useFingerprint hook can access the visitorId.
 * Gracefully handles missing configuration or load failures.
 */
export function FingerprintProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const publicKey = process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY;

    // If not configured, skip initialization
    if (!publicKey) {
      return;
    }

    // Initialize FingerprintJS Pro
    const initFingerprint = async () => {
      try {
        const FingerprintJS = await import("@fingerprintjs/fingerprintjs-pro-react");
        // Create the fpPromise and attach to window for useFingerprint hook
        const fpPromise = FingerprintJS.FingerprintJSPro.load({
          apiKey: publicKey,
        });

        (window as any).fpPromise = fpPromise;
      } catch (error) {
        console.warn("Failed to initialize FingerprintJS:", error);
        // Silently fail — device fingerprinting is optional
      }
    };

    void initFingerprint();
  }, []);

  return <>{children}</>;
}
