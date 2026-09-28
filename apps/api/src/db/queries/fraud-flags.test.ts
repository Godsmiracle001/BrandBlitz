import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();

vi.mock("../index", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { getFraudFlags } from "./fraud-flags";
import { CursorQuerySchema } from "../pagination";

function lastQueries(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0]));
}

describe("getFraudFlags index-aligned query (issue #342)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    // rows query + count query both resolve
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });
  });

  it("orders by the indexed created_at column, newest first", async () => {
    await getFraudFlags({ pageSize: 20 });
    const rowsSql = lastQueries().find((q) => q.includes("FROM fraud_flags ff"));
    expect(rowsSql).toBeDefined();
    expect(rowsSql).toMatch(/ORDER BY ff\.created_at DESC/);
  });

  it("bounds the result set with a LIMIT placeholder", async () => {
    await getFraudFlags({ pageSize: 20 });
    const rowsSql = lastQueries().find((q) => q.includes("FROM fraud_flags ff"));
    expect(rowsSql).toMatch(/LIMIT \$\d+/);
  });

  it("passes the page size through as the LIMIT parameter", async () => {
    await getFraudFlags({ pageSize: 50 });
    const rowsCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("FROM fraud_flags ff"),
    );
    const params = rowsCall?.[1] as unknown[];
    expect(params[params.length - 1]).toBe(50);
  });
});

describe("CursorQuerySchema page-size cap (issue #342)", () => {
  it("rejects a page size above the 100-row cap", () => {
    expect(() => CursorQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it("accepts the maximum page size of 100", () => {
    expect(CursorQuerySchema.parse({ limit: 100 }).limit).toBe(100);
  });

  it("defaults to a bounded page size when omitted", () => {
    const parsed = CursorQuerySchema.parse({});
    expect(parsed.limit).toBeLessThanOrEqual(100);
  });
});
