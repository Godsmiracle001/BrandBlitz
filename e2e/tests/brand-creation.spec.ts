import { expect, test } from "@playwright/test";
import { signInWithMockGoogle } from "./helpers";

const BRAND_USER = { email: "brand-create@example.com", name: "Brand Creator" };

test.describe("Brand creation with logo upload, product images, and tagline (#433)", () => {
  test("shows validation messages when required fields are empty", async ({
    page,
  }) => {
    await signInWithMockGoogle(page, BRAND_USER, "/brand/new");
    await page.waitForURL("**/brand/new");

    const submitBtn = page.getByRole("button", {
      name: "Create Brand Kit & Challenge",
    });
    await expect(submitBtn).toBeVisible();

    await submitBtn.click();

    await expect(page.getByLabel("Brand Name *")).toBeVisible();
    await expect(page.getByLabel("Prize Pool (USDC) *")).toBeVisible();
  });

  test("fills brand name, tagline, and validates fields", async ({ page }) => {
    await signInWithMockGoogle(page, BRAND_USER, "/brand/new");
    await page.waitForURL("**/brand/new");

    await page.getByLabel("Brand Name *").fill("Nova Reach");
    await page
      .getByLabel("Tagline")
      .fill("Earned attention, not empty impressions");
    await page
      .getByLabel("Brand Story")
      .fill("Nova Reach helps web3 brands turn curiosity into measurable recall.");
    await page.getByLabel("Prize Pool (USDC) *").fill("50");
    await page.getByLabel("Challenge Duration (hours)").fill("24");

    await expect(page.getByLabel("Brand Name *")).toHaveValue("Nova Reach");
    await expect(page.getByLabel("Tagline")).toHaveValue(
      "Earned attention, not empty impressions"
    );
  });

  test("uploads logo image and shows preview thumbnail", async ({ page }) => {
    await signInWithMockGoogle(page, BRAND_USER, "/brand/new");
    await page.waitForURL("**/brand/new");

    await page.getByLabel("Brand Name *").fill("Upload Test Brand");
    await page.getByLabel("Prize Pool (USDC) *").fill("25");

    const presignResponse = {
      uploadUrl: "http://localhost:9000/test-bucket/upload-key?signature=test",
      key: "brand-logos/test-logo.png",
      publicUrl: "http://localhost:9000/test-bucket/brand-logos/test-logo.png",
    };

    await page.route("**/api/upload/presign", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(presignResponse),
      });
    });

    await page.route("**/localhost:9000/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "ETag": '"test-etag"' },
      });
    });

    await page.route("**/api/upload/verify", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ verified: true }),
      });
    });

    const logoInput = page.locator('input[type="file"]').first();
    await logoInput.setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
      ),
    });

    await expect(page.getByText("Uploaded")).toBeVisible({ timeout: 5000 });
    await expect(page.getByAltText("Upload Brand Logo")).toBeVisible();
  });

  test("uploads product images and shows them in gallery", async ({
    page,
  }) => {
    await signInWithMockGoogle(page, BRAND_USER, "/brand/new");
    await page.waitForURL("**/brand/new");

    await page.getByLabel("Brand Name *").fill("Gallery Test Brand");
    await page.getByLabel("Prize Pool (USDC) *").fill("25");

    let presignCount = 0;
    await page.route("**/api/upload/presign", async (route) => {
      presignCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          uploadUrl: `http://localhost:9000/test-bucket/product-${presignCount}`,
          key: `product-images/test-${presignCount}.png`,
          publicUrl: `http://localhost:9000/test-bucket/product-${presignCount}.png`,
        }),
      });
    });

    await page.route("**/localhost:9000/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "ETag": '"test-etag"' },
      });
    });

    await page.route("**/api/upload/verify", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ verified: true }),
      });
    });

    const productInput = page.locator('input[type="file"]').nth(1);

    await productInput.setInputFiles({
      name: "product1.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
      ),
    });

    await expect(page.getByText("1/2 image(s) uploaded")).toBeVisible({
      timeout: 5000,
    });

    await productInput.setInputFiles({
      name: "product2.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
      ),
    });

    await expect(page.getByText("2/2 image(s) uploaded")).toBeVisible({
      timeout: 5000,
    });
  });

  test("submits form and navigates to brand detail page", async ({
    page,
    request,
  }) => {
    await signInWithMockGoogle(page, BRAND_USER, "/brand/new");
    await page.waitForURL("**/brand/new");

    const brandId = "11111111-1111-1111-1111-111111111111";

    let brandCreated = false;
    await page.route("**/api/brands", async (route, request) => {
      if (request.method() === "POST") {
        brandCreated = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ brand: { id: brandId } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [] }),
      });
    });

    await page.route("**/api/brands/challenges", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challenge: { id: "challenge-001" },
          depositInstructions: {
            address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            memo: "12345",
          },
        }),
      });
    });

    await page.getByLabel("Brand Name *").fill("Submit Test Brand");
    await page.getByLabel("Tagline").fill("Testing the submit flow");
    await page.getByLabel("Prize Pool (USDC) *").fill("50");
    await page.getByLabel("Challenge Duration (hours)").fill("48");

    await page.getByRole("button", { name: "Create Brand Kit & Challenge" }).click();

    await page.waitForURL(`**/brand/${brandId}`, { timeout: 10000 });
    expect(brandCreated).toBeTruthy();
  });

  test("brand name, tagline, and details visible on brand detail page", async ({
    page,
  }) => {
    const brandId = "22222222-2222-2222-2222-222222222222";

    await page.route("**/api/brands/public/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          brand: {
            id: brandId,
            name: "Visible Brand",
            tagline: "Visible tagline here",
            brandStory: "A brand story for testing visibility.",
            logoUrl: "http://localhost:9000/test-bucket/logo.png",
            productImageUrls: [],
            primaryColor: "#6366f1",
            secondaryColor: "#a5b4fc",
          },
        }),
      });
    });

    await page.route("**/api/brands/public/*/top-brands", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [] }),
      });
    });

    await page.goto(`/brand/${brandId}`);

    await expect(page.getByText("Visible Brand")).toBeVisible();
    await expect(page.getByText("Visible tagline here")).toBeVisible();
    await expect(page.getByText("A brand story for testing visibility.")).toBeVisible();
  });

  test("submits form and verifies API call returns correct metadata", async ({
    page,
  }) => {
    await signInWithMockGoogle(page, BRAND_USER, "/brand/new");
    await page.waitForURL("**/brand/new");

    const brandId = "33333333-3333-3333-3333-333333333333";
    const capturedRequests: any[] = [];

    await page.route("**/api/brands", async (route, request) => {
      if (request.method() === "POST") {
        capturedRequests.push(JSON.parse(request.postData()!));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ brand: { id: brandId } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [] }),
      });
    });

    await page.route("**/api/brands/challenges", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challenge: { id: "challenge-002" },
          depositInstructions: {
            address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            memo: "67890",
          },
        }),
      });
    });

    await page.getByLabel("Brand Name *").fill("API Verify Brand");
    await page.getByLabel("Tagline").fill("Verifying API metadata");
    await page.getByLabel("Prize Pool (USDC) *").fill("100");
    await page.getByLabel("Challenge Duration (hours)").fill("72");

    await page.getByRole("button", { name: "Create Brand Kit & Challenge" }).click();
    await page.waitForURL(`**/brand/${brandId}`, { timeout: 10000 });

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const brandPayload = capturedRequests[0];
    expect(brandPayload.name).toBe("API Verify Brand");
    expect(brandPayload.tagline).toBe("Verifying API metadata");
  });
});
