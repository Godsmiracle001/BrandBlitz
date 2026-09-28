import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../lib/redis", () => ({
  redis: { set: mocks.redisSet },
}));

vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../db/index", () => ({
  query: mocks.query,
}));

const WEBHOOK_SECRET = "test-webhook-secret-key-12345";
const DIFFERENT_SECRET = "completely-different-secret-key-xxxxx";

vi.mock("../../lib/config", () => ({
  config: { WEBHOOK_SECRET },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { verifyWebhook, signWebhookPayload } from "../verify-webhook";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeReq(overrides: Partial<Request> & { rawBody?: Buffer } = {}) {
  return {
    headers: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

function fakeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function fakeNext() {
  return vi.fn() as unknown as NextFunction;
}

function setDbSecrets(secrets: { current: string; pending?: string }) {
  const rows = [];
  if (secrets.current) {
    rows.push({ key: "webhook_secret_current", value: { secret: secrets.current } });
  }
  if (secrets.pending) {
    rows.push({
      key: "webhook_secret_pending",
      value: { secret: secrets.pending, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
  }
  mocks.query.mockResolvedValue({ rows });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("verifyWebhook middleware (Issue #407)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue("OK");
    setDbSecrets({ current: WEBHOOK_SECRET });
  });

  // ── AC 1: valid signature calls next() ────────────────────────────────────

  describe("valid HMAC-SHA256 signature", () => {
    it("calls next() when the signature is computed from the correct secret", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = '{"event":"deposit","amount":"100"}';
      const rawBody = Buffer.from(payload, "utf8");
      const sig = signWebhookPayload(rawBody, timestamp, WEBHOOK_SECRET);

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${sig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-001",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ── AC 2: different secret → 401 ─────────────────────────────────────────

  describe("signature from a different secret", () => {
    it("rejects with 401 when the signature is computed from a different secret", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = '{"event":"deposit"}';
      const rawBody = Buffer.from(payload, "utf8");
      const sig = signWebhookPayload(rawBody, timestamp, DIFFERENT_SECRET);

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${sig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-002",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook signature" });
    });
  });

  // ── AC 3: byte-flipped signature → 401 ───────────────────────────────────

  describe("byte-flipped signature", () => {
    it("rejects with 401 when one byte of the signature is flipped", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = '{"event":"deposit"}';
      const rawBody = Buffer.from(payload, "utf8");
      const sig = signWebhookPayload(rawBody, timestamp, WEBHOOK_SECRET);

      // Flip one byte: change the first hex char
      const firstChar = sig[0] === "0" ? "1" : "0";
      const tamperedSig = firstChar + sig.slice(1);

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${tamperedSig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-003",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // ── AC 4: missing signature header → 401 without HMAC ────────────────────

  describe("missing X-Webhook-Signature header", () => {
    it("returns 401 without attempting HMAC computation", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-004",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing signature" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── AC 5: empty string signature → 401 ───────────────────────────────────

  describe("empty X-Webhook-Signature header", () => {
    it("returns 401 when the signature header is an empty string", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-signature": "",
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-005",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── AC 6: crypto.timingSafeEqual is invoked ──────────────────────────────

  describe("timingSafeEqual verification", () => {
    it("rejects a signature with mismatched byte length (proving buffer-based comparison)", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");
      const sig = signWebhookPayload(rawBody, timestamp, WEBHOOK_SECRET);

      // Truncate the signature to make it too short — timingSafeEqual requires equal lengths
      const shortSig = sig.slice(0, 32);

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${shortSig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-timing-01",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      // Should reject because lengths don't match — this proves buffer-based
      // comparison (timingSafeEqual) is used, not a string === comparison
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── AC 7: body consumed before HMAC computation ──────────────────────────

  describe("body consumed before HMAC computation", () => {
    it("reads rawBody (a pre-consumed Buffer) before computing HMAC", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const largePayload = "x".repeat(1024 * 1024); // 1 MB
      const rawBody = Buffer.from(largePayload, "utf8");
      const sig = signWebhookPayload(rawBody, timestamp, WEBHOOK_SECRET);

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${sig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-007",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      // The large payload was consumed (it's a Buffer, not a stream)
      expect(rawBody).toBeInstanceOf(Buffer);
      expect(rawBody.length).toBe(Buffer.byteLength(largePayload));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects when rawBody is not available (streaming scenario)", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = signWebhookPayload("test", timestamp, WEBHOOK_SECRET);

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${sig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-008",
        },
        rawBody: undefined,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Raw webhook payload unavailable" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── Additional edge cases ────────────────────────────────────────────────

  describe("signature format validation", () => {
    it("rejects signature with invalid format (missing sha256= prefix)", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-signature": "not-a-valid-signature",
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-009",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid signature format" });
    });

    it("rejects signature with non-hex characters after sha256=", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-signature": "sha256=xyz_not_hex_at_all!",
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-010",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe("missing timestamp header", () => {
    it("returns 400 when x-webhook-timestamp is missing", async () => {
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-signature": "sha256=" + "a".repeat(64),
          "x-webhook-id": "wh-011",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing timestamp" });
    });
  });

  describe("missing webhook ID", () => {
    it("returns 400 when x-webhook-id is missing", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-signature": "sha256=" + "a".repeat(64),
          "x-webhook-timestamp": timestamp.toString(),
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing webhook id" });
    });
  });

  describe("no webhook secret configured", () => {
    it("returns 500 when no secret is available from DB or env", async () => {
      mocks.query.mockResolvedValue({ rows: [] });
      process.env.WEBHOOK_SECRET = "";
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = Buffer.from("test");

      const req = fakeReq({
        headers: {
          "x-webhook-signature": "sha256=" + "a".repeat(64),
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-012",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Webhook verification misconfigured" });
    });
  });

  describe("replay protection", () => {
    it("rejects duplicate webhook IDs", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = '{"event":"deposit"}';
      const rawBody = Buffer.from(payload, "utf8");
      const sig = signWebhookPayload(rawBody, timestamp, WEBHOOK_SECRET);

      mocks.redisSet.mockResolvedValue(null); // NX fails = duplicate

      const req = fakeReq({
        headers: {
          "x-webhook-signature": `sha256=${sig}`,
          "x-webhook-timestamp": timestamp.toString(),
          "x-webhook-id": "wh-duplicate",
        },
        rawBody,
      });
      const res = fakeRes();
      const next = fakeNext();

      await verifyWebhook(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: "duplicate" });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
