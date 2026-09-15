import type { AssociationArmReport } from "./association-arm.js";

/**
 * `association-probes` の機械可読な出力口（`./retrieval-json.js` / `./identifier-json.js` と
 * 同じ作法。Issue #291）。
 *
 * ⭐ **出力スキーマは確定している。**別担当がこれを前提に summary スクリプトを書いている
 * ため、キー名を1文字も変えないこと（マネージャー指示）。
 *
 * `embedding`（`provider`/`model`/`dimensions`）と `recallLimit` は、この arm を走らせる
 * cli 側（`cli.ts`）が `@mnemora/local-embedding` / `@mnemora/core` の定数から取って渡す
 * ——ここでは値を手で書かない（`retrieval-json.ts` と同じ「出所を1箇所にする」規律）。
 */

export interface AssociationEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

export interface AssociationWarmupJson {
  ok: boolean;
  /**
   * `ok: false` のときだけ理由を持つ。`ok: true` のときは `null`
   * （成功時の常套句を機械可読 JSON に残す価値が無いため、"何も言うことが無い"を
   * 素直に null で表す）。
   */
  detail: string | null;
}

export interface AssociationDeltaJson {
  baselineArmLabel: string;
  againstArmLabel: string;
  /** against.goldReturnedCount - baseline.goldReturnedCount。 */
  goldReturnedCount: number;
  /** against.goldViaAssociationCount(baseline 側は構造上 0 なので差ではなく against の値そのもの)。 */
  goldViaAssociationCount: number;
  /** against.mrr - baseline.mrr。 */
  mrr: number;
  /** against.hit10Count - baseline.hit10Count。 */
  hit10Count: number;
  /** against.memoryCharsTotal - baseline.memoryCharsTotal。 */
  memoryCharsTotal: number;
  /** memoryCharsTotal(差分) / goldReturnedCount(差分)。goldReturnedCount が 0 以下なら null。 */
  charsPerAdditionalGold: number | null;
}

export interface AssociationProbeRunJson {
  /** この形が変わったら上げる。読み手(summary スクリプト)が形の変化を検知できるように。 */
  schemaVersion: 1;
  /** ISO 8601。JSON を組み立てた時刻——arm の実行が全部終わった後。 */
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`(推測で埋めない。`./git-info.js` 参照)。 */
  commit: string | null;
  embedding: AssociationEmbeddingSpaceJson;
  /** この bench は `deterministic` LLM 固定(`cli.ts` の `runAssociationProbes`)。 */
  llmMode: "deterministic";
  probeCount: number;
  haystackSize: number;
  recallLimit: number;
  warmup: AssociationWarmupJson;
  /** 4 arm(off / on(maxCount=3) / on(maxCount=5) / on(maxCount=10))。 */
  arms: AssociationArmReport[];
  /** 3件(on(3) / on(5) / on(10) のそれぞれ対 off)。 */
  deltas: AssociationDeltaJson[];
}

/** `against` から `baseline` を引いた差分を組む(純関数)。 */
function buildAssociationDelta(
  baseline: AssociationArmReport,
  against: AssociationArmReport,
): AssociationDeltaJson {
  const goldReturnedCount = against.goldReturnedCount - baseline.goldReturnedCount;
  const memoryCharsTotal = against.memoryCharsTotal - baseline.memoryCharsTotal;
  return {
    baselineArmLabel: baseline.armLabel,
    againstArmLabel: against.armLabel,
    goldReturnedCount,
    goldViaAssociationCount: against.goldViaAssociationCount,
    mrr: against.mrr - baseline.mrr,
    hit10Count: against.hit10Count - baseline.hit10Count,
    memoryCharsTotal,
    charsPerAdditionalGold: goldReturnedCount > 0 ? memoryCharsTotal / goldReturnedCount : null,
  };
}

export interface BuildAssociationProbeRunJsonOptions {
  offReport: AssociationArmReport;
  on3Report: AssociationArmReport;
  on5Report: AssociationArmReport;
  on10Report: AssociationArmReport;
  embeddingSpace: AssociationEmbeddingSpaceJson;
  recallLimit: number;
  warmup: { ok: boolean; detail: string };
  measuredAt: Date;
  commit: string | null;
}

/**
 * 計測できたときの JSON を組み立てる。**純関数**(ファイル I/O・環境変数・時刻取得を
 * 一切行わない)——呼び出し側が `measuredAt`/`commit`/`recallLimit` を明示的に渡す。
 *
 * `probeCount`/`haystackSize` は `offReport` から導く(`retrieval-json.ts` の
 * `buildRetrievalQualityJson` と同じ理由——書き写すと呼び出し側が別の値を渡したときに
 * この JSON だけが古い値のまま残る)。association probe set は 1 probe あたり
 * anchor/gold/distractor の3件を積む(`./association-probe-set.js` 参照)ため、
 * `haystackSize = ingestedCount - probeCount * 3`。
 */
export function buildAssociationProbeRunJson(
  options: BuildAssociationProbeRunJsonOptions,
): AssociationProbeRunJson {
  const probeCount = options.offReport.probeCount;
  const haystackSize = options.offReport.ingestedCount - probeCount * 3;

  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    embedding: options.embeddingSpace,
    llmMode: "deterministic",
    probeCount,
    haystackSize,
    recallLimit: options.recallLimit,
    warmup: {
      ok: options.warmup.ok,
      detail: options.warmup.ok ? null : options.warmup.detail,
    },
    arms: [options.offReport, options.on3Report, options.on5Report, options.on10Report],
    deltas: [
      buildAssociationDelta(options.offReport, options.on3Report),
      buildAssociationDelta(options.offReport, options.on5Report),
      buildAssociationDelta(options.offReport, options.on10Report),
    ],
  };
}
