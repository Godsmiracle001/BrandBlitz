import { expect, test } from "@playwright/test";

test("web page responses include X-DNS-Prefetch-Control: off", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["x-dns-prefetch-control"]).toBe("off");
});

test("API health endpoint includes X-DNS-Prefetch-Control: off", async ({ request }) => {
  const response = await request.get(
    `${process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001"}/health`
  );
  expect(response.headers()["x-dns-prefetch-control"]).toBe("off");
});
