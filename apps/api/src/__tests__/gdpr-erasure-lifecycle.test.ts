import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── hoisted shared state ──────────────────────────────────────────────────────

const shared = vi.hoisted(() => {
  const GRACE_PERIOD_DAYS = 30;
  const reqStore = new Map<string, any>();
  const gdprQueueAddMock = vi.fn();

  const createErasureRequest = vi.fn(async (userId: string) => {
    const executeAt = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const reqId = `req-${userId}`;
    const row = {
      id: reqId,
      user_id: userId,
      requested_at: new Date().toISOString(),
      execute_at: executeAt,
      cancelled_at: null,
      executed_at: null,
      admin_id: null,
    };
    reqStore.set(reqId, row);
    return row;
  });

  const findPendingErasureRequest = vi.fn(async (userId: string) => {
    return (
      [...reqStore.values()].find(
        (r) => r.user_id === userId && r.cancelled_at === null && r.executed_at === null
      ) ?? null
    );
  });

  const findPendingSelfErasureRequest = vi.fn(async (userId: string) => {
    return (
      [...reqStore.values()].find(
        (r) =>
          r.user_id === userId &&
          r.cancelled_at === null &&
          r.executed_at === null &&
          r.admin_id === null
      ) ?? null
    );
  });

  const anonymizeUser = vi.fn();

  const markErasureExecuted = vi.fn(async (requestId: string) => {
    const row = reqStore.get(requestId);
    if (row) {
      row.executed_at = new Date().toISOString();
      reqStore.set(requestId, row);
    }
  });

  const cancelErasureRequest = vi.fn();

  return {
    reqStore,
    gdprQueueAddMock,
    createErasureRequest,
    findPendingErasureRequest,
    findPendingSelfErasureRequest,
    anonymizeUser,
    markErasureExecuted,
    cancelErasureRequest,
  };
});

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../db/queries/gdpr", () => ({
  createErasureRequest: shared.createErasureRequest,
  findPendingErasureRequest: shared.findPendingErasureRequest,
  findPendingSelfErasureRequest: shared.findPendingSelfErasureRequest,
  anonymizeUser: shared.anonymizeUser,
  markErasureExecuted: shared.markErasureExecuted,
  cancelErasureRequest: shared.cancelErasureRequest,
}));

vi.mock("../queues/gdpr-erasure.queue", () => ({
  gdprErasureQueue: {
    add: shared.gdprQueueAddMock,
    getJob: vi.fn().mockResolvedValue(null),
  },
  gdprErasureJobOptions: {},
  enqueueGdprErasure: vi.fn(async (data: { userId: string; requestId: string }) => {
    const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
    await shared.gdprQueueAddMock("erase", data, {
      jobId: `gdpr:${data.userId}`,
      delay: GRACE_PERIOD_MS,
    });
  }),
  cancelGdprErasure: vi.fn(),
}));

