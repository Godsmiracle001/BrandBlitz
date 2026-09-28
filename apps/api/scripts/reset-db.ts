/**
 * Full local PostgreSQL reset.
 *
 * Drops and recreates the entire schema (wiping ALL data), then reapplies every
 * forward migration so the database matches a fresh install. Optionally
 * re-creates the seed fixtures afterwards.
 *
 * Usage:
 *   pnpm --filter @brandblitz/api db:reset            # drop + re-migrate
 *   pnpm --filter @brandblitz/api db:reset --seed     # drop + re-migrate + seed
 *   pnpm db:reset -- --seed                           # from the monorepo root
 *
 * Safety: this wipes every table in the target database. By default the script
 * refuses to run against non-local hosts; pass `--force` only if you are sure.
 */

import "dotenv/config";
import { spawnSync } from "child_process";
import path from "path";
import { Pool } from "pg";

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/brandblitz";

const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const url = new URL(connectionString);
const isLocalHost =
  url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";

if (!isLocalHost && !process.argv.includes("--force")) {
  console.error(
    `Refusing to reset non-local database host "${url.hostname}". ` +
      "This wipes ALL data in the target database. Point DATABASE_URL at a local " +
      "PostgreSQL instance, or pass --force to override."
  );
  process.exit(1);
}

process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;

const pool = new Pool({ connectionString, max: 1 });

// Re-run the existing pnpm scripts so the reset always uses the same logic as
// the normal migrate/seed workflows.
function runWorkspaceScript(args: string[], label: string): void {
  console.log(`\n${label}…`);
  const npmExecPath = process.env.npm_execpath;
  const cmd = npmExecPath ? process.execPath : "pnpm";
  const cmdArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(cmd, cmdArgs, {
    cwd: path.resolve(__dirname, "../../../"),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Failed to run ${args.join(" ")}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const doSeed = process.argv.includes("--seed");

  console.log(`\nBrandBlitz local database reset${doSeed ? " (--seed)" : ""}`);
  console.log("─".repeat(40));
  console.log(`Target: ${url.host}`);

  console.log("\nDropping and recreating the public schema…");
  await pool.query("DROP EXTENSION IF EXISTS pgcrypto CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  console.log("Schema recreated.");

  runWorkspaceScript(["--filter", "@brandblitz/api", "migrate"], "Reapplying migrations");

  if (doSeed) {
    runWorkspaceScript(["--filter", "@brandblitz/api", "seed"], "Seeding fixtures");
  }

  console.log("\n─".repeat(40));
  console.log("Local database reset complete.");
}

main()
  .catch((err) => {
    console.error("Reset failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => undefined));
