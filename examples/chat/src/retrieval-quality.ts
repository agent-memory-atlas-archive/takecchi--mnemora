import type {
  Ctx,
  MemoryStore,
  RecallChannel,
  RecalledMemory,
  Runtime,
  ScoreBreakdown,
} from "@mnemora/core";
import { DEFAULT_RECALL_CHANNELS, RECALL_CHANNELS } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { DrainResult } from "./embed-drain.js";
import type { ProviderMode } from "./providers.js";
import {
  DEFAULT_HAYSTACK_SIZE,
  PROBES,
  buildProbeSetConversation,
  distractorExternalId,
  goldExternalId,
} from "./probe-set.js";
import { resolveExternalId } from "./provenance-trace.js";
import { formatNoApiCallsNotice } from "./usage-meter.js";
import type { UsageMeter } from "./usage-meter.js";

/**
 * probe ごとの順位を測る(PR 本文 (D))。
 *
 * **memory → observation の系譜の辿り方**: 本物の LLM は発話を書き換えて記憶を作る
 * (要約・言い換え)ため、`recall().memories[].digest`/`memoryId` から「どの発話が元に
 * なったか」を**文字列一致では判定できない**。その辿り方は `./provenance-trace.js` の
 * `resolveExternalId` に在る——**`compare.ts` も同じ経路を必要とするようになったため、
 * 共有の部品としてそちらへ降ろした**(ADR 0052)。ここでは互換のため re-export する。
 */
export { resolveExternalId };

// ---------------------------------------------------------------------------
// outbox を干上がるまで処理する(PR 本文「実行時の規律」)
//
// `drainEmbedTicks`/`DrainResult` の実体は `./embed-drain.js` に移した——
// `mnemora-path.ts` の `ingestConversation`(主測定である `compare` 経路)にも
// 同じ罠があったため、共有モジュールへ切り出した(docs/decisions/0021 参照)。
// ここでは import した名前をそのまま re-export し、この関数を
// `./retrieval-quality.js` から import している既存コードとの互換を保つ。
// ---------------------------------------------------------------------------

export { drainEmbedTicks };
export type { DrainResult };

// ---------------------------------------------------------------------------
// スコア内訳(docs/recall.md §7)を、順位と一緒に記録する
//
// **なぜ足すか**: このベンチは順位(goldRank/distractorRank)だけを記録し、
// `recall()` が返した `RecalledMemory.score` を捨てていた。その結果
// [ADR 0019 §7.5](../../../docs/decisions/0019-real-openai-measurement-cost.md) は
// 「なぜ distractor が上に来たか」を**解釈**として書くしかなかった
// (「主語と時制を見ていない」)。北極星の問い3(なぜ選ばれたかを後から説明できるか)を
// 第一級と書いている製品のベンチが、説明を捨てていた。
//
// ここで足すのは**記録と印字だけ**である——閾値・重み・limit・overFetchFactor は
// 一切変えない(ADR 0022 の線: 見栄えの良い数字のために測る条件を選び直さない)。
// ---------------------------------------------------------------------------

/**
 * `ScoreBreakdown` のうち `total` を除いた項。**`total` を含めない**のは、
 * `total` が他の項の積であり、「どの項が順位を決めたか」を問う対象ではないため。
 */
export const SCORE_TERMS = ["similarity", "decay", "tagMatch", "freshness", "strength"] as const;
export type ScoreTerm = (typeof SCORE_TERMS)[number];

/**
 * 返ってきた候補の集合の中で、その項が取った値の幅。
 *
 * **これが順位の説明の本体である。**幅が 0 の項は、その recall の順位付けに
 * 一切寄与していない——「重みが小さい」のではなく、**候補間で差が付いていない**。
 * 幅が最大の項が、順位を実際に決めた項である。
 */
export interface TermSpread {
  term: ScoreTerm;
  /** その項を持っていた候補の件数。`similarity` は ANN 経由の候補にしか存在しない。 */
  presentCount: number;
  /** 項を持つ候補が1件も無ければ null。 */
  min: number | null;
  max: number | null;
  /** `max - min`。項を持つ候補が1件も無ければ null(0 と区別する)。 */
  spread: number | null;
  /**
   * その項を持つ候補が、実際に何通りの値を取ったか(`new Set(values).size`。
   * 浮動小数は厳密比較)。項を持つ候補が0件なら 0。
   *
   * **⚠ `spread`(幅 = `max - min`)とは別の主張である**(ADR 0081 §1.1)。
   * 幅が0(または極小)であることと、候補間で1通りしか値を取らないことは、
   * この文脈では違う主張である——**幅は両端の距離だけを言い、中間に何個の値が
   * 在るかを言わない。**`decay` はこの違いが出る項の実例で、幅は 1e-7 桁(ADR 0109 §4 の実測。
   * **この桁は系の定数ではなく、取り込みから `recall()` までの実時間の関数である**)だが
   * 通り数は候補数ぶんある(= 重みを触れば理論上は動く余地がある)のに対し、
   * `tagMatch`/`strength` は通り数そのものが1であり(= 重みをいくら触っても
   * 順位は1つも動かない)。**「重みが小さい」と「項が動いていない」を区別するには、
   * 幅ではなく通り数が要る。**
   */
  distinctCount: number;
}

