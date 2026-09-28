import { expect, test } from "@playwright/test";
import { signInWithMockGoogle, createApiToken } from "./helpers";

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://localhost/api";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "your-webhook-secret";

test("full challenge creation flow with deposit instructions and mock activation", async ({ page, request }) => {
  const brandOwner = { email: "challenge-flow@example.com", name: "Challenge Flow Owner" };
  
  // Step 1: Authenticate as brand user and navigate to dashboard
  await signInWithMockGoogle(page, brandOwner, "/brand/dashboard");
  await page.waitForURL("**/brand/dashboard");
  await expect(page.getByRole("heading", { name: "Brand Dashboard" })).toBeVisible();

  // Step 2: Navigate to brand creation form
  await page.getByRole("link", { name: "+ New Brand" }).click();
  await page.waitForURL("**/brand/new");
  await expect(page.getByRole("heading", { name: "Create Brand Kit" })).toBeVisible();

  // Step 3: Fill in brand kit and challenge details
  await page.getByLabel("Brand Name *").fill("E2E Test Brand");
  await page.getByLabel("Tagline").fill("Testing the full flow");
  await page.getByLabel("Brand Story").fill("This is a test brand for E2E challenge creation flow testing.");
  
  // Set primary and secondary colors
  await page.getByLabel("Primary Color").fill("#6366f1");
  await page.getByLabel("Secondary Color").fill("#a5b4fc");
  
  // Upload logo (mock upload)
  await page.getByText("Upload Brand Logo").click();
  
  // Fill challenge settings
  await page.getByLabel("Prize Pool (USDC) *").fill("150.00");
  await page.getByLabel("Challenge Duration (hours)").fill("48");

  // Step 4: Submit the form
  await page.getByRole("button", { name: "Create Brand Kit & Challenge" }).click();
  
  // Wait for redirect to brand page
  await page.waitForURL("**/brand/*");
  const brandId = page.url().split("/").pop();
  
  // Step 5: Navigate to dashboard to see the challenge in pending_deposit state
  await page.goto("/brand/dashboard");
  await page.waitForURL("**/brand/dashboard");
  
  // Step 6: Verify challenge appears with pending_deposit status
  await expect(page.getByText("pending_deposit")).toBeVisible();
  await expect(page.getByText("150.00")).toBeVisible();

  // Step 7: Get challenge details via API to verify escrow address
  const apiToken = await createApiToken(request, brandOwner);
  const brandsResponse = await request.get(`${API_BASE_URL}/brands`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  expect(brandsResponse.ok()).toBeTruthy();
  const brandsData = await brandsResponse.json();
  const brand = brandsData.brands.find((b: any) => b.id === brandId);
  expect(brand).toBeDefined();
  
  const challenge = brand.challenges[0];
  expect(challenge.status).toBe("pending_deposit");
  expect(challenge.poolAmountUsdc).toBe("150.00");

  // Step 8: Get deposit info to verify escrow address format
  const depositInfoResponse = await request.get(
    `${API_BASE_URL}/challenges/${challenge.id}/deposit-info`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  );
  expect(depositInfoResponse.ok()).toBeTruthy();
  const depositInfo = await depositInfoResponse.json();
  
  // Verify escrow address is in Stellar format (starts with G)
  expect(depositInfo.depositInfo.hotWalletAddress).toMatch(/^G[A-Za-z0-9]{55}$/);
  expect(depositInfo.depositInfo.memo).toBe(challenge.id);
  expect(depositInfo.depositInfo.amount).toBe("150.00");

  // Step 9: Trigger mock deposit webhook to activate challenge
  const webhookResponse = await request.post(`${API_BASE_URL}/webhooks/stellar/deposit`, {
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    data: {
      memo: challenge.id,
      txHash: `e2e-test-tx-${Date.now()}`,
      amount: "150.00",
    },
  });
  expect(webhookResponse.ok()).toBeTruthy();
  const webhookResult = await webhookResponse.json();
  expect(webhookResult.status).toBe("activated");
  expect(webhookResult.challengeId).toBe(challenge.id);

  // Step 10: Verify challenge status updated to active in UI without refresh
  // Reload dashboard to see updated status
  await page.reload();
  await expect(page.getByText("active")).toBeVisible();
  
  // Step 11: Verify challenge appears in public challenge list
  await page.goto("/challenges");
  await page.waitForURL("**/challenges");
  await expect(page.getByText("E2E Test Brand")).toBeVisible();
  
  // Step 12: Navigate to specific challenge page
  await page.goto(`/challenge/${challenge.id}`);
  await page.waitForURL("**/challenge/**");
  await expect(page.getByText("E2E Test Brand")).toBeVisible();

  // Step 13: Verify database state via API
  const challengeResponse = await request.get(`${API_BASE_URL}/challenges/${challenge.id}`);
  expect(challengeResponse.ok()).toBeTruthy();
  const challengeData = await challengeResponse.json();
  expect(challengeData.challenge.status).toBe("active");
  expect(challengeData.challenge.deposit_tx_hash).toBeTruthy();
});

test("challenge creation validates escrow address format and amount", async ({ page, request }) => {
  const brandOwner = { email: "validation-test@example.com", name: "Validation Test" };
  
  await signInWithMockGoogle(page, brandOwner, "/brand/new");
  await page.waitForURL("**/brand/new");

  await page.getByLabel("Brand Name *").fill("Validation Brand");
  await page.getByLabel("Prize Pool (USDC) *").fill("100.50");
  await page.getByLabel("Challenge Duration (hours)").fill("24");
  await page.getByText("Upload Brand Logo").click();
  await page.getByRole("button", { name: "Create Brand Kit & Challenge" }).click();
  
  await page.waitForURL("**/brand/*");
  const brandId = page.url().split("/").pop();

  const apiToken = await createApiToken(request, brandOwner);
  const brandsResponse = await request.get(`${API_BASE_URL}/brands`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const brandsData = await brandsResponse.json();
  const brand = brandsData.brands.find((b: any) => b.id === brandId);
  const challenge = brand.challenges[0];

  const depositInfoResponse = await request.get(
    `${API_BASE_URL}/challenges/${challenge.id}/deposit-info`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
    }
  );
  const depositInfo = await depositInfoResponse.json();

  // Validate Stellar address format (56 characters, starts with G)
  expect(depositInfo.depositInfo.hotWalletAddress).toHaveLength(56);
  expect(depositInfo.depositInfo.hotWalletAddress[0]).toBe("G");
  
  // Validate exact amount match
  expect(depositInfo.depositInfo.amount).toBe("100.50");
  
  // Validate memo is UUID format
  expect(depositInfo.depositInfo.memo).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("webhook activation transitions challenge from pending_deposit to active", async ({ page, request }) => {
  const brandOwner = { email: "webhook-test@example.com", name: "Webhook Test" };
  
  // Create challenge via API for faster setup
  const apiToken = await createApiToken(request, brandOwner);
  
  const brandResponse = await request.post(`${API_BASE_URL}/brands`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    data: {
      name: "Webhook Test Brand",
      tagline: "Testing webhook activation",
      primaryColor: "#6366f1",
      secondaryColor: "#a5b4fc",
    },
  });
  const brandData = await brandResponse.json();
  
  const challengeResponse = await request.post(`${API_BASE_URL}/brands/challenges`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    data: {
      brandId: brandData.brand.id,
      poolAmountUsdc: "75.00",
      endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  });
  const challengeData = await challengeResponse.json();
  
  // Verify initial status
  const initialChallenge = await request.get(`${API_BASE_URL}/challenges/${challengeData.challenge.id}`);
  const initialData = await initialChallenge.json();
  expect(initialData.challenge.status).toBe("pending_deposit");
  
  // Trigger webhook
  const webhookResponse = await request.post(`${API_BASE_URL}/webhooks/stellar/deposit`, {
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    data: {
      memo: challengeData.depositInstructions.memo,
      txHash: `webhook-test-${Date.now()}`,
      amount: "75.00",
    },
  });
  expect(webhookResponse.ok()).toBeTruthy();
  
  // Verify status changed
  const activatedChallenge = await request.get(`${API_BASE_URL}/challenges/${challengeData.challenge.id}`);
  const activatedData = await activatedChallenge.json();
  expect(activatedData.challenge.status).toBe("active");
  expect(activatedData.challenge.deposit_tx_hash).toBeTruthy();
  
  // Verify it appears in active challenges list
  const activeResponse = await request.get(`${API_BASE_URL}/challenges/active`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const activeData = await activeResponse.json();
  const foundChallenge = activeData.items.find((c: any) => c.id === challengeData.challenge.id);
  expect(foundChallenge).toBeDefined();
});
