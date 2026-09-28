# 03 — Stellar & Soroban Architecture

## Overview

BrandBlitz uses Stellar for all on-chain operations: prize-pool custody, deposit detection, and winner payouts. The system is designed to be **non-custodial by default** — the platform never holds user funds. Prize pools are escrowed in a Soroban smart contract, deposits are detected via Soroban event polling, and payouts are settled atomically on-chain.

```
                          Stellar Network
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │  Soroban     │    │  Horizon     │    │  USDC (SAC)       │  │
│  │  Escrow      │◄───┤  RPC         │◄───┤  Token Contract   │  │
│  │  Contract    │    │  (events)    │    │                   │  │
│  └──────┬───────┘    └──────────────┘    └───────────────────┘  │
│         │                                                       │
│    settle(distro) / refund() / deposit(amount)                  │
└─────────┼────────────────────────────────────────────────────────┘
          │
          │  Soroban RPC    │  Horizon REST
          ▼                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                      BrandBlitz Backend                          │
│                                                                  │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │  Express API        │    │  Deposit Monitor Service        │ │
│  │  apps/api           │    │  apps/deposit-monitor           │ │
│  │                     │    │                                 │ │
│  │  • Payout Service   │    │  • Polls Soroban getEvents     │ │
│  │  • EscrowClient     │    │  • Detects USDC deposits       │ │
│  │  • Webhook handler  │    │  • Delivers webhook to API     │ │
│  └──────────┬──────────┘    └─────────────────────────────────┘ │
│             │                                                   │
│  ┌──────────▼──────────┐                                        │
│  │  packages/stellar   │                                        │
│  │  • escrow.ts        │  EscrowClient wrapper                  │
│  │  • deposit.ts       │  Deposit event polling                 │
│  │  • payout.ts        │  Batch USDC payout builder             │
│  │  • accounts.ts      │  Muxed address helpers                 │
│  │  • constants.ts     │  Network configs                       │
│  └─────────────────────┘                                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Brand Creates Challenge → Funds Escrow

```
Brand creates challenge via API ──→ challenge status = pending_deposit
                                        │
Brand sends USDC to Soroban escrow ──→  deposit(memo, amount)
                                        │
Deposit monitor detects Funded event ──→ challenge status = active
```

**Key files:**
- `packages/stellar/src/escrow.ts` — `EscrowClient.deposit()` calls the Soroban contract
- `apps/deposit-monitor/src/index.ts` — polls Soroban RPC `getEvents` for deposit detection
- `docs/adr/002-escrow-usage.md` — decision rationale for non-custodial escrow
- `docs/adr/003-escrow-implementation.md` — detailed implementation ADR

### 2. Challenge Ends → Payout Settlement

```
Challenge.ends_at passes
         │
BullMQ job fires → rank all sessions → calculate proportional shares
         │
    [SOROBAN_CONTRACT_ID configured?]
         │              │
        YES             NO
         │              │
 EscrowClient           submitBatchPayout
 .settle(recipients)    (direct hot-wallet transfer)
         │              │
  Atomic Soroban tx     Batch USDC Payment ops (≤50/tx)
         │              │
  Mark payouts sent     Mark payouts sent
         │
  Challenge status = settled
