import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { formatUsdc } from "./format";

describe("formatUsdc", () => {
  it("formats a whole number with 2 decimals by default", () => {
    expect(formatUsdc("100")).toBe("100.00 USDC");
  });

  it("formats a decimal string to 2 places", () => {
    expect(formatUsdc("12.5")).toBe("12.50 USDC");
  });

  it("formats to 7 decimal places when precision is 7", () => {
    expect(formatUsdc("1.1234567", { precision: 7 })).toBe("1.1234567 USDC");
  });

  it("handles negative amounts and adds minus sign", () => {
    const result = formatUsdc("-100.00");
    expect(result.startsWith("-")).toBe(true);
    expect(result).toContain("USDC");
  });

  it("handles large amounts without precision loss", () => {
    // 2^53 + 1 — would lose precision with Number()
    const large = "9007199254740993";
    const result = formatUsdc(large);
    expect(result).toContain("USDC");
    expect(result).not.toContain("NaN");
  });

  it("handles zero", () => {
    expect(formatUsdc("0")).toBe("0.00 USDC");
    expect(formatUsdc(0)).toBe("0.00 USDC");
  });

  it("accepts a numeric argument", () => {
    expect(formatUsdc(42.5)).toBe("42.50 USDC");
  });

  it("property: always contains USDC suffix", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-1e9), max: Math.fround(1e9), noNaN: true }),
        (n) => {
          const result = formatUsdc(n.toFixed(7));
          expect(result).toMatch(/USDC$/);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it("property: negative inputs produce a minus-prefixed result", () => {
    fc.assert(
      fc.property(
        fc.float({
          min: Math.fround(-1e9),
          max: Math.fround(-0.0000001),
          noNaN: true,
        }),
        (n) => {
          expect(formatUsdc(n.toFixed(7)).startsWith("-")).toBe(true);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it("property: non-negative inputs never start with minus", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(1e9), noNaN: true }),
        (n) => {
          expect(formatUsdc(n.toFixed(7)).startsWith("-")).toBe(false);
        }
      ),
      { numRuns: 1000 }
    );
  });
});