/**
 * 返ってきた候補全体について、項ごとの値の幅を出す。
 *
 * **項を持つ候補が0件のときに `spread` を 0 と書かない。**「差が無かった」と
 * 「測る対象が無かった」は別物である(ADR 0008 の「無いには種類がある」の、
 * この文脈への適用)。
 *
 * **`presentCount`/`min`/`max`/`spread` の計算はここで変えていない**——
 * `distinctCount`(ADR 0081 §1.1)を追加で計算するだけである。
 */
export function computeTermSpreads(memories: readonly RecalledMemory[]): TermSpread[] {
  return SCORE_TERMS.map((term) => {
    const values = memories
      .map((memory) => memory.score[term])
      .filter((value): value is number => value !== undefined);
    if (values.length === 0) {
      return { term, presentCount: 0, min: null, max: null, spread: null, distinctCount: 0 };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      term,
      presentCount: values.length,
      min,
      max,
      spread: max - min,
      distinctCount: new Set(values).size,
    };
  });
}

/**
 * `decay` と `freshness` を、同じ候補行の中で1件ずつ厳密比較(`===`)する
 * (ADR 0081 §2 / ADR 0109)。
 *
 * **なぜ「幅が一致すること」では代用できないか**: `termSpreads` の `decay`/`freshness`
 * の幅が同じ値であっても、それは両端(min/max)が一致しているだけであり、
 * **同じ候補行どうしで値が一致していることを含意しない**——間接証拠でしかない。
 * ここでは行ごとの厳密等価を直接数える。
 *
 * **`ScoreBreakdown.decay`/`freshness` はどちらも必須欄(optional ではない)なので、
 * `memories` に1件でも要素があれば、その行は必ず両方の欄を持つ。**⟹ `rows` は
 * 実質 `memories.length` と一致する。それでも名前を「両方の欄を持つ行数」とするのは、
 * 将来どちらかが optional になった場合に、この関数の意図(「測れた行だけを数える」)を
 * 呼び出し側のコードから読み取れるようにするため。
 */
export function computeDecayFreshnessRowwise(
  memories: readonly RecalledMemory[],
): DecayFreshnessRowwise {
  const rows = memories.length;
  let equalRows = 0;
  for (const memory of memories) {
    if (memory.score.decay === memory.score.freshness) {
      equalRows += 1;
    }
  }
  return { rows, equalRows, differentRows: rows - equalRows };
}

/** `computeDecayFreshnessRowwise` の結果(ADR 0109)。 */
export interface DecayFreshnessRowwise {
  /** `decay`/`freshness` の両方を持っていた行数。 */
  rows: number;
  /** そのうち `decay === freshness`(厳密等価)だった行数。 */
  equalRows: number;
  /** そのうち `decay !== freshness` だった行数。 */
  differentRows: number;
}

/** 1件の候補が、この probe においてどの役だったか。複数該当しうる(gold が1位など)。 */
export type ScoredRole = "gold" | "distractor" | "top1";

export interface ProbeScoreDetail {
  /** 該当する役をすべて持つ。gold が1位なら `["gold","top1"]`。 */
  roles: ScoredRole[];
  /** 1始まりの順位。 */
  rank: number;
  digest: string;
  score: ScoreBreakdown;
}

/**
 * gold・distractor・1位の3つについて、スコア内訳を取り出す。
 *
 * **返らなかったものは含めない。**gold が `limit` の外に落ちていれば内訳は存在しない——
 * そこで 0 や「不明」を捏造しない。なぜ返らなかったかは `ProbeOutcome.omittedKinds` の側が答える。
 *
 * `goldRank`/`distractorRank` は `runRetrievalQualityArm` が系譜追跡で決めた順位を
 * そのまま受け取る(この関数自身は externalId を解決しない——純関数に保つため)。
 *
 * **2つの順位を位置引数ではなくオブジェクトで受ける。**どちらも `number | null` なので、
 * 位置で渡すと取り違えても型が通り、**gold と distractor の役が入れ替わったまま
 * 出力される**(この配線は検査が届いていない——`runRetrievalQualityArm` は Runtime と
 * MemoryStore を要求するため単体で呼べない)。**検査で捕まえられないなら、
 * 起こせない形にするほうが強い。**
 *
 * **範囲外の順位を弾く番人は置いていない。**呼び出し側は `memories` の `indexOf` から
 * 順位を作るので、`null` か `1..memories.length` 以外は構造上出てこない。届かない分岐を
 * 「念のため」で置くと、検査できない経路が増えるだけである(ADR 0024 の「実装の無い予約を
 * 残さない」と同じ理由)。**別の `recall()` の順位を混ぜて渡せば添字が外れて例外になるが、
 * それは黙って別の記憶を返すより良い**——壊れているものを壊れていない顔で返さない。
 */
export interface ProbeRanks {
  /** `recall().memories` の中の gold の順位(1始まり)。返っていなければ null。 */
  goldRank: number | null;
  distractorRank: number | null;
}

export function collectScoreDetails(
  memories: readonly RecalledMemory[],
  ranks: ProbeRanks,
): ProbeScoreDetail[] {
  const rolesByRank = new Map<number, ScoredRole[]>();
  const addRole = (rank: number | null, role: ScoredRole): void => {
    if (rank === null) {
      return;
    }
    const roles = rolesByRank.get(rank) ?? [];
    roles.push(role);
    rolesByRank.set(rank, roles);
  };
  addRole(ranks.goldRank, "gold");
  addRole(ranks.distractorRank, "distractor");
  addRole(memories.length > 0 ? 1 : null, "top1");

  return [...rolesByRank.keys()]
    .sort((a, b) => a - b)
    .map((rank) => {
      const memory = memories[rank - 1]!;
      return {
        roles: rolesByRank.get(rank)!,
        rank,
        digest: memory.digest,
        score: memory.score,
      };
    });
}

