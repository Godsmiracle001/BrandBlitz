/**
 * Seed script — creates deterministic local dev fixtures.
 *
 * Usage:
 *   pnpm --filter @brandblitz/api seed              # idempotent (no-op on re-run)
 *   pnpm --filter @brandblitz/api seed -- --reset   # truncate then re-seed
 */

import "dotenv/config";
import { Pool } from "pg";
import path from "path";

// DB connection

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/brandblitz",
  max: 5,
});

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

// Deterministic RNG (mulberry32, seed = 0xDEADBEEF)

let _rngState = 0xdeadbeef;

function rng(): number {
  _rngState = (_rngState + 0x6d2b79f5) >>> 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
}

function rngInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function rngChoice<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// Fixture definitions

const BRANDS = [
  {
    email: "seed-brand-1@brandblitz.test",
    name: "Stellar Pay",
    tagline: "Send money across borders in seconds",
    usp: "Zero-fee USDC transfers powered by Stellar",
    colors: JSON.stringify({ primary: "#14b8a6", secondary: "#0f766e" }),
    logoKey: "brand-1.png",
  },
  {
    email: "seed-brand-2@brandblitz.test",
    name: "NovaMint",
    tagline: "The smart way to stake your assets",
    usp: "Up to 12% APY on your digital assets with daily compounding",
    colors: JSON.stringify({ primary: "#7c3aed", secondary: "#4c1d95" }),
    logoKey: "brand-2.png",
  },
  {
    email: "seed-brand-3@brandblitz.test",
    name: "AetherShop",
    tagline: "Shop globally, pay locally",
    usp: "One-click USDC checkout at 50,000+ stores worldwide",
    colors: JSON.stringify({ primary: "#f97316", secondary: "#c2410c" }),
    logoKey: "brand-3.png",
  },
];

const CHALLENGE_STATUSES = ["active", "active", "completed", "completed", "draft", "active"] as const;

const QUESTION_TYPES = ["tagline", "usp", "product"] as const;

// Helpers

function logoUrl(filename: string): string {
  return `local://fixtures/logos/${filename}`;
}

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString();
}

// Progress
// Seeding thousands of rows can take minutes; overwrite in-place so the user
// sees live progress instead of a silent wait.

function progress(done: number, total: number, label: string): void {
  const pct = Math.round((done / total) * 100);
  process.stdout.write(`\r    ${label}: ${done}/${total} (${pct}%)    `, () => {
    // Ensure the write is flushed so progress renders live even when stdout is piped (e.g. CI or `tee`).
  });
}

function progressEnd(): void {
  process.stdout.write("\n");
}

// Reset

async function resetFixtures(): Promise<void> {
  console.log("  Resetting seed fixtures…");
  // Delete in dependency order
  await sql(`DELETE FROM fraud_flags      WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'seed-%')`);
  await sql(`DELETE FROM session_round_scores WHERE session_id IN (
               SELECT id FROM game_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'seed-%')
             )`);
  await sql(`DELETE FROM game_sessions    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'seed-%')`);
  await sql(`DELETE FROM payouts          WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'seed-%')`);
  await sql(`DELETE FROM challenges       WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE 'seed-%'))`);
  await sql(`DELETE FROM brands           WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE 'seed-%')`);
  await sql(`DELETE FROM users            WHERE email LIKE 'seed-%'`);
  console.log("  Reset complete.");
}

// Seeding

