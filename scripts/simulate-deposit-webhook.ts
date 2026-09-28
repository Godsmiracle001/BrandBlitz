/**
 * Simulates a deposit-monitor -> API webhook call locally, without needing
 * a real testnet deposit or a hand-crafted signed curl request.
 *
 * Builds the exact same signature/headers as
 * apps/deposit-monitor/src/index.ts's sendDepositWebhook(), verified by
 * apps/api/src/middleware/verify-webhook.ts, and POSTs to
 * POST /webhooks/stellar/deposit.
 *
 * Usage:
 *   pnpm tsx scripts/simulate-deposit-webhook.ts --memo <challenge-uuid> [--tx-hash <64-hex>] [--amount <decimal>]
 *
 * Env:
 *   WEBHOOK_SECRET  required, must match the API's current webhook secret
 *   API_URL         optional, defaults to http://localhost:3001 (the API's
 *                    default PORT — see apps/api/src/lib/config-schema.ts)
 *
 * Note: `memo` must be an existing challenge's memo (see
 * scripts/seed-e2e-challenge.ts) for the API to do anything with the
 * request beyond signature verification — an unknown memo is a valid
 * response to test too (404 "Unknown memo").
 */
import crypto from "crypto";

const DEFAULT_API_URL = "http://localhost:3001";

interface Args {
  memo: string;
  txHash: string;
  amount?: string;
}

function randomTxHash(): string {
  return crypto.randomBytes(32).toString("hex");
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for --${key}`);
      }
      flags[key] = value;
      i++;
    }
  }

  if (!flags.memo) {
    throw new Error(
      "Missing required --memo <challenge-uuid> (see scripts/seed-e2e-challenge.ts to create a test challenge)",
    );
  }

  if (flags["tx-hash"] && !/^[0-9a-fA-F]{64}$/.test(flags["tx-hash"])) {
    throw new Error("--tx-hash must be a 64-character hex string");
  }

  return {
    memo: flags.memo,
    txHash: flags["tx-hash"] ?? randomTxHash(),
    amount: flags.amount,
  };
}

/** Mirrors apps/api/src/middleware/verify-webhook.ts's signWebhookPayload(). */
function signWebhookPayload(payload: string, timestamp: number, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest("hex");
}

async function main(): Promise<void> {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "❌ WEBHOOK_SECRET is not set. Set it to the same value the local API is configured with " +
        "(APP_CONFIG.webhook_secret_current, or the WEBHOOK_SECRET env var it falls back to).",
    );
    process.exit(1);
  }

  const apiUrl = process.env.API_URL ?? DEFAULT_API_URL;
  if (!process.env.API_URL) {
    console.log(`ℹ️  API_URL not set, defaulting to ${DEFAULT_API_URL}`);
  }

  const args = parseArgs(process.argv.slice(2));

  const body = JSON.stringify({
    memo: args.memo,
    txHash: args.txHash,
    ...(args.amount ? { amount: args.amount } : {}),
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(body, timestamp, webhookSecret);
  const webhookId = `deposit-${args.txHash}`;

  console.log("📤 Sending simulated deposit webhook", {
    url: `${apiUrl}/webhooks/stellar/deposit`,
    memo: args.memo,
    txHash: args.txHash,
    amount: args.amount,
  });

  const response = await fetch(`${apiUrl}/webhooks/stellar/deposit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": webhookSecret,
      "X-Webhook-Timestamp": String(timestamp),
      "X-Webhook-Signature": `sha256=${signature}`,
      "X-Webhook-Id": webhookId,
    },
    body,
  });

  const responseText = await response.text();
  let responseBody: unknown = responseText;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    // Non-JSON response body — leave as text.
  }

  if (response.ok) {
    console.log(`✅ ${response.status} ${response.statusText}`, responseBody);
  } else {
    console.error(`❌ ${response.status} ${response.statusText}`, responseBody);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ Failed to simulate webhook:", error instanceof Error ? error.message : error);
  process.exit(1);
});
