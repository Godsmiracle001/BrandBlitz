import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
}));

vi.mock("../lib/redis", () => ({
  redis: { connect: vi.fn() },
}));

vi.mock("bullmq", async () => {
  const actual = await vi.importActual("bullmq");
  return {
    ...actual,
    // A plain `function`, not an arrow function, is required here — arrow
    // functions are never constructible, and this mock is invoked with `new`
    // by the real session-timeout.queue.ts module.
    Queue: vi.fn().mockImplementation(function () {
      return { add: mocks.queueAdd };
    }),
  };
});

// #375 — real equivalent of the issue's "session-timeout job enqueued with
// the correct delay" acceptance criterion. There is no per-session delayed
// job: session-timeout.queue.ts registers exactly one recurring sweep job
// at worker startup (see queues/processors/session-timeout.processor.ts,
// which bulk-abandons stale sessions via markAbandonedSessions()). These
// tests verify that registration call directly, since apps/api/src/routes/
// sessions.ts's warmup-start handler never touches this queue at all
// (covered separately in routes/sessions.test.ts).
describe("session-timeout queue — sweep job registration (#375)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueAdd.mockResolvedValue({});
  });

  it("registers a single recurring sweep job with a 5-minute repeat interval", async () => {
    const { ensureSessionTimeoutSweepJob } = await import("./session-timeout.queue");

    await ensureSessionTimeoutSweepJob();

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "session-timeout-sweep",
      {},
      expect.objectContaining({
        jobId: "session-timeout-sweep",
        repeat: { every: 5 * 60_000 },
        removeOnComplete: true,
      })
    );
  });

  it("always registers with the same stable jobId, which is what lets BullMQ dedup repeat calls server-side", async () => {
    const { ensureSessionTimeoutSweepJob } = await import("./session-timeout.queue");

    await ensureSessionTimeoutSweepJob();
    await ensureSessionTimeoutSweepJob();

    const [firstCallArgs, secondCallArgs] = mocks.queueAdd.mock.calls;
    expect(firstCallArgs[2].jobId).toBe("session-timeout-sweep");
    expect(secondCallArgs[2].jobId).toBe("session-timeout-sweep");
  });
});
