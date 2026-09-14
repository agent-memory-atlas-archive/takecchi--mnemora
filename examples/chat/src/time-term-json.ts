import type { PairMember, PairOutcome, TimeTermArmReport } from "./time-term-arm.js";
import type { ProviderMode } from "./providers.js";

/**
 * `time-term`（ADR 0058 / Issue #217）の機械可読な出力口。
 *
 * `./retrieval-json.ts`（ADR 0088）・`./identifier-json.ts`（ADR 0094）と同じ分担・
 * 同じ理由: ファイル I/O・環境変数・時刻取得を一切行わない純関数だけを置く。
 * `cli.ts` の `runTimeTerm()` が、`runTimeTermArm()` の返り値（`TimeTermArmReport`）を
 * ここへ渡して JSON を組み立て、`MNEMORA_TIME_TERM_JSON` が設定されているときだけ書き出す。
 *
 * 🔴 **数字だけを書いて、条件を書かないベンチ出力は、この repo で実際に3度壊れている**
 * （ADR 0068・ADR 0081 §3.2）。だからこの JSON も、**実際に使われた** `llmMode`/
 * `embeddingMode`（`report.llmMode`/`report.embeddingMode` = `handle` の実値）を
 * トップレベルに同居させる。
 *
 * ⚠ **`identifier-json.ts` と違い `status: "weights_unavailable"` を持たない。**
 * `time-term` は `deterministic` embedding に固定される（`cli.ts` の `runTimeTerm()`
 * docstring 参照）——`@mnemora/local-embedding` を使わないので、HuggingFace への外向き
 * 通信も「重みを取得できなかった」という失敗モードも構造上存在しない
 * （ADR 0094 §9 が引き受けた負債1はこの bench には当たらない）。
 *
 * ⚠ **MRR / hit@k を持たない。**この arm は「gold/distractor のどちらが上に来るか」の
 * 想起の質を測るものではなく、「時間項(`freshness`/`decay`)が総合スコアの順位を
 * 動かすか・どれだけ動かすか」を測るものである（ADR 0058）。⟹ 出力の単位は
 * probe ごとの `outcome`（`PairOutcome`）であり、それを混ぜた単一の指標は作らない。
 *
 * ⚠ **JSON は数値を丸めずに書く。**`formatScoreValue`（コンソール表示、`toFixed(6)`）を
 * 経由しないので、`total`/`freshness`/`decay` の実際の桁（ADR 0109 §4 が実測した
 * 1e-7 桁の差）を機械可読な形で保つ唯一の経路である（`retrieval-json.ts` の
 * `termDistinct` と同じ理由）。
 */

export interface TimeTermPairMemberJson {
  rank: number;
  total: number;
  /** ANN 経由でない場合は `undefined` になりうる欄（`ScoreBreakdown.similarity`）を `null` に写す。 */
  similarity: number | null;
  decay: number;
  tagMatch: number;
  freshness: number;
  strength: number;
  digest: string;
}

export interface TimeTermProbeJson {
  probeId: string;
  outcome: PairOutcome;
  totalInScope: number;
  omittedKinds: string[];
  /** ペアの2件の `similarity` の差の絶対値。片方が返っていなければ `null`（0 と区別する）。 */
  similarityGapWithinPair: number | null;
  /** `decay-*` probe の検査の要——0 でなければ `freshness`/`decay` が分離できていない。 */
  freshnessGapWithinPair: number | null;
  freshnessRatio: number | null;
  decayRatio: number | null;
  totalRatio: number | null;
  newer: TimeTermPairMemberJson | null;
  older: TimeTermPairMemberJson | null;
}

export interface TimeTermRunJson {
  /** この形が変わったら上げる。読み手（summary スクリプト）が形の変化を検知できるように。 */
  schemaVersion: 1;
  /** ISO 8601。JSON を組み立てた時刻——8 probe すべての実行が終わった後。 */
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない。`./git-info.js` 参照）。 */
  commit: string | null;
  armLabel: string;
  /** その arm で**実際に**使われたモード（`TimeTermArmReport.llmMode` = `handle.llmMode` の実値）。 */
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `report.probes.length`。件数をどこにも書き写さない（ADR 0068 の再発防止と同じ規律）。 */
  probeCount: number;
  probes: TimeTermProbeJson[];
}

export interface BuildTimeTermJsonOptions {
  report: TimeTermArmReport;
  measuredAt: Date;
  commit: string | null;
}

function memberJson(member: PairMember | null): TimeTermPairMemberJson | null {
  if (member === null) {
    return null;
  }
  return {
    rank: member.rank,
    total: member.score.total,
    similarity: member.score.similarity ?? null,
    decay: member.score.decay,
    tagMatch: member.score.tagMatch,
    freshness: member.score.freshness,
    strength: member.score.strength,
    digest: member.digest,
  };
}

/**
 * `runTimeTermArm()` が返した `TimeTermArmReport` から、機械可読な JSON を組み立てる。
 *
 * **純関数**（ファイル I/O・環境変数・時刻取得を一切行わない）——呼び出し側が
 * `measuredAt`/`commit` を明示的に渡す。これにより DB もネットワークも無い環境で
 * 検査できる（`__tests__/time-term-json.test.ts`）。
 *
 * **出所は `TimeTermArmReport` の欄だけ**（`retrieval-json.ts`/`identifier-json.ts` と
 * 同じ規律）。集計をここで作り直さない——`report.probes` をそのまま写す。
 */
export function buildTimeTermJson(options: BuildTimeTermJsonOptions): TimeTermRunJson {
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
      outcome: p.outcome,
      totalInScope: p.totalInScope,
      omittedKinds: [...p.omittedKinds],
      similarityGapWithinPair: p.similarityGapWithinPair,
      freshnessGapWithinPair: p.freshnessGapWithinPair,
      freshnessRatio: p.freshnessRatio,
      decayRatio: p.decayRatio,
      totalRatio: p.totalRatio,
      newer: memberJson(p.newer),
      older: memberJson(p.older),
    })),
  };
}
