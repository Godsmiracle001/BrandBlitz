import "dotenv/config";
import { readFile, readdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Pool, type PoolClient } from "pg";

const command = process.argv[2] ?? "up";
const rollbackCount = Number.parseInt(process.argv[3] ?? "1", 10);
const databaseUrl = process.env.DATABASE_URL;

// `lint` only checks filenames on disk — it needs no database connection.
if (!databaseUrl && command !== "lint") {
  console.error("DATABASE_URL is required to run migrations");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../migrations");

type MigrationFile = {
  file: string;
  upPath: string;
  downPath: string | null;
};

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

async function listMigrations(): Promise<MigrationFile[]> {
  const dirEntries = await readdir(migrationsDir, { withFileTypes: true });
  const names = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && !entry.name.endsWith(".down.sql"))
    .map((entry) => entry.name)
    .sort();
  const knownNames = new Set(dirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  return names.map((file) => {
    const downFile = file.replace(/\.sql$/, ".down.sql");
    return {
      file,
      upPath: path.join(migrationsDir, file),
      downPath: knownNames.has(downFile) ? path.join(migrationsDir, downFile) : null,
    };
  });
}

async function ensureMigrationTables(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_lock (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO schema_migration_lock (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedVersions(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY applied_at ASC, version ASC"
  );
  return new Set(result.rows.map((row) => row.version));
}

async function withLockedTransaction<T>(
  handler: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureMigrationTables(client);
    await client.query("SELECT id FROM schema_migration_lock WHERE id = 1 FOR UPDATE");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runUp(): Promise<void> {
  const migrations = await listMigrations();

  await withLockedTransaction(async (client) => {
    const applied = await getAppliedVersions(client);
    const pending = migrations.filter((migration) => !applied.has(migration.file));

    if (pending.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const migration of pending) {
      const sql = await readFile(migration.upPath, "utf8");
      console.log(`Applying ${migration.file}`);
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.file]);
    }
  });

  await pool.query("ANALYZE");
  console.log("Migration ANALYZE complete.");
}

async function runDryRun(): Promise<void> {
  const migrations = await listMigrations();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureMigrationTables(client);
    const applied = await getAppliedVersions(client);
    const pending = migrations.filter((migration) => !applied.has(migration.file));
    await client.query("ROLLBACK");

    if (pending.length > 0) {
      const pendingList = pending.map((migration) => `- ${migration.file}`).join("\n");
      throw new Error(`Pending migrations:\n${pendingList}`);
    }

    console.log("All migrations have already been applied.");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures while surfacing the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runDown(count: number): Promise<void> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Rollback count must be a positive integer");
  }

  const migrations = await listMigrations();

  await withLockedTransaction(async (client) => {
    const applied = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC"
    );
    const targets = applied.rows.slice(0, count);

    if (targets.length === 0) {
      console.log("No applied migrations to roll back.");
      return;
    }

    const migrationByName = new Map(migrations.map((migration) => [migration.file, migration]));

    for (const target of targets) {
      const migration = migrationByName.get(target.version);
      if (!migration?.downPath) {
        throw new Error(`Migration ${target.version} is forward-only and cannot be rolled back`);
      }

      const downSql = await readFile(migration.downPath, "utf8");
      console.log(`Rolling back ${target.version}`);
      await client.query(downSql);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [target.version]);
    }
  });

  await pool.query("ANALYZE");
  console.log("Rollback ANALYZE complete.");
}

// Canonical filename pattern documented in docs/database/migrations.md:
// <5-digit-zero-padded-sequence>-<kebab-case-description>[.down].sql
const MIGRATION_FILENAME_PATTERN = /^\d{5}-[a-z0-9]+(-[a-z0-9]+)*(\.down)?\.sql$/;

// Migrations that predate the canonical naming convention. Renaming them
// would require a downtime-inducing schema_migrations rewrite, so they're
// grandfathered in — only *new* migration files are required to match
// MIGRATION_FILENAME_PATTERN. See docs/database/migrations.md.
const LEGACY_EXEMPT_FILES = new Set([
  "00000-initial.sql",
  "00001-hot-path-indexes.sql",
  "00001-hot-path-indexes.down.sql",
  "00002-refunds.sql",
  "00003-soft-delete.sql",
  "00012-cursor-pagination-indexes.sql",
  "0006-leaderboard-mv.sql",
  "0007-archive-tables.sql",
  "0010-legal-docs.sql",
  "0011-session-round-scores-cascade.sql",
  "0012-multisig-escrow.sql",
  "0013-deposit-confirmations.sql",
  "0014-fee-bump-payouts.sql",
  "0015_idx_audit_log_entity_key.down.sql",
  "0015_idx_audit_log_entity_key.sql",
  "0016_idx_game_sessions_flagged.down.sql",
  "0016_idx_game_sessions_flagged.sql",
  "0017-waitlist.down.sql",
  "0017-waitlist.sql",
  "0018-challenges-reported-count.down.sql",
  "0018-challenges-reported-count.sql",
  "0019-users-last-active-at.down.sql",
  "0019-users-last-active-at.sql",
  "0020-app-config-updated-by.down.sql",
  "0020-app-config-updated-by.sql",
  "0021_session_round_scores_reaction_time.down.sql",
  "0021_session_round_scores_reaction_time.sql",
  "0022_brands_question_template.down.sql",
  "0022_brands_question_template.sql",
  "0023_session_abandon_reason.down.sql",
  "0023_session_abandon_reason.sql",
  "0024-username-unique-partial.down.sql",
  "0024-username-unique-partial.sql",
  "0025-brand-webhooks.down.sql",
  "0025-brand-webhooks.sql",
  "0026-challenge-templates.down.sql",
  "0026-challenge-templates.sql",
]);

async function runLint(): Promise<void> {
  const dirEntries = await readdir(migrationsDir, { withFileTypes: true });
  const sqlFiles = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const invalid = sqlFiles.filter(
    (file) => !LEGACY_EXEMPT_FILES.has(file) && !MIGRATION_FILENAME_PATTERN.test(file)
  );

  if (invalid.length > 0) {
    console.error("New migration filenames must match <NNNNN>-<kebab-case-description>[.down].sql:");
    for (const file of invalid) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  console.log(`All ${sqlFiles.length} migration filenames are valid (canonical or grandfathered).`);
}

async function main(): Promise<void> {
  try {
    if (command === "up") {
      await runUp();
      return;
    }

    if (command === "dryrun") {
      await runDryRun();
      return;
    }

    if (command === "down") {
      await runDown(rollbackCount);
      return;
    }

    if (command === "lint") {
      await runLint();
      return;
    }

    throw new Error(`Unknown migration command: ${command}`);
  } finally {
    if (command !== "lint") {
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
