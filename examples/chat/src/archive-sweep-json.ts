import { defaultDecayStrategy, heuristicTokenCounter } from "@mnemora/core";
import type { ProviderMode } from "./providers.js";
import { carriedDigestTokensOf, meanExcludingNullGoldRank } from "./consolidation-json.js";

/**
 * `archive-sweep-cost` サブコマンド(Issue #209)の機械可読出力口。
 *
 * **なぜこれが要るか**: `Runtime.sweepArchive`/`MemoryStore.archiveDecayed`(ADR 0114)は
 * 入ったが、`examples/chat` に配線が無く、北極星の物差し（「使う側が会話ログを全部
 * プロンプトへ積むのをやめられたか」）に効いたかを誰も測っていなかった（Issue #209、
 * #136 と同型の穴）。この bench は「掃引の前後でベンチの数字が動くか」を実測する器である。
 *
 * **`./consolidation-json.ts`（Issue #136 / ADR 0101）と型を共有しない理由**:
 * consolidate は「N件をLLMで1件へ畳む」操作であり、JSON は round ごとの
 * `groups`/`llmCalls`/`outcomes`/`embeddingStatus` を持つ。sweep は「decay_floor_at を
 * 過ぎた行を status だけ書き換える」操作であり、LLM を1回も呼ばない・新しい Memory を
 * 1件も作らない・ラウンドを反復しない（1回 sweep すれば対象は尽きる。ADR 0114
 * 「一度 archived になった行は…同じ行が二度 archived になることはない」）。
 * この違いのため、専用の JSON 型を持つ。**ただし測定の部品（probe 集合・budget ladder・
 * digest トークン数え方・goldRank の平均の取り方）は共有する**——
 * `carriedDigestTokensOf`/`meanExcludingNullGoldRank`（このファイルが import している
 * とおり）と、`examples/chat/src/probe-set.ts`・`consolidation-cost-options.ts` の
 * `DEFAULT_BUDGET_LADDER`/`DEFAULT_RECALL_LIMIT` をそのまま流用する
 * （`archive-sweep-cost.ts` 参照）。
 *
 * ⛔ **縮み率（前後の比）はここでは書かない**（ADR 0088 §4 / consolidation-json.ts と
 * 同じ規律）。差分は将来 `scripts/archive-sweep-cost-summary.mjs` が基準値との比較として
 * 計算する。
 */

export interface ArchiveSweepEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

export interface ArchiveSweepStoreJson {
  activeCount: number;
  supersededCount: number;
  /** `status='archived'` の件数。sweep 前は常に0。 */
  archivedCount: number;
  /** active のみ。 */
  activeContentChars: number;
  activeContentTokens: number;
  activeDigestChars: number;
  activeDigestTokens: number;
  /** active + superseded + archived の合計。 */
  allContentChars: number;
}

export interface ArchiveSweepProbeJson {
  probeId: string;
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  goldRank: number | null;
  /** `result.memories.length / store.activeCount`。1.0 に近いと「全部載せる」に退化している。 */
  recalledActiveShare: number;
  /**
   * `result.omitted` のうち `{kind:'filtered', condition:'archived'}` の `count`。
   * sweep 前は常に0——`status='archived'` の行がまだ1件も存在しないため
   * （ADR 0114 が唯一の書き込み口）。sweep 後に正の値へ動けば、この bench の受け入れ条件
   * （issue #209 本文）の1つが実測で満たされたことになる。
   */
  omittedArchivedCount: number;
  omittedKinds: string[];
  budgetExceeded: boolean;
}

export interface ArchiveSweepMeanJson {
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  recalledActiveShare: number;
  omittedArchivedCount: number;
  /** `goldRank` が非 null の probe だけの平均。全件 null なら `null`。 */
  goldRank: number | null;
  /** `goldRank` が null で平均から除いた probe の件数。 */
  goldRankExcludedCount: number;
}

export interface ArchiveSweepRecallUnbudgetedJson {
  probes: ArchiveSweepProbeJson[];
  mean: ArchiveSweepMeanJson;
}

/** 予算の階段（`consolidation-cost-options.ts` の `DEFAULT_BUDGET_LADDER` を共有する）の1段。 */
export interface ArchiveSweepRecallBudgetRungJson {
  budgetTokens: number;
  probes: ArchiveSweepProbeJson[];
  mean: ArchiveSweepMeanJson;
}

export interface ArchiveSweepRecallJson {
  unbudgeted: ArchiveSweepRecallUnbudgetedJson;
  /** `budgetLadder` と同じ長さ・同じ順序。 */
  budgeted: ArchiveSweepRecallBudgetRungJson[];
}

/** sweep の前後、それぞれの時点の store/recall スナップショット。 */
export interface ArchiveSweepPhaseJson {
  store: ArchiveSweepStoreJson;
  recall: ArchiveSweepRecallJson;
}

