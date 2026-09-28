import { expect, type Locator, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle } from "./helpers";
import { WARMUP_MIN_SECONDS } from "../../apps/web/src/components/game/constants";

async function expectVisibleFocusIndicator(locator: Locator) {
  const styles = await locator.evaluate((element) => {
    const computed = window.getComputedStyle(element);
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
      boxShadow: computed.boxShadow,
    };
  });

  const hasOutline =
    styles.outlineStyle !== "none" &&
    styles.outlineWidth !== "0px";
  const hasShadow = styles.boxShadow !== "none";

  expect(
    hasOutline || hasShadow,
    `Expected a visible focus indicator, got outline=${styles.outlineStyle}/${styles.outlineWidth} boxShadow=${styles.boxShadow}`,
  ).toBe(true);
}

test("keyboard-only navigation works through preview, warmup, and answer selection", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("brandblitz:keyboard-tooltip-dismissed", "1");
  });

  const seeded = await seedActiveChallenge(request, {
    email: "keyboard-owner@example.com",
    name: "Keyboard Owner",
  });

  await signInWithMockGoogle(
    page,
    { email: "keyboard-player@example.com", name: "Keyboard Player" },
    `/challenge/${seeded.challengeId}`,
  );

  await page.waitForURL(`**/challenge/${seeded.challengeId}`);

  const previewStartButton = page.getByRole("button", { name: /start now/i });
  await expect(previewStartButton).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(previewStartButton).toBeFocused();
  await expectVisibleFocusIndicator(previewStartButton);

  await page.keyboard.press("Enter");

  await expect(page.getByText(/Study this brand carefully/i)).toBeVisible();

  const warmupStartButton = page.getByRole("button", { name: /Start Challenge/i });
  await expect(warmupStartButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });

  await page.keyboard.press("Tab");
  await expect(warmupStartButton).toBeFocused();
  await expectVisibleFocusIndicator(warmupStartButton);

  await page.keyboard.press("Enter");

  await expect(page.getByText("Round 1 of 3")).toBeVisible();

  const reportButton = page.getByRole("button", { name: /report this challenge/i });
  const optionA = page.getByRole("button", { name: /^A:/ });
  const optionB = page.getByRole("button", { name: /^B:/ });
  const optionC = page.getByRole("button", { name: /^C:/ });
  const optionD = page.getByRole("button", { name: /^D:/ });

  await page.keyboard.press("Tab");
  await expect(reportButton).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(optionA).toBeFocused();
  await expectVisibleFocusIndicator(optionA);

  await page.keyboard.press("Escape");
  await expect(page.getByText("Round 1 of 3")).toBeVisible();
  await expect(optionA).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Tab");
  await expect(optionB).toBeFocused();
  await expectVisibleFocusIndicator(optionB);

  await page.keyboard.press("Tab");
  await expect(optionC).toBeFocused();
  await expectVisibleFocusIndicator(optionC);

  await page.keyboard.press("Tab");
  await expect(optionD).toBeFocused();
  await expectVisibleFocusIndicator(optionD);

  await page.keyboard.press("Enter");

  await expect(optionD).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Round 2 of 3")).toBeVisible({ timeout: 5_000 });
});
