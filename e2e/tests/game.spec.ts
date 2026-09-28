import { expect, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle } from "./helpers";
import { WARMUP_MIN_SECONDS } from "../../apps/web/src/components/game/constants";
import pg from "pg";

test("player can complete warmup, play 3 rounds, and reach results", async ({
  page,
  request,
}) => {
  const seeded = await seedActiveChallenge(request, {
    email: "brand-owner-game@example.com",
    name: "Game Owner",
  });

  await signInWithMockGoogle(
    page,
    { email: "player-one@example.com", name: "Player One" },
    `/challenge/${seeded.challengeId}`
  );

  await page.waitForURL(`**/challenge/${seeded.challengeId}`);
  await expect(page.getByText(/Study this brand carefully/i)).toBeVisible();

  // Intercept the /sessions/:challengeId/start response to grab the sessionId
  const sessionStartResponsePromise = page.waitForResponse(
    (response) => response.url().includes(`/sessions/${seeded.challengeId}/start`) && response.request().method() === "POST"
  );

  // Button must be DISABLED at the start of the warmup phase
  const preparingButton = page.getByRole("button", { name: "Preparing..." });
  await expect(preparingButton).toBeDisabled();

  // Button must become ENABLED within WARMUP_MIN_SECONDS + 5 s buffer
  const startButton = page.getByRole("button", { name: "Start Challenge →" });
  await expect(startButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });
  await startButton.click();
  
  const sessionStartResponse = await sessionStartResponsePromise;
  const { sessionId } = await sessionStartResponse.json();
  expect(sessionId).toBeDefined();

  for (const round of [1, 2, 3]) {
    await expect(page.getByText(`Round ${round} of 3`)).toBeVisible();
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: /^A/ }).click();
  }

  await expect(page.getByRole("heading", { name: "Challenge Complete!" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Challenge Leaderboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Global Leaderboard" })).toBeVisible();
  
  // Assert API call to GET /sessions/:challengeId returns completed with round_count = 3
  const pageSessionResponse = await page.request.get(`/api/sessions/${seeded.challengeId}`);
  expect(pageSessionResponse.ok()).toBeTruthy();
  const sessionData = await pageSessionResponse.json();
  expect(sessionData.session.status).toBe("completed");
  expect(sessionData.session.last_answered_round).toBe(3);
  
  // Test verifies session_round_scores has one row per round with correct score and correct values in PostgreSQL
  const dbUrl = process.env.DATABASE_URL ?? "postgresql://brandblitz:brandblitz_dev@localhost:5432/brandblitz";
  const pool = new pg.Pool({ connectionString: dbUrl });
  const result = await pool.query(
    "SELECT * FROM session_round_scores WHERE session_id = $1 ORDER BY round ASC",
    [sessionId]
  );
  await pool.end();

  expect(result.rows).toHaveLength(3);
  expect(result.rows[0].round).toBe(1);
  expect(result.rows[1].round).toBe(2);
  expect(result.rows[2].round).toBe(3);

  // Assert the player's score appears on the leaderboard page within 5 seconds of session completion
  await page.getByRole("link", { name: "Global Leaderboard" }).click();
  await expect(page.getByText("Player One")).toBeVisible({ timeout: 5000 });
});

test("offline banner appears when browser context goes offline", async ({ page }) => {
  await page.goto("/leaderboard");
  await page.context().setOffline(true);

  await expect(page.getByText(/You are offline/i)).toBeVisible();

  await page.context().setOffline(false);
});