/** `Runtime.sweepArchive` の呼び出しそのものの結果（`SweepArchiveResult` をそのまま運ぶ）。 */
export interface ArchiveSweepResultJson {
  /** `MemoryStore.archiveDecayed` が実装されていたか。`false` なら他の欄は常に0/false。 */
  supported: boolean;
  /** この呼び出しに渡した `ArchiveDecayedOptions.limit`。 */
  limit: number;
  archivedCount: number;
  /** `true` なら `limit` 件ちょうど archived にした＝まだ対象が残っている可能性がある。 */
  reachedLimit: boolean;
}

/**
 * `status` で「測ったが値がこうだった」と「そもそも測れなかった」を区別する
 * （`consolidation-json.ts` の `ConsolidationCostRunJson` と同じ形。この bench も
 * `@mnemora/local-embedding` を使うため、同じ「重みを取得できなかった」失敗モードを持つ）。
 */
export type ArchiveSweepCostRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      /** 宣言値ではなく handle の実値（ADR 0088 §4 と同じ規律）。 */
      llmMode: ProviderMode;
      embeddingMode: ProviderMode;
      embeddingSpace: ArchiveSweepEmbeddingSpaceJson;
      probeCount: number;
      haystackSize: number;
      /** テナントの `default_half_life_hours`（sweep 前に実測した実値。裁量の定数ではない）。 */
      halfLifeHours: number;
      budgetLadder: number[];
      recallLimit: number;
      sweep: ArchiveSweepResultJson;
      before: ArchiveSweepPhaseJson;
      after: ArchiveSweepPhaseJson;
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      /** `warmupLocalEmbedding` が返した detail（`WEIGHTS_UNAVAILABLE_PREFIX` を含む）。 */
      detail: string;
    };

// ---------------------------------------------------------------------------
// 純関数の本体
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * `defaultDecayStrategy.floorAt` を1970-01-01T00:00:00.000Z を起点に呼び、
 * 「作成から decay_floor_at までの固定オフセット（ミリ秒）」を導出する。
 *
 * **`packages/core` の減衰式（`strength=1`・既定閾値）を再導出しない**——
 * `defaultDecayStrategy` をそのまま呼ぶことで、閾値やモデルが変わってもこの関数は
 * 追随する（式を書き写すと片方だけ直したときにずれる。`AGENTS.md` と同じ理由）。
 */
export function decayFloorOffsetMs(halfLifeHours: number): number {
  const epoch = new Date(0);
  const floor = defaultDecayStrategy.floorAt({
    recordedAt: epoch,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
  });
  return floor.getTime() - epoch.getTime();
}

/**
 * haystack（filler）を ingest するときに時計を巻き戻す量（ミリ秒）。
 *
 * `decayFloorOffsetMs(halfLifeHours)` だけ過去に戻せば、filler の `decayFloorAt` は
 * ちょうど「実行時の現在時刻」と一致する——境界のブレ（浮動小数点・ミリ秒の丸め）を
 * 吸収するため、さらに `marginHours` だけ余分に戻す。gold/distractor は実時刻で
 * ingest するため、その `decayFloorAt` は現在時刻より `decayFloorOffsetMs` だけ未来にあり、
 * `marginHours` がその余裕を食いつぶすことはない（`marginHours` は数十時間のオーダー、
 * 既定 halfLifeHours=720 なら余裕は約129.66日ある）。
 */
export function fillerBackdateMs(halfLifeHours: number, marginHours: number): number {
  return decayFloorOffsetMs(halfLifeHours) + marginHours * MS_PER_HOUR;
}

/** 単純平均。空配列は 0（呼び出し側は空配列を渡さない前提だが、0除算で NaN を出さない）。 */
function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** `carriedCount / activeCount`。`activeCount === 0` のときは 0。 */
export function computeRecalledActiveShare(carriedCount: number, activeCount: number): number {
  if (activeCount <= 0) {
    return 0;
  }
  return carriedCount / activeCount;
}

/** `buildArchiveSweepProbeJson` への入力。DB/embedding を経由して既に取り終えた値だけを持つ。 */
export interface RawArchiveSweepProbeMeasurement {
  probeId: string;
  /** `recall().memories` の digest だけを取り出したもの。 */
  memoryDigests: readonly string[];
  goldRank: number | null;
  totalInScope: number;
  omittedKinds: readonly string[];
  omittedArchivedCount: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  budgetExceeded: boolean;
}

export function buildArchiveSweepProbeJson(
  raw: RawArchiveSweepProbeMeasurement,
  activeCount: number,
): ArchiveSweepProbeJson {
  return {
    probeId: raw.probeId,
    carriedCount: raw.memoryDigests.length,
    carriedDigestTokens: carriedDigestTokensOf(raw.memoryDigests),
    usageChars: raw.usageChars,
    usageEstimatedTokens: raw.usageEstimatedTokens,
    usageIndexChars: raw.usageIndexChars,
    totalInScope: raw.totalInScope,
    goldRank: raw.goldRank,
    recalledActiveShare: computeRecalledActiveShare(raw.memoryDigests.length, activeCount),
    omittedArchivedCount: raw.omittedArchivedCount,
    omittedKinds: [...raw.omittedKinds],
    budgetExceeded: raw.budgetExceeded,
  };
}

