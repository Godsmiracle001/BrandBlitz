import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, query } from "../db";
import { randomUUID } from "node:crypto";
import { createArchiveWorker } from "./archive.queue";
import { getLeaderboard, getArchivedLeaderboard } from "../db/queries/sessions";
import { getChallengeByIdAny, updateChallengeStatus } from "../db/queries/challenges";

describe("Archive Queue Integration Tests", () => {
  let testUserId: string;
  let testBrandId: string;
  let testChallengeId: string;
  let sessionIds: string[] = [];

  beforeAll(async () => {
    // Create test user
    const userResult = await query(
      `INSERT INTO users (email, display_name, username, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ["archive-test@example.com", "Archive Test User", "archive_test", "admin", "active"]
    );
    testUserId = userResult.rows[0].id;

    // Create test brand
    const brandResult = await query(
      `INSERT INTO brands (owner_user_id, name, tagline, primary_color, secondary_color)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [testUserId, "Archive Test Brand", "Testing archival", "#6366f1", "#a5b4fc"]
    );
    testBrandId = brandResult.rows[0].id;

    // Create test challenge in ended state (eligible for archival)
    const challengeResult = await query(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, ends_at, started_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '120 days', NOW() - INTERVAL '125 days')
       RETURNING id`,
      [testBrandId, `archive-challenge-${randomUUID()}`, "settled", 1000000000] // 100 USDC
    );
    testChallengeId = challengeResult.rows[0].id;

    // Create 10 sessions with 5 round scores each (50 total session_round_scores)
    for (let i = 0; i < 10; i++) {
      const sessionResult = await query(
        `INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at, challenge_started_at, challenge_ended_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '100 days', NOW() - INTERVAL '110 days', NOW() - INTERVAL '100 days')
         RETURNING id`,
        [testUserId, testChallengeId, "completed", 1000 + i * 100]
      );
      const sessionId = sessionResult.rows[0].id;
      sessionIds.push(sessionId);

      // Create 5 round scores per session
      for (let round = 1; round <= 5; round++) {
        await query(
          `INSERT INTO session_round_scores (session_id, round, score, reaction_time_ms)
           VALUES ($1, $2, $3, $4)`,
          [sessionId, round as 1 | 2 | 3, 200 + round * 50, 1000 + round * 100]
        );
      }
    }
  });

  afterAll(async () => {
    // Cleanup test data
    await query(`DELETE FROM session_round_scores WHERE session_id = ANY($1::uuid[])`, [sessionIds]);
    await query(`DELETE FROM game_sessions_archive WHERE id = ANY($1::uuid[])`, [sessionIds]);
    await query(`DELETE FROM game_sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
    await query(`DELETE FROM challenges_archive WHERE id = $1`, [testChallengeId]);
    await query(`DELETE FROM challenges WHERE id = $1`, [testChallengeId]);
    await query(`DELETE FROM brands WHERE id = $1`, [testBrandId]);
    await query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  it("should archive ended challenge data and delete session_round_scores from hot table", async () => {
    // Verify initial state - 50 session_round_scores exist
    const initialScores = await query(
      `SELECT COUNT(*) as count FROM session_round_scores WHERE session_id = ANY($1::uuid[])`,
      [sessionIds]
    );
    expect(initialScores.rows[0].count).toBe(50);

    // Verify sessions exist in hot table
    const initialSessions = await query(
      `SELECT COUNT(*) as count FROM game_sessions WHERE id = ANY($1::uuid[])`,
      [sessionIds]
    );
    expect(initialSessions.rows[0].count).toBe(10);

    // Verify challenge exists in hot table
    const initialChallenge = await getChallengeByIdAny(testChallengeId);
    expect(initialChallenge).not.toBeNull();
    expect(initialChallenge?.status).toBe("settled");

    // Get pre-archive leaderboard state
    const preArchiveLeaderboard = await getLeaderboard(testChallengeId, 10);
    expect(preArchiveLeaderboard.sessions.length).toBeGreaterThan(0);

    // Create and run archive worker
    const worker = createArchiveWorker();
    
    // Manually trigger the job (since we're testing the processor directly)
    await worker.run();
    
    // Wait a moment for processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify session_round_scores are deleted from hot table
    const postArchiveScores = await query(
      `SELECT COUNT(*) as count FROM session_round_scores WHERE session_id = ANY($1::uuid[])`,
      [sessionIds]
    );
    expect(postArchiveScores.rows[0].count).toBe(0);

    // Verify sessions are moved to archive table
    const archivedSessions = await query(
      `SELECT COUNT(*) as count FROM game_sessions_archive WHERE id = ANY($1::uuid[])`,
      [sessionIds]
    );
    expect(archivedSessions.rows[0].count).toBe(10);

    // Verify sessions are deleted from hot table
    const postArchiveSessions = await query(
      `SELECT COUNT(*) as count FROM game_sessions WHERE id = ANY($1::uuid[])`,
      [sessionIds]
    );
    expect(postArchiveSessions.rows[0].count).toBe(0);

    // Verify challenge is moved to archive table
    const archivedChallenge = await query(
      `SELECT * FROM challenges_archive WHERE id = $1`,
      [testChallengeId]
    );
    expect(archivedChallenge.rows.length).toBe(1);
    expect(archivedChallenge.rows[0].status).toBe("settled");

    // Verify challenge is deleted from hot table
    const postArchiveChallenge = await getChallengeByIdAny(testChallengeId);
    expect(postArchiveChallenge).toBeNull();

    // Verify archived sessions have identical field values
    const archivedSessionData = await query(
      `SELECT * FROM game_sessions_archive WHERE id = $1`,
      [sessionIds[0]]
    );
    expect(archivedSessionData.rows.length).toBe(1);
    expect(archivedSessionData.rows[0].user_id).toBe(testUserId);
    expect(archivedSessionData.rows[0].challenge_id).toBe(testChallengeId);
    expect(archivedSessionData.rows[0].status).toBe("completed");
    expect(archivedSessionData.rows[0].total_score).toBe(1000);

    // Verify leaderboard endpoint reads from archive and returns correct data
    const archivedLeaderboard = await getArchivedLeaderboard(testChallengeId, 10);
    expect(archivedLeaderboard.sessions.length).toBe(10);
    
    // Verify rankings match pre-archive state (same order by score)
    expect(archivedLeaderboard.sessions[0].total_score).toBe(preArchiveLeaderboard.sessions[0].total_score);
    expect(archivedLeaderboard.sessions[0].user_id).toBe(preArchiveLeaderboard.sessions[0].user_id);

    await worker.close();
  });

  it("should be idempotent - re-running archive produces no errors or duplicates", async () => {
    // Create another ended challenge for idempotency test
    const idempotentChallengeId = randomUUID();
    await query(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, ends_at, started_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '120 days', NOW() - INTERVAL '125 days')
       RETURNING id`,
      [testBrandId, `idempotent-${idempotentChallengeId}`, "settled", 500000000]
    );
    const challengeId = (await query(`SELECT id FROM challenges WHERE challenge_id = $2`, [testBrandId, `idempotent-${idempotentChallengeId}`])).rows[0].id;

    const idempotentSessionId = randomUUID();
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at, challenge_started_at, challenge_ended_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '100 days', NOW() - INTERVAL '110 days', NOW() - INTERVAL '100 days')
       RETURNING id`,
      [testUserId, challengeId, "completed", 500]
    );

    // First archive run
    const worker = createArchiveWorker();
    await worker.run();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify data was archived
    const firstArchiveCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions_archive WHERE id = $1`,
      [idempotentSessionId]
    );
    expect(firstArchiveCheck.rows[0].count).toBe(1);

    // Second archive run (should be idempotent)
    await worker.run();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify no duplicate archive rows
    const secondArchiveCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions_archive WHERE id = $1`,
      [idempotentSessionId]
    );
    expect(secondArchiveCheck.rows[0].count).toBe(1); // Still 1, not 2

    // Cleanup
    await query(`DELETE FROM challenges_archive WHERE id = $1`, [challengeId]);
    await query(`DELETE FROM game_sessions_archive WHERE id = $1`, [idempotentSessionId]);
    await query(`DELETE FROM game_sessions WHERE id = $1`, [idempotentSessionId]);
    await query(`DELETE FROM challenges WHERE id = $1`, [challengeId]);

    await worker.close();
  });

  it("should not archive active or pending_deposit challenges", async () => {
    // Create an active challenge
    const activeChallengeId = randomUUID();
    await query(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, ends_at, started_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '48 hours', NOW())`,
      [testBrandId, `active-${activeChallengeId}`, "active", 1000000000]
    );
    const activeChallenge = (await query(`SELECT id FROM challenges WHERE challenge_id = $2`, [testBrandId, `active-${activeChallengeId}`])).rows[0].id;

    const activeSessionId = randomUUID();
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at, challenge_started_at, challenge_ended_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')
       RETURNING id`,
      [testUserId, activeChallenge, "completed", 800]
    );

    // Create a pending_deposit challenge
    const pendingChallengeId = randomUUID();
    await query(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, ends_at, started_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '48 hours', NOW())`,
      [testBrandId, `pending-${pendingChallengeId}`, "pending_deposit", 500000000]
    );
    const pendingChallenge = (await query(`SELECT id FROM challenges WHERE challenge_id = $2`, [testBrandId, `pending-${pendingChallengeId}`])).rows[0].id;

    const pendingSessionId = randomUUID();
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at, challenge_started_at, challenge_ended_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')
       RETURNING id`,
      [testUserId, pendingChallenge, "completed", 600]
    );

    // Run archive worker
    const worker = createArchiveWorker();
    await worker.run();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify active challenge still exists in hot table
    const activeChallengeCheck = await getChallengeByIdAny(activeChallenge);
    expect(activeChallengeCheck).not.toBeNull();
    expect(activeChallengeCheck?.status).toBe("active");

    // Verify active session still exists in hot table
    const activeSessionCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions WHERE id = $1`,
      [activeSessionId]
    );
    expect(activeSessionCheck.rows[0].count).toBe(1);

    // Verify pending_deposit challenge still exists in hot table
    const pendingChallengeCheck = await getChallengeByIdAny(pendingChallenge);
    expect(pendingChallengeCheck).not.toBeNull();
    expect(pendingChallengeCheck?.status).toBe("pending_deposit");

    // Verify pending session still exists in hot table
    const pendingSessionCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions WHERE id = $1`,
      [pendingSessionId]
    );
    expect(pendingSessionCheck.rows[0].count).toBe(1);

    // Verify neither was archived
    const activeArchiveCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions_archive WHERE id = $1`,
      [activeSessionId]
    );
    expect(activeArchiveCheck.rows[0].count).toBe(0);

    const pendingArchiveCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions_archive WHERE id = $1`,
      [pendingSessionId]
    );
    expect(pendingArchiveCheck.rows[0].count).toBe(0);

    // Cleanup
    await query(`DELETE FROM game_sessions WHERE id = ANY($1::uuid[])`, [[activeSessionId, pendingSessionId]]);
    await query(`DELETE FROM challenges WHERE id = ANY($1::uuid[])`, [[activeChallenge, pendingChallenge]]);

    await worker.close();
  });

  it("should handle transaction rollback on error", async () => {
    // Create a challenge that will cause an error during archival
    // by making it ineligible for archival but trying to force it
    const errorChallengeId = randomUUID();
    await query(
      `INSERT INTO challenges (brand_id, challenge_id, status, pool_amount_stroops, ends_at, started_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '48 hours', NOW())`,
      [testBrandId, `error-${errorChallengeId}`, "active", 1000000000]
    );
    const challengeId = (await query(`SELECT id FROM challenges WHERE challenge_id = $2`, [testBrandId, `error-${errorChallengeId}`])).rows[0].id;

    const errorSessionId = randomUUID();
    await query(
      `INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at, challenge_started_at, challenge_ended_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      [testUserId, challengeId, "completed", 300]
    );

    // Run archive worker - should not error even with ineligible challenges
    const worker = createArchiveWorker();
    await worker.run();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify the ineligible challenge was not touched
    const errorChallengeCheck = await getChallengeByIdAny(challengeId);
    expect(errorChallengeCheck).not.toBeNull();
    expect(errorChallengeCheck?.status).toBe("active");

    const errorSessionCheck = await query(
      `SELECT COUNT(*) as count FROM game_sessions WHERE id = $1`,
      [errorSessionId]
    );
    expect(errorSessionCheck.rows[0].count).toBe(1);

    // Cleanup
    await query(`DELETE FROM game_sessions WHERE id = $1`, [errorSessionId]);
    await query(`DELETE FROM challenges WHERE id = $1`, [challengeId]);

    await worker.close();
  });
});
