import type { NextConfig } from "next";
import withBundleAnalyzer from "@next/bundle-analyzer";
import { PERMISSIONS_POLICY_HEADER } from "@brandblitz/config";

const withAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

function getAllowedOrigins() {
  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (envOrigins) {
    return envOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  }

  // Fallbacks
  if (process.env.NODE_ENV === "production") {
    // Staging / explicit environments must have ALLOWED_ORIGINS
    if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
      throw new Error("ALLOWED_ORIGINS must be set in Vercel preview/staging environments");
    }
    return ["brandblitz.app", "www.brandblitz.app"];
  }

  return ["localhost:3000", "127.0.0.1:3000"];
}

/**
 * Constructs image remotePatterns from environment variables.
 * Supports:
 *  - Dev: MinIO at localhost:9000 + 127.0.0.1:9000
 *  - Prod/staging: S3 host via NEXT_PUBLIC_CDN_HOST or NEXT_PUBLIC_S3_HOST (e.g., assets.brandblitz.app)
 */
function getImageRemotePatterns() {
  const patterns: NonNullable<NonNullable<NextConfig["images"]>["remotePatterns"]> = [
    // Google OAuth avatars
    { protocol: "https" as const, hostname: "lh3.googleusercontent.com" },
  ];

  // MinIO development hosts (local testing, Docker)
  patterns.push(
    {
      protocol: "http" as const,
      hostname: "localhost",
      port: "9000",
      pathname: "/brandblitz/**",
    },
    {
      protocol: "http" as const,
      hostname: "127.0.0.1",
      port: "9000",
      pathname: "/brandblitz/**",
    }
  );

  // Production/Staging CDN host from env
  const cdnHost = process.env.NEXT_PUBLIC_CDN_HOST || process.env.NEXT_PUBLIC_S3_HOST;
  if (cdnHost) {
    patterns.push({
      protocol: "https" as const,
      hostname: cdnHost,
      pathname: "/brandblitz/**",
    });
  }

  // Fallback to the legacy assets.brandblitz.app for backward compatibility
  if (!cdnHost) {
    patterns.push({
      protocol: "https" as const,
      hostname: "assets.brandblitz.app",
      pathname: "/brandblitz/**",
    });
  }

  return patterns;
}

const nextConfig: NextConfig = {
  // Required for Docker standalone builds — reduces image 500MB → ~150MB
  output: "standalone",

  images: {
    remotePatterns: getImageRemotePatterns(),
  },

  experimental: {
    serverActions: {
      allowedOrigins: getAllowedOrigins(),
    },
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Referrer-Policy",
            value: process.env.REFERRER_POLICY ?? "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: PERMISSIONS_POLICY_HEADER,
          },
        ],
      },
    ];
  },
};

export default withAnalyzer(nextConfig);