/** `probes[]` の数値欄の平均（`goldRank` は null を除く）。 */
export function buildArchiveSweepMeanJson(
  probes: readonly ArchiveSweepProbeJson[],
): ArchiveSweepMeanJson {
  const goldRanks = meanExcludingNullGoldRank(probes.map((p) => p.goldRank));
  return {
    carriedCount: mean(probes.map((p) => p.carriedCount)),
    carriedDigestTokens: mean(probes.map((p) => p.carriedDigestTokens)),
    usageChars: mean(probes.map((p) => p.usageChars)),
    usageEstimatedTokens: mean(probes.map((p) => p.usageEstimatedTokens)),
    usageIndexChars: mean(probes.map((p) => p.usageIndexChars)),
    totalInScope: mean(probes.map((p) => p.totalInScope)),
    recalledActiveShare: mean(probes.map((p) => p.recalledActiveShare)),
    omittedArchivedCount: mean(probes.map((p) => p.omittedArchivedCount)),
    goldRank: goldRanks.mean,
    goldRankExcludedCount: goldRanks.excludedCount,
  };
}

/** `store` に既に読み終えた active/superseded/archived Memory の content/digest から数える。 */
export interface RawArchiveSweepStoreMeasurement {
  activeContentsAndDigests: readonly { content: string; digest: string }[];
  supersededCount: number;
  archivedCount: number;
  /** active + superseded + archived の content 文字数の合計(呼び出し側が別途合算する)。 */
  allContentChars: number;
}

export function buildArchiveSweepStoreJson(
  raw: RawArchiveSweepStoreMeasurement,
): ArchiveSweepStoreJson {
  const activeContentChars = raw.activeContentsAndDigests.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  const activeDigestChars = raw.activeContentsAndDigests.reduce(
    (sum, m) => sum + m.digest.length,
    0,
  );
  return {
    activeCount: raw.activeContentsAndDigests.length,
    supersededCount: raw.supersededCount,
    archivedCount: raw.archivedCount,
    activeContentChars,
    activeContentTokens: heuristicTokenCounter.count(
      raw.activeContentsAndDigests.map((m) => m.content).join("\n"),
    ).tokens,
    activeDigestChars,
    activeDigestTokens: heuristicTokenCounter.count(
      raw.activeContentsAndDigests.map((m) => m.digest).join("\n"),
    ).tokens,
    allContentChars: raw.allContentChars,
  };
}

export interface BuildArchiveSweepCostRunJsonOptions {
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: ArchiveSweepEmbeddingSpaceJson;
  probeCount: number;
  haystackSize: number;
  halfLifeHours: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  sweep: ArchiveSweepResultJson;
  before: ArchiveSweepPhaseJson;
  after: ArchiveSweepPhaseJson;
  measuredAt: Date;
  commit: string | null;
}

/** トップレベルの JSON を組み立てる（`status: "measured"`）。純関数。 */
export function buildArchiveSweepCostRunJson(
  options: BuildArchiveSweepCostRunJsonOptions,
): Extract<ArchiveSweepCostRunJson, { status: "measured" }> {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace: options.embeddingSpace,
    probeCount: options.probeCount,
    haystackSize: options.haystackSize,
    halfLifeHours: options.halfLifeHours,
    budgetLadder: [...options.budgetLadder],
    recallLimit: options.recallLimit,
    sweep: options.sweep,
    before: options.before,
    after: options.after,
  };
}

/**
 * 重みを取得できなかったときの JSON を組み立てる（`consolidation-json.ts` の
 * `buildWeightsUnavailableConsolidationCostRunJson` と同じ形）。**メトリクスの欄を
 * 一切持たない**——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
 */
export function buildWeightsUnavailableArchiveSweepCostRunJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): ArchiveSweepCostRunJson {
  return {
    schemaVersion: 1,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}

/**
 * `cli.ts` の `runArchiveSweepCostCommand` が立てる終了コード。
 *
 * - `status === "weights_unavailable"`（重みを取得できず、そもそも測れなかった） → 1
 * - `sweep.supported === false`（store が `archiveDecayed` を実装していない。この bench は
 *   `@mnemora/postgres` を使うので実際には起きない想定だが、黙って0件の成功として扱わない） → 1
 * - それ以外 → 0
 */
export function exitCodeForArchiveSweepCostRun(json: ArchiveSweepCostRunJson): 0 | 1 {
  if (json.status === "weights_unavailable") {
    return 1;
  }
  if (!json.sweep.supported) {
    return 1;
  }
  return 0;
}
