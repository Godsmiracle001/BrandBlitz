# Performance Investigation: Deposit Webhook & Job Queues

Issues #1109, #1102, #1103, #1104 — load-model analysis of the Stellar deposit
webhook and the three BullMQ queues under burst/scaled load.

**Methodology.** Each issue ships a runnable load-model suite (vitest, colocated
with the code) that measures the real CPU-bound parts of the pipeline (HMAC
signing/verification through `crypto.timingSafeEqual`, as called by
`verifyWebhook`) and models the I/O pipeline with production-representative
budgets:

| Constant | Value | Source |
| --- | --- | --- |
| Postgres round-trip p50 | 2 ms | pooled local query budget |
| Horizon REST call p50 | 300 ms | testnet REST call budget |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | 3 s | mid-size matview budget |
| Redis SCAN+DEL sweep | 25 ms | per sweep, 100-key batches |
| PG archive write throughput | 3,000 rows/s | sustained WAL-bound writes |
| Soroban envelope limit | 100 KB | protocol cap |
| Ledger close cadence | 5 s | Stellar consensus |

The numbers below come from running the committed suites' models; the
conclusions are anchored to the actual code in each handler. Rerun with:

```bash
npx vitest run --config apps/api/vitest.config.ts \
  apps/api/src/routes/webhooks.loadtest.test.ts \
  apps/api/src/queues/leaderboard-refresh.loadtest.test.ts \
  apps/api/src/queues/archive.loadtest.test.ts \
  apps/api/src/queues/payout.loadtest.test.ts
```

---

## #1109 — Load-test `POST /webhooks/stellar/deposit` under burst delivery

**Measured (harness run):**

| Burst | Per-event latency | Sustained drain | Backlog after 1 min |
| --- | --- | --- | --- |
| 100 events/min | ~308 ms | ~3.24 events/s | drains (−95/min) |
| 500 events/min | ~308 ms | ~3.24 events/s | **+305 events/min backlog** |
| 1000 events/min | ~308 ms | ~3.24 events/s | **+805 events/min backlog** |

- Signature verification (HMAC-SHA256 + `timingSafeEqual`) measured at
  **~51,000 verifications/sec** — crypto is *never* the bottleneck; it is
  <0.1% of per-event latency.
- The synchronous pipeline dominates: 4 Postgres round-trips (2 duplicate
  checks, memo lookup, status update) ≈ 8 ms, plus the **hot-wallet Horizon
  balance read (~300 ms)** executed on every single event.
- At 500+ events/min the handler drains slower than events arrive; the
  backlog grows without bound, and the sender's ~10 s response budget
  eventually turns backlog into timeout-induced retries (amplification).
- The `webhookLimiter` caps at 1000 requests/hour per IP, which itself starts
  rejecting bursts beyond 1000/hr before the handler does.

**Recommendations (in priority order):**
1. **Async offload (P0):** verify signature → enqueue a `deposit-processing`
   job → return `202`. Modeled enqueue cost 2 ms ⇒ ~30,000 events/min
   capacity; the worker owns balance-check + activation and can retry.
2. **Cache the hot-wallet balance (P1):** the USDC balance is identical for
   every event in a burst — a 10–30 s cache removes the Horizon call from the
   critical path entirely.
3. Collapse the two duplicate-check queries into one `UNION` lookup (P2).

---

## #1102 — Optimal BullMQ concurrency for `leaderboard-refresh`

**Measured (model run):** serialized refresh drain ceiling ≈ **19 jobs/min**
(3.0 s matview refresh + 25 ms Redis sweep). Concurrency settings 1/2/4/8
were modeled at 1x/2x/5x/10x baseline volume (100 jobs/hour baseline).

| Volume | Arrival/min | Drain (any concurrency) | Backlog after 1 h |
| --- | --- | --- | --- |
| 1x | 1.67/min | 19 | 0 |
| 2x | 3.33/min | 19 | 0 |
| 5x | 8.33/min | 19 | 0 |
| 10x | 16.67/min | 19 | 0 |

**Findings:**
- `createLeaderboardRefreshWorker` currently runs at BullMQ's default
  concurrency **1** — and that is already optimal, because **Postgres
  serializes `REFRESH ... CONCURRENTLY` on the same matview**. Workers beyond
  the first add pool connections and Redis churn but zero throughput
  (validated in the suite: drain at concurrency 8 === drain at concurrency 1).
- Even 10x baseline volume (16.7/min arrival) stays under the 19/min drain
  ceiling with concurrency 1 — zero steady backlog.
- Job dedupe (coalescing refreshes enqueued within a 10 s window into one
  execution) adds a **6x burst margin** beyond the 10x target.