async function seedUsers(): Promise<Record<string, string>> {
  console.log("  Seeding users (50)…");
  const ids: Record<string, string> = {};

  // Admin
  const [admin] = await sql<{ id: string }>(
    `INSERT INTO users (email, display_name, username, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    ["seed-admin@brandblitz.test", "Seed Admin", "seed_admin"]
  );
  ids["admin"] = admin.id;

  // Brand owners (3)
  for (let i = 1; i <= 3; i++) {
    const email = `seed-brand-${i}@brandblitz.test`;
    const [row] = await sql<{ id: string }>(
      `INSERT INTO users (email, display_name, username, role)
       VALUES ($1, $2, $3, 'brand')
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [email, `Seed Brand ${i}`, `seed_brand_${i}`]
    );
    ids[`brand_${i}`] = row.id;
  }

  // Players (46)
  const TOTAL_PLAYERS = 46;
  for (let i = 1; i <= TOTAL_PLAYERS; i++) {
    const email = `seed-player-${i}@brandblitz.test`;
    const league = rngChoice(["bronze", "silver", "gold", null, null, null]);
    const [row] = await sql<{ id: string }>(
      `INSERT INTO users (email, display_name, username, role, league)
       VALUES ($1, $2, $3, 'player', $4)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [email, `Player ${i}`, `seed_player_${i}`, league]
    );
    ids[`player_${i}`] = row.id;
    if (i % 10 === 0 || i === TOTAL_PLAYERS) {
      progress(i, TOTAL_PLAYERS, "players");
    }
  }
  progressEnd();

  console.log(`    Created/found ${Object.keys(ids).length} users.`);
  return ids;
}

async function seedBrands(userIds: Record<string, string>): Promise<Record<string, string>> {
  console.log("  Seeding brands (3)…");
  const ids: Record<string, string> = {};

  for (let i = 0; i < BRANDS.length; i++) {
    const b = BRANDS[i];
    const ownerId = userIds[`brand_${i + 1}`];
    const [row] = await sql<{ id: string }>(
      `INSERT INTO brands (owner_user_id, name, tagline, usp, logo_url, colors)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ownerId, b.name, b.tagline, b.usp, logoUrl(b.logoKey), b.colors]
    );
    if (row) {
      ids[`brand_${i + 1}`] = row.id;
    } else {
      const [existing] = await sql<{ id: string }>(
        `SELECT id FROM brands WHERE name = $1 AND owner_user_id = $2`,
        [b.name, ownerId]
      );
      ids[`brand_${i + 1}`] = existing.id;
    }
  }

  console.log(`    Created/found ${Object.keys(ids).length} brands.`);
  return ids;
}