// ---------------------------------------------------------------------------
// probe ごとの指標
// ---------------------------------------------------------------------------

export interface ProbeOutcome {
  probeId: string;
  lexicalControl: boolean;
  /** `recall().memories` の中の gold の順位(1始まり)。居なければ null。 */
  goldRank: number | null;
  distractorRank: number | null;
  hit1: boolean;
  /** 既定の limit(10件)に残ったか。`memories` は既定で最大10件しか返らないため、
   *  goldRank !== null であることと同値。 */
  hit10: boolean;
  /** 話題は合っているが答えが違う記憶(distractor)が gold より上に来たか。
   *  gold が返らず distractor だけ返った場合も「beats gold」として扱う(最悪のケース)。 */
  distractorBeatsGold: boolean;
  reciprocalRank: number;
  omittedKinds: string[];
  totalInScope: number;
  /** gold / distractor / 1位 のスコア内訳(返らなかったものは含まない)。 */
  scoreDetails: ProbeScoreDetail[];
  /** 返ってきた候補全体で、各項が取った値の幅。順位を実際に決めた項がどれかを示す。 */
  termSpreads: TermSpread[];
  /**
   * この probe で `recall()` が実際に返した候補行数(`result.memories.length`)。
   *
   * **なぜ足すか**(非門ジョブへの可視化。ADR 0108): `SCORE_TERMS` は `lexicalMatch` を
   * 含まない(第6の項として掛けない、という ADR 0084 §5 の決定の反映であって、この欄が
   * 無い理由ではない)。⟹ 語彙チャンネルが**そもそも1行も通っていないのか**、**通っては
   * いるが値が無いのか**を、`termSpreads` だけでは区別できない。この欄と
   * `lexicalMatchRows` を並べることで、その区別を行数として残す。
   */
  recalledRows: number;
  /**
   * そのうち `score.lexicalMatch` 欄を持っていた行数。
   *
   * **`examples/chat` のベンチは `channels` を渡していない**(既定
   * `DEFAULT_RECALL_CHANNELS` = `["ann"]`)ため、現状はどの probe でも 0 のまま推移する
   * ——これは欠陥ではなく、「語彙チャンネルが配線されていない」という構成そのものの
   * 反映である(ADR 0108)。
   */
  lexicalMatchRows: number;
  /**
   * この probe において、`decay` と `freshness` が行ごとに厳密等価だったか(ADR 0109)。
   *
   * **なぜ足すか**: ADR 0081 §2 は「`freshness` は `decay` の行ごと厳密な複製である」を
   * 一時的な計装で測ったが、その計装は捨てられ(§6.1)、再現するには足し直す必要が
   * あった。ここで恒久化する。
   */
  decayFreshnessRowwise: DecayFreshnessRowwise;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// 実行ごとに一意な tenantId を組む(ADR 0068)
//
// **背景**: `cli.ts` の `runRetrieval` は arm ごとに固定の `tenantId`
// (`retrieval-quality-arm-a` 等)を使っていた。DB をリセットしないため、2回目の
// 実行は `observe()` の externalId 冪等性に当たって新規 observation を1件も作らず、
// `ingest` の欄が「1回で足りた」という**逆の結論**を印字する(1回目は実際に測って
// 「足りなかった」、2回目は測っていないのに同じ判定式が `false` を返す)。
// 順位(goldRank 等)は DB に前回の記憶が残っているため正しく出続けるので、
// 数字を見ていても気付けない——`ingest` の欄だけが嘘をつく。
//
// **直し方はテナントを毎回変えること。**冪等性そのもの(externalId の重複排除)は
// 製品として正しい挙動であり、崩さない。崩すべきは「同じテナントで2回測ってしまう」
// ベンチ側の呼び出し方である。
//
// **引き受ける負債**: 実行のたびに DB へテナントが増える(memories/observations/
// outbox 行が積み上がり、掃除しない)。掃除しない理由と実測件数は ADR 0068 に書く。
// ---------------------------------------------------------------------------

let runTokenCounter = 0;

/**
 * 実行ごとに一意な token。**2回呼べば必ず違う値を返す**——`Date.now()` 単体だと
 * 同一ミリ秒内の2連続呼び出しで衝突しうるため、プロセス内カウンタを足して
 * 「必ず違う」を実装で保証する(クロックの分解能に依存しない)。
 */
export function newRunToken(): string {
  runTokenCounter += 1;
  return `${Date.now().toString(36)}-${runTokenCounter}`;
}

/**
 * arm の tenantId を組む。**同じ `runToken` なら同じ、違う `runToken` なら必ず違う**——
 * `armKey` は arm を区別するための安定した鍵(`"a"`/`"b"`/`"c"` 等)であり、
 * `armLabel`(画面の見出し文言)とは独立に保つ(見出し文言を変えても tenantId が
 * 変わらないようにするため)。
 */
export function buildArmTenantId(armKey: string, runToken: string): string {
  return `retrieval-quality-arm-${armKey}-${runToken}`;
}

// ---------------------------------------------------------------------------
// 語彙チャンネルを通す構成を選べるようにする(ADR 0148、Issue #179)
//
// **既定は今日までと1バイトも変えない**——`MNEMORA_BENCH_CHANNELS` を指定しない
// 呼び出しは `parseBenchChannels` が `undefined` を返し、`RunRetrievalQualityArmOptions
// .channels` を省略した呼び出しと同じ挙動になる(`runRetrievalQualityArm` は
// `options.channels` が `undefined` のとき `recall()` に `channels` を渡さず、
// `packages/core` 自身の既定 `DEFAULT_RECALL_CHANNELS` = `["ann"]` に委ねる)。
// ---------------------------------------------------------------------------

/**
 * `MNEMORA_BENCH_CHANNELS` の値(生の env 文字列)を読み、`recall()` へ渡す
 * `channels` を決める。**純関数**——`consolidation-cost-options.ts` の
 * `parseBudgetLadder` と同じ形で、env オブジェクトそのものではなく値1つを受け取る。
 *
 * **未指定・空文字なら `undefined`**(=呼び出し側は `channels` を渡さず、既定
 * `["ann"]` のまま)。カンマ区切りで `RECALL_CHANNELS`(`packages/core` の唯一の
 * 出所)の値だけを受け付ける——値の一覧をここに書き写さない(`RecallQuery.channels`
 * の doc が「値の一覧を散文で書かない」と定める規律と同じ)。未知の値は
 * `parseModeOverride`(`providers.ts`)と同じ形で例外にする——黙って無視すると、
 * typo が「既定のまま静かに ann だけで走った」に化ける。
 */
export function parseBenchChannels(
  value: string | undefined,
): readonly RecallChannel[] | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const values = value.split(",").map((v) => v.trim());
  for (const v of values) {
    if (!(RECALL_CHANNELS as readonly string[]).includes(v)) {
      throw new Error(
        `MNEMORA_BENCH_CHANNELS の要素は ${RECALL_CHANNELS.map((c) => `"${c}"`).join(" / ")} の` +
          `いずれかであること(カンマ区切り)。渡された値: "${value}"`,
      );
    }
  }
  return values as RecallChannel[];
}

