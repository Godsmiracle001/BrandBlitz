import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineProject } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sharedCoverageOptions } from "../../packages/config/src/vitest-base";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "./src"),
    },
  },
  test: {
    name: "@brandblitz/web",
    root: projectRoot,
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      ...sharedCoverageOptions,
      include: [
        "src/components/brand/brand-kit-form.tsx",
        "src/components/brand/upload-field.tsx",
        "src/components/game/countdown-timer.tsx",
        "src/components/game/challenge-round.tsx",
        "src/components/game/warmup-phase.tsx",
        "src/components/game/result-screen.tsx",
      ],
      reporter: ["text", "lcov", "json", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
