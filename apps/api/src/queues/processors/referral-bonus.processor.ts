import { Worker, type Job } from "bullmq";
import { submitBatchPayout } from "@brandblitz/stellar";
import { config } from "../../lib/config";
import { logger } from "../../lib/logger";
import { stellarSequenceStore } from "../../lib/redis";
import {
  findReferralPayoutById,
  updateReferralPayoutStatus,
} from "../../db/queries/referral-payouts";
import { referralBonusQueue } from "../referral-bonus.queue";
import { forwardToDlq, referralBonusDlqQueue } from "../dlq";
import {
  auditReferralBonusSkipped,
  isFraudSession,
} from "../../services/referrals";
import { getSession } from "../../db/queries/sessions";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

export const referralBonusWorkerOptions = {
  concurrency: 2,
} as const;

export async function processReferralBonusJob(
  job: Job<{ referralPayoutId: string }>,
): Promise<void> {
  const payout = await findReferralPayoutById(job.data.referralPayoutId);
  if (!payout) {
    logger.warn("Referral payout not found", {
      referralPayoutId: job.data.referralPayoutId,
    });
    return;
  }

  if (payout.status !== "pending") {
    logger.info("Referral payout already processed", {
      referralPayoutId: payout.id,
      status: payout.status,
    });
    return;
  }

  if (payout.challenge_id) {
    const session = await getSession(payout.referred_id, payout.challenge_id);
    if (session && (await isFraudSession(session.id))) {
      await updateReferralPayoutStatus(
        payout.id,
        "failed",
        undefined,
        "Referral bonus skipped because session was flagged as fraud",
      );
      await auditReferralBonusSkipped({
        sessionId: session.id,
        referrerId: payout.referrer_id,
        referredId: payout.referred_id,
        referralId: payout.referral_id,
        referralPayoutId: payout.id,
        challengeId: payout.challenge_id,
      });
      logger.info("Referral bonus skipped for fraud-flagged session", {
        referralPayoutId: payout.id,
        sessionId: session.id,
      });
      return;
    }
  }

  if (!payout.referrer_stellar_address || !payout.referred_stellar_address) {
    await updateReferralPayoutStatus(
      payout.id,
      "failed",
      undefined,
      "Missing Stellar address for referral bonus payout",
    );
    return;
  }

  const results = await submitBatchPayout(
    [
      {
        address: payout.referrer_stellar_address,
        amount: payout.referrer_amount_stroops,
      },
      {
        address: payout.referred_stellar_address,
        amount: payout.referred_amount_stroops,
      },
    ],
    config.HOT_WALLET_SECRET,
    `referral-${payout.id}`,
    config.STELLAR_NETWORK,
    { sequenceStore: stellarSequenceStore },
  );

  const firstResult = results[0];
  if (!firstResult) {
    await updateReferralPayoutStatus(
      payout.id,
      "failed",
      undefined,
      "No Stellar response",
    );
    return;
  }

  if (firstResult.success) {
    await updateReferralPayoutStatus(payout.id, "sent", firstResult.txHash);
    logger.info("Referral bonus payout completed", {
      referralPayoutId: payout.id,
      txHash: firstResult.txHash,
    });
    return;
  }

  await updateReferralPayoutStatus(
    payout.id,
    "failed",
    undefined,
    firstResult.error ?? "Referral bonus payout failed",
  );
}

export function createReferralBonusWorker(
  WorkerImpl: typeof Worker = Worker,
): Worker {
  const worker = new WorkerImpl(
    referralBonusQueue.name,
    processReferralBonusJob,
    referralBonusWorkerOptions,
  );

  setupGracefulShutdown(worker, "referral-bonus");

  return worker;
}

function setupGracefulShutdown(worker: Worker, workerName: string): void {
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received, gracefully shutting down ${workerName} worker...`);

    const shutdownTimer = setTimeout(() => {
      logger.warn(`${workerName} worker shutdown timeout exceeded, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await worker.close();
      clearTimeout(shutdownTimer);
      logger.info(`${workerName} worker closed gracefully`);
      process.exit(0);
    } catch (error) {
      clearTimeout(shutdownTimer);
      logger.error(`Error during ${workerName} worker shutdown`, {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}