// ---------------------------------------------------------------------------
// arm 単位の実行
// ---------------------------------------------------------------------------

export interface RunRetrievalQualityArmOptions {
  armLabel: string;
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `llmMode`/`embeddingMode` のどちらかが `"openai"` のときに渡す。 */
  usageMeter?: UsageMeter;
  /** 既定は `DEFAULT_HAYSTACK_SIZE`(`DEFAULT_TICK_LIMIT`=50 を超える件数)。 */
  haystackSize?: number;
  /**
   * `recall()` に渡す `channels`(ADR 0148、Issue #179)。
   *
   * **省略時は `recall()` 自身の既定(`DEFAULT_RECALL_CHANNELS` = `["ann"]`)のまま**
   * ——この欄を渡さない既存の呼び出しは1バイトも挙動が変わらない(`cli.ts` の
   * `runRetrieval()` は既定でこの欄を渡さない)。呼び出し側が明示的に
   * `["ann", "lexical"]` 等を渡したときだけ、語彙チャンネルを通る構成に切り替わる。
   */
  channels?: readonly RecallChannel[];
}

/**
 * observe() が返した `ObserveResult.extraction` の内訳(ADR 0068)。
 *
 * **なぜ数えるか**: `handleExtractableObservation`(`packages/core/src/runtime.ts`)は、
 * 冪等な再送(`created === false`)のとき `extraction: "skipped"` を返す——「今回は
 * 何も取り込んでいない」という信号そのものである。それを `for (const utterance of
 * utterances) { await options.runtime.observe(...) }` が丸ごと捨てていたのが、
 * この ADR が塞ぐ欠陥の現物(ADR 0033 が塞いだのと同じ形——返り値の説明を捨てる)。
 */
export interface ExtractionOutcomeCounts {
  ok: number;
  skipped: number;
  llmFailedWholeObservation: number;
}

/**
 * この run が実際に ingest を測ったか(ADR 0008「無いには種類がある」の適用)。
 *
 * - `"measured"`: 全 utterance が新規 observation だった。`ingest` の数字はこの run のもの。
 * - `"replayed"`: 新規が0件だった(＝このテナントは既に取り込み済み)。`ingest` の数字は
 *   **この run のものではない**——前回以前に測った値がたまたま DB に残っているだけ。
 * - `"partial"`: 新規と冪等な再送が混ざっていた。`drain` の数字は新規分だけを反映する。
 *
 * **`boolean` に潰さない。**「測った/測っていない」の2値では `"partial"` を表現できず、
 * 表現しようとすると結局どちらかへ寄せて嘘になる。
 */
export type IngestMeasurement = "measured" | "replayed" | "partial";

function classifyIngestMeasurement(counts: ExtractionOutcomeCounts): IngestMeasurement {
  const created = counts.ok + counts.llmFailedWholeObservation;
  if (counts.skipped === 0) {
    return "measured";
  }
  return created === 0 ? "replayed" : "partial";
}

