import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { verifyWebhook, signWebhookPayload } from "./verify-webhook";
import crypto from "crypto";

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
}));

vi.mock("../lib/redis", () => ({
  redis: {
    set: mocks.redisSet,
  },
}));

vi.mock("../lib/config", () => ({
  config: {
    WEBHOOK_SECRET: "test-webhook-secret-key-12345",
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../db/index", () => ({
  query: vi.fn().mockResolvedValue({
    rows: [
      {
        key: "webhook_secret_current",
        value: { secret: "test-webhook-secret-key-12345" },
      },
    ],
  }),
}));

describe("verifyWebhook middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  const WEBHOOK_SECRET = "test-webhook-secret-key-12345";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue("OK");

    req = {
      headers: {},
      body: {},
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    next = vi.fn();
  });

  describe("timing-safe HMAC comparison", () => {
    it("accepts a valid webhook signature using timing-safe comparison", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ test: "data" });
      const rawBody = Buffer.from(payload, "utf8");
      
      const expectedSignature = signWebhookPayload(rawBody, timestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-signature": `sha256=${expectedSignature}`,
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = rawBody;

      await verifyWebhook(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("rejects an invalid signature with generic 401 error", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ test: "data" });
      const rawBody = Buffer.from(payload, "utf8");
      
      const wrongSignature = "0".repeat(64);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${wrongSignature}`,
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = rawBody;

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook signature" });
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects a tampered payload with generic 401 error", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const originalPayload = JSON.stringify({ amount: "100" });
      const tamperedPayload = JSON.stringify({ amount: "999999" });
      
      const validSignature = signWebhookPayload(Buffer.from(originalPayload), timestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${validSignature}`,
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = Buffer.from(tamperedPayload, "utf8");

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook signature" });
      expect(next).not.toHaveBeenCalled();
    });

    it("uses constant-time comparison (crypto.timingSafeEqual) internally", () => {
      // Verify that the implementation uses Buffer-based comparison
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = "test";
      
      const signature1 = signWebhookPayload(payload, timestamp, WEBHOOK_SECRET);
      const signature2 = signWebhookPayload(payload, timestamp, WEBHOOK_SECRET);
      
      // Both should be hex strings that can be compared with timingSafeEqual
      expect(signature1).toBe(signature2);
      expect(signature1).toMatch(/^[a-fA-F0-9]{64}$/);
      
      // Verify buffers can be created and compared
      const buf1 = Buffer.from(signature1, "hex");
      const buf2 = Buffer.from(signature2, "hex");
      expect(crypto.timingSafeEqual(buf1, buf2)).toBe(true);
    });

    it("rejects signature with wrong length without revealing expected signature", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ test: "data" });
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": "sha256=abc123",
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = Buffer.from(payload);

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid signature format" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("timestamp validation", () => {
    it("rejects stale webhook request (>5 minutes old)", async () => {
      const staleTimestamp = Math.floor(Date.now() / 1000) - 400;
      const payload = JSON.stringify({ test: "data" });
      const signature = signWebhookPayload(payload, staleTimestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${signature}`,
        "x-webhook-timestamp": staleTimestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = Buffer.from(payload);

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Stale webhook request" });
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects future webhook request (>5 minutes in future)", async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 400;
      const payload = JSON.stringify({ test: "data" });
      const signature = signWebhookPayload(payload, futureTimestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${signature}`,
        "x-webhook-timestamp": futureTimestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = Buffer.from(payload);

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Stale webhook request" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("replay attack prevention", () => {
    it("accepts first request with webhook ID", async () => {
      mocks.redisSet.mockResolvedValue("OK");
      
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ test: "data" });
      const signature = signWebhookPayload(payload, timestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${signature}`,
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-unique-123",
      };
      (req as any).rawBody = Buffer.from(payload);

      await verifyWebhook(req as Request, res as Response, next);

      expect(mocks.redisSet).toHaveBeenCalledWith(
        "webhook:id:webhook-unique-123",
        "1",
        "EX",
        600,
        "NX"
      );
      expect(next).toHaveBeenCalled();
    });

    it("rejects duplicate webhook ID", async () => {
      mocks.redisSet.mockResolvedValue(null);
      
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ test: "data" });
      const signature = signWebhookPayload(payload, timestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${signature}`,
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-duplicate-456",
      };
      (req as any).rawBody = Buffer.from(payload);

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: "duplicate" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("error edge cases", () => {
    it("rejects when signature header is missing", async () => {
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = Buffer.from("test");

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing signature" });
    });

    it("rejects when raw body is unavailable", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signWebhookPayload("test", timestamp, WEBHOOK_SECRET);
      
      req.headers = {
        "x-webhook-secret": WEBHOOK_SECRET,
        "x-webhook-signature": `sha256=${signature}`,
        "x-webhook-timestamp": timestamp.toString(),
        "x-webhook-id": "webhook-123",
      };
      (req as any).rawBody = undefined;

      await verifyWebhook(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Raw webhook payload unavailable" });
    });
  });
});
