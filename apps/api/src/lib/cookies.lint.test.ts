import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

const SRC_DIR = join(__dirname, "..");
const HELPER_PATH = join(__dirname, "cookies.ts");
const TEST_FILE_PATH = join(__dirname, "cookies.lint.test.ts");

describe("cookie security lint", () => {
  it("no raw res.cookie() calls exist outside lib/cookies.ts", () => {
    const violations: string[] = [];

    for (const file of collectTsFiles(SRC_DIR)) {
      if (file === HELPER_PATH || file === TEST_FILE_PATH) continue;

      const src = readFileSync(file, "utf-8");
      if (/res\.cookie\s*\(/.test(src)) {
        violations.push(relative(SRC_DIR, file));
      }
    }

    expect(violations).toEqual([]);
  });
});
