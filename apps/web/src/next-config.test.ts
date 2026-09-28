import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next image remote patterns", () => {
  it("only allows explicit avatar, MinIO bucket, and CDN bucket hosts", () => {
    const patterns = nextConfig.images?.remotePatterns ?? [];
    // Must include Google avatars
    expect(patterns.some((p: any) => p.hostname === "lh3.googleusercontent.com")).toBe(true);
    // Must include local MinIO hosts
    expect(patterns.some((p: any) => p.hostname === "localhost" && p.port === "9000")).toBe(true);
    // Must include fallback CDN host
    expect(patterns.some((p: any) => p.hostname === "assets.brandblitz.app")).toBe(true);
    // All patterns must use secure pathname
    patterns.forEach((p: any) => {
      if (p.pathname) expect(p.pathname).toContain("/brandblitz");
    });
  });

  it("sets Referrer-Policy and Permissions-Policy on all page responses", async () => {
    const headers = await nextConfig.headers?.();
    expect(headers).toBeDefined();
    expect(headers![0].source).toBe("/:path*");
    const headerKeys = headers![0].headers.map((h: any) => h.key);
    expect(headerKeys).toContain("Referrer-Policy");
    expect(headerKeys).toContain("Permissions-Policy");
  });
});
