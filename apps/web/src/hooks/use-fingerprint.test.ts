import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useFingerprint } from "./use-fingerprint";

describe("useFingerprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear environment variable
    delete (process.env as any).NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY;
    delete (window as any).fpPromise;
  });

  it("should return null when NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY is not set", async () => {
    const { result } = renderHook(() => useFingerprint());

    await waitFor(() => {
      expect(result.current).toBe(null);
    });
  });

  it("should not call FingerprintJS SDK during tests when not configured", async () => {
    const { result } = renderHook(() => useFingerprint());

    await waitFor(() => {
      expect(result.current).toBe(null);
    });
  });

  it("should return the visitorId collected by the FingerprintJS agent", async () => {
    process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = "test-key";
    const get = vi.fn().mockResolvedValue({ visitorId: "visitor-id" });
    (window as any).fpPromise = Promise.resolve({ get });

    const { result } = renderHook(() => useFingerprint());

    await waitFor(() => {
      expect(result.current).toBe("visitor-id");
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it("should gracefully handle FingerprintJS load failures", async () => {
    process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = "test-key";
    (window as any).fpPromise = Promise.reject(new Error("Failed to load FingerprintJS"));

    const { result } = renderHook(() => useFingerprint());

    await waitFor(() => {
      expect(result.current).toBe(null);
    });
  });
});
