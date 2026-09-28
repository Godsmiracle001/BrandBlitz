import { describe, it, expect } from "vitest";
import {
  STELLAR_NETWORKS,
  DEPOSIT_POLL_INTERVAL_MS,
  STROOPS_PER_USDC,
  MAX_SUPPLY_STROOPS,
  usdcToStroops,
  stroopsToUsdc,
} from "./constants";

describe("constants", () => {
  it("should have correct testnet values", () => {
    expect(STELLAR_NETWORKS.testnet.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(STELLAR_NETWORKS.testnet.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });

  it("should have correct public values", () => {
    expect(STELLAR_NETWORKS.public.rpcUrl).toBe("https://mainnet.stellar.validationcloud.io/v1/rpc");
    expect(STELLAR_NETWORKS.public.networkPassphrase).toBe("Public Global Stellar Network ; September 2015");
  });

  it("should have correct deposit poll interval", () => {
    expect(DEPOSIT_POLL_INTERVAL_MS).toBe(5000);
  });

  it("should have correct stroop conversion factor", () => {
    expect(STROOPS_PER_USDC).toBe(10_000_000);
  });

  it("should have correct max XLM supply in stroops", () => {
    expect(MAX_SUPPLY_STROOPS).toBe(50_000_000_000_000_000);
  });
});

describe("usdcToStroops()", () => {
  it("converts 1 USDC to exactly 10,000,000 stroops", () => {
    expect(usdcToStroops("1")).toBe(10_000_000n);
    expect(usdcToStroops("1.0")).toBe(10_000_000n);
    expect(usdcToStroops("1.0000000")).toBe(10_000_000n);
  });

  it("converts 0.5 USDC to 5,000,000 stroops", () => {
    expect(usdcToStroops("0.5")).toBe(5_000_000n);
  });

  it("converts 100 USDC to 1,000,000,000 stroops", () => {
    expect(usdcToStroops("100")).toBe(1_000_000_000n);
  });

  it("handles fractional USDC below 1 stroop by rounding down", () => {
    // 0.00000001 USDC = 0.1 stroops (rounded down to 0)
    expect(usdcToStroops("0.00000001")).toBe(0n);
    // 0.0000001 USDC = 1 stroop
    expect(usdcToStroops("0.0000001")).toBe(1n);
  });

  it("handles very small fractional amounts", () => {
    // 0.0000002 USDC = 2 stroops
    expect(usdcToStroops("0.0000002")).toBe(2n);
    // 0.00000099 USDC = 9 stroops (rounded down from 9.9)
    expect(usdcToStroops("0.00000099")).toBe(9n);
  });

  it("rejects negative values with RangeError", () => {
    expect(() => usdcToStroops("-1")).toThrow(RangeError);
    expect(() => usdcToStroops("-0.5")).toThrow(RangeError);
  });

  it("rejects non-numeric string inputs with TypeError", () => {
    expect(() => usdcToStroops("abc")).toThrow(TypeError);
    expect(() => usdcToStroops("1.2.3")).toThrow(TypeError);
    expect(() => usdcToStroops("1e10")).toThrow(TypeError);
  });

  it("rejects non-string inputs with TypeError", () => {
    // @ts-ignore - testing runtime type check
    expect(() => usdcToStroops(123)).toThrow(TypeError);
    // @ts-ignore
    expect(() => usdcToStroops(null)).toThrow(TypeError);
    // @ts-ignore
    expect(() => usdcToStroops(undefined)).toThrow(TypeError);
  });

  it("rejects empty strings with TypeError", () => {
    expect(() => usdcToStroops("")).toThrow(TypeError);
    expect(() => usdcToStroops("   ")).toThrow(TypeError);
  });

  it("throws RangeError when amount exceeds max XLM supply", () => {
    // 100 billion + 1 USDC exceeds the max
    const exceeds = (MAX_SUPPLY_STROOPS / BigInt(STROOPS_PER_USDC) + 1n).toString();
    expect(() => usdcToStroops(exceeds)).toThrow(RangeError);
  });

  it("accepts maximum valid amount (100 billion USDC)", () => {
    const max = (MAX_SUPPLY_STROOPS / BigInt(STROOPS_PER_USDC)).toString();
    expect(usdcToStroops(max)).toBeLessThanOrEqual(MAX_SUPPLY_STROOPS);
  });

  it("handles zero", () => {
    expect(usdcToStroops("0")).toBe(0n);
    expect(usdcToStroops("0.0")).toBe(0n);
  });

  it("handles whitespace around input", () => {
    expect(usdcToStroops("  1  ")).toBe(10_000_000n);
    expect(usdcToStroops("\n1.5\n")).toBe(15_000_000n);
  });

  it("handles precise decimal amounts", () => {
    // 1.1234567 USDC = 11,234,567 stroops
    expect(usdcToStroops("1.1234567")).toBe(11_234_567n);
    // 10.5000001 USDC = 105,000,010 stroops (rounded down from 105,000,010)
    expect(usdcToStroops("10.5000001")).toBe(105_000_010n);
  });
});

describe("stroopsToUsdc()", () => {
  it("converts 10,000,000 stroops to 1.0 USDC", () => {
    expect(stroopsToUsdc(10_000_000)).toBe("1");
    expect(stroopsToUsdc(10_000_000n)).toBe("1");
  });

  it("converts 5,000,000 stroops to 0.5 USDC", () => {
    expect(stroopsToUsdc(5_000_000)).toBe("0.5");
    expect(stroopsToUsdc(5_000_000n)).toBe("0.5");
  });

  it("converts 1,000,000,000 stroops to 100 USDC", () => {
    expect(stroopsToUsdc(1_000_000_000)).toBe("100");
    expect(stroopsToUsdc(1_000_000_000n)).toBe("100");
  });

  it("converts 1 stroop to 0.0000001 USDC", () => {
    expect(stroopsToUsdc(1)).toBe("0.0000001");
    expect(stroopsToUsdc(1n)).toBe("0.0000001");
  });

  it("converts 0 stroops to 0", () => {
    expect(stroopsToUsdc(0)).toBe("0");
    expect(stroopsToUsdc(0n)).toBe("0");
  });

  it("rejects negative stroops with RangeError", () => {
    expect(() => stroopsToUsdc(-1)).toThrow(RangeError);
    expect(() => stroopsToUsdc(-1n)).toThrow(RangeError);
  });

  it("rejects non-number and non-bigint inputs with TypeError", () => {
    // @ts-ignore
    expect(() => stroopsToUsdc("123")).toThrow(TypeError);
    // @ts-ignore
    expect(() => stroopsToUsdc(null)).toThrow(TypeError);
    // @ts-ignore
    expect(() => stroopsToUsdc(undefined)).toThrow(TypeError);
  });

  it("throws RangeError when stroops exceed max supply", () => {
    expect(() => stroopsToUsdc(MAX_SUPPLY_STROOPS + 1n)).toThrow(RangeError);
  });

  it("accepts maximum valid amount (max supply)", () => {
    const result = stroopsToUsdc(MAX_SUPPLY_STROOPS);
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it("trims trailing zeros from decimal result", () => {
    // 100 stroops would have trailing zeros without trimming
    expect(stroopsToUsdc(100_000_000)).toBe("10");
    expect(stroopsToUsdc(100_000_001)).toBe("10.0000001");
  });

  it("handles both number and bigint equally", () => {
    const testAmount = 12_345_678;
    expect(stroopsToUsdc(testAmount)).toBe(stroopsToUsdc(BigInt(testAmount)));
  });
});

describe("usdcToStroops() and stroopsToUsdc() round-trip", () => {
  it("preserves value: USDC → stroops → USDC", () => {
    const original = "10.5";
    const stroops = usdcToStroops(original);
    const recovered = stroopsToUsdc(stroops);
    expect(recovered).toBe("10.5");
  });

  it("preserves value for 1 USDC round-trip", () => {
    const stroops = usdcToStroops("1");
    const recovered = stroopsToUsdc(stroops);
    expect(recovered).toBe("1");
  });

  it("preserves value for fractional amount", () => {
    const original = "0.123456";
    const stroops = usdcToStroops(original);
    const recovered = stroopsToUsdc(stroops);
    // Expected: rounded down from 1234560 stroops due to sub-stroop precision loss
    expect(recovered).toBe("0.123456");
  });

  it("preserves value for zero", () => {
    const stroops = usdcToStroops("0");
    const recovered = stroopsToUsdc(stroops);
    expect(recovered).toBe("0");
  });

  it("preserves within acceptable epsilon for edge cases", () => {
    // Test various amounts and verify round-trip consistency
    const testCases = ["1", "10.5", "0.0000001", "100", "0.5"];
    for (const original of testCases) {
      const stroops = usdcToStroops(original);
      const recovered = stroopsToUsdc(stroops);
      const originalNum = parseFloat(original);
      const recoveredNum = parseFloat(recovered);
      // Allow for very small floating point error
      expect(Math.abs(originalNum - recoveredNum)).toBeLessThan(1e-8);
    }
  });
});
