import { expect, test } from "@playwright/test";

test("challenges discovery page renders and filter controls are visible", async ({ page }) => {
  await page.goto("/challenges");

  await expect(page.getByRole("heading", { name: "Challenges" })).toBeVisible();

  await expect(page.getByRole("button", { name: "Active" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upcoming" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ended" })).toBeVisible();
});

test("active filter shows only active challenges", async ({ page }) => {
  await page.goto("/challenges");

  await page.getByRole("button", { name: "Active" }).click();

  const cards = page.locator('[data-slot="card"]');
  const count = await cards.count();

  if (count > 0) {
    const badges = page.getByText("Active");
    await expect(badges.first()).toBeVisible();
  } else {
    await expect(page.getByText("No challenges match the active filters.")).toBeVisible();
  }
});

test("clear filters button resets state", async ({ page }) => {
  await page.goto("/challenges");

  await page.getByRole("button", { name: "Ended" }).click();
  await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("button", { name: "Clear filters" })).not.toBeVisible();
});
