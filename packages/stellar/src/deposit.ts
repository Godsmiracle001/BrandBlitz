import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { getRpcServer, getUsdcAsset, getNetworkConfig, withRetry, type NetworkName, type RetryOptions } from "./client";
import { DEPOSIT_POLL_INTERVAL_MS } from "./constants";

export interface DepositEvent {
  txHash: string;
  amount: string;
  memo: string;
  to: string;
  ledger: number;
  createdAt: string;
}

export interface DepositConfirmationUpdate {
  txHash: string;
  memo: string;
  ledger: number;
  confirmationCount: number;
}

export type DepositMemoValidation =
  | { valid: true; memo: string }
  | { valid: false; reason: "missing" | "invalid_format" };

/** Generate an opaque Stellar text memo (maximum 28 UTF-8 bytes). */
export function generateDepositMemo(): string {
  return randomBytes(18).toString("base64url");
}

export function validateDepositMemo(memo: string | null): DepositMemoValidation {
  if (!memo?.trim()) return { valid: false, reason: "missing" };
  if (
    Buffer.byteLength(memo, "utf8") > 28 ||
    /[\u0000-\u001f\u007f]/.test(memo)
  ) {
    return { valid: false, reason: "invalid_format" };
  }
  return { valid: true, memo };
}

/**
 * Poll Stellar RPC getEvents for USDC transfers to the hot wallet.
 * Returns a list of deposit events since the given cursor ledger.
 *
 * Architecture decision: RPC getEvents (Protocol 23+) preferred over
 * Horizon streaming — more reliable at scale, no long-lived connections.
 */
export async function fetchDepositEvents(
  hotWalletAddress: string,
  fromLedger: number,
  network: NetworkName = "testnet"
): Promise<{ events: DepositEvent[]; latestLedger: number }> {
  const rpc = getRpcServer(network);
  const usdc = getUsdcAsset(network);
  const { networkPassphrase } = getNetworkConfig(network);

  const response = await withRetry(
    () =>
      rpc.getEvents({
        startLedger: fromLedger,
        filters: [
          {
            type: "contract",
            // SAC (Stellar Asset Contract) transfer events for USDC
            contractIds: [usdc.contractId(networkPassphrase)],
            topics: [
              ["transfer", "*", hotWalletAddress],
            ],
          },
        ],
        limit: 200,
      }),
    { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 30_000 }
  );

  const events: DepositEvent[] = [];

  for (const event of response.events) {
    try {
      const txMeta = await withRetry(
        () => rpc.getTransaction(event.txHash),
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 }
      );
      if (txMeta.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        console.warn(`Skipping unsuccessful transaction: ${event.txHash}`, { status: txMeta.status });
        continue;
      }

      if (!event.ledgerClosedAt) {
        console.warn(`Skipping event with missing ledgerClosedAt: ${event.txHash}`);
        continue;
      }

      const memo = (txMeta as any).memo?.text ?? null;
      const memoValidation = validateDepositMemo(memo);
      if (!memoValidation.valid) {
        console.warn("Rejecting deposit with invalid memo", {
          reason: memoValidation.reason,
          memo: memo?.slice(0, 28) ?? null,
          txHash: event.txHash,
          senderAccount: (event as any).from ?? null,
        });
        continue;
      }
      const amount = event.value?.toString() ?? "0";

      events.push({
        txHash: event.txHash,
        amount,
        memo: memoValidation.memo,
        to: hotWalletAddress,
        ledger: event.ledger,
        createdAt: new Date(event.ledgerClosedAt).toISOString(),
      });
    } catch (err) {
      console.warn(`Error processing deposit event ${event.txHash}:`, err);
      continue;
    }
  }

  return {
    events,
    latestLedger: response.latestLedger,
  };
}

/**
 * Returns the interval in ms to wait between deposit polls.
 */
export function getDepositPollInterval(): number {
  return DEPOSIT_POLL_INTERVAL_MS;
}

/**
 * Check if a transaction still exists at a specific ledger height.
 * Used to verify deposit transactions haven't been reverted.
 *
 * @param txHash - Transaction hash to verify
 * @param ledger - Ledger height where transaction was confirmed
 * @param network - Stellar network
 * @returns Number of confirmations (ledgers since transaction), or 0 if not found
 */
export async function getDepositConfirmationCount(
  txHash: string,
  txLedger: number,
  network: NetworkName = "testnet"
): Promise<number> {
  const rpc = getRpcServer(network);

  try {
    const txMeta = await withRetry(
      () => rpc.getTransaction(txHash),
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 }
    );

    if (txMeta.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return 0;
    }

    // Get current ledger
    const health = await withRetry(
      () => rpc.getHealth(),
      { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 2_000 }
    );

    const currentLedger = health.ledger.sequence;
    const confirmations = Math.max(0, currentLedger - txLedger);

    return confirmations;
  } catch (err) {
    console.warn(`Error checking deposit confirmations for ${txHash}:`, err);
    return 0;
  }
}
