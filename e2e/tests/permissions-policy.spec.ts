import { expect, test } from "@playwright/test";
import { PERMISSIONS_POLICY_HEADER } from "@brandblitz/config";

test("page navigation responses include Permissions-Policy", async ({ page }) => {
  const response = await page.goto("/leaderboard");

  expect(response?.headers()["permissions-policy"]).toBe(PERMISSIONS_POLICY_HEADER);
});
