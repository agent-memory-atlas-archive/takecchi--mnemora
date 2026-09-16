import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorFilter, VectorStore, VectorHit } from "./interfaces/vector-store.js";
import type { LexicalStore, LexicalHit } from "./interfaces/lexical-store.js";
import type { DecayClock, TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import {
  DEFAULT_DECAY_CLOCK,
  readActivitySeq,
  readDecayClock,
} from "./interfaces/tenant-settings-store.js";
import type { MemoryId } from "./ids.js";
import { NOT_INDEXED_REASONS } from "./recall.js";
import type { Memory } from "./memory.js";
import {
  ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
  DEFAULT_ASSOCIATION_ANCHOR_COUNT,
  DEFAULT_ASSOCIATION_MIN_SIMILARITY,
  DEFAULT_DIGEST_BAND_LIMIT,
  DEFAULT_OVER_FETCH_FACTOR,
  DEFAULT_RECALL_CHANNELS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SCORE_THRESHOLD,
  LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
  DIGEST_BAND_MAX_CHARS,
  DIGEST_BAND_MAX_ENTRY_CHARS,
  FILTERED_CONDITION_SCOPE_RELATION,
  RecallQuerySchema,
} from "./recall.js";
import { packDigestBand } from "./digest-band.js";
import type {
  CountKind,
  IndexBand,
  Omission,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  RecalledMemory,
  ScoreBreakdown,
  StageTrace,
} from "./recall.js";
import { defaultScoringStrategy } from "./strategies/scoring.js";
import { decideAnnTruncation } from "./ann-truncation.js";
import {
  DEFAULT_RECALL_OUTPUT_VALIDATION,
  validateRecallOutput,
} from "./recall-output-validation.js";
import type { RecallOutputValidationMode } from "./recall-output-validation.js";

/**
 * `recall()` の実装（roadmap.md 段階4「想起」・段階5「説明」）。
 *
 * docs/recall.md §2 の7段パイプラインをそのまま実装する。**各段は「なぜ落としたか」を
 * Omission の形にして次の段へ渡し、パイプラインの最後に集計し直さない**（同§2 の契約）。
 * この関数の中の各ステップが、その契約を守る単位である——`omitted` に何かを push したら、
 * それ以降の段はその判断を覆さない。
 *
 * 候補生成（段1）は **`RecallQuery.channels` が指すチャンネルを並行して走らせる**
 * （[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)、Issue #106）。
 * **走らせられるチャンネルの唯一の出所は `RECALL_CHANNELS`（`recall.ts`）である**——
 * ここに散文で数え直さない（ADR 0082 が `TICK_SUPPORTED_JOB_KINDS` について引いた線）。
 *
 * **⚠ 既定は `DEFAULT_RECALL_CHANNELS`（= ANN 1本）であり、ADR 0084 以前と同じである。**
 * `channels` を渡さない呼び出しは、候補も順位も `explain` も1バイト変わらない。
 *
 * **「タグ一致・直近取得」は、いまも実装していない。**docs/recall.md §2 が一般形として
 * 触れているが、ADR 0084 が足したのは語彙チャンネル1本だけである。タグはこれまで通り
 * スコアリング（段2の加点要素、`defaultScoringStrategy`）としてのみ参加する。
 */

export interface RecallRuntimeDeps {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  /**
   * [ADR 0165](../../docs/decisions/0165-decay-activity-clock.md): 忘却ゲート（段1・
   * 後置フィルタ）と段2の再スコアが、そのテナントの `decay_clock`・活動時計の「いま」
   * （`activity_seq`）を読むために使う。`Runtime`（`runtime.ts`）は既に
   * `RuntimeDeps.tenantSettingsStore`（`getDefaultHalfLifeHours` 用に必須）を持っており、
   * `recall` の配線（`runtime.ts` の `recall` 関数）がそれをここへそのまま渡す。
   *
   * **省略可能**（ADR 0165 決めたこと13）。`createRecallRuntime` を直接呼ぶ外部の
   * 呼び出し側を壊さないため——省略すると `decay_clock` は `'wall'` 固定として動く
   * （＝本 ADR 以前とまったく同じ挙動）。
   */
  tenantSettingsStore?: TenantSettingsStore;
  /**
   * 語彙チャンネル（ADR 0084）。**省略可能**——語彙チャンネルを無効にしたまま
   * mnemora は成立する（北極星の問い2）。
   *
   * **🔴 省略したまま `channels` に `"lexical"` を渡すと `recall()` は投げる。**
   * 黙って0件にしない理由は `RecallQuery.channels` の doc に書いてある。
   */
  lexicalStore?: LexicalStore;
  embeddingProvider: EmbeddingProvider;
  clock: Clock;
  tokenCounter: TokenCounter;
  /**
   * `recall()` の戻り値を zod で検証するときの倒れ方（Issue #131、ADR 0098）。
   * 省略時は {@link DEFAULT_RECALL_OUTPUT_VALIDATION}（`"report"`）——既定では投げない。
   */
  outputValidation?: RecallOutputValidationMode;
}

type ScoredCandidate = {
  memory: Memory;
  /**
   * **この候補を候補集合へ入れた最初のチャンネル。**
   *
   * **⚠ 「このチャンネルだけが見つけた」ではない。**ANN と語彙の両方が同じ記憶を
   * 引き当てた場合、ここは `"ann"` になる（ANN の窓に入っていたため）。
   * **語彙チャンネルも当てたかどうかは `score.lexicalMatch` の有無が名乗る**——
   * 2つを併せて読むと、どのチャンネルの集合に入っていたかが一意に決まる
   * （ADR 0084 §6）。単一の値でチャンネルの集合を表そうとしないこと。
   */
  retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
  companionOf?: MemoryId;
  /** `retrievedVia: "association"` のときだけ在る。どのアンカーから連想したか（ADR 0151）。 */
  associationOf?: MemoryId;
  score: ScoreBreakdown;
};

/**
 * 段2（再スコア）の並び順。`score.total` 降順が主キーで、**同点のときのタイブレークを
 * 明示する**（Issue #339 / ADR 0170）。
 *
 * **なぜ `packages/core` 自身がタイブレークを持つか**: `Array.prototype.sort` は
 * 安定（ES2019+）なので、これが無ければ同点候補は adapter が返した順序をそのまま
 * 保つ。`PostgresVectorStore.search()` は距離 → `recorded_at` DESC → `memory_id` の
 * 3段で決定的に並べる（ADR 0170）が、**`lexical` チャンネル
 * （`PostgresLexicalStore.search()`、`ORDER BY coverage DESC, rank DESC` に
 * 完全なタイブレークが無い）や `testkit`/テスト用の fake 実装が同じ保証を持つとは
 * 限らない。**ここで明示のタイブレークを足し、`packages/core` 自身が adapter の
 * 返却順に依存しないようにする**（多層防御。ADR 0034/0056/0059 と同じ考え方
 * ——正しさの担保を1箇所に置かない）。
 *
 * 1. `score.total` 降順。
 * 2. 実効時刻（`occurredAt ?? recordedAt`、ADR 0039）降順——新しい方を先に。
 * 3. `memory.id` 昇順——最終フォールバック。**ここまで落ちたとき**（`score.total` と
 *    実効時刻の両方が完全一致したとき）は、`memory.id` が ingest のたびに
 *    振り直されるランダムな UUID である adapter（`PostgresMemoryStore`）の場合、
 *    **決定的だが fresh ingest をまたいで再現するとは限らない**——
 *    `vector-store.ts` の3段目の tie-break と同じ性質の限界を引き継ぐ
 *    （ADR 0170「確かめていないこと」）。
 *
 * テストからも直接呼べるよう、export する（`threshold-partition.test.ts` が
 * `partitionByThreshold` を直接 import しているのと同じ作法）。
 */
export function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  const scoreDiff = b.score.total - a.score.total;
  if (scoreDiff !== 0) return scoreDiff;
  const aTime = (a.memory.occurredAt ?? a.memory.recordedAt).getTime();
  const bTime = (b.memory.occurredAt ?? b.memory.recordedAt).getTime();
  if (aTime !== bTime) return bTime - aTime;
  return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
}

/**
 * 段2の閾値比較の結果を、**網羅的な三分割**にする（ADR 0044）。
 *
 * **⚠ 以前は `filter(total >= t)` と `filter(total < t)` の2本を独立に走らせていた。
 * この2つは補集合ではない**——どちらかが `NaN` だと両方の比較が false になり、
 * 候補は残らないのに `below_threshold` にも数えられなかった
 * （`omitted` が空配列になり、「取りこぼしは無い」と積極的に誤答していた）。
 *
 * ここでは**1件につき1回だけ分岐**し、必ず3つのどれか1つに入れる。
 * ⟹ `passed.length + belowThreshold.length + notComparable.length === scored.length` が
 * **構造的に成り立つ。**成り立っていることは呼び出し側が確かめ、`countKind` の名乗りに使う。
 */
export interface ThresholdPartition {
  passed: ScoredCandidate[];
  belowThreshold: ScoredCandidate[];
  /** `>= threshold` でも `< threshold` でもなかった候補（実際には `total` が `NaN`）。 */
  notComparable: ScoredCandidate[];
}

export function partitionByThreshold(
  scored: readonly ScoredCandidate[],
  threshold: number,
): ThresholdPartition {
  const passed: ScoredCandidate[] = [];
  const belowThreshold: ScoredCandidate[] = [];
  const notComparable: ScoredCandidate[] = [];
  for (const candidate of scored) {
    const total = candidate.score.total;
    if (total >= threshold) {
      passed.push(candidate);
    } else if (total < threshold) {
      belowThreshold.push(candidate);
    } else {
      // ⚠ ここは「else if を書き忘れた残り」ではない。**到達する**——
      // total か threshold が NaN のとき、上の2つはどちらも false になる。
      notComparable.push(candidate);
    }
  }
  return { passed, belowThreshold, notComparable };
}

/**
 * 三分割の件数の `countKind` を決める（ADR 0044）。
 *
 * **🔴 `'exact'` をリテラルで書かないための関数である。**この repo が一度破れたのは、
 * `count(*) OVER ()` が `hnsw.ef_search` 依存の値を返すようになっても名乗りが
 * `'exact'` のままだった件である（ADR 0011）。**名乗りは、正確さを知っている場所から引き継ぐ。**
 * ここで正確さを知っているのは「三分割が網羅であること」なので、それを実際に数えて確かめる。
 *
 * **⚠ `partitionByThreshold` が正しい限り `'unknown'` は返らない。**
 * それでもこの分岐を置くのは、**壊れたときに嘘をつくのではなく黙るため**である。
 * 分岐が到達不能であること自体は、この関数を直接呼ぶ歯が測っている
 * （網羅でない分割を渡すと `'unknown'` が返ることを確かめてある）。
 */
export function countKindForPartition(
  partition: ThresholdPartition,
  scoredCount: number,
): CountKind {
  const partitioned =
    partition.passed.length + partition.belowThreshold.length + partition.notComparable.length;
  return partitioned === scoredCount ? "exact" : "unknown";
}

/** budget truncation の単位。同伴ペアは分割しない（docs/recall.md §8）ため、1つ以上の候補をまとめて持つ。 */
export type Unit = {
  members: ScoredCandidate[];
  /** 並び替え・切り詰めの基準スコア。ペアの場合は主(スコアで選ばれた側)のスコアを使う。 */
  rankScore: number;
};