export interface ArmIngestSummary {
  observationCount: number;
  drain: DrainResult;
  /** observe() の `extraction` を捨てずに集計したもの。 */
  extractionCounts: ExtractionOutcomeCounts;
  /** この run が ingest を実際に測ったか。 */
  measurement: IngestMeasurement;
  /**
   * 既定の `tick()` を1回だけ呼ぶ実装(`ingestConversation`)だったら、
   * この arm では止まっていたはずか。
   *
   * **`measurement === "replayed"` のときは `null`。**このとき `drain` は
   * 「今回 claim できた embed ジョブが0件だった」という空の測定であり、そこから
   * 「1回で足りた」(`false`)を導くのは、**測っていないことを「足りた」と言い換える
   * 誤りそのもの**(本 ADR の背景)。`boolean | null` にして、「測っていない」と
   * 「足りた」が同じ顔にならないようにする。
   */
  singleTickWouldHaveStalled: boolean | null;
}

export interface ArmReport {
  armLabel: string;
  tenantId: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  ingest: ArmIngestSummary;
  probes: ProbeOutcome[];
  mrrOverall: number;
  mrrLexicalControl: number;
  mrrNonLexical: number;
  /** usage-meter のレポート、または擬似 provider の場合の明示的な注記。 */
  usageReport: string;
  /**
   * この arm が実際に `recall()` へ渡した(または渡さず既定へ委ねた)チャンネル
   * (ADR 0148、Issue #179)。**数字と条件を同じオブジェクトから離さない**という
   * ADR 0088 §4 の規律の適用——`options.channels` を省略した呼び出しでも、
   * ここには実際に使われた既定値(`DEFAULT_RECALL_CHANNELS`)がそのまま入る。
   */
  channels: readonly RecallChannel[];
}

/**
 * 1つの provider の組み合わせ(arm)について、probe set を ingest し、
 * probe ごとに `recall()` を1回投げて順位を測る。
 *
 * **パラメータは既定のまま変えない**(PR 本文「実行時の規律」)——`recall()` には
 * `text` 以外を渡さない。閾値・limit・overFetchFactor は `packages/core` の既定値を
 * そのまま使う。
 */
