import "dotenv/config";
import crypto from "crypto";
import { Redis } from "ioredis";
import { fetchDepositEvents, type DepositEvent } from "@brandblitz/stellar";
import { config } from "./config";
import { logger } from "./logger";

const LAST_LEDGER_KEY = "stellar:deposit_monitor:last_ledger";
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
});

/**
 * Sign webhook payload following the same logic as apps/api/src/middleware/verify-webhook.ts
 */
function signWebhookPayload(payload: string, timestamp: number): string {
  const hmac = crypto.createHmac("sha256", config.WEBHOOK_SECRET);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest("hex");
}

/**
 * Metrics emission (logs as per project standard in apps/api/src/lib/metrics.ts)
 */
function emitMetric(name: string, value = 1, metadata: Record<string, unknown> = {}): void {
  logger.info("Metric emitted", { metric: name, value, ...metadata });
}

async function sendDepositWebhook(event: DepositEvent): Promise<void> {
  const body = JSON.stringify({
    memo: event.memo,
    txHash: event.txHash,
    amount: event.amount,
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(body, timestamp);
  const webhookId = `deposit-${event.txHash}`;

  try {
    const response = await fetch(`${config.API_URL}/webhooks/stellar/deposit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": config.WEBHOOK_SECRET,
        "X-Webhook-Timestamp": String(timestamp),
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Webhook-Id": webhookId,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook failed with status ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    logger.info("Webhook delivered successfully", { txHash: event.txHash, result });
  } catch (err) {
    logger.error("Failed to deliver webhook", { txHash: event.txHash, err });
    throw err; // Retry in next poll or let loop handle it
  }
}

async function poll(): Promise<void> {
  try {
    const lastLedgerStr = await redis.get(LAST_LEDGER_KEY);
    // If no last ledger, start from 0 (fetchDepositEvents will handle it or we could start from current)
    // Actually, starting from current ledger is safer for first run to avoid processing all history.
    let fromLedger = lastLedgerStr ? parseInt(lastLedgerStr, 10) : 0;

    logger.debug("Polling for deposits", { fromLedger });

    const { events, latestLedger } = await fetchDepositEvents(
      config.HOT_WALLET_PUBLIC_KEY,
      fromLedger,
      config.STELLAR_NETWORK as any
    );

    if (fromLedger === 0) {
      // First run: just save the latest ledger and wait for next poll
      // to avoid processing old events.
      await redis.set(LAST_LEDGER_KEY, latestLedger.toString());
      logger.info("Initial poll complete, cursor set", { latestLedger });
      return;
    }

    for (const event of events) {
      logger.info("Deposit detected", { txHash: event.txHash, memo: event.memo });
      emitMetric("deposits.detected_total");
      
      try {
        await sendDepositWebhook(event);
      } catch (err) {
        // If one webhook fails, we don't update the cursor and will retry all from this ledger next time.
        // For simplicity, we stop here.
        emitMetric("deposits.poll_errors_total", 1, { error: "webhook_failure" });
        return;
      }
    }

    // Update cursor only if all events were processed
    if (latestLedger > fromLedger) {
      await redis.set(LAST_LEDGER_KEY, latestLedger.toString());
      logger.debug("Cursor updated", { latestLedger });
    }
  } catch (err) {
    logger.error("Poll error", { err });
    emitMetric("deposits.poll_errors_total", 1, { error: "rpc_error" });
  }
}

let isRunning = true;

export async function main() {
  await redis.connect();
  logger.info("Redis connected");

  logger.info("Deposit monitor starting", {
    network: config.STELLAR_NETWORK,
    hotWallet: config.HOT_WALLET_PUBLIC_KEY,
    interval: config.DEPOSIT_POLL_INTERVAL_MS,
  });

  while (isRunning) {
    await poll();
    if (isRunning) {
      await new Promise((resolve) => setTimeout(resolve, config.DEPOSIT_POLL_INTERVAL_MS));
    }
  }

  logger.info("Deposit monitor stopped");
}

const shutdown = async (signal: string) => {
  logger.info(`${signal} received — starting graceful shutdown`);
  isRunning = false;
  
  try {
    await redis.disconnect();
    logger.info("Redis disconnected");
    process.exit(0);
  } catch (err) {
    logger.error("Error during shutdown", { err });
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  main().catch((err) => {
    logger.error("Critical failure", { err });
    process.exit(1);
  });
}

export { poll, sendDepositWebhook, redis, LAST_LEDGER_KEY };
