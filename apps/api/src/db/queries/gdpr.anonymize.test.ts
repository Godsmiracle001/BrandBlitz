import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks ────────────────────────────────────────────────────────────────────
// Follow the apps/api DB-mocking pattern: mock the db `pool` and capture every
// statement the transaction issues so we can assert on its side effects.

interface Captured {
  text: string;
  params?: unknown[];
}

const hoisted = vi.hoisted(() => {
  const captured: Captured[] = [];
  // Minimal in-memory game_sessions store so we can assert device_id is nulled.
  const sessions = new Map<string, { user_id: string; device_id: string | null }>();

  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      captured.push({ text, params });

      if (/UPDATE\s+game_sessions\s+SET\s+device_id\s*=\s*NULL/i.test(text)) {
        const userId = params?.[0];
        for (const [k, s] of sessions.entries()) {
          if (s.user_id === userId) {
            sessions.set(k, { ...s, device_id: null });
          }
        }
      }

      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  return { captured, sessions, client };
});

vi.mock("../index", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  pool: { connect: vi.fn(async () => hoisted.client) },
}));

import {
  anonymizeUser,
  GDPR_ERASURE_ACTION,
  GDPR_ERASURE_CLEARED_COLUMNS,
} from "./gdpr";

function findStatement(re: RegExp): Captured | undefined {
  return hoisted.captured.find((c) => re.test(c.text));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("anonymizeUser — device fingerprint erasure (issue #315)", () => {
  beforeEach(() => {
    hoisted.captured.length = 0;
    hoisted.sessions.clear();
    hoisted.client.query.mockClear();
    hoisted.client.release.mockClear();
  });

  it("nulls game_sessions.device_id for all of the erased user's sessions only", async () => {
    hoisted.sessions.set("s1", { user_id: "user-1", device_id: "dev-abc" });
    hoisted.sessions.set("s2", { user_id: "user-1", device_id: "dev-xyz" });
    hoisted.sessions.set("s3", { user_id: "other-user", device_id: "dev-keep" });

    await anonymizeUser("user-1");

    expect(hoisted.sessions.get("s1")!.device_id).toBeNull();
    expect(hoisted.sessions.get("s2")!.device_id).toBeNull();
    // A different user's session fingerprint must be left untouched.
    expect(hoisted.sessions.get("s3")!.device_id).toBe("dev-keep");
  });

  it("issues the game_sessions device-fingerprint UPDATE scoped to the user", async () => {
    await anonymizeUser("user-42");

    const stmt = findStatement(/UPDATE\s+game_sessions\s+SET\s+device_id\s*=\s*NULL/i);
    expect(stmt).toBeDefined();
    expect(stmt!.text).toMatch(/WHERE\s+user_id\s*=\s*\$1/i);
    expect(stmt!.params?.[0]).toBe("user-42");
  });

  it("strips stored fingerprint hashes from the user's fraud_flags rows", async () => {
    await anonymizeUser("user-7");

    const stmt = findStatement(/UPDATE\s+fraud_flags/i);
    expect(stmt).toBeDefined();
    // Removes the 'fingerprint' key from the details JSONB blob.
    expect(stmt!.text).toMatch(/details\s*=\s*details\s*-\s*'fingerprint'/i);
    expect(stmt!.params?.[0]).toBe("user-7");
  });

  it("runs every mutation inside a single transaction (BEGIN/COMMIT, released)", async () => {
    await anonymizeUser("user-9");

    const order = hoisted.captured.map((c) => c.text.trim());
    expect(order[0]).toBe("BEGIN");
    expect(order[order.length - 1]).toBe("COMMIT");
    expect(hoisted.client.release).toHaveBeenCalledTimes(1);

    // Users PII, game_sessions and fraud_flags are all mutated before COMMIT.
    const commitIdx = order.indexOf("COMMIT");
    const usersIdx = order.findIndex((t) => /UPDATE users SET/i.test(t));
    const sessionsIdx = order.findIndex((t) => /UPDATE\s+game_sessions/i.test(t));
    const fraudIdx = order.findIndex((t) => /UPDATE\s+fraud_flags/i.test(t));
    expect(usersIdx).toBeGreaterThan(-1);
    expect(usersIdx).toBeLessThan(commitIdx);
    expect(sessionsIdx).toBeLessThan(commitIdx);
    expect(fraudIdx).toBeLessThan(commitIdx);
  });

  it("writes compliance evidence (completion timestamp + cleared columns) to audit_log", async () => {
    await anonymizeUser("user-audit");

    const stmt = findStatement(/INSERT INTO audit_log/i);
    expect(stmt).toBeDefined();
    expect(stmt!.params).toContain(GDPR_ERASURE_ACTION);
    expect(stmt!.params).toContain("user-audit");

    const payload = JSON.parse(String(stmt!.params?.[2]));
    expect(payload.clearedColumns).toEqual([...GDPR_ERASURE_CLEARED_COLUMNS]);
    expect(payload.clearedColumns).toContain("game_sessions.device_id");
    expect(payload.clearedColumns).toContain("fraud_flags.details.fingerprint");
    expect(typeof payload.completedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.completedAt))).toBe(false);
  });

  it("rolls back and rethrows if a mutation fails (no partial erasure evidence)", async () => {
    hoisted.client.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })); // BEGIN
    hoisted.client.query.mockImplementationOnce(async () => {
      throw new Error("db exploded");
    }); // users UPDATE fails

    await expect(anonymizeUser("user-fail")).rejects.toThrow("db exploded");

    const order = hoisted.captured.map((c) => c.text.trim());
    expect(order).toContain("ROLLBACK");
    expect(order).not.toContain("COMMIT");
    expect(hoisted.client.release).toHaveBeenCalledTimes(1);
  });
});
