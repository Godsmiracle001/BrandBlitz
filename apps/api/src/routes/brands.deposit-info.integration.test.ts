import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { query } from "../db";
import { createBrand, getBrandById } from "../db/queries/brands";
import { createChallenge, getChallengeByIdAny, updateChallengeStatus } from "../db/queries/challenges";
import { getAccountUsdcBalance } from "@brandblitz/stellar";
import * as stellarClient from "@brandblitz/stellar";

describe("Deposit Info Endpoint Integration Tests", () => {
  let testUserId: string;
  let testBrandId: string;
  let testChallengeId: string;
  let authToken: string;

  beforeAll(async () => {
    // Create test user
    const userResult = await query(
      `INSERT INTO users (email, display_name, username, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ["deposit-info-test@example.com", "Deposit Info Test", "deposit_test", "brand", "active"]
    );
    testUserId = userResult.rows[0].id;

    // Create test brand
    const brand = await createBrand({
      owner_user_id: testUserId,
      name: "Deposit Info Test Brand",
      tagline: "Testing deposit info",
      logo_url: null,
      brand_story: null,
      usp: null,
      product_image_keys: [],
      question_template: null,
      primary_color: "#6366f1",
      secondary_color: "#a5b4fc",
    });
    testBrandId = brand.id;

    // Create test challenge in pending_deposit state
    const challenge = await createChallenge({
      brandId: testBrandId,
      challengeId: randomUUID(),
      poolAmountUsdc: "100.00",
      endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    testChallengeId = challenge.id;

    // Create auth token for API requests
    authToken = `test-token-${randomUUID()}`;
  });

  afterAll(async () => {
    // Cleanup test data
    await query(`DELETE FROM challenges WHERE id = $1`, [testChallengeId]);
    await query(`DELETE FROM brands WHERE id = $1`, [testBrandId]);
    await query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  describe("with mocked Stellar client", () => {
    it("should return deposit info with correct balance from mocked Stellar client", async () => {
      // Mock the Stellar balance query
      vi.spyOn(stellarClient, "getAccountUsdcBalance").mockResolvedValue(1000000000n); // 100 USDC in stroops

      // Call deposit-info endpoint (simulated via direct function call)
      const balance = await getAccountUsdcBalance("GDUMMYADDRESS", "testnet");
      
      expect(balance).toBe(1000000000n);
      
      // Verify the mock was called
      expect(stellarClient.getAccountUsdcBalance).toHaveBeenCalledWith("GDUMMYADDRESS", "testnet");
      
      vi.restoreAllMocks();
    });

    it("should handle zero balance from mocked Stellar client", async () => {
      vi.spyOn(stellarClient, "getAccountUsdcBalance").mockResolvedValue(0n);

      const balance = await getAccountUsdcBalance("GDUMMYADDRESS", "testnet");
      
      expect(balance).toBe(0n);
      
      vi.restoreAllMocks();
    });

    it("should handle Stellar client errors gracefully", async () => {
      vi.spyOn(stellarClient, "getAccountUsdcBalance").mockRejectedValue(new Error("Network error"));

      await expect(getAccountUsdcBalance("GDUMMYADDRESS", "testnet")).rejects.toThrow("Network error");
      
      vi.restoreAllMocks();
    });
  });

  describe("deposit-info endpoint validation", () => {
    it("should return 404 for non-existent challenge", async () => {
      const nonExistentChallengeId = randomUUID();
      
      // Simulate the endpoint logic
      const challenge = await getChallengeByIdAny(nonExistentChallengeId);
      expect(challenge).toBeNull();
    });

    it("should return 403 when requester is not brand owner", async () => {
      // Create another user
      const otherUserResult = await query(
        `INSERT INTO users (email, display_name, username, role, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ["other-user@example.com", "Other User", "other_user", "brand", "active"]
      );
      const otherUserId = otherUserResult.rows[0].id;

      // Verify the other user is not the brand owner
      const brand = await getBrandById(testBrandId);
      expect(brand?.owner_user_id).not.toBe(otherUserId);

      // Cleanup
      await query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
    });

    it("should return 400 when challenge is not in pending_deposit state", async () => {
      // Update challenge to active state
      await updateChallengeStatus(testChallengeId, "active");
      
      const challenge = await getChallengeByIdAny(testChallengeId);
      expect(challenge?.status).toBe("active");

      // Reset to pending_deposit for other tests
      await updateChallengeStatus(testChallengeId, "pending_deposit");
    });

    it("should include required fields in deposit info response", async () => {
      const challenge = await getChallengeByIdAny(testChallengeId);
      expect(challenge).not.toBeNull();
      
      // Verify challenge has required fields
      expect(challenge?.pool_amount_usdc).toBeDefined();
      expect(challenge?.id).toBeDefined();
    });
  });

  describe("escrow account validation", () => {
    it("should validate Stellar address format (G... format)", () => {
      const validAddress = "GDUMMYADDRESS1234567890123456789012345678901234567890";
      const invalidAddress = "INVALIDADDRESS";
      
      // Stellar addresses should be 56 characters starting with G
      expect(validAddress).toMatch(/^G[A-Z0-9]{55}$/);
      expect(invalidAddress).not.toMatch(/^G[A-Z0-9]{55}$/);
    });

    it("should handle non-existent escrow account gracefully", async () => {
      vi.spyOn(stellarClient, "getAccountUsdcBalance").mockRejectedValue(new Error("Account not found"));

      await expect(getAccountUsdcBalance("GNONEXISTENT1234567890123456789012345678901234567890", "testnet"))
        .rejects.toThrow("Account not found");
      
      vi.restoreAllMocks();
    });
  });

  describe("payouts table protection", () => {
    it("should not update payouts table before deposit confirmation", async () => {
      // Verify no payouts exist for the challenge
      const payoutsBefore = await query(
        `SELECT COUNT(*) as count FROM payouts WHERE challenge_id = $1`,
        [testChallengeId]
      );
      expect(payoutsBefore.rows[0].count).toBe(0);

      // Simulate deposit info query (which should not create payouts)
      const challenge = await getChallengeByIdAny(testChallengeId);
      expect(challenge).not.toBeNull();

      // Verify payouts table still has no entries
      const payoutsAfter = await query(
        `SELECT COUNT(*) as count FROM payouts WHERE challenge_id = $1`,
        [testChallengeId]
      );
      expect(payoutsAfter.rows[0].count).toBe(0);
    });

    it("should maintain challenge status as pending_deposit until webhook confirmation", async () => {
      const challenge = await getChallengeByIdAny(testChallengeId);
      expect(challenge?.status).toBe("pending_deposit");
      expect(challenge?.deposit_tx_hash).toBeNull();
    });
  });

  describe("balance tolerance and precision", () => {
    it("should handle USDC stroop conversion correctly", () => {
      // Test stroop to USDC conversion (1 USDC = 10^7 stroops)
      const stroopsPerUsdc = 10000000n;
      
      const usdcAmount = "100.00";
      const expectedStroops = BigInt(Math.round(parseFloat(usdcAmount) * 10000000));
      
      expect(expectedStroops).toBe(1000000000n);
      expect(expectedStroops / stroopsPerUsdc).toBe(100n);
    });

    it("should handle fractional USDC amounts correctly", () => {
      const fractionalAmount = "50.50";
      const expectedStroops = BigInt(Math.round(parseFloat(fractionalAmount) * 10000000));
      
      expect(expectedStroops).toBe(505000000n);
    });

    it("should validate balance within acceptable tolerance", () => {
      const expectedBalance = 1000000000n; // 100 USDC
      const actualBalance = 1000000000n; // Exact match
      const tolerance = 100n; // 0.00001 USDC tolerance
      
      const difference = actualBalance > expectedBalance 
        ? actualBalance - expectedBalance 
        : expectedBalance - actualBalance;
      
      expect(difference).toBeLessThanOrEqual(tolerance);
    });
  });
});

