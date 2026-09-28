import { describe, it, expect } from "vitest";
import {
  WARMUP_MIN_SECONDS as CANONICAL_WARMUP_MIN_SECONDS,
  ROUND_SECONDS as CANONICAL_ROUND_SECONDS,
  MAX_ROUNDS as CANONICAL_MAX_ROUNDS,
} from "@brandblitz/stellar";
import {
  WARMUP_MIN_SECONDS,
  ROUND_SECONDS,
  TOTAL_ROUNDS,
} from "./constants";

describe("game constants parity with @brandblitz/stellar", () => {
  it("WARMUP_MIN_SECONDS matches the canonical value", () => {
    expect(WARMUP_MIN_SECONDS).toBe(CANONICAL_WARMUP_MIN_SECONDS);
  });

  it("ROUND_SECONDS matches the canonical value", () => {
    expect(ROUND_SECONDS).toBe(CANONICAL_ROUND_SECONDS);
  });

  it("TOTAL_ROUNDS (web) matches MAX_ROUNDS (stellar)", () => {
    expect(TOTAL_ROUNDS).toBe(CANONICAL_MAX_ROUNDS);
  });
});
