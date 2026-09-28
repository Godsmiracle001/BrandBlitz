import { describe, expect, it } from "vitest";
import { generateChallengeQuestions, generateQuestionPreview } from "./questions";
import type { Brand } from "../db/queries/brands";

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: "brand-1",
    owner_user_id: "user-1",
    name: "BrandX",
    tagline: "Best product ever",
    usp: "Fast and reliable",
    brand_story: null,
    logo_url: null,
    primary_color: null,
    secondary_color: null,
    product_image_keys: ["img1.png", "img2.png"],
    question_template: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
    ...overrides,
  };
}

const distractorPool = Array.from({ length: 20 }).map((_, i) => ({
  name: `Brand${i}`,
  tagline: `Tagline ${i}`,
  usp: `USP ${i}`,
}));

describe("Questions Generation Engine", () => {
  // -------------------------
  // BASIC GENERATION
  // -------------------------
  it("generates exactly 3 questions when full brand data is provided", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), distractorPool);

    expect(result.length).toBe(3);

    const types = result.map((q) => q.question_type);
    expect(types).toContain("which_tagline");
    expect(types).toContain("which_brand");
    expect(types).toContain("which_product");
  });

  it("assigns rounds 1, 2, and 3", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), distractorPool);
    const rounds = result.map((q) => q.round).sort();
    expect(rounds).toEqual([1, 2, 3]);
  });

  // -------------------------
  // FALLBACK TAGLINE
  // -------------------------
  it("falls back to brand name when tagline is missing", () => {
    const result = generateChallengeQuestions(
      "challenge-1",
      makeBrand({ tagline: null }),
      distractorPool,
    );

    const fallbackQ = result.find((q) => q.question_text === "What is the name of this brand?");

    expect(fallbackQ?.correct_answer).toBe("BrandX");
  });

  // -------------------------
  // DISTRACTOR LOGIC
  // -------------------------
  it("uses distractors from pool without duplicates or correct answer", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), distractorPool);

    result.forEach((q) => {
      const options = [q.option_a, q.option_b, q.option_c, q.option_d];

      // correct answer not duplicated in distractors
      const occurrences = options.filter((o) => o === q.correct_answer);
      expect(occurrences.length).toBe(1);
    });
  });

  // -------------------------
  // EMPTY POOL HANDLING
  // -------------------------
  it("falls back to Option A/B/C when distractor pool is empty", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), []);

    result.forEach((q) => {
      const options = [q.option_a, q.option_b, q.option_c, q.option_d];
      expect(options).toContain("Option A");
      expect(options).toContain("Option B");
      expect(options).toContain("Option C");
    });
  });

  // -------------------------
  // CORRECT OPTION SHUFFLING
  // -------------------------
  it("assigns correct_option consistently after shuffle", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), distractorPool);

    result.forEach((q) => {
      const options = [q.option_a, q.option_b, q.option_c, q.option_d];
      const correctIndex = options.indexOf(q.correct_answer);
      expect(q.correct_option).toBe(["A", "B", "C", "D"][correctIndex]);
    });
  });

  // -------------------------
  // TEMPLATE OVERRIDES (#487)
  // -------------------------
  it("uses defaults when question_template is null", () => {
    const result = generateChallengeQuestions(
      "challenge-1",
      makeBrand({ question_template: null }),
      distractorPool,
    );

    const r1 = result.find((q) => q.round === 1)!;
    expect(r1.question_text).toBe("Which tagline belongs to this brand?");
    expect(r1.prompt_type).toBe("logo");

    const r2 = result.find((q) => q.round === 2)!;
    expect(r2.question_text).toContain("Fast and reliable");
    expect(r2.prompt_type).toBe("tagline");

    const r3 = result.find((q) => q.round === 3)!;
    expect(r3.question_text).toBe("Which brand makes this product?");
    expect(r3.prompt_type).toBe("productImage1");
  });

  it("overrides question_text per round from question_template", () => {
    const brand = makeBrand({
      question_template: {
        round_1: { question_text: "Custom round 1 text" },
        round_2: { question_text: "Custom round 2 text" },
      },
    });
    const result = generateChallengeQuestions("challenge-1", brand, distractorPool);

    expect(result.find((q) => q.round === 1)!.question_text).toBe("Custom round 1 text");
    expect(result.find((q) => q.round === 2)!.question_text).toBe("Custom round 2 text");
    // round 3 not overridden — uses default
    expect(result.find((q) => q.round === 3)!.question_text).toBe("Which brand makes this product?");
  });

  it("overrides prompt_type per round from question_template", () => {
    const brand = makeBrand({
      question_template: {
        round_1: { prompt_type: "tagline" },
      },
    });
    const result = generateChallengeQuestions("challenge-1", brand, distractorPool);
    expect(result.find((q) => q.round === 1)!.prompt_type).toBe("tagline");
    // rounds without override keep their defaults
    expect(result.find((q) => q.round === 2)!.prompt_type).toBe("tagline");
    expect(result.find((q) => q.round === 3)!.prompt_type).toBe("productImage1");
  });

  it("falls back to generic questions when brand data is sparse", () => {
    const result = generateChallengeQuestions(
      "challenge-1",
      makeBrand({ tagline: null, usp: null, product_image_keys: [] }),
      distractorPool,
    );
    expect(result).toHaveLength(3);
    result.forEach((q) => {
      expect(q.question_text).toBe("What is the name of this brand?");
    });
  });

  it("sets challenge_id on all questions", () => {
    const result = generateChallengeQuestions("chal-xyz", makeBrand(), distractorPool);
    result.forEach((q) => {
      expect(q.challenge_id).toBe("chal-xyz");
    });
  });

  // -------------------------
  // OUTPUT SHAPE COMPLETENESS (#396)
  // -------------------------
  it("returns fully-populated question drafts with no missing fields", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), distractorPool);

    result.forEach((q) => {
      expect(q.question_text).toEqual(expect.any(String));
      expect(q.question_text.length).toBeGreaterThan(0);
      expect(q.correct_answer).toEqual(expect.any(String));
      expect(q.option_a).toEqual(expect.any(String));
      expect(q.option_b).toEqual(expect.any(String));
      expect(q.option_c).toEqual(expect.any(String));
      expect(q.option_d).toEqual(expect.any(String));
      expect(["A", "B", "C", "D"]).toContain(q.correct_option);
    });
  });

  // -------------------------
  // MALFORMED / BOUNDARY BRAND INPUT (#396)
  //
  // generateChallengeQuestions is a pure, deterministic function with no
  // required-field validation of its own — the brand fields it reads
  // (name, tagline, usp, description length) are validated upstream by the
  // Zod schema in routes/brands.ts before a Brand ever reaches this service.
  // These tests document (and lock in) how the generator actually behaves
  // when handed boundary-case input, so a regression here is caught even
  // though no exception is expected.
  // -------------------------
  it("does not throw for an empty-string brand name and still returns 3 well-formed questions", () => {
    const brand = makeBrand({ name: "" });

    expect(() => generateChallengeQuestions("challenge-1", brand, distractorPool)).not.toThrow();

    const result = generateChallengeQuestions("challenge-1", brand, distractorPool);
    expect(result).toHaveLength(3);
    result.forEach((q) => {
      expect([q.option_a, q.option_b, q.option_c, q.option_d]).not.toContain(undefined);
    });
  });

  it("does not throw for a very long usp and includes it verbatim in the round 2 question text", () => {
    const longUsp = "A".repeat(5000);
    const brand = makeBrand({ usp: longUsp });

    expect(() => generateChallengeQuestions("challenge-1", brand, distractorPool)).not.toThrow();

    const result = generateChallengeQuestions("challenge-1", brand, distractorPool);
    const round2 = result.find((q) => q.round === 2);
    expect(round2?.question_text).toContain(longUsp);
  });

  it("is a synchronous, side-effect-free function — no network or async work is possible", () => {
    const result = generateChallengeQuestions("challenge-1", makeBrand(), distractorPool);
    // A pure/sync function returns a value directly, never a Promise — there
    // is no AI client or network call in this service to mock out.
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("Question Preview Generation (generateQuestionPreview) — #396", () => {
  it("returns preview objects exposing text, options, correctIndex, and explanation", () => {
    const result = generateQuestionPreview(makeBrand(), distractorPool, 3);

    expect(result).toHaveLength(3);
    result.forEach((p) => {
      expect(p.text).toEqual(expect.any(String));
      expect(p.options).toHaveLength(4);
      expect(p.correctIndex).toBeGreaterThanOrEqual(0);
      expect(p.correctIndex).toBeLessThan(4);
      expect(p.explanation).toEqual(expect.any(String));
    });
  });

  it("correctIndex always points at the option named in the explanation (internal consistency)", () => {
    const result = generateQuestionPreview(makeBrand(), distractorPool, 3);

    result.forEach((p) => {
      expect(p.explanation).toBe(`The correct answer is "${p.options[p.correctIndex]}".`);
    });
  });

  it("cycles through the 3 underlying rounds when count exceeds 3", () => {
    const result = generateQuestionPreview(makeBrand(), distractorPool, 5);

    expect(result).toHaveLength(5);
    // index 3 wraps back to round index 0, index 4 wraps to round index 1
    expect(result[3].text).toBe(result[0].text);
    expect(result[4].text).toBe(result[1].text);
  });

  it("returns exactly `count` items when count is fewer than the 3 underlying rounds", () => {
    const result = generateQuestionPreview(makeBrand(), distractorPool, 1);
    expect(result).toHaveLength(1);
  });

  it("never returns an empty array, even for a brand with only a name (sparse data still fills 3 rounds)", () => {
    const sparseBrand = makeBrand({ tagline: null, usp: null, product_image_keys: [] });
    const result = generateQuestionPreview(sparseBrand, distractorPool, 3);
    expect(result).toHaveLength(3);
  });

  it("is a synchronous function — no network or AI client call is made", () => {
    const result = generateQuestionPreview(makeBrand(), distractorPool, 3);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result)).toBe(true);
  });
});
