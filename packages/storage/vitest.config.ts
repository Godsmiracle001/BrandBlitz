import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineProject } from "vitest/config";
import { sharedCoverageOptions } from "../../packages/config/src/vitest-base";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const sharedSetupFile = path.resolve(projectRoot, "../../tests/setup.ts");

export default defineProject({
  test: {
    name: "@brandblitz/storage",
    root: projectRoot,
    environment: "node",
    setupFiles: [sharedSetupFile],
    include: ["src/**/*.test.ts"],
    coverage: {
      ...sharedCoverageOptions,
      reportsDirectory: "./coverage",
      thresholds: {
        branches: 0,
        functions: 0,
        lines: 0,
        statements: 0,
      },
    },
  },
});
