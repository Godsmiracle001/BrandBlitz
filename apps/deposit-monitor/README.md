# deposit-monitor

Polls Stellar for USDC deposits matching open challenges and notifies the
API via a signed webhook (`POST /webhooks/stellar/deposit`) when a matching
deposit is detected.

## Local development

```
pnpm --filter @brandblitz/deposit-monitor dev
```

Requires the env vars in `apps/deposit-monitor/src/config.ts` (`REDIS_URL`,
`STELLAR_NETWORK`, `HOT_WALLET_PUBLIC_KEY`, `WEBHOOK_SECRET`, `API_URL`, ...).

## Testing the webhook locally without a real deposit

Running the full service against real testnet deposits (or hand-crafting a
signed curl request) is slow for iterating on the API side of this
integration. `scripts/simulate-deposit-webhook.ts` (run from the repo root)
builds a correctly-signed test payload and posts it to your local API,
using the exact same HMAC signing logic as `sendDepositWebhook()` in
`src/index.ts`:

```
WEBHOOK_SECRET=<same secret the local API uses> \
  pnpm simulate-deposit-webhook -- --memo <existing-challenge-uuid> [--tx-hash <64-hex>] [--amount <decimal>]
```

- `--memo` is required and should be an existing challenge's memo (see
  `scripts/seed-e2e-challenge.ts` to create one) — the API 404s on an
  unknown memo, which is itself a useful case to exercise.
- `--tx-hash` defaults to a random 64-character hex string if omitted.
- `--amount` is optional, matching the real webhook payload.
- `API_URL` defaults to `http://localhost:3001` (the API's default port);
  set it if your local API runs elsewhere.

The script exits non-zero and prints a clear error if `WEBHOOK_SECRET` is
unset, since a missing secret can't produce a signature the API's
`verify-webhook` middleware will accept.
