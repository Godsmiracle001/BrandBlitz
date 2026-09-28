#!/usr/bin/env tsx
/**
 * Generates a Stellar keypair and funds it via the testnet friendbot, so
 * contributors don't have to hand-roll this every time they need a funded
 * wallet to test payout code locally (see CONTRIBUTING.md Drips Wave rules).
 *
 * Usage:
 *   STELLAR_NETWORK=testnet pnpm tsx scripts/fund-testnet-wallet.ts
 *
 * Refuses to run unless STELLAR_NETWORK=testnet — this script must never be
 * pointed at a public-network friendbot (there isn't one) or used to imply
 * mainnet funds are "free".
 */
import { Keypair } from "@stellar/stellar-sdk";

const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

async function main(): Promise<void> {
  const network = process.env.STELLAR_NETWORK;

  if (network !== "testnet") {
    console.error(
      `Refusing to run: STELLAR_NETWORK must be "testnet" (got ${JSON.stringify(network ?? "")}).\n` +
        "Set STELLAR_NETWORK=testnet and re-run."
    );
    process.exit(1);
  }

  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  console.log(`Generated keypair:\n  Public: ${publicKey}\n  Secret: ${secretKey}`);
  console.log(`Requesting friendbot funding for ${publicKey}...`);

  const friendbotResponse = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);

  if (!friendbotResponse.ok) {
    const body = await friendbotResponse.text();
    console.error(`Friendbot funding failed (${friendbotResponse.status}): ${body}`);
    process.exit(1);
  }

  const horizonResponse = await fetch(`${HORIZON_TESTNET_URL}/accounts/${publicKey}`);

  if (!horizonResponse.ok) {
    const body = await horizonResponse.text();
    console.error(`Funding submitted, but Horizon lookup failed (${horizonResponse.status}): ${body}`);
    process.exit(1);
  }

  const account = (await horizonResponse.json()) as { balances?: Array<{ asset_type: string; balance: string }> };
  const nativeBalance = account.balances?.find((b) => b.asset_type === "native")?.balance;

  console.log(`Funded. Confirmed via Horizon — native balance: ${nativeBalance ?? "unknown"} XLM`);
  console.log(`\nAdd to your .env for local testing:\nSTELLAR_HOT_WALLET_SECRET=${secretKey}\nHOT_WALLET_PUBLIC_KEY=${publicKey}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