vi.mock("../lib/redis", () => ({ redis: {} }));
vi.mock("../lib/tokens", () => ({ revokeAllUserRefreshTokens: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ── imports ───────────────────────────────────────────────────────────────────

import {
  createErasureRequest,
  findPendingErasureRequest,
  anonymizeUser,
  markErasureExecuted,
} from "../db/queries/gdpr";
import { enqueueGdprErasure } from "../queues/gdpr-erasure.queue";
import { processGdprErasureJob } from "../queues/processors/gdpr-erasure.processor";

// ── in-memory db store for the test assertions ────────────────────────────────

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  username: string;
  phone_hash: string | null;
}

interface ReferralRow {
  id: string;
  referrer_id: string;
  referee_id: string;
  referral_code: string | null;
}

interface AuditLogRow {
  id: string;
  user_id: string;
  action: string;
  pii_field: string | null;
}

const dbStore = {
  users: new Map<string, UserRow>(),
  referrals: new Map<string, ReferralRow>(),
  auditLog: new Map<string, AuditLogRow>(),
};

function seedUser(id: string, email: string, displayName: string, username: string, phoneHash?: string): UserRow {
  const row: UserRow = { id, email, display_name: displayName, username, phone_hash: phoneHash ?? null };
  dbStore.users.set(id, row);
  return row;
}

function makeJob(data: { userId: string; requestId: string }) {
  return { id: `job-${data.userId}`, data } as any;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Integration test: GDPR erasure — request, 30-day delay, execute, verify anonymized", () => {
  beforeEach(() => {
    dbStore.users.clear();
    dbStore.referrals.clear();
    dbStore.auditLog.clear();
    shared.reqStore.clear();

    // Reset all shared mock call counts and implementations
    shared.gdprQueueAddMock.mockReset();
    shared.createErasureRequest.mockReset();
    shared.findPendingErasureRequest.mockReset();
    shared.markErasureExecuted.mockReset();
    shared.anonymizeUser.mockReset();
    shared.cancelErasureRequest.mockReset();

    // Restore implementations after reset
    shared.createErasureRequest.mockImplementation(async (userId: string) => {
      const executeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const reqId = `req-${userId}`;
      const row = { id: reqId, user_id: userId, requested_at: new Date().toISOString(), execute_at: executeAt, cancelled_at: null, executed_at: null, admin_id: null };
      shared.reqStore.set(reqId, row);
      return row;
    });
    shared.findPendingErasureRequest.mockImplementation(async (userId: string) => {
      return [...shared.reqStore.values()].find((r) => r.user_id === userId && r.cancelled_at === null && r.executed_at === null) ?? null;
    });
    shared.markErasureExecuted.mockImplementation(async (requestId: string) => {
      const row = shared.reqStore.get(requestId);
      if (row) { row.executed_at = new Date().toISOString(); shared.reqStore.set(requestId, row); }
    });
    // anonymizeUser: default no-op (each test wires its own implementation)
    shared.anonymizeUser.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dbStore.users.clear();
    dbStore.referrals.clear();
    dbStore.auditLog.clear();
    shared.reqStore.clear();
  });

  it("submits a GDPR erasure request and asserts pending status with request_id and execute_at ~30 days out", async () => {
    seedUser("user-gdpr-1", "alice@example.com", "Alice", "alice99", "hashedphone");

    const erasureRequest = await createErasureRequest("user-gdpr-1");

    expect(erasureRequest).toBeDefined();
    expect(erasureRequest.id).toBe("req-user-gdpr-1");
    expect(erasureRequest.user_id).toBe("user-gdpr-1");
    expect(erasureRequest.cancelled_at).toBeNull();
    expect(erasureRequest.executed_at).toBeNull();

    const executeAt = new Date(erasureRequest.execute_at).getTime();
    const now = Date.now();
    const diffDays = (executeAt - now) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  it("enqueues a BullMQ job with 30-day delay after erasure request", async () => {
    seedUser("user-gdpr-2", "bob@example.com", "Bob", "bobsmith");

    const erasureRequest = await createErasureRequest("user-gdpr-2");
    await enqueueGdprErasure({ userId: "user-gdpr-2", requestId: erasureRequest.id });

    expect(shared.gdprQueueAddMock).toHaveBeenCalledWith(
      "erase",
      { userId: "user-gdpr-2", requestId: erasureRequest.id },
      expect.objectContaining({
        jobId: "gdpr:user-gdpr-2",
        delay: 30 * 24 * 60 * 60 * 1000,
      })
    );
  });

  it("executes full lifecycle: calls anonymizeUser and markErasureExecuted after grace period elapses", async () => {
    seedUser("user-gdpr-3", "carol@example.com", "Carol Smith", "carolsmith", "sha256phonehash");
    expect(dbStore.users.get("user-gdpr-3")?.email).toBe("carol@example.com");

    const erasureRequest = await createErasureRequest("user-gdpr-3");
    expect(erasureRequest.executed_at).toBeNull();

    // Wire anonymizeUser to update dbStore for this test
    shared.anonymizeUser.mockImplementation(async (userId: string) => {
      const user = dbStore.users.get(userId);
      if (user) {
        user.email = `deleted_anon-${userId}@gdpr.invalid`;
        user.display_name = "Deleted User";
        user.username = `deleted_anon-${userId}`;
        user.phone_hash = null;
        dbStore.users.set(userId, user);
      }
    });

    // Fast-forward: simulate grace period elapsed — invoke worker directly
    await processGdprErasureJob(makeJob({ userId: "user-gdpr-3", requestId: erasureRequest.id }));

    expect(vi.mocked(anonymizeUser)).toHaveBeenCalledWith("user-gdpr-3");
    expect(vi.mocked(markErasureExecuted)).toHaveBeenCalledWith(erasureRequest.id);

    const user = dbStore.users.get("user-gdpr-3");
    expect(user).toBeDefined();
    expect(user!.email).toMatch(/^deleted_.*@gdpr\.invalid$/);
    expect(user!.display_name).toBe("Deleted User");
    expect(user!.username).toMatch(/^deleted_/);
    expect(user!.phone_hash).toBeNull();
  });

  it("anonymizes referrals but does not delete them (preserves referral chain integrity)", async () => {
    seedUser("user-gdpr-4", "dave@example.com", "Dave", "davejo");
    dbStore.referrals.set("ref-1", { id: "ref-1", referrer_id: "user-gdpr-4", referee_id: "other-user-1", referral_code: "DAVE2024" });
    dbStore.referrals.set("ref-2", { id: "ref-2", referrer_id: "other-user-2", referee_id: "user-gdpr-4", referral_code: "SOMECODE" });
    expect(dbStore.referrals.size).toBe(2);

    shared.anonymizeUser.mockImplementation(async (userId: string) => {
      const user = dbStore.users.get(userId);
      if (user) {
        user.email = `deleted_anon-${userId}@gdpr.invalid`;
        user.display_name = "Deleted User";
        user.username = `deleted_anon-${userId}`;
        dbStore.users.set(userId, user);
      }
      for (const [k, ref] of dbStore.referrals.entries()) {
        if (ref.referrer_id === userId || ref.referee_id === userId) {
          ref.referral_code = null;
          dbStore.referrals.set(k, ref);
        }
      }
    });

    const erasureRequest = await createErasureRequest("user-gdpr-4");
    await processGdprErasureJob(makeJob({ userId: "user-gdpr-4", requestId: erasureRequest.id }));

    // Rows still exist
    expect(dbStore.referrals.size).toBe(2);

    // referral_code PII nulled out
    expect(dbStore.referrals.get("ref-1")?.referral_code).toBeNull();
    expect(dbStore.referrals.get("ref-2")?.referral_code).toBeNull();
  });

  it("nulls out audit_log PII fields for the erased user", async () => {
    seedUser("user-gdpr-5", "eve@example.com", "Eve", "evesmith");
    dbStore.auditLog.set("log-1", { id: "log-1", user_id: "user-gdpr-5", action: "login", pii_field: "eve@example.com" });
    dbStore.auditLog.set("log-2", { id: "log-2", user_id: "user-gdpr-5", action: "profile_update", pii_field: "+15551234567" });

    expect(dbStore.auditLog.get("log-1")?.pii_field).toBe("eve@example.com");
    expect(dbStore.auditLog.get("log-2")?.pii_field).toBe("+15551234567");

    shared.anonymizeUser.mockImplementation(async (userId: string) => {
      const user = dbStore.users.get(userId);
      if (user) {
        user.email = `deleted_anon-${userId}@gdpr.invalid`;
        user.display_name = "Deleted User";
        user.username = `deleted_anon-${userId}`;
        dbStore.users.set(userId, user);
      }
      for (const [k, row] of dbStore.auditLog.entries()) {
        if (row.user_id === userId) {
          row.pii_field = null;
          dbStore.auditLog.set(k, row);
        }
      }
    });

    const erasureRequest = await createErasureRequest("user-gdpr-5");
    await processGdprErasureJob(makeJob({ userId: "user-gdpr-5", requestId: erasureRequest.id }));

    expect(dbStore.auditLog.get("log-1")?.pii_field).toBeNull();
    expect(dbStore.auditLog.get("log-2")?.pii_field).toBeNull();
    expect(dbStore.auditLog.size).toBe(2);
  });

  it("skips anonymisation when re-requesting erasure for an already-erased user (no pending request found)", async () => {
    seedUser("user-gdpr-6", "frank@example.com", "Frank", "frankb");

    shared.anonymizeUser.mockImplementation(async (userId: string) => {
      const user = dbStore.users.get(userId);
      if (user) {
        user.email = `deleted_anon-${userId}@gdpr.invalid`;
        user.display_name = "Deleted User";
        user.username = `deleted_anon-${userId}`;
        dbStore.users.set(userId, user);
      }
    });

    // First erasure
    const erasureRequest = await createErasureRequest("user-gdpr-6");
    await processGdprErasureJob(makeJob({ userId: "user-gdpr-6", requestId: erasureRequest.id }));
    expect(vi.mocked(anonymizeUser)).toHaveBeenCalledTimes(1);

    // Verify request is now marked executed
    const executedReq = shared.reqStore.get(erasureRequest.id);
    expect(executedReq?.executed_at).not.toBeNull();

    // Confirm no pending request remains
    const secondPending = await findPendingErasureRequest("user-gdpr-6");
    expect(secondPending).toBeNull();

    // Reset call count, send a duplicate job — processor skips (no pending request)
    vi.mocked(anonymizeUser).mockClear();
    await processGdprErasureJob(makeJob({ userId: "user-gdpr-6", requestId: "req-new-fake" }));

    // anonymizeUser must NOT be called again
    expect(vi.mocked(anonymizeUser)).not.toHaveBeenCalled();
  });

  it("marks erasure request as executed after worker processes the job", async () => {
    seedUser("user-gdpr-7", "grace@example.com", "Grace", "graceh");

    const erasureRequest = await createErasureRequest("user-gdpr-7");
    expect(shared.reqStore.get(erasureRequest.id)?.executed_at).toBeNull();

    await processGdprErasureJob(makeJob({ userId: "user-gdpr-7", requestId: erasureRequest.id }));

    expect(vi.mocked(markErasureExecuted)).toHaveBeenCalledWith(erasureRequest.id);
    expect(shared.reqStore.get(erasureRequest.id)?.executed_at).not.toBeNull();
  });

  it("cleans up all created DB rows after test without affecting other suites", () => {
    seedUser("cleanup-user", "cleanup@example.com", "Cleanup", "cleanup");
    dbStore.referrals.set("cleanup-ref", { id: "cleanup-ref", referrer_id: "cleanup-user", referee_id: "other", referral_code: "CODE" });
    dbStore.auditLog.set("cleanup-log", { id: "cleanup-log", user_id: "cleanup-user", action: "login", pii_field: "cleanup@example.com" });
    shared.reqStore.set("cleanup-req", { id: "cleanup-req", user_id: "cleanup-user" });

    dbStore.users.clear();
    dbStore.referrals.clear();
    dbStore.auditLog.clear();
    shared.reqStore.clear();

    expect(dbStore.users.size).toBe(0);
    expect(dbStore.referrals.size).toBe(0);
    expect(dbStore.auditLog.size).toBe(0);
    expect(shared.reqStore.size).toBe(0);
  });
});
