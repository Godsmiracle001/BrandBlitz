import { expect, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle } from "./helpers";
import { WARMUP_MIN_SECONDS } from "../../apps/web/src/components/game/constants";

test.describe("Parallel Game Sessions E2E", () => {
  test("two parallel browser contexts play same challenge without interference", async ({ browser, request }) => {
    test.setTimeout(60000); // under 60 seconds

    const seeded = await seedActiveChallenge(request, {
      email: "brand-owner-parallel@example.com",
      name: "Parallel Owner",
    });

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Start sessions concurrently
    await Promise.all([
      signInWithMockGoogle(
        page1,
        { email: "player1@example.com", name: "Player One" },
        `/challenge/${seeded.challengeId}`
      ),
      signInWithMockGoogle(
        page2,
        { email: "player2@example.com", name: "Player Two" },
        `/challenge/${seeded.challengeId}`
      )
    ]);

    await Promise.all([
      page1.waitForURL(`**/challenge/${seeded.challengeId}`),
      page2.waitForURL(`**/challenge/${seeded.challengeId}`)
    ]);

    const startButton1 = page1.getByRole("button", { name: "Start Challenge →" });
    const startButton2 = page2.getByRole("button", { name: "Start Challenge →" });

    await Promise.all([
      expect(startButton1).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 }),
      expect(startButton2).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 })
    ]);

    await Promise.all([
      startButton1.click(),
      startButton2.click()
    ]);

    // Submit different answers
    for (const round of [1, 2, 3]) {
      await Promise.all([
        expect(page1.getByText(`Round ${round} of 3`)).toBeVisible(),
        expect(page2.getByText(`Round ${round} of 3`)).toBeVisible(),
      ]);

      await page1.waitForTimeout(250);
      await page2.waitForTimeout(250);

      // Player 1 picks A, Player 2 picks B
      await Promise.all([
        page1.getByRole("button", { name: /^A/ }).click(),
        page2.getByRole("button", { name: /^B/ }).click()
      ]);
    }

    // Wait for completion
    await Promise.all([
      expect(page1.getByRole("heading", { name: "Challenge Complete!" })).toBeVisible(),
      expect(page2.getByRole("heading", { name: "Challenge Complete!" })).toBeVisible()
    ]);

    // Verify leaderboard rankings (independent scores)
    await page1.getByRole("link", { name: "Global Leaderboard" }).click();
    await page1.waitForURL("**/leaderboard");

    // Both players should be on leaderboard
    await expect(page1.getByText("Player One")).toBeVisible();
    await expect(page1.getByText("Player Two")).toBeVisible();

    // Closing one context does not affect the other's state
    // To test this properly, we can close context1 and assert context2 is still fine
    await context1.close();
    
    // Assert page2 is still fully usable
    await page2.getByRole("link", { name: "Global Leaderboard" }).click();
    await expect(page2.getByText("Player One")).toBeVisible();
    await expect(page2.getByText("Player Two")).toBeVisible();
  });
});
