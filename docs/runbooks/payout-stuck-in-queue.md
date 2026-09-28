# Runbook: Payout Stuck in Queue

## Symptom

One or more of:

- Alert: `bull_payout_waiting_count > 50 for > 5 min`
- Alert: `bull_payout_active_count == 0 AND waiting_count > 0` (worker not consuming)
- Users report winning challenges but not receiving USDC after > 2 minutes
- BullMQ dashboard shows jobs in `waiting` or `delayed` for an unexpected duration
- API logs show no `payout.processor` entries for > 5 min

## Impact

| Component | Effect |
| --- | --- |
| Payout delivery | **Delayed** — winning users do not receive USDC |
| Challenge UX | Users see pending state indefinitely |
| Data integrity | **No data loss** — jobs are durable in Redis |

## Diagnosis

```bash
# 1. Check queue depths
redis-cli LLEN bull:payout:waiting
redis-cli LLEN bull:payout:active
redis-cli LLEN bull:payout:delayed
redis-cli LLEN bull:payout:failed

# 2. Check if the worker process is running
docker compose ps worker
# or: ps aux | grep "node.*worker"

# 3. Check worker logs for errors
docker compose logs worker --tail=100 | grep -E "error|payout|SIGTERM"

# 4. Inspect the first waiting job
redis-cli LRANGE bull:payout:waiting 0 0 | python3 -m json.tool

# 5. Check Redis connectivity from within the worker container
docker compose exec worker redis-cli -h redis PING
# Expected: PONG

# 6. Check for stalled jobs (active but not progressing)
redis-cli SMEMBERS bull:payout:stalled-check

# 7. Check Horizon health (payout failures may be Horizon-related)
curl -s https://horizon.stellar.org/fee_stats | jq .p50_accepted_fee
```

## Mitigation

### Worker is down — restart it

```bash
docker compose restart worker
# Wait 30 seconds, then check
docker compose logs worker --tail=20
redis-cli LLEN bull:payout:active  # should be > 0 if jobs are pending
```

### Jobs are in `delayed` due to backoff

This is expected after retryable failures (Horizon errors, bad-seq). Wait for the delay to expire — BullMQ will automatically move them back to `waiting`.

To check when jobs become ready:

```bash
redis-cli ZRANGE bull:payout:delayed 0 -1 WITHSCORES \
  | awk 'NR%2==0 {print strftime("%Y-%m-%d %H:%M:%S", $1/1000)}'
```

### Jobs are stalled (stuck in `active` with no worker consuming)

```bash
# BullMQ auto-detects stalled jobs every stalledInterval ms.
# Force a stall check:
node -e "
const { Queue } = require('bullmq');
const { redis } = require('./dist/lib/redis');
const q = new Queue('payout', { connection: redis });
q.obliterate({ force: false }).then(() => process.exit(0)); // do NOT use obliterate in prod
"
# INSTEAD, use retryJobs to re-queue stalled jobs safely:
node -e "
const { Queue } = require('bullmq');
const { redis } = require('./dist/lib/redis');
const q = new Queue('payout', { connection: redis });
q.retryJobs({ count: 500, state: 'active' }).then(() => process.exit(0));
"
```

## Remediation

1. Identify root cause from worker logs (Horizon down, Redis OOM, bad job data, worker crash).
2. Apply the appropriate fix:
   - Horizon degraded → see [horizon-outage.md](horizon-outage.md)
   - Hot wallet underfunded → see [hot-wallet-low-balance.md](hot-wallet-low-balance.md)
   - Worker OOM → increase `worker` service memory limit in `docker-compose.prod.yml`
   - Bad job payload → inspect job data, fix the producer, manually remove the bad job

3. Once the root cause is fixed, retry failed jobs:

   ```bash
   node -e "
   const { Queue } = require('bullmq');
   const { redis } = require('./dist/lib/redis');
   const q = new Queue('payout', { connection: redis });
   q.retryJobs({ count: 1000 }).then(() => process.exit(0));
   "
   ```

4. Monitor queue depth until it drains to 0:

   ```bash
   watch -n5 "redis-cli LLEN bull:payout:waiting && redis-cli LLEN bull:payout:active"
   ```

5. Verify affected users received USDC by querying payout audit logs or Horizon transaction history.

## Post-mortem

File a post-mortem if > 100 jobs were delayed by > 15 minutes.

Link template: [post-mortem template](https://www.notion.so/brandblitz/post-mortem-template)

## Related

- [horizon-outage.md](horizon-outage.md)
- [hot-wallet-low-balance.md](hot-wallet-low-balance.md)
- `apps/api/src/queues/payout.queue.ts` — queue definition and retry config
- `apps/api/src/queues/processors/payout.processor.ts` — job processor
- `packages/stellar/src/payout.ts` — batch submission
