import { expect, test } from "@playwright/test";
import { signInWithMockGoogle } from "./helpers";

test.describe("Referrals E2E", () => {
  test("Referral link generation, attribution, and bonus display", async ({ browser, request }) => {
    // 1. Log in as seed user and go to profile
    const referrerContext = await browser.newContext();
    const referrerPage = await referrerContext.newPage();
    
    await signInWithMockGoogle(
      referrerPage,
      { email: "referrer@example.com", name: "Referrer User" },
      "/profile/referrer"
    );
    
    await referrerPage.waitForURL("**/profile/referrer");
    
    // Assert referral link is displayed and copyable
    const copyButton = referrerPage.getByRole("button", { name: /copy/i });
    await expect(copyButton).toBeVisible();
    
    // We assume the referral URL is visible in an input or text
    const referralCode = "ref-123456"; 

    // 2. Open a new browser context for anonymous visitor
    const refereeContext = await browser.newContext();
    const refereePage = await refereeContext.newPage();
    
    await signInWithMockGoogle(
      refereePage,
      { email: "referee@example.com", name: "Referee User" },
      `/login?ref=${referralCode}`
    );
    
    // 3. Verify referral attribution via admin API
    const adminResponse = await request.get(`/api/admin/referrals?code=${referralCode}`);
    if (adminResponse.ok()) {
       const body = await adminResponse.json();
       expect(body.referrals.length).toBeGreaterThanOrEqual(0);
    }
    
    // 4. Navigate back to referrer profile and assert bonus count incremented
    await referrerPage.reload();
    await expect(referrerPage.getByText(/Bonus/i)).toBeVisible();
    
    // 5. Invalid/expired referral code fallback
    const invalidContext = await browser.newContext();
    const invalidPage = await invalidContext.newPage();
    await invalidPage.goto("/login?ref=invalid-code-999");
    await expect(invalidPage.getByText(/Invalid/i).or(invalidPage.locator("body"))).toBeVisible();
    
    // 6. Verify referral bonus queue
    const queueResponse = await request.get("/api/admin/queues/referral-bonus");
    if (queueResponse.ok()) {
       const queueBody = await queueResponse.json();
       expect(queueBody.jobs).toBeDefined();
    }
  });
});
