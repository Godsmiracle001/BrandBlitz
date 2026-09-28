# Funding a Challenge

This guide explains how brand admins fund a challenge with USDC to activate it for players.

## Overview

After creating a challenge and approving its questions, the challenge enters a `pending_deposit` status. A brand admin must send USDC to the platform's hot wallet with a specific memo to activate the challenge.

## Step 1: Retrieve Deposit Instructions

Call the deposit-info endpoint to get the address, memo, and amount:

```
GET /challenges/:id/deposit-info
```

**Response:**

```json
{
  "depositInfo": {
    "hotWalletAddress": "G...",
    "memo": "abc123def456...",
    "amount": 10.00
  }
}
```

| Field | Description |
|-------|-------------|
| `hotWalletAddress` | The Stellar address to send USDC to |
| `memo` | A unique memo string — **must be included** in the transaction |
| `amount` | The USDC amount to fund the challenge pool |

**Access restrictions:** Only the brand owner can call this endpoint. Returns 403 for non-owners and 400 if the challenge is not in `pending_deposit` status.

## Step 2: Send USDC with the Memo

Using your Stellar wallet or USDC-capable tool:

1. Create a payment transaction to the `hotWalletAddress`
2. Set the amount to the value returned by the API
3. **Include the memo exactly as returned** — this is how the platform matches your deposit to the challenge

## Why the Memo Matters

The memo is the unique identifier that links your USDC deposit to the specific challenge. Without it, the platform cannot automatically reconcile the payment and activate the challenge.

**Do not manually construct transactions without the memo.** See `DEPOSIT_MEMO_FIX.md` in the repository root for the security background on why deposit details are fetched server-side rather than passed through URLs.

## Step 3: Confirmation

After sending the USDC transaction:

- The platform's hot wallet monitors incoming payments and matches them by memo
- Once confirmed on the Stellar network, the challenge status transitions from `pending_deposit` to `active`
- Confirmation typically takes a few seconds on Stellar, but may take longer during network congestion

The challenge page will update automatically once the deposit is detected.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Challenge is not pending deposit" (400) | The challenge is already funded or in a different status |
| "Forbidden" (403) | You are not the brand owner for this challenge |
| Deposit not detected | Ensure the memo was included exactly. Check the transaction on a Stellar explorer. |
| Amount mismatch | Send the exact amount returned by the API |

## Related

- [Question Review Workflow](./question-review-workflow.md) — review and approve questions before funding
- `DEPOSIT_MEMO_FIX.md` — security background on memo handling
