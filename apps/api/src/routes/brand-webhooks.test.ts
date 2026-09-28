import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import brandsRouter from "./brands";
import { errorHandler } from "../middleware/error";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getBrandById: vi.fn(),
  createBrandWebhook: vi.fn(),
  getBrandWebhooks: vi.fn(),
  getBrandWebhookDeliveries: vi.fn(),
}));

vi.mock("../db/queries/brands", () => ({
  getBrandById: mocks.getBrandById,
}));

vi.mock("../services/brand-webhooks", () => ({
  createBrandWebhook: mocks.createBrandWebhook,
  getBrandWebhooks: mocks.getBrandWebhooks,
  getBrandWebhookDeliveries: mocks.getBrandWebhookDeliveries,
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { sub: "user-owner-1", role: "brand" };
    next();
  },
}));

vi.mock("../middleware/require-tos", () => ({
  requireCurrentTosAccepted: (_req: any, _res: any, next: any) => next(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/brands", brandsRouter);
  app.use(errorHandler);
  return app;
}

describe("Brand Webhook Subscriptions (Issue #1289)", () => {
  const brandId = "brand-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBrandById.mockResolvedValue({
      id: brandId,
      owner_user_id: "user-owner-1",
      name: "Acme Brand",
    });
  });

  it("POST /brands/:id/webhooks registers a new webhook subscription", async () => {
    const mockWebhook = {
      id: "wh-1",
      brand_id: brandId,
      url: "https://example.com/webhook",
      secret: "super-secret-key-123456",
      event_types: ["challenge.started", "challenge.ended"],
      status: "active",
      created_at: new Date().toISOString(),
    };
    mocks.createBrandWebhook.mockResolvedValue(mockWebhook);

    const res = await request(createApp())
      .post(`/brands/${brandId}/webhooks`)
      .send({
        url: "https://example.com/webhook",
        secret: "super-secret-key-123456",
        eventTypes: ["challenge.started", "challenge.ended"],
      });

    expect(res.status).toBe(201);
    expect(res.body.webhook).toEqual(mockWebhook);
    expect(mocks.createBrandWebhook).toHaveBeenCalledWith({
      brandId,
      url: "https://example.com/webhook",
      secret: "super-secret-key-123456",
      eventTypes: ["challenge.started", "challenge.ended"],
    });
  });

  it("POST /brands/:id/webhooks rejects invalid URL", async () => {
    const res = await request(createApp()).post(`/brands/${brandId}/webhooks`).send({
      url: "invalid-url-string",
    });

    expect(res.status).toBe(422);
    expect(mocks.createBrandWebhook).not.toHaveBeenCalled();
  });

  it("GET /brands/:id/webhooks returns registered webhooks for brand owner", async () => {
    const mockList = [
      { id: "wh-1", brand_id: brandId, url: "https://example.com/wh1", status: "active" },
    ];
    mocks.getBrandWebhooks.mockResolvedValue(mockList);

    const res = await request(createApp()).get(`/brands/${brandId}/webhooks`);

    expect(res.status).toBe(200);
    expect(res.body.webhooks).toEqual(mockList);
    expect(mocks.getBrandWebhooks).toHaveBeenCalledWith(brandId);
  });

  it("GET /brands/:id/webhooks/deliveries returns delivery logs", async () => {
    const mockDeliveries = [
      {
        id: "del-1",
        webhook_id: "wh-1",
        brand_id: brandId,
        event_type: "challenge.started",
        status: "success",
        response_status: 200,
        attempts: 1,
      },
    ];
    mocks.getBrandWebhookDeliveries.mockResolvedValue(mockDeliveries);

    const res = await request(createApp()).get(`/brands/${brandId}/webhooks/deliveries`);

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toEqual(mockDeliveries);
    expect(mocks.getBrandWebhookDeliveries).toHaveBeenCalledWith(brandId);
  });

  it("returns 403 when non-owner non-admin tries to register webhooks", async () => {
    mocks.getBrandById.mockResolvedValue({
      id: brandId,
      owner_user_id: "other-user",
      name: "Acme Brand",
    });

    const res = await request(createApp())
      .post(`/brands/${brandId}/webhooks`)
      .send({ url: "https://example.com/webhook" });

    expect(res.status).toBe(403);
    expect(mocks.createBrandWebhook).not.toHaveBeenCalled();
  });
});
