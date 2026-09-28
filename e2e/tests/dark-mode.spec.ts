import { expect, test } from "@playwright/test";
import { signInWithMockGoogle } from "./helpers";

const THEME_USER = { email: "darkmode@example.com", name: "Dark Mode Tester" };

async function getHtmlClasses(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => document.documentElement.className);
}

async function getThemeDataAttr(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

async function getLocalStorageTheme(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("theme"));
}

test.describe("Dark mode toggle persistence (#442)", () => {
  test("enabling dark mode applies dark class on <html>", async ({ page }) => {
    await signInWithMockGoogle(page, THEME_USER, "/leaderboard");

    const toggle = page.getByRole("button", { name: /theme:/i });
    await toggle.click();

    const classes = await getHtmlClasses(page);
    expect(classes).toContain("dark");

    const theme = await getThemeDataAttr(page);
    expect(theme).toBe("dark");

    const stored = await getLocalStorageTheme(page);
    expect(stored).toBe("dark");
  });

  test("dark mode persists after client-side navigation to /leaderboard", async ({ page }) => {
    await signInWithMockGoogle(page, THEME_USER, "/leaderboard");

    const toggle = page.getByRole("button", { name: /theme:/i });
    await toggle.click();

    await expect(getHtmlClasses(page)).resolves.toContain("dark");

    await page.getByRole("link", { name: /leaderboard/i }).first().click();
    await page.waitForURL("**/leaderboard");

    const classes = await getHtmlClasses(page);
    expect(classes).toContain("dark");
  });

  test("dark mode persists after a full page reload", async ({ page }) => {
    await signInWithMockGoogle(page, THEME_USER, "/leaderboard");

    const toggle = page.getByRole("button", { name: /theme:/i });
    await toggle.click();

    await expect(getHtmlClasses(page)).resolves.toContain("dark");

    await page.reload();

    const classes = await getHtmlClasses(page);
    expect(classes).toContain("dark");

    const stored = await getLocalStorageTheme(page);
    expect(stored).toBe("dark");
  });

  test("dark mode persists in a new tab (shared localStorage)", async ({ page, context }) => {
    await signInWithMockGoogle(page, THEME_USER, "/leaderboard");

    const toggle = page.getByRole("button", { name: /theme:/i });
    await toggle.click();

    await expect(getHtmlClasses(page)).resolves.toContain("dark");

    const newPage = await context.newPage();
    await newPage.goto("/leaderboard");
    await newPage.waitForLoadState("domcontentloaded");

    const classes = await getHtmlClasses(newPage);
    expect(classes).toContain("dark");
  });

  test("disabling dark mode restores light mode and persists on reload", async ({ page }) => {
    await signInWithMockGoogle(page, THEME_USER, "/leaderboard");

    const toggle = page.getByRole("button", { name: /theme:/i });
    await toggle.click();
    await expect(getHtmlClasses(page)).resolves.toContain("dark");

    await toggle.click();
    const classes = await getHtmlClasses(page);
    expect(classes).not.toContain("dark");

    const stored = await getLocalStorageTheme(page);
    expect(stored).toBe("light");

    await page.reload();

    const reloadedClasses = await getHtmlClasses(page);
    expect(reloadedClasses).not.toContain("dark");
  });

  test("no flash of light theme on reload when dark mode is active", async ({ page }) => {
    await signInWithMockGoogle(page, THEME_USER, "/leaderboard");

    const toggle = page.getByRole("button", { name: /theme:/i });
    await toggle.click();
    await expect(getHtmlClasses(page)).resolves.toContain("dark");

    const response = await page.goto("/leaderboard");
    expect(response?.ok()).toBeTruthy();

    const classes = await getHtmlClasses(page);
    expect(classes).toContain("dark");

    const theme = await getThemeDataAttr(page);
    expect(theme).toBe("dark");
  });
});
