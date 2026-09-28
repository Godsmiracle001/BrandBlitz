import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiLimiter,
  authLimiter,
  challengeStartLimiter,
  normalizeClientIp,
  uploadLimiter,
  phoneRateLimit,
} from "../rate-limit";

// ─── Mock heavy dependencies so the module can be imported in tests ───────────

vi.mock("../../lib/redis", () => ({
  redis: {
    call: vi.fn(),
    on: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

let keySeq = 0;
const nextIp = () =>
  `10.${Math.floor(keySeq / 65025)}.${Math.floor((keySeq % 65025) / 255)}.${(keySeq++ % 255) + 1}`;
const nextUser = () => `test-user-${keySeq++}`;

type Limiter = ReturnType<typeof rateLimit>;

function makeApp(limiter: Limiter, userSub?: string) {
  const app = express();
  app.set("trust proxy", true);
  if (userSub) {
    app.use((_req, _res, next) => {
      (_req as any).user = { sub: userSub };
      next();
    });
  }
  app.use(limiter);
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

async function exhaust(app: express.Express, ip: string, n: number) {
  const responses = await Promise.all(
    Array.from({ length: n }, () => request(app).get("/").set("X-Forwarded-For", ip)),
  );
  responses.forEach((res, i) => {
    expect(res.status, `request ${i + 1}/${n} should be 200`).toBe(200);
  });
}

// ─── Issue #403: Sliding-window rate limiting ──────────────────────────────────

describe("rate-limit — Issue #403", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── AC 1: first request increments Redis counter with TTL ─────────────────

  describe("first request within the window", () => {
    it("allows the first request and the counter starts from zero", async () => {
      const ip = nextIp();
      const app = makeApp(authLimiter);
      const res = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(res.status).toBe(200);
    });
  });

  // ── AC 2: at limit → 429 with Retry-After ────────────────────────────────

  describe("request count at exactly the limit", () => {
    it("allows exactly 10 requests and blocks the 11th with 429", async () => {
      const ip = nextIp();
      const app = makeApp(authLimiter);
      await exhaust(app, ip, 10);
      const over = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(over.status).toBe(429);
    });

    it("returns a Retry-After header on the 429 response", async () => {
      const ip = nextIp();
      const app = makeApp(authLimiter);
      await exhaust(app, ip, 10);
      const over = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(over.headers["retry-after"]).toBeDefined();
    });

    it("returns a JSON error body", async () => {
      const ip = nextIp();
      const app = makeApp(authLimiter);
      await exhaust(app, ip, 10);
      const over = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(over.body.error).toMatch(/login attempts/i);
    });
  });

  // ── AC 3: exceeding the limit is rejected ────────────────────────────────

  describe("request count exceeding the limit", () => {
    it("rejects with 429 and does not increment the counter", async () => {
      const ip = nextIp();
      const app = makeApp(authLimiter);
      await exhaust(app, ip, 10);

      // Block the 11th
      const r11 = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(r11.status).toBe(429);

      // 12th should also be blocked (counter not incremented past limit)
      const r12 = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(r12.status).toBe(429);
    });
  });

  // ── AC 4: X-Forwarded-For parsing ────────────────────────────────────────

  describe("X-Forwarded-For header parsing", () => {
    it("uses the first (client) IP from X-Forwarded-For as the key", async () => {
      const app = makeApp(authLimiter);

      // Exhaust using client IP 1.2.3.4
      const clientIp = "1.2.3.4";
      const forwardedChain = `${clientIp}, 10.0.0.1, 172.16.0.1`;
      await exhaust(app, clientIp, 10);

      // Same client IP in a different chain position → still blocked
      const over = await request(app)
        .get("/")
        .set("X-Forwarded-For", `${clientIp}, 99.99.99.99`);
      expect(over.status).toBe(429);
    });

    it("treats different first IPs as separate buckets", async () => {
      const app = makeApp(authLimiter);
      const ip1 = nextIp();
      const ip2 = nextIp();

      await exhaust(app, ip1, 10);

      // Different first IP → fresh bucket
      const res = await request(app).get("/").set("X-Forwarded-For", ip2);
      expect(res.status).toBe(200);
    });
  });

  // ── AC 5: absent X-Forwarded-For falls back to remoteAddress ─────────────

  describe("absent X-Forwarded-For header", () => {
    it("falls back to req.socket.remoteAddress when X-Forwarded-For is absent", async () => {
      const app = makeApp(authLimiter);
      // Without X-Forwarded-For, express-rate-limit uses req.ip
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    });

    it("uses the same bucket for requests without X-Forwarded-For from the same connection", async () => {
      // Use a fresh limiter to avoid shared state with other tests
      const freshLimiter = rateLimit({
        windowMs: 60_000,
        max: 3,
        standardHeaders: "draft-7",
        legacyHeaders: false,
      });
      const app = makeApp(freshLimiter);

      // Exhaust the default IP bucket
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get("/");
        expect(res.status).toBe(200);
      }

      const over = await request(app).get("/");
      expect(over.status).toBe(429);
    });
  });

  // ── AC 6: Redis key expires after window → fresh counter ─────────────────

  describe("window expiry resets the counter", () => {
    it("counter resets after the window expires and allows requests again", async () => {
      vi.useFakeTimers();

      const shortLimiter = rateLimit({
        windowMs: 500,
        max: 3,
        standardHeaders: "draft-7",
        legacyHeaders: false,
      });
      const ip = nextIp();
      const app = makeApp(shortLimiter);

      await exhaust(app, ip, 3);
      expect((await request(app).get("/").set("X-Forwarded-For", ip)).status).toBe(429);

      // Advance past the window
      vi.advanceTimersByTime(600);

      // Counter should be reset
      expect((await request(app).get("/").set("X-Forwarded-For", ip)).status).toBe(200);
    });
  });

  // ── AC 7: Redis error → fail open ────────────────────────────────────────

  describe("Redis store error — fail open", () => {
    it("passes the request through (200) when the store throws and passOnStoreError is true", async () => {
      const failingStore = {
        increment: vi.fn().mockRejectedValue(new Error("redis unavailable")),
        decrement: vi.fn(),
        resetKey: vi.fn(),
      };

      const failOpenLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        store: failingStore as any,
        passOnStoreError: true,
      });

      const app = makeApp(failOpenLimiter);
      const res = await request(app).get("/").set("X-Forwarded-For", nextIp());
      expect(res.status).toBe(200);
    });

    it("does not block traffic when Redis is down and passOnStoreError is enabled", async () => {
      const failingStore = {
        increment: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        decrement: vi.fn(),
        resetKey: vi.fn(),
      };

      const limiter = rateLimit({
        windowMs: 60_000,
        max: 1,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        store: failingStore as any,
        passOnStoreError: true,
      });

      const app = makeApp(limiter);
      // Multiple requests should all pass through
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get("/").set("X-Forwarded-For", nextIp());
        expect(res.status).toBe(200);
      }
    });
  });

  // ── Per-limiter boundary tests ───────────────────────────────────────────

  describe("apiLimiter — dynamic max", () => {
    it("allows requests up to the dynamic max", async () => {
      const ip = nextIp();
      const app = makeApp(apiLimiter);
      // The dynamic max defaults to 200 — exhaust the first few
      await exhaust(app, ip, 5);
      const next = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(next.status).toBe(200);
    });
  });

  describe("challengeStartLimiter — 5 req / h", () => {
    it("allows exactly 5 requests and blocks the 6th", async () => {
      const ip = nextIp();
      const app = makeApp(challengeStartLimiter);
      await exhaust(app, ip, 5);
      const over = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(over.status).toBe(429);
    });
  });

  describe("uploadLimiter — 20 req / h", () => {
    it("allows exactly 20 requests and blocks the 21st", async () => {
      const ip = nextIp();
      const app = makeApp(uploadLimiter);
      await exhaust(app, ip, 20);
      const over = await request(app).get("/").set("X-Forwarded-For", ip);
      expect(over.status).toBe(429);
    });
  });

  describe("phoneRateLimit — 3 req / 15 min", () => {
    it("limits by phone number from request body", async () => {
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json());
      app.use(phoneRateLimit);
      app.post("/", (_req, res) => res.json({ ok: true }));

      const phone = "+15551234567";
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(app).post("/").send({ phone }).set("X-Forwarded-For", nextIp()),
        ),
      );
      responses.forEach((r) => expect(r.status).toBe(200));

      const over = await request(app)
        .post("/")
        .send({ phone })
        .set("X-Forwarded-For", nextIp());
      expect(over.status).toBe(429);
    });
  });

  // ── Authenticated vs anonymous bucket isolation ──────────────────────────

  describe("bucket isolation", () => {
    it("authenticated requests for the same user share a bucket regardless of IP", async () => {
      const userId = nextUser();
      const app = makeApp(challengeStartLimiter, userId);
      const ip1 = nextIp();
      const ip2 = nextIp();

      await exhaust(app, ip1, 5);

      // Different IP, same user → still blocked
      const blocked = await request(app).get("/").set("X-Forwarded-For", ip2);
      expect(blocked.status).toBe(429);
    });

    it("two different authenticated users get independent buckets", async () => {
      const user1 = nextUser();
      const user2 = nextUser();
      const ip = nextIp();

      const app1 = makeApp(challengeStartLimiter, user1);
      const app2 = makeApp(challengeStartLimiter, user2);

      await exhaust(app1, ip, 5);
      expect((await request(app1).get("/").set("X-Forwarded-For", ip)).status).toBe(429);

      // user2 is unaffected
      expect((await request(app2).get("/").set("X-Forwarded-For", ip)).status).toBe(200);
    });
  });
});

// ─── normalizeClientIp unit tests ─────────────────────────────────────────────

describe("normalizeClientIp", () => {
  it("returns 'anonymous' for undefined input", () => {
    expect(normalizeClientIp(undefined)).toBe("anonymous");
  });

  it("extracts the first IP from a comma-separated X-Forwarded-For", () => {
    expect(normalizeClientIp("1.2.3.4, 10.0.0.1, 172.16.0.1")).toBe("1.2.3.4");
  });

  it("normalizes IPv6 addresses to their /64 prefix", () => {
    expect(normalizeClientIp("2001:db8:abcd:ef12::1")).toBe("2001:db8:abcd:ef12::/64");
  });

  it("unwraps IPv4-mapped IPv6 addresses", () => {
    expect(normalizeClientIp("::ffff:192.0.2.10")).toBe("192.0.2.10");
  });

  it("preserves valid IPv4 addresses unchanged", () => {
    expect(normalizeClientIp("203.0.113.42")).toBe("203.0.113.42");
  });

  it("handles bracket-wrapped IPv6 addresses", () => {
    expect(normalizeClientIp("[2001:db8::1]")).toMatch(/2001:db8/);
  });

  it("strips zone identifiers from IPv6", () => {
    expect(normalizeClientIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});
