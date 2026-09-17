import type { AnswerCaseRunResult } from "./answer-bench.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { AnswerVerdict } from "./answer-case.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer` の人間向け出力（Markdown 表 + 目立つ注記）。
 *
 * 🔴 **`answerQualityClaimable(llmMode) === false` のとき、正誤の列に判定を出さない。**
 * `—` を出し、脚注で理由を書く——`llmMode=deterministic` は意味を持たない stub であり、
 * この bench が回っても回答品質は測っていない。
 */

/** stdout の先頭に出す、目立つ注記。`llmMode` が `deterministic` のときだけ非空を返す。 */
export function formatAnswerQualityBanner(llmMode: ProviderMode): string {
  if (answerQualityClaimable(llmMode)) {
    return "";
  }
  return (
    "⛔⛔⛔ これは配線の検査であり、回答品質は測っていない（llmMode=deterministic） ⛔⛔⛔\n" +
    "deterministic の LLM は意味を持たない stub（渡された最後のメッセージをそのまま返す）である。" +
    "以下の表・JSON は naive/mnemora が同じ入力量・同じ呼び出し方で走ることの配線検査であって、" +
    "どちらの回答が正しいかは、この run からは何も言えない。"
  );
}

function verdictGlyph(verdict: AnswerVerdict): string {
  switch (verdict) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "indeterminate":
      return "❓";
    default: {
      const exhaustive: never = verdict;
      throw new Error(`verdictGlyph: 未知の AnswerVerdict: ${String(exhaustive)}`);
    }
  }
}

/**
 * ケースごとの入力量（naive/mnemora）と、質を主張できるときだけの正誤を並べた表。
 *
 * `answerQualityClaimable(llmMode) === false` のときは正誤の列に `—` を出し、
 * 表の下に脚注を1行足す。
 */
export function formatAnswerTable(
  results: readonly AnswerCaseRunResult[],
  llmMode: ProviderMode,
): string {
  const claimable = answerQualityClaimable(llmMode);
  const header =
    "| id | category | tuningUse | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | naive 正誤 | mnemora 正誤 |";
  const sep = "|---|---|---|---|---|---|---|---|---|";
  const body = results.map((r) => {
    const naiveVerdict = claimable ? verdictGlyph(r.naive.verdict) : "—";
    const mnemoraVerdict = claimable ? verdictGlyph(r.mnemora.verdict) : "—";
    return (
      `| ${r.case.id} | ${r.case.category} | ${r.case.tuningUse} | ${r.naive.inputChars} | ` +
      `${r.naive.inputEstimatedTokens} | ${r.mnemora.inputChars} | ` +
      `${r.mnemora.inputEstimatedTokens} | ${naiveVerdict} | ${mnemoraVerdict} |`
    );
  });
  const lines = [header, sep, ...body];
  if (!claimable) {
    lines.push(
      "",
      "(注) 正誤の列は `—`——`llmMode=deterministic` では回答品質を主張できない" +
        "（`answerQualityClaimable`、`answer-case.ts`）。",
    );
  }
  return lines.join("\n");
}

/**
 * 追加費用（別ブロック）。⛔ 削減率から差し引かない——ここに独立して出す。
 */
export function formatAnswerCostTable(results: readonly AnswerCaseRunResult[]): string {
  const header = "| id | 抽出 LLM 呼び出し | 埋め込み呼び出し | 回答生成 LLM 呼び出し |";
  const sep = "|---|---|---|---|";
  const body = results.map(
    (r) =>
      `| ${r.case.id} | ${r.cost.extractionLLMCalls} | ${r.cost.embeddingCalls} | ${r.cost.answerLLMCalls} |`,
  );
  const totalExtraction = results.reduce((sum, r) => sum + r.cost.extractionLLMCalls, 0);
  const totalEmbedding = results.reduce((sum, r) => sum + r.cost.embeddingCalls, 0);
  const totalAnswer = results.reduce((sum, r) => sum + r.cost.answerLLMCalls, 0);
  const totalRow = `| **合計** | **${totalExtraction}** | **${totalEmbedding}** | **${totalAnswer}** |`;
  return [header, sep, ...body, totalRow].join("\n");
}
