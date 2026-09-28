import https from "https";
import http from "http";
import {
  Horizon,
  Keypair,
  Asset,
  Networks,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { STELLAR_NETWORKS, type NetworkName } from "./constants";

// ─── Retry Configuration ─────────────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatusCodes?: number[];
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  retryableStatusCodes: [429, 503, 504],
};

/**
 * Calculates delay with exponential backoff and full jitter.
 *
 * Formula: min(maxDelay, baseDelay * 2^attempt * random(0,1))
 *
 * @param attempt - Attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay in milliseconds
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitteredDelay = exponentialDelay * Math.random();
  return Math.min(maxDelayMs, jitteredDelay);
}

/**
 * Check if an error is retryable based on HTTP status code or error type.
 */
function isRetryableError(err: unknown, retryableStatusCodes: number[]): boolean {
  const statusCode = (err as any)?.response?.status ?? (err as any)?.status;
  if (statusCode && retryableStatusCodes.includes(statusCode)) {
    return true;
  }

  const message = String((err as any)?.message ?? "").toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("networkconnection")
  );
}

/**
 * Execute a function with exponential backoff and full jitter retry logic.
 * Logs retry attempts and exhaustion to console.warn for structured logging.
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Promise result from fn
 * @throws Original error with retryExhausted: true if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };

  let lastError: any;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === config.maxAttempts - 1) {
        // Exhausted all retries
        break;
      }

      if (!isRetryableError(err, config.retryableStatusCodes)) {
        // Not retryable, fail immediately
        throw err;
      }

      const delayMs = calculateBackoffDelay(
        attempt,
        config.baseDelayMs,
        config.maxDelayMs
      );

      const statusCode = (err as any)?.response?.status ?? (err as any)?.status;
      console.warn(
        `[Stellar RPC Retry] Attempt ${attempt + 1}/${config.maxAttempts} failed, retrying in ${delayMs}ms`,
        {
          statusCode,
          errorMessage: (err as any)?.message ?? String(err),
          delayMs,
        }
      );

      await delay(delayMs);
    }
  }

  // All retries exhausted
  const error = lastError as any;
  error.retryExhausted = true;
  console.warn(
    `[Stellar RPC Retry] Exhausted all ${config.maxAttempts} retry attempts`,
    {
      statusCode: error?.response?.status ?? error?.status,
      errorMessage: error?.message ?? String(error),
    }
  );
  throw error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getNetworkConfig(name: NetworkName = "testnet") {
  const config = STELLAR_NETWORKS[name];
  if (!config) {
    throw new Error(`Invalid network name: ${name}`);
  }
  return config;
}

// Backward-compat alias.
export const getNetwork = getNetworkConfig;
const maxSockets = Number(process.env.STELLAR_MAX_SOCKETS ?? "32");

// One shared agent for all Horizon + Soroban HTTPS connections.
// Avoids per-call TCP+TLS handshake; sized to env STELLAR_MAX_SOCKETS (default 32).
export const sharedAgent = new https.Agent({
  keepAlive: true,
  maxSockets,
  maxFreeSockets: Math.ceil(maxSockets / 4),
});

const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets,
  maxFreeSockets: Math.ceil(maxSockets / 4),
});

// Wire the agent into Horizon's shared axios client when the SDK exposes it so
// every Horizon.Server instance created in this process reuses the connection
// pool. Stellar SDK versions differ on whether this singleton is public.
if (Horizon.AxiosClient?.defaults) {
  Horizon.AxiosClient.defaults.httpsAgent = sharedAgent;
  Horizon.AxiosClient.defaults.httpAgent = sharedHttpAgent;
}

/** Call on process shutdown to drain in-flight requests and close sockets. */
export function drainSharedAgent(): void {
  sharedAgent.destroy();
  sharedHttpAgent.destroy();
}

export function getHorizonServer(network: NetworkName = "testnet"): Horizon.Server {
  const { horizonUrl } = getNetwork(network);
  return new Horizon.Server(horizonUrl, { allowHttp: network === "testnet" });
}

export function getRpcServer(network: NetworkName = "testnet"): SorobanRpc.Server {
  const { rpcUrl } = getNetwork(network);
  return new SorobanRpc.Server(rpcUrl, { allowHttp: network === "testnet" });
}

export function getUsdcAsset(network: NetworkName = "testnet"): Asset {
  const { usdcIssuer } = getNetwork(network);
  return new Asset("USDC", usdcIssuer);
}

export function getNetworkPassphrase(network: NetworkName = "testnet"): string {
  return getNetwork(network).networkPassphrase;
}

export type { NetworkName };
export { Keypair, Asset, TransactionBuilder, BASE_FEE, Networks };
