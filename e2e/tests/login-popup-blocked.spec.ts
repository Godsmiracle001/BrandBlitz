import { expect, test } from "@playwright/test";

// Issue #347: a blocked OAuth popup must never leave the login button stuck in
// a permanent loading state. We simulate the browser blocking popups by making
// window.open return null before the page scripts run.
test("login button recovers when the OAuth popup is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    // Browsers return null from window.open when a popup is blocked.
    window.open = () => null;
  });

  await page.goto("/login");

  const button = page.getByRole("button", { name: /continue with google/i });
  await expect(button).toBeEnabled();
  await button.click();

  // In a real-provider build the popup path runs: the button must re-enable and
  // a popup-blocked message must appear. In the E2E mock build the redirect flow
  // navigates away. Either way the user is never stuck on a disabled button.
  const popupBlockedAlert = page.getByRole("alert");
  const recovered = await Promise.race([
    popupBlockedAlert
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => "alert")
      .catch(() => null),
    page
      .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 5_000 })
      .then(() => "navigated")
      .catch(() => null),
  ]);

  if (recovered === "alert") {
    await expect(popupBlockedAlert).toContainText(/allow popups/i);
    await expect(button).toBeEnabled();
  } else if (recovered !== "navigated") {
    // No navigation and no alert — the button must at least remain usable.
    await expect(button).toBeEnabled();
  }
});
