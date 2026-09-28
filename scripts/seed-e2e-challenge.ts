import { pool } from "../apps/api/src/db";
import { createBrand } from "../apps/api/src/db/queries/brands";
import { createChallenge, insertChallengeQuestions, updateChallengeStatus } from "../apps/api/src/db/queries/challenges";
import { upsertUser } from "../apps/api/src/db/queries/users";

async function seed() {
  console.log("🌱 Seeding E2E challenge...");

  try {
    // 1. Create a test user/owner
    const owner = await upsertUser({
      email: "e2e-owner@example.com",
      googleId: "e2e-owner-google-id",
      name: "E2E Owner",
    });

    // 2. Create a brand
    const brand = await createBrand({
      owner_user_id: owner.id,
      name: "E2E Test Brand",
      logo_url: "https://placehold.co/400x400?text=E2E+Logo",
      primary_color: "#6366f1",
      secondary_color: "#1e293b",
      tagline: "The best brand for testing",
      brand_story: "We were created specifically for Playwright tests.",
      usp: "100% test coverage",
      product_image_keys: ["test-product-1"],
    });

    // 3. Create a challenge
    const challenge = await createChallenge({
      brandId: brand.id,
      challengeId: `e2e-memo-${Date.now()}`,
      poolAmountUsdc: "100",
    });

    // 4. Add questions
    await insertChallengeQuestions([
      {
        challenge_id: challenge.id,
        round: 1,
        question_type: "which_brand",
        prompt_type: "logo",
        question_text: "Which brand is this?",
        option_a: "E2E Test Brand",
        option_b: "Generic Brand",
        option_c: "Other Brand",
        option_d: "Wrong Brand",
        correct_option: "A",
      },
      {
        challenge_id: challenge.id,
        round: 2,
        question_type: "which_tagline",
        prompt_type: "tagline",
        question_text: "What is our tagline?",
        option_a: "Not this one",
        option_b: "The best brand for testing",
        option_c: "Maybe this?",
        option_d: "No way",
        correct_option: "B",
      },
      {
        challenge_id: challenge.id,
        round: 3,
        question_type: "which_product",
        prompt_type: "productImage1",
        question_text: "What do we sell?",
        option_a: "Nothing",
        option_b: "Everything",
        option_c: "Something",
        option_d: "100% test coverage",
        correct_option: "D",
      },
    ]);

    // 5. Activate the challenge
    await updateChallengeStatus(challenge.id, "active");

    console.log(`✅ E2E challenge seeded: ${challenge.id}`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
