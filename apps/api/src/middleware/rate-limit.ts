/**
 * rate-limit.ts — Application-layer rate limiting.
 *
 * Strategy (Issue #226):
 *   - Authenticated requests  → keyed by JWT `sub` (user ID).
 *     Each user gets their own independent bucket regardless of IP.
 *   - Anonymous requests       → keyed by IP, but with a much higher limit
 *     so mobile carriers / corporate NAT are not punished.
 *   - nginx acts as a coarse anti-abuse fence (200 req/s / 500 burst per IP).
 *     These application-layer limits are the fine-grained enforcement.
 *
 * Metrics: every 429 response increments a labelled counter so alerts can
 * fire when the rate spikes.
 *
 * Closes #226
 */

import type { Request, Response } from "express";
import { isIP } from "node:net";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";
import { config } from "../lib/config";

// ── Metrics ───────────────────────────────────────────────────────────────────

/** Increment a labelled 429 counter so dashboards / alerts can track spikes. */
function record429(limiterName: string, key: string): void {
  logger.warn("Rate limit exceeded", {
    limiter: limiterName,
    key,
    metric: "rate_limit.exceeded",
  });
}

// ── Key derivation ────────────────────────────────────────────────────────────

function parseIpv4Hextets(part: string): string[] | null {
  if (isIP(part) !== 4) return null;

  const octets = part.split(".").map((octet) => Number.parseInt(octet, 10));
  return [
    ((octets[0] << 8) | octets[1]).toString(16),
    ((octets[2] << 8) | octets[3]).toString(16),
  ];
}

function expandIpv6(address: string): string[] | null {
  const withoutZone = address.split("%", 1)[0].toLowerCase();
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;

  const expandParts = (value: string): string[] => {
    if (!value) return [];
    return value.split(":").flatMap((part) => parseIpv4Hextets(part) ?? [part]);
  };

  const left = expandParts(halves[0]);
  const right = halves.length === 2 ? expandParts(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) =>
    Number.parseInt(part || "0", 16).toString(16)
  );
}

export function normalizeClientIp(ip: string | undefined): string {
  if (!ip) return "anonymous";

  const forwardedIp = ip.split(",", 1)[0].trim();
  const unwrapped =
    forwardedIp.startsWith("[") && forwardedIp.includes("]")
      ? forwardedIp.slice(1, forwardedIp.indexOf("]"))
      : forwardedIp;
  const withoutZone = unwrapped.split("%", 1)[0].toLowerCase();

  if (isIP(withoutZone) === 4) return withoutZone;

  const ipv4Mapped = withoutZone.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Mapped && isIP(ipv4Mapped[1]) === 4) return ipv4Mapped[1];

  if (isIP(withoutZone) !== 6) return forwardedIp || "anonymous";

  const hextets = expandIpv6(withoutZone);
  if (!hextets) return withoutZone;

  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * Returns the JWT `sub` for authenticated requests, or the client IP for
 * anonymous ones.  Prefixed so the two namespaces never collide in Redis.
 */
