import { expect, test } from "@playwright/test";

test("home page Content-Security-Policy header contains nonce and lacks unsafe-inline in script-src", async ({
  page,
}) => {
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";

  expect(csp).toBeTruthy();

  const scriptSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));

  expect(scriptSrc).toBeDefined();
  expect(scriptSrc).toMatch(/nonce-[A-Za-z0-9+/=]+/);
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).toContain("'strict-dynamic'");
});
