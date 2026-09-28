import createHmac from "node:crypto";
import { randomUUID } from "node:crypto";
import { query } from "../db/index";
import { logger } from "../lib/logger";

export interface BrandWebhook {
  id: string;
  brand_id: string;
  url: string;
  secret: string;
  event_types: string[];
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface BrandWebhookDelivery {
  id: string;
  webhook_id: string;
  brand_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  attempts: number;
  status: "pending" | "success" | "failed";
  delivered_at: string | null;
  created_at: string;
}

export async function createBrandWebhook(data: {
  brandId: string;
  url: string;
  secret?: string;
  eventTypes?: string[];
}): Promise<BrandWebhook> {
  const secret = data.secret || randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const eventTypes =
    data.eventTypes && data.eventTypes.length > 0
      ? data.eventTypes
      : ["challenge.started", "challenge.ended", "challenge.settled"];

  const result = await query<BrandWebhook>(
    `INSERT INTO brand_webhooks (brand_id, url, secret, event_types)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.brandId, data.url, secret, eventTypes]
  );
  return result.rows[0];
}

export async function getBrandWebhooks(brandId: string): Promise<BrandWebhook[]> {
  const result = await query<BrandWebhook>(
    `SELECT * FROM brand_webhooks WHERE brand_id = $1 ORDER BY created_at DESC`,
    [brandId]
  );
  return result.rows;
}

export async function getBrandWebhookDeliveries(
  brandId: string,
  limit = 50
): Promise<BrandWebhookDelivery[]> {
  const result = await query<BrandWebhookDelivery>(
    `SELECT * FROM brand_webhook_deliveries WHERE brand_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [brandId, limit]
  );
  return result.rows;
}

export async function sendWebhookRequestWithRetry(
  deliveryId: string,
  url: string,
  secret: string,
  eventType: string,
  payloadStr: string,
  maxAttempts = 3
): Promise<void> {
  const signature = createHmac.createHmac("sha256", secret).update(payloadStr).digest("hex");
  let attempt = 0;
  let success = false;
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  while (attempt < maxAttempts && !success) {
    attempt++;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BrandBlitz-Signature": `sha256=${signature}`,
          "X-BrandBlitz-Event": eventType,
          "User-Agent": "BrandBlitz-WebhookDispatcher/1.0",
        },
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      responseStatus = res.status;
      responseBody = (await res.text()).slice(0, 1000);

      if (res.ok) {
        success = true;
      } else {
        errorMessage = `HTTP error status ${res.status}`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (!success && attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt - 1) * 100;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  await query(
    `UPDATE brand_webhook_deliveries
     SET response_status = $1,
         response_body = $2,
         error_message = $3,
         attempts = $4,
         status = $5,
         delivered_at = $6
     WHERE id = $7`,
    [
      responseStatus,
      responseBody,
      errorMessage,
      attempt,
      success ? "success" : "failed",
      success ? new Date().toISOString() : null,
      deliveryId,
    ]
  );
}

/**
 * Dispatch signed HMAC webhooks on challenge state transitions.
 */
export async function dispatchBrandWebhookEvent(
  brandId: string,
  challengeId: string,
  status: string,
  extraData: Record<string, unknown> = {}
): Promise<void> {
  try {
    let eventType = `challenge.${status}`;
    if (status === "active") eventType = "challenge.started";
    if (status === "ended") eventType = "challenge.ended";
    if (status === "settled") eventType = "challenge.settled";

    const webhooksRes = await query<BrandWebhook>(
      `SELECT * FROM brand_webhooks 
       WHERE brand_id = $1 
         AND status = 'active'
         AND ($2 = ANY(event_types) OR $3 = ANY(event_types) OR '*' = ANY(event_types))`,
      [brandId, eventType, `challenge.${status}`]
    );

    const webhooks = webhooksRes.rows;
    if (webhooks.length === 0) return;

    for (const hook of webhooks) {
      const payload = {
        id: randomUUID(),
        event: eventType,
        challenge_id: challengeId,
        brand_id: brandId,
        timestamp: new Date().toISOString(),
        data: {
          challenge_id: challengeId,
          status,
          ...extraData,
        },
      };

      const payloadStr = JSON.stringify(payload);

      const deliveryRes = await query<{ id: string }>(
        `INSERT INTO brand_webhook_deliveries (webhook_id, brand_id, event_type, payload, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending')
         RETURNING id`,
        [hook.id, brandId, eventType, payloadStr]
      );

      const deliveryId = deliveryRes.rows[0].id;

      sendWebhookRequestWithRetry(deliveryId, hook.url, hook.secret, eventType, payloadStr).catch(
        (err) => {
          logger.error("Error dispatching brand webhook", { deliveryId, brandId, err });
        }
      );
    }
  } catch (err) {
    logger.error("Failed to process brand webhook event dispatch", {
      brandId,
      challengeId,
      status,
      err,
    });
  }
}
