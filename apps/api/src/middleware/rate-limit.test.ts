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
} from "./rate-limit";

// ─── Mock heavy dependencies so the module can be imported in tests ───────────

vi.mock("../lib/redis", () => ({
  redis: {
    call: vi.fn(),
    on: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Unique key counter — prevents state bleed between tests.
let keySeq = 0;
const nextIp = () =>
  `10.${Math.floor(keySeq / 65025)}.${Math.floor((keySeq % 65025) / 255)}.${(keySeq++ % 255) + 1}`;
const nextUser = () => `test-user-${keySeq++}`;

type Limiter = ReturnType<typeof rateLimit>;

/** Creates a minimal Express app protected by the given limiter. */
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

/** Fires `n` requests from `ip`, all expected to succeed (200). */
async function exhaust(app: express.Express, ip: string, n: number) {
  const responses = await Promise.all(
    Array.from({ length: n }, () => request(app).get("/").set("X-Forwarded-For", ip)),
  );
  responses.forEach((res, i) => {
    expect(res.status, `request ${i + 1}/${n} should be 200`).toBe(200);
  });
}

// ─── Per-policy boundary tests ─────────────────────────────────────────────────

describe("apiLimiter — 200 req / 15 min", () => {
  let ip: string;

  beforeEach(() => { ip = nextIp(); });

  it("allows exactly 200 requests and blocks the 201st with 429", async () => {
    const app = makeApp(apiLimiter);
    await exhaust(app, ip, 200);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.status).toBe(429);
  });

  it("sets Retry-After on the rate-limited response", async () => {
    const app = makeApp(apiLimiter);
    await exhaust(app, ip, 200);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.headers["retry-after"]).toBeDefined();
  });
});

describe("authLimiter — 10 req / 15 min", () => {
  let ip: string;

  beforeEach(() => { ip = nextIp(); });

  it("allows exactly 10 requests and blocks the 11th with 429", async () => {
    const app = makeApp(authLimiter);
    await exhaust(app, ip, 10);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.status).toBe(429);
  });

  it("sets Retry-After on the rate-limited response", async () => {
    const app = makeApp(authLimiter);
    await exhaust(app, ip, 10);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.headers["retry-after"]).toBeDefined();
  });

  it("returns the custom error message", async () => {
    const app = makeApp(authLimiter);
    await exhaust(app, ip, 10);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.body.error).toMatch(/login attempts/i);
  });
});

describe("challengeStartLimiter — 5 req / 1 h", () => {
  let ip: string;

  beforeEach(() => { ip = nextIp(); });

  it("allows exactly 5 requests and blocks the 6th with 429", async () => {
    const app = makeApp(challengeStartLimiter);
    await exhaust(app, ip, 5);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.status).toBe(429);
  });

  it("sets Retry-After on the rate-limited response", async () => {
    const app = makeApp(challengeStartLimiter);
    await exhaust(app, ip, 5);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.headers["retry-after"]).toBeDefined();
  });
});

describe("uploadLimiter — 20 req / 1 h", () => {
  let ip: string;

  beforeEach(() => { ip = nextIp(); });

  it("allows exactly 20 requests and blocks the 21st with 429", async () => {
    const app = makeApp(uploadLimiter);
    await exhaust(app, ip, 20);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.status).toBe(429);
  });

  it("sets Retry-After on the rate-limited response", async () => {
    const app = makeApp(uploadLimiter);
    await exhaust(app, ip, 20);
    const over = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(over.headers["retry-after"]).toBeDefined();
  });
});

// ─── Key derivation ────────────────────────────────────────────────────────────

