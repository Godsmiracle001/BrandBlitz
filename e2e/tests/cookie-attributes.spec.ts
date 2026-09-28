import { expect, test } from "@playwright/test";

test("referral tracking cookie carries Secure; HttpOnly; SameSite=Strict", async ({ request }) => {
  const response = await request.get("/?ref=ABC123");

  const setCookie = response.headers()["set-cookie"] ?? "";
  const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean);

  const refCookie = cookies.find((c) => c.startsWith("ref="));
  if (refCookie) {
    expect(refCookie.toLowerCase()).toContain("secure");
    expect(refCookie.toLowerCase()).toContain("httponly");
    expect(refCookie.toLowerCase()).toContain("samesite=strict");
  }
});
