import { describe, expect, it, vi } from "vitest";
import { checkDependenciesHealth } from "./health-check";

describe("checkDependenciesHealth (#392)", () => {
  it("marks a dependency as error if its check does not settle within the timeout", async () => {
    vi.useFakeTimers();

    const resultPromise = checkDependenciesHealth(
      {
        checkDb: () => new Promise(() => {}), // never settles
        checkRedis: () => Promise.resolve(),
        checkStellar: () => Promise.resolve(),
      },
      50
    );

    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result.db).toBe("error");
    expect(result.status).toBe("degraded");

    vi.useRealTimers();
  });

  it("runs all three probes concurrently rather than sequentially", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const startedBeforeGateOpened: string[] = [];

    const track = (name: string) => async (): Promise<void> => {
      startedBeforeGateOpened.push(name); // records synchronously, before blocking
      await gate;
    };

    const resultPromise = checkDependenciesHealth({
      checkDb: track("db"),
      checkRedis: track("redis"),
      checkStellar: track("stellar"),
    });

    // Flush pending microtasks so every check has a chance to start.
    await Promise.resolve();
    await Promise.resolve();

    // If probes ran sequentially (await one, then the next), only "db"
    // could have started — checkRedis/checkStellar would still be blocked
    // waiting for checkDb's promise, which is itself stuck on the gate.
    // Seeing all three here proves Promise.all dispatched them together,
    // i.e. wall time is O(1) bounded by the slowest probe, not O(n) summed.
    expect(startedBeforeGateOpened.sort()).toEqual(["db", "redis", "stellar"]);

    openGate();
    const result = await resultPromise;
    expect(result.status).toBe("ok");
  });
});
