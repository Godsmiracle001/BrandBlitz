import { describe, it, expect, vi, beforeEach } from "vitest";
import { poll, redis, LAST_LEDGER_KEY } from "./index";
import * as stellar from "@brandblitz/stellar";

vi.mock("@brandblitz/stellar", () => ({
  fetchDepositEvents: vi.fn(),
}));

const fetch = vi.fn();
vi.stubGlobal("fetch", fetch);

describe("Deposit Monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize cursor on first run", async () => {
    vi.spyOn(redis, "get").mockResolvedValue(null);
    const setSpy = vi.spyOn(redis, "set").mockResolvedValue("OK");
    
    (stellar.fetchDepositEvents as any).mockResolvedValue({
      events: [],
      latestLedger: 1000,
    });

    await poll();

    expect(stellar.fetchDepositEvents).toHaveBeenCalledWith(
      expect.any(String),
      0,
      expect.any(String)
    );
    expect(setSpy).toHaveBeenCalledWith(LAST_LEDGER_KEY, "1000");
  });

  it("should process events and update cursor", async () => {
    vi.spyOn(redis, "get").mockResolvedValue("1000");
    const setSpy = vi.spyOn(redis, "set").mockResolvedValue("OK");
    
    const mockEvent = {
      txHash: "hash123",
      amount: "100",
      memo: "memo123",
      to: "wallet",
      ledger: 1001,
      createdAt: new Date().toISOString(),
    };

    (stellar.fetchDepositEvents as any).mockResolvedValue({
      events: [mockEvent],
      latestLedger: 1001,
    });

    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "activated" }),
    });

    await poll();

    expect(fetch).toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith(LAST_LEDGER_KEY, "1001");
  });

  it("should not update cursor if webhook fails", async () => {
    vi.spyOn(redis, "get").mockResolvedValue("1000");
    const setSpy = vi.spyOn(redis, "set");
    
    const mockEvent = {
      txHash: "hash123",
      amount: "100",
      memo: "memo123",
      to: "wallet",
      ledger: 1001,
      createdAt: new Date().toISOString(),
    };

    (stellar.fetchDepositEvents as any).mockResolvedValue({
      events: [mockEvent],
      latestLedger: 1001,
    });

    (fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await poll();

    expect(fetch).toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalledWith(LAST_LEDGER_KEY, "1001");
  });
});