export async function runRetrievalQualityArm(
  options: RunRetrievalQualityArmOptions,
): Promise<ArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const utterances = buildProbeSetConversation(options.haystackSize ?? DEFAULT_HAYSTACK_SIZE);

  // **`ObserveResult` を捨てない**(本 ADR の主題)。`extraction` の内訳を数えて、
  // この run が実際に何を取り込んだか(measurement)を後で判定する材料にする。
  const extractionCounts: ExtractionOutcomeCounts = {
    ok: 0,
    skipped: 0,
    llmFailedWholeObservation: 0,
  };
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    switch (observed.extraction) {
      case "ok":
        extractionCounts.ok += 1;
        break;
      case "skipped":
        extractionCounts.skipped += 1;
        break;
      case "llm_failed_whole_observation":
        extractionCounts.llmFailedWholeObservation += 1;
        break;
    }
  }
  const measurement = classifyIngestMeasurement(extractionCounts);

  const drain = await drainEmbedTicks(options.runtime, ctx);

  const probes: ProbeOutcome[] = [];
  for (const probe of PROBES) {
    const result = await options.runtime.recall(ctx, {
      text: probe.query,
      ...(options.channels !== undefined ? { channels: [...options.channels] } : {}),
    });
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndex = resolvedExternalIds.indexOf(goldExternalId(probe.id));
    const distractorIndex = resolvedExternalIds.indexOf(distractorExternalId(probe.id));
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;
    const distractorBeatsGold =
      distractorRank !== null && (goldRank === null || distractorRank < goldRank);

    probes.push({
      probeId: probe.id,
      lexicalControl: probe.lexicalControl === true,
      goldRank,
      distractorRank,
      hit1: goldRank === 1,
      hit10: goldRank !== null,
      distractorBeatsGold,
      reciprocalRank: goldRank !== null ? 1 / goldRank : 0,
      omittedKinds: result.omitted.map((o) => o.kind),
      totalInScope: result.index.totalInScope,
      scoreDetails: collectScoreDetails(result.memories, { goldRank, distractorRank }),
      termSpreads: computeTermSpreads(result.memories),
      recalledRows: result.memories.length,
      lexicalMatchRows: result.memories.filter((m) => m.score.lexicalMatch !== undefined).length,
      decayFreshnessRowwise: computeDecayFreshnessRowwise(result.memories),
    });
  }

  const lexicalProbes = probes.filter((p) => p.lexicalControl);
  const nonLexicalProbes = probes.filter((p) => !p.lexicalControl);

  return {
    armLabel: options.armLabel,
    tenantId: options.tenantId,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    ingest: {
      observationCount: utterances.length,
      drain,
      extractionCounts,
      measurement,
      singleTickWouldHaveStalled:
        measurement === "replayed" ? null : drain.firstTickProcessed < drain.totalProcessed,
    },
    probes,
    mrrOverall: average(probes.map((p) => p.reciprocalRank)),
    mrrLexicalControl: average(lexicalProbes.map((p) => p.reciprocalRank)),
    mrrNonLexical: average(nonLexicalProbes.map((p) => p.reciprocalRank)),
    usageReport: options.usageMeter
      ? options.usageMeter.formatReport()
      : formatNoApiCallsNotice({
          llmMode: options.llmMode,
          embeddingMode: options.embeddingMode,
        }),
    channels: options.channels ?? DEFAULT_RECALL_CHANNELS,
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function formatRank(rank: number | null): string {
  return rank === null ? "(無し)" : String(rank);
}

/**
 * 小さい値を 0.000000 に潰さない。幅が 1e-4 未満のときに指数表記へ倒すのは、
 * 「その項は動いていない」を「その項は 0 だった」と読み違えさせないため——
 * decay の幅は実測で 10^-5 の桁に出る（0 ではないが順位を動かせない）。
 */
export function formatScoreValue(value: number): string {
  if (value !== 0 && Math.abs(value) < 1e-4) {
    return value.toExponential(3);
  }
  return value.toFixed(6);
}

/**
 * 丸めない整形(ADR 0081 §6.2 / ADR 0109)。
 *
 * **`formatScoreValue`(6桁丸め、または `1e-4` 未満は指数表記)はここでは変えない**
 * ——既存の印字(`formatTermSpreads`/`formatScoreDetail`)はそのまま使い続ける。
 * こちらは新設で、`String(value)` がそのまま返す、double を往復可能な最短の
 * 10進表現を使う。
 *
 * **なぜ要るか**: ADR 0081 §6.2 は、`formatScoreValue` を `decay`/`freshness` の
 * 生値の印字に流用したところ、両者とも `1.000000` に丸められ、「`distinctCount=10`
 * なのに `min=max=1.000000`」という自己矛盾した表示になったことを記録している
 * (`decay`/`freshness` は 1 からの差が 1e-7〜1e-8 桁であり、6桁丸めでは差が消える。
 * 実測は ADR 0109 §4)。
 * `formatTermDistinctCounts` はこの関数を使うことで、その欠陥を再現しない。
 */
export function formatExactScoreValue(value: number): string {
  return String(value);
}

/** 項ごとの値の幅を1行にする。幅が最大の項が、その recall の順位を決めた項である。 */
export function formatTermSpreads(spreads: readonly TermSpread[]): string {
  return spreads
    .map((s) =>
      s.spread === null
        ? `${s.term}=(この項を持つ候補が無い)`
        : `${s.term}=${formatScoreValue(s.spread)}`,
    )
    .join(" ");
}

/**
 * 項ごとの「何通りか」を1行にする(ADR 0081 §1.1 / ADR 0109)。
 *
 * **既存の `formatTermSpreads`(幅)とは別の行として足す。**両者は別の主張であり
 * (`TermSpread.distinctCount` の doc 参照)、既存の行の文面は1文字も変えない。
 * min/max は丸めない(`formatExactScoreValue`)——`decay`/`freshness` の 1e-7 桁の
 * 差を、6桁丸めの `formatScoreValue` で消さないため(ADR 0081 §6.2 / ADR 0109 §4)。
 */
export function formatTermDistinctCounts(spreads: readonly TermSpread[]): string {
  return spreads
    .map((s) =>
      s.min === null || s.max === null
        ? `${s.term}=(この項を持つ候補が無い)`
        : `${s.term}=${s.distinctCount}通り[${formatExactScoreValue(s.min)}..${formatExactScoreValue(s.max)}]`,
    )
    .join(" ");
}

/** `decay`/`freshness` の行ごと厳密等価を1行にする(ADR 0081 §2 / ADR 0109)。 */
export function formatDecayFreshnessRowwise(rowwise: DecayFreshnessRowwise): string {
  const suffix = rowwise.differentRows > 0 ? `(違う行が${rowwise.differentRows}件ある)` : "";
  return `${rowwise.equalRows}/${rowwise.rows}行${suffix}`;
}

/** gold/distractor/1位のスコア内訳を、掛け算の形のまま1行ずつ出す。 */
export function formatScoreDetail(detail: ProbeScoreDetail): string {
  const s = detail.score;
  const similarity =
    s.similarity === undefined ? "(ANN 経由でない)" : formatScoreValue(s.similarity);
  return (
    `#${detail.rank} [${detail.roles.join(",")}] total=${formatScoreValue(s.total)} = ` +
    `similarity ${similarity} × decay ${formatScoreValue(s.decay)} × ` +
    `tagMatch ${formatScoreValue(s.tagMatch)} × freshness ${formatScoreValue(s.freshness)} × ` +
    `strength ${formatScoreValue(s.strength)}  ${detail.digest}`
  );
}

// ---------------------------------------------------------------------------
// arm の見出し数字を1箇所で作る(ADR 0068 ②)
//
// **なぜ足すか**: `formatArmSummaryTable` は MRR しか持っていなかった。`hit@1`/
// `hit@10` を知るには `formatProbeComparisonTable`(arm ごとに5列 × 3 arm = 17列の
// 横長の表)へ行って行を横に数える必要があり、そこで arm を跨いで数字を拾える隙間が
// できていた——実際に「arm B の MRR」と「arm C の hit@10」を束ねて読み違えた実例がある。
//
// **引数は `ArmReport` 1つだけ。**複数の arm を受け取らないので、構造上、別の arm の
// 数字が混ざりようがない。
// ---------------------------------------------------------------------------

export interface ArmHeadline {
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  /** `report.probes[].recalledRows` の総和(この arm が実際に返した候補行の総数)。 */
  recalledRows: number;
  /** `report.probes[].lexicalMatchRows` の総和(語彙チャンネルが引き当てた行の総数)。 */
  lexicalMatchRows: number;
  /** 項ごとの、arm 全体での「何通りか」の集計(ADR 0081 §1.1 / ADR 0109)。 */
  termDistinct: ArmTermDistinct[];
  /** `report.probes[].decayFreshnessRowwise.equalRows` の総和。 */
  decayFreshnessEqualRows: number;
  /** `report.probes[].decayFreshnessRowwise.differentRows` の総和。 */
  decayFreshnessDifferentRows: number;
}

/**
 * 項ごとに、arm 全体での「何通りか」を集計する(ADR 0109)。
 *
 * **`probes[].termSpreads` からのみ導く。**別の集計にすると、この関数と
 * `formatArmDetail` の印字が食い違いうる(ADR 0068 ②と同じ理由)。
 */
export interface ArmTermDistinct {
  term: ScoreTerm;
  /** arm 全体で、その欄を持っていた行数(`presentCount` の probe 間の総和)。 */
  presentRows: number;
  /** probe ごとの `distinctCount` の最小。 */
  minDistinctPerProbe: number;
  /**
   * probe ごとの `distinctCount` の最大。**これが 1 なら、arm 内のどの probe でも
   * この項は候補間で1通りしか値を取っていない**(= 重みを触っても順位は動かない。
   * ADR 0081 §1)。
   */
  maxDistinctPerProbe: number;
  /** arm 全体の最小値(丸めない生値)。項を持つ候補がどの probe にも無ければ null。 */
  min: number | null;
  max: number | null;
}

function computeArmTermDistinct(probes: readonly ProbeOutcome[]): ArmTermDistinct[] {
  return SCORE_TERMS.map((term) => {
    let presentRows = 0;
    // `null` は「まだ1件も見ていない」——先頭の probe がたまたまこの項を
    // 持たない(`termSpreads` にこの項の要素そのものが無い)場合でも、
    // 見つかった最初の1件を基準に min/max を初期化できるようにする
    // (probe の並び順に依存させない)。
    let minDistinctPerProbe: number | null = null;
    let maxDistinctPerProbe: number | null = null;
    let min: number | null = null;
    let max: number | null = null;
    for (const probe of probes) {
      const spread = probe.termSpreads.find((s) => s.term === term);
      if (!spread) {
        continue;
      }
      presentRows += spread.presentCount;
      minDistinctPerProbe =
        minDistinctPerProbe === null
          ? spread.distinctCount
          : Math.min(minDistinctPerProbe, spread.distinctCount);
      maxDistinctPerProbe =
        maxDistinctPerProbe === null
          ? spread.distinctCount
          : Math.max(maxDistinctPerProbe, spread.distinctCount);
      if (spread.min !== null) {
        min = min === null ? spread.min : Math.min(min, spread.min);
      }
      if (spread.max !== null) {
        max = max === null ? spread.max : Math.max(max, spread.max);
      }
    }
    return {
      term,
      presentRows,
      minDistinctPerProbe: minDistinctPerProbe ?? 0,
      maxDistinctPerProbe: maxDistinctPerProbe ?? 0,
      min,
      max,
    };
  });
}

/** 1つの arm の見出し数字。`report.probes` からのみ導く。 */
export function armHeadline(report: ArmReport): ArmHeadline {
  return {
    mrrOverall: report.mrrOverall,
    hit1Count: report.probes.filter((p) => p.hit1).length,
    hit10Count: report.probes.filter((p) => p.hit10).length,
    probeCount: report.probes.length,
    recalledRows: report.probes.reduce((sum, p) => sum + p.recalledRows, 0),
    lexicalMatchRows: report.probes.reduce((sum, p) => sum + p.lexicalMatchRows, 0),
    termDistinct: computeArmTermDistinct(report.probes),
    decayFreshnessEqualRows: report.probes.reduce(
      (sum, p) => sum + p.decayFreshnessRowwise.equalRows,
      0,
    ),
    decayFreshnessDifferentRows: report.probes.reduce(
      (sum, p) => sum + p.decayFreshnessRowwise.differentRows,
      0,
    ),
  };
}

/** `4/7` のような `n/総数` の形。 */
function formatFraction(count: number, total: number): string {
  return `${count}/${total}`;
}

/** arm ごとの詳細(probe 単位の内訳・ingest の内訳・usage レポート)。 */
export function formatArmDetail(report: ArmReport): string {
  const lines: string[] = [];
  lines.push(`=== arm ${report.armLabel}(tenant=${report.tenantId}) ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(`channels: [${report.channels.join(", ")}]`);
  lines.push(
    `ingest: observations=${report.ingest.observationCount} ` +
      `ticks=${report.ingest.drain.ticks} ` +
      `firstTickProcessed=${report.ingest.drain.firstTickProcessed} ` +
      `totalProcessed=${report.ingest.drain.totalProcessed} ` +
      `totalFailed=${report.ingest.drain.totalFailed} ` +
      `measurement=${report.ingest.measurement}`,
  );
  // **測っていない(`"replayed"`)ときは、測っていないと印字する**——これが本 ADR の
  // 核心。かつてはここが `singleTickWouldHaveStalled` を単純な `? :` で読んでおり、
  // 「測っていない」が `false`(足りた)と同じ文面に潰れていた。
  if (report.ingest.measurement === "replayed") {
    lines.push(
      "  (このテナントは既に取り込み済みで、ingest の数字は今回の run のものではない" +
        "——1回で足りたかどうかは測っていない)",
    );
  } else {
    lines.push(
      report.ingest.singleTickWouldHaveStalled === true
        ? "  ⚠ 既定の tick() を1回だけ呼ぶ実装だったら、この arm では " +
            `${report.ingest.drain.totalProcessed - report.ingest.drain.firstTickProcessed} 件が` +
            "埋め込まれないまま残っていたはず(背景2)。"
        : "  (この arm では既定の tick() 1回で全件処理できる件数だった)",
    );
    if (report.ingest.measurement === "partial") {
      lines.push(
        "  ⚠ 一部の observation は冪等な再送だった——上の ingest の数字は新規分だけを反映する。",
      );
    }
  }
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}${p.lexicalControl ? "[lexicalControl]" : ""}: ` +
        `goldRank=${formatRank(p.goldRank)} hit@1=${p.hit1} hit@10=${p.hit10} ` +
        `distractorRank=${formatRank(p.distractorRank)} distractorBeatsGold=${p.distractorBeatsGold} ` +
        `omitted=[${p.omittedKinds.join(",")}] totalInScope=${p.totalInScope}`,
    );
    lines.push(`      項ごとの値の幅(返った候補全体): ${formatTermSpreads(p.termSpreads)}`);
    lines.push(
      `      項ごとの何通りか(返った候補全体): ${formatTermDistinctCounts(p.termSpreads)}`,
    );
    lines.push(
      `      decay===freshness(行ごと厳密等価): ${formatDecayFreshnessRowwise(p.decayFreshnessRowwise)}`,
    );
    for (const detail of p.scoreDetails) {
      lines.push(`      ${formatScoreDetail(detail)}`);
    }
  }
  // **`armHeadline()` から作る(ADR 0068 ②)。**`formatArmSummaryTable` の同じ数字と
  // 別々に計算すると、2箇所が食い違うことがあり得る(そして実際に読み違いが起きた)。
  // 同じ関数から作ることで、構造上食い違いようがなくする。
  const headline = armHeadline(report);
  lines.push(
    `MRR: 全体=${headline.mrrOverall.toFixed(3)} ` +
      `lexicalControl=${report.mrrLexicalControl.toFixed(3)} ` +
      `非語彙=${report.mrrNonLexical.toFixed(3)} ` +
      `hit@1=${formatFraction(headline.hit1Count, headline.probeCount)} ` +
      `hit@10=${formatFraction(headline.hit10Count, headline.probeCount)}`,
  );
  lines.push(report.usageReport);
  return lines.join("\n");
}

