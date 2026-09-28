import type { Brand } from "../db/queries/brands";
import type { ChallengeQuestion } from "../db/queries/challenges";

type QuestionDraft = Omit<ChallengeQuestion, "id">;

/**
 * Auto-generate 3 challenge questions from brand kit inputs.
 *
 * Round 1: Tagline recognition — show logo image, pick correct tagline
 * Round 2: Brand recognition — show brand copy, pick correct brand
 * Round 3: Product recognition — show product image, pick correct brand name
 *
 * Architecture decision: questions derived from content shown in warm-up,
 * so unknown brands work perfectly. Correct answers come from brand inputs.
 * Distractors are generated from other available brand data.
 */
type RoundTemplateOverride = {
  question_text?: string;
  prompt_type?: string;
};

export function generateChallengeQuestions(
  challengeId: string,
  brand: Brand,
  distractorPool: Pick<Brand, "name" | "tagline" | "usp">[]
): QuestionDraft[] {
  // Per-round overrides from brand.question_template; null/undefined = global defaults.
  const tpl = (brand.question_template ?? {}) as Record<string, RoundTemplateOverride>;

  const questions: QuestionDraft[] = [];

  // — Round 1: Tagline recognition —
  if (brand.tagline) {
    const distractors = pickDistractors(
      distractorPool.map((d) => d.tagline).filter(Boolean) as string[],
      brand.tagline,
      3
    );
    const options = shuffle([brand.tagline, ...distractors]);
    const correctOption = optionLetter(options.indexOf(brand.tagline));

    questions.push({
      challenge_id: challengeId,
      round: 1,
      question_type: "which_tagline",
      prompt_type: (tpl.round_1?.prompt_type ?? "logo") as QuestionDraft["prompt_type"],
      question_text: tpl.round_1?.question_text ?? `Which tagline belongs to this brand?`,
      correct_answer: brand.tagline,
      option_a: options[0],
      option_b: options[1],
      option_c: options[2],
      option_d: options[3],
      correct_option: correctOption,
    });
  }

  // — Round 2: USP match —
  if (brand.usp) {
    const distractors = pickDistractors(
      distractorPool.map((d) => d.name).filter(Boolean) as string[],
      brand.name,
      3
    );
    const options = shuffle([brand.name, ...distractors]);
    const correctOption = optionLetter(options.indexOf(brand.name));

    questions.push({
      challenge_id: challengeId,
      round: 2,
      question_type: "which_brand",
      prompt_type: (tpl.round_2?.prompt_type ?? "tagline") as QuestionDraft["prompt_type"],
      question_text:
        tpl.round_2?.question_text ?? `Which brand is described by this claim: ${brand.usp}?`,
      correct_answer: brand.name,
      option_a: options[0],
      option_b: options[1],
      option_c: options[2],
      option_d: options[3],
      correct_option: correctOption,
    });
  }

  // — Round 3: Product recognition —
  if (brand.product_image_keys.length > 0) {
    const brandNames = pickDistractors(
      distractorPool.map((d) => d.name).filter(Boolean) as string[],
      brand.name,
      3
    );
    const options = shuffle([brand.name, ...brandNames]);
    const correctOption = optionLetter(options.indexOf(brand.name));

    questions.push({
      challenge_id: challengeId,
      round: 3,
      question_type: "which_product",
      prompt_type: (tpl.round_3?.prompt_type ?? "productImage1") as QuestionDraft["prompt_type"],
      question_text: tpl.round_3?.question_text ?? `Which brand makes this product?`,
      correct_answer: brand.name,
      option_a: options[0],
      option_b: options[1],
      option_c: options[2],
      option_d: options[3],
      correct_option: correctOption,
    });
  }

  // Ensure exactly 3 rounds — fallback to brand name recognition if data is sparse
  while (questions.length < 3) {
    const round = (questions.length + 1) as 1 | 2 | 3;
    const roundKey = `round_${round}` as "round_1" | "round_2" | "round_3";
    const distractors = pickDistractors(
      distractorPool.map((d) => d.name),
      brand.name,
      3
    );
    const options = shuffle([brand.name, ...distractors]);
    questions.push({
      challenge_id: challengeId,
      round,
      question_type: "which_brand",
      prompt_type: (tpl[roundKey]?.prompt_type ?? "logo") as QuestionDraft["prompt_type"],
      question_text: tpl[roundKey]?.question_text ?? `What is the name of this brand?`,
      correct_answer: brand.name,
      option_a: options[0],
      option_b: options[1],
      option_c: options[2],
      option_d: options[3],
      correct_option: optionLetter(options.indexOf(brand.name)),
    });
  }

  return questions.slice(0, 3);
}

function pickDistractors(pool: string[], exclude: string, count: number): string[] {
  const filtered = pool.filter((item) => item !== exclude);
  const shuffled = shuffle(filtered);
  const result = shuffled.slice(0, count);

  // Pad with generic fallbacks if pool is too small
  const fallbacks = ["Option A", "Option B", "Option C", "Option D"];
  while (result.length < count) {
    result.push(fallbacks[result.length] ?? `Option ${result.length + 1}`);
  }

  return result;
}

function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function optionLetter(index: number): "A" | "B" | "C" | "D" {
  return (["A", "B", "C", "D"] as const)[index] ?? "A";
}

export interface QuestionPreview {
  text: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

/**
 * Draft-only variant of generateChallengeQuestions for the preview endpoint
 * (issue #467). Reuses the same deterministic round generation but returns a
 * flat text/options/correctIndex/explanation shape and does not require a
 * persisted challenge_id. `count` cycles through the 3 rounds to fill out
 * however many preview questions were requested.
 */
export function generateQuestionPreview(
  brand: Brand,
  distractorPool: Pick<Brand, "name" | "tagline" | "usp">[],
  count: number
): QuestionPreview[] {
  const rounds = generateChallengeQuestions("preview", brand, distractorPool);
  if (rounds.length === 0) return [];

  const previews: QuestionPreview[] = [];
  for (let i = 0; i < count; i++) {
    const round = rounds[i % rounds.length];
    const options = [round.option_a, round.option_b, round.option_c, round.option_d];
    previews.push({
      text: round.question_text,
      options,
      correctIndex: options.indexOf(round.correct_answer),
      explanation: `The correct answer is "${round.correct_answer}".`,
    });
  }
  return previews;
}
