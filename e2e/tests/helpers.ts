import { expect, type APIRequestContext, type Page } from "@playwright/test";

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://localhost/api";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "your-webhook-secret";

interface MockUser {
  email: string;
  name: string;
}

interface BrandChallengeSeed {
  challengeId: string;
  memo: string;
  brandId: string;
}

export async function signInWithMockGoogle(
  page: Page,
  user: MockUser,
  callbackPath: string
): Promise<void> {
  const params = new URLSearchParams({
    callbackUrl: callbackPath,
    mockEmail: user.email,
    mockName: user.name,
  });

  await page.goto(`/login?${params.toString()}`);
  await page.getByRole("button", { name: /continue with google/i }).click();
}

export async function createApiToken(
  request: APIRequestContext,
  user: MockUser
): Promise<string> {
  const response = await request.post(`${API_BASE_URL}/auth/google/callback`, {
    data: {
      idToken: `e2e:${user.email}:${user.name}`,
    },
  });

  expect(response.ok()).toBeTruthy();

  const payload = (await response.json()) as { token: string };
  return payload.token;
}

export async function seedActiveChallenge(
  request: APIRequestContext,
  owner: MockUser
): Promise<BrandChallengeSeed> {
  const token = await createApiToken(request, owner);

  const brandResponse = await request.post(`${API_BASE_URL}/brands`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      name: "Orbit Pay",
      tagline: "Move money at quiz speed",
      brandStory: "Orbit Pay helps creators send stablecoin payouts instantly across borders.",
      usp: "Global USDC payouts with instant settlement",
      primaryColor: "#0f766e",
      secondaryColor: "#99f6e4",
    },
  });

  expect(brandResponse.ok()).toBeTruthy();
  const brandPayload = (await brandResponse.json()) as { brand: { id: string } };

  const challengeResponse = await request.post(`${API_BASE_URL}/brands/challenges`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: {
      brandId: brandPayload.brand.id,
      poolAmountUsdc: "25.00",
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });

  expect(challengeResponse.ok()).toBeTruthy();

  const challengePayload = (await challengeResponse.json()) as {
    challenge: { id: string };
    depositInstructions: { memo: string };
  };

  const webhookResponse = await request.post(`${API_BASE_URL}/webhooks/stellar/deposit`, {
    headers: {
      "X-Webhook-Secret": WEBHOOK_SECRET,
    },
    data: {
      memo: challengePayload.depositInstructions.memo,
      txHash: `e2e-tx-${Date.now()}`,
      amount: "25.00",
    },
  });

  expect(webhookResponse.ok()).toBeTruthy();

  return {
    challengeId: challengePayload.challenge.id,
    memo: challengePayload.depositInstructions.memo,
    brandId: brandPayload.brand.id,
  };
}

export async function seedFraudFlag(
  request: APIRequestContext,
  sessionId: string,
  userId: string,
  flagType: string = "reaction_time_anomaly"
): Promise<string> {
  const dbUrl = process.env.DATABASE_URL ?? "postgresql://brandblitz:brandblitz_dev@localhost:5432/brandblitz";
  const response = await request.post(`${API_BASE_URL}/admin/test/seed-fraud-flag`, {
    data: { sessionId, userId, flagType },
  });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { flagId: string };
  return payload.flagId;
}

export async function makeUserAdmin(
  request: APIRequestContext,
  userId: string
): Promise<void> {
  const response = await request.post(`${API_BASE_URL}/admin/test/promote-to-admin`, {
    data: { userId },
  });
  expect(response.ok()).toBeTruthy();
}

export async function getFraudFlagsFromDb(
  request: APIRequestContext,
  status?: string
): Promise<Array<any>> {
  const params = new URLSearchParams();
  if (status) params.append("status", status);

  const response = await request.get(
    `${API_BASE_URL}/admin/test/fraud-flags?${params.toString()}`
  );
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { flags: Array<any> };
  return payload.flags;
}
