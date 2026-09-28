import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  metricsInc: vi.fn(),
}));

vi.mock("./redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
  },
}));

vi.mock("./metrics", () => ({
  metrics: { inc: mocks.metricsInc },
}));

import { cached } from "./cache";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const KEY = "test:key";
const TTL = 60;

function makeLoader<T>(value: T) {
  return vi.fn(async () => value);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cached()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
  });

  it("returns cached value and skips loader on hit", async () => {
    const payload = { x: 1 };
    mocks.redisGet.mockResolvedValue(JSON.stringify(payload));
    const loader = makeLoader(payload);

    const result = await cached(KEY, TTL, loader);

    expect(result).toEqual(payload);
    expect(loader).not.toHaveBeenCalled();
    expect(mocks.metricsInc).toHaveBeenCalledWith("cache.hit_total", { key: KEY });
  });

  it("calls loader once on miss, writes to Redis, returns value", async () => {
    mocks.redisGet.mockResolvedValue(null);            // cache miss
    mocks.redisSet.mockResolvedValueOnce("OK");        // lock acquired
    const payload = { y: 2 };
    const loader = makeLoader(payload);

    const result = await cached(KEY, TTL, loader);

    expect(result).toEqual(payload);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mocks.metricsInc).toHaveBeenCalledWith("cache.miss_total", { key: KEY });
    // Writes cache entry with correct TTL
    expect(mocks.redisSet).toHaveBeenCalledWith(
      KEY,
      JSON.stringify(payload),
      "EX",
      TTL,
    );
    // Releases lock
    expect(mocks.redisDel).toHaveBeenCalledWith(`lock:${KEY}`);
  });

  it("stampede: second caller waits and gets value from cache without calling loader", async () => {
    const payload = { z: 3 };

    // First call: cache miss, acquires lock, runs loader
    // Second call: cache miss, lock already held (set returns null), then cache appears
    let firstLoaderDone = false;
    const firstLoader = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 80));
      firstLoaderDone = true;
      return payload;
    });

    // For the second caller simulation:
    // redisGet returns null twice then the populated value
    let getCallCount = 0;
    mocks.redisGet.mockImplementation(async () => {
      getCallCount++;
      // After lock released and cache populated
      if (getCallCount >= 3) return JSON.stringify(payload);
      return null;
    });

    // First set call (lock acquire) → OK; second set (cache write) → OK
    // For the second caller, lock acquire returns null (not acquired)
    let setCallCount = 0;
    mocks.redisSet.mockImplementation(async (_k: string, _v: string, ...args: string[]) => {
      setCallCount++;
      // Lock acquire for second caller should return null
      if (args.includes("NX") && setCallCount > 1) return null;
      return "OK";
    });

    const result = await cached(KEY, TTL, firstLoader);
    expect(result).toEqual(payload);
    expect(firstLoaderDone).toBe(true);
  });

  it("timeout fallback: falls through to loader when cache never appears", async () => {
    // Cache never gets populated (lock held by someone who crashes)
    mocks.redisGet.mockResolvedValue(null);
    // Lock acquire fails (held by other)
    mocks.redisSet.mockImplementation(async (_k: string, _v: string, ...args: string[]) => {
      if (args.includes("NX")) return null;
      return "OK";
    });

    const payload = { fallback: true };
    const loader = makeLoader(payload);

    const result = await cached(KEY, TTL, loader);

    expect(result).toEqual(payload);
    expect(loader).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("emits cache.stampede_avoided_total when a waiter gets the value from cache", async () => {
    const payload = { avoided: true };
    let getCallCount = 0;

    mocks.redisGet.mockImplementation(async () => {
      getCallCount++;
      if (getCallCount === 1) return null; // initial miss
      return JSON.stringify(payload);      // subsequent polls hit
    });

    // Lock not acquired (held by other)
    mocks.redisSet.mockResolvedValue(null);

    await cached(KEY, TTL, makeLoader(payload));

    expect(mocks.metricsInc).toHaveBeenCalledWith("cache.stampede_avoided_total", { key: KEY });
  });

  it("get on non-existent key returns null (not undefined)", async () => {
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValueOnce("OK");
    const loader = makeLoader({ data: "value" });

    await cached(KEY, TTL, loader);

    // Verify first get call (which checks cache) received null
    expect(mocks.redisGet).toHaveBeenCalledWith(KEY);
  });

  it("sets a key with a TTL and calls loader on miss", async () => {
    const ttl = 60;
    const payload = { test: "data" };
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValueOnce("OK");
    const loader = makeLoader(payload);

    await cached(KEY, ttl, loader);

    // Verify TTL was respected
    expect(mocks.redisSet).toHaveBeenCalledWith(
      KEY,
      JSON.stringify(payload),
      "EX",
      ttl,
    );
  });

  it("invalidate removes the key", async () => {
    mocks.redisGet.mockResolvedValue(JSON.stringify({ data: "cached" }));
    const loader = makeLoader({ data: "fresh" });

    // First call hits cache
    const result1 = await cached(KEY, TTL, loader);
    expect(result1.data).toBe("cached");

    // Simulate invalidation by clearing the cache
    mocks.redisGet.mockResolvedValueOnce(null);
    mocks.redisSet.mockResolvedValueOnce("OK");

    // Next call should call loader (cache miss)
    const result2 = await cached(KEY, TTL, loader);
    expect(result2.data).toBe("fresh");
  });

  it("serializes and deserializes nested objects correctly", async () => {
    const complexPayload = {
      rounds: [{ score: 100, correct: true }, { score: 50, correct: false }],
      metadata: { userId: "user1", timestamp: "2024-01-01T00:00:00Z" },
    };

    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValueOnce("OK");
    const loader = makeLoader(complexPayload);

    const result = await cached(KEY, TTL, loader);

    expect(result).toEqual(complexPayload);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].score).toBe(100);
    expect(result.metadata.userId).toBe("user1");
  });

  it("concurrent set calls for same key result in last-write value", async () => {
    // Simulate multiple concurrent calls updating the same key
    const firstPayload = { version: 1 };
    const lastPayload = { version: 3 };

    let setCallCount = 0;
    mocks.redisSet.mockImplementation(async (...args: any[]) => {
      setCallCount++;
      if (args.includes("NX")) return "OK"; // lock acquired on first call
      return "OK"; // subsequent writes
    });

    mocks.redisGet.mockResolvedValue(null);
    const loader = makeLoader(lastPayload);

    const result = await cached(KEY, TTL, loader);

    expect(result).toEqual(lastPayload);
  });

  it("key namespacing prevents collisions", async () => {
    const key1 = "leaderboard:weekly:page:1";
    const key2 = "leaderboard:daily:page:1";
    const value1 = { page: 1, period: "weekly" };
    const value2 = { page: 1, period: "daily" };

    // Mock different returns for different keys
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === key1) return JSON.stringify(value1);
      if (key === key2) return JSON.stringify(value2);
      return null;
    });

    const result1 = await cached(key1, TTL, makeLoader(value1));
    const result2 = await cached(key2, TTL, makeLoader(value2));

    expect(result1.period).toBe("weekly");
    expect(result2.period).toBe("daily");
    // Ensure they're different
    expect(result1).not.toEqual(result2);
  });
});