/** probe ごとに、3 arm を並べて goldRank/distractorRank を比較する表。 */
export function formatProbeComparisonTable(reports: ArmReport[]): string {
  const header = [
    "probe",
    "lexical",
    ...reports.flatMap((r) => [
      `${r.armLabel}:goldRank`,
      `${r.armLabel}:hit@1`,
      `${r.armLabel}:hit@10`,
      `${r.armLabel}:distractorRank`,
      `${r.armLabel}:distractorBeatsGold`,
    ]),
  ];
  const sep = header.map(() => "---");
  const probeIds = reports[0]?.probes.map((p) => p.probeId) ?? [];
  const rows = probeIds.map((probeId) => {
    const first = reports[0]?.probes.find((p) => p.probeId === probeId);
    const cells = [probeId, String(first?.lexicalControl ?? false)];
    for (const report of reports) {
      const p = report.probes.find((x) => x.probeId === probeId);
      cells.push(
        p ? formatRank(p.goldRank) : "-",
        p ? String(p.hit1) : "-",
        p ? String(p.hit10) : "-",
        p ? formatRank(p.distractorRank) : "-",
        p ? String(p.distractorBeatsGold) : "-",
      );
    }
    return cells;
  });
  return [
    `| ${header.join(" | ")} |`,
    `|${sep.join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/**
 * arm ごとの ingest・MRR・hit@1・hit@10 のまとめ表(ADR 0068 ②)。
 *
 * **`hit@1`/`hit@10` をここに足したのは、arm の見出し数字を知るために
 * `formatProbeComparisonTable`(横長・arm を跨いで数える必要がある表)へ行く理由を
 * 無くすため。**MRR と同じ行に並べる——別の表を経由すれば、その分だけ別の arm の
 * 数字を拾い間違える隙間が増える。
 */
export function formatArmSummaryTable(reports: ArmReport[]): string {
  const header =
    "| arm | llmMode | embeddingMode | observations | ticks | 初回tick処理数 | 合計処理数 | " +
    "ingest計測 | 既定tick1回なら止まっていたか | MRR(全体) | MRR(lexicalControl) | " +
    "MRR(非語彙) | hit@1 | hit@10 |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = reports.map((r) => {
    // `singleTickWouldHaveStalled` は測っていないとき `null`——それを "いいえ"(足りた)
    // に潰すと、この ADR が塞いだはずの欠陥がこの表に戻ってきてしまう。
    const stalled =
      r.ingest.singleTickWouldHaveStalled === null
        ? "(測っていない)"
        : r.ingest.singleTickWouldHaveStalled
          ? "はい"
          : "いいえ";
    const headline = armHeadline(r);
    return (
      `| ${r.armLabel} | ${r.llmMode} | ${r.embeddingMode} | ${r.ingest.observationCount} | ` +
      `${r.ingest.drain.ticks} | ${r.ingest.drain.firstTickProcessed} | ` +
      `${r.ingest.drain.totalProcessed} | ${r.ingest.measurement} | ${stalled} | ` +
      `${headline.mrrOverall.toFixed(3)} | ${r.mrrLexicalControl.toFixed(3)} | ` +
      `${r.mrrNonLexical.toFixed(3)} | ${formatFraction(headline.hit1Count, headline.probeCount)} | ` +
      `${formatFraction(headline.hit10Count, headline.probeCount)} |`
    );
  });
  return [header, sep, ...rows].join("\n");
}
