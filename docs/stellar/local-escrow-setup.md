# Local escrow setup — build, deploy, and wire up the Soroban contract

This is the single end-to-end flow for a contributor who does **not** normally
work on the Rust contract but needs a live escrow contract on Stellar testnet to
exercise escrow-integrated payout code (`apps/api/src/services/payout.ts`,
`packages/stellar/src/escrow.ts`) locally.

By the end you will have:

1. Built the `escrow` contract to WASM.
2. Deployed it to Stellar testnet.
3. Set `SOROBAN_CONTRACT_ID` in your `.env` so the payout service routes through
   the contract instead of doing direct transfers.

If you only want to run the API and don't care about on-chain settlement, you can
skip this entirely — see [Fallback behavior](#fallback-behavior-soroban_contract_id-unset)
at the bottom.

---

## Prerequisites

| Tool | Install | Notes |
|---|---|---|
| Rust toolchain | <https://rustup.rs> | Needed for `cargo` |
| `wasm32v1-none` target | `rustup target add wasm32v1-none` | Build target the Makefile emits |
| Stellar CLI 25 | `cargo install --locked stellar-cli@25 --features opt` | Provides the `stellar` command |

All commands below are run from `contracts/contracts/escrow` (the directory that
holds the [`Makefile`](../../contracts/contracts/escrow/Makefile)), unless noted.

```bash
cd contracts/contracts/escrow
```

---

## 1. Build the contract

Run the contract's own test suite first — CONTRIBUTING.md requires `cargo test`
output on any PR that touches `contracts/escrow/`, and it's the fastest way to
confirm your toolchain is healthy (the tests use an in-process mock Stellar
environment, so no network is needed):

```bash
cargo test
```

Then build the deployable WASM. The `build` target wraps `stellar contract build`
and prints the resulting artifact:

```bash
make build
# → target/wasm32v1-none/release/escrow.wasm
```

`cargo build` alone will compile the crate but does **not** produce the
Soroban-optimized `wasm32v1-none` artifact that the deploy step uploads — always
go through `make build` (or `stellar contract build` directly).

---

## 2. Create and fund a testnet identity

The deploy target signs with whatever identity you pass as `STELLAR_ACCOUNT`, so
you need one Stellar CLI identity that exists and is funded on testnet.

```bash
# Create a local keypair named "blitz-local"
stellar keys generate blitz-local --network testnet

# Fund it from friendbot
stellar keys fund blitz-local --network testnet
```

You can reuse an existing key instead:

```bash
stellar keys add blitz-local --secret-key S...   # e.g. your STELLAR_HOT_WALLET_SECRET
```

---

## 3. Deploy to testnet

Use the [`deploy-testnet`](../../contracts/contracts/escrow/Makefile) target
already present in the escrow Makefile. It depends on `build`, so it rebuilds the
WASM first, then runs `stellar contract deploy` against
`https://soroban-testnet.stellar.org` with the `Test SDF Network ; September 2015`
passphrase.

Pass your identity name via `STELLAR_ACCOUNT`:

```bash
make deploy-testnet STELLAR_ACCOUNT=blitz-local
```

On success the CLI prints the **contract ID** — a 56-character string starting
with `C`, for example:

```
CCJZ5DGASBWQXR5MPFCJXMBI2TPBSY35Z6PY5MZ2GEQTPD6MRA2CX7ZH
```

Copy it. (If you miss it in the output, `stellar contract deploy` also writes the
deployment to `.stellar/` under the current directory.)

### Initialize the deployed contract

A freshly deployed contract must be initialized once before any `deposit`,
`settle`, or `refund` call. Full parameter reference is in
[`contracts/README.md`](../../contracts/README.md#initialize); the minimum for
local testing:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source-account blitz-local \
  --network testnet \
  -- initialize \
  --admin $(stellar keys address blitz-local) \
  --token CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  --memo "BLITZ-LOCAL1"
```

`CBIELTK6...DAMA` is the testnet USDC Stellar Asset Contract address. The `admin`
address is the only one allowed to call `settle()` / `refund()`, so it must match
the wallet your API signs payouts with (`STELLAR_HOT_WALLET_SECRET`).

---

## 4. Set `SOROBAN_CONTRACT_ID` in `.env`

Back at the repo root, open `.env` (copy it from
[`.env.example`](../../.env.example) if you haven't yet) and set:

```bash
SOROBAN_CONTRACT_ID=CCJZ5DGASBWQXR5MPFCJXMBI2TPBSY35Z6PY5MZ2GEQTPD6MRA2CX7ZH
```

Make sure the surrounding Stellar values point at testnet (these are the
defaults in `.env.example`):

```bash
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HOT_WALLET_SECRET=S...   # secret for the same key you used as --admin above
```

Restart the API. On the next payout run,
`apps/api/src/services/payout.ts` sees `config.SOROBAN_CONTRACT_ID` is set and
routes settlement through `EscrowClient.settle()` instead of direct transfers.

---

## Fallback behavior (`SOROBAN_CONTRACT_ID` unset)

Per the comment in [`.env.example`](../../.env.example):

> If set, payouts use the escrow contract; if not set, falls back to direct transfers

When `SOROBAN_CONTRACT_ID` is empty or unset, the payout service skips the escrow
path entirely and pays winners with direct hot-wallet USDC `Payment` operations
(`submitBatchPayout()`, batched ≤50 ops per transaction). This is the default in
`.env.example`, and it's a fully supported mode — you do **not** need a deployed
contract to develop or test payout code. Set `SOROBAN_CONTRACT_ID` only when you
specifically want to exercise the on-chain escrow settlement path.

See [`docs/03-stellar-architecture.md`](../03-stellar-architecture.md#fallback-behavior)
for how the runtime switch works, and
[`docs/adr/003-escrow-implementation.md`](../adr/003-escrow-implementation.md) for
the rationale.
