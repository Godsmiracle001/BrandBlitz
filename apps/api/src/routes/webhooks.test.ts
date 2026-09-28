import type { Server } from "node:http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { errorHandler } from "../middleware/error";
import { signWebhookPayload } from "../middleware/verify-webhook";
import webhooksRouter from "./webhooks";

// ── Mocks ──────────────────────────────────────────────────────────────────────
// webhooks.ts is guarded by the real verifyWebhook middleware (HMAC signature,
// timestamp, and replay checks). That middleware reads the shared secret from
// `app_config` via db/index#query and de-dupes webhook ids via redis, so both
// need to be mocked here for the route handler underneath to ever be reached.

const WEBHOOK_SECRET = "test-webhook-secret-key-12345";

const mocks = vi.hoisted(() => ({
  getChallengeByMemo: vi.fn(),
  getChallengeByDepositTxHash: vi.fn(),
  updateChallengeStatus: vi.fn(),
  findPayoutByTxHash: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  dbQuery: vi.fn(),
  redisSet: vi.fn(),
  getAccountUsdcBalance: vi.fn(),
}));

vi.mock("../db/queries/challenges", () => ({
  getChallengeByMemo: mocks.getChallengeByMemo,
  getChallengeByDepositTxHash: mocks.getChallengeByDepositTxHash,
  updateChallengeStatus: mocks.updateChallengeStatus,
}));

vi.mock("../db/queries/payouts", () => ({
  findPayoutByTxHash: mocks.findPayoutByTxHash,
}));

vi.mock("../middleware/rate-limit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  webhookLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("../db/index", () => ({
  query: mocks.dbQuery,
}));

vi.mock("../lib/redis", () => ({
  redis: { set: mocks.redisSet },
}));

vi.mock("@brandblitz/stellar", () => ({
  getAccountUsdcBalance: mocks.getAccountUsdcBalance,
}));

// ── Test server helpers ────────────────────────────────────────────────────────

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );
  app.use("/webhooks", webhooksRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function signedHeaders(body: object, overrides?: Partial<Record<string, string>>) {
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(payload, timestamp, WEBHOOK_SECRET);
  return {
    "Content-Type": "application/json",
    "X-Webhook-Signature": `sha256=${signature}`,
    "X-Webhook-Timestamp": timestamp.toString(),
    "X-Webhook-Id": `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

const validBody = {
  memo: "550e8400-e29b-41d4-a716-446655440000",
  txHash: "a".repeat(64),
  amount: "10.0000000",
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Webhooks API", () => {
  let currentServer: Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQuery.mockResolvedValue({
      rows: [{ key: "webhook_secret_current", value: { secret: WEBHOOK_SECRET } }],
    });
    mocks.redisSet.mockResolvedValue("OK");
    mocks.getChallengeByMemo.mockResolvedValue({
      id: "challenge-1",
      status: "pending_deposit",
      pool_amount_usdc: "10.0000000",
    });
    mocks.getChallengeByDepositTxHash.mockResolvedValue(null);
    mocks.findPayoutByTxHash.mockResolvedValue(null);
    mocks.updateChallengeStatus.mockResolvedValue(undefined);
    mocks.getAccountUsdcBalance.mockResolvedValue(10_000_0000n);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (currentServer) {
        currentServer.close(() => resolve());
        currentServer = undefined;
        return;
      }
      resolve();
    });
  });

  describe("POST /webhooks/stellar/deposit — signature verification", () => {
    it("rejects a request with a missing X-Webhook-Signature header with 401", async () => {
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": Math.floor(Date.now() / 1000).toString(),
          "X-Webhook-Id": "webhook-no-sig",
        },
        body: JSON.stringify(validBody),
      });

      expect(response.status).toBe(401);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("rejects a request with an invalid HMAC signature with 401", async () => {
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody, {
          "X-Webhook-Signature": `sha256=${"0".repeat(64)}`,
        }),
        body: JSON.stringify(validBody),
      });

      expect(response.status).toBe(401);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("accepts a request with a valid HMAC signature and returns 200", async () => {
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      expect(response.status).toBe(200);
      expect(mocks.updateChallengeStatus).toHaveBeenCalledWith("challenge-1", "active", {
        depositTx: "a".repeat(64),
      });
    });

    it("rejects a duplicate webhook id (replay) with 200 duplicate status and does not reprocess", async () => {
      mocks.redisSet.mockResolvedValue(null); // SET NX returns null when the key already exists

      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("duplicate");
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });
  });

  describe("POST /webhooks/stellar/deposit — deposit event processing", () => {
    it("activates a challenge on a valid deposit event", async () => {
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: "activated", challengeId: "challenge-1" });
      expect(mocks.getAccountUsdcBalance).toHaveBeenCalledWith(
        "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "testnet"
      );
    });

    it("is idempotent for a challenge that is already active", async () => {
      mocks.getChallengeByMemo.mockResolvedValue({ id: "challenge-1", status: "active" });

      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe("already_processed");
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("returns 404 for an unrecognized memo", async () => {
      mocks.getChallengeByMemo.mockResolvedValue(null);

      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      expect(response.status).toBe(404);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("returns 200 duplicate_tx_ignored and does not enqueue re-processing for a previously seen tx hash", async () => {
      mocks.getChallengeByDepositTxHash.mockResolvedValue({ id: "challenge-older" });

      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe("duplicate_tx_ignored");
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("returns 200 duplicate_tx_ignored when the tx hash already matches a recorded payout", async () => {
      mocks.findPayoutByTxHash.mockResolvedValue({ id: "payout-1" });

      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe("duplicate_tx_ignored");
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("returns 422 with INSUFFICIENT_ESCROW_BALANCE when the hot wallet balance is too low", async () => {
      mocks.getAccountUsdcBalance.mockResolvedValue(1_000_0000n); // less than the 10 USDC pool

      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(validBody),
        body: JSON.stringify(validBody),
      });

      const body = await response.json();
      expect(response.status).toBe(422);
      expect(body.code).toBe("INSUFFICIENT_ESCROW_BALANCE");
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });
  });

  describe("POST /webhooks/stellar/deposit — payload validation", () => {
    it("returns 400 for missing required fields", async () => {
      const body = { memo: validBody.memo };
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(body),
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("rejects an empty memo", async () => {
      const body = { ...validBody, memo: "" };
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(body),
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("rejects an empty tx hash", async () => {
      const body = { ...validBody, txHash: "" };
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(body),
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });

    it("rejects unknown fields", async () => {
      const body = { ...validBody, extra: "unexpected" };
      const { server, baseUrl } = await startServer();
      currentServer = server;

      const response = await fetch(`${baseUrl}/webhooks/stellar/deposit`, {
        method: "POST",
        headers: signedHeaders(body),
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(mocks.updateChallengeStatus).not.toHaveBeenCalled();
    });
  });
});
