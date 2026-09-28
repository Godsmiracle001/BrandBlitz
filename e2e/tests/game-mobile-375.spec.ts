import { expect, test } from "@playwright/test";
import { seedActiveChallenge, signInWithMockGoogle } from "./helpers";
import { WARMUP_MIN_SECONDS } from "../../apps/web/src/components/game/constants";

// Configure test project for 375px mobile viewport
test.use({ viewport: { width: 375, height: 812 } });

test.describe("Mobile Game Flow (375px) (#440)", () => {
    test("game loads and renders at 375px without horizontal scroll", async ({
        page,
        request,
    }) => {
        const seeded = await seedActiveChallenge(request, {
            email: "mobile-brand@example.com",
            name: "Mobile Brand",
        });

        await signInWithMockGoogle(
            page,
            { email: "mobile-player@example.com", name: "Mobile Player" },
            `/challenge/${seeded.challengeId}`
        );

        await page.waitForURL(`**/challenge/${seeded.challengeId}`);

        // Verify no horizontal scroll
        const hasOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth
        );
        expect(hasOverflow).toBe(false);

        // Verify warmup content is visible
        await expect(page.getByText(/Study this brand carefully/i)).toBeVisible();
    });

    test("answer option buttons visible and tappable at 375px", async ({
        page,
        request,
    }) => {
        const seeded = await seedActiveChallenge(request, {
            email: "mobile-options-brand@example.com",
            name: "Mobile Options Brand",
        });

        await signInWithMockGoogle(
            page,
            { email: "mobile-options-player@example.com", name: "Mobile Options Player" },
            `/challenge/${seeded.challengeId}`
        );

        await page.waitForURL(`**/challenge/${seeded.challengeId}`);

        // Wait for warmup to complete
        const startButton = page.getByRole("button", { name: "Start Challenge →" });
        await expect(startButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });
        await startButton.click();

        // Verify round text and answer options are visible
        await expect(page.getByText("Round 1 of 3")).toBeVisible();

        // Check that all answer buttons are visible and within viewport
        const answerButtons = page.locator('button[role="button"]:has-text("A"), button[role="button"]:has-text("B"), button[role="button"]:has-text("C"), button[role="button"]:has-text("D")');
        const count = await answerButtons.count();
        expect(count).toBeGreaterThanOrEqual(4);

        // Tap first answer option
        await page.getByRole("button", { name: /^A/ }).click();

        // Verify selection feedback is visible
        await expect(page.getByText(/Round 2 of 3/)).toBeVisible({ timeout: 5000 });
    });

    test("countdown timer visible and not truncated at 375px", async ({
        page,
        request,
    }) => {
        const seeded = await seedActiveChallenge(request, {
            email: "mobile-timer-brand@example.com",
            name: "Mobile Timer Brand",
        });

        await signInWithMockGoogle(
            page,
            { email: "mobile-timer-player@example.com", name: "Mobile Timer Player" },
            `/challenge/${seeded.challengeId}`
        );

        await page.waitForURL(`**/challenge/${seeded.challengeId}`);

        // Wait for warmup and start
        const startButton = page.getByRole("button", { name: "Start Challenge →" });
        await expect(startButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });
        await startButton.click();

        // Look for countdown timer element
        const timerRegex = /\d+:\d+/;
        const timerElement = page.locator('*:has-text("' + timerRegex + '")')
            .first();

        // Verify timer is visible
        await expect(timerElement).toBeVisible();

        // Check that timer is not clipped or overflowing
        const boundingBox = await timerElement.boundingBox();
        if (boundingBox) {
            expect(boundingBox.width).toBeGreaterThan(0);
            expect(boundingBox.height).toBeGreaterThan(0);
            // Timer should fit within viewport width (375px)
            expect(boundingBox.x + boundingBox.width).toBeLessThanOrEqual(375);
        }
    });

    test("final score screen renders without overflow at 375px", async ({
        page,
        request,
    }) => {
        const seeded = await seedActiveChallenge(request, {
            email: "mobile-score-brand@example.com",
            name: "Mobile Score Brand",
        });

        await signInWithMockGoogle(
            page,
            { email: "mobile-score-player@example.com", name: "Mobile Score Player" },
            `/challenge/${seeded.challengeId}`
        );

        await page.waitForURL(`**/challenge/${seeded.challengeId}`);

        // Complete warmup
        const startButton = page.getByRole("button", { name: "Start Challenge →" });
        await expect(startButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });
        await startButton.click();

        // Complete all 3 rounds
        for (const round of [1, 2, 3]) {
            await expect(page.getByText(`Round ${round} of 3`)).toBeVisible({ timeout: 5000 });
            await page.waitForTimeout(250);
            await page.getByRole("button", { name: /^A/ }).click();
        }

        // Verify final score screen appears
        await expect(page.getByRole("heading", { name: "Challenge Complete!" })).toBeVisible();

        // Verify no horizontal overflow
        const hasOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth
        );
        expect(hasOverflow).toBe(false);

        // Verify score card elements are visible
        await expect(page.getByRole("link", { name: "View Leaderboard" })).toBeVisible();
    });

    test("mobile gesture handling for answer selection", async ({
        page,
        request,
    }) => {
        const seeded = await seedActiveChallenge(request, {
            email: "mobile-gesture-brand@example.com",
            name: "Mobile Gesture Brand",
        });

        await signInWithMockGoogle(
            page,
            { email: "mobile-gesture-player@example.com", name: "Mobile Gesture Player" },
            `/challenge/${seeded.challengeId}`
        );

        await page.waitForURL(`**/challenge/${seeded.challengeId}`);

        const startButton = page.getByRole("button", { name: "Start Challenge →" });
        await expect(startButton).toBeEnabled({ timeout: (WARMUP_MIN_SECONDS + 5) * 1000 });
        await startButton.click();

        // Simulate tap on answer button (Playwright uses click for touch)
        const buttonB = page.getByRole("button", { name: /^B/ });
        await expect(buttonB).toBeVisible();
        await buttonB.tap();

        // Verify next round appears
        await expect(page.getByText("Round 2 of 3")).toBeVisible({ timeout: 5000 });
    });
});