function userAwareKey(req: Request): string {
  if (req.user?.sub) {
    return `user:${req.user.sub}`;
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

function ipKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip)}`;
}

// ── Redis store ───────────────────────────────────────────────────────────────

function makeRedisStore() {
  return new RedisStore({
    sendCommand: async (...args: string[]) => {
      const command = typeof (redis as any).call === "function"
        ? (redis as any).call
        : (redis as any).sendCommand;
      if (!command) throw new TypeError("Redis client does not support call/sendCommand");
      try {
        return await command.apply(redis, args);
      } catch (err) {
        logger.warn("Rate-limit: Redis store error; failing open", {
          error: (err as Error).message,
        });
        throw err;
      }
    },
  });
}

const redisStore = config.NODE_ENV === "test" ? undefined : makeRedisStore();

// ── Limiters ──────────────────────────────────────────────────────────────────

import { getConfig } from "../db/queries/config";

let cachedRateLimit = 200;
let lastRateLimitFetch = 0;
const RATE_LIMIT_CACHE_TTL = 10000; // 10 seconds

async function getApiRateLimit(): Promise<number> {
  const now = Date.now();
  if (now - lastRateLimitFetch > RATE_LIMIT_CACHE_TTL) {
    try {
      const configObj = await getConfig("rate_limit_requests_per_minute");
      if (configObj && typeof configObj.limit === "number") {
        cachedRateLimit = configObj.limit;
      }
    } catch (err) {
      logger.warn("Failed to fetch rate_limit_requests_per_minute", { error: (err as Error).message });
    }
    lastRateLimitFetch = now;
  }
  return cachedRateLimit;
}

/**
 * General API rate limit.
 *   - Authenticated users: dynamic req / 15 min per user ID
 *   - Anonymous (IP):      dynamic req / 15 min per IP
 *     (higher than before to avoid punishing shared IPs)
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: async () => await getApiRateLimit(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userAwareKey,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("apiLimiter", userAwareKey(req));
    res.status(429).json({ error: "Too many requests, please try again later" });
  },
});

/**
 * Auth endpoints: always keyed by IP (pre-authentication).
 * Kept intentionally tight — 10 req / 15 min.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: ipKey,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("authLimiter", normalizeClientIp(req.ip));
    res.status(429).json({ error: "Too many login attempts, please try again later" });
  },
});

/**
 * Challenge start: 5 req / hour per user/IP.
 * Prevents automated challenge farming.
 */
export const challengeStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userAwareKey,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("challengeStartLimiter", userAwareKey(req));
    res.status(429).json({ error: "Too many challenge attempts" });
  },
});

/**
 * Upload presign: 20 req / hour per user/IP.
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userAwareKey,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("uploadLimiter", userAwareKey(req));
    res.status(429).json({ error: "Too many upload requests" });
  },
});

/**
 * Webhook endpoints: 1000 req / hour (internal-to-internal).
 * Always uses Redis — webhooks are never anonymous.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: ipKey,
  store: redisStore,
});

/**
 * OTP phone limiter: 3 req / 15 min per phone number.
 */
export const phoneRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  passOnStoreError: true,
  store: redisStore,
  keyGenerator: (req) => {
    const raw = typeof req.body?.phone === "string" ? req.body.phone.replace(/\D/g, "") : "";
    return raw ? `phone:${raw}` : userAwareKey(req);
  },
  handler: (req, res, next, options) => {
    const raw = typeof req.body?.phone === "string" ? req.body.phone.replace(/\D/g, "") : "";
    const key = raw ? `phone:${raw}` : userAwareKey(req);
    logger.warn("Rate limit exceeded", {
      limiter: "phoneRateLimit",
      key,
      metric: "rate_limit.exceeded",
    });
    res.setHeader("Retry-After", Math.ceil(options.windowMs / 1000));
    res.status(429).json({ error: "Too many verification attempts, please try again later" });
  },
});

/**
 * Webhook rotation endpoints: 10 req / hour per admin user.
 * Prevents abuse of secret rotation.
 */
export const webhookRotationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userAwareKey,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("webhookRotationLimiter", userAwareKey(req));
    res.status(429).json({ error: "Too many webhook rotation requests" });
  },
});

/**
 * Waitlist signup: 5 req / hour per IP (#470).
 * Public endpoint — keyed by IP to prevent bulk scraping.
 */
export const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: ipKey,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("waitlistLimiter", normalizeClientIp(req.ip));
    res.status(429).json({ error: "Too many signup attempts, please try again later" });
  },
});

/**
 * Question preview (issue #467): 10 req / hour per brand.
 * Keyed by the :id route param (not the caller) so the cap applies per-brand
 * regardless of which owner/admin account is making the request, preventing
 * AI generation cost abuse via a single brand.
 */
export const questionPreviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `brand:${req.params.id}`,
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    record429("questionPreviewLimiter", `brand:${req.params.id}`);
    res.status(429).json({ error: "Too many question preview requests for this brand" });
  },
});

/**
 * Challenge report: 5 req / 15 min per authenticated user.
 * Prevents report-spam across multiple challenges.
 */
export const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.sub ? `user:${req.user.sub}` : `ip:${normalizeClientIp(req.ip)}`),
  passOnStoreError: true,
  store: redisStore,
  handler: (req, res) => {
    const key = req.user?.sub ? `user:${req.user.sub}` : `ip:${normalizeClientIp(req.ip)}`;
    record429("reportLimiter", key);
    res.status(429).json({ error: "Too many report requests, please try again later" });
  },
});
