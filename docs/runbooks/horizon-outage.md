# Runbook: Stellar Horizon Outage

## Symptom

One or more of:

- Alert: `horizon_request_errors_total > 10 in 1 min`
- API logs: `connect ETIMEDOUT horizon.stellar.org` or `503 Service Unavailable`
- Payout jobs in BullMQ fail repeatedly with `Error: Request failed with status code 503`
- `/api/health` returns `{ stellar: "degraded" }` or `500`
- Users see "Payout failed" toasts despite valid challenge results

## Impact

| Component | Effect |
| --- | --- |
| Challenge payouts | **Blocked** — BullMQ jobs retry with exponential backoff; recipients are not paid until Horizon recovers |
| Balance checks | **Degraded** — hot-wallet balance reads fail; deposit monitoring halted |
| New challenges | **Unaffected** if Horizon is only used post-game |
| Leaderboards / UI | **Unaffected** — served from PostgreSQL |

## Diagnosis

```bash
# 1. Check Stellar public status page
curl -s https://horizon.stellar.org/fee_stats | jq .p50_accepted_fee
# Expected: a number — if this times out or returns 5xx, Horizon is down

# 2. Check testnet (if relevant)
curl -s https://horizon-testnet.stellar.org/fee_stats | jq .p50_accepted_fee

# 3. Check Stellar status page
# https://status.stellar.org — look for active incidents

# 4. Check BullMQ failed jobs
redis-cli LLEN bull:payout:failed
redis-cli LRANGE bull:payout:failed 0 4

# 5. Check API logs
docker compose logs api --tail=100 | grep -i "horizon\|stellar\|payout"
```

## Mitigation

1. **Do nothing destructive** — BullMQ is configured with `attempts: 3` and exponential backoff. Jobs will automatically retry when Horizon recovers.

2. If Horizon is degraded (slow, not down), enable the Soroban RPC fallback if implemented, or reduce payout batch size via `MAX_OPS_PER_TX` env override to lower per-request load.

3. If Horizon has been down > 15 min and jobs are exhausting retries, pause the payout queue to prevent DLQ fill:

   ```bash
   redis-cli LPUSH bull:payout:commands '{"cmd":"pause"}'
   # or use the BullMQ admin UI
   ```

4. Post a status update in the internal incident channel.

## Remediation

1. Wait for Stellar Foundation to restore Horizon (monitor <https://status.stellar.org>).

2. Once healthy, resume the payout queue:

   ```bash
   redis-cli LPUSH bull:payout:commands '{"cmd":"resume"}'
   ```

3. Retry failed payout jobs from the DLQ:

   ```bash
   # Move all failed jobs back to waiting
   # (use BullMQ admin UI or bull-board, or write a one-off script)
   node -e "
   const { Queue } = require('bullmq');
   const { redis } = require('./dist/lib/redis');
   const q = new Queue('payout', { connection: redis });
   q.retryJobs({ count: 1000 }).then(() => process.exit(0));
   "
   ```

4. Verify payouts resume by tailing API logs and checking BullMQ completed count.

5. Confirm affected users received their USDC via Horizon transaction history.

## Post-mortem

After resolution, file a post-mortem if the outage exceeded 30 minutes or affected > 50 users.
Link template: [post-mortem template](https://www.notion.so/brandblitz/post-mortem-template)

## Related

- [payout-stuck-in-queue.md](payout-stuck-in-queue.md)
- [hot-wallet-low-balance.md](hot-wallet-low-balance.md)
- `packages/stellar/src/client.ts` — shared HTTP agent config
- `packages/stellar/src/payout.ts` — batch submission logic