function unitChars(unit: Unit): number {
  return unit.members.reduce((sum, m) => sum + m.memory.digest.length, 0);
}

function unitTokens(unit: Unit, tokenCounter: TokenCounter): number {
  return unit.members.reduce((sum, m) => sum + tokenCounter.count(m.memory.digest).tokens, 0);
}

/** budget が指定されたトークン予算の中で最も厳しい(小さい)ものを1本にまとめる。 */
function effectiveTokenBudget(budget: RecallBudget | undefined): number | undefined {
  if (!budget) return undefined;
  const candidates = [budget.maxMemoryTokens, budget.promptBudgetTokens].filter(
    (v): v is number => v !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/**
 * 段4（予算による切り詰め）の件数の `countKind` を決める（ADR 0045）。
 *
 * **🔴 `'exact'` をリテラルで書かないための関数である。**
 * [ADR 0044](../../../docs/decisions/0044-score-not-comparable-omission.md) で段2に入れたのと
 * 同じ規律を段4へ広げる——**名乗りは、正確さを知っている場所から引き継ぐ。**
 *
 * **⚠ ここで「正確さを知っている場所」は `slice` ではない。**
 * `keptUnits = units.slice(0, cut)` と `droppedUnits = units.slice(cut)` が網羅であることは
 * 言語の保証であり、確かめても同語反復にしかならない。
 *
 * **正確さを決めているのは、その手前の「単位を組む繰り返し」である**——
 * 段3までに集まった候補（`withinLimit` ＋ 同伴取得分）が、**それぞれちょうど1つの単位に入ったか。**
 * あの繰り返しは `consumed` の集合で重複を避けながら同伴をペアにしており、
 * **どの候補もどの単位にも入らないまま落ちる余地が構造として在る**（対向関係が
 * 一対一でない壊れたデータが来た場合など）。**そうなると、その候補は返り値にも
 * `budget_dropped` にも現れずに消える**——[ADR 0044](../../../docs/decisions/0044-score-not-comparable-omission.md)
 * が段2で塞いだのと同じ形の穴が、段4で開くことになる。
 *
 * **⟹ 単位が候補を網羅していれば `'exact'`、していなければ `'unknown'` と名乗る。**
 * 嘘をつくのではなく黙る。
 */
export function countKindForUnits(units: readonly Unit[], candidateCount: number): CountKind {
  const covered = units.reduce((sum, unit) => sum + unit.members.length, 0);
  return covered === candidateCount ? "exact" : "unknown";
}

/**
 * 単位が候補を**覆えていない件数**を返す（ADR 0043）。覆えていれば 0。
 *
 * **🔴 二重計上（覆った数が候補数を超える）でも 0 を返す。**候補は*消えて*いないので、
 * 「落ちた」と名乗るのは嘘になる。**差の絶対値ではない**——向きが意味を持つ。
 * 二重計上そのものは `countKindForUnits` が `'unknown'` として名乗る（ADR 0045）。
 *
 * **⚠ この関数の 0 を返す2つの経路（覆えている / 二重計上）は、`recall()` からは
 * 区別できない。**どちらも omission が出ないという同じ結果になるためである。
 * ⟹ **向きの判断そのものは、この関数を直接呼ぶ歯で測る。**
 */
export function unitAssemblyShortfall(units: readonly Unit[], candidateCount: number): number {
  const covered = units.reduce((sum, unit) => sum + unit.members.length, 0);
  return Math.max(0, candidateCount - covered);
}

export async function runRecall(
  ctx: Ctx,
  query: RecallQuery,
  deps: RecallRuntimeDeps,
): Promise<RecallResult> {
  const validatedQuery = RecallQuerySchema.parse(query);
  const now = deps.clock.now();
  const stages: StageTrace[] = [];
  const omitted: Omission[] = [];

  // 「この時刻において真だった記憶」ゲート（Issue #280、Issue #202 第2弾、
  // マネージャー決定1）。既定で有効——`includeFullyDecayed` と同じ opt-out 型
  // （`RecallQuery.includeOutsideValidity`）。省略時の基準時刻は `now`。
  const validityGateActive = validatedQuery.includeOutsideValidity !== true;
  const validAt = validatedQuery.validAt ?? now;

  // 忘却ゲート（decay floor gate、マネージャー決定、Issue #196 / ADR 0153）。
  // 既定で有効——opt-in ではなく opt-out（`RecallQuery.includeFullyDecayed`）。
  // ADR 0011「Phase 1 では decayFloorAtAfter を読み取りフィルタに使わない」を
  // ADR 0153 が明示的に上書きしている。
  const decayGateActive = validatedQuery.includeFullyDecayed !== true;

  // ADR 0165: テナントの decay_clock を読み、忘却ゲート（段1・後置フィルタ）と段2の
  // 再スコアに織り込む。`decayClock` は 'wall' 以外なら段2でも使うため、ゲートが
  // 無効（includeFullyDecayed: true）でも常に読む——「ゲートを外す」ことと「順位付けに
  // 使う時計を選ぶ」ことは別の軸である。
  const decayClock: DecayClock =
    deps.tenantSettingsStore === undefined
      ? DEFAULT_DECAY_CLOCK
      : await readDecayClock(deps.tenantSettingsStore, ctx);
  // 活動時計の「いま」。'wall' のテナントでは一度も `tenant_activity` を読まない
  // （ADR 0165 決めたこと5「activity_seq を進めるのは decay_clock != 'wall' のテナントに
  // 限る」の読み側の対になる節約——'wall' のテナントの activity_seq は常に無意味な 0 なので
  // 読む理由が無い）。
  const nowSeq: number | undefined =
    decayClock === "wall" || deps.tenantSettingsStore === undefined
      ? undefined
      : await readActivitySeq(deps.tenantSettingsStore, ctx);

  // -------------------------------------------------------------------
  // 段0: スコープ確定（docs/recall.md §2 段0、マネージャー決定の「スコープの外延」）
  //
  // ⚠ **この塊は `decayClock`/`nowSeq` の読み取り（上の2つの `await`）より後に置く**
  // （Issue #329 / ADR 0173）。忘却ゲートの2軸は `decay_clock` を読まなければ決まらず、
  // スコープはその2軸を持って `MemoryStore.aggregateScope` へ渡らなければならない
  // ——`omitted.filtered(decayed)` の件数を、段1の押し下げと**同じ述語**で数えるためである。
  // **`stage: "scope"` の trace の内容も、stages 内の順序も1バイトも変わっていない**
  // ——この塊より前にあるのは `decayGateActive` の定義と2つの `await` だけであり、
  // そのどれも `stages` を1つも積まない。
  // -------------------------------------------------------------------
  const scope: RecallScope = {
    subjectId: ctx.subjectId,
    occurredAfter: validatedQuery.occurredAfter,
    occurredBefore: validatedQuery.occurredBefore,
    validAt: validityGateActive ? validAt : undefined,
    // ADR 0153 が段1へ押し下げた述語を、そのままスコープの一部として持つ
    // （ADR 0165 決めたこと1・12 の2軸ぶん）。
    // **⭐ ここが軸の唯一の出所である。**段1（ANN）と段3.5（連想枠）の `VectorFilter` は
    // `gateVectorFilterFields`（下、ADR 0172）経由でこの欄を読むだけであり、
    // 段5の `aggregateScope` は `scope` そのものを受け取る（ADR 0173）。
    // ——2箇所で同じ式を書くと、片方だけ直したときに「落ちた数」と「数えた数」が黙って
    // 食い違う（ADR 0038 が測った「実装が2つあると食い違う」穴）。
    decayFloorAtAfter:
      decayGateActive && (decayClock === "wall" || decayClock === "either") ? now : undefined,
    decayFloorSeqAfter:
      decayGateActive && (decayClock === "activity" || decayClock === "either")
        ? nowSeq
        : undefined,
    decayFloorAnyAxis: decayGateActive && decayClock === "either",
  };
  stages.push({
    stage: "scope",
    executed: true,
    detail: {
      subjectId: scope.subjectId ?? null,
      occurredAfter: scope.occurredAfter?.toISOString() ?? null,
      occurredBefore: scope.occurredBefore?.toISOString() ?? null,
      validAt: scope.validAt?.toISOString() ?? null,
    },
  });

  // -------------------------------------------------------------------
  // 段1: 候補生成（索引が効く。docs/recall.md §2 段1・§3）
  // -------------------------------------------------------------------
  const limit = validatedQuery.limit ?? DEFAULT_RECALL_LIMIT;
  const overFetchFactor = validatedQuery.overFetchFactor ?? DEFAULT_OVER_FETCH_FACTOR;
  const kPrime = Math.max(1, Math.round(limit * overFetchFactor));

  // 走らせるチャンネル（ADR 0084）。唯一の出所は RECALL_CHANNELS（recall.ts）であり、
  // ここで値を数え直さない——増えたときに黙って嘘になるのは散文のほうだからである。
  const channels = validatedQuery.channels ?? DEFAULT_RECALL_CHANNELS;
  const wantsAnn = channels.includes("ann");
  const wantsLexical = channels.includes("lexical");

  /**
   * 忘却ゲートの壁時計側の軸: `decayFloorAt` がまだ「いま」を過ぎていないか（狭義の `>`）。
   */
  const wallAxisAlive = (memory: Memory): boolean => memory.decayFloorAt > now;

  /**
   * 忘却ゲートの活動時計側の軸: `decayFloorSeq` が無い（NULL）なら「この軸には床が無い
   * ＝活動時計では沈まない」（ADR 0165 決めたこと4）ので常に true。`nowSeq` 自体が
   * 無い（`decayClock === 'wall'` で一度も読んでいない）場合も、判定できないので
   * 緩い側（true）へ倒す。
   */
  const activityAxisAlive = (memory: Memory): boolean => {
    const floorSeq = memory.decayFloorSeq;
    if (floorSeq === undefined || floorSeq === null) return true;
    if (nowSeq === undefined) return true;
    return floorSeq > nowSeq;
  };

  /**
   * ⭐ 全チャンネル共通の後置フィルタと段1（ANN）の押し下げが、同じ述語を2軸ぶん見る
   * （ADR 0165 決めたこと1・12）。
   * - `'wall'`: 壁時計の軸だけ。
   * - `'activity'`: 活動時計の軸だけ。
   * - `'either'`: **OR**（どちらかが生きていれば通す。最も緩い——決めたこと1）。
   */
  const survivesDecayGate = (memory: Memory): boolean => {
    if (decayClock === "wall") return wallAxisAlive(memory);
    if (decayClock === "activity") return activityAxisAlive(memory);
    return wallAxisAlive(memory) || activityAxisAlive(memory);
  };

  /**
   * ⭐ `validAt` ゲート（Issue #280 / ADR 0164）の述語。**段1の後置フィルタと段3.5（連想枠）の
   * 後置フィルタが、同じこの関数を呼ぶ**（Issue #347 / ADR 0172）——`RecallQuery.validAt` の
   * doc の述語そのものであり、`VectorFilter.validAt` / `LexicalFilter.validAt` が SQL 側で
   * 表す述語と同じ境界（左端は包含の `<=`、右端は狭義の `>`）である。
   *
   * `scope.validAt` が `undefined`（`includeOutsideValidity: true` でゲートを外した場合）なら
   * no-op——opt-out は全チャンネル・全段で同じように効く。
   *
   * **⚠ ここでは件数を数えない。** `expired`/`not_yet_valid` の exact な件数は
   * `aggregateScope` から取る（`period` と同じ扱い。`FilteredOmission.condition` の doc 参照）。
   */
  const survivesValidityGate = (memory: Memory): boolean => {
    if (scope.validAt === undefined) return true;
    if (memory.validFrom != null && memory.validFrom > scope.validAt) return false;
    if (memory.validUntil != null && memory.validUntil <= scope.validAt) return false;
    return true;
  };

  /**
   * ⭐ 段1（ANN）と段3.5（連想枠）の `VectorFilter` へ渡す、**ゲートの欄だけ**をまとめた断片
   * （Issue #347 / ADR 0172）。**1箇所で作って、両方の `vectorStore.search()` が同じものを撒く。**
   *
   * 🔴 **なぜ1箇所にまとめたか**: 以前は段1の filter だけがこの欄を持ち、段3.5 の連想用
   * `search()` は `tenant/subject/status/period/excludeProvenanceKinds` の5欄しか渡していなかった
   * ——⟹ **完全に減衰しきった記憶と、期限切れ／未発効の記憶が、連想枠から黙って返っていた**
   * （Issue #347）。**ゲートが増えたら、ここに足す。ここだけに足す。**
   *
   * - 忘却ゲート（ADR 0153 / Issue #196）: ADR 0011「Phase 1 では `decayFloorAtAfter` を
   *   読み取りフィルタに使わない」を ADR 0153 が明示的に上書きした。既定（`decayGateActive`）では
   *   「いま」を押し下げ、`decayFloorAt` を過ぎた（完全に減衰しきった）Memory を候補集合そのものから
   *   外す——over-fetch の窓（k'）を、まだ生きている記憶で埋める方向に働く。
   *   `includeFullyDecayed: true` を渡すと全欄が `undefined`/`false` になり、ADR 0153 より前の
   *   挙動（押し下げない）に戻る。**この opt-out は連想枠でも同じように効く。**
   * - ADR 0165 決めたこと1・12: `decay_clock` に応じて2軸を押し下げる。
   *   - `'wall'`: `decayFloorAtAfter` のみ（従来どおり）。
   *   - `'activity'`: `decayFloorSeqAfter` のみ。
   *   - `'either'`: 両方 + `decayFloorAnyAxis`（OR で結ぶ、最も緩い）。
   * - `validAt` ゲート（Issue #280 / ADR 0164）: `period` と同じ形で段1へ押し下げる
   *   （`scope.validAt` の doc 参照）。ゲートを外したときは `scope.validAt` 自体が `undefined`。
   *
   * ⚠ **この断片は後置フィルタの代わりではない。** `survivesDecayGate` / `survivesValidityGate`
   * が両段の後置に残っており、adapter が ADR 0034 の契約（filter を実際に適用する）を
   * 守らなかった場合の多層防御になっている。
   *
   * ⭐ **Issue #329 / [ADR 0173](../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md):
   * この断片は式を1つも持たない——4欄すべて `scope` から取る。**
   * 段5の `MemoryStore.aggregateScope` は同じ `scope` を受け取り、`count(*) FILTER` で
   * 「ゲートが落とした件数」を厳密に数える（`ScopeAggregate.filteredDecayed` /
   * `filteredExpired` / `filteredNotYetValid`）。⟹ **押し下げ（ここ）と集約（段5）が
   * 構造的に同じ述語を見る**ことが、`omitted` の件数が `"exact"` を名乗れる根拠である。
   * **ここに式を書き戻すと、その根拠が消える**——「段1で落ちた数」と「集約が数えた数」が
   * 黙って食い違いうる形に戻る。
   *
   * ⟹ **ゲートを増やすときは、`RecallScope`（`recall.ts`）に欄を足し、ここでその欄を撒き、
   * `aggregateScope` の述語に同じものを足す。この3点セットで1つである。**
   */
  const gateVectorFilterFields: Pick<
    VectorFilter,
    "decayFloorAtAfter" | "decayFloorSeqAfter" | "decayFloorAnyAxis" | "validAt"
  > = {
    decayFloorAtAfter: scope.decayFloorAtAfter,
    decayFloorSeqAfter: scope.decayFloorSeqAfter,
    decayFloorAnyAxis: scope.decayFloorAnyAxis,
    validAt: scope.validAt,
  };

  /**
   * 段2の再スコア（`strategies/scoring.ts`）へ渡す、活動時計まわりの入力（ADR 0165
   * 決めたこと12）。`decayClock`/`nowSeq` はテナント単位、`decayBaseSeq`/`halfLifeRecalls` は
   * Memory 単位——`computeDecay`（scoring.ts）が「揃っていなければ壁時計へフォールバック」
   * するので、ここでは単に Memory の値をそのまま渡すだけでよい。
   */
  const decayScoringExtras = (
    memory: Memory,
  ): {
    decayClock: DecayClock;
    nowSeq: number | undefined;
    decayBaseSeq: number | null | undefined;
    halfLifeRecalls: number | null | undefined;
  } => ({
    decayClock,
    nowSeq,
    decayBaseSeq: memory.decayBaseSeq,
    halfLifeRecalls: memory.halfLifeRecalls,
  });

  // 🔴 配線されていない語彙チャンネルを明示的に要求されたら、ここで投げる（ADR 0084 §4）。
  // **黙って0件を返さない。**理由は RecallQuery.channels の doc に書いてある——
  // これは「探したが無かった」ではなく「探せる状態になっていない」であり、
  // 何度呼んでも成功しない。degrade させると、呼び出し側は「使っているつもりで
  // 一度も使えていない」ことに気づけない。
  const lexicalStore = deps.lexicalStore;
  if (wantsLexical && lexicalStore === undefined) {
    throw new Error(
      LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX +
        "pass RuntimeDeps.lexicalStore, or drop 'lexical' from RecallQuery.channels",
    );
  }

  const embeddableText = validatedQuery.text?.trim();
  let queryVector = validatedQuery.vector;
  let candidateGenerationExecuted = false;
  let annHits: VectorHit[] = [];
  let lexicalHits: LexicalHit[] = [];
  let lexicalExecuted = false;

  // 「クエリに引ける中身が無い」は**段の性質であってチャンネルの性質ではない**ので、
  // チャンネルが2本走っても omission は1つしか積まない（ADR 0008: 同じ理由を
  // 2つの顔で返さない）。どのチャンネルが実行されなかったかは stages が名乗る。
  const pushEmptyQuerySkipOnce = (): void => {
    const already = omitted.some(
      (o) =>
        o.kind === "stage_skipped" &&
        o.stage === "candidate_generation" &&
        o.reason === "empty_query_content",
    );
    if (!already) {
      omitted.push({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "empty_query_content",
      });
    }
  };

  if (wantsAnn && queryVector === undefined) {
    if (embeddableText) {
      try {
        const [vector] = await deps.embeddingProvider.embed(ctx, [embeddableText]);
        queryVector = vector;
      } catch {
        omitted.push({
          kind: "stage_skipped",
          stage: "candidate_generation",
          reason: "embedding_provider_unavailable",
        });
      }
    } else {
      pushEmptyQuerySkipOnce();
    }
  }

  if (wantsAnn && queryVector !== undefined) {
    annHits = await deps.vectorStore.search(ctx, deps.embeddingProvider.space, queryVector, {
      limit: kPrime,
      filter: {
        tenantId: ctx.tenantId,
        status: ["active", "contested"],
        subjectId: scope.subjectId,
        excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
        occurredAfter: scope.occurredAfter,
        occurredBefore: scope.occurredBefore,
        // 忘却ゲート（ADR 0153 / ADR 0165）と validAt ゲート（Issue #280 / ADR 0164）の欄。
        // **段3.5（連想枠）の search() と1文字も違わないものを撒く**（Issue #347 / ADR 0172）
        // ——由来・意味論・opt-out の効き方は `gateVectorFilterFields` の doc に置いてある。
        // ⚠ ここへゲートの欄を直接書き足さないこと。足すなら `gateVectorFilterFields` へ足す
        // ——そうしないと連想枠だけが取り残される（それが Issue #347 で実際に起きたことである）。
        // ⚠ その `gateVectorFilterFields` も式を持たず `scope` から作る（Issue #329 / ADR 0173）
        // ——段5の `aggregateScope` が同じ `scope` を受け取って `count(*) FILTER` で数えるためである。
        ...gateVectorFilterFields,
      },
      // subjectId は等値一致なので段1に降ろす（ADR 0023）。excludeProvenanceKinds も
      // 離散5値の独立列への等値比較なので同じ理由で段1に降ろす（ADR 0056）。period は
      // 連続値の範囲比較であり partial index の離散値向き制約（docs/recall.md 133行目）に
      // 関わる設計判断だったが、ADR 0059 で式索引
      // （`COALESCE(occurred_at, recorded_at)` の3列索引）を足して段1に降ろした——
      // ADR 0023 の却下理由（「降ろすにはスキーマに踏み込む判断が要る」）は、その判断を
      // 実際に行ったことで解消されている。狭い時間窓のとき over-fetch の窓（k'）が
      // 期間外の候補で埋まる取りこぼしは、この押し下げで塞がれる。
    });
    candidateGenerationExecuted = true;
  }

  // **チャンネル1本につき trace を1つ積む**（ADR 0084 §6）。
  // ⟹ 既定（ANN 1本）のとき、この配列は ADR 0084 以前と1要素も1バイトも変わらない。
  // 複数チャンネルを走らせたときだけ要素が増え、各要素の detail.channel が出所を名乗る。
  if (wantsAnn) {
    stages.push({
      stage: "candidate_generation",
      executed: candidateGenerationExecuted,
      // decayGate（ADR 0153）: ANN は段1の VectorFilter.decayFloorAtAfter へ押し下げる。
      // ここでは「適用されたかどうか」だけを名乗る——件数は
      // omitted.filtered(condition:'decayed') を見よ。
      // ⭐ Issue #329 / ADR 0173: その件数は今は **exact** である（段5の `aggregateScope` が
      // 同じ述語で数える）。**ただし「ANN が k' の窓の中で落とした件数」ではない**
      // ——窓の内側の話は ADR 0011 の限界として引き続き不明である。
      detail: {
        channel: "ann",
        kPrime,
        hits: annHits.length,
        decayGate: decayGateActive ? "pushed_down" : "disabled",
        // ADR 0165 決めたこと1・12（北極星の問い3）: 実際に使った時計を名乗る。
        clock: decayClock,
        // Issue #280: validAt ゲートは ANN・語彙の両チャンネルで同じ形（"pushed_down"）
        // ——decayGate と違い語彙側も SQL の WHERE で絞るので "post_filtered" は無い。
        validityGate: validityGateActive ? "pushed_down" : "disabled",
      },
    });
  }

  // -------------------------------------------------------------------
  // 段1・語彙チャンネル（ADR 0084、Issue #106）
  // -------------------------------------------------------------------
  // **埋め込みを作らない。**語彙チャンネルはクエリの**文字列そのもの**を引く経路であり、
  // ここが「LLM を呼ばずに済ませられないか」（北極星の問い5）に素直に答える部分である。
  // ⟹ channels が ["lexical"] だけなら、この recall は埋め込み provider を一度も呼ばない。
  // `lexicalStore !== undefined` は上の throw が保証している。ここで改めて見ているのは
  // 型の narrowing のためだけであり、条件が増えたわけではない。
  if (wantsLexical && lexicalStore !== undefined) {
    if (embeddableText) {
      lexicalHits = await lexicalStore.search(ctx, embeddableText, {
        limit: kPrime,
        filter: {
          tenantId: ctx.tenantId,
          status: ["active", "contested"],
          subjectId: scope.subjectId,
          excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
          occurredAfter: scope.occurredAfter,
          occurredBefore: scope.occurredBefore,
          // Issue #280: `period` と同じ形で語彙チャンネルの SQL にも直接効く
          // （`decayFloorAtAfter` とは違い `LexicalFilter` が持つ欄）。
          validAt: scope.validAt,
        },
      });
      lexicalExecuted = true;
    } else {
      // vector だけを渡された場合もここへ来る——**ベクタは語彙チャンネルに渡せない。**
      pushEmptyQuerySkipOnce();
    }
    stages.push({
      stage: "candidate_generation",
      executed: lexicalExecuted,
      // decayGate（ADR 0153）: `LexicalFilter` は decayFloorAtAfter を持たない
      // （マネージャー決定3 — interface/adapter を増やさない）。代わりに core が
      // 全チャンネル共通の後置フィルタで同じ述語（`memory.decayFloorAt > now`）を掛ける
      // ——語彙チャンネルだけ減衰しきった記憶が返り続ける非対称を消す。
      detail: {
        channel: "lexical",
        kPrime,
        hits: lexicalHits.length,
        decayGate: decayGateActive ? "post_filtered" : "disabled",
        // ADR 0165 決めたこと1・12（北極星の問い3）: 実際に使った時計を名乗る。
        clock: decayClock,
        // Issue #280: 語彙チャンネルも SQL の WHERE で絞る（decayGate の "post_filtered"
        // とは違う）——`LexicalFilter.validAt` の doc 参照。
        validityGate: validityGateActive ? "pushed_down" : "disabled",
      },
    });
  }

  // over-fetch の打ち切り（docs/recall.md §3「正直に書くべき限界」）: LIMIT に達したなら
  // その先に何件あるかは原理的に数えられない。
  //
  // **⚠ ここでは「窓が埋まったか」を覚えるだけで、omitted へは積まない（ADR 0069）。**
  // かつてはこの位置で無条件に積んでいたが、`annHits.length >= kPrime` は
  // **「スコープが k' 以上ある」としか言っておらず、損したかどうかを一切言っていない**——
  // 実測でスコープ 75件・k'=40 のとき 7 probe すべてで鳴り、実損は 0/7 だった。
  // **⟹ 損失が起こりえたかは、段2〜段4 が終わって k 位の total が出るまで判定できない。**
  // 判定は `withinLimit` を作った直後で行う（下方の `decideAnnTruncation` の呼び出し）。
  const annWindowFilled = candidateGenerationExecuted && annHits.length >= kPrime && kPrime > 0;

  // 候補の実体を取得し、スコープ外（subject/period）・除外 provenance を落とす。
  // ここで落ちたものは「filtered」としては報告しない——subject は呼び出し側の境界
  // （tenant と同格。recall.ts の RecallScope doc 参照）、period はスコープを定義する
  // フィルタであり、その件数は段5の集約から報告する（ここで個別に数え直さない。
  // ADR 0011 と同じ理由——複数の経路から同じ意味の件数を出すと食い違いうる）。
  // チャンネルの候補を和集合にする（ADR 0084 §6）。順序は「ANN が返した順 →
  // 語彙だけが返した順」。**⟹ 語彙チャンネルが走っていないとき、この配列は
  // `annHits.map(h => h.memoryId)` と完全に一致する**——既定の挙動が変わらないことの、
  // コードの側の根拠である。
  const rawById = new Map<MemoryId, { distance?: number; lexicalCoverage?: number }>();
  const candidateIds: MemoryId[] = [];
  for (const hit of annHits) {
    const found = rawById.get(hit.memoryId);
    if (found === undefined) {
      rawById.set(hit.memoryId, { distance: hit.distance });
      candidateIds.push(hit.memoryId);
    } else if (found.distance === undefined) {
      found.distance = hit.distance;
    }
  }
  for (const hit of lexicalHits) {
    const found = rawById.get(hit.memoryId);
    if (found === undefined) {
      rawById.set(hit.memoryId, { lexicalCoverage: hit.coverage });
      candidateIds.push(hit.memoryId);
    } else if (found.lexicalCoverage === undefined) {
      found.lexicalCoverage = hit.coverage;
    }
  }

  const fetchedMemories =
    candidateIds.length > 0 ? await deps.memoryStore.getMany(ctx, candidateIds) : [];
  const memoriesById = new Map(fetchedMemories.map((m) => [m.id, m]));

  const excludeKinds = new Set(validatedQuery.excludeProvenanceKinds ?? []);
  const filteredCandidates: { memory: Memory; distance?: number; lexicalCoverage?: number }[] = [];
  for (const memoryId of candidateIds) {
    const raw = rawById.get(memoryId);
    if (raw === undefined) continue; // 起こらない（candidateIds は rawById から作った）。
    const memory = memoriesById.get(memoryId);
    if (!memory) continue; // getMany は存在しない/クロステナントの id を静かに落とす契約。
    // subjectId・excludeProvenanceKinds・period（occurredAfter/occurredBefore）は
    // 段1の filter にも渡している（上）が、ここでも改めて見る。二重に見えるが意図的
    // ——`VectorFilter` の各フィールドは adapter が実際に適用しなければならない契約だが
    // （ADR 0034）、正しさの責任は後段にも置く多層防御として残す（ADR 0034 の
    // 「採らなかった案」節、ADR 0056、period は ADR 0059）。この境界判定
    // （`>=`/`<=`、両端とも包含）は ADR 0039 が固定した規則そのものであり、
    // 段1へ渡す `VectorFilter.occurredAfter`/`occurredBefore`（ADR 0059）と
    // 同じ境界でなければならない——ここだけを変えると「何が返るか」と「omitted が
    // 何と言うか」が食い違う（ADR 0039 の指摘）。
    // ⚠ この段2のコメントは以前「InMemoryVectorStore は filter を無視するプレースホルダ
    // なので、ここを削ると core の契約そのものが壊れる」と書いていたが、その根拠は
    // ADR 0034 で `InMemoryVectorStore` が filter を実際に適用するよう直された時点で
    // 事実でなくなった（ADR 0034 が「コメントの更新は別途必要」と書き残していた分。
    // ADR 0056 で更新）。多層防御を残す理由そのものは変わっていない——上の
    // 現在の根拠に差し替えただけである。段1の絞りは正しさのためではなく、
    // over-fetch の窓（k'）を無駄にしないための最適化に過ぎない。
    if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) continue;
    const effectiveTime = memory.occurredAt ?? memory.recordedAt;
    if (scope.occurredAfter && effectiveTime < scope.occurredAfter) continue;
    if (scope.occurredBefore && effectiveTime > scope.occurredBefore) continue;
    if (excludeKinds.has(memory.provenance.kind)) continue;
    // validAt ゲート（Issue #280）: `period` と同じ多層防御——段1へも同じ述語を渡している
    // （上の ann/lexical filter 構築部）が、ここでも改めて見る。`RecallQuery.validAt` の
    // doc の述語そのもの。**exact な件数は `aggregateScope` から取るので、ここでは
    // カウントしない**（`period` と同じ扱い。`decayed` とは違う——理由は
    // `FilteredOmission.condition` の doc「`count`/`countKind` は `period` と同じ扱い」参照）。
    if (!survivesValidityGate(memory)) continue;
    // 忘却ゲート（ADR 0153、ADR 0165 決めたこと12）: `LexicalFilter` に decayFloorAtAfter を
    // 足さず（マネージャー決定3）、ここで**全チャンネル共通**の述語を適用する——ANN の候補にも
    // 同じ述語が掛かる。既定で押し下げている ANN の候補は `survivesDecayGate` を段1で
    // 既に満たしているはずなので、通常はここでは何も落とさない（実際に落ちないことを歯で
    // 検算する。マネージャー決定「押し下げと後置が同じ述語であることの検算になる」）。
    // ⭐ ADR 0165: `decay_clock` が 'activity'/'either' のテナントでは、この述語が
    // 壁時計だけでなく活動時計の軸も見る（`survivesDecayGate` の doc コメント参照）——
    // これを忘れると、語彙チャンネルだけ壁時計のまま残る（ADR 0165 決めたこと12 の表）。
    // ⚠ **ここでは数えない**（Issue #329 / ADR 0173）。`period`/`expired` と同じ扱いに
    // 揃えた——exact な件数は段5の `aggregateScope`（`ScopeAggregate.filteredDecayed`）から
    // 取る。**両方から数えると二重計上になる。**フィルタそのものは残す（多層防御と、
    // 語彙チャンネルが混ざったときの保険。ADR 0153 決めたこと3）。
    if (decayGateActive && !survivesDecayGate(memory)) {
      continue;
    }
    filteredCandidates.push({
      memory,
      distance: raw.distance,
      lexicalCoverage: raw.lexicalCoverage,
    });
  }

  // -------------------------------------------------------------------
  // 段2: 再スコア（索引不要。docs/recall.md §2 段2・§7）
  // -------------------------------------------------------------------
  const queryTags = validatedQuery.tags ?? [];
  const scored: ScoredCandidate[] = filteredCandidates.map(
    ({ memory, distance, lexicalCoverage }) => {
      // ADR 0038: distance はコサイン距離。ANN が当てていない候補には距離が無い。
      const similarity = distance === undefined ? undefined : 1 - distance;
      // `lexicalMatch` は adapter が返した coverage（一致した語彙数 ÷ クエリ語彙数）
      // をそのまま使う（ADR 0092）。**⚠ adapter が返した rank をここへ流さない**
      // ——尺度が adapter ごとに違い、コサイン類似度と比較可能な量ではない（ADR 0084 §5）。
      const lexicalMatch = lexicalCoverage;
      const score = defaultScoringStrategy({
        now,
        similarity,
        lexicalMatch,
        tags: memory.tags,
        queryTags,
        occurredAt: memory.occurredAt,
        recordedAt: memory.recordedAt,
        lastReinforcedAt: memory.lastReinforcedAt,
        strength: memory.strength,
        halfLifeHours: memory.halfLifeHours,
        ...decayScoringExtras(memory),
      });
      return {
        memory,
        retrievedVia: distance === undefined ? ("lexical" as const) : ("ann" as const),
        score,
      };
    },
  );
  // `score.total` が同点のときのタイブレークは `compareScoredCandidates` の doc
  // コメント参照（Issue #339 / ADR 0170）。
  scored.sort(compareScoredCandidates);

  const scoreThreshold = validatedQuery.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const partition = partitionByThreshold(scored, scoreThreshold);
  const { passed, belowThreshold, notComparable } = partition;
  // ⚠ `'exact'` をリテラルで書かない（ADR 0044）。理由は countKindForPartition の doc を参照。
  const rescoreCountKind = countKindForPartition(partition, scored.length);

  if (belowThreshold.length > 0) {
    omitted.push({
      kind: "below_threshold",
      count: belowThreshold.length,
      countKind: rescoreCountKind,
      nearMisses: belowThreshold
        .slice(0, 5)
        .map((c) => ({ memoryId: c.memory.id, score: c.score.total })),
    });
  }

  if (notComparable.length > 0) {
    omitted.push({
      kind: "score_not_comparable",
      count: notComparable.length,
      countKind: rescoreCountKind,
    });
  }

  const withinLimit = passed.slice(0, limit);
  const overLimit = passed.slice(limit);
  if (overLimit.length > 0) {
    omitted.push({ kind: "over_limit", count: overLimit.length, countKind: rescoreCountKind });
  }

  // -------------------------------------------------------------------
  // over-fetch の窓の外に、本来 top-k に入るべき候補が残っていたか（ADR 0069 案A）
  //
  // **段1ではなくここで判定する。**比較の基準になる「k 位の total」は、閾値と limit を
  // 通したあとにしか存在しないからである。**⟹ `omitted` の並び順が変わった**——
  // かつて `ann_truncated` は `below_threshold` / `over_limit` より前に積まれていた。
  // **順序に意味は無い**（`omitted` は集合として読まれる。`docs/recall.md` §4 の表も
  // kind ごとの説明であり順序を規定していない）が、**配列の完全一致で書かれた歯は影響を受ける**
  // ので、そういう歯は `toContainEqual` 等へ直した（緩めたのではなく、順序に依存していた
  // ことのほうが偶然だった）。
  // -------------------------------------------------------------------
  if (annWindowFilled && lexicalExecuted) {
    // 🔴 語彙チャンネルが走った run では、ADR 0069 の上界が前提として成り立たない
    // （ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE の doc）。**判定を試みずに、
    // 判定不能だと名乗る。**試みて `provably_safe` が返ると、成り立っていない前提の上で
    // 沈黙することになる——ADR 0069 が塞いだ穴を、こちらから開け直すことになる。
    omitted.push({
      kind: "ann_truncated",
      countKind: "unknown",
      certainty: "undecidable",
      undecidableReason: ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
    });
  } else if (annWindowFilled) {
    const lastAnnHit = annHits[annHits.length - 1];
    const verdict = decideAnnTruncation({
      strategy: defaultScoringStrategy,
      queryTags,
      // 段2が `1 - distance` で similarity を作っているのと同じ変換（ADR 0038: distance は
      // コサイン距離）。ここで別の式を使うと、判定と実際のスコアが食い違う。
      lastAnnSimilarity: lastAnnHit === undefined ? Number.NaN : 1 - lastAnnHit.distance,
      lastReturnedTotal:
        withinLimit.length >= limit ? (withinLimit[limit - 1]?.score.total ?? null) : null,
      scoreThreshold,
    });
    // **`provably_safe` のときは何も積まない。**沈黙は「値」ではなく「不在」で表す——
    // omission を「安全だった」という顔で積むと、`undecidable`（判定できなかった）と
    // 同じ形になり、この決定の芯が消える。
    if (verdict.kind === "loss_possible") {
      omitted.push({
        kind: "ann_truncated",
        countKind: "unknown",
        certainty: "loss_possible",
        safetyRatio: verdict.safetyRatio,
        assumptions: verdict.assumptions,
      });
    } else if (verdict.kind === "undecidable") {
      omitted.push({
        kind: "ann_truncated",
        countKind: "unknown",
        certainty: "undecidable",
        undecidableReason: verdict.reason,
      });
    }
  }

  // 語彙チャンネルの打ち切り（ADR 0084 §7）。**ANN と同じ札に潰さない**——
  // `ann_truncated` は損失可能性の判定まで作り込んだ札であり、こちらにその機構は無い。
  if (lexicalExecuted && kPrime > 0 && lexicalHits.length >= kPrime) {
    omitted.push({ kind: "lexical_truncated", countKind: "unknown" });
  }

  stages.push({
    stage: "rescore",
    executed: filteredCandidates.length > 0,
    detail: {
      scored: scored.length,
      passedThreshold: passed.length,
      // 三分割の3つ目。ADR 0044 で omitted にも出るようになったが、
      // trace の側でも辻褄が合っていることを読めるようにしておく。
      notComparable: notComparable.length,
      withinLimit: withinLimit.length,
    },
  });

  // -------------------------------------------------------------------
  // 段3: 矛盾の解決と必須の同伴取得（docs/recall.md §2 段3・§8）
  // -------------------------------------------------------------------
  const presentIds = new Set(withinLimit.map((c) => c.memory.id));
  const contestedNeedingCompanion = withinLimit.filter(
    (c) =>
      c.memory.status === "contested" &&
      c.memory.contestedWithId &&
      !presentIds.has(c.memory.contestedWithId),
  );
  const companionIds = [
    ...new Set(
      contestedNeedingCompanion
        .map((c) => c.memory.contestedWithId)
        .filter((id): id is MemoryId => id !== null && id !== undefined),
    ),
  ];

  const companions: ScoredCandidate[] =
    companionIds.length > 0
      ? (await deps.memoryStore.getMany(ctx, companionIds)).map((companionMemory) => {
          const owner = contestedNeedingCompanion.find(
            (c) => c.memory.contestedWithId === companionMemory.id,
          );
          const score = defaultScoringStrategy({
            now,
            tags: companionMemory.tags,
            queryTags,
            occurredAt: companionMemory.occurredAt,
            recordedAt: companionMemory.recordedAt,
            lastReinforcedAt: companionMemory.lastReinforcedAt,
            strength: companionMemory.strength,
            halfLifeHours: companionMemory.halfLifeHours,
            ...decayScoringExtras(companionMemory),
          });
          return {
            memory: companionMemory,
            retrievedVia: "mandatory_companion" as const,
            companionOf: owner?.memory.id,
            score,
          };
        })
      : [];

  stages.push({
    stage: "contradiction_resolution",
    executed: true,
    detail: { companionsAdded: companions.length },
  });

  // -------------------------------------------------------------------
  // 隣接性の不変条件（docs/memory-model.md §5 機構3）: 対向関係にある Memory は
  // 提示順で必ず隣接させる。ここで「単位（Unit）」を組み、budget 切り詰め（段4）は
  // 単位ごとに行う——ペアを分割しない（docs/recall.md §8）。
  // -------------------------------------------------------------------
  const allCandidates = [...withinLimit, ...companions];
  const byId = new Map(allCandidates.map((c) => [c.memory.id, c]));
  const consumed = new Set<MemoryId>();
  const units: Unit[] = [];
  for (const candidate of withinLimit) {
    if (consumed.has(candidate.memory.id)) continue;
    consumed.add(candidate.memory.id);
    const companionId = candidate.memory.contestedWithId;
    const companion = companionId && !consumed.has(companionId) ? byId.get(companionId) : undefined;
    if (companion && companion.retrievedVia === "mandatory_companion") {
      consumed.add(companion.memory.id);
      units.push({ members: [candidate, companion], rankScore: candidate.score.total });
    } else if (companion) {
      // 両側とも独立に withinLimit に含まれていたケース。まだ処理していなければペアにする。
      consumed.add(companion.memory.id);
      units.push({
        members: [candidate, companion],
        rankScore: Math.max(candidate.score.total, companion.score.total),
      });
    } else if (candidate.memory.status === "contested") {
      // 🔴 ADR 0136 / Issue #243: 対向が見つからない `contested`（典型は
      // `contestedWithId=null`。`memory-store.ts:175` 付近の mandatory companion
      // retrieval 契約——`contested` を単独で返してはならない）は、単位を組まず
      // consumed のまま落とす。`units` に一切現れないため、下の
      // `unitAssemblyShortfall` が「候補が単位を覆えていない」件数として自動的に
      // 検出し、既存の `unit_assembly_dropped`（ADR 0043）を通じて黙らずに報告される
      // ——争われている主張を、争われていない顔で単独で出すくらいなら、
      // 何も出さない（docs/recall.md §8 と同じ判断）。
    } else {
      units.push({ members: [candidate], rankScore: candidate.score.total });
    }
  }
  units.sort((a, b) => b.rankScore - a.rankScore);
  // 段4の件数がどれだけ正確かは、この時点で決まっている（ADR 0045）。
  const unitsCountKind = countKindForUnits(units, allCandidates.length);

  // 🔴 単位を組む繰り返しから候補が漏れたら、黙らない（ADR 0043）。
  //
  // ⚠ **Issue #197 / ADR 0134（2026-09 追記）で `Runtime.markContested` が入り、
  // `contested` を書く主体自体は存在するようになった。** ただし `markContested` は
  // 両側 `status='active'` の CAS を課したうえで相互参照を1トランザクションで書くため、
  // **`Runtime` 経由で作られた `contested` ペアが一対一を破ることは無い**——鎖
  // （A→B→C）や片方向（`contestedWithId` が対向を指し返さない）は `markContested` の
  // 書き込み経路からは構成できない。
  // ⟹ **今日この分岐が通るとすれば、それは `MemoryStore` を `Runtime` を経由せず直接
  // 叩いた場合に限る**（`docs/decisions/0046-contested-pair-invariant-tooth.md` が
  // 実測したとおり、`updateStatus(id, "contested")` 単体は今日も公開 interface から
  // 呼べる）。**片側だけの `contested`（`contestedWithId=null`）が単独で返る問題
  // （Issue #243）は、上の単位を組む繰り返しで ADR 0136 により塞いだ**——単独候補は
  // 単位を組まず、この shortfall の一部として `unit_assembly_dropped` に計上される。
  //
  // ⚠ **Issue #197 / ADR 0150（2026-09 追記）で、この段の反対側——`contested` から出る経路
  // （`Runtime.resolveContested`。docs/memory-model.md §11 行7）——も入った。** 決着が
  // つくと両側の `contestedWithId` が `null` に戻るため、**負けた側は次の recall から
  // 返らず、この段の同伴取得も起きなくなる**（`companionsAdded` が 0 に戻る）。
  // ⟹ **この段が発火したかどうかは `contradiction_resolution` の
  // `detail.companionsAdded` で数えられる**——`executed` は `companions.length` に
  // 関わらず常に `true` であり、**発火の有無を測っていない**（ADR 0150「測ったこと」が
  // 変異試験で実測した。歯は
  // `__tests__/stage3-mandatory-companion-mutation.test.ts`）。
  //
  // ⚠ 二重計上のときに出さない判断は `unitAssemblyShortfall` が持つ（その doc を参照）。
  const unitsShortfall = unitAssemblyShortfall(units, allCandidates.length);
  if (unitsShortfall > 0) {
    omitted.push({
      kind: "unit_assembly_dropped",
      count: unitsShortfall,
      // 二重計上が同時に起きていれば、その分だけ消失が隠れる。⟹ 下限しか言えない。
      countKind: "lower_bound",
    });
  }

  // -------------------------------------------------------------------
  // 段3.5: 連想（任意。既定 off。docs/recall.md §9、ADR 0151）
  //
  // 「聞かれていないことを、自分から思い出す」の実装。クエリで引けた記憶（アンカー）の
  // 近傍を、同じ埋め込み空間の二段目として引く——「何が似ているか」を新しく定義せず、
  // ANN が既に使っているコサイン類似度そのものを、クエリの代わりにアンカーを起点に使う。
  //
  // **この段が段1（候補生成）ではなく段3の隣に在る理由**: 段1で拾ったものは段2で
  // クエリに対して再スコアされる。連想の候補は定義上クエリに当たらないのだから、
  // 段1に置くと必ず段2の below_threshold で落ちる。「スコアに関係なく候補へ足す」経路は
  // 既に段3（必須の同伴取得）が持っており、連想はその一般化である。
  // -------------------------------------------------------------------
  const associationQuery = validatedQuery.association;
  const associationUnits: Unit[] = [];
  if (associationQuery !== undefined) {
    if (deps.vectorStore.getVectors === undefined) {
      // 北極星の問い2（無効にしても成立するか）を型で担保する任意メソッドが無い。
      // `query.association` を渡していても、連想は一切実行されない。
      omitted.push({
        kind: "stage_skipped",
        stage: "association",
        reason: "vector_store_lacks_get_vectors",
      });
    } else {
      // ⚠ `.bind` で `this` を固定してから切り出す——`FakeVectorStore.getVectors` の
      // ような通常のクラスメソッドは、`const f = obj.method; f(...)` の形で呼ぶと
      // `this` 束縛が外れる（実測: `this.entries` が `undefined` になり落ちた）。
      const getVectors = deps.vectorStore.getVectors.bind(deps.vectorStore);
      const anchorCount = associationQuery.anchorCount ?? DEFAULT_ASSOCIATION_ANCHOR_COUNT;
      const minSimilarity = associationQuery.minSimilarity ?? DEFAULT_ASSOCIATION_MIN_SIMILARITY;
      // アンカーは「クエリに実際に当たった」候補（withinLimit）から取る——companions
      // （段3の必須同伴取得）はスコアに関係なく足された候補であり、連想の起点として
      // 使うと「クエリに当たっていない候補から、さらにクエリに当たっていない候補を
      // 連想する」という不透明な連鎖になる。
      const anchors = withinLimit.slice(0, anchorCount);
      if (anchors.length === 0) {
        omitted.push({ kind: "stage_skipped", stage: "association", reason: "no_anchor" });
      } else {
        const anchorIds = anchors.map((a) => a.memory.id);
        const anchorVectorList = await getVectors(ctx, deps.embeddingProvider.space, anchorIds);
        // `VectorStore.getVectors` は「返す順序は memoryIds の順序と一致している必要はない」
        // という契約を持つ（packages/core/src/interfaces/vector-store.ts の doc）——
        // ここで memoryId をキーに引き直し、`anchorIds`（スコア降順、既に確定した順序）の
        // 順で処理する。
        //
        // 🔴 Issue #316 の非決定性の実際の原因（ADR 0167）: 以前はここで
        // `anchorVectorList` を直接 for-of していたため、複数アンカーの近傍に同じ候補が
        // 重なったとき「最初に当たったアンカー」が adapter の返す順序に左右されていた。
        // `PostgresVectorStore.getVectors` は `ORDER BY` を持たず、実測では主キー
        // `(tenant_id, memory_id)` の Index Scan（memory_id という**ランダムな UUID**の
        // 昇順）で返る——ingest のたびに `gen_random_uuid()` が変わるので、この「最初に
        // 当たった」の勝者が ingest ごとに変わっていた。HNSW / pgvector の近似探索は
        // 無関係だった（実測: この規模では Seq Scan / PK Index Scan のみが選ばれ、
        // HNSW 索引は一度も使われていない）。
        const anchorVectorById = new Map(anchorVectorList.map((v) => [v.memoryId, v]));
        // 除外集合: 既に返る集合（withinLimit + companions）とアンカー自身。
        const excludeIds = new Set<MemoryId>([
          ...withinLimit.map((c) => c.memory.id),
          ...companions.map((c) => c.memory.id),
          ...anchorIds,
        ]);
        // 複数アンカーから同じ記憶が浮上しても、associationOf は最初に当たった
        // アンカーだけを記録する（ADR 0151 の負債4「アンカーを1つしか指さない」）。
        // 「最初」は常に `anchorIds`（スコア降順）の順で決める——adapter の返す順序には
        // 依存しない（上のコメント参照）。
        const seen = new Set<MemoryId>();
        const associationHits: { memoryId: MemoryId; anchorId: MemoryId; similarity: number }[] =
          [];
        for (const anchorId of anchorIds) {
          const anchor = anchorVectorById.get(anchorId);
          if (!anchor) continue; // adapter が返さなかった（存在しない/削除された等）
          // **段0と同じ scope の filter で呼ぶ**（docs/recall.md §9.2 手順4）——アンカーの
          // ベクトルを使うだけで、**tenant/subject/status/period/excludeProvenanceKinds に
          // 加えて、忘却ゲート（`decayFloorAtAfter`/`decayFloorSeqAfter`/`decayFloorAnyAxis`）と
          // `validAt` ゲートまで含めた境界すべてを、段1のANN検索と同一にする**
          // （Issue #347 / ADR 0172）。ゲートの3種は `gateVectorFilterFields` に1箇所で
          // まとめてあり、段1と同じ断片をそのまま撒く——**列挙を散文で数え直さない**
          // （数え直した結果、2つのゲートが抜けたまま「同一にする」と書いてあったのが
          // Issue #347 である）。limit は over-fetch 済みの kPrime を流用する
          // ——除外・閾値で落ちる分の余裕を持たせるためであり、新しい係数を定義しない。
          const hits = await deps.vectorStore.search(
            ctx,
            deps.embeddingProvider.space,
            anchor.vector,
            {
              limit: kPrime,
              filter: {
                tenantId: ctx.tenantId,
                status: ["active", "contested"],
                subjectId: scope.subjectId,
                excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
                occurredAfter: scope.occurredAfter,
                occurredBefore: scope.occurredBefore,
                ...gateVectorFilterFields,
              },
            },
          );
          for (const hit of hits) {
            if (excludeIds.has(hit.memoryId) || seen.has(hit.memoryId)) continue;
            const similarity = 1 - hit.distance;
            if (!(similarity >= minSimilarity)) continue;
            seen.add(hit.memoryId);
            associationHits.push({
              memoryId: hit.memoryId,
              anchorId,
              similarity,
            });
          }
        }
        // アンカーとの類似度降順に並べ、maxCount 件まで採る（docs/recall.md §9.2 手順6）。
        //
        // ⚠ **同点（similarity が完全一致）のときの並びは、意図して明示のタイブレークを
        // 足さず、`vectorStore.search()` が返す順序にそのまま委ねている**（Issue #339 /
        // ADR 0170、決めたこと）。`Array.prototype.sort` は安定（ES2019+）——同点候補は
        // `associationHits`（= アンカーを `anchorIds` の順に処理し、各アンカーの
        // `hits` を search() が返した順のまま push した配列）の挿入順を保つ。
        // `VectorStore.search()` の doc（`packages/core/src/interfaces/vector-store.ts`）が
        // 「同点のときの順序まで含めて adapter の責務」と明記しており、
        // `PostgresVectorStore.search()` は距離 → `recorded_at` DESC → `memory_id` の
        // 3段で決定的に並べる（同ファイルのクラス doc 参照）——**この段（recall-runtime.ts）
        // 自身に memoryId 等での再タイブレークを重ねて足すと、adapter が既に確定した
        // 順序（`recorded_at` に基づく、意味のある順序）を、無関係な UUID の辞書順で
        // 上書きしてしまい、かえって adapter 側の修正を無効化する**。⟹ ここでは
        // 「adapter が完全な順序を返す」契約に乗り、`recall-runtime.ts` 側では
        // 何もしないことを選んだ（`scored.sort`、上の段2とは違う選択——あちらは
        // `lexical` チャンネルの adapter 側の tie-break が不完全なままなので
        // 多層防御を足したが、こちらは Memory を取得する前で `occurredAt`/`recordedAt`
        // を持たず、同じ多層防御を足すには追加の DB 往復が要る。ADR 0170「採らなかった案」）。
        associationHits.sort((a, b) => b.similarity - a.similarity);
        const selectedHits = associationHits.slice(0, associationQuery.maxCount);
        const associationMemories =
          selectedHits.length > 0
            ? await deps.memoryStore.getMany(
                ctx,
                selectedHits.map((h) => h.memoryId),
              )
            : [];
        const associationMemoriesById = new Map(associationMemories.map((m) => [m.id, m]));
        for (const hit of selectedHits) {
          const memory = associationMemoriesById.get(hit.memoryId);
          if (!memory) continue; // getMany は存在しない/クロステナントの id を静かに落とす契約。
          // 多層防御（段1の後で withinLimit を組み立てるのと同じ理由、ADR 0034/0056/0059）:
          // VectorFilter の各フィールドは adapter が実際に適用しなければならない契約だが、
          // ここでも改めて見る。
          if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) continue;
          const effectiveTime = memory.occurredAt ?? memory.recordedAt;
          if (scope.occurredAfter && effectiveTime < scope.occurredAfter) continue;
          if (scope.occurredBefore && effectiveTime > scope.occurredBefore) continue;
          if (excludeKinds.has(memory.provenance.kind)) continue;
          // ⭐ validAt ゲート（Issue #280 / ADR 0164）と忘却ゲート（ADR 0153 / ADR 0165）の
          // 後置を、段1の後置ループ（上）と**同じ述語**で掛ける（Issue #347 / ADR 0172）。
          // `survivesValidityGate` / `survivesDecayGate` を呼ぶ——ここで述語を書き直さない
          // ことが、段1と段3.5が同じ境界を持つことの根拠である。
          // ⚠ `decayGateActive`（`includeFullyDecayed !== true`）の opt-out は連想枠でも
          // 尊重する——`includeFullyDecayed: true` を渡した呼び手には、連想枠でも
          // 減衰しきったものが返る。
          // ⚠ `survivesDecayGate` は `decay_clock` が 'activity'/'either' のテナントでは
          // 活動時計の軸も見る（ADR 0165 決めたこと12）——壁時計だけを見る述語をここに
          // 書き下すと、連想枠だけが壁時計のまま取り残される。
          //
          // 🔴 **落ちた件数はここでは数えない**（Issue #347 / ADR 0172 決めたこと3）。
          // 段1の後置ループ（上）と同じ扱いであり、連想用 `search()` も同じ欄を
          // 押し下げているので、通常この後置は1件も落とさない——落ちるのは adapter が
          // ADR 0034 の契約を破ったときだけである。
          //
          // ⭐ **Issue #329 / ADR 0173 の後は、件数は段5の `aggregateScope` が名乗る**
          // （`filtered(decayed)` / `filtered(expired)` / `filtered(not_yet_valid)`、
          // いずれも `countKind: "exact"`）。ADR 0172 が書いていた「段1の押し下げで
          // 落ちた分は原理的に数えられない（ADR 0011）」は、`decayed` については
          // **もう実態ではない**——押し下げは外さないまま、同じ `scope` の述語を
          // 集約側が持つことで厳密に数えられるようになった。
          // ⚠ **二重計上にならないのはなぜか**: 集約が数えるのは「**scope 内で**
          // 減衰しきっていた件数」という*集合の大きさ*であって、「どの段が落としたか」
          // ではない。⟹ 段1で落ちようが段3.5 で落ちようが、同じ Memory は1回しか
          // 数えられない。**だからこそ、数えるのは段5の1箇所だけでなければならない**
          // ——ここや段1の後置で足し込むと、その瞬間に二重計上になる。
          if (!survivesValidityGate(memory)) continue;
          if (decayGateActive && !survivesDecayGate(memory)) continue;
          // ⛔ アンカーとの類似度を score.similarity（クエリとの類似度の枠）に入れない
          // ——嘘になる（北極星の問い3・問い4、ADR 0151「採らなかった案」）。
          // `mandatory_companion`（段3）の先例に倣い、similarity/lexicalMatch を渡さず
          // decay × tagMatch × freshness × strength だけでスコアする（affinity は
          // 中立の1に退化する。`strategies/scoring.ts` の doc 参照）——スコアを
          // 合成しない、という規約をそのまま引き継ぐ。
          const score = defaultScoringStrategy({
            now,
            tags: memory.tags,
            queryTags,
            occurredAt: memory.occurredAt,
            recordedAt: memory.recordedAt,
            lastReinforcedAt: memory.lastReinforcedAt,
            strength: memory.strength,
            halfLifeHours: memory.halfLifeHours,
            ...decayScoringExtras(memory),
          });
          associationUnits.push({
            members: [
              {
                memory,
                retrievedVia: "association" as const,
                associationOf: hit.anchorId,
                score,
              },
            ],
            // 予算（段4）が「スコアの低いものから落とす」既定に従っても連想が
            // 最初に落ちるよう、`units`（クエリで引けた本体）の後ろに必ず並ぶ配列
            // として連結する（下記）。rankScore 自体は連想候補どうしの順序
            // （類似度降順で既に並んでいる）を保つためだけに使う。
            rankScore: score.total,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // 段4: 予算による切り詰め（docs/recall.md §2 段4・§8、§9.5）
  //
  // **連想の候補（associationUnits）は予算の内側に置き、予算で削るときは最初に落とす**
  // ——`units`（クエリで引けた本体、既にスコア降順）の**後ろに連結する**ことで、
  // 下の「後ろから cut する」切り詰めが連想を優先して落とす（クエリで引けたものを
  // 押し出さない）。目次帯（§6）とは違い連想枠は digest 本文を持つ実トークンなので、
  // 「予算の対象外」という先例（§6）はここへ適用しない。
  // -------------------------------------------------------------------
  const allUnits = [...units, ...associationUnits];
  const budget = validatedQuery.budget;
  let keptUnits = allUnits;
  if (budget) {
    const maxMemoryChars = budget.maxMemoryChars;
    const maxTokens = effectiveTokenBudget(budget);
    const fits = (candidateUnits: Unit[]): boolean => {
      if (maxMemoryChars !== undefined) {
        const chars = candidateUnits.reduce((sum, u) => sum + unitChars(u), 0);
        if (chars > maxMemoryChars) return false;
      }
      if (maxTokens !== undefined) {
        const tokens = candidateUnits.reduce((sum, u) => sum + unitTokens(u, deps.tokenCounter), 0);
        if (tokens > maxTokens) return false;
      }
      return true;
    };
    let cut = allUnits.length;
    while (cut > 0 && !fits(allUnits.slice(0, cut))) {
      cut -= 1;
    }
    keptUnits = allUnits.slice(0, cut);
    const droppedUnits = allUnits.slice(cut);
    const droppedCount = droppedUnits.reduce((sum, u) => sum + u.members.length, 0);
    if (droppedCount > 0) {
      // ⚠ `'exact'` をリテラルで書かない（ADR 0045）。理由は countKindForUnits の doc を参照。
      // associationUnits は1候補=1 Unit で構築しており取りこぼしが構造的に起きないため、
      // unitsCountKind（`units`/`allCandidates` から出した精度）をそのまま流用しても
      // 精度の名乗りは変わらない。
      omitted.push({ kind: "budget_dropped", count: droppedCount, countKind: unitsCountKind });
    }
  }

  stages.push({
    stage: "budget_truncation",
    executed: true,
    detail: { budgetApplied: budget !== undefined, unitsKept: keptUnits.length },
  });

  const finalMemories: RecalledMemory[] = keptUnits.flatMap((unit) =>
    unit.members.map((member) => {
      const recalled: RecalledMemory = {
        memoryId: member.memory.id,
        digest: member.memory.digest,
        retrievedVia: member.retrievedVia,
        // ⚠ リテラルを書かない。値は **その Memory の provenance そのもの**から引き継ぐ。
        // 出どころが将来変わったら、名乗りも一緒に変わる——countKind の exact が
        // リテラル固定のまま出どころだけ変わって嘘になった件（ADR 0011）の裏返しである。
        provenanceKind: member.memory.provenance.kind,
        score: member.score,
      };
      if (member.companionOf !== undefined) {
        recalled.companionOf = member.companionOf;
      }
      if (member.associationOf !== undefined) {
        recalled.associationOf = member.associationOf;
      }
      return recalled;
    }),
  );

  // 連想枠（Issue #200、ADR 0151）が返した digest の合計文字数の内訳。`association` を
  // 渡したときだけ usage.byTier に載せる（申告されていなければ欄自体が無い。`share`/
  // `budgetExceeded` と同じ規約）——「呼び手が連想で何文字増えたか」を見られるようにする。
  const associationChars = finalMemories
    .filter((m) => m.retrievedVia === "association")
    .reduce((sum, m) => sum + m.digest.length, 0);

  // -------------------------------------------------------------------
  // 段5: 目次帯の構築（索引: 集約クエリ。docs/recall.md §2 段5・§5）
  //
  // digestBand が担うのは「スコープ内に在るが `memories` に返していないもの」の
  // 1件1行の要旨である——`memories` に入った分の要旨は既に `RecalledMemory.digest` に
  // 在るので、ここでは `finalMemories` の memoryId を明示的に除外して集約を取る。
  // -------------------------------------------------------------------
  const digestBandLimit = validatedQuery.digestBandLimit ?? DEFAULT_DIGEST_BAND_LIMIT;
  const aggregate = await deps.memoryStore.aggregateScope(ctx, scope, {
    digestBand: {
      limit: digestBandLimit,
      excludeMemoryIds: finalMemories.map((m) => m.memoryId),
    },
  });
  const packedDigestBand = packDigestBand(aggregate.digests, aggregate.digestEligible.count, {
    limit: digestBandLimit,
    maxChars: DIGEST_BAND_MAX_CHARS,
    maxEntryChars: DIGEST_BAND_MAX_ENTRY_CHARS,
  });
  const indexBand: IndexBand = {
    groups: aggregate.groups,
    totalInScope: aggregate.totalInScope,
    countKind: aggregate.countKind,
    digestBand: packedDigestBand.band,
    digestBandCoverage: {
      shown: packedDigestBand.band.length,
      eligible: aggregate.digestEligible.count,
      countKind: aggregate.digestEligible.countKind,
      ...(packedDigestBand.limitedBy !== undefined
        ? { limitedBy: packedDigestBand.limitedBy }
        : {}),
    },
  };
  stages.push({
    stage: "index_band",
    // ⚠ detail に件数を足さない（ADR 0011）。件数は digestBandCoverage が名乗る。
    // detail は型無しの診断欄であり、同じ意味の件数を2箇所に置くと食い違いうる。
    executed: true,
    detail: { totalInScope: aggregate.totalInScope },
  });

  if (aggregate.filteredArchived.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "archived",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.archived,
      count: aggregate.filteredArchived.count,
      countKind: aggregate.filteredArchived.countKind,
    });
  }
  // superseded と forgotten を別々に push する（ADR 0027）。前者は機構の都合
  // （より良い抽出への置き換え、または統合。置き換え先を持つ）、後者は製品の振る舞い
  // （利用者が意図して忘れさせた。置き換え先を持たない）——束ねると次の一手が
  // 判定できなくなる。
  if (aggregate.filteredSuperseded.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "superseded",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.superseded,
      count: aggregate.filteredSuperseded.count,
      countKind: aggregate.filteredSuperseded.countKind,
    });
  }
  if (aggregate.filteredForgotten.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.forgotten,
      count: aggregate.filteredForgotten.count,
      countKind: aggregate.filteredForgotten.countKind,
    });
  }
  if (aggregate.filteredPeriod.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "period",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.period,
      count: aggregate.filteredPeriod.count,
      countKind: aggregate.filteredPeriod.countKind,
    });
  }
  // Issue #280: validAt ゲートが落とした件数を、理由ごとに分けて報告する
  // （`FilteredOmission.condition` の doc「1つの "invalid" のような値に束ねない」）。
  // `period` と同じく count === 0 では積まない——`decayed` と同じ既存の作法に揃える。
  if (aggregate.filteredExpired.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "expired",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.expired,
      count: aggregate.filteredExpired.count,
      countKind: aggregate.filteredExpired.countKind,
    });
  }
  if (aggregate.filteredNotYetValid.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "not_yet_valid",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.not_yet_valid,
      count: aggregate.filteredNotYetValid.count,
      countKind: aggregate.filteredNotYetValid.countKind,
    });
  }
  // ⭐ Issue #329 / ADR 0173: 忘却ゲートが落とした件数も、他の `filtered` と同じく
  // **この集約1本**から出す。ADR 0153 は段1（ANN）へ押し下げた分を「原理的に数えられない」
  // として後置フィルタの実測値（下限）だけを報告していたが、既定チャンネルは ANN 1本
  // （`DEFAULT_RECALL_CHANNELS`）なので**既定経路では一度も鳴らなかった**——記憶が
  // 何の名乗りも無く消えていた（北極星 項目6「『見つからなかった』と『探していない』を、
  // 同じ顔で返さない」と正面から食い違う）。押し下げは1バイトも外さず、
  // **同じ述語を持つ `scope` を集約へ渡して厳密に数える**ことで塞いだ。
  // `count === 0` では積まない——他の `filtered` と同じ作法。
  if (aggregate.filteredDecayed.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.decayed,
      count: aggregate.filteredDecayed.count,
      countKind: aggregate.filteredDecayed.countKind,
    });
  }
  // 理由ごとに1件ずつ返す（`filtered` の `condition` と同じ形）。
  // 一時的な遅延（pending）と恒久的な失敗（failed）と意図した除外（skipped）を
  // 1つに潰さない——ADR 0008 の判定基準（次の一手が変わるか）による。
  for (const reason of NOT_INDEXED_REASONS) {
    const entry = aggregate.notIndexed[reason];
    if (entry.count > 0) {
      omitted.push({
        kind: "not_indexed",
        reason,
        count: entry.count,
        countKind: entry.countKind,
      });
    }
  }

  // -------------------------------------------------------------------
  // ann_unreached（ADR 0025 の実測、ADR 0026 の決定）: 「近似索引がこの scope に
  // 届かなかった」ことが `omitted` に一度も出ない、という ADR 0008 の破れを埋める。
  //
  // **⚠ ここは段5（`aggregate`）に依存する。** `eligible`（= scope 内で埋め込みがあり
  // ANN の候補になり得た件数）は段1の情報だけでは出せない——`aggregate.totalInScope` と
  // `aggregate.notIndexed` が要る。この関数には早期 return が無く、段5は常にここに
  // 到達する前に実行されている（`aggregate` は必ず存在する。§報告のとおり確認済み）。
  // **もし将来、段5をスキップする経路が実装されたら、この判定はそこでは行えない
  // ——「取りこぼしたかもしれない」と断言する根拠（eligible）が無いため、鳴らさないこと。**
  const notIndexedTotal =
    aggregate.notIndexed.pending.count +
    aggregate.notIndexed.failed.count +
    aggregate.notIndexed.skipped.count;
  const eligible = aggregate.totalInScope - notIndexedTotal;
  if (
    candidateGenerationExecuted &&
    kPrime > 0 &&
    // k' に達していない。達していれば ann_truncated の領域であり、これと同時には立てない
    // ——「打ち切り」（もっと在るはずだが LIMIT で切った）と「届かなかった」（scope の他所へ
    // ANN が行ってしまった）は別の出来事だから、同じ札に相乗りさせない（ADR 0026）。
    annHits.length < kPrime &&
    // scope 内にまだ見られていない候補が残っている。
    // ⚠ この条件を落とすと、小さい subject で候補が ANN に全部返った場合
    // （例: 候補3件・kPrime 40・hits 3。3 < 40 だが 3 == eligible）にも常に鳴るようになる
    // ——「鳴ってはいけない側」を守っているのはこの条件である。
    annHits.length < eligible
  ) {
    omitted.push({ kind: "ann_unreached", countKind: "unknown" });
  }

  // -------------------------------------------------------------------
  // usage（docs/recall.md §6）: 計測と強制を混同しない——強制は段4で既に行った。
  // ここでは実際に返した量を測るだけ。
  // -------------------------------------------------------------------
  const digestChars = finalMemories.reduce((sum, m) => sum + m.digest.length, 0);
  const indexBandText = JSON.stringify(indexBand);
  const indexChars = indexBandText.length;
  const totalChars = digestChars + indexChars;
  const memoryTokens = deps.tokenCounter.count(finalMemories.map((m) => m.digest).join("\n"));
  const tokenCount = deps.tokenCounter.count(
    finalMemories.map((m) => m.digest).join("\n") + indexBandText,
  );

  // share の分子は **memories tier だけ**である（目次帯を含めない）。
  //
  // 目次帯は budget の対象外なので（RecallBudget の doc 参照）、分子に含めると
  // 「予算の何割を使ったか」という問いに対して、予算が縛っていない量まで数えることになり、
  // 100% を超える——実際に 248% という「割合として成立しない値」が出ていた。目次帯を
  // 分子から外したことで、その問題（248%）自体は直っている。
  //
  // ⚠ ただし「だから share は 1 を超えない」は偽である（ADR 0097。この段落は
  // ADR 0097 が拾い残していたコメントで、以前は「段4の切り詰めが memories tier を
  // 予算内に収めることを保証しているので、分子を memories tier に限れば share は
  // 1 を超えない」と書いていたが、これは実際には成り立たない——**`share` は 1 を
  // 超えうる。超えたときは `budgetExceeded` が `true` になる。**
  // 理由は、段4の切り詰め（強制）と `share` の計測が**別の数え方**をしているから
  // である: 強制側（段4の `fits`/`unitTokens`）は digest ごとに `tokenCounter.count()`
  // を呼びその合計で判定するが、`share` の分子は `digests.join("\n")` を1回だけ
  // `count()` する（連結後の量）。改行区切り文字の分だけ後者が前者を上回ることがあり、
  // 非CJK20字の digest 2件・`maxMemoryTokens: 10` で `share = 1.1` が実測されている
  // （`recall-pipeline.test.ts` の `usage.budgetExceeded` 節）。ADR 0098 参照。
  //
  // 「この応答は全体でいくらかかったか」は別の問いであり、`chars` と `indexChars` が答える。
  const tokenBudget = effectiveTokenBudget(budget);
  const usageShareDenominator = tokenBudget ?? budget?.maxMemoryChars;
  const usageShareNumerator = tokenBudget !== undefined ? memoryTokens.tokens : digestChars;

  // budgetExceeded（Issue #108「案3」、ADR 0083 が型変更として意図的に切り出した残件）。
  //
  // **存在条件を `share` と歯で揃える。** 「予算が申告されている」の判定に
  // `usageShareDenominator !== undefined` をそのまま再利用する——別の式で
  // 「申告されている」を判定し直すと、2箇所の規則が将来食い違いうる
  // （ADR 0011 が「同じ意味の件数を複数の経路から出すと食い違う」と言っているのと同じ理由）。
  // `budget: {}`（次元が1つも無い）は `usageShareDenominator` も `undefined` になるので、
  // この欄も無い。
  //
  // **`share` からは導出しない**（`RecallUsage.budgetExceeded` の doc、および
  // ADR 0083 を参照）。理由は2つ:
  // 1. 強制側（段4の `fits` が呼ぶ `unitTokens`）は digest ごとに `tokenCounter.count()` を
  //    呼ぶため `heuristicTokenCounter` の `Math.ceil` が件数ぶん掛かる。`share` の分子
  //    （`memoryTokens`。連結した1本に対して `ceil` を1回だけ、かつ連結で増えた `"\n"` の
  //    ぶんは強制側の計算に入っていない）とは加法的に一致しない。
  // 2. `share` の分母は `tokenBudget ?? budget?.maxMemoryChars` であり、トークン予算が
  //    在ると `maxMemoryChars` は分母から丸ごと消える。両方申告された場合、chars 次元の
  //    充足度は `share` からは読めない。
  //
  // ⟹ 返した memories を、申告された全次元に対して**個別に測り直す**。
  //
  // **トークン数に何を使うか**: 段4の `fits`（`unitTokens`。digest ごとに ceil）ではなく、
  // 上で計算済みの `memoryTokens`（連結して ceil 1回）を使う。呼び出し側が実際に
  // プロンプトへ積むのは「連結された1本」であり、`unitTokens` の合計はその連結後の量を
  // 表さない（改行区切り文字の分だけ過小に出る上、ceil を複数回に分けて行うぶん丸めの向きも
  // 変わる）。実測（歯: `recall-pipeline.test.ts` の budgetExceeded 節）: 非CJK20字の digest
  // 2件（各5トークン）に `maxMemoryTokens: 10` を渡すと、段4の `fits` は
  // `unitTokens` の合計 `5+5=10 <= 10` で両方残すが、`memoryTokens`（連結41字）は
  // `ceil(41/4) = 11 > 10` になる——強制側は超えていないと判定して両方残したのに、
  // 実際に返した量を測り直すと超えている。これが `budgetExceeded` の存在理由そのものである。
  //
  // **`maxMemoryChars` は例外的に、この不一致が起こらない**——`unitChars`（強制側）も
  // `digestChars`（ここ）も同じ「digest.length の単純な合計」であり、連結の区切り文字も
  // 複数回の ceil も無い。段4の `fits` は `maxMemoryChars` が申告されていれば必ずそれも
  // 満たしてから候補を確定するので、切り詰め後に `digestChars > maxMemoryChars` になることは
  // 構造上ない。⟹ `maxMemoryChars` だけを申告した経路では `budgetExceeded` は常に `false`
  // になる（歯: "maxMemoryChars のみの経路では false のままである"）。**それでもこの次元を
  // 判定に含めているのは**、他の次元（トークン）が同時に申告されたときに `budgetExceeded` の
  // 判定からこの次元を丸ごと落とさないため——`share` の分母がトークン優先で
  // `maxMemoryChars` を切り捨てるのと同じ落とし穴を、ここで繰り返さないためである。
  const charsExceeded = budget?.maxMemoryChars !== undefined && digestChars > budget.maxMemoryChars;
  const memoryTokensExceeded =
    budget?.maxMemoryTokens !== undefined && memoryTokens.tokens > budget.maxMemoryTokens;
  const promptTokensExceeded =
    budget?.promptBudgetTokens !== undefined && memoryTokens.tokens > budget.promptBudgetTokens;

  const usage = {
    chars: totalChars,
    estimatedTokens: tokenCount.tokens,
    counter: tokenCount.counter,
    byTier: {
      full: 0,
      digest: digestChars,
      index: indexChars,
      ...(associationQuery !== undefined ? { association: associationChars } : {}),
    },
    indexChars,
    ...(usageShareDenominator !== undefined
      ? {
          share: usageShareNumerator / usageShareDenominator,
          budgetExceeded: charsExceeded || memoryTokensExceeded || promptTokensExceeded,
        }
      : {}),
  };

  // -------------------------------------------------------------------
  // 段6: 記録（docs/recall.md §2 段6、ADR 0008）。必須の段。
  //
  // `stages` に 'record' 自身のトレースを、実際に書き込む**前**に積む——「記録した」ことを
  // 記録するには、記録が起きたという前提を先に確定する必要がある（この呼び出しが
  // 例外を投げれば `recall()` 自体が例外で終わるため、`explain.stages` が「記録した」と
  // 嘘をついたまま呼び出し側に届くことはない）。
  // -------------------------------------------------------------------
  stages.push({ stage: "record", executed: true });
  const recallId = await deps.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: ctx.subjectId ?? null,
    query: validatedQuery,
    budget: budget ?? null,
    omitted,
    usage,
    indexBand,
    explain: { stages },
    // Issue #298 / ADR 0155: 「後から再現できないもの」だけを運ぶ。`digest`/`provenanceKind`
    // は `MemoryStore.get()` から再現できるため含めない（下の draft.memories は
    // 引き続き finalMemories をそのまま使う——`RecallResult`（プロンプトへ向かう側）は
    // 1バイトも太らせない。この変更は記録側だけに閉じている）。
    returnedMemories: finalMemories.map((m) => ({
      memoryId: m.memoryId,
      score: m.score,
      retrievedVia: m.retrievedVia,
      ...(m.companionOf !== undefined ? { companionOf: m.companionOf } : {}),
      ...(m.associationOf !== undefined ? { associationOf: m.associationOf } : {}),
    })),
    // ADR 0165 決めたこと5: `decay_clock != 'wall'` のテナントに限り、この recall で
    // `tenant_activity.activity_seq` を進める。「1単位 = recall() 1回」——この呼び出し
    // そのものが1回の recall なので、既定のテナント（'wall'）では false のまま渡り、
    // `activity_seq` は1本も UPDATE が増えない。
    advanceActivityClock: decayClock !== "wall",
  });

  // -------------------------------------------------------------------
  // 出力検証（Issue #131、ADR 0098）: `recall()` の戻り値は、これまで一度も zod で
  // 検証されていなかった（fail-open）。段6（記録）は既に書き込み終えている——検証は
  // それより後に行う純関数の口（`validateRecallOutput`）に通すだけで、`draft` の値は
  // 一切書き換えない（`usage.share` が 1 を超えていても丸めない。ADR 0097 が記録した
  // 欠陥を、検証を足したことで隠さないため）。
  // -------------------------------------------------------------------
  const draft: RecallResult = {
    recallId,
    memories: finalMemories,
    omitted,
    index: indexBand,
    usage,
    explain: { stages },
  };
  const outputValidationMode = deps.outputValidation ?? DEFAULT_RECALL_OUTPUT_VALIDATION;
  const outputValidationReport = validateRecallOutput(draft, outputValidationMode, recallId);
  return outputValidationReport === undefined
    ? draft
    : { ...draft, outputValidation: outputValidationReport };
}
