import type { AnswerCaseRunResult } from "./answer-bench.js";
import type { AnswerCategory, AnswerVerdict } from "./answer-case.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer` の機械可読な出力口（`MNEMORA_ANSWER_JSON`、`cli.ts`）。
 *
 * `compare-json.ts`/`retrieval-json.ts` と同じ分担: ファイル I/O・環境変数・時刻取得を
 * 一切行わない純関数だけを置く。
 *
 * 🔴 **この JSON は回答品質を主張しない。** `qualityClaimable` が `false`
 * （`llmMode === "deterministic"`）のときは `summary`（何件中何件 pass の集計）を
 * 一切出さない——`answerQualityClaimable`（`answer-case.ts`）が唯一の判定源である。
 * ケースごとの `verdict` フィールド自体は raw データとして残す（機械可読な出力は
 * 後から品質を主張してよい層で読み直すことができる形にしておく）——ただし
 * **集計しない**という制約は変えない。
 */

export interface AnswerPathJson {
  inputChars: number;
  inputEstimatedTokens: number;
  answer: string;
  verdict: AnswerVerdict;
}

export interface AnswerCaseCostJson {
  extractionLLMCalls: number;
  embeddingCalls: number;
  answerLLMCalls: number;
}

export interface AnswerCaseJson {
  id: string;
  category: AnswerCategory;
  tuningUse: "development" | "held-out";
  naive: AnswerPathJson;
  mnemora: AnswerPathJson;
  cost: AnswerCaseCostJson;
}

export interface AnswerVerdictCountsJson {
  pass: number;
  fail: number;
  indeterminate: number;
}

export interface AnswerSummaryJson {
  naive: AnswerVerdictCountsJson;
  mnemora: AnswerVerdictCountsJson;
}

export interface AnswerRunJson {
  /** この形が変わったら上げる。 */
  schemaVersion: 1;
  measuredAt: string;
  commit: string | null;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `answerQualityClaimable(llmMode)` の結果。`false` なら `summary` は無い。 */
  qualityClaimable: boolean;
  caseCount: number;
  cases: AnswerCaseJson[];
  /** `qualityClaimable === true` のときだけ存在する。 */
  summary?: AnswerSummaryJson;
}

export interface BuildAnswerJsonOptions {
  results: readonly AnswerCaseRunResult[];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  measuredAt: Date;
  commit: string | null;
}

function emptyVerdictCounts(): AnswerVerdictCountsJson {
  return { pass: 0, fail: 0, indeterminate: 0 };
}

function tallyVerdicts(verdicts: readonly AnswerVerdict[]): AnswerVerdictCountsJson {
  const counts = emptyVerdictCounts();
  for (const v of verdicts) {
    counts[v] += 1;
  }
  return counts;
}

export function buildAnswerJson(options: BuildAnswerJsonOptions): AnswerRunJson {
  const qualityClaimable = answerQualityClaimable(options.llmMode);
  const cases: AnswerCaseJson[] = options.results.map((result) => ({
    id: result.case.id,
    category: result.case.category,
    tuningUse: result.case.tuningUse,
    naive: {
      inputChars: result.naive.inputChars,
      inputEstimatedTokens: result.naive.inputEstimatedTokens,
      answer: result.naive.answer,
      verdict: result.naive.verdict,
    },
    mnemora: {
      inputChars: result.mnemora.inputChars,
      inputEstimatedTokens: result.mnemora.inputEstimatedTokens,
      answer: result.mnemora.answer,
      verdict: result.mnemora.verdict,
    },
    cost: { ...result.cost },
  }));

  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    qualityClaimable,
    caseCount: cases.length,
    cases,
    ...(qualityClaimable
      ? {
          summary: {
            naive: tallyVerdicts(options.results.map((r) => r.naive.verdict)),
            mnemora: tallyVerdicts(options.results.map((r) => r.mnemora.verdict)),
          },
        }
      : {}),
  };
}
