import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { AuthBoundary } from "@/components/auth/auth-boundary";
import { Providers } from "@/components/providers";
import { MaintenanceBanner } from "@/components/layout/maintenance-banner";
import { getCspNonce } from "@/lib/csp";
import { FingerprintProvider } from "@/components/providers/fingerprint-provider";
import { GlobalErrorHandler } from "@/components/error/global-error-handler";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "BrandBlitz — Stellar Edition",
    template: "%s | BrandBlitz",
  },
  description:
    "Brands deposit USDC on Stellar. Users compete in 45-second brand challenges. Top performers earn USDC instantly.",
  metadataBase: new URL(process.env.WEB_URL ?? "http://localhost:3000"),
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "BrandBlitz",
    description: "Earn USDC by mastering brand challenges",
    url: "/",
    siteName: "BrandBlitz",
    images: [
      {
        url: "/og-default.png",
        width: 1200,
        height: 630,
        alt: "BrandBlitz — Earn USDC by mastering brand challenges",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "BrandBlitz",
    description: "Earn USDC by mastering brand challenges",
    images: ["/og-default.png"],
  },
};

export const viewport = {
  themeColor: "#6366f1",
  width: "device-width",
  initialScale: 1,
};

// SRI hashes for external scripts (update these when upgrading external dependencies)
const SRI_HASHES: Record<string, string> = {
  // Example: Add SRI hashes for external scripts here
  // "https://cdn.example.com/script.js": "sha384-abc123...",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = getCspNonce();

  return (
    <html lang="en" className={inter.className}>
      <head>
        <Script id="theme-init" strategy="beforeInteractive" nonce={nonce}>
          {`
            (function () {
              try {
                var key = "theme";
                var mode = localStorage.getItem(key);
                if (mode !== "light" && mode !== "dark" && mode !== "system") mode = "system";
                var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
                var isDark = mode === "dark" || (mode === "system" && prefersDark);
                var html = document.documentElement;
                if (isDark) html.classList.add("dark"); else html.classList.remove("dark");
                html.dataset.theme = mode;
              } catch (e) {
                // Ignore storage/media-query failures; the server-rendered theme remains usable.
              }
            })();
          `}
        </Script>
      </head>
      <body className="flex min-h-screen flex-col bg-[var(--background)] text-[var(--foreground)] antialiased">
        <FingerprintProvider>
          <AuthBoundary>
            <Providers>
              <GlobalErrorHandler />
              <MaintenanceBanner />
              {children}
            </Providers>
          </AuthBoundary>
        </FingerprintProvider>
      </body>
    </html>
  );
}
