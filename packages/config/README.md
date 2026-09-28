# `@brandblitz/config`

Shared constants and configuration for BrandBlitz workspaces.

## Contents

| File                 | What it provides                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`       | `PERMISSIONS_POLICY_HEADER` — `Permissions-Policy` header value disabling camera, microphone, geolocation, and payment. |
| `src/vitest-base.ts` | `sharedCoverageOptions` — shared Vitest coverage options (`provider: "v8"`, `reporter: ["text", "html"]`).              |

## Shared Vitest configuration

Each workspace `vitest.config.ts` duplicates the same coverage options (v8
provider, `["text", "html"]` reporters), which makes it easy for thresholds or
reporters to drift between workspaces.

Import the shared options from `packages/config/src/vitest-base` and spread
them into the local `coverage` block. Workspace-specific settings (thresholds,
`include` lists, `reportsDirectory`) stay in each config:

```ts
import { sharedCoverageOptions } from "../../packages/config/src/vitest-base";

coverage: {
  ...sharedCoverageOptions,
  thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
},
```

To change the coverage provider or default reporters for every workspace,
update `src/vitest-base.ts` instead of editing each config.
