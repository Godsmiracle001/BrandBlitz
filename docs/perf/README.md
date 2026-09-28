# Performance docs

| File                                                                             | What it covers                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`bundle-baseline.txt`](./bundle-baseline.txt)                                   | Committed web bundle baseline used by the budget check (see below). |
| [`api-scale-investigation-plan.md`](./api-scale-investigation-plan.md)           | API scaling investigation plan.                                     |
| [`high-volume-investigation-plan.md`](./high-volume-investigation-plan.md)       | High-volume load investigation plan.                                |
| [`metrics-overhead.md`](./metrics-overhead.md)                                   | Cost of Prometheus metrics collection.                              |
| [`question-regeneration-concurrency.md`](./question-regeneration-concurrency.md) | Concurrency notes for question regeneration.                        |
| [`session-start-burst-investigation.md`](./session-start-burst-investigation.md) | Synchronized 5k session-start burst load test at challenge open.    |

---

## Web bundle size tooling

Two scripts in the repo root [`scripts/`](../../scripts) folder read the Next.js build output
in `apps/web/.next/static/chunks/` and measure every `.js` file in it (raw and gzip size).

| Command                                   | Script                                                                   | Output                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| `node scripts/generate-bundle-report.mjs` | [`generate-bundle-report.mjs`](../../scripts/generate-bundle-report.mjs) | Report table printed to **stdout**      |
| `pnpm check:bundle`                       | [`check-bundle-budget.mjs`](../../scripts/check-bundle-budget.mjs)       | Budget summary printed to stdout/stderr |

### Prerequisites

1. **Build the web app first.** Both scripts only read files that already exist, so without a
   build there is nothing to measure:

   ```bash
   pnpm --filter @brandblitz/web build   # or `pnpm build` for the whole monorepo
   ```

2. **Run from the repository root.** Both scripts use paths relative to the current directory
   (`apps/web/.next/static/chunks` and `docs/perf/bundle-baseline.txt`). `pnpm check:bundle` is a
   root `package.json` script, so pnpm runs it from the root for you. If you call `node` directly,
   `cd` to the root first.

### `generate-bundle-report.mjs`: where the report goes

The script does **not** write a file. It prints the report to stdout and exits. Nothing is
created under `.next/`, `docs/`, or anywhere else. To keep a copy, redirect it:

```bash
node scripts/generate-bundle-report.mjs                       # view in the terminal
node scripts/generate-bundle-report.mjs > /tmp/bundle-report.txt
```

Format (the same format as `bundle-baseline.txt`):

```text
Bundle Baseline Report
======================
File                                                         |       Size |       Gzip
-------------------------------------------------------------------------------------
9304.cb38e2ec68c55a48.js                                     |     451984 |     148159
app/leaderboard/page-0668a7b2c87e83ac.js                     |      10494 |       3788
...
```

- Four header lines, then one row per chunk: `path | size | gzip`.
- `File` is relative to `apps/web/.next/static/chunks/`. `app/...` entries are per-route chunks.
- `Size` is raw bytes and `Gzip` is bytes after `zlib.gzipSync`.
- Rows are sorted by gzip size (largest first). Only the **top 20** chunks are printed.
- If `apps/web/.next/static/chunks` is missing, the script exits with an `ENOENT` error. Build first.

### `check-bundle-budget.mjs` (`pnpm check:bundle`)

```bash
pnpm --filter @brandblitz/web build
pnpm check:bundle
```

What it does:

- Sums the `Gzip` column of every row in `docs/perf/bundle-baseline.txt` (after the 4 header lines).
- Sums the gzip size of **every** `.js` file currently in `apps/web/.next/static/chunks/`.
- Prints both totals and the difference. If the current total is more than **10%** above the
  baseline, it prints `::warning::Bundle size regressed by more than 10%!`.
- The baseline file only lists the top 20 chunks, but the current total counts every chunk. Even
  with no real change, the current total can come out somewhat above the baseline sum.
- The check only warns. It always exits `0`, so look for the warning line in the output.
- If `docs/perf/bundle-baseline.txt` is missing, it prints `No baseline found, skipping budget check.`
- If you haven't built, `Current Total Gzip` is `0` and the check reports "within budget".
  That result is meaningless. Build first.

### Troubleshooting a bundle size warning

1. Reproduce locally: `pnpm --filter @brandblitz/web build && pnpm check:bundle`.
2. Find which chunks grew by comparing the current report against the committed baseline:

   ```bash
   node scripts/generate-bundle-report.mjs > /tmp/bundle-report.txt
   diff docs/perf/bundle-baseline.txt /tmp/bundle-report.txt
   ```

   Chunk filenames include content hashes, so a changed chunk shows up as a removed row plus an
   added row. Compare by size and position, not by name.

3. To see what is inside a large chunk, use the bundle analyzer:
   `pnpm --filter @brandblitz/web analyze` (see [`apps/web/README.md`](../../apps/web/README.md#building--running)).
4. Only refresh the baseline when a size increase is intentional and agreed in review, and do it in
   its own commit:

   ```bash
   node scripts/generate-bundle-report.mjs > docs/perf/bundle-baseline.txt
   ```

   Use `node` directly, or `pnpm -s`. Plain `pnpm run` adds a `> brandblitz@…` banner to stdout,
   which would corrupt the baseline's header.