describe("key derivation", () => {
  it("normalizes IPv6 addresses to their /64 prefix and preserves IPv4 addresses", () => {
    expect(normalizeClientIp("203.0.113.42")).toBe("203.0.113.42");
    expect(normalizeClientIp("2001:db8:abcd:ef12::1")).toBe("2001:db8:abcd:ef12::/64");
    expect(normalizeClientIp("2001:0db8:abcd:ef12:0000:0000:0000:abcd")).toBe(
      "2001:db8:abcd:ef12::/64"
    );
    expect(normalizeClientIp("::ffff:192.0.2.10")).toBe("192.0.2.10");
  });

  it("unauthenticated requests from the same IP share a bucket", async () => {
    const ip = nextIp();
    const app = makeApp(challengeStartLimiter); // max=5, easy to exhaust
    await exhaust(app, ip, 5);

    // Second request — same IP, still unauthenticated — should be blocked
    const blocked = await request(app).get("/").set("X-Forwarded-For", ip);
    expect(blocked.status).toBe(429);
  });

  it("authenticated requests for the same user ID share a bucket regardless of IP", async () => {
    const userId = nextUser();
    const app = makeApp(challengeStartLimiter, userId); // attaches user.sub
    const ip1 = nextIp();
    const ip2 = nextIp();

    // Exhaust using ip1
    await exhaust(app, ip1, 5);

    // Different IP, same user — should still be rate-limited
    const blocked = await request(app).get("/").set("X-Forwarded-For", ip2);
    expect(blocked.status).toBe(429);
  });

  it("counts rotated IPv6 addresses inside the same /64 together", async () => {
    const app = makeApp(challengeStartLimiter);
    const responses = [];

    for (let i = 0; i < 100; i++) {
      const ip = `2001:db8:abcd:${keySeq.toString(16)}::${i.toString(16)}`;
      responses.push(await request(app).get("/").set("X-Forwarded-For", ip));
    }

    expect(responses.filter((res) => res.status === 200)).toHaveLength(5);
    expect(responses.filter((res) => res.status === 429)).toHaveLength(95);
  });

  it("uses the same IPv6 /64 bucket on pre-authentication routes", async () => {
    const app = makeApp(authLimiter);
    const prefix = keySeq.toString(16);

    for (let i = 0; i < 10; i++) {
      const response = await request(app)
        .get("/")
        .set("X-Forwarded-For", `2001:db8:beef:${prefix}::${i.toString(16)}`);
      expect(response.status).toBe(200);
    }

    const blocked = await request(app)
      .get("/")
      .set("X-Forwarded-For", `2001:db8:beef:${prefix}::ffff`);
    expect(blocked.status).toBe(429);
  });

  it("two different authenticated users get independent buckets", async () => {
    const user1 = nextUser();
    const user2 = nextUser();
    const ip = nextIp();

    const app1 = makeApp(challengeStartLimiter, user1);
    const app2 = makeApp(challengeStartLimiter, user2);

    await exhaust(app1, ip, 5);

    // user1 is rate-limited…
    expect((await request(app1).get("/").set("X-Forwarded-For", ip)).status).toBe(429);

    // …but user2 is unaffected — first request returns 200
    expect((await request(app2).get("/").set("X-Forwarded-For", ip)).status).toBe(200);
  });
});

// ─── Window reset ──────────────────────────────────────────────────────────────

describe("window reset", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("counter resets after the window expires and allows requests again", async () => {
    vi.useFakeTimers();

    // Use a fresh short-window limiter to avoid state sharing with other tests
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

    // Counter should be reset — first request in the new window is 200
    expect((await request(app).get("/").set("X-Forwarded-For", ip)).status).toBe(200);
  });
});

// ─── Redis down → fail open ────────────────────────────────────────────────────

describe("Redis store error — fail open", () => {
  it("passes the request through (200) when the store throws", async () => {
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

  it("blocks with 500 (not silently) when passOnStoreError is false", async () => {
    const failingStore = {
      increment: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      decrement: vi.fn(),
      resetKey: vi.fn(),
    };

    const failClosedLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      store: failingStore as any,
      passOnStoreError: false,
    });

    const app = express();
    app.use(failClosedLimiter);
    app.get("/", (_req, res) => res.json({ ok: true }));
    // Add a minimal error handler so the test app returns a response
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "store error" });
    });

    const res = await request(app).get("/");
    expect(res.status).toBe(500);
  });
});