async function seedChallenges(brandIds: Record<string, string>): Promise<string[]> {
  console.log("  Seeding challenges (6)…");
  const challengeIds: string[] = [];
  const brandKeys = Object.keys(brandIds);

  for (let i = 0; i < 6; i++) {
    const brandKey = brandKeys[i % brandKeys.length];
    const brandId = brandIds[brandKey];
    const challengeStatus = CHALLENGE_STATUSES[i];
    const poolUsdc = rngChoice([50, 100, 200, 500]);
    const poolStroops = BigInt(poolUsdc) * BigInt(10_000_000);
    const startsAt = i < 4 ? pastDate(rngInt(3, 30)) : futureDate(rngInt(1, 14));
    const endsAt = i < 2
      ? futureDate(rngInt(7, 21))    // active: ends in future
      : i < 4
      ? pastDate(rngInt(1, 7))       // completed: ended recently
      : futureDate(rngInt(30, 60));  // draft: far future

    const [row] = await sql<{ id: string }>(
      `INSERT INTO challenges
         (brand_id, status, pool_amount_stroops, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [brandId, challengeStatus, poolStroops.toString(), startsAt, endsAt]
    );

    if (row) {
      challengeIds.push(row.id);
      // Seed 3 questions per challenge
      for (let r = 1; r <= 3; r++) {
        const qType = QUESTION_TYPES[r - 1];
        await sql(
          `INSERT INTO challenge_questions
             (challenge_id, round, question_type, prompt_type, options, correct_option)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT DO NOTHING`,
          [
            row.id,
            r,
            qType,
            "text",
            JSON.stringify(["Option A", "Option B", "Option C", "Option D"]),
            rngInt(0, 3),
          ]
        );
      }
    } else {
      // Already exists — find by brand_id and index order
      const existing = await sql<{ id: string }>(
        `SELECT id FROM challenges WHERE brand_id = $1 ORDER BY created_at LIMIT 6`,
        [brandId]
      );
      if (existing[i % 2]) challengeIds.push(existing[i % 2].id);
    }
  }

  console.log(`    Created/found ${challengeIds.length} challenges.`);
  return challengeIds;
}

async function seedSessions(
  userIds: Record<string, string>,
  challengeIds: string[]
): Promise<void> {
  console.log("  Seeding sessions (200)…");
  if (challengeIds.length === 0) {
    console.log("    No challenges — skipping sessions.");
    return;
  }

  const playerIds = Object.entries(userIds)
    .filter(([k]) => k.startsWith("player_"))
    .map(([, v]) => v);

  let inserted = 0;
  const TOTAL_SESSIONS = 200;

  for (let i = 0; i < TOTAL_SESSIONS; i++) {
    const userId = rngChoice(playerIds);
    const challengeId = rngChoice(challengeIds);
    const isFlagged = rng() < 0.1; // ~10% flagged
    const sessionStatus = isFlagged ? "flagged" : "completed";
    const totalScore = isFlagged ? rngInt(0, 100) : rngInt(50, 300);
    const round1Score = rngInt(0, 100);
    const round2Score = rngInt(0, 100);
    const round3Score = totalScore - round1Score - round2Score;
    const r1Ms = isFlagged ? rngInt(20, 70) : rngInt(150, 8000);
    const r2Ms = rngInt(150, 8000);
    const r3Ms = rngInt(150, 8000);
    const completedAt = pastDate(rngInt(0, 30));

    const [row] = await sql<{ id: string }>(
      `INSERT INTO game_sessions
         (user_id, challenge_id, status, flagged, flag_reasons,
          round_1_score, round_2_score, round_3_score, total_score,
          round_1_reaction_ms, round_2_reaction_ms, round_3_reaction_ms,
          warmup_started_at, warmup_completed_at, challenge_started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12,
               NOW() - interval '5 minutes',
               NOW() - interval '4 minutes',
               NOW() - interval '3 minutes',
               $13)
       ON CONFLICT (user_id, challenge_id) DO NOTHING
       RETURNING id`,
      [
        userId,
        challengeId,
        sessionStatus,
        isFlagged,
        isFlagged ? ["reaction_time_too_fast"] : null,
        round1Score,
        round2Score,
        Math.max(0, round3Score),
        totalScore,
        r1Ms,
        r2Ms,
        r3Ms,
        completedAt,
      ]
    );

    if (row) {
      inserted++;
      if (isFlagged) {
        await sql(
          `INSERT INTO fraud_flags (session_id, user_id, flag_type, details)
           VALUES ($1, $2, 'reaction_time_too_fast', $3::jsonb)
           ON CONFLICT (session_id, flag_type) DO NOTHING`,
          [row.id, userId, JSON.stringify({ round_1_reaction_ms: r1Ms })]
        );
      }
    }

    if ((i + 1) % 25 === 0 || i === TOTAL_SESSIONS - 1) {
      progress(i + 1, TOTAL_SESSIONS, "sessions");
    }
  }
  progressEnd();

  console.log(`    Inserted ${inserted} sessions (target 200, deduped by user+challenge).`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const doReset = process.argv.includes("--reset");

  console.log(`\nBrandBlitz seed script${doReset ? " (--reset)" : ""}`);
  console.log("─".repeat(40));

  if (doReset) await resetFixtures();

  const userIds = await seedUsers();
  const brandIds = await seedBrands(userIds);
  const challengeIds = await seedChallenges(brandIds);
  await seedSessions(userIds, challengeIds);

  console.log("─".repeat(40));
  console.log("Seed complete.\n");
  console.log("Admin login: seed-admin@brandblitz.test");
  console.log(`Fixture logos: ${path.resolve(__dirname, "fixtures/logos/")}\n`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
