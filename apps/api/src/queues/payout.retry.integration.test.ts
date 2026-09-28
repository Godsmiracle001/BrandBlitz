import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Worker, Queue } from "bullmq";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `payout_retry_test_${Date.now()}_${randomUUID().replace(/-/g, "")}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options");
  const searchPathOption = `-c search_path=${schema}`;
  url.searchParams.set(
    "options",
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption
  );
  return url.toString();
}

if (originalDatabaseUrl) {
  process.env.DATABASE_URL = withSearchPath(originalDatabaseUrl, schemaName);
}

const describeIntegration = originalDatabaseUrl ? describe : describe.skip;

import { createPayoutWorker } from "./processors/payout.processor";
import { enqueuePayoutJob, payoutQueue } from "./payout.queue";
import * as stellarClient from "@brandblitz/stellar";

vi.mock("@brandblitz/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@brandblitz/stellar")>();
  return {
    ...actual,
    submitBatchPayout: vi.fn(),
  };
});

describeIntegration("payout queue retries on transient errors", () => {
  let query: typeof import("../../db/index").query;
  let closeDb: typeof import("../../db/index").closeDb;
  let worker: Worker;

  beforeAll(async () => {
    const db = await import("../../db/index");
    query = db.query;
    closeDb = db.closeDb;

    await query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    
    // Execute init.sql equivalent tables for test
    const fs = await import("fs");
    const path = await import("path");
    const initSqlPath = path.resolve(__dirname, "../../../../../init.sql");
    const initSql = fs.readFileSync(initSqlPath, "utf8");
    await query(initSql);

    // Disable SOROBAN_CONTRACT_ID to force direct payout route
    const { config } = await import("../../lib/config");
    config.SOROBAN_CONTRACT_ID = "";

    worker = createPayoutWorker();
  });

  afterAll(async () => {
    if (worker) {
      await worker.close();
    }
    if (payoutQueue) {
      await payoutQueue.close();
    }
    if (query) {
      await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    if (closeDb) {
      await closeDb();
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  async function seedChallengeAndPendingPayout(challengeId: string) {
    const userId = randomUUID();
    
    await query(`
      INSERT INTO users (id, email, display_name, stellar_address)
      VALUES ($1, $2, 'Winner', 'GWINNERPUBLICKEY1234')
    `, [userId, `winner-${userId}@example.com`]);

    await query(`
      INSERT INTO challenges (id, status, pool_amount_stroops)
      VALUES ($1, 'ended', 10000000)
    `, [challengeId]);

    await query(`
      INSERT INTO game_sessions (user_id, challenge_id, status, total_score, completed_at)
      VALUES ($1, $2, 'completed', 100, NOW())
    `, [userId, challengeId]);
    
    // Set integrity hmac using the correct secret to pass verifySessionHmac
    const { generateSessionHmac } = await import("../../lib/integrity");
    const sessionRes = await query<{ id: string, total_score: number, completed_at: Date }>(`SELECT id, total_score, completed_at FROM game_sessions WHERE user_id = $1 AND challenge_id = $2`, [userId, challengeId]);
    
    const hmac = generateSessionHmac(
      sessionRes.rows[0].id,
      sessionRes.rows[0].total_score,
      sessionRes.rows[0].completed_at.toISOString()
    );
    await query(`UPDATE game_sessions SET integrity_hmac = $1 WHERE id = $2`, [hmac, sessionRes.rows[0].id]);
  }

  it("retries on 504 and completes on third attempt", async () => {
    const challengeId = randomUUID();
    await seedChallengeAndPendingPayout(challengeId);

    let attempts = 0;
    vi.mocked(stellarClient.submitBatchPayout).mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("Gateway Timeout");
        (err as any).code = "504"; // Simulate Horizon 504
        throw err;
      }
      return [{
        txHash: "success-tx-hash",
        recipients: [{ address: "GWINNERPUBLICKEY1234", amount: "1.0000000" }],
        success: true
      }];
    });

    await enqueuePayoutJob(challengeId);
    
    // Wait for job to process and complete
    await new Promise<void>((resolve, reject) => {
      worker.on("completed", (job) => {
        if (job.data.challengeId === challengeId) {
          resolve();
        }
      });
      worker.on("failed", (job, err) => {
        if (job?.data.challengeId === challengeId && job?.attemptsMade === 5) {
          reject(new Error("Job failed completely unexpectedly"));
        }
      });
    });

    expect(attempts).toBe(3);

    const payoutRes = await query(`SELECT status, stellar_tx_hash FROM payouts WHERE challenge_id = $1`, [challengeId]);
    expect(payoutRes.rows).toHaveLength(1);
    expect(payoutRes.rows[0].status).toBe("sent");
    expect(payoutRes.rows[0].stellar_tx_hash).toBe("success-tx-hash");
  }, 15000);

  it("exhausts retries and transitions to failed without dead-letter loop", async () => {
    const challengeId = randomUUID();
    await seedChallengeAndPendingPayout(challengeId);

    let submitCount = 0;
    vi.mocked(stellarClient.submitBatchPayout).mockImplementation(async () => {
      submitCount++;
      const err = new Error("Gateway Timeout");
      (err as any).code = "504";
      throw err;
    });

    await enqueuePayoutJob(challengeId);
    
    // Wait for job to fail completely
    await new Promise<void>((resolve) => {
      worker.on("failed", (job) => {
        // BullMQ sets attemptsMade. When it equals the max (5), it's completely failed.
        if (job?.data.challengeId === challengeId && job?.attemptsMade === 5) {
          resolve();
        }
      });
    });

    // Check we didn't exceed 5 calls
    expect(submitCount).toBe(5);

    // Give the DLQ handler a moment to execute
    await new Promise(res => setTimeout(res, 500));

    const payoutRes = await query(`SELECT status FROM payouts WHERE challenge_id = $1`, [challengeId]);
    expect(payoutRes.rows).toHaveLength(1);
    expect(payoutRes.rows[0].status).toBe("failed");
  }, 30000);
});
