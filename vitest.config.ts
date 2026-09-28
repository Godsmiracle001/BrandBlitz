import { defineConfig } from "vitest/config";
import { sharedCoverageOptions } from "./packages/config/src/vitest-base";

export default defineConfig({
  test: {
    projects: [
      "./apps/api/vitest.config.ts",
      "./apps/web/vitest.config.ts",
      "./packages/stellar/vitest.config.ts",
      "./packages/storage/vitest.config.ts",
    ],
    coverage: {
      ...sharedCoverageOptions,
      thresholds: {
        branches: 0,
        functions: 0,
        lines: 0,
        statements: 0,
      },
    },
  },
});
