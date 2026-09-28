# Stellar Wallet Connection and Payout Flow

This guide explains how to link a Stellar wallet address to your BrandBlitz account and how USDC prize payouts are settled to that address.

## Overview

BrandBlitz pays out challenge prizes in **USDC on the Stellar network**. To receive payouts you must:

1. Have a Stellar wallet that holds a USDC trustline.
2. Link your wallet address to your BrandBlitz account via `PATCH /users/me/wallet`.
3. Win or earn rewards — payouts are settled on-chain automatically.

---

## Step 1 — Link Your Stellar Wallet

### Endpoint

```
PATCH /users/me/wallet
Authorization: Bearer <access_token>
Content-Type: application/json
```

### Request body

```json
{
  "stellarAddress": "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"
}
```

### Response

```json
{ "success": true }
```

### Validation rules

| Rule | Detail |
|---|---|
| Length | 56 – 70 characters |
| Format | Must be a valid Stellar public key (`G...`) |
| Uniqueness | One wallet address per account |

> **Update your address?** Call the same endpoint with the new address. The old address is replaced immediately. In-flight payouts that are already queued will complete to the old address — contact support if you need to redirect an in-flight payout.

---

## Step 2 — Establish a USDC Trustline

Before BrandBlitz can send USDC to your wallet, the wallet must have an explicit **trustline** for the USDC asset issued by Centre (the Circle/Coinbase issuer on Stellar).

**USDC asset details on Stellar:**

| Field | Value |
|---|---|
| Asset code | `USDC` |
| Issuer (mainnet) | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| Issuer (testnet) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |

Most Stellar wallets (Lobstr, Freighter, Solar) let you add trustlines from their asset search screen. You can also add one programmatically:

```js
import { Asset, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const usdcAsset = new Asset(
  "USDC",
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
);
const op = Operation.changeTrust({ asset: usdcAsset });
```

If your wallet has no USDC trustline, BrandBlitz will hold your payout in escrow and retry after 24 hours. After three failed attempts you will receive an email notification.

---

## Step 3 — How Payout Shares Are Calculated

BrandBlitz challenges define a **prize pool** funded by the sponsoring brand. When a challenge closes, the backend runs a proportional settlement:

```
share_i = (score_i / Σ scores) × prize_pool_usdc
```

Where:

- `score_i` — the player's final score for the challenge.
- `Σ scores` — the sum of all eligible participant scores.
- `prize_pool_usdc` — the total USDC amount locked in the challenge escrow account.

Minimum payout threshold is **1 USDC**. Shares below this threshold are accumulated and rolled into the player's next payout cycle.

Fees are covered by the platform — players receive their full calculated share.

---

## Step 4 — Settlement on Chain

Once shares are calculated the platform submits a **Stellar batch payment transaction** from the challenge escrow account to each winning wallet address.

| Metric | Typical value |
|---|---|
| Settlement time | 3 – 5 seconds |
| Transaction fee | ~$0.0007 per payment operation |
| Fee payer | BrandBlitz platform |
| Memo | `BRANDBLITZ:<challenge_id>` |

You can verify your payout on any Stellar block explorer (Stellar Expert, StellarChain) by searching for your wallet address and filtering by the `BRANDBLITZ:` memo prefix.

---

## Frequently Asked Questions

**Can I link a custodial exchange address?**
Only link a wallet address you control directly. Exchange deposit addresses do not have USDC trustlines and payouts will fail.

**What happens if my address is invalid?**
The `PATCH /users/me/wallet` endpoint validates the address format. If validation passes but the address has no USDC trustline, payouts will be retried up to three times before the amount is held for manual review.

**Is there a minimum payout?**
Yes — 1 USDC. Smaller accumulated amounts carry forward to your next settlement cycle.

---

## Related

- [Earnings page](/profile/[username]/earnings)
- [Stellar Architecture](../../03-stellar-architecture.md)
- [README — Stellar Integration](../../README.md#stellar-integration)
