import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { query } from "../db";
import { createBrand } from "../db/queries/brands";
import { createChallenge, getChallengeByIdAny, updateChallengeStatus, insertChallengeQuestions } from "../db/queries/challenges";
import { createSession, getSession, recordRoundScore } from "../db/queries/sessions";

describe("Concurrent Session Answer Submissions Integration Tests", () => {
  let testUserId: string;
  let testBrandId: string;
  let testChallengeId: string;
  let sessionId: string;

  beforeAll(async () => {
    // Create test user
    const userResult = await query(
      `INSERT INTO users (email, display_name, username, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ["concurrent-test@example.com", "Concurrent Test", "concurrent_test", "player", "active"]
    );
    testUserId = userResult.rows[0].id;

    // Create test brand
    const brand = await createBrand({
      owner_user_id: testUserId,
      name: "Concurrent Test Brand",
      tagline: "Testing concurrent submissions",
      logo_url: null,
      brand_story: null,
      usp: null,
      product_image_keys: [],
      question_template: null,
      primary_color: "#6366f1",
      secondary_color: "#a5b4fc",
    });
    testBrandId = brand.id;

    // Create test challenge in active state
    const challenge = await createChallenge({
      brandId: testBrandId,
      challengeId: randomUUID(),
      poolAmountUsdc: "100.00",
      endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    testChallengeId = challenge.id;

    // Activate the challenge
    await updateChallengeStatus(testChallengeId, "active");

    // Insert test questions
    const questions = [
      {
        challenge_id: testChallengeId,
        round: 1 as const,
        question_type: "which_brand" as const,
        prompt_type: "logo" as const,
        question_text: "Which brand is this?",
        correct_answer: "Brand A",
        option_a: "Brand A",
        option_b: "Brand B",
        option_c: "Brand C",
        option_d: "Brand D",
        correct_option: "A" as const,
      },
      {
        challenge_id: testChallengeId,
        round: 2 as const,
        question_type: "which_tagline" as const,
        prompt_type: "tagline" as const,
        question_text: "Which tagline is this?",
        correct_answer: "Tagline X",
        option_a: "Tagline X",
        option_b: "Tagline Y",
        option_c: "Tagline Z",
        option_d: "Tagline W",
        correct_option: "A" as const,
      },
      {
        challenge_id: testChallengeId,
        round: 3 as const,
        question_type: "which_product" as const,
        prompt_type: "productImage1" as const,
        question_text: "Which product is this?",
        correct_answer: "Product 1",
        option_a: "Product 1",
        option_b: "Product 2",
        option_c: "Product 3",
        option_d: "Product 4",
        correct_option: "A" as const,
      },
    ];
    await insertChallengeQuestions(questions);

    // Create test session
    const session = await createSession({
      userId: testUserId,
      challengeId: testChallengeId,
      deviceId: "test-device-123",
      isPractice: false,
    });
    sessionId = session.id;

    // Mark session as started
    await query(
      `UPDATE game_sessions SET challenge_started_at = NOW() WHERE id = $1`,
      [sessionId]
    );
  });

  afterAll(async () => {
    // Cleanup test data
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [sessionId]);
    await query(`DELETE FROM game_sessions WHERE id = $1`, [sessionId]);
    await query(`DELETE FROM challenge_questions WHERE challenge_id = $1`, [testChallengeId]);
    await query(`DELETE FROM challenges WHERE id = $1`, [testChallengeId]);
    await query(`DELETE FROM brands WHERE id = $1`, [testBrandId]);
    await query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  it("should prevent double-scoring when same round answer is submitted concurrently", async () => {
    const round = 1 as const;
    const selectedOption = "A" as const;
    const reactionTimeMs = 1000;
    const score = 150; // Base 100 + speed bonus

    // Submit the same answer concurrently
    const promises = [
      recordRoundScore(sessionId, round, score, selectedOption, reactionTimeMs),
      recordRoundScore(sessionId, round, score, selectedOption, reactionTimeMs),
      recordRoundScore(sessionId, round, score, selectedOption, reactionTimeMs),
    ];

    // All should resolve (no errors thrown)
    const results = await Promise.allSettled(promises);
    
    // At least one should succeed
    const successful = results.filter(r => r.status === "fulfilled");
    expect(successful.length).toBeGreaterThan(0);

    // Verify only one score was recorded in the database
    const scoreRecords = await query(
      `SELECT * FROM session_round_scores WHERE session_id = $1 AND round = $2`,
      [sessionId, round]
    );
    expect(scoreRecords.rows.length).toBe(1);

    // Verify the score value
    expect(scoreRecords.rows[0].score).toBe(score);
    expect(scoreRecords.rows[0].reaction_time_ms).toBe(reactionTimeMs);
  });

  it("should handle concurrent submissions for different rounds correctly", async () => {
    // Clean up any existing scores
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [sessionId]);

    const round1Score = 150;
    const round2Score = 120;
    const round3Score = 140;

    // Submit answers for all rounds concurrently
    const promises = [
      recordRoundScore(sessionId, 1, round1Score, "A", 1000),
      recordRoundScore(sessionId, 2, round2Score, "B", 2000),
      recordRoundScore(sessionId, 3, round3Score, "C", 1500),
    ];

    await Promise.all(promises);

    // Verify all three scores were recorded
    const scoreRecords = await query(
      `SELECT * FROM session_round_scores WHERE session_id = $1 ORDER BY round`,
      [sessionId]
    );
    expect(scoreRecords.rows.length).toBe(3);

    expect(scoreRecords.rows[0].round).toBe(1);
    expect(scoreRecords.rows[0].score).toBe(round1Score);

    expect(scoreRecords.rows[1].round).toBe(2);
    expect(scoreRecords.rows[1].score).toBe(round2Score);

    expect(scoreRecords.rows[2].round).toBe(3);
    expect(scoreRecords.rows[2].score).toBe(round3Score);
  });

  it("should prevent duplicate submissions for the same round with different answers", async () => {
    // Clean up any existing scores
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [sessionId]);

    const round = 2 as const;

    // Submit different answers for the same round concurrently
    const promises = [
      recordRoundScore(sessionId, round, 150, "A", 1000),
      recordRoundScore(sessionId, round, 0, "B", 2000), // Wrong answer
      recordRoundScore(sessionId, round, 0, "C", 1500), // Wrong answer
    ];

    await Promise.allSettled(promises);

    // Verify only one score was recorded
    const scoreRecords = await query(
      `SELECT * FROM session_round_scores WHERE session_id = $1 AND round = $2`,
      [sessionId, round]
    );
    expect(scoreRecords.rows.length).toBe(1);
  });

  it("should maintain session total score correctly under concurrent load", async () => {
    // Clean up any existing scores
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [sessionId]);

    // Reset session scores
    await query(
      `UPDATE game_sessions 
       SET round_1_score = 0, round_2_score = 0, round_3_score = 0, total_score = 0
       WHERE id = $1`,
      [sessionId]
    );

    const scores = [150, 120, 140];
    const expectedTotal = scores.reduce((sum, score) => sum + score, 0);

    // Submit all rounds concurrently with some duplicates
    const promises = [
      ...scores.map((score, idx) => 
        recordRoundScore(sessionId, (idx + 1) as 1 | 2 | 3, score, "A", 1000)
      ),
      // Add some duplicate submissions
      recordRoundScore(sessionId, 1, 150, "A", 1000),
      recordRoundScore(sessionId, 2, 120, "A", 1000),
    ];

    await Promise.allSettled(promises);

    // Verify session total score
    const session = await getSession(testUserId, testChallengeId);
    expect(session?.total_score).toBe(expectedTotal);
  });

  it("should handle rapid sequential submissions without race conditions", async () => {
    // Clean up any existing scores
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [sessionId]);

    // Reset session scores
    await query(
      `UPDATE game_sessions 
       SET round_1_score = 0, round_2_score = 0, round_3_score = 0, total_score = 0
       WHERE id = $1`,
      [sessionId]
    );

    // Submit answers in rapid succession (simulating fast user)
    const startTime = Date.now();
    for (let i = 1; i <= 3; i++) {
      await recordRoundScore(sessionId, i as 1 | 2 | 3, 100 + i * 10, "A", 500 + i * 100);
    }
    const elapsed = Date.now() - startTime;

    // Should complete quickly (< 1 second)
    expect(elapsed).toBeLessThan(1000);

    // Verify all scores were recorded
    const scoreRecords = await query(
      `SELECT * FROM session_round_scores WHERE session_id = $1 ORDER BY round`,
      [sessionId]
    );
    expect(scoreRecords.rows.length).toBe(3);
  });

  it("should use database constraints to prevent duplicate round scores", async () => {
    // Clean up any existing scores
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [sessionId]);

    const round = 1 as const;

    // Try to insert duplicate records directly (bypassing the application layer)
    // This should fail due to database constraints
    const firstInsert = await query(
      `INSERT INTO session_round_scores (session_id, round, score, reaction_time_ms)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [sessionId, round, 150, 1000]
    );
    expect(firstInsert.rows.length).toBe(1);

    // Try to insert the same round again
    const secondInsert = await query(
      `INSERT INTO session_round_scores (session_id, round, score, reaction_time_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, round) DO NOTHING
       RETURNING id`,
      [sessionId, round, 150, 1000]
    );
    
    // The second insert should not return a row (conflict prevented)
    expect(secondInsert.rows.length).toBe(0);

    // Verify only one record exists
    const scoreRecords = await query(
      `SELECT COUNT(*) as count FROM session_round_scores WHERE session_id = $1 AND round = $2`,
      [sessionId, round]
    );
    expect(scoreRecords.rows[0].count).toBe(1);
  });

  it("should handle concurrent submissions from multiple users for different sessions", async () => {
    // Create a second user and session
    const user2Result = await query(
      `INSERT INTO users (email, display_name, username, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ["concurrent-test-2@example.com", "Concurrent Test 2", "concurrent_test_2", "player", "active"]
    );
    const testUserId2 = user2Result.rows[0].id;

    const session2 = await createSession({
      userId: testUserId2,
      challengeId: testChallengeId,
      deviceId: "test-device-456",
      isPractice: false,
    });

    await query(
      `UPDATE game_sessions SET challenge_started_at = NOW() WHERE id = $1`,
      [session2.id]
    );

    // Submit answers for both users concurrently
    const promises = [
      recordRoundScore(sessionId, 1, 150, "A", 1000),
      recordRoundScore(session2.id, 1, 140, "A", 1200),
      recordRoundScore(sessionId, 2, 120, "B", 2000),
      recordRoundScore(session2.id, 2, 130, "B", 2100),
    ];

    await Promise.all(promises);

    // Verify both users have their scores recorded
    const user1Scores = await query(
      `SELECT COUNT(*) as count FROM session_round_scores WHERE session_id = $1`,
      [sessionId]
    );
    expect(user1Scores.rows[0].count).toBe(2);

    const user2Scores = await query(
      `SELECT COUNT(*) as count FROM session_round_scores WHERE session_id = $1`,
      [session2.id]
    );
    expect(user2Scores.rows[0].count).toBe(2);

    // Cleanup second user
    await query(`DELETE FROM session_round_scores WHERE session_id = $1`, [session2.id]);
    await query(`DELETE FROM game_sessions WHERE id = $1`, [session2.id]);
    await query(`DELETE FROM users WHERE id = $1`, [testUserId2]);
  });
});
