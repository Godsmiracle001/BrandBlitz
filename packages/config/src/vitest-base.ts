/**
 * Shared Vitest configuration options for BrandBlitz workspaces.
 *
 * Coverage provider and default reporters are defined once here so package
 * configs (apps/api, apps/web, packages/stellar, packages/storage, root) can
 * spread these options instead of duplicating them, preventing drift between
 * workspaces.
 *
 * Usage in a vitest.config.ts:
 *
 *   import { sharedCoverageOptions } from "../../packages/config/src/vitest-base";
 *
 *   coverage: {
 *     ...sharedCoverageOptions,
 *     thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
 *   },
 */
export const sharedCoverageOptions = {
  provider: "v8",
  reporter: ["text", "html"],
} as const;
