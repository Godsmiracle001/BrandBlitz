"use client";

import { useEffect } from "react";
import { toast } from "@/lib/toast";

/**
 * GlobalErrorHandler - Catches unhandled promise rejections globally
 * 
 * This component adds a window.addEventListener('unhandledrejection') handler
 * to log unhandled promise rejections and display a user-facing error toast.
 * This addresses issue #366 where async errors thrown in useEffect callbacks
 * result in unhandled promise rejections that are silently swallowed in production.
 */
export function GlobalErrorHandler() {
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      // Prevent the default browser error logging
      event.preventDefault();

      // Log to console for debugging
      console.error("Unhandled promise rejection:", event.reason);

      // Show user-facing error toast
      const errorMessage = event.reason?.message || event.reason?.toString() || "An unexpected error occurred";
      toast.error(errorMessage);

      // Report to monitoring service (Sentry, etc.) if available
      if (typeof window !== "undefined" && (window as any).Sentry) {
        (window as any).Sentry.captureException(event.reason);
      }
    };

    // Add the event listener
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    // Clean up on unmount
    return () => {
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  // This component doesn't render anything - it's just for the side effect
  return null;
}