```

**Key files:**
- `packages/stellar/src/payout.ts` — `submitBatchPayout()` builds up to 50 Payment ops per transaction
- `packages/stellar/src/escrow.ts` — `EscrowClient.settle()` for atomic Soroban settlement
- `apps/api/src/services/payout.ts` — payout service with escrow fallback logic
- `contracts/contracts/escrow/` — Soroban smart contract source (Rust)

### 3. Refund Flow

If a challenge is cancelled before settlement:
- **Escrow path**: brand calls `refund()` on the contract; the contract enforces a grace-period gate before releasing funds
- **Direct path**: payouts service returns funds via hot-wallet transfer

---

## Key Components

### Soroban Escrow Contract

**Location**: `contracts/contracts/escrow/`

The contract holds USDC in a Soroban SAC (Stellar Asset Contract) wrapper. It exposes four main functions:

| Function | Description |
|---|---|
| `initialize(admin, token, memo)` | One-time setup per challenge |
| `deposit(depositor, amount)` | Brand funds the prize pool |
| `settle(recipients[])` | Atomic distribution to winners |
| `refund()` | Return pool to brand after grace period |

**Deployment**: `make deploy-testnet` / `make deploy-mainnet` (see `contracts/contracts/escrow/Makefile`)

### EscrowClient Wrapper

**Location**: `packages/stellar/src/escrow.ts`

TypeScript wrapper encapsulating Soroban SDK complexity:
- Handles transaction construction, signing, retry with exponential backoff
- Falls back to direct transfers when `SOROBAN_CONTRACT_ID` is not configured
- `generateAdminOperationXdr()` for offline co-signing of admin operations

### Deposit Monitor

**Location**: `apps/deposit-monitor/src/index.ts`

Background service that:
1. Polls Soroban RPC `getEvents` at a configurable interval
2. Detects `Funded` events matching the hot-wallet public key
3. Sends an HMAC-signed webhook to `POST /webhooks/stellar/deposit`
4. Tracks cursor position in Redis for resumability

### Batch Payout Builder

**Location**: `packages/stellar/src/payout.ts`

For the direct-transfer fallback path:
- Chunks winners into batches of ≤50 Payment ops
- Each batch submitted as one atomic Stellar transaction (~$0.0007 fee)
- Uses muxed accounts (no 2 XLM minimum reserve per user)

---

## Configuration

| Variable | Description | Source |
|---|---|---|
| `STELLAR_HOT_WALLET_SECRET` | Hot-wallet keypair seed | `.env` |
| `STELLAR_NETWORK` | `testnet` or `public` | `.env` |
| `STELLAR_HORIZON_URL` | Horizon REST endpoint | `.env` |
| `STELLAR_RPC_URL` | Soroban RPC endpoint | `.env` |
| `SOROBAN_CONTRACT_ID` | Deployed escrow contract ID (optional) | `.env` |
| `USDC_ISSUER` | USDC issuer address for the network | `.env` |
| `HOT_WALLET_PUBLIC_KEY` | Hot-wallet public key (deposit monitor) | `.env` |
| `WEBHOOK_SECRET` | HMAC key for webhook auth | `.env` |

---

## Fallback Behavior

The payout service checks for `SOROBAN_CONTRACT_ID` at runtime:

- **If set**: uses `EscrowClient.settle()` for atomic Soroban settlement (non-custodial)
- **If unset**: falls back to `submitBatchPayout()` (direct hot-wallet USDC transfers)

This allows:
- Gradual rollout per environment
- Quick recovery if the contract has issues
- Staging/testing without a deployed contract
- One-line disable: unset the env var, restart

---

## Monitoring & Alerting

| Metric | Description |
|---|---|
| `payout.escrow_settlement_total` | Successful Soroban settlements |
| `payout.escrow_settlement_failed_total` | Failed settlements |
| `payout.fallback_direct_transfer_total` | Fallback to direct transfers |
| `payout.settlement_latency_ms` | Time to settle via Soroban |
| `deposits.detected_total` | Deposits detected by monitor |
| `deposits.poll_errors_total` | Poll errors by type |

---

## References

- `docs/adr/002-escrow-usage.md` — Why non-custodial escrow (ADR)
- `docs/adr/003-escrow-implementation.md` — Implementation details & deployment checklist
- `docs/api/webhooks.md` — Webhook contract, signature verification, and retry semantics for integrators
- `ESCROW_IMPLEMENTATION.md` — Executive summary of escrow integration
- `packages/stellar/src/escrow.ts` — EscrowClient wrapper
- `packages/stellar/src/payout.ts` — Batch payout builder
- `packages/stellar/src/deposit.ts` — Deposit event polling helper
- `packages/stellar/src/accounts.ts` — Muxed account helpers
- `apps/deposit-monitor/src/index.ts` — Deposit monitor service
- `apps/api/src/services/payout.ts` — Payout service integration
- `contracts/contracts/escrow/` — Soroban contract source (Rust)