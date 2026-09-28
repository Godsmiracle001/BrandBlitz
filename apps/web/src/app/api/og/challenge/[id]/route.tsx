import { ImageResponse } from "next/og";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

/** Escape HTML special characters before interpolating into Satori JSX (#361). */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 1×1 transparent PNG returned when OG generation fails unexpectedly. */
function fallbackResponse(): NextResponse {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  return new NextResponse(png, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60" },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Fetch challenge data — fall back gracefully if unavailable
  let brandName = "BrandBlitz";
  let prizePool = "0";
  let logoUrl: string | null = null;

  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost/api";
    const res = await fetch(`${apiUrl}/challenges/${id}`, { next: { revalidate: 60 } });
    if (res.ok) {
      const data = await res.json();
      const c = data.challenge;
      brandName = c.brand_name ?? brandName;
      prizePool = c.pool_amount_usdc ?? prizePool;
      logoUrl = c.logo_url ?? null;
    }
  } catch {
    // Use defaults
  }

  // Escape special characters before interpolating into Satori JSX to prevent
  // render exceptions on brand names containing &, <, >, ", or ' (#361).
  const safeBrandName = escapeHtml(brandName);

  try {
    return new ImageResponse(
      (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
            fontFamily: "sans-serif",
            padding: "48px",
          }}
        >
          {logoUrl && (
            // next/image can't render inside Satori's ImageResponse
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={safeBrandName}
              width={80}
              height={80}
              style={{ borderRadius: "50%", marginBottom: "24px", objectFit: "cover" }}
            />
          )}
          <div style={{ fontSize: 48, fontWeight: 700, color: "#f8fafc", textAlign: "center", lineHeight: 1.2 }}>
            {safeBrandName} Challenge
          </div>
          <div style={{ fontSize: 28, color: "#22d3ee", marginTop: "16px", fontWeight: 600 }}>
            Win {prizePool} USDC
          </div>
          <div style={{ fontSize: 18, color: "#94a3b8", marginTop: "12px", textAlign: "center" }}>
            Compete in a 45-second brand challenge. Top players win USDC instantly.
          </div>
          <div style={{ marginTop: "32px", fontSize: 14, color: "#475569" }}>
            brandblitz.gg
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    );
  } catch {
    // Satori render failed — return a 1×1 transparent PNG so link previews
    // don't get a 500 and crawlers don't retry aggressively (#361).
    return fallbackResponse();
  }
}
