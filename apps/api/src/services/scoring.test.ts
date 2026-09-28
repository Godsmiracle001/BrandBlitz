import { describe, expect, it } from "vitest";
import {
  calculateRoundScore,
  validateAnswer,
  calculatePayoutShare,
  rankWinners,
  SessionSummary,
  validateRoundScore,
  validateTotalScore,
  MAX_ROUND_SCORE,
  MAX_TOTAL_SCORE,
} from "./scoring";
import { calculatePayoutShareStroops } from "../lib/usdc";

describe("scoring service", () => {
  /**
   * ---------------------------
   * calculateRoundScore tests
   * ---------------------------
   */
  describe("calculateRoundScore", () => {
    const base = {
      correctOption: "A" as const,
      selectedOption: "A" as const,
    };

    it("returns 150 for instant correct answer (0ms)", () => {
      expect(
        calculateRoundScore({ ...base, reactionTimeMs: 0 })
      ).toBe(150);
    });

    it("returns 125 for ~7.5s", () => {
      expect(
        calculateRoundScore({ ...base, reactionTimeMs: 7500 })
      ).toBe(125);
    });

    it("returns 100 for 15s boundary", () => {
      expect(
        calculateRoundScore({ ...base, reactionTimeMs: 15000 })
      ).toBe(100);
    });

    it("returns 100 for slow answers beyond 15s", () => {
      expect(
        calculateRoundScore({ ...base, reactionTimeMs: 30000 })
      ).toBe(100);
    });

    it("returns 100 (bonus 0) for 15001ms and does not throw", () => {
      expect(() =>
        calculateRoundScore({ ...base, reactionTimeMs: 15001 })
      ).not.toThrow();
      expect(
        calculateRoundScore({ ...base, reactionTimeMs: 15001 })
      ).toBe(100);
    });

    it("keeps median reaction time bonus strictly between 0 and max", () => {
      const score = calculateRoundScore({ ...base, reactionTimeMs: 7500 });
      const bonus = score - 100;
      expect(bonus).toBeGreaterThan(0);
      expect(bonus).toBeLessThan(MAX_ROUND_SCORE - 100);
    });

    it("returns 0 for wrong answer", () => {
      expect(
        calculateRoundScore({
          selectedOption: "B",
          correctOption: "A",
          reactionTimeMs: 0,
        })
      ).toBe(0);
    });

    it("returns 0 for timeout answer", () => {
      expect(
        calculateRoundScore({
          selectedOption: null,
          correctOption: "A",
          reactionTimeMs: 15000,
        })
      ).toBe(0);
    });
  });

  /**
   * ---------------------------
   * validateAnswer tests
   * ---------------------------
   */
  describe("validateAnswer", () => {
    const question = {
      correct_option: "C",
    } as any;

    it("returns true for correct match", () => {
      expect(validateAnswer(question, "C")).toBe(true);
    });

    it("returns false for wrong answer", () => {
      expect(validateAnswer(question, "A")).toBe(false);
    });

    it("returns false for timeout answer", () => {
      expect(validateAnswer(question, null)).toBe(false);
    });

    it("is case-sensitive", () => {
      expect(validateAnswer(question, "c" as any)).toBe(false);
    });

    it("rejects invalid values", () => {
      expect(validateAnswer(question, "E" as any)).toBe(false);
    });
  });

  /**
   * ---------------------------
   * calculatePayoutShare tests
   * ---------------------------
   */
  describe("calculatePayoutShare", () => {
    it("returns correct proportional share", () => {
      const result = calculatePayoutShare(50, 100, "100");
      expect(result).toBe("50.0000000");
    });

    it("handles zero total points", () => {
      expect(calculatePayoutShare(50, 0, "100")).toBe("0.0000000");
    });

    it("rounds to 7 decimal places", () => {
      const result = calculatePayoutShare(1, 3, "10");
      expect(result).toMatch(/\d+\.\d{7}/);
    });
  });

  /**
   * ---------------------------
   * rankWinners tests
   * ---------------------------
   */
  describe("rankWinners", () => {
    const sessions: SessionSummary[] = [
      {
        userId: "b",
        stellarAddress: "addr2",
        totalScore: 100,
        endedAt: "2024-01-01T10:00:00Z",
      },
      {
        userId: "a",
        stellarAddress: "addr1",
        totalScore: 100,
        endedAt: "2024-01-01T09:00:00Z",
      },
      {
        userId: "c",
        stellarAddress: "addr3",
        totalScore: 200,
        endedAt: "2024-01-01T11:00:00Z",
      },
    ];

    it("sorts by score descending", () => {
      const result = rankWinners(sessions);
      expect(result[0].userId).toBe("c");
    });

    it("uses endedAt as tiebreaker", () => {
      const result = rankWinners(sessions);
      expect(result[1].userId).toBe("a");
    });

    it("uses lexicographic userId order when score and endedAt are tied", () => {
      const tiedSessions: SessionSummary[] = [
        {
          userId: "b",
          stellarAddress: "addr2",
          totalScore: 100,
          endedAt: "2024-01-01T10:00:00Z",
        },
        {
          userId: "a",
          stellarAddress: "addr1",
          totalScore: 100,
          endedAt: "2024-01-01T10:00:00Z",
        },
      ];

      const result = rankWinners(tiedSessions);
      expect(result[0].userId).toBe("a");
      expect(result[1].userId).toBe("b");
    });

    it("respects topN limit", () => {
      const result = rankWinners(sessions, 2);
      expect(result.length).toBe(2);
    });
  });

  /**
   * ---------------------------
   * calculatePayoutShareStroops — tie / proportional-share math
   * ---------------------------
   */
  describe("calculatePayoutShareStroops", () => {
    it("splits the pool exactly in half between two players tied on score", () => {
      const pool = 1_000_000_000n;
      const a = calculatePayoutShareStroops(100, 200, pool);
      const b = calculatePayoutShareStroops(100, 200, pool);
      expect(a).toBe(500_000_000n);
      expect(b).toBe(500_000_000n);
      expect(a + b).toBe(pool);
    });

    it("splits the pool by floor division among three tied players without exceeding the pool", () => {
      const pool = 100n;
      const shares = [calculatePayoutShareStroops(1, 3, pool), calculatePayoutShareStroops(1, 3, pool), calculatePayoutShareStroops(1, 3, pool)];
      const total = shares.reduce((sum, s) => sum + s, 0n);

      expect(shares.every((s) => s === 33n)).toBe(true);
      expect(total).toBeLessThanOrEqual(pool);
    });

    it("never lets computed shares sum above the total pool across arbitrary score distributions", () => {
      const pool = 999_999_937n;
      const scores = [37, 41, 41, 5, 123, 1];
      const total = scores.reduce((a, b) => a + b, 0);

      const shares = scores.map((s) => calculatePayoutShareStroops(s, total, pool));
      const sum = shares.reduce((a, b) => a + b, 0n);

      expect(sum).toBeLessThanOrEqual(pool);
    });

    it("gives a single winner with no ties 100% of the pool", () => {
      const pool = 250_000_000n;
      expect(calculatePayoutShareStroops(300, 300, pool)).toBe(pool);
    });

    it("gives 0 to a participant with no score contribution", () => {
      expect(calculatePayoutShareStroops(0, 300, 250_000_000n)).toBe(0n);
    });

    it("returns 0 for every participant when total points is 0 (no divide-by-zero)", () => {
      expect(calculatePayoutShareStroops(0, 0, 250_000_000n)).toBe(0n);
    });
  });

  /**
   * ---------------------------
   * Fuzz test (VERY IMPORTANT)
   * ---------------------------
   */
  describe("fuzz testing safety checks", () => {
    it("never produces NaN or negative values", () => {
      for (let i = 0; i < 1000; i++) {
        const score = calculateRoundScore({
          selectedOption: (["A", "B", "C", "D"] as const)[
            Math.floor(Math.random() * 4)
          ],
          correctOption: "A",
          reactionTimeMs: Math.random() * 50000,
        });

        expect(Number.isNaN(score)).toBe(false);
        expect(score >= 0).toBe(true);
      }
    });
  });

  /**
   * ---------------------------
   * Score bounds validation
   * ---------------------------
   */
  describe("validateRoundScore", () => {
    it("accepts score = 0", () => {
      expect(validateRoundScore(0)).toEqual({ valid: true });
    });

    it("accepts score = 150 (max per round)", () => {
      expect(validateRoundScore(MAX_ROUND_SCORE)).toEqual({ valid: true });
    });

    it("rejects score = 151", () => {
      const result = validateRoundScore(151);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ROUND_SCORE_OUT_OF_RANGE");
      }
    });

    it("rejects score = -1", () => {
      const result = validateRoundScore(-1);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ROUND_SCORE_OUT_OF_RANGE");
      }
    });

    it("rejects NaN", () => {
      expect(validateRoundScore(NaN).valid).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(validateRoundScore(Infinity).valid).toBe(false);
    });
  });

  describe("validateTotalScore", () => {
    it("accepts score = 0", () => {
      expect(validateTotalScore(0)).toEqual({ valid: true });
    });

    it("accepts score = 450 (max total)", () => {
      expect(validateTotalScore(MAX_TOTAL_SCORE)).toEqual({ valid: true });
    });

    it("rejects score = 451", () => {
      const result = validateTotalScore(451);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("TOTAL_SCORE_OUT_OF_RANGE");
      }
    });

    it("rejects score = -1", () => {
      const result = validateTotalScore(-1);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("TOTAL_SCORE_OUT_OF_RANGE");
      }
    });
  });
});