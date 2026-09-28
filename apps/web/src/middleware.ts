import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getToken } from "next-auth/jwt";

const REF_COOKIE_NAME = "ref";
const REF_TTL_SECONDS = 30 * 24 * 60 * 60;

// NextAuth session cookie names. The secure (`__Secure-`) prefix is used in
// production (see apps/web/src/lib/auth.ts); the bare name is used over http in
// dev. Both are cleared when we detect a stale/expired session on /login so a
// dead cookie can never trigger the /login ↔ /dashboard redirect loop.
const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
}

function clearSessionCookies(response: NextResponse): void {
  for (const name of SESSION_COOKIE_NAMES) {
    response.cookies.delete(name);
  }
}

function normalizeCode(code: string): string | null {
  const value = code.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(value) ? value : null;
}

/**
 * Generate a cryptographically secure nonce for CSP
 * Used to allow inline scripts while preventing XSS attacks
 */
function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Build Content-Security-Policy header value
 * Uses nonce-based approach for inline scripts
 * Enforced mode active (Content-Security-Policy)
 */
function buildCSPHeader(nonce: string): string {
  const cdnHost = process.env.NEXT_PUBLIC_CDN_HOST || "assets.brandblitz.app";
  const apiHost = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  // Extract hostname from API URL (handle both http://host and https://host)
  const apiHostname = new URL(apiHost).hostname;

  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `img-src 'self' data: https://${cdnHost}`,
    `font-src 'self' https://fonts.gstatic.com`,
    `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'`,
    `connect-src 'self' https://${apiHostname}`,
    `frame-ancestors 'none'`,
    `report-uri /api/csp-report`,
  ].join("; ");
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // ── Auth redirect guard (issues #571, #367) ───────────────────────────────
  // getToken decodes the JWT from the session cookie and validates its `exp`
  // claim, returning null for missing, malformed, OR expired tokens. Checking
  // its return value (not mere cookie presence) is what prevents the
  // /login ↔ /dashboard redirect loop for every token state.
  let clearStaleSession = false;
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });
    if (token) {
      // Session is valid and unexpired — redirect away from login.
      const url = request.nextUrl.clone();
      url.pathname = "/challenge";
      url.search = "";
      return NextResponse.redirect(url);
    }
    // Token missing/expired/malformed: never redirect. If a stale session
    // cookie is still present, delete it on the response so the browser stops
    // sending a dead credential that would otherwise re-trigger the loop.
    clearStaleSession = hasSessionCookie(request);
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Generate nonce for this request
  const nonce = generateNonce();

  // Handle referral code
  const referralCode = request.nextUrl.searchParams.get("ref");
  let response = NextResponse.next();

  if (referralCode) {
    const normalizedCode = normalizeCode(referralCode);
    if (normalizedCode) {
      response.cookies.set(REF_COOKIE_NAME, normalizedCode, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: REF_TTL_SECONDS,
        secure: request.nextUrl.protocol === "https:",
      });
    }
  }

  // Inject nonce into response headers for use in layout/components
  response.headers.set("x-nonce", nonce);

  // Prevent browsers from pre-resolving hostnames found in page content.
  // DNS prefetch can leak back-end infrastructure topology to network observers.
  response.headers.set("X-DNS-Prefetch-Control", "off");

  const cspHeader = buildCSPHeader(nonce);
  response.headers.set("Content-Security-Policy", cspHeader);

  // Expired/malformed session on /login: drop the dead cookie on the way out.
  if (clearStaleSession) {
    clearSessionCookies(response);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
