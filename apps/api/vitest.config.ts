import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineProject } from "vitest/config";
import { sharedCoverageOptions } from "../../packages/config/src/vitest-base";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const sharedSetupFile = path.resolve(projectRoot, "../../tests/setup.ts");

export default defineProject({
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src"),
      "@brandblitz/config": path.resolve(projectRoot, "../../packages/config/src"),
      "@brandblitz/storage": path.resolve(projectRoot, "../../packages/storage/src"),
      "@brandblitz/stellar": path.resolve(projectRoot, "../../packages/stellar/src"),
    },
  },
  test: {
    name: "@brandblitz/api",
    root: projectRoot,
    globals: true,
    environment: "node",
    envDir: projectRoot,
    envFiles: [".env.test"],
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
