import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Substitution note (issue #367): Playwright IS configured in this repo, but its
// e2e specs require a full running stack (Next + API + Postgres + Redis + a real
// NEXTAUTH_SECRET) that cannot be booted here to verify a brand-new spec. This
// deterministic unit test exercises the exact middleware decision logic — the
// valid / expired / malformed / absent token states — that prevents the
// /login ↔ /dashboard redirect loop, plus the stale-cookie clearing.

const getTokenMock = vi.fn();

vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));

import { middleware } from "./middleware";

const SESSION_COOKIE = "next-auth.session-token";

function makeRequest(pathname: string, opts?: { sessionCookie?: string }): NextRequest {
  const headers = new Headers();
  if (opts?.sessionCookie) {
    headers.set("cookie", `${SESSION_COOKIE}=${opts.sessionCookie}`);
  }
  return new NextRequest(new URL(`https://app.test${pathname}`), { headers });
}

function locationPath(res: Response): string | null {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
}

function setCookieString(res: Response): string {
  // getSetCookie() aggregates multiple Set-Cookie headers when available.
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie().join("\n");
  }
  return res.headers.get("set-cookie") ?? "";
}

describe("web middleware — /login redirect-loop guard (issue #367)", () => {
  beforeEach(() => {
    getTokenMock.mockReset();
  });

  it("redirects away from /login when the session token is valid and unexpired", async () => {
    getTokenMock.mockResolvedValueOnce({ sub: "user-1", exp: Date.now() / 1000 + 3600 });

    const res = await middleware(makeRequest("/login"));

    expect(res.status).toBe(307);
    expect(locationPath(res)).toBe("/challenge");
  });

  it("does NOT redirect when the token is expired (getToken returns null)", async () => {
    getTokenMock.mockResolvedValueOnce(null);

    const res = await middleware(makeRequest("/login", { sessionCookie: "expired.jwt.value" }));

    // No redirect — the login page is allowed to render.
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("clears the stale session cookie when an expired token is present on /login", async () => {
    getTokenMock.mockResolvedValueOnce(null);

    const res = await middleware(makeRequest("/login", { sessionCookie: "expired.jwt.value" }));

    const cookies = setCookieString(res);
    expect(cookies).toContain(SESSION_COOKIE);
    // A deletion is emitted as an immediately-expiring cookie.
    expect(cookies).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it("does NOT emit a clearing cookie when no session cookie exists (absent token)", async () => {
    getTokenMock.mockResolvedValueOnce(null);

    const res = await middleware(makeRequest("/login"));

    expect(res.status).not.toBe(307);
    expect(setCookieString(res)).not.toContain(SESSION_COOKIE);
  });

  it("treats a malformed token the same as absent (getToken null -> render, no loop)", async () => {
    getTokenMock.mockResolvedValueOnce(null);

    const res = await middleware(makeRequest("/login", { sessionCookie: "malformed-not-a-jwt" }));

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
    // Stale/garbage cookie is still cleared.
    expect(setCookieString(res)).toContain(SESSION_COOKIE);
  });

  it("never evaluates the login guard for non-login paths (no redirect from here)", async () => {
    const res = await middleware(makeRequest("/challenge", { sessionCookie: "whatever" }));

    expect(res.status).not.toBe(307);
    expect(getTokenMock).not.toHaveBeenCalled();
    // Still applies security headers on the normal path.
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
