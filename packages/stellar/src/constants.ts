export const STELLAR_NETWORKS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
  public: {
    rpcUrl: "https://mainnet.stellar.validationcloud.io/v1/rpc",
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
} as const;

export type NetworkName = keyof typeof STELLAR_NETWORKS;

export const MAX_OPS_PER_TX = 50; // safe limit (protocol allows 100)
export const PAYOUT_BATCH_DELAY_MS = 2000; // avoid sequence conflicts
export const DEPOSIT_POLL_INTERVAL_MS = 5000;
export const WARMUP_MIN_SECONDS = 20;
export const CHALLENGE_SECONDS = 45;
export const ROUND_SECONDS = 15;
export const MAX_ROUNDS = 3;

// USDC/Stroop conversion
export const USDC_DECIMALS = 6;
export const STROOP_DECIMALS = 7;
export const STROOPS_PER_USDC = 10_000_000; // 10^7, since stroops have 7 decimals and USDC has 6
export const MAX_SUPPLY_STROOPS = 50_000_000_000_000_000; // 100 billion XLM × 10^7 stroops

// Minimum pool amount in stroops (100 USDC = 1,000,000,000 stroops)
// Used by challenge creation validation to prevent dust-level prize pools
export const MIN_POOL_STROOPS = 1_000_000_000;

/**
 * Convert USDC amount (as decimal string) to stroops (integer).
 * Rounds down fractional stroops (sub-stroop amounts).
 *
 * @param usdc - Amount in USDC as string (e.g., "10.50")
 * @returns Amount in stroops as bigint
 * @throws TypeError if input is not a valid numeric string
 * @throws RangeError if amount exceeds max XLM supply
 */
export function usdcToStroops(usdc: string): bigint {
  if (typeof usdc !== "string") {
    throw new TypeError(`Expected string, got ${typeof usdc}`);
  }

  const trimmed = usdc.trim();
  if (!trimmed) {
    throw new TypeError("Cannot convert empty string to stroops");
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Invalid USDC amount: "${usdc}"`);
  }

  const amount = parseFloat(trimmed);
  if (!Number.isFinite(amount)) {
    throw new TypeError(`Invalid USDC amount: "${usdc}"`);
  }

  if (amount < 0) {
    throw new RangeError("USDC amount cannot be negative");
  }

  // Multiply by stroop factor (10^7) for 7-decimal precision
  // Use BigInt to avoid floating-point precision errors
  const stroops = BigInt(Math.floor(amount * STROOPS_PER_USDC));

  if (stroops > MAX_SUPPLY_STROOPS) {
    throw new RangeError(
      `Amount ${usdc} USDC exceeds maximum XLM supply (${MAX_SUPPLY_STROOPS} stroops)`
    );
  }

  return stroops;
}

/**
 * Convert stroops (integer) to USDC amount (decimal string).
 * Formats result with up to 7 decimal places, trimming trailing zeros.
 *
 * @param stroops - Amount in stroops as number or bigint
 * @returns Amount in USDC as string (e.g., "10.5")
 * @throws TypeError if stroops is not a number or bigint
 * @throws RangeError if stroops is negative or exceeds max supply
 */
export function stroopsToUsdc(stroops: number | bigint): string {
  if (typeof stroops !== "number" && typeof stroops !== "bigint") {
    throw new TypeError(`Expected number or bigint, got ${typeof stroops}`);
  }

  const amount = typeof stroops === "number" ? BigInt(Math.floor(stroops)) : stroops;

  if (amount < 0n) {
    throw new RangeError("Stroops cannot be negative");
  }

  if (amount > MAX_SUPPLY_STROOPS) {
    throw new RangeError(
      `Amount ${amount} stroops exceeds maximum XLM supply (${MAX_SUPPLY_STROOPS} stroops)`
    );
  }

  const factor = BigInt(STROOPS_PER_USDC);
  const usdc = Number(amount) / Number(factor);

  return usdc.toFixed(7).replace(/\.?0+$/, "");
}
