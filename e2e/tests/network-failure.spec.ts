import { expect, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle } from "./helpers";
import { WARMUP_MIN_SECONDS } from "../../apps/web/src/components/game/constants";

test.describe("Network Failure E2E", () => {
  test("network failure during game shows error state, not blank screen", async ({ page, request }) => {
    // Watch for console errors
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    const seeded = await seedActiveChallenge(request, {
      email: "brand-owner-net@example.com",
      name: "Network Owner",
    });

    await signInWithMockGoogle(
      page,
      { email: "player-net@example.com", name: "Player Network" },
      `/challenge/${seeded.challengeId}`
    );

    await page.waitForURL(`**/challenge/${seeded.challengeId}`);
    
    const startButton = page.getByRole("button", { name: "Start Challenge →" });
    await expect(startButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });
    await startButton.click();

    await expect(page.getByText(`Round 1 of 3`)).toBeVisible();

    // 1. Intercept round-fetch (or answer submission) and abort
    await page.route("**/api/sessions/**", (route) => {
      if (route.request().method() === "POST") {
        route.abort("failed");
      } else {
        route.continue();
      }
    });

    await page.waitForTimeout(250);
    // Submit answer - should fail due to abort
    await page.getByRole("button", { name: /^A/ }).click();

    // Assert visible error message
    await expect(page.getByText(/error|retry/i)).toBeVisible();
    await expect(page.locator("body")).not.toBeEmpty(); // not blank page

    // 2. Intercept and return 503
    await page.unroute("**/api/sessions/**");
    await page.route("**/api/sessions/**", (route) => {
      if (route.request().method() === "POST") {
        route.fulfill({ status: 503, body: "Service Unavailable" });
      } else {
        route.continue();
      }
    });

    const retryButton = page.getByRole("button", { name: /retry/i });
    if (await retryButton.isVisible()) {
      await retryButton.click();
    } else {
      await page.getByRole("button", { name: /^A/ }).click();
    }

    // Assert 503 triggers non-blank error UI
    await expect(page.getByText(/error|retry|503/i)).toBeVisible();

    // 3. Unroute and verify retry succeeds without reload
    await page.unroute("**/api/sessions/**");
    
    if (await retryButton.isVisible()) {
      await retryButton.click();
    } else {
      await page.getByRole("button", { name: /^A/ }).click();
    }

    // Should proceed to Round 2
    await expect(page.getByText(`Round 2 of 3`)).toBeVisible();

    // 4. No unhandled console errors
    // (We filter out the expected network errors from Playwright's perspective)
    const unexpectedErrors = errors.filter(e => !e.includes("net::ERR_FAILED") && !e.includes("503"));
    expect(unexpectedErrors.length).toBe(0);

    // 5. Confirm session-timeout queue behavior not triggered (session still active)
    const followUpRes = await request.get(`/api/sessions/active`);
    expect(followUpRes.ok()).toBeTruthy();
  });
});
