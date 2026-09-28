"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/lib/toast";

// Poll the OAuth popup often enough that a user-cancelled popup releases the
// loading state well within the 500 ms target from issue #347.
const POPUP_POLL_INTERVAL_MS = 250;
const POPUP_FEATURES =
  "width=500,height=600,menubar=no,toolbar=no,location=no,status=no";
const POPUP_BLOCKED_MESSAGE =
  "Popup blocked. Please allow popups for this site, then try signing in again.";

export function LoginButton() {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const useMock = process.env.NEXT_PUBLIC_E2E_MOCK_GOOGLE_OAUTH === "true";
  const providerId = useMock ? "google-mock" : "google";

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const mockSignInOptions = useMemo(
    () => ({
      callbackUrl,
      email: searchParams.get("mockEmail") ?? "e2e-player@example.com",
      name: searchParams.get("mockName") ?? "E2E Player",
    }),
    [callbackUrl, searchParams]
  );

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Stop polling if the component unmounts mid-flow.
  useEffect(() => clearPoll, [clearPoll]);

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(callbackUrl);
    }
  }, [status, router, callbackUrl]);

  const handleLogin = useCallback(() => {
    setError(null);
    setIsLoading(true);

    // The E2E mock provider uses NextAuth's standard redirect flow — no popup.
    if (useMock) {
      void signIn(providerId, mockSignInOptions);
      return;
    }

    const signInUrl = `/api/auth/signin/${providerId}?callbackUrl=${encodeURIComponent(
      callbackUrl
    )}`;

    let popup: Window | null = null;
    try {
      popup = window.open(signInUrl, "brandblitz-oauth", POPUP_FEATURES);
    } catch {
      popup = null;
    }

    // A blocked popup returns null (or throws). Recover immediately so the
    // button never gets stuck in a permanent loading state (issue #347).
    if (!popup) {
      setIsLoading(false);
      setError(POPUP_BLOCKED_MESSAGE);
      toast.error(POPUP_BLOCKED_MESSAGE);
      return;
    }

    // If the user closes the popup before OAuth completes, reset loading.
    // A successful login flips `status` to "authenticated" and redirects above.
    clearPoll();
    pollRef.current = window.setInterval(() => {
      if (popup?.closed) {
        clearPoll();
        setIsLoading(false);
      }
    }, POPUP_POLL_INTERVAL_MS);
  }, [useMock, providerId, mockSignInOptions, callbackUrl, clearPoll]);

  if (status === "loading") return <Skeleton className="h-11 w-full" />;

  return (
    <div className="space-y-2">
      <Button
        className="w-full"
        size="lg"
        onClick={handleLogin}
        disabled={isLoading}
        aria-busy={isLoading}
      >
        <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        {isLoading ? "Signing in…" : "Continue with Google"}
      </Button>
      {error ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
