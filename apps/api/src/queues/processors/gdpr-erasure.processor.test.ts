import { describe, expect, it, vi, beforeEach } from "vitest";

// ── mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  findPendingErasureRequest: vi.fn(),
  anonymizeUser: vi.fn(),
  markErasureExecuted: vi.fn(),
  revokeAllUserRefreshTokens: vi.fn(),
}));

vi.mock("../../db/queries/gdpr", () => ({
  findPendingErasureRequest: mocks.findPendingErasureRequest,
  anonymizeUser: mocks.anonymizeUser,
  markErasureExecuted: mocks.markErasureExecuted,
}));

vi.mock("../../lib/tokens", () => ({
  revokeAllUserRefreshTokens: mocks.revokeAllUserRefreshTokens,
}));

vi.mock("../../lib/redis", () => ({
  redis: {},
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { processGdprErasureJob } from "./gdpr-erasure.processor";

function makeJob(data: { userId: string; requestId: string }) {
  return { id: "job-1", data } as any;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("processGdprErasureJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("anonymises user, revokes tokens and marks request executed when request is pending", async () => {
    const userId = "user-abc";
    const requestId = "req-abc";
    mocks.findPendingErasureRequest.mockResolvedValueOnce({ id: requestId, user_id: userId });
    mocks.anonymizeUser.mockResolvedValueOnce(undefined);
    mocks.revokeAllUserRefreshTokens.mockResolvedValueOnce(undefined);
    mocks.markErasureExecuted.mockResolvedValueOnce(undefined);

    await processGdprErasureJob(makeJob({ userId, requestId }));

    expect(mocks.anonymizeUser).toHaveBeenCalledWith(userId);
    expect(mocks.revokeAllUserRefreshTokens).toHaveBeenCalledWith(userId);
    expect(mocks.markErasureExecuted).toHaveBeenCalledWith(requestId);
  });

  it("skips anonymisation when request is cancelled (no pending request found)", async () => {
    mocks.findPendingErasureRequest.mockResolvedValueOnce(null);

    await processGdprErasureJob(makeJob({ userId: "user-xyz", requestId: "req-xyz" }));

    expect(mocks.anonymizeUser).not.toHaveBeenCalled();
    expect(mocks.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    expect(mocks.markErasureExecuted).not.toHaveBeenCalled();
  });

  it("skips when a newer request supersedes the job's requestId", async () => {
    mocks.findPendingErasureRequest.mockResolvedValueOnce({
      id: "req-newer",
      user_id: "user-abc",
    });

    await processGdprErasureJob(makeJob({ userId: "user-abc", requestId: "req-old" }));

    expect(mocks.anonymizeUser).not.toHaveBeenCalled();
  });

  it("is idempotent: skips when no pending request exists (already executed)", async () => {
    mocks.findPendingErasureRequest.mockResolvedValueOnce(null);

    await processGdprErasureJob(makeJob({ userId: "user-done", requestId: "req-done" }));

    expect(mocks.anonymizeUser).not.toHaveBeenCalled();
  });
});
