# Runbook: Hot Wallet Low Balance

## Symptom

One or more of:

- Alert: `hot_wallet_usdc_balance_xlm < LOW_BALANCE_THRESHOLD` (default 50 USDC)
- Payout jobs fail with `op_underfunded` in the Stellar transaction result
- API logs: `PayoutError: insufficient balance for payment`
- Users report "Payout failed" after challenge completion

## Impact

| Component | Effect |
| --- | --- |
| Challenge payouts | **Blocked for all new challenges** until balance is restored |
| In-flight challenges | Games in progress continue; only the payout step fails |
| Brand deposits | **Unaffected** — deposited to a separate custody account |
| Leaderboards / UI | **Unaffected** |

## Diagnosis

```bash
# 1. Check current hot wallet balance via Horizon
HOT_WALLET_PUB=$(grep HOT_WALLET_PUBLIC_KEY .env | cut -d= -f2)
curl -s "https://horizon.stellar.org/accounts/${HOT_WALLET_PUB}" \
  | jq '.balances[] | select(.asset_code == "USDC")'

# Expected output:
# { "balance": "123.4500000", "asset_code": "USDC", ... }

# 2. Check the minimum XLM balance (needed for base reserve + fee buffer)
curl -s "https://horizon.stellar.org/accounts/${HOT_WALLET_PUB}" \
  | jq '.balances[] | select(.asset_type == "native")'

# 3. Check how many pending payout jobs exist
redis-cli LLEN bull:payout:waiting
redis-cli LLEN bull:payout:active
redis-cli LLEN bull:payout:failed
```

## Mitigation

If payouts are already failing, **pause new challenge starts** to prevent additional debt:

```bash
# Set an env flag or feature flag to block new games
# (or scale down the challenge start rate limiter temporarily)
```

Do NOT delete or drain the payout queue — jobs must be retried once funded.

## Remediation

### 1. Identify the funding source

USDC in the hot wallet comes from brand deposits. If multiple brands deposited, the custodian account should be routing funds automatically. Investigate why routing stopped before manually funding.

### 2. Transfer USDC to the hot wallet

```bash
# Identify the custodian or treasury account address
CUSTODIAN_PUB=<get from ops secrets>

# Check custodian balance
curl -s "https://horizon.stellar.org/accounts/${CUSTODIAN_PUB}" \
  | jq '.balances[] | select(.asset_code == "USDC")'

# Execute a manual transfer using the Stellar Laboratory or a signed CLI tool:
# Send enough USDC to cover pending payouts + a 20% buffer.
# Minimum safe top-up: (pending_jobs × avg_payout_usdc) × 1.2
```

### 3. Verify the balance

```bash
curl -s "https://horizon.stellar.org/accounts/${HOT_WALLET_PUB}" \
  | jq '.balances[] | select(.asset_code == "USDC") | .balance'
```

### 4. Retry failed payout jobs

```bash
node -e "
const { Queue } = require('bullmq');
const { redis } = require('./dist/lib/redis');
const q = new Queue('payout', { connection: redis });
q.retryJobs({ count: 1000 }).then(() => { console.log('done'); process.exit(0); });
"
```

### 5. Resume normal game operations

Remove any temporary rate-limit or game-start blocks applied in mitigation.

### 6. Adjust the low-balance alert threshold

If this was triggered prematurely, adjust `LOW_BALANCE_THRESHOLD` in the monitoring config to a more appropriate value.

## Post-mortem

File a post-mortem if the wallet was dry for > 10 minutes or > 20 payouts failed.
Investigate: why was the auto-funding pipeline not triggered? Is there a brand deposit stuck upstream?

Link template: [post-mortem template](https://www.notion.so/brandblitz/post-mortem-template)

## Related

- [horizon-outage.md](horizon-outage.md)
- [payout-stuck-in-queue.md](payout-stuck-in-queue.md)
- `packages/stellar/src/payout.ts` — submitBatchPayout
- `packages/stellar/src/accounts.ts` — balance query helpers