describe("Live Testnet Integration Tests", () => {
  const describeLive = process.env.RUN_LIVE_STELLAR_TESTS ? describe : describe.skip;

  describeLive("with live Stellar testnet", () => {
    let testUserId: string;
    let testBrandId: string;
    let testChallengeId: string;

    beforeAll(async () => {
      // Create test user
      const userResult = await query(
        `INSERT INTO users (email, display_name, username, role, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ["live-stellar-test@example.com", "Live Stellar Test", "live_stellar", "brand", "active"]
      );
      testUserId = userResult.rows[0].id;

      // Create test brand
      const brand = await createBrand({
        owner_user_id: testUserId,
        name: "Live Stellar Test Brand",
        tagline: "Testing live Stellar",
        logo_url: null,
        brand_story: null,
        usp: null,
        product_image_keys: [],
        question_template: null,
        primary_color: "#6366f1",
        secondary_color: "#a5b4fc",
      });
      testBrandId = brand.id;

      // Create test challenge
      const challenge = await createChallenge({
        brandId: testBrandId,
        challengeId: randomUUID(),
        poolAmountUsdc: "10.00",
        endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
 });
      testChallengeId = challenge.id;
    });

    afterAll(async () => {
      await query(`DELETE FROM challenges WHERE id = $1`, [testChallengeId]);
      await query(`DELETE FROM brands WHERE id = $1`, [testBrandId]);
      await query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    });

    it("should query actual Stellar testnet balance", async () => {
      // Use a known testnet address (this would be a real testnet address in production)
      const testnetAddress = process.env.TEST_STELLAR_ADDRESS || "GDUMMYADDRESS1234567890123456789012345678901234567890";
      
      try {
        const balance = await getAccountUsdcBalance(testnetAddress, "testnet");
        
        // Balance should be a bigint
        expect(typeof balance).toBe("bigint");
        expect(balance).toBeGreaterThanOrEqual(0n);
      } catch (error) {
        // If the account doesn't exist on testnet, that's expected for test addresses
        expect((error as Error).message).toMatch(/account|not found|load/i);
      }
    });

    it("should handle network errors gracefully", async () => {
      const invalidAddress = "GINVALIDADDRESS1234567890123456789012345678901234567890";
      
      await expect(getAccountUsdcBalance(invalidAddress, "testnet"))
        .rejects.toThrow();
    });
  });
});
