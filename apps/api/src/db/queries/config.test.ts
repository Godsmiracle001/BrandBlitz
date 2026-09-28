import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../index", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { getConfig, getConfigRow, getPublicConfig, PUBLIC_CONFIG_KEYS, setConfig } from "./config";

describe("getPublicConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only queries app_config for the whitelisted keys", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getPublicConfig();

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [PUBLIC_CONFIG_KEYS]);
  });

  it("flattens whitelisted rows into a flat key/value object", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { key: "game_round_duration_seconds", value: 30 },
        { key: "maintenance_mode", value: true },
      ],
    });

    const result = await getPublicConfig();

    expect(result).toEqual({
      game_round_duration_seconds: 30,
      maintenance_mode: true,
    });
  });

  it("returns an empty object when no whitelisted keys exist in app_config", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPublicConfig();

    expect(result).toEqual({});
  });
});

describe("getConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the value for an existing key", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: { limit: 5 } }] });

    const result = await getConfig("rate_limit_requests_per_minute");

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["rate_limit_requests_per_minute"]);
    expect(result).toEqual({ limit: 5 });
  });

  it("returns null when the key does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getConfig("nonexistent");

    expect(result).toBeNull();
  });
});

describe("getConfigRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the full row including change-tracking metadata", async () => {
    const row = {
      key: "anti_cheat",
      value: { minReactionTimeMs: 150 },
      updated_at: "2026-07-01T00:00:00.000Z",
      updated_by: "admin-1",
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await getConfigRow("anti_cheat");

    expect(result).toEqual(row);
  });

  it("returns null when the key does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getConfigRow("nonexistent");

    expect(result).toBeNull();
  });
});

describe("setConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts the new value into app_config keyed by the config key", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: { limit: 100 } }] }); // existing-value lookup
    mockQuery.mockResolvedValueOnce({ rows: [] }); // upsert
    mockQuery.mockResolvedValueOnce({ rows: [] }); // audit_log insert

    await setConfig("rate_limit_requests_per_minute", { limit: 5 }, "admin-1");

    const [upsertSql, upsertParams] = mockQuery.mock.calls[1];
    expect(upsertSql).toContain("INSERT INTO app_config");
    expect(upsertSql).toContain("ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    expect(upsertParams).toEqual([
      "rate_limit_requests_per_minute",
      JSON.stringify({ limit: 5 }),
      "admin-1",
    ]);
  });

  it("writes an audit_log entry referencing the changed key, actor, and before/after values", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: { limit: 100 } }] }); // existing value
    mockQuery.mockResolvedValueOnce({ rows: [] }); // upsert
    mockQuery.mockResolvedValueOnce({ rows: [] }); // audit_log insert

    await setConfig("rate_limit_requests_per_minute", { limit: 5 }, "admin-1");

    const [auditSql, auditParams] = mockQuery.mock.calls[2];
    expect(auditSql).toContain("INSERT INTO audit_log");
    expect(auditParams).toEqual([
      "admin-1",
      "rate_limit_requests_per_minute",
      { limit: 100 },
      { limit: 5 },
    ]);
  });

  it("records a null 'before' value in the audit log when the key is set for the first time", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no existing row
    mockQuery.mockResolvedValueOnce({ rows: [] }); // upsert
    mockQuery.mockResolvedValueOnce({ rows: [] }); // audit_log insert

    await setConfig("deposit_required_confirmations", { confirmations: 3 }, "admin-1");

    const [, auditParams] = mockQuery.mock.calls[2];
    expect(auditParams).toEqual([
      "admin-1",
      "deposit_required_confirmations",
      null,
      { confirmations: 3 },
    ]);
  });
});
