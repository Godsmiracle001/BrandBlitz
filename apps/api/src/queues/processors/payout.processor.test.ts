import { describe, it, expect, vi, beforeEach } from "vitest";
import { Worker } from "bullmq";
import { createPayoutWorker } from "./payout.processor";

vi.mock("../../lib/redis", () => ({
  redis: { connect: vi.fn() },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../lib/config", () => ({
  config: {
    PAYOUT_WORKER_CONCURRENCY: 2,
  },
}));

vi.mock("../../services/payout", () => ({
  processPayout: vi.fn(),
}));

describe("payout worker graceful shutdown", () => {
  let mockWorker: any;
  let originalProcessOn: typeof process.on;
  let signalHandlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    signalHandlers = new Map();

    // Mock process.on to capture signal handlers
    originalProcessOn = process.on;
    process.on = vi.fn((signal: string, handler: any) => {
      signalHandlers.set(signal, handler);
      return process;
    }) as any;

    mockWorker = {
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockReturnThis(),
    };

    // Mock Worker constructor
    vi.spyOn(Worker.prototype, "close").mockImplementation(mockWorker.close);
    vi.spyOn(Worker.prototype, "on").mockImplementation(mockWorker.on);
  });

  afterEach(() => {
    process.on = originalProcessOn;
  });

  it("registers SIGTERM and SIGINT handlers on worker creation", () => {
    createPayoutWorker(Worker as any);

    expect(signalHandlers.has("SIGTERM")).toBe(true);
    expect(signalHandlers.has("SIGINT")).toBe(true);
  });

  it("calls worker.close() when SIGTERM is received", async () => {
    const MockWorkerClass = vi.fn().mockImplementation(() => mockWorker);
    createPayoutWorker(MockWorkerClass as any);

    const sigtermHandler = signalHandlers.get("SIGTERM");
    expect(sigtermHandler).toBeDefined();

    // Prevent actual process.exit during test
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await sigtermHandler!();

    expect(mockWorker.close).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });

  it("calls worker.close() when SIGINT is received", async () => {
    const MockWorkerClass = vi.fn().mockImplementation(() => mockWorker);
    createPayoutWorker(MockWorkerClass as any);

    const sigintHandler = signalHandlers.get("SIGINT");
    expect(sigintHandler).toBeDefined();

    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await sigintHandler!();

    expect(mockWorker.close).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });

  it("enforces shutdown timeout and force-exits if worker.close() hangs", async () => {
    vi.useFakeTimers();

    // Mock worker.close to never resolve
    mockWorker.close = vi.fn().mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    const MockWorkerClass = vi.fn().mockImplementation(() => mockWorker);
    createPayoutWorker(MockWorkerClass as any);

    const sigtermHandler = signalHandlers.get("SIGTERM");
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const shutdownPromise = sigtermHandler!();

    // Fast-forward past the 30s timeout
    vi.advanceTimersByTime(30000);

    await vi.runAllTimersAsync();

    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    vi.useRealTimers();
  });

  it("does not call worker.close() twice on multiple signals", async () => {
    const MockWorkerClass = vi.fn().mockImplementation(() => mockWorker);
    createPayoutWorker(MockWorkerClass as any);

    const sigtermHandler = signalHandlers.get("SIGTERM");
    const sigintHandler = signalHandlers.get("SIGINT");
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    // Trigger both signals rapidly
    const promise1 = sigtermHandler!();
    const promise2 = sigintHandler!();

    await Promise.all([promise1, promise2]);

    // Should only close once
    expect(mockWorker.close).toHaveBeenCalledTimes(1);

    mockExit.mockRestore();
  });
});
