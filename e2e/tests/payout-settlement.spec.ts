import { expect, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle, createApiToken } from "./helpers";
import pg from "pg";

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://localhost/api";

test("completed game session triggers payout creation after settlement", async ({ page, request }) => {
  // ── 1. Seed a challenge and log in as a player ─────────────────────────────
  const seeded = await seedActiveChallenge(request, {
    email: "payout-brand@example.com",
    name: "Payout Brand",
  });

  const player = { email: "payout-player@example.com", name: "Payout Player" };
  await signInWithMockGoogle(page, player, `/challenge/${seeded.challengeId}`);
  await page.waitForURL(`**/challenge/${seeded.challengeId}`);

  // ── 2. Complete the warmup ─────────────────────────────────────────────────
  const startButton = page.getByRole("button", { name: "Start Challenge →" });
  await expect(startButton).toBeEnabled({ timeout: 30_000 });
  await startButton.click();

  // ── 3. Play all 3 rounds ───────────────────────────────────────────────────
  for (const round of [1, 2, 3]) {
    await expect(page.getByText(`Round ${round} of 3`)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: /^A/ }).click();
  }
  await expect(page.getByRole("heading", { name: "Challenge Complete!" })).toBeVisible({ timeout: 10_000 });

  // ── 4. Get the player's session ID and user ID via API ────────────────────
  const sessionResponse = await page.request.get(`/api/sessions/${seeded.challengeId}`);
  expect(sessionResponse.ok()).toBeTruthy();
  const sessionData = await sessionResponse.json();
  const sessionId = sessionData.session.id;
  const userId = sessionData.session.user_id;
  const totalScore = sessionData.session.total_score;
  expect(sessionData.session.status).toBe("completed");

  // ── 5. Promote the player to admin so we can call the test endpoint ───────
  //     (In e2e the settlement endpoint requires admin auth.)
  const dbUrl = process.env.DATABASE_URL ?? "postgresql://brandblitz:brandblitz_dev@localhost:5432/brandblitz";
  const pool = new pg.Pool({ connectionString: dbUrl });

  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);

  const adminToken = await createApiToken(request, player);
  await pool.end();

  // ── 6. Settle the challenge via the admin test endpoint ───────────────────
  //     The endpoint transitions the challenge to "ended" and calls processPayout.
  //     Payout rows are created before the Stellar attempt, so they persist
  //     even when the Stellar network is unavailable.
  const settleResponse = await request.post(`${API_BASE_URL}/admin/test/settle-challenge`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { challengeId: seeded.challengeId },
  });
  expect(settleResponse.ok()).toBeTruthy();
  const settleResult = await settleResponse.json();
  expect(settleResult.success).toBe(true);

  // ── 7. Verify payout rows were created in the database ────────────────────
  const checkPool = new pg.Pool({ connectionString: dbUrl });
  let payouts: any[] = [];
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const result = await checkPool.query(
      "SELECT * FROM payouts WHERE challenge_id = $1 AND user_id = $2 ORDER BY created_at ASC",
      [seeded.challengeId, userId]
    );
    if (result.rows.length > 0) {
      payouts = result.rows;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await checkPool.end();

  expect(payouts.length).toBeGreaterThan(0);
  const payout = payouts[0];

  expect(payout.challenge_id).toBe(seeded.challengeId);
  expect(payout.user_id).toBe(userId);
  expect(payout.status).toBe("pending");
  expect(Number(payout.amount_stroops)).toBeGreaterThan(0);

  // ── 8. Verify the challenge status transitioned through "ended" ──────────
  const challengeResponse = await request.get(`${API_BASE_URL}/challenges/${seeded.challengeId}`);
  expect(challengeResponse.ok()).toBeTruthy();
  const challengeData = await challengeResponse.json();

  // The challenge ends up either "settled" (if processPayout got far enough)
  // or still "ended" (if Stellar failure prevented the status update).
  expect(["ended", "settled", "payout_failed"]).toContain(challengeData.challenge.status);
});