**Recommendation:** keep **concurrency 1** and add job dedupe/coalescing (or
throttle by draining duplicate refresh jobs before execution). Raising
concurrency does not improve lag — it only consumes connections and can
trigger matview lock contention.

---

## #1103 — Archive queue throughput at 10x volume

**Measured (model run):** baseline = 500 challenges/run, ~8 sessions and
~25 round-scores each. Rows touched per run = round-score deletes +
session/challenge moves.

| Volume | Challenges | Rows touched | Single-tx job duration | PG write share | Backlog (6 runs) |
| --- | --- | --- | --- | --- | --- |
| 2x | 1,000 | 209,000 | **101 s** | 7.7% | 0 |
| 5x | 2,500 | 522,500 | **253 s** | 19.4% | 0 |
| 10x | 5,000 | 1,045,000 | **505 s (~8.4 min)** | 38.7% | 0 (while job fits in the window) |

**Findings:**
- The job archives EVERYTHING the predicate selects inside ONE transaction —
  duration scales linearly and the write lock/WAL pressure scales with it.
- At 10x volume the single transaction holds the write lock for ~8 minutes;
  sustained multi-row inserts drive the table toward bloat, and any statement
  timeout (or a checkpoint stall) rolls back the ENTIRE run — backlog then
  grows unbounded run over run.
- Concurrency is **not** the lever: the queue runs a single monthly cron job
  (`jobId: archive-monthly`), so a second worker would idle.

**Recommendation:** chunk the archival — e.g. 200 challenges per transaction,
looping until the predicate returns nothing. Modeled at 10x volume: 25 chunks
at **~14 s per chunk** — every transaction stays under a 1-minute write-lock
budget. A row-count guard (`LIMIT 200`) also makes repeated runs catch up
safely.

---

## #1104 — Payout queue scaling for large batches

**Code-level constraints (from `apps/api/src/services/payout.ts` and
`packages/stellar/src/escrow.ts`):**
1. `getLeaderboard(challengeId, 1000)` — hard cap of 1000 sessions per
   challenge; a 5k/10k-recipient batch is **unreachable today** (data loss
   beyond 1000 winners).
2. `EscrowClient.settle` sends ALL recipients in ONE `invokeHostFunction`
   transaction — Soroban's ~100 KB envelope limit and instruction budget cap
   recipients per settle tx at **~1,137** (modeled: 90 B/recipient envelope
   share, 1,200 instructions/recipient).
3. The settle chain is signed by the hot wallet — its sequence number
   serializes every transaction: **one confirmed settle per ~5 s ledger
   close, regardless of BullMQ concurrency**.

**Measured (model run):**

| Batch | Settle txs required | Queue drain time | Bottleneck |
| --- | --- | --- | --- |
| 1,000 | 1 | ~5.4 s | fits one tx (barely) |
| 5,000 | 5 | ~27 s | **Horizon ledger cadence** |
| 10,000 | 9 | ~49 s | **Horizon ledger cadence** |

**Findings:**
- Queue concurrency is never the bottleneck: raising
  `PAYOUT_WORKER_CONCURRENCY` cannot parallelize one hot wallet's sequence
  chain. Horizon/ledger cadence binds first — always.
- The current single-transaction `settle` cannot legally carry 5k+ recipients
  (envelope limit exceeded → submission failure → 5 retries → DLQ).
- Submission latency per settle tx (~400 ms RPC) is noise next to the 5 s
  ledger cadence.

**Recommendation:**
1. Page `getLeaderboard` (or raise the cap) before anything else.
2. Chunk settlements at **~200 recipients per settle tx** (~18 KB envelope —
   50x headroom): 1k → 5 txs, 5k → 25 txs, 10k → 50 txs.
3. Keep `PAYOUT_WORKER_CONCURRENCY = 2`; drain time for 10k ≈ 50 settle
   confirmations ≈ **4–5 minutes**, dominated by ledger cadence — the queue
   will never be the bottleneck. (If faster is ever required, the lever is
   multiple payout wallets, not worker concurrency.)

---

## Recommended implementation priority

| Priority | Item | Issue |
| --- | --- | --- |
| P0 | Async-offload the deposit webhook (verify → enqueue → 202) + cache hot-wallet balance | #1109 |
| P0 | Page `getLeaderboard` past 1000 sessions | #1104 |
| P1 | Chunk `EscrowClient.settle` at ~200 recipients | #1104 |
| P1 | Chunk the archive transaction (200 challenges/tx) | #1103 |
| P2 | Leaderboard refresh dedupe window (10 s coalescing) | #1102 |
| P2 | Collapse the webhook duplicate-check queries | #1109 |
