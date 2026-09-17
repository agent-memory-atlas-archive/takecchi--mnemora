import type { Omission } from "@mnemora/core";
import type { ComparisonRow } from "./compare.js";
import type { ProviderMode } from "./providers.js";

/**
 * `compare`（北極星の物差し。docs/north-star.md「使う側が会話ログを全部プロンプトへ
 * 積むのをやめられたか」）の機械可読な出力口（Issue #242）。
 *
 * `./retrieval-json.ts`（ADR 0088）・`./time-term-json.ts`（ADR 0058/#217）と同じ分担:
 * ファイル I/O・環境変数・時刻取得を一切行わない純関数だけを置く。`cli.ts` の
 * `runCompare()` が `runComparison()`（`compare.ts`）の返り値（`ComparisonRow[]`）を
 * ここへ渡して JSON を組み立て、`MNEMORA_COMPARE_JSON` が設定されているときだけ書き出す。
 *
 * 🔴 **数字だけを書いて、条件を書かないベンチ出力は、この repo で実際に3度壊れている**
 * （ADR 0068・ADR 0081 §3.2）。だからこの JSON も、**実際に使われた** `llmMode`/
 * `embeddingMode`（`handle` の実値）をトップレベルに同居させる。
 *
 * ⚠ **`compare.ts` の `ComparisonRow` をほぼそのまま写す。**集計をここで作り直さない
 * ——`omitted`（`Omission[]`）も丸ごと持つ（`compare.ts` 冒頭のコメント「推定値を
 * 実測値の顔で出さない」という規律を、この JSON でも保つ）。
 */

export interface CompareRowJson {
  fillerPairs: number;
  turnCount: number;
  naiveChars: number;
  naiveTokens: number;
  mnemoraChars: number;
  mnemoraTokens: number;
  mnemoraShareOfNaiveChars: number;
  totalInScope: number;
  omitted: Omission[];
  returnedCount: number;
  annCandidateCount: number;
  /**
   * 冒頭の事実表明の出典（`sourceObservationId` → `externalId`）に到達したかだけを
   * 測る。情報保持・最終回答の正誤はこの欄に含まれない（`ComparisonRow.factStatementSurvived`
   * の docstring、`docs/autonomy.md` §2.2 の2番、ADR 0226）。
   *
   * 🔴 **キー名はここでは変えていない。** ⭐門（ADR 0133）と
   * `examples/chat/compare-baseline.json` がこのキー名に依存しているため、
   * `schemaVersion` を上げずに据え置いている——意味のずれはこのコメントと
   * ADR 0226 で名乗る。
   */
  factStatementSurvived: boolean;
}

export interface CompareRunJson {
  /** この形が変わったら上げる。読み手（summary スクリプト）が形の変化を検知できるように。 */
  schemaVersion: 1;
  /** ISO 8601。JSON を組み立てた時刻——全会話長の実行が終わった後。 */
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない。`./git-info.js` 参照）。 */
  commit: string | null;
  /** その run で**実際に**使われたモード（`handle.llmMode`/`handle.embeddingMode` の実値）。 */
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `rows.length`。件数をどこにも書き写さない（ADR 0068 の再発防止と同じ規律）。 */
  rowCount: number;
  rows: CompareRowJson[];
}

export interface BuildCompareJsonOptions {
  rows: readonly ComparisonRow[];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  measuredAt: Date;
  commit: string | null;
}

/**
 * `runComparison()` が返した `ComparisonRow[]` から、機械可読な JSON を組み立てる。
 *
 * **純関数**（ファイル I/O・環境変数・時刻取得を一切行わない）——呼び出し側が
 * `measuredAt`/`commit` を明示的に渡す。これにより DB もネットワークも無い環境で
 * 検査できる（`__tests__/compare-json.test.ts`）。
 *
 * **出所は `ComparisonRow` の欄だけ**（`retrieval-json.ts`/`time-term-json.ts` と
 * 同じ規律）。集計をここで作り直さない——`row.omitted` をそのまま写す（配列を複製し、
 * 呼び出し側の配列への以後の変更が影響しないようにする）。
 */
export function buildCompareJson(options: BuildCompareJsonOptions): CompareRunJson {
  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    rowCount: options.rows.length,
    rows: options.rows.map((row) => ({
      fillerPairs: row.fillerPairs,
      turnCount: row.turnCount,
      naiveChars: row.naiveChars,
      naiveTokens: row.naiveTokens,
      mnemoraChars: row.mnemoraChars,
      mnemoraTokens: row.mnemoraTokens,
      mnemoraShareOfNaiveChars: row.mnemoraShareOfNaiveChars,
      totalInScope: row.totalInScope,
      omitted: row.omitted.map((o) => ({ ...o })),
      returnedCount: row.returnedCount,
      annCandidateCount: row.annCandidateCount,
      factStatementSurvived: row.factStatementSurvived,
    })),
  };
}
