import { expect, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle } from "./helpers";

test.describe("Cancel Challenge E2E", () => {
  test("brand owner cancels challenge from dashboard and sees refund status", async ({ page, request }) => {
    // Watch all network requests to /api/challenges/** to ensure 2xx
    page.on("response", (response) => {
      if (response.url().includes("/api/challenges/")) {
        expect(response.status()).toBeGreaterThanOrEqual(200);
        expect(response.status()).toBeLessThan(300);
      }
    });

    const seeded = await seedActiveChallenge(request, {
      email: "brand-owner-cancel@example.com",
      name: "Cancel Owner",
    });

    await signInWithMockGoogle(
      page,
      { email: "brand-owner-cancel@example.com", name: "Cancel Owner" },
      "/dashboard"
    );

    await page.waitForURL("**/dashboard");

    // Locate active challenge
    const challengeCard = page.locator(`[data-testid="challenge-card-${seeded.challengeId}"]`).or(page.locator('.challenge-card').first());
    await expect(challengeCard).toBeVisible();

    // Click cancel action
    const cancelButton = challengeCard.getByRole("button", { name: /cancel/i });
    await cancelButton.click();

    // Confirm modal appears
    const modal = page.locator('[role="dialog"]').or(page.locator('.modal'));
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/Are you sure/i)).toBeVisible();

    // Confirm cancellation
    await modal.getByRole("button", { name: /confirm/i }).click();

    // Assert updates to "Cancelled" without full page reload
    await expect(challengeCard.getByText(/Cancelled/i)).toBeVisible();

    // Verify refund record indicator
    await expect(challengeCard.getByText(/Refund (Pending|Initiated)/i)).toBeVisible();

    // Reload page and assert persistence
    await page.reload();
    await expect(challengeCard.getByText(/Cancelled/i)).toBeVisible();
    await expect(challengeCard.getByText(/Refund (Pending|Initiated)/i)).toBeVisible();

    // Attempt to cancel again - assert disabled or meaningful error
    const disabledCancelBtn = challengeCard.getByRole("button", { name: /cancel/i });
    // Check if the button is either not present, disabled, or gives an error
    if (await disabledCancelBtn.isVisible()) {
      await expect(disabledCancelBtn).toBeDisabled();
    }
  });
});
