import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `challenges_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options");
  const searchPathOption = `-c search_path=${schema}`;
  url.searchParams.set(
    "options",
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption
  );
  return url.toString();
}

if (originalDatabaseUrl) {
  process.env.DATABASE_URL = withSearchPath(originalDatabaseUrl, schemaName);
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

describeIntegration("challenges db queries", () => {
  let query: typeof import("../index").query;
  let closeDb: typeof import("../index").closeDb;
  let challenges: typeof import("./challenges");

  /** Helper: insert a minimal user and return its id. */
  async function createUser(emailPrefix: string): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2)
       RETURNING id`,
      [`${emailPrefix}-${randomUUID()}@example.test`, emailPrefix]
    );
    return result.rows[0].id;
  }

  /** Helper: insert a brand linked to the given owner and return its id. */
  async function createBrand(ownerId: string, name = "Test Brand"): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO brands (owner_id, name, logo_url, primary_color, secondary_color)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [ownerId, name, "https://example.test/logo.png", "#6366f1", "#a5b4fc"]
    );
    return result.rows[0].id;
  }

  // ── Schema setup ────────────────────────────────────────────────────────────
  beforeAll(async () => {
    const db = await import("../index");
    query = db.query;
    closeDb = db.closeDb;
    challenges = await import("./challenges");

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // Minimal users table (FK target)
    await query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL
      )
    `);

    // Minimal brands table (FK target for challenges)
    await query(`
      CREATE TABLE brands (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        logo_url TEXT,
        primary_color TEXT DEFAULT '#6366f1',
        secondary_color TEXT DEFAULT '#a5b4fc'
      )
    `);

    // Challenges table matching columns used by the query functions
    await query(`
      CREATE TABLE challenges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        challenge_id TEXT NOT NULL UNIQUE,
        pool_amount_stroops BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending_deposit',
        stellar_deposit_tx TEXT,
        deposit_memo TEXT UNIQUE,
        payout_tx_hashes TEXT[],
        max_players INTEGER,
        starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ends_at             TIMESTAMPTZ,
        deleted_at          TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        `);

    await query(
      `CREATE INDEX idx_challenges_deposit_memo ON challenges (deposit_memo)`
    );

    // Challenge questions table
    await query(`
      CREATE TABLE challenge_questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        round INTEGER NOT NULL CHECK (round IN (1, 2, 3)),
        question_type TEXT NOT NULL CHECK (question_type IN ('which_brand', 'which_tagline', 'which_product')),
        prompt_type TEXT NOT NULL CHECK (prompt_type IN ('logo', 'productImage1', 'tagline')),
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        correct_option CHAR(1) NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (challenge_id, round)
      )
    `);
  });

  afterAll(async () => {
    if (query) {
      await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    if (closeDb) {
      await closeDb();
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  // ── createChallenge ─────────────────────────────────────────────────────────
  it("createChallenge persists with status pending_deposit", async () => {
    const userId = await createUser("create-chal");
    const brandId = await createBrand(userId);

    const challenge = await challenges.createChallenge({
      brandId,
      challengeId: `memo-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
      maxPlayers: 50,
      endsAt: "2026-12-31T23:59:59Z",
    });

    expect(challenge).toBeDefined();
    expect(challenge.id).toBeTruthy();
    expect(challenge.brand_id).toBe(brandId);
    expect(challenge.status).toBe("pending_deposit");
    expect(Number(challenge.pool_amount_usdc)).toBe(100);
    expect(challenge.pool_amount_stroops).toBe("1000000000");
    expect(challenge.max_players).toBe(50);
    expect(challenge.stellar_deposit_tx).toBeNull();
    expect(challenge.payout_tx_hashes).toBeNull();
    expect(challenge.created_at).toBeTruthy();
  });

  it("createChallenge defaults max_players and ends_at to null when omitted", async () => {
    const userId = await createUser("create-defaults");
    const brandId = await createBrand(userId);

    const challenge = await challenges.createChallenge({
      brandId,
      challengeId: `memo-${randomUUID()}`,
      poolAmountUsdc: "50.0000000",
    });

    expect(challenge.max_players).toBeNull();
    expect(challenge.ends_at).toBeNull();
  });

  // ── updateChallengeStatus ───────────────────────────────────────────────────
  it("updateChallengeStatus transitions through pending -> active -> ended -> settled", async () => {
    const userId = await createUser("status-trans");
    const brandId = await createBrand(userId);
    const challengeId = `memo-${randomUUID()}`;

    const created = await challenges.createChallenge({
      brandId,
      challengeId,
      poolAmountUsdc: "200.0000000",
    });

    expect(created.status).toBe("pending_deposit");

    // pending_deposit -> active (with deposit tx)
    await challenges.updateChallengeStatus(created.id, "active", {
      depositTx: "TX_HASH_123",
    });
    let updated = await challenges.getChallengeById(created.id);
    expect(updated?.status).toBe("active");
    expect(updated?.stellar_deposit_tx).toBe("TX_HASH_123");

    // active -> ended
    await challenges.updateChallengeStatus(created.id, "ended");
    updated = await challenges.getChallengeById(created.id);
    expect(updated?.status).toBe("ended");

    // ended -> settled (with payout tx hashes)
    await challenges.updateChallengeStatus(created.id, "settled", {
      payoutTxHashes: ["PAYOUT_1", "PAYOUT_2"],
    });
    updated = await challenges.getChallengeById(created.id);
    expect(updated?.status).toBe("settled");
    expect(updated?.payout_tx_hashes).toEqual(["PAYOUT_1", "PAYOUT_2"]);
  });

  it("updateChallengeStatus works with no extras", async () => {
    const userId = await createUser("status-plain");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `memo-${randomUUID()}`,
      poolAmountUsdc: "10.0000000",
    });

    await challenges.updateChallengeStatus(created.id, "active");
    const updated = await challenges.getChallengeById(created.id);
    expect(updated?.status).toBe("active");
    // deposit tx should remain null since we did not pass extras
    expect(updated?.stellar_deposit_tx).toBeNull();
  });

  // ── getActiveChallenges ─────────────────────────────────────────────────────
  it("getActiveChallenges joins brand correctly and respects ends_at", async () => {
    const userId = await createUser("active-chal");
    const brandId = await createBrand(userId, "Active Brand");

    // Create an active challenge with a future ends_at
    const activeMemo = `active-${randomUUID()}`;
    const active = await challenges.createChallenge({
      brandId,
      challengeId: activeMemo,
      poolAmountUsdc: "500.0000000",
      endsAt: "2099-12-31T23:59:59Z",
    });
    await challenges.updateChallengeStatus(active.id, "active");

    // Create a non-active (pending) challenge -- should NOT appear
    await challenges.createChallenge({
      brandId,
      challengeId: `pending-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    const activeChallenges = await challenges.getActiveChallenges(100, 0);
    const found = activeChallenges.find((c) => c.id === active.id);

    expect(found).toBeDefined();
    expect(found!.brand_id).toBe(brandId);
    // Joined brand fields
    expect((found as any).brand_name).toBe("Active Brand");
    expect((found as any).logo_url).toBe("https://example.test/logo.png");
    expect((found as any).primary_color).toBe("#6366f1");
    expect((found as any).secondary_color).toBe("#a5b4fc");

    // Verify pending challenge is excluded
    const pendingInResults = activeChallenges.some((c) => c.status !== "active");
    expect(pendingInResults).toBe(false);
  });

  it("getActiveChallenges orders by pool_amount_stroops DESC", async () => {
    const userId = await createUser("active-order");
    const brandId = await createBrand(userId, "Order Brand");

    const small = await challenges.createChallenge({
      brandId,
      challengeId: `small-${randomUUID()}`,
      poolAmountUsdc: "10.0000000",
    });
    const large = await challenges.createChallenge({
      brandId,
      challengeId: `large-${randomUUID()}`,
      poolAmountUsdc: "9999.0000000",
    });

    await challenges.updateChallengeStatus(small.id, "active");
    await challenges.updateChallengeStatus(large.id, "active");

    const results = await challenges.getActiveChallenges(100, 0);
    const smallIdx = results.findIndex((c) => c.id === small.id);
    const largeIdx = results.findIndex((c) => c.id === large.id);

    // Larger pool should appear first
    expect(largeIdx).toBeLessThan(smallIdx);
  });

  it("getActiveChallenges respects limit and offset", async () => {
    const userId = await createUser("active-page");
    const brandId = await createBrand(userId, "Page Brand");

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await challenges.createChallenge({
        brandId,
        challengeId: `page-${i}-${randomUUID()}`,
        poolAmountUsdc: `${(i + 1) * 100}.0000000`,
      });
      await challenges.updateChallengeStatus(c.id, "active");
      ids.push(c.id);
    }

    const page1 = await challenges.getActiveChallenges(2, 0);
    expect(page1.length).toBeGreaterThanOrEqual(2);

    const page2 = await challenges.getActiveChallenges(2, 2);
    // page2 should not contain the same items as page1
    const page1Ids = new Set(page1.map((c) => c.id));
    for (const c of page2) {
      expect(page1Ids.has(c.id)).toBe(false);
    }
  });

  // ── getChallengeByMemo ──────────────────────────────────────────────────────
  it("getChallengeByMemo returns the challenge for a known memo", async () => {
    const userId = await createUser("memo-known");
    const brandId = await createBrand(userId);
    const memo = `known-memo-${randomUUID()}`;

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `cid-${randomUUID()}`,
      poolAmountUsdc: "75.0000000",
    });
    // Set deposit_memo separately — mirrors how the deposit flow works
    await query("UPDATE challenges SET deposit_memo = $1 WHERE id = $2", [memo, created.id]);

    const found = await challenges.getChallengeByMemo(memo);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("getChallengeByMemo returns null for unknown memo", async () => {
    const result = await challenges.getChallengeByMemo(`nonexistent-${randomUUID()}`);
    expect(result).toBeNull();
  });

  // ── getChallengeById ────────────────────────────────────────────────────────
  it("getChallengeById returns correct challenge", async () => {
    const userId = await createUser("by-id");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `byid-${randomUUID()}`,
      poolAmountUsdc: "25.0000000",
    });

    const found = await challenges.getChallengeById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("getChallengeById returns null for unknown id", async () => {
    const result = await challenges.getChallengeById(randomUUID());
    expect(result).toBeNull();
  });

  // ── insertChallengeQuestions ─────────────────────────────────────────────────
  it("insertChallengeQuestions inserts all 3 questions atomically", async () => {
    const userId = await createUser("insert-q");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `q-insert-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    const questions = [1, 2, 3].map((round) => ({
      challenge_id: created.id,
      round: round as 1 | 2 | 3,
      question_type: "which_brand",
      prompt_type: "tagline",
      question_text: `Question ${round}?`,
      option_a: "A answer",
      option_b: "B answer",
      option_c: "C answer",
      option_d: "D answer",
      correct_option: (["A", "B", "C", "D"] as const)[round - 1],
    }));

    await challenges.insertChallengeQuestions(questions);

    const stored = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM challenge_questions WHERE challenge_id = $1",
      [created.id]
    );
    expect(Number(stored.rows[0].count)).toBe(3);
  });

  it("insertChallengeQuestions rejects duplicate rounds (all-or-none atomicity)", async () => {
    const userId = await createUser("insert-q-dup");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `q-dup-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    const baseQuestion = {
      challenge_id: created.id,
      question_type: "which_brand",
      prompt_type: "tagline",
      question_text: "Duplicate?",
      option_a: "A",
      option_b: "B",
      option_c: "C",
      option_d: "D",
      correct_option: "A" as const,
    };

    // Insert round 1 first
    await challenges.insertChallengeQuestions([
      { ...baseQuestion, round: 1 as const },
    ]);

    // Attempt to insert round 1 again should violate the unique constraint
    await expect(
      challenges.insertChallengeQuestions([
        { ...baseQuestion, round: 1 as const },
      ])
    ).rejects.toThrow();
  });

  // ── getChallengeQuestions ────────────────────────────────────────────────────
  it("getChallengeQuestions returns all questions ordered by round", async () => {
    const userId = await createUser("get-q");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `q-get-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    // Insert in reverse round order to verify ORDER BY
    const questions = [3, 1, 2].map((round) => ({
      challenge_id: created.id,
      round: round as 1 | 2 | 3,
      question_type: "which_brand",
      prompt_type: "tagline",
      question_text: `Question round ${round}`,
      option_a: "A",
      option_b: "B",
      option_c: "C",
      option_d: "D",
      correct_option: "A" as const,
    }));

    await challenges.insertChallengeQuestions(questions);

    const result = await challenges.getChallengeQuestions(created.id);

    expect(result).toHaveLength(3);
    // Must be ordered by round ascending
    expect(result[0].round).toBe(1);
    expect(result[1].round).toBe(2);
    expect(result[2].round).toBe(3);
    // Verify content
    expect(result[0].question_text).toBe("Question round 1");
    expect(result[1].question_text).toBe("Question round 2");
    expect(result[2].question_text).toBe("Question round 3");
  });

  it("getChallengeQuestions includes correct_option field", async () => {
    const userId = await createUser("get-q-private");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `q-private-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    await challenges.insertChallengeQuestions([
      {
        challenge_id: created.id,
        round: 1,
        question_type: "which_tagline",
        prompt_type: "logo",
        question_text: "Private test?",
        option_a: "A",
        option_b: "B",
        option_c: "C",
        option_d: "D",
        correct_option: "B",
      },
    ]);

    const result = await challenges.getChallengeQuestions(created.id);
    expect(result).toHaveLength(1);
    // The current getChallengeQuestions returns SELECT * so correct_option is included
    expect(result[0].correct_option).toBe("B");
  });

  it("round-trips question and prompt types", async () => {
    const userId = await createUser("get-q-types");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `q-types-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    await challenges.insertChallengeQuestions([
      {
        challenge_id: created.id,
        round: 1,
        question_type: "which_product",
        prompt_type: "productImage1",
        question_text: "Which brand makes this product?",
        option_a: "Acme",
        option_b: "Beta",
        option_c: "Cyan",
        option_d: "Delta",
        correct_option: "A",
      },
    ]);

    const result = await challenges.getChallengeQuestions(created.id);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      question_type: "which_product",
      prompt_type: "productImage1",
      question_text: "Which brand makes this product?",
    });
  });

  // ── deposit_memo index performance ─────────────────────────────────────────
  it("getChallengeByMemo lookup completes in < 5ms with 10k rows", async () => {
    const userId = await createUser("memo-perf");
    const brandId = await createBrand(userId, "Perf Brand");

    // Insert 10 000 challenges in batches to keep the test fast
    const batchSize = 200;
    const batches = 50;
    for (let b = 0; b < batches; b++) {
      const values = Array.from({ length: batchSize }, (_, i) => {
        const idx = b * batchSize + i;
        return `('${brandId}', 'perf-cid-${randomUUID()}', 100, 'perf-memo-${idx}-${randomUUID()}')`;
      }).join(",");
      await query(
        `INSERT INTO challenges (brand_id, challenge_id, pool_amount_stroops, deposit_memo) VALUES ${values}`
      );
    }

    const targetMemo = `target-memo-${randomUUID()}`;
    await query(
      `INSERT INTO challenges (brand_id, challenge_id, pool_amount_stroops, deposit_memo)
       VALUES ($1, $2, 50, $3)`,
      [brandId, `target-cid-${randomUUID()}`, targetMemo]
    );

    const start = performance.now();
    const found = await challenges.getChallengeByMemo(targetMemo);
    const elapsed = performance.now() - start;

    expect(found).not.toBeNull();
    expect(elapsed).toBeLessThan(5);
  });

  it("getChallengeQuestions returns empty array for challenge with no questions", async () => {
    const userId = await createUser("no-q");
    const brandId = await createBrand(userId);

    const created = await challenges.createChallenge({
      brandId,
      challengeId: `no-q-${randomUUID()}`,
      poolAmountUsdc: "100.0000000",
    });

    const result = await challenges.getChallengeQuestions(created.id);
    expect(result).toEqual([]);
  });
});
