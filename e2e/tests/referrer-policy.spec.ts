import { expect, test } from "@playwright/test";

test("page navigation responses include Referrer-Policy", async ({ page }) => {
  const response = await page.goto("/leaderboard");

  expect(response?.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});
