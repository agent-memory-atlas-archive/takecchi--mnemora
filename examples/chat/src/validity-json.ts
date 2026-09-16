import type { ValidityArmReport, ValidityProbeOutcome } from "./validity-arm.js";
import type { ProviderMode } from "./providers.js";

/**
 * `validity`（Issue #280、Issue #202 第2弾）の機械可読な出力口。
 *
 * `./time-term-json.ts`（ADR 0058）と同じ分担・同じ理由: ファイル I/O・環境変数・
 * 時刻取得を一切行わない純関数だけを置く。`cli.ts` の `runValidity()` が、
 * `runValidityArm()` の返り値（`ValidityArmReport`）をここへ渡して JSON を組み立て、
 * `MNEMORA_VALIDITY_JSON` が設定されているときだけ書き出す。
 *
 * 🔴 数字だけを書いて条件を書かないベンチ出力は、この repo で実際に3度壊れている
 * （ADR 0068・ADR 0081 §3.2）。だからこの JSON も、**実際に使われた** `llmMode`/
 * `embeddingMode` をトップレベルに同居させる。
 */

export interface ValidityProbeJson {
  probeId: string;
  otherReason: ValidityProbeOutcome["otherReason"];
  currentReturnedAtNow: boolean;
  otherReturnedAtNow: boolean;
  omittedConditionsAtNow: string[];
  historical: {
    validAt: string;
    currentReturned: boolean;
    otherReturned: boolean;
    omittedConditions: string[];
  } | null;
  optOutCurrentReturned: boolean;
  optOutOtherReturned: boolean;
  totalInScope: number;
}

export interface ValidityRunJson {
  /** この形が変わったら上げる。読み手（summary スクリプト）が形の変化を検知できるように。 */
  schemaVersion: 1;
  /** ISO 8601。JSON を組み立てた時刻——全 probe の実行が終わった後。 */
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない）。 */
  commit: string | null;
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  probeCount: number;
  probes: ValidityProbeJson[];
}

export interface BuildValidityJsonOptions {
  report: ValidityArmReport;
  measuredAt: Date;
  commit: string | null;
}

/**
 * `runValidityArm()` が返した `ValidityArmReport` から、機械可読な JSON を組み立てる。
 *
 * **純関数**（ファイル I/O・環境変数・時刻取得を一切行わない）——呼び出し側が
 * `measuredAt`/`commit` を明示的に渡す。**出所は `ValidityArmReport` の欄だけ**
 * （`time-term-json.ts` と同じ規律）。
 */
export function buildValidityJson(options: BuildValidityJsonOptions): ValidityRunJson {
  const { report } = options;
  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    armLabel: report.armLabel,
    llmMode: report.llmMode,
    embeddingMode: report.embeddingMode,
    probeCount: report.probes.length,
    probes: report.probes.map((p) => ({
      probeId: p.probeId,
      otherReason: p.otherReason,
      currentReturnedAtNow: p.current.returnedAtNow,
      otherReturnedAtNow: p.other.returnedAtNow,
      omittedConditionsAtNow: [...p.omittedConditionsAtNow],
      historical: p.historical
        ? {
            validAt: p.historical.validAt.toISOString(),
            currentReturned: p.historical.currentReturned,
            otherReturned: p.historical.otherReturned,
            omittedConditions: [...p.historical.omittedConditions],
          }
        : null,
      optOutCurrentReturned: p.optOut.currentReturned,
      optOutOtherReturned: p.optOut.otherReturned,
      totalInScope: p.totalInScope,
    })),
  };
}
