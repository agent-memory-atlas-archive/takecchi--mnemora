import { systemClock } from "./clock.js";
import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EventActor, NewMemoryEvent } from "./event.js";
import {
  buildNewMemoryFromCandidate,
  describeExtractionFailure,
  extractCandidates,
} from "./extraction.js";
import type {
  ExtractedMemoryCandidate,
  ExtractionFailure,
  ExtractionOutcome,
} from "./extraction.js";
import { heuristicTokenCounter } from "./heuristic-token-counter.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { EventStore } from "./interfaces/event-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import {
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
  PURGE_TOMBSTONE_CONTENT,
  PURGE_TOMBSTONE_DIGEST,
} from "./interfaces/memory-store.js";
import type {
  ArchiveDecayedOptions,
  MemoryStore,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
} from "./interfaces/memory-store.js";
import { OutboxLeaseConflictError } from "./interfaces/outbox-store.js";
import type { ClaimOutboxJobsOptions, OutboxStore } from "./interfaces/outbox-store.js";
import type { OutboxJobKind } from "./interfaces/scheduler.js";
import {
  readActivitySeq,
  readDecayClock,
  readDefaultHalfLifeRecalls,
} from "./interfaces/tenant-settings-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore } from "./interfaces/vector-store.js";
import type { LexicalStore } from "./interfaces/lexical-store.js";
import type { MemoryId, ObservationId, RecallId } from "./ids.js";
import type { Memory, MemoryStatus, NewMemory } from "./memory.js";
import type {
  ObserveDocumentInput,
  ObserveEventInput,
  ObserveInput,
  ObserveUtteranceInput,
  ObserveInputKind,
} from "./observation.js";
import { ObserveInputSchema, observeInputKindToObservationKind } from "./observation.js";
import type { NewObservation, Observation } from "./observation.js";
import type { OutboxJobRecord } from "./outbox.js";
import { runRecall } from "./recall-runtime.js";
import type { RecallQuery, RecallRecord, RecallResult } from "./recall.js";
import type { RecallOutputValidationMode } from "./recall-output-validation.js";
import { classifyReextractTargets, classifySupersedeFailure } from "./strategies/reextract.js";
import type { ReextractSkip } from "./strategies/reextract.js";
import {
  buildConsolidatedMemory,
  buildConsolidationPrompt,
  computeAffinity,
  ConsolidationLLMResultSchema,
} from "./strategies/consolidate.js";
import type { ConsolidationLLMResult } from "./strategies/consolidate.js";
import {
  buildReflectedMemory,
  buildReflectionPrompt,
  ReflectionLLMResultSchema,
} from "./strategies/reflect.js";
import type { ReflectionLLMResult } from "./strategies/reflect.js";

/**
 * `runtime.observe` / `runtime.tick` の実装（roadmap.md 段階3、docs/architecture.md §3.2・§3.3）。
 *
 * **runtime は `packages/core` に置く**（docs/architecture.md §4）。ただし core は zod 以外の
 * 実行時依存を持てない（§3.6）ため、DB・LLM・埋め込み・時刻・ハッシュ計算はすべて
 * `createRuntime(deps)` の呼び出し側が注入する。core 自身はこれらの実体を import しない。
 *
 * D16 の反映: `contentHash`（SHA-256 hex）の実装は core に置かない。`deps.hashContent` として
 * 注入される関数（`node:crypto` を使う実装は adapter 側、例えば `packages/postgres` の
 * `sha256Hex`）に委ねる。runtime はこの関数を「呼ぶ」だけで、計算そのものは行わない。
 */

export interface RuntimeConfig {
  /** 抽出器のバージョン。冪等キー `(observationId, extractorVersion)` の一部になる。 */
  extractorVersion?: string;
  /** `provenance.inferred.model` に書き込むモデル識別子。呼び出し側の LLMProvider の実体に合わせる。 */
  llmModelId?: string;
  /** `provenance.inferred.promptVersion`。抽出プロンプトを変えたら上げる。 */
  promptVersion?: string;
  /** digest フォールバック（機械的な先頭文字列切り出し）の最大文字数。既定 200。 */
  digestFallbackLength?: number;
  /** `tick` の既定 claimedBy 値。複数ワーカーを区別したい場合に指定する。 */
  defaultClaimedBy?: string;
  /**
   * [Issue #204](https://github.com/takecchi/mnemora/issues/204) /
   * [ADR 0157](../../../docs/decisions/0157-tick-drives-consolidate-and-reflect.md):
   * `extract`（`observe()` の sync 経路・`tick()` の `extract` ジョブ経路の両方）が新しい
   * Memory を1件作るたびに、その `memoryId` を種にした `consolidate` / `reflect` の
   * outbox ジョブも追加で積むかどうか。
   *
   * 🔴 **既定は `false`（積まない）。** 北極星の問い2（「これを無効にしたとき、
   * Memory Framework として成立するか」）を満たすための opt-in——この設定を有効に
   * しなくても `observe()`/`recall()`/`tick()` は完全に成立し、`tick()` は
   * `embed` ジョブだけを処理し続ける。`consolidate()`/`reflect()` 自体は
   * この設定と無関係に、呼び出し側が明示的に呼べば常に動く（ADR 0089/0091）。
   *
   * `true` にすると、積む job kinds が `["embed"]` から `["embed", "consolidate", "reflect"]`
   * に変わる。ジョブの `payload` は既存の `embed` ジョブと同じ `{ memoryId }`
   * （`MemoryStore.createMemoryWithOutbox` が `jobKinds` の各要素に同じ payload を使う。
   * 新しい payload 形は発明していない）。`tick()` はその2種を
   * `consolidate(ctx, { target: { seedMemoryId: memoryId } })` /
   * `reflect(ctx, { target: { seedMemoryId: memoryId } })` として処理する。
   */
  autoQueueConsolidateReflectOnExtract?: boolean;
}

const DEFAULT_EXTRACTOR_VERSION = "v1";
const DEFAULT_LLM_MODEL_ID = "unknown";
const DEFAULT_PROMPT_VERSION = "v1";
const DEFAULT_DIGEST_FALLBACK_LENGTH = 200;
const DEFAULT_CLAIMED_BY = "runtime.tick";
const DEFAULT_TICK_LIMIT = 50;

/**
 * `tick` が**実際に処理する分岐を持つ** outbox job kind（ADR 0082）。
 *
 * ⚠ **ここに「いまは extract と embed だけ」と書かない。**この配列そのものが答えであり、
 * 散文で数え直した瞬間に、次に kind が増えたとき（`consolidate` / `reflect` の本体、
 * 利用者が足す第5・第6の kind）に黙って嘘になる。**コメントは検査されない。**
 *
 * 🔴 **これが「tick が何を処理するか」の唯一の出所である。**`claimBatch` の `kinds` の
 * 既定値も、ジョブを配る先（`jobHandlers`）も、`OutboxJobKind` の JSDoc も、ここを指す。
 * issue #105 の根は、この一覧が3か所（`OutboxJobKind` の名指しの列挙・`tick` の claim
 * 既定値・`if (job.kind === ...)` の分岐）に別々に写されていて、独立にずれたことだった。
 * `jobHandlers` は `Record<TickSupportedJobKind, JobHandler>` として書いてあるので、
 * **この配列に kind を足してハンドラを足し忘れると型検査が落ちる**（逆も落ちる）。
 *
 * ⚠ `OutboxJobKind` は `(string & {})` を含む開いたユニオンであり、ここに無い kind を
 * 積むこと自体は正しい使い方である（利用者が独自の種別を足して別経路で処理する）。
 * ここに無い kind を **`tick` に渡した**ときの倒れ方は {@link TickResult.unsupported} を見ること。
 */
export const TICK_SUPPORTED_JOB_KINDS = ["extract", "embed", "consolidate", "reflect"] as const;

/** {@link TICK_SUPPORTED_JOB_KINDS} の要素型。 */
export type TickSupportedJobKind = (typeof TICK_SUPPORTED_JOB_KINDS)[number];

/**
 * `tick` が `fail()` へ書き込む `last_error` の接頭辞。
 * 「対応していない kind だった」ことは {@link TickResult.unsupported} が第一の伝達路であり、
 * こちらは**後から outbox 行だけを見た人**（運用者・DB を覗いた人）が同じ結論に届くための
 * 二の路である。定数にしてあるのは、歯がこの文字列を名指しで測るため。
 */
export const UNSUPPORTED_KIND_ERROR_PREFIX = "runtime.tick: unsupported outbox job kind: ";

/** `tick` が1件の outbox ジョブを処理する関数の形。 */
type JobHandler = (ctx: Ctx, job: OutboxJobRecord) => Promise<void>;

export interface RuntimeDeps {
  memoryStore: MemoryStore;
  outboxStore: OutboxStore;
  vectorStore: VectorStore;
  /**
   * 語彙候補生成チャンネル（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)、Issue #106）。
   *
   * **省略可能である。**省略しても mnemora は成立する（北極星の問い2）——
   * `recall()` の既定は ANN 1本のままで、何も変わらない。
   *
   * **🔴 省略したまま `RecallQuery.channels` に `"lexical"` を渡すと `recall()` は投げる**
   * （`recall.ts` の `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX`）。**黙って0件を返さない**——
   * 理由は `RecallQuery.channels` の doc に書いてある。
   */
  lexicalStore?: LexicalStore;
  eventStore: EventStore;
  tenantSettingsStore: TenantSettingsStore;
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  /** 省略時は `systemClock`。 */
  clock?: Clock;
  /** D16: SHA-256 hex 等、content からハッシュを計算する関数（core は計算しない）。 */
  hashContent: (content: string) => string;
  config?: RuntimeConfig;
  /**
   * roadmap.md 段階4: `usage`（docs/recall.md §6）の計測に使う。省略時は
   * `heuristicTokenCounter`（文字数ベースの推定、`counter: 'heuristic'`）。
   */
  tokenCounter?: TokenCounter;
  /**
   * `recall()` の戻り値を zod で検証するときの倒れ方（Issue #131、ADR 0098）。
   * 省略時は `"report"`（{@link DEFAULT_RECALL_OUTPUT_VALIDATION}）——既定では投げない。
   * `recall-runtime.js` の `RecallRuntimeDeps.outputValidation` へそのまま渡る。
   */
  outputValidation?: RecallOutputValidationMode;
}

export interface ObserveResult {
  observationId: ObservationId;
  /**
   * sync 抽出で実際に作られた（または既存の冪等な行として返された）Memory の id。
   * `deferred` の場合、または冪等な再送（`created: false`）の場合は空配列——
   * **この場合に「以前作られた Memory の id」を遡って探すことはしない**（本 PR の決定。
   * PR 本文参照）。
   */
  memoryIds: MemoryId[];
  /**
   * この呼び出しの中で抽出がどうなったか。
   *
   * **`boolean` にしない。**「抽出した / していない」の2値に潰すと、
   * **LLM 呼び出しが失敗して全文フォールバックへ倒れた**という第三の状態が
   * 「抽出した」と同じ顔になる。ADR 0008 の判定基準——その区別があると
   * 呼び出し側の次の一手が変わるか——に照らすと、これは潰してはいけない区別である
   * （`llm_failed_whole_observation` なら、provider の復旧後に抽出をやり直す、
   * という一手がある。`ok` にはその一手が無い）。
   */
  extraction: ExtractionOutcome;
  /**
   * `extraction === "llm_failed_whole_observation"` のときに LLM 呼び出しが失敗した理由。
   * **それ以外（`"ok"` / `"skipped"`）は必ず `null`。**
   *
   * `ExtractionOutcome` 自体は3値のまま変えない（値を足すと `extraction` を分岐する
   * 網羅性チェックの無い箇所——本ファイルの三項演算子と
   * `examples/chat/src/retrieval-quality.ts` の switch——が黙って既定側へ落ちるため）。
   * その代わり、失敗の中身（provider が名乗った `kind` と人が読むメッセージ）はこの欄で運ぶ。
   *
   * **省略可能にしない。** 必須にすることで、`ObserveResult` を組み立てる全経路を
   * TypeScript に列挙させ、「埋め忘れた経路が黙って `undefined`（＝間違った *有る*）になる」
   * ことを防ぐ。
   */
  extractionFailure: ExtractionFailure | null;
}

/**
 * `runtime.reextract` の結果（ADR 0028、ADR 0029）。
 *
 * `observe()` の `ExtractionOutcome` が持つ `'skipped'`（`ObserveResult.extraction`。
 * `memory_usage` 入力用の値）と、この型が持つ `ReextractResult.skipped` フィールドは
 * **別の語彙**である——前者は「この呼び出しで抽出そのものを行ったか」、後者は
 * 「既存 Memory を supersede しなかった理由」。名前が似ているだけで無関係。
 * `reextract` の `extraction` は常に `'ok'` か `'llm_failed_whole_observation'` のどちらかで、
 * `'skipped'` は取らない——呼び出し側が明示的に指定した Observation に対して常に抽出を
 * 試みるため（deferred も冪等な再送もここには来ない）。
 */
/**
 * この呼び出しで「正典が要求する1トランザクション」が使えたかどうか（Issue #134 /
 * [ADR 0100](../../../docs/decisions/0100-supersede-with-new-memories.md)）。
 *
 * - `'store_supported'` — `MemoryStore.supersedeWithNewMemories`（任意メソッド）が在り、
 *   新 Memory の作成と旧行の supersede をその口へ渡した。
 * - `'store_unsupported'` — 口が無い adapter だったので、今日どおり作成と supersede を
 *   別々の書き込みとして行った（docs/memory-model.md §11 行5 は**満たされていない**）。
 * - `'not_attempted'` — **書き込みを1件も試みていない。**`reextract` の安全弁（LLM が
 *   また失敗した／候補が0件）で早期 return した場合。⛔ この状態を上の2つのどちらかに
 *   寄せない——「口が無かった」と「そもそも書いていない」は別のことであり、潰すと
 *   呼び手は「§11 行5 が破れた」と「破れる機会が無かった」を区別できなくなる。
 *   名前は `ConsolidationResult` の `not_attempted`（ADR 0087 決定5）に揃えた。
 *
 * 🔴 **この値は原子性の証拠ではない。口の有無の写しである。** adapter が口を実装したと
 * 宣言したことしか意味しない——実装していても実際にはトランザクションを張っていない
 * adapter（`packages/testkit` の `InMemoryMemoryStore` は「トランザクションは一切模して
 * いない」と自分で書いている）を、この値は見抜けない。原子性を実際に測るのは適合テストと
 * `packages/postgres` の並行の歯であって、この値ではない。
 *
 * ⛔ **省略可能（`?`）にしない。**`undefined` が「口が無かった」と「この欄より前の版の
 * 戻り値」の両方を意味してしまい、「無い」の種類を潰すことになる。
 */
export type WriteAtomicity = "store_supported" | "store_unsupported" | "not_attempted";

export interface ReextractResult {
  observationId: ObservationId;
  /** {@link WriteAtomicity}。⛔ 省略可能にしない。 */
  atomicity: WriteAtomicity;
  /**
   * 今回の抽出で作られた（または冪等に既存の行として返された）Memory の id。
   * `outcome !== 'ok'`、または候補が0件だった場合は空配列。
   */
  memoryIds: MemoryId[];
  /**
   * 🔴 安全弁により supersede された既存 Memory の id。
   * - LLM がまた失敗した場合（`outcome: 'llm_failed_whole_observation'`）は必ず空配列
   *   ——失敗を根拠に既存の記憶を置き換えない。
   * - 候補が0件だった場合も必ず空配列——そもそも `supersededById` の指す先が無い。
   * - 対象は同じ `(sourceObservationId, extractorVersion)` を持つ **`status: 'active'`** の
   *   Memory のうち、今回作られた content_hash の集合に含まれないものだけ
   *   （`forgotten` は絶対に含めない。`contested` も対象外——理由は ADR 0028 参照）。
   * - 🔴 安全弁3（ADR 0030）: `updateStatus` を `expectedStatus: "active"` の
   *   compare-and-swap で呼ぶ。読み（`listBySourceObservation`）と書き（`updateStatus`）の
   *   間に他の書き込みで status が変わっていた Memory は、ここには**入らない**
   *   （`skipped` に `status_changed_concurrently` として出る）。
   */
  supersededMemoryIds: MemoryId[];
  /**
   * ADR 0029: 既存 Memory を supersede しなかった理由。ADR 0028 が「引き受ける負債」に
   * 記録した欠落——`contested` で飛ばした・`forgotten` で飛ばした・そもそも置き換える
   * ものが無かった、の3つが `supersededMemoryIds: []` という同じ顔になっていた——を埋める。
   * ADR 0030（安全弁3）で `status_changed_concurrently`（TOCTOU で弾かれた）を追加した。
   *
   * **件数は持たない**（`ReextractSkip` 自体に `count`/`countKind` が無い。`recall.ts` の
   * `StageSkippedOmission` に倣った形。理由は ADR 0029 参照）。
   *
   * `usedWholeObservationFallback` の早期 return、`candidates.length === 0` の早期 return、
   * 本経路（`classifyReextractTargets` + `classifySupersedeFailure`）の3つの書き込み経路が
   * ある——早期 return の2つは**`listBySourceObservation` を呼ぶ前に return する**ため、
   * `skipped` には `{ kind: 'not_examined', ... }` が入る（「何も飛ばさなかった」ではなく
   * 「既存を見ていない」）。
   */
  skipped: ReextractSkip[];
  extraction: ExtractionOutcome;
  /**
   * `ObserveResult.extractionFailure` と同じ意味の欄（ADR 0076）。
   * `reextract` も `extractCandidates` を呼び、`llm_failed_whole_observation` を返す
   * 早期 return を持つ——`ObserveResult` にだけ運んで `ReextractResult` に運ばないと、
   * 「片方は種類が分かるのにもう片方は分からない」という非対称ができるため、対称に足す。
   * `extraction !== "llm_failed_whole_observation"` のときは必ず `null`。
   */
  extractionFailure: ExtractionFailure | null;
}

/**
 * `runtime.forget` の対象（Issue #102）。
 *
 * `{ memoryId }`（単数）と `{ memoryIds }`（複数）のどちらでも同じ意味論——
 * `forget` 自身は内部でこれを `MemoryId[]` に正規化してから処理する
 * （`{ memoryId }` は1要素の配列と同じ扱い）。単数形をわざわざ用意するのは、
 * 呼び出し側の大多数が1件だけを忘れさせたい場合に `{ memoryIds: [id] }` と
 * 書かせないため。
 */
export type ForgetTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/**
 * `runtime.forget` が対象1件ごとに返す結果（Issue #102）。
 *
 * **6つの `kind` はそれぞれ呼び出し側の次の一手が違う**——`ReextractSkip` や
 * `UnsupportedOutboxJob` と同じ「無いの分類」（ADR 0008）の適用:
 *
 * - `"forgotten"`: 今回の呼び出しで実際に `status` を `forgotten` へ動かし、
 *   `memory_events` にも `kind: 'forgotten'` を積んだ。`previousStatus` は
 *   動かす直前に観測した status。
 * - `"already_forgotten"`: 対象は最初から（または同じ呼び出し内の先行する
 *   要素の処理によって）`forgotten` だった。**書き込みは一切起きていない**
 *   ——`status` を「動かして `forgotten` になった」のではなく「既に
 *   `forgotten` だった」の区別を、呼び出し側が監査ログの読み方を誤らないよう
 *   に残す（同じ Memory を2回 forget しても `memory_events` は1件のまま、
 *   という冪等性がこの kind の存在理由そのもの）。
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い（一度も
 *   存在しなかった、または他テナントの id）。`"already_forgotten"` と混同しない
 *   ——「もう忘れている」と「そもそも知らない」は呼び出し側にとって別の状況
 *   （前者は監査ログを遡れる、後者は遡れるものが無い）。
 * - `"conflicted"`: compare-and-swap が破れた——`getMany` で読んだ時点の
 *   status と、実際に書きに行った時点の status が一致しなかった（並行して
 *   別の書き込みが割り込んだ）。**このメソッドは自動で再試行しない**
 *   （上限の無い再試行ループを作らない）。呼び出し側は `observedStatus` を見て
 *   必要なら自分でもう一度 `forget` を呼び直す。
 * - `"failed"`: 競合以外の例外（DB 接続断等）で書き込みそのものが失敗した。
 *   `error` に例外のメッセージを運ぶ。**この時点で処理を打ち切る**
 *   （下の `"not_attempted"` 参照）。
 * - `"not_attempted"`: 同じ呼び出しの中で、**それより前の要素が `"failed"`
 *   になったため、この要素はまだ見ていない。** `"not_found"` や
 *   `"already_forgotten"` に潰さない——それらは「見た上でそう判定した」だが
 *   こちらは「見ていない」であり、意味が違う（`ReextractSkip` の
 *   `not_examined` と同じ区別）。呼び出し側は `"failed"` の原因を解消してから
 *   `"not_attempted"` になった id だけを含めて `forget` を呼び直せる。
 */
export type ForgetOutcome =
  | { memoryId: MemoryId; kind: "forgotten"; previousStatus: MemoryStatus }
  | { memoryId: MemoryId; kind: "already_forgotten" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | { memoryId: MemoryId; kind: "failed"; error: string }
  | { memoryId: MemoryId; kind: "not_attempted" };

/** `runtime.forget` の任意オプション（Issue #102）。 */
export interface ForgetOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。「ユーザーの訂正で
   * 落ちた」と「運用の都合で落とした」を後から区別するためにある。省略時、
   * `meta` に `reason` キー自体を持たせない（`""` と「省略」を区別する）。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
}

/**
 * `runtime.forget` の結果（Issue #102）。
 *
 * **`forgottenCount` のような派生値を持たない。**`outcomes` を数えれば得られる
 * 値を欄として複製すると、「同じことを言う道が2つ在り、どちらか一方だけ直して
 * ずれる」というこのリポジトリが繰り返し踏んできた欠陥（`TICK_SUPPORTED_JOB_KINDS`・
 * `MAX_STRENGTH` の JSDoc 参照）を新しく作ることになる。
 */
export interface ForgetResult {
  /**
   * 入力（`ForgetTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる——1回目の処理結果が
   * 2回目の判定に反映される（例: 1回目が `"forgotten"` なら2回目は
   * `"already_forgotten"` になる）。
   */
  outcomes: ForgetOutcome[];
}

/**
 * `runtime.consolidate` の対象（Issue #103、ADR 0089。`{ seedMemoryId }` は
 * Issue #135、ADR 0152）。
 *
 * `{ memoryIds }` は `forget` の `ForgetTarget` と同じ規律——正規化せず、**重複も入力順も
 * そのまま保つ**。`{ query, maxCandidates }` は `recall(ctx, query)` を1回呼んで得られた
 * `memories` の id を順に採る（`maxCandidates` があれば先頭からその件数で切る）。
 *
 * `{ seedMemoryId }` は「この記憶に似ているものを mnemora 自身が集めて、1つに畳め」という
 * 意味である（ADR 0152）。`{ query, maxCandidates }` と違い、**「似ている」の判定
 * そのものを呼び手ではなく mnemora 側が行う**。ただし ADR 0089 却下案7・
 * `docs/roadmap.md` §5.7 が拒んだ「対象を自分で*列挙して*選ぶ」（active な記憶を走査して
 * どれから畳むかを決める）ことはしない——**起点（`seedMemoryId`）は必ず呼び手が渡す。**
 * mnemora が自分で決めるのは「起点に似ているものをどう集めるか」だけである。
 *
 * - 実装（`consolidate()` 内）: `seedMemoryId` の Memory を `get` し、その `digest` を
 *   `RecallQuery.text` にして `recall(ctx, { text })` を1回呼ぶ——`{ query }` 形と
 *   まったく同じ経路（同じ `recall()`）を通す。**新しい「似ている」の判定を作らない。**
 * - 「似ている」は `recall()` が既に使っている `affinity`
 *   （`strategies/scoring.ts`: `affinity = max(similarity, lexicalMatch)`）をそのまま使う
 *   （{@link computeAffinity}）。`minAffinity` 未満の候補は落とす。**既定は
 *   {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}。**
 * - **種（`seedMemoryId` そのもの）は `minAffinity` の判定を受けず、必ず候補に含める。**
 *   種の embedding がまだ無ければ ANN 段に載らず `recall()` の結果に現れないため
 *   （`embeddingStatus: 'pending'`。`consolidate` 自身が作る統合先の産物と同じ窓、
 *   ADR 0089「引き受けた負債」4）、`recall()` の結果に種が見つからなければ先頭に足す。
 *   見つかった場合も、`minAffinity` で弾かれないよう先頭に固定する（`affinity` の判定対象は
 *   種以外の候補だけ）。
 * - `maxCandidates` は「1回の統合に入れる上限」——`{ query }` 形と同じ意味。
 *   `[seedMemoryId, ...minAffinity を満たした近傍]` の順に並べたあと、先頭から切る
 *   （種は常に先頭にいるため、`maxCandidates >= 1` である限り必ず残る）。
 * - `seedMemoryId` が指す Memory が無い場合、`recall()` は呼ばない——
 *   対象は `[seedMemoryId]` の1件のみとなり、後続の `getMany` が `not_found` に分類する
 *   （新しい `nothingReason` を発明しない。下記 {@link ConsolidateNothingReason} 参照）。
 */
export type ConsolidateTarget =
  | { memoryIds: MemoryId[] }
  | { query: RecallQuery; maxCandidates?: number }
  | { seedMemoryId: MemoryId; maxCandidates?: number; minAffinity?: number };

/**
 * `{ seedMemoryId }` 形（Issue #135、ADR 0152）が使う `minAffinity` の既定値。
 *
 * 🔴 **この値は実測していない。**保守側（畳まない側）に倒した理由——統合元は
 * `superseded` へ動く（ADR 0089 決定1）ため、**取り違えて畳んだときの damage は
 * 「畳まなかった」より大きい。**緩めるのは `examples/chat` の `consolidation-cost`
 * （Issue #136、着地済み）で実際に測ってから判断する。`ConsolidateOptions.dryRun` が
 * あるので、呼び手は本番へ入れる前に何が畳まれるはずかを見られる。
 */
export const DEFAULT_CONSOLIDATE_MIN_AFFINITY = 0.8;

/**
 * `runtime.consolidate` の任意オプション（Issue #103、ADR 0089）。
 */
export interface ConsolidateOptions {
  target: ConsolidateTarget;
  /**
   * `true` なら **LLM を呼ばず・1件も書かず**、束ねられる対象だけを見て返す
   * （{@link ConsolidateSourceOutcome} の `"eligible"` を参照）。
   */
  dryRun?: boolean;
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /** `memory_events.meta.reason` へ足す補足。省略時は積まない（`ForgetOptions.reason` と同じ形）。 */
  reason?: string;
}

/**
 * `runtime.consolidate` 全体の結末（Issue #103、ADR 0089）。ADR 0008 の「無い」の分類の適用——
 * 「束ねるものが無かった」「そもそも見ていない」「LLM が落ちた」「下見だけ」を1つの `false` に
 * 潰さない。
 *
 * - `"consolidated"` — 統合先を1件作り、少なくとも1件を `superseded` へ動かした。
 * - `"nothing_to_consolidate"` — 対象を見た上で、束ねるものが無かった
 *   （{@link ConsolidateNothingReason} で細分）。
 * - `"not_examined"` — 対象そのものが空（`memoryIds: []`）、または `query` が0件だった
 *   ——store の Memory を1件も見ていない。
 * - `"llm_failed"` — LLM 呼び出しが失敗した。**1件も書いていない。**
 * - `"dry_run"` — 下見だけを行った。**1件も書いていない。**
 */
export type ConsolidateOutcome =
  "consolidated" | "nothing_to_consolidate" | "not_examined" | "llm_failed" | "dry_run";

/**
 * `ConsolidateOutcome: "nothing_to_consolidate"` の理由（Issue #103、ADR 0089）。
 *
 * - `"no_eligible_sources"` — 渡された/引けた対象のうち `status: 'active'` が0件。
 * - `"single_eligible_source"` — `active` が1件だけ。1件を1件に「統合」しない。
 */
export type ConsolidateNothingReason = "no_eligible_sources" | "single_eligible_source";

/**
 * `runtime.consolidate` が対象1件ごとに返す結末（Issue #103、ADR 0089）。
 * `ForgetOutcome` / `ReextractSkip` の語彙にできるだけ揃える——新しい `kind` を作らない。
 *
 * - `"superseded"` — この呼び出しで実際に `status` を `superseded` へ動かした。
 * - `"not_found"` — その id の Memory がそもそも無い（`ForgetOutcome` と同じ意味）。
 * - `"status_not_active"` — `status !== 'active'`（`forgotten` はここで確実に弾かれる。
 *   ADR 0089 §1）。
 * - `"status_changed_concurrently"` — compare-and-swap が破れた（TOCTOU。`reextract` の
 *   `status_changed_concurrently` と同じ意味）。
 * - `"failed"` — 競合以外の例外で書き込みが失敗した。**この時点で処理を打ち切る**
 *   （下の `"not_attempted"` 参照）。
 * - `"not_attempted"` — それより前の要素が `"failed"` になったため、まだ見ていない。
 * - `"eligible"` — `dryRun: true` のときだけ出る。`status === 'active'` で、実際に統合される
 *   側になったであろう対象。
 */
export type ConsolidateSourceOutcome =
  | { memoryId: MemoryId; kind: "superseded"; previousStatus: "active" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
  | { memoryId: MemoryId; kind: "status_changed_concurrently"; observedStatus: MemoryStatus | null }
  | { memoryId: MemoryId; kind: "failed"; error: string }
  | { memoryId: MemoryId; kind: "not_attempted" }
  | { memoryId: MemoryId; kind: "eligible" };

/**
 * `runtime.consolidate` の結果（Issue #103、ADR 0089）。
 *
 * ⛔ `consolidatedCount` のような派生値を持たない——`ForgetResult` と同じ理由
 * （`sources` を数えれば得られる）。
 */
export interface ConsolidationResult {
  outcome: ConsolidateOutcome;
  /**
   * {@link WriteAtomicity}。⛔ 省略可能にしない。
   *
   * `outcome` が `"consolidated"` 以外（`dry_run`・`nothing_to_consolidate`・
   * `not_examined`・`llm_failed`）のときは必ず `"not_attempted"`——書き込みを1件も
   * 試みていないからである。
   */
  atomicity: WriteAtomicity;
  /** `outcome === "nothing_to_consolidate"` のときだけ非 `null`。それ以外は必ず `null`。 */
  nothingReason: ConsolidateNothingReason | null;
  /** 作られた統合先の id。`outcome !== "consolidated"` のときは必ず `null`。 */
  consolidatedMemoryId: MemoryId | null;
  /**
   * 対象1件ごとの結末。**入力と同じ順序・同じ長さ**（`{ memoryIds }` のとき）。
   * 対象そのものを見ていない（`outcome === "not_examined"`）場合は空配列。
   */
  sources: ConsolidateSourceOutcome[];
  /** LLM を実際に呼んだ回数。`dryRun`・`not_examined`・`nothing_to_consolidate` は必ず `0`。 */
  llmCalls: number;
  /** `outcome !== "llm_failed"` のときは必ず `null`（`ReextractResult.extractionFailure` と同じ規律）。 */
  llmFailure: ExtractionFailure | null;
}

/**
 * `runtime.reflect` の対象（Issue #104。`{ seedMemoryId }` は Issue #204、ADR 0154）。
 * `consolidate` の {@link ConsolidateTarget} と**意図的に同じ形**——`reflect` に「何を見るか」を
 * 決めさせない。`target` を必須にしたのは、これを省略できると `reflect` 自身が対象を選ぶことに
 * なり、それは Background Cognition の*実運用*（Phase 1 の範囲外、docs/roadmap.md §1.3）の決定を
 * 先取りしてしまうためである。
 *
 * `{ memoryIds }` は正規化せず、**重複も入力順もそのまま保つ**。`{ query, maxCandidates }` は
 * `recall(ctx, query)` を1回呼んで得られた `memories` の id を順に採る（`maxCandidates` が
 * あれば先頭からその件数で切る）。
 *
 * `{ seedMemoryId }` は `ConsolidateTarget` の `{ seedMemoryId }`（ADR 0152）と**同じ土台選定**
 * を使う——種の `digest` を `RecallQuery.text` にして `recall()` を1回呼び、`computeAffinity`
 * （`strategies/consolidate.ts`、`max(similarity, lexicalMatch)`）が `minAffinity` 未満の
 * 候補を落とす。**新しい「似ている」は発明しない。**種そのものは判定を受けず、必ず先頭に
 * 含める（種の embedding がまだ `pending` で `recall()` に現れない窓があるため、
 * `ConsolidateTarget` の doc コメントと同じ理由）。
 *
 * ⚠ **`minAffinity` の既定値は `consolidate` と別の定数である**
 * （{@link DEFAULT_REFLECT_MIN_AFFINITY}、`consolidate` は {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}）。
 * `consolidate` と `reflect` は同じ道具に**逆向きの帯**を要求する——`consolidate` が欲しいのは
 * 「同じ事実の言い換え」（近いほどよい）、`reflect` が欲しいのは「関連するが同じではない
 * 複数の事実」（近すぎると導けるものが無い。同じ事実の写しを5枚並べて内省させても、
 * 新しい知識は出てこない）。低い閾値でよいもう1つの根拠: `reflect()` は既存行の `status` を
 * 1つも動かさない（ADR 0091 決定4）⟹ 取り違えたときの damage が `consolidate`（統合元が
 * `superseded` へ動く）より小さい⟹ 保守側へ倒す理由が `consolidate` ほど強くない。
 *
 * ⛔ **上限（近すぎるものを除く帯）は無い。**上限を入れると `reflect` が「何が重複か」を
 * 判断することになり、それは `consolidate` の仕事である（責務の二重化、Issue #103 が
 * 訴えたのと同じ形）。代わりに「`consolidate` が先に走っていれば重複は既に畳まれている」
 * という前提に乗る——**この前提は負債である**（ADR 0154「引き受けた負債」）。
 *
 * `seedMemoryId` が指す Memory が無い場合、`recall()` は呼ばない——対象は `[seedMemoryId]` の
 * 1件のみとなり、後続の `getMany` が既存の分類（`not_found`）にそのまま落とす（新しい
 * `nothingReason`/`ReflectBasisOutcome` は発明しない）。
 *
 * この形も `target` を呼び手が必須で渡す点は変わらない——`reflect` 自身が「何を見るか」を
 * 決めているわけではなく、ADR 0091 決定3（`target` 必須）に反しない（ADR 0154）。
 */
export type ReflectTarget =
  | { memoryIds: MemoryId[] }
  | { query: RecallQuery; maxCandidates?: number }
  | { seedMemoryId: MemoryId; maxCandidates?: number; minAffinity?: number };

/**
 * `{ seedMemoryId }` 形（Issue #204、ADR 0154）が使う `minAffinity` の既定値。
 *
 * 🔴 **この値は実測していない。**根拠は向きの議論だけであり、数字の根拠ではない
 * （`DEFAULT_CONSOLIDATE_MIN_AFFINITY` の JSDoc と同じ書き方）。`consolidate` の 0.8 より
 * 低くしてあるのは、`reflect` が「近すぎない」複数の事実を欲しがるためである
 * （{@link ReflectTarget} の doc コメント参照）。緩める/締めるのは、`reflect` 側の実測
 * （`consolidation-cost` に相当する reflect 側の計測）が入ってから判断する。
 */
export const DEFAULT_REFLECT_MIN_AFFINITY = 0.4;

/**
 * `runtime.reflect` の任意オプション（Issue #104）。
 */
export interface ReflectOptions {
  target: ReflectTarget;
  /**
   * `true` なら **LLM を呼ばず・1件も書かず**、土台になりうる対象だけを見て返す
   * （{@link ReflectBasisOutcome} の `"eligible"` を参照）。
   */
  dryRun?: boolean;
  /** `memory_events.actor`（`created` イベント）。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /** `memory_events.meta.reason` へ足す補足。省略時は積まない（`ConsolidateOptions.reason` と同じ形）。 */
  reason?: string;
}

/**
 * `runtime.reflect` 全体の結末（Issue #104）。`ConsolidateOutcome` と同じ2階層の
 * 「無い」の分類の適用——「一般化するものが無かった」「そもそも見ていない」「LLM が落ちた」
 * 「下見だけ」を1つの `false` に潰さない。
 *
 * - `"reflected"` — 新しい Memory を1件作った。`reflectedMemoryId` は非 `null`。
 * - `"nothing_to_reflect"` — 土台を見た上で、作るものが無かった
 *   （{@link ReflectNothingReason} で細分）。
 * - `"not_examined"` — 対象そのものが空（`memoryIds: []`）、または `query` が0件だった
 *   ——store の Memory を1件も見ていない。
 * - `"llm_failed"` — LLM 呼び出しが失敗した。**1件も書いていない。**
 * - `"dry_run"` — 下見だけを行った。**1件も書いていない。**
 */
export type ReflectOutcome =
  "reflected" | "nothing_to_reflect" | "not_examined" | "llm_failed" | "dry_run";

/**
 * `ReflectOutcome: "nothing_to_reflect"` の理由（Issue #104）。
 *
 * - `"no_eligible_basis"` — 渡された/引けた対象のうち、採れるもの
 *   （`status: 'active'` かつ `provenance.kind !== 'reflected'`）が0件。**LLM を呼んでいない**
 *   （`llmCalls: 0`）。
 * - `"llm_declined"` — LLM を呼び、モデルが「一般化するものは無い」と答えた
 *   （`outcome: 'nothing'`、`llmCalls: 1`）。**書き込みは0件。**
 */
export type ReflectNothingReason = "no_eligible_basis" | "llm_declined";

/**
 * `runtime.reflect` が対象1件ごとに返す結末（Issue #104）。`ConsolidateSourceOutcome` と
 * **意図的に違う語彙を持つ**——`reflect` は N→1 の置換ではなく「足す」操作であり
 * （既存の行の `status` を1つも動かさない）、書き込みの途中で対象1件だけが失敗しうる
 * `"status_changed_concurrently"` / `"failed"` / `"not_attempted"` は存在しない
 * （そもそも対象へ書き込みに行かないので、その種類の失敗が起きようがない）。
 *
 * - `"used"` — 実際に新しい Memory の `provenance.sources` に入った土台。
 * - `"not_found"` — その id の Memory がそもそも無い（`ConsolidateSourceOutcome` と同じ意味）。
 * - `"status_not_active"` — `status !== 'active'`（`forgotten` はここで確実に弾かれる）。
 * - `"basis_is_reflected"` — `status: 'active'` だが `provenance.kind === 'reflected'`。
 *   自己増幅（reflect の産物を土台にまた reflect すること）を形の側で止める。
 * - `"eligible"` — 土台として採れる状態だったが、この呼び出しでは結局使われなかった
 *   （`dryRun: true` で下見しただけ／LLM 呼び出しが失敗した／LLM が「無い」と答えた、
 *   のいずれか）。
 */
export type ReflectBasisOutcome =
  | { memoryId: MemoryId; kind: "used" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
  | { memoryId: MemoryId; kind: "basis_is_reflected" }
  | { memoryId: MemoryId; kind: "eligible" };

/**
 * `runtime.reflect` の結果（Issue #104）。
 *
 * ⛔ 派生値（`reflectedCount` 等）を持たない——`ConsolidationResult` と同じ理由
 * （`basis` を数えれば得られる）。
 */
export interface ReflectionResult {
  outcome: ReflectOutcome;
  /** `outcome === "nothing_to_reflect"` のときだけ非 `null`。それ以外は必ず `null`。 */
  nothingReason: ReflectNothingReason | null;
  /** 作られた Memory の id。`outcome !== "reflected"` のときは必ず `null`。 */
  reflectedMemoryId: MemoryId | null;
  /**
   * 対象1件ごとの結末。**入力と同じ順序・同じ長さ**（`{ memoryIds }` のとき、重複も保つ）。
   * 対象そのものを見ていない（`outcome === "not_examined"`）場合は空配列。
   */
  basis: ReflectBasisOutcome[];
  /** LLM を実際に呼んだ回数。`dryRun`・`not_examined`・`no_eligible_basis` は必ず `0`。 */
  llmCalls: number;
  /** `outcome !== "llm_failed"` のときは必ず `null`（`ConsolidationResult.llmFailure` と同じ規律）。 */
  llmFailure: ExtractionFailure | null;
}

export interface TickOptions {
  /**
   * claim のリース長（ミリ秒）。`ClaimOutboxJobsOptions.leaseMs`（ADR 0032）へそのまま渡す。
   * **必須・既定値なし**——リース長は「ワーカーが止まったとみなすまでの時間」という
   * 運用方針であり、`packages/core` が決めてよい値ではなく呼び出し側が決める。
   * これにより `tick(ctx)` を引数無しで呼ぶことはできない（意図した破壊的変更、ADR 0032）。
   */
  leaseMs: number;
  limit?: number;
  kinds?: OutboxJobKind[];
  claimedBy?: string;
}

/**
 * `tick` が claim したものの、**処理する分岐を持たなかった**ジョブ（ADR 0082）。
 * {@link TickResult.unsupported} の要素型。
 *
 * **件数の欄を持たない**（`ReextractSkip` / `StageSkippedOmission` に倣った形。ADR 0029）
 * ——ここは配列そのものが件数を持っている。
 */
export interface UnsupportedOutboxJob {
  /** `fail()` で終端に落とした outbox 行の id。どの行が焼かれたかを名指しできる。 */
  jobId: string;
  /** その行の `kind`。`TICK_SUPPORTED_JOB_KINDS` に無かったもの。 */
  kind: OutboxJobKind;
}

/**
 * 🔴 ADR 0142 / Issue #233: `tick` がジョブの結果を `complete`/`fail` で記録しようと
 * した時点で、既にリースを失っていた（`OutboxLeaseConflictError`）ジョブ。
 * {@link TickResult.leaseConflicts} の要素型。
 *
 * **これは失敗ではない。** リース競合が起きるのは、別のワーカーが既に同じジョブを
 * 再 claim して（成功にせよ失敗にせよ）終端まで進めた場合だけである——
 * `claimBatch` の `WHERE`（`completed_at IS NULL AND failed_at IS NULL`）が、
 * 終端化されていない行しか対象にしないため。**システムから見れば、そのジョブは
 * （このワーカー以外の誰かによって）既に済んでいる。**
 */
export interface OutboxLeaseConflict {
  /** 競合した outbox 行の id。 */
  jobId: string;
  /** その行の `kind`。 */
  kind: OutboxJobKind;
  /**
   * このワーカーが記録しようとしていた結果。`"complete"` はジョブの処理自体には
   * 成功したが、その結果を記録しようとした時点でリースを失っていたことを示す。
   * `"fail"` は、処理に失敗した（または `"complete"` の記録自体が競合以外の理由で
   * 失敗した）ため `fail()` で記録しようとしたが、それもリース切れで記録できな
   * かったことを示す。**いずれの場合も、この worker はジョブの最終的な結果に
   * 影響を与えていない**——別のワーカーが既に書いた結果がそのまま残る。
   */
  attemptedOutcome: "complete" | "fail";
}

export interface TickResult {
  processed: number;
  failed: number;
  /**
   * `failed` の**内訳**のうち、「処理を試みて失敗した」のではなく
   * 「`tick` がその kind を処理する分岐を持っていなかった」もの（ADR 0082、issue #105）。
   *
   * 🔴 **この欄が在る理由は1つだけ**——これが無いと、
   * 「embed の provider が落ちて失敗した」と「`kinds: ['consolidate']` を渡したが
   * `tick` は consolidate を処理できない」が、どちらも `failed: 1` という**同じ顔**になる。
   * それは ADR 0029 が `ReextractResult.skipped` で塞いだのと同じ族の欠落
   * （「無い」の種類を潰す）である。**`unsupported` に入ったジョブは `failed` にも数える**
   * ——`failed` の意味（この tick で終端の失敗になった件数）は変えていない。
   *
   * ⚠ **ここに出たジョブは `fail()` で終端に落ちている**（Phase 1 に自動リトライは無い。
   * ADR 0032）。黙って lease 切れを待つ形にはしない——claim したまま何もしないと、
   * 「claim され続けるがいつまでも進まない」という、まさに呼び出し側から見えない停止になる。
   *
   * 空配列が既定であり、`undefined` にはならない（「出なかった」と「見ていない」を
   * 同じ顔にしないため）。
   */
  unsupported: UnsupportedOutboxJob[];
  /**
   * 🔴 ADR 0142 / Issue #233: このジョブの結果を記録しようとした時点で、既にリースを
   * 失っていた（`OutboxLeaseConflictError`）ジョブ。**`processed` にも `failed` にも
   * 数えない**——「無い」の種類を潰さない、`unsupported` と同じ理由（ADR 0008 の族）。
   * 良性の競合（正常な並行の結果）を、失敗という別の顔に変えない。
   *
   * `tick` はこの例外を検知すると、**そのジョブだけを飛ばして残りのジョブの処理を
   * 続ける**——1件の良性の競合で、同じ `tick` 呼び出し内の他のジョブまで処理が
   * 止まるのは、狭い事象を広い停止に変換する形であり、避ける。
   *
   * 空配列が既定であり、`undefined` にはならない。
   */
  leaseConflicts: OutboxLeaseConflict[];
}

/**
 * {@link Runtime.sweepArchive} の返り値（ADR 0114）。
 *
 * `MemoryStore.archiveDecayed` は任意メソッドである。**store 側の
 * {@link ArchiveDecayedResult} をそのまま返り値にしない**——store 側の型には
 * 「口が無かった」を語る場所が無い（口が無ければそもそも呼べないので、store が
 * 自分について「対応していない」と言う機会が無い）。この違いを埋めるのが `supported`
 * である。
 *
 * ⛔ **`supported` を省略可能にしない**（`WriteAtomicity`（ADR 0100）と同じ理由——
 * `undefined` は「口が無かった」と「この欄が増える前の版の戻り値」の両方を意味して
 * しまい、「無い」の種類を潰す）。
 */
export interface SweepArchiveResult {
  /**
   * `MemoryStore.archiveDecayed` が実装されていたか。**`false` のとき `archived` は
   * 常に空配列・`reachedLimit` は常に `false`**——「対応していないので0件」であって
   * 「対応していて0件だった」ではない。呼び出し側はこの2つを取り違えないよう、
   * 必ず `supported` を先に見ること。
   */
  supported: boolean;
  /** 実際に archived にした Memory。`decay_floor_at` 昇順。`supported: false` なら常に空。 */
  archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }>;
  /** store 側の `ArchiveDecayedResult.reachedLimit` をそのまま運ぶ。`supported: false` なら常に `false`。 */
  reachedLimit: boolean;
}

/**
 * `runtime.restoreArchived` の対象（Issue #195、ADR 0122）。`ForgetTarget` と**意図的に
 * 同じ形**——`{ memoryId }`（単数）と `{ memoryIds }`（複数）のどちらでも同じ意味論であり、
 * 内部で `MemoryId[]` に正規化してから処理する。
 */
export type RestoreArchivedTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/** `runtime.restoreArchived` の任意オプション（Issue #195、ADR 0122）。`ForgetOptions` と同じ形。 */
export interface RestoreArchivedOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason`
   * キー自体を持たせない（`ForgetOptions.reason` と同じ規律）。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
}

/**
 * `runtime.restoreArchived` が対象1件ごとに返す結果（Issue #195、ADR 0122）。
 * `ForgetOutcome` と**同じ6つの `kind`**（`forgotten`/`already_forgotten` の位置が
 * `restored`/`status_not_archived` に入れ替わるだけ）——呼び出し側の次の一手が違う
 * 状況を1つの `boolean` に潰さない、という同じ「無い」の分類（ADR 0008）を適用する。
 *
 * - `"restored"`: 今回の呼び出しで実際に `status` を `archived` から `active` へ動かし、
 *   `memory_events` に `kind: 'restored'` を積んだ。`previousStatus` は常に `"archived"`
 *   （このメソッドが動かす遷移はこの1本だけであり、他の値を取らない）。
 *   **⚠ 2026-09 追記（マネージャー決定、Issue #196 / [ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）:
 *   `status` の復帰に続けて `MemoryStore.reinforce` も呼ぶ**（`decay_floor_at` を
 *   復帰の瞬間から引き直す。理由は `restoreArchived` の JSDoc・ADR 0153 を参照）。
 *   **`reinforce` が失敗しても、既に成功した `status` の復帰は握り潰さない**
 *   ——`kind` は `"restored"` のままで、失敗は `reinforceError` に運ぶ
 *   （additive。省略時は成功、または対象が無かった旧来の形と区別が付かないという
 *   ことはない——`reinforce` は必ず `status` の復帰の直後に試みるので、この欄が
 *   無ければ「試みて成功した」ことを意味する）。
 * - `"status_not_archived"`: 対象は最初から（または同じ呼び出し内の先行する要素の
 *   処理によって）`archived` ではなかった。**書き込みは一切起きていない。**
 *   `status` に現在値（`active`/`superseded`/`contested`/`forgotten` のいずれか）が入る。
 *   `ConsolidateSourceOutcome.status_not_active` と同じ命名規律——「対象は見た。
 *   だが前提の状態ではなかった」を1つの語で表す。
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い。
 * - `"conflicted"`: compare-and-swap が破れた——`getMany` で読んだ時点は `archived` だったが、
 *   実際に書きに行った時点では別の書き込みが割り込んでいた。**このメソッドは自動で
 *   再試行しない。**再読した結果が `"active"`（＝別の呼び出しがちょうど同じ復帰を
 *   先に済ませていた）だった場合は `"status_not_archived"` に含める——「求めていた状態に
 *   既に居る」ことは対立ではない（`forget` の `already_forgotten` と同じ扱い）。
 *   それ以外の状態に変わっていた場合だけ `"conflicted"` として `observedStatus` を運ぶ。
 * - `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: それより前の要素が `"failed"` になったため、まだ見ていない。
 */
export type RestoreArchivedOutcome =
  | {
      memoryId: MemoryId;
      kind: "restored";
      previousStatus: "archived";
      /**
       * `status` の復帰に続けて試みた `reinforce` が失敗した場合だけ在る
       * （マネージャー決定、Issue #196 / ADR 0153）。省略時（`undefined`）は
       * `reinforce` も成功したことを意味する——「試みていない」という第3の状態は
       * 無い（`reinforce` は復帰が成功した全件に対して必ず試みる）。
       */
      reinforceError?: string;
    }
  | { memoryId: MemoryId; kind: "status_not_archived"; status: Exclude<MemoryStatus, "archived"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | { memoryId: MemoryId; kind: "failed"; error: string }
  | { memoryId: MemoryId; kind: "not_attempted" };

/**
 * `runtime.restoreArchived` の結果（Issue #195、ADR 0122）。
 *
 * ⛔ `restoredCount` のような派生値を持たない（`ForgetResult`/`ConsolidationResult` と
 * 同じ理由——`outcomes` を数えれば得られる値を欄として複製すると、片方だけ直して
 * ずれるという、このリポジトリが繰り返し踏んできた欠陥を新しく作ることになる）。
 */
export interface RestoreArchivedResult {
  /**
   * 入力（`RestoreArchivedTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる（`ForgetResult.outcomes` と同じ規律）。
   */
  outcomes: RestoreArchivedOutcome[];
}

/**
 * `runtime.purge` の対象（Issue #198、ADR 0124）。`ForgetTarget`/`RestoreArchivedTarget` と
 * 意図的に同じ形——`{ memoryId }`（単数）と `{ memoryIds }`（複数）のどちらでも同じ意味論であり、
 * 内部で `MemoryId[]` に正規化してから処理する。
 */
export type PurgeTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

/** `runtime.purge` の任意オプション（Issue #198、ADR 0124）。`ForgetOptions`/`RestoreArchivedOptions` と同じ形に `dryRun` を足す。 */
export interface PurgeOptions {
  /**
   * 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason`
   * キー自体を持たせない（`ForgetOptions.reason` と同じ規律）。
   */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * 🔴 **下見（issue #198 の受け入れ条件が名指しする「dryRun 相当の下見」）。**
   * `true` のとき、一切の書き込み（`content`/`digest`/`purgedAt` の更新、
   * `memory_events` への追記、`VectorStore.delete`）を行わず、「実行していたら何が
   * 起きたか」だけを {@link PurgeOutcome} の `"would_purge"`/`"already_purged"`/
   * `"status_not_forgotten"`/`"not_found"` として返す。省略時 `false`。
   */
  dryRun?: boolean;
}

/**
 * `runtime.purge` が対象1件ごとに返す結果（Issue #198、ADR 0124）。
 * `ForgetOutcome`/`RestoreArchivedOutcome` と同じ「無い」の分類（ADR 0008）に、
 * `purge` 固有の2値（`"would_purge"`/`"already_purged"`）を足す。
 *
 * - `"purged"`: この呼び出しで実際に `content`/`digest` をトゥームストーンで上書きし、
 *   `purgedAt` を設定し、`memory_events` に `kind: 'purged'` を積んだ（`VectorStore.delete`
 *   もベストエフォートで試みた——失敗してもこの kind は変わらない。`Runtime.purge` の
 *   doc コメント参照）。`previousStatus` は常に `"forgotten"`。
 * - `"would_purge"`: `opts.dryRun: true` のとき、対象が `status === "forgotten"` かつ
 *   未 purge（`purgedAt` が `null`）であり、`dryRun: false` で呼べば `"purged"` に
 *   なったはずであることを示す。**書き込みは一切起きていない。**
 * - `"already_purged"`: 対象は既に purge 済み（`purgedAt` が非 `null`）だった。
 *   **書き込みは一切起きていない**（`dryRun` の有無に関わらず同じ kind——「何も起きない」
 *   という結論自体は `dryRun` で変わらない）。
 * - `"status_not_forgotten"`: 対象の `status` が `"forgotten"` ではなかった
 *   （`purge` は `forgotten` からのみ遷移できる、ADR 0124 決定1）。`status` に現在値が入る。
 *   **書き込みは一切起きていない。**
 * - `"not_found"`: そのテナントにその id の Memory がそもそも無い。
 * - `"conflicted"`: compare-and-swap が破れ、1回だけ再読した結果も上の3分岐のどれにも
 *   明確に分類できなかった——`forgotten` から抜け出す経路も、`purge` 以外に `purgedAt`
 *   を書く経路も本 PR の時点で存在しないため、**現在の実装では到達しない防御的な分類**
 *   （`forget`/`restoreArchived` と同じ、上限の無い再試行にしない安全弁）。
 * - `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
 * - `"not_attempted"`: それより前の要素が `"failed"` になった、または
 *   `MemoryStore.purgeMemory` が実装されていない（`PurgeResult.supported: false`）ため、
 *   この要素はまだ見ていない。
 */
export type PurgeOutcome =
  | { memoryId: MemoryId; kind: "purged"; previousStatus: "forgotten" }
  | { memoryId: MemoryId; kind: "would_purge"; previousStatus: "forgotten" }
  | { memoryId: MemoryId; kind: "already_purged" }
  | { memoryId: MemoryId; kind: "status_not_forgotten"; status: Exclude<MemoryStatus, "forgotten"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | { memoryId: MemoryId; kind: "failed"; error: string }
  | { memoryId: MemoryId; kind: "not_attempted" };

/**
 * `runtime.purge` の結果（Issue #198、ADR 0124）。
 *
 * ⛔ `purgedCount` のような派生値を持たない（`ForgetResult`/`RestoreArchivedResult` と
 * 同じ理由——`outcomes` を数えれば得られる値を欄として複製すると、片方だけ直してずれる
 * という、このリポジトリが繰り返し踏んできた欠陥を新しく作ることになる）。
 */
export interface PurgeResult {
  /**
   * `MemoryStore.purgeMemory` が実装されていたか。**`false` のとき `outcomes` は
   * 全要素が `"not_attempted"`**（`opts.dryRun` の有無に関わらず——`SweepArchiveResult.supported`
   * （ADR 0114）と同じ「無い」の扱い。この口を実装しない adapter に対しては、実際の
   * purge も下見も一様に「見ていない」と名乗る）。
   */
  supported: boolean;
  /**
   * 入力（`PurgeTarget` を正規化した `MemoryId[]`）と**同じ順序・同じ長さ**。
   * 入力に同じ id が2回現れたら、結果にも2回現れる（`ForgetResult.outcomes` と同じ規律）。
   */
  outcomes: PurgeOutcome[];
}

/**
 * `runtime.markContested` が対象1件（`first`/`second` のどちらか）ごとに分類する適格性
 * （Issue #197、ADR 0134）。**新しい語彙を作らない**——`ForgetOutcome`/`ConsolidateSourceOutcome`
 * が既に使っている `"not_found"`/`"status_not_active"`/`"eligible"` にそのまま揃える。
 *
 * - `"eligible"` — `status === "active"`。書き込みの CAS 条件を満たす。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_active"` — 存在はするが `status !== "active"`
 *   （既に `contested`・`superseded`・`archived`・`forgotten` のいずれか）。
 */
export type MarkContestedSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> };

/**
 * `runtime.markContested` 全体の結末（Issue #197、ADR 0134）。ADR 0008 の「無い」の分類の
 * 適用——「対象が適格でなかった」「書き込み時点で競合した」「対応していない」を
 * 1つの `false`/例外に潰さない。
 *
 * - `"contested"` — 両側を `status: 'contested'` へ動かし、`contestedWithId` を相互に
 *   設定した。**部分成功は無い**——`supersedeWithNewMemories` の `conflicted`（対象ごとに
 *   独立で部分成功を許す設計）とは違い、対向ペアは本質的に結合しているため全部成功する
 *   か全部失敗するかのどちらかである。
 * - `"ineligible"` — `getMany` で読んだ時点で、どちらか一方（または両方）が
 *   `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では両側とも `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU）。1回だけ再読した現在の
 *   `status` を `conflicts` に積む。
 * - `"not_attempted"` — `MemoryStore.markContestedPair` が実装されていない
 *   （`MarkContestedResult.supported: false`）。フォールバック経路は無い
 *   （`archiveDecayed`/`purgeMemory` と同じ理由——`contestedWithId` を書ける経路は
 *   この口以外に無い）。
 */
export type MarkContestedOutcome =
  | { kind: "contested"; first: Memory; second: Memory }
  | { kind: "ineligible"; sides: [MarkContestedSideOutcome, MarkContestedSideOutcome] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/**
 * `runtime.markContested` の任意オプション（Issue #197、ADR 0134）。`ConsolidateOptions`/
 * `ForgetOptions` と同じ形。
 */
export interface MarkContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値 `'contested'` であり、
   * この欄では上書きしない——`consolidate`/`reflect` の `opts.reason` → `meta.note` と
   * 同じ形）。省略時は `meta` に `note` キー自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.markContested` の結果（Issue #197、ADR 0134）。
 */
export interface MarkContestedResult {
  /**
   * `MemoryStore.markContestedPair` が実装されていたか。**`false` のとき `outcome` は
   * 必ず `{ kind: "not_attempted" }`**（`PurgeResult.supported`（ADR 0124）と同じ「無い」の
   * 扱い）。
   */
  supported: boolean;
  outcome: MarkContestedOutcome;
}

/**
 * `runtime.resolveContested` が対象1件（`first`/`second` のどちらか）ごとに分類する適格性
 * （Issue #197、ADR 0150）。**新しい語彙を作りすぎない**——`MarkContestedSideOutcome` が
 * 既に持つ `"not_found"`/`"eligible"` はそのまま使う。この操作固有に足すのは2つだけである。
 *
 * - `"eligible"` — `status === "contested"` かつ、相手の `contestedWithId` が互いを指して
 *   いる（`first.contestedWithId === second.id` かつ `second.contestedWithId === first.id`）。
 *   書き込みの CAS 条件を満たす。
 * - `"not_found"` — そのテナントにその id の Memory がそもそも無い。
 * - `"status_not_contested"` — 存在はするが `status !== "contested"`。`status` に現在値が
 *   入る。
 * - `"pair_broken"` — `status === "contested"` ではあるが、相互参照が成立していない
 *   （`contestedWithId` が相手を指していない、または `null`）。[ADR 0046](../../../docs/decisions/0046-contested-pair-invariant-tooth.md)
 *   が数え上げた「一対一が破れた状態」の読み取り側の反映であり、`markContestedPair`
 *   （ADR 0134）を経由する限り今日の実装では到達しないはずだが、`PurgeOutcome` の
 *   `"conflicted"` と同じ「防御的な分類」として残す。`contestedWithId` に観測した現在値
 *   （`null` を含む）が入る。
 */
export type ResolveContestedSideOutcome =
  | { memoryId: MemoryId; kind: "eligible" }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "status_not_contested"; status: Exclude<MemoryStatus, "contested"> }
  | { memoryId: MemoryId; kind: "pair_broken"; contestedWithId: MemoryId | null };

/**
 * `runtime.resolveContested` に「どちらが正しいか」を渡すための判別可能 union
 * （Issue #197、ADR 0150）。**この型自身は何も判定しない**——呼び出し側が既に下した決定を
 * 運ぶだけである（`resolveContested` の interface JSDoc 参照）。
 *
 * - `"supersede"` — `winnerId` 側が勝ち残る。勝った側は `status: "active"`、負けた側は
 *   `status: "superseded"` + `supersededById: <勝者>` になる。
 * - `"both_active"` — どちらも正しかった（対向ではなかったと分かった）。両側とも
 *   `status: "active"` に戻る。`docs/memory-model.md` §11 lifecycle 行7の
 *   「（負けた側は）」という括弧書きが、負けた側が存在しない決着を許している。
 */
export type ContestedResolution =
  { kind: "supersede"; winnerId: MemoryId } | { kind: "both_active" };

/**
 * `runtime.resolveContested` 全体の結末（Issue #197、ADR 0150）。`MarkContestedOutcome`
 * と対称——「対象が適格でなかった」「書き込み時点で競合した」「対応していない」を
 * 1つの `false`/例外に潰さない（ADR 0008 の「無い」の分類の適用）。
 *
 * - `"resolved"` — 両側を解決後の状態へ動かした。**部分成功は無い**——対向ペアは本質的に
 *   結合しているため（`MarkContestedOutcome` の `"contested"` と同じ理由）。
 * - `"ineligible"` — `getMany` で読んだ時点で、どちらか一方（または両方）が
 *   `"eligible"` でなかった。**書き込みは一切試みていない。**
 * - `"conflict"` — 読んだ時点では両側とも `"eligible"` だったが、書き込み時点で
 *   {@link MemoryStatusConflictError} が投げられた（TOCTOU）。`markContested` と同じく
 *   **1回だけ**再読した現在の `status` を `conflicts` に積み、そこで打ち切る
 *   （上限の無い再試行ループにしない）。
 * - `"not_attempted"` — `MemoryStore.resolveContestedPair` が実装されていない
 *   （`ResolveContestedResult.supported: false`）。フォールバック経路は無い
 *   （`markContestedPair`/`archiveDecayed`/`purgeMemory` と同じ理由——`contestedWithId` を
 *   `null` へ戻せる口はこの口以外に無い。`resolveContestedPair` の interface JSDoc 参照）。
 */
export type ResolveContestedOutcome =
  | { kind: "resolved"; first: Memory; second: Memory }
  | { kind: "ineligible"; sides: [ResolveContestedSideOutcome, ResolveContestedSideOutcome] }
  | {
      kind: "conflict";
      conflicts: ReadonlyArray<{ id: MemoryId; observedStatus: MemoryStatus | null }>;
    }
  | { kind: "not_attempted" };

/**
 * `runtime.resolveContested` の任意オプション（Issue #197、ADR 0150）。`MarkContestedOptions`
 * と同じ形。
 */
export interface ResolveContestedOptions {
  /** `memory_events.actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * `memory_events.meta.note` へ足す補足（`meta.reason` は常に固定値
   * `'contested_resolved'` であり、この欄では上書きしない——`markContested`/`consolidate`/
   * `reflect` の `opts.reason` → `meta.note` と同じ形）。省略時は `meta` に `note` キー
   * 自体を持たせない。
   */
  reason?: string;
}

/**
 * `runtime.resolveContested` の結果（Issue #197、ADR 0150）。
 */
export interface ResolveContestedResult {
  /**
   * `MemoryStore.resolveContestedPair` が実装されていたか。**`false` のとき `outcome` は
   * 必ず `{ kind: "not_attempted" }`**（`MarkContestedResult.supported`（ADR 0134）と同じ
   * 「無い」の扱い）。
   */
  supported: boolean;
  outcome: ResolveContestedOutcome;
}

export interface Runtime {
  observe(ctx: Ctx, input: ObserveInput): Promise<ObserveResult>;
  /**
   * outbox に溜まったジョブを消化する（docs/architecture.md §3.3）。
   * `extract: 'deferred'` かつ `InlineScheduler`（キュー無し）構成では、これを誰かが
   * 明示的に呼ばない限り抽出・埋め込みは永久に走らない——「キューが無ければ黙って
   * 何も起きない」を作らない、という設計方針をそのまま体現する。
   *
   * `opts.leaseMs` は必須（ADR 0032）。`tick(ctx)` を引数無しで呼ぶことはできない
   * ——`claimBatch` の claim リース長は運用方針であり、`packages/core` が既定値を
   * 発明せず呼び出し側に決めさせるための意図した破壊的変更。
   *
   * 🔴 **処理する kind は {@link TICK_SUPPORTED_JOB_KINDS} が唯一の出所である**
   * （ADR 0082、issue #105）。`opts.kinds` の既定値もそこを指す。そこに無い kind を
   * `opts.kinds` に明示して渡した場合、そのジョブは claim され、**終端で失敗し**
   * （`fail()`。Phase 1 に自動リトライは無い）、{@link TickResult.unsupported} に
   * **名指しで**出る。黙って何も起きないまま lease が切れる形にはしない。
   *
   * ⚠ `OutboxJobKind` に名前が在ることと `tick` が処理することは**別である**——
   * その型の JSDoc も参照。
   */
  tick(ctx: Ctx, opts: TickOptions): Promise<TickResult>;
  /**
   * roadmap.md 段階4「想起」・段階5「説明」。docs/recall.md §2 の7段パイプライン
   * （実装は `./recall-runtime.js` の `runRecall`）。
   */
  recall(ctx: Ctx, query: RecallQuery): Promise<RecallResult>;
  /**
   * [Issue #312](https://github.com/takecchi/mnemora/issues/312) /
   * [ADR 0161](../../../docs/decisions/0161-runtime-get-recall.md):
   * `recall()` が返した `RecallId` から、その recall が実際に何を・どの内訳で返したかを
   * **後から**読み戻す。
   *
   * ⚠ **その場の {@link RecallResult}（`recall()` の戻り値）ではなく、後から `recallId` で
   * 引く口である。**`recall()` を呼んだ時点の変数がスコープを抜けた後でも、`recallId` さえ
   * 持っていれば同じ内訳（`score`/`retrievedVia`/`companionOf`/`associationOf`）に
   * 後から届く——`docs/north-star.md`「目指す姿」の「なぜそれを思い出したのかを、
   * 後から説明できる。」の**「後から」**を、`Runtime` だけを持つ採用側にも届かせるための
   * 口である（ADR 0155 は `MemoryStore.getRecall` を用意したが、`Runtime` には出していない
   * ——本 issue はその欠落を埋める）。
   *
   * 見つからない（そもそも存在しない `recallId`）、または別テナントの recall なら
   * `null` を返す（例外にしない。`MemoryStore.get`/`getObservation`/`getRecall` と同じ規律）。
   *
   * 引数と返り値は {@link RecallId} / {@link RecallRecord} を**そのまま使う**（`TickOptions`
   * のように別の型を立てない）。この口は
   * `MemoryStore.getRecall`（`../interfaces/memory-store.js`）へそのまま素通しするだけで、
   * runtime 側が足す選択肢が1つも無いためである——`reembed`（ADR 0079、上の doc コメント
   * 参照）と同じ理由: **同じ形の型を2つ置くと、片方だけ直したときに黙ってずれる。**
   *
   * 🔴 **`RecallRecord.returnedMemories` は `memoryId`/`score`/`retrievedVia`/
   * `companionOf`/`associationOf` までしか運ばない——`digest` には届かない。**`recall()`
   * の戻り値（`RecalledMemory`）には `digest` が在るのに対して非対称である（ADR 0155
   * 決定1が `digest` を「後から `MemoryStore.get()` で再現できる」という理由で
   * `recalls` へ複製しなかったため）。`Runtime` には記憶を1件読む口が無いため、
   * `digest` まで要る採用側は `MemoryStore` を自前で保持する必要がある——検討の詳細は
   * ADR 0161 の「検討して採らなかった案」を参照。
   */
  getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null>;
  /**
   * ADR 0028: ADR 0013 が未解決のまま残した「失敗した抽出をやり直す」操作。
   * 指定した Observation に対してもう一度 `extractCandidates` を走らせ、成功したら
   * 同じ `(sourceObservationId, extractorVersion)` を持つ既存の `active` Memory のうち
   * 今回作られなかったもの（content_hash が今回の集合に無いもの）を `superseded` にする。
   * 安全弁3つ（LLM がまた失敗したら何もしない・候補0件なら何もしない・compare-and-swap で
   * TOCTOU の競合を検知する）は `ReextractResult` の doc コメントを参照。
   */
  reextract(ctx: Ctx, observationId: ObservationId): Promise<ReextractResult>;
  /**
   * ADR 0079: 索引に載っていない Memory を**もう一度索引へ載せに行く**。
   *
   * `recall` は `omitted` に `{ kind: 'not_indexed', reason }` を積んで
   * 「索引されていない N 件がある」と正しく名乗る。docs/recall.md §4 はその `reason` に
   * 応じた次の一手（`pending` は待つ・再試行する、`failed` は埋め込みパイプラインを疑う）
   * まで案内している。**この口は、その案内どおりに動くための操作である**——
   * 埋め込みの provider が落ちていた間に入った Memory は、provider が直っても
   * 自力では索引へ戻らない（`fail` は終端であり、Phase 1 に自動リトライは無い。ADR 0032）。
   *
   * ⚠ **`reextract` とは別の操作である。**`reextract` は**抽出**をやり直す
   * （Observation から Memory を作り直す）。こちらは既にある Memory の**埋め込み**を
   * やり直す。
   *
   * **このメソッド自身は埋め込みを行わない。**`MemoryStore.requeueEmbedJobs` を呼んで
   * `embed` ジョブを積み直すだけであり、実際に埋め込むのは次の `tick()` である
   * ——「キューが無ければ黙って何も起きない」を作らない、という `tick` の設計方針
   * （上の doc コメント）をここでも崩さない。**呼んだだけでは索引は埋まらない。**
   *
   * 引数と返り値は {@link RequeueEmbedJobsOptions} / {@link RequeueEmbedJobsResult} を
   * **そのまま使う**（`TickOptions` のように別の型を立てない）。この口は store の同名
   * メソッドへ素通しするだけで、runtime 側が足す選択肢が1つも無いためである——
   * 同じ形の型を2つ置くと、片方だけ直したときに黙ってずれる。
   */
  reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
  /**
   * [ADR 0114](../../../docs/decisions/0114-archive-sweep-for-decayed-memories.md):
   * `docs/memory-model.md` §11 行8「`decay_floor_at < now()` を検出する低頻度の掃引…
   * → `status='archived'` + `archived` イベント」を実行する。
   *
   * `MemoryStore.archiveDecayed`（任意メソッド）へ素通しする——`reembed`（ADR 0079）と
   * 同じ形。引数の型 {@link ArchiveDecayedOptions} を store 側とそのまま共有している
   * のも同じ理由（同じ形の型を2つ置くと片方だけ直したときに黙ってずれる）。
   *
   * ⭐ **`opts.clock` を省略した場合に限り、この口が `tenant_settings.decay_clock` を
   * 読んで補う**（Issue #364 /
   * [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * `'wall'`（既定）なら `decayFloorAt <= now` のまま、`'activity'`/`'either'` なら
   * `nowSeq`（`tenant_activity.activity_seq`）も併せて読んで store へ渡す。**`opts.clock`
   * を明示で渡したときはそちらが勝ち、この口は `tenant_settings`/`tenant_activity` を
   * 一切読まない。** `decay_clock` を設定していないテナントの挙動は本 ADR の前後で
   * 1バイトも変わらない。
   *
   * store がこの口を実装していなければ `{ supported: false, archived: [], reachedLimit:
   * false }` を返す——黙って0件を返すのではなく「対応していない」と名指しする
   * （ADR 0082「黙って何も起きない形にしない」の哲学をここでも守る）。
   *
   * ⚠ **`reextract`/`consolidate`（ADR 0100）と違い、フォールバック経路を持たない。**
   * `supersedeWithNewMemories` は「口が無ければ今日どおりの2段の書き込みで代替できる」
   * 既存の経路があったが、この掃引には代替経路がそもそも存在しない——`decay_floor_at`
   * を読んで `archived` にする経路はこの口以外に無い。⟹ 「対応していない」を返す
   * だけで、それ以上の代替を試みない。
   *
   * 🔴 **この掃引は自動では一度も走らない。**`tick()`/`observe()` からは呼ばれない
   * ——呼び出し側が明示的にこれを呼んだときだけ走る保守操作である（`reembed` と
   * 同じ立場。`opts.now`/`opts.limit` のどちらにも既定値を置かない規律も共有する）。
   */
  sweepArchive(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<SweepArchiveResult>;
  /**
   * Issue #195（[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md)）:
   * `archived` な Memory を、呼び出し側が**明示的に**取り戻す。`sweepArchive`
   * （ADR 0114）が閉じる方向（`active` → `archived`）だけを持っていた片道を、
   * 開く方向（`archived` → `active`）で埋める——`docs/north-star.md` が引くオーナー
   * 仕様§48「必要な場合だけ過去の記憶を再び呼び戻せる」の、その「呼び戻せる」側。
   *
   * 🔴 **`MemoryStore` に新しい任意メソッドを足していない。**`sweepArchive`
   * （`archiveDecayed?`）と違い、この操作は「`status` を1つ動かし、同一トランザクションで
   * `memory_events` に1件積む」という、**既に必須メソッドとして存在する
   * `MemoryStore.updateStatusWithEvent`（ADR 0031）がそのまま満たせる形**をしている
   * ——`archived` → `active` への compare-and-swap を撃つだけであり、`archiveDecayed`
   * のような「範囲走査して複数件を一度に選ぶ」独自のクエリ形状を必要としない。
   * **⟹ `supported: false` を名乗る余地が無い**（`MemoryStore` を実装するすべての
   * adapter で、追加のコードなしに今日から動く）。
   *
   * 手順（`forget` (`ForgetOutcome` の doc コメント) と同じ骨格。**新しいメソッドを
   * 足さない代わりに、アルゴリズムの形をできる限り揃えた**）:
   * 1. `target` を `MemoryId[]` に正規化する。空配列は store に一切触れず
   *    `{ outcomes: [] }`。
   * 2. `getMany` で一括読み。存在しなければ `"not_found"`。`status !== "archived"`
   *    なら `"status_not_archived"`（現在の `status` を添える。書き込み無し）。
   * 3. それ以外（`status === "archived"`）は、観測した `"archived"` を `expectedStatus`
   *    にした compare-and-swap で `updateStatusWithEvent(ctx, id, "active",
   *    { expectedStatus: "archived" }, { kind: "restored", ... })` を呼ぶ。
   *    {@link MemoryStatusConflictError} が投げられたら**1回だけ**再読し、
   *    再読した `status` が `"active"`（＝別の呼び出しが先に同じ復帰を済ませていた）
   *    なら `"status_not_archived"`、`null`（行が無くなっていた）なら `"not_found"`、
   *    それ以外なら `"conflicted"` として `observedStatus` を返す——**上限の無い
   *    再試行ループにはしない**（`forget` と同じ安全弁）。
   * 4. それ以外の例外は `"failed"` を積んだ上で**その場で処理を打ち切り**、残りの
   *    対象は一切試みずに `"not_attempted"` として返す。例外はこのメソッドの外へは
   *    投げない。
   *
   * `memory_events` へ積むイベントの `kind` は `"restored"`
   * （[ADR 0122](../../../docs/decisions/0122-restore-archived-memory.md) が
   * `MemoryEventKind` へ足した新しい値）。`digestSnapshot` にはその Memory の
   * 現在の `digest` を入れ、**`content`（本文）は運ばない**（`forget`/`reextract` と
   * 同じ規律。docs/memory-model.md §9）。`opts.reason` を渡すと `meta.reason` に入り、
   * 省略すると `meta` に `reason` キー自体を持たせない。
   *
   * ⚠ **2026-09 訂正（マネージャー決定、Issue #196 / [ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）:
   * `decay_floor_at` は動かす。** ADR 0122 の当初決定は「復帰と強化は別の操作であり、
   * `decay_floor_at` の再計算は複製しない。居着かせたい呼び出し側が `reinforce` を
   * 別途呼ぶこと」だった。**この決定は ADR 0153 が覆した。** 理由は、ADR 0153 が
   * `recall()` に既定 ON の忘却ゲート（`decayFloorAt <= now` の Memory を候補から
   * 除外する）を導入したことで、上記の「引き受けた負債」が実害に変わったため——
   * `sweepArchive` が `archived` にする選定条件は、テナントの `decay_clock`（既定
   * `'wall'`）に従う——`'wall'` なら `decayFloorAt <= now`、`'activity'`/`'either'`
   * なら `decayFloorSeq <= nowSeq` を軸に含む（Issue #364 /
   * [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * `restoreArchived` の対象は定義上、いずれの軸であってもこの条件を満たす。⟹ `reinforce` を
   * 別途呼ばない限り、`status` は `"active"` に戻っても**既定では recall に二度と
   * 現れない**——呼び出し側から見ると「restored と言われたのに何も返ってこない」。
   * これは `docs/north-star.md`「目指す姿」の逐語「必要な場合だけ過去の記憶を
   * 再び呼び戻せる」と正面から食い違う（`AGENTS.md`「正典と実装が食い違ったら、
   * バグなのは実装のほう」）。**⟹ このメソッドは、`status` の復帰に成功した対象へ
   * 続けて `MemoryStore.reinforce(ctx, id, now)` を呼ぶ**（新しい interface・adapter
   * は増やさない。既存の契約された口をそのまま呼ぶだけ）。**復帰させるという行為
   * そのものが「この記憶がいま必要だ」という明示の信号であり、北極星が言う
   * 「必要な場合」に当たる、というのが ADR 0153 の意味づけである。**
   *
   * `reinforce` が失敗しても、既に成功した `status` の復帰は握り潰さない——`outcomes`
   * の `kind` は `"restored"` のままで、失敗は `RestoreArchivedOutcome` の
   * `reinforceError` に運ぶ（`RestoreArchivedOutcome` の doc コメント参照）。
   *
   * ⚠ **`recall()` 自身は一切変更していない。**`status` が `"active"` へ戻った時点で、
   * 段1の候補生成が使う既存の status ゲート（`["active","contested"]`、
   * `recall-runtime.ts`）へ他の `active` な Memory と全く同じ経路で合流する——
   * `docs/recall.md` §2 段0「スコープの外延」・§5 の被覆不変条件のどちらも、
   * この操作のために1行も変更していない。**変わったのはこのメソッドが `reinforce`
   * も呼ぶようになったことだけであり**、それによって `decayFloorAt` が「いま」より
   * 先へ進むので、既定の忘却ゲート（ADR 0153）を通過できるようになる。
   */
  restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult>;
  /**
   * Issue #102: Memory を**論理的に**忘れさせる。
   *
   * **行も `content` も消さない。**`status` を `'forgotten'` へ動かすだけで、
   * 物理削除（`purge()`）は Phase 2 の別操作である（docs/memory-model.md
   * 「forget() と purge() を分ける」）。`status` の更新と `memory_events` への
   * `kind: 'forgotten'` の追記は `MemoryStore.updateStatusWithEvent`
   * （ADR 0031）で**同一トランザクション**として行う——片方だけ起きることはない。
   *
   * `memory_events` の `digestSnapshot` にはその Memory の `digest` を入れる。
   * **`content`（本文）は運ばない**（docs/memory-model.md §9: 監査ログに残す
   * 記録項目は digest のスナップショットに限る）。
   *
   * `forgotten` は `recall()` の候補生成の status ゲート（`['active','contested']`）
   * に含まれないため、このメソッドを呼んだ後の `recall()` には対象の Memory が
   * 一切出てこなくなる（`omitted` に `{ kind: 'filtered', condition: 'forgotten' }`
   * として計上される。ADR 0027）。**`recall` 側のコードはこの機能のために
   * 一切変更していない**——ゲートも `omitted` の分類も既に在ったものをそのまま使う。
   *
   * **冪等である。**既に `forgotten` な Memory を対象に含めても書き込みは起きず
   * `{ kind: 'already_forgotten' }` を返す。同じ id を同じ呼び出しの中に複数回
   * 渡しても、`memory_events` に積まれるのは高々1件——1回目の結果を2回目が見る。
   *
   * 対象は `target` を `MemoryId[]` に正規化した上で**入力順に**処理する:
   * - 対象が存在しない、または compare-and-swap の再読で `null` になった場合は
   *   `{ kind: 'not_found' }`。
   * - 既に `forgotten` の場合は `{ kind: 'already_forgotten' }`（書き込み無し）。
   * - それ以外は観測した現在の status を `expectedStatus` にした
   *   compare-and-swap で `forgotten` へ更新する。{@link MemoryStatusConflictError}
   *   が投げられたら**1回だけ**再読し、再読の結果に応じて `not_found` /
   *   `already_forgotten` / `{ kind: 'conflicted', observedStatus }` のいずれかを
   *   返す——**上限の無い再試行ループにはしない。**
   * - それ以外の例外（DB 接続断等）は `{ kind: 'failed', error }` を積んだ上で
   *   **その場で処理を打ち切り**、残りの対象は一切試みずに
   *   `{ kind: 'not_attempted' }` として返す。例外はこのメソッドの外へは
   *   投げない。
   *
   * `kind` の意味と呼び出し側の次の一手は {@link ForgetOutcome} の doc コメントに
   * 詳しい。`target` が空配列（`{ memoryIds: [] }`）なら、store に一切触れずに
   * `{ outcomes: [] }` を返す。
   */
  forget(ctx: Ctx, target: ForgetTarget, opts?: ForgetOptions): Promise<ForgetResult>;
  /**
   * Issue #198（docs/roadmap.md §5.3、[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）:
   * `forgotten` な Memory を**物理削除**する。`forget()` が可逆な論理削除（`status` を
   * 動かすだけ）であるのに対し、`purge()` は不可逆——`content`/`digest` を固定の
   * トゥームストーン文字列で上書きし、`purgedAt` を設定する。**行そのものは消さない**
   * （`memory_events` からの外部キー参照整合性のため。docs/memory-model.md
   * 「forget() と purge() を分ける」）。
   *
   * 🔴 **`forgotten` からのみ遷移できる。**`active`/`archived`/`superseded`/`contested`
   * な Memory を直接 purge することはできない——`forget → purge` の二段階を、不可逆操作
   * に対する最小の安全弁にする（ADR 0124 決定1。`docs/memory-model.md` §11 lifecycle 表
   * 行10が既に `forgotten → purged` とだけ書いている）。`status` がそれ以外の対象は
   * `status_not_forgotten` を返し、書き込みは一切起きない。
   *
   * 🔴 **`MemoryStore.purgeMemory`（任意メソッド）が無い adapter では、この操作は
   * 一切実行できない。**`{ supported: false, outcomes: [...すべて "not_attempted"] }`
   * を返す——`sweepArchive`（ADR 0114）と同じ「フォールバック経路を持たない」形
   * （`content`/`digest`/`purgedAt` を書く経路はこの口以外に無いため）。`opts.dryRun`
   * の有無に関わらず同じ扱いにする——下見だけを許して実際の purge を許さない adapter を
   * 作ると、下見が約束する内容と実際の振る舞いが食い違いうる。
   *
   * 手順（`forget`/`restoreArchived` と同じ骨格。**CAS の条件だけが違う**——下記参照）:
   * 1. `target` を `MemoryId[]` に正規化する。空配列は store に一切触れず
   *    `{ supported: <purgeMemory の有無>, outcomes: [] }`。
   * 2. `deps.memoryStore.purgeMemory` が無ければ、ここで打ち切り全対象を
   *    `{ supported: false, outcomes: [...すべて "not_attempted"] }` として返す。
   * 3. `getMany` で一括読み。存在しなければ `"not_found"`。`status !== "forgotten"`
   *    なら `"status_not_forgotten"`（現在の `status` を添える。書き込み無し）。
   *    `status === "forgotten"` かつ `purgedAt` が非 `null` なら `"already_purged"`
   *    （書き込み無し）。
   * 4. それ以外（`status === "forgotten"` かつ `purgedAt === null`）は、`opts.dryRun`
   *    なら書き込みをせず `"would_purge"` を返す。そうでなければ
   *    `deps.memoryStore.purgeMemory(ctx, id, { content: PURGE_TOMBSTONE_CONTENT,
   *    digest: PURGE_TOMBSTONE_DIGEST }, event)` を呼ぶ。成功したら `"purged"` を返し、
   *    続けて `deps.vectorStore.delete(ctx, deps.embeddingProvider.space, id)` を
   *    ベストエフォートで試みる（例外は握り潰す——ADR 0124 決定5。`MemoryStore` 側の
   *    書き込みは既に確定しているため、この失敗を理由に `"purged"` を `"failed"` に
   *    格下げすると「安全に再試行できる」という `"failed"`/`"not_attempted"` の意味を
   *    裏切る）。
   * 5. {@link MemoryPurgeConflictError} が投げられたら**1回だけ**再読し、
   *    再読した `purgedAt` が非 `null` なら `"already_purged"`、`status` が
   *    `"forgotten"` でなければ `"status_not_forgotten"`、行が消えていれば
   *    `"not_found"`、それ以外（`status === "forgotten"` かつ `purgedAt === null` の
   *    まま）なら `"conflicted"`——**上限の無い再試行ループにはしない。**
   * 6. それ以外の例外（DB 接続断等）は `"failed"` を積んだ上で**その場で処理を打ち切り**、
   *    残りの対象は一切試みずに `"not_attempted"` として返す。例外はこのメソッドの外へは
   *    投げない。
   *
   * `memory_events` へ積むイベントの `kind` は `"purged"`（`MemoryEventKind` に
   * 既に在る値——追加していない）。`digestSnapshot` には上書き**前**の digest を入れ、
   * **`content`（本文）は運ばない**（`forget`/`restoreArchived` と同じ規律。
   * docs/memory-model.md §9）。`opts.reason` を渡すと `meta.reason` に入り、省略すると
   * `meta` に `reason` キー自体を持たせない。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**`TICK_SUPPORTED_JOB_KINDS` に
   * `purge` 相当の job kind を足していない・`observe()` の入力分岐に `purge` を混ぜて
   * いない——issue #198 が要求する「明示的でない経路からは絶対に呼ばれない」ことを、
   * 歯（`purge.test.ts`）で実測する。
   *
   * ⚠ **`recall()`/`aggregateScope` 側は一切変更していない。**`purge` は `status` を
   * 動かさないため、purge された Memory は purge の前後を通じて常に `status = 'forgotten'`
   * であり——`docs/recall.md` §2 段0・§5 の決定（スコープ = tenant + subject + period +
   * taxonomy + status ゲート、status ゲートで落ちた Memory はスコープ内に含まれない）
   * により、そもそも一度も「スコープ内」に入ったことが無い。群カウント
   * （`ScopeAggregate.groups`/`totalInScope`）に触れようがない（ADR 0124 決定6）。
   */
  purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult>;
  /**
   * Issue #197（ADR 0134）: `docs/memory-model.md` §11 lifecycle 行6「判定できない対向を
   * 検出 → 両側の `status='contested'`、`contested_with_id` を相互に設定」を実行する
   * **明示的操作**。
   *
   * **この操作自身は「矛盾しているかどうか」を判定しない。**呼び出し側（人・上位のアプリ
   * ケーション層・将来の自動検出）が「この2件は対向する」と既に決めていることを前提に、
   * その決定を`docs/memory-model.md` §5 が要求する形（一対一・相互参照・機構2の
   * mandatory companion retrieval が働く状態）で機械的に書き込むだけである。
   * ⟹ **順序（新しい方を勝たせる）で判定しない・LLM を呼ばない**——
   * どちらの北極星の制約も、判定そのものをこの口が持たないことで自動的に満たす
   * （`docs/decisions/0134-*.md` 参照）。
   *
   * `docs/memory-model.md` §11 行7「`contested` → `active | superseded`」（解決）は
   * この PR の範囲外——別の issue/PR で扱う（ADR 0134「採らなかった案」参照）。
   *
   * 手順:
   * 1. `firstId === secondId` は呼び出し前の programmer error として扱い、
   *    `RangeError`（`Runtime.markContested: firstId and secondId must differ`）を投げる。
   *    書き込みは一切試みない（`supersedeWithNewMemories` の
   *    `supersededByIndex out of range` と同じ「開く前に落とす」位置）。
   * 2. `deps.memoryStore.markContestedPair` が無ければ、ここで打ち切り
   *    `{ supported: false, outcome: { kind: "not_attempted" } }` を返す
   *    ——フォールバック経路は無い（interface 側の doc コメント参照）。
   * 3. `getMany([firstId, secondId])` で一括読み、それぞれを {@link MarkContestedSideOutcome}
   *    に分類する（`"not_found"`/`"status_not_active"`/`"eligible"`）。どちらか一方でも
   *    `"eligible"` でなければ、書き込みを一切試みず
   *    `{ supported: true, outcome: { kind: "ineligible", sides: [...] } }` を返す。
   * 4. 両側とも `"eligible"` なら `deps.memoryStore.markContestedPair` を呼ぶ。成功すれば
   *    `{ supported: true, outcome: { kind: "contested", first, second } }`。
   * 5. {@link MemoryStatusConflictError} が投げられたら（3で読んだ後、4で書く前に別の
   *    書き込みが割り込んだ TOCTOU）、**1回だけ**再読して `conflicts` に両側の現在の
   *    `status` を積み、`{ supported: true, outcome: { kind: "conflict", conflicts } }`
   *    を返す——上限の無い再試行ループにはしない（`forget`/`restoreArchived`/`purge` と
   *    同じ安全弁）。
   *
   * `memory_events` へ両側それぞれ1件ずつ積む。`kind: 'updated'`・`meta.reason: 'contested'`
   * （`docs/memory-model.md` §11 行6 が定める固定値。`consolidate`/`reflect` の
   * `meta.reason` と同じ「操作の種類を表す固定タグ」の扱いであり、`forget`/`restoreArchived`
   * の「呼び出し側の自由文」とは別物）。`opts.reason` を渡すと `meta.note` に追加で入る。
   * `digestSnapshot` にはその Memory の現在の `digest` を入れる（`content` は運ばない。
   * `forget`/`reextract` と同じ規律）。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`status` が `'contested'` になった時点で、
   * 既存の段1 status ゲート（`["active","contested"]`）・段3の mandatory companion
   * retrieval（`contestedWithId` を辿って対向を取得する既存実装）へ他の `contested` な
   * Memory と全く同じ経路で合流する——この操作のために `recall-runtime.ts` は1行も
   * 変更していない（変更したのは「ここは一度も通らない」という古くなったコメントだけ）。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**明示的に呼んだときだけ動く
   * ——`forget`/`purge`/`restoreArchived` と同じ立場。
   */
  markContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    opts?: MarkContestedOptions,
  ): Promise<MarkContestedResult>;
  /**
   * Issue #197（ADR 0150）: `docs/memory-model.md` §11 lifecycle 行7「`contested` →
   * `active | superseded`」を実行する**明示的操作**。`markContested`（`docs/decisions/
   * 0134-mark-contested-explicit-operation.md`）の解決側であり、その形を手本に対称に
   * 書いてある。
   *
   * **この操作自身も「どちらが正しいか」を判定しない。**`markContested` と同じ理由——
   * 呼び出し側（人・上位のアプリケーション層）が既に下した決定（{@link ContestedResolution}）
   * を、`docs/memory-model.md` が要求する形（CAS・イベント・1トランザクション）で機械的に
   * 書き込むだけである。⟹ **`recordedAt`/`occurredAt` を一度も参照しない**——
   * `docs/memory-model.md` §5「順序では解かない」に抵触しない。**LLM を呼ばない。**
   *
   * 手順:
   * 1. `firstId === secondId` は呼び出し前の programmer error として扱い、`RangeError`
   *    （`Runtime.resolveContested: firstId and secondId must differ`）を投げる。書き込みは
   *    一切試みない（`markContested` と同じ「開く前に落とす」位置）。
   * 2. `resolution.kind === "supersede"` のとき、`resolution.winnerId` が `firstId`/`secondId`
   *    のどちらでもなければ、同じく書き込み前に `RangeError`
   *    （`Runtime.resolveContested: resolution.winnerId must be firstId or secondId`）を
   *    投げる。
   * 3. `deps.memoryStore.resolveContestedPair` が無ければ、ここで打ち切り
   *    `{ supported: false, outcome: { kind: "not_attempted" } }` を返す——フォールバック
   *    経路は無い（`MemoryStore.resolveContestedPair` の interface JSDoc 参照）。
   * 4. `getMany([firstId, secondId])` で一括読み、それぞれを {@link ResolveContestedSideOutcome}
   *    に分類する（`"not_found"`/`"status_not_contested"`/`"pair_broken"`/`"eligible"`。
   *    適格性は「両側とも `status === 'contested'` かつ相互参照が成立している」——
   *    [ADR 0046](../../../docs/decisions/0046-contested-pair-invariant-tooth.md) の対不変
   *    条件を読む側からも守る）。どちらか一方でも `"eligible"` でなければ、書き込みを
   *    一切試みず `{ supported: true, outcome: { kind: "ineligible", sides: [...] } }` を返す。
   * 5. 両側とも `"eligible"` なら `deps.memoryStore.resolveContestedPair` を呼ぶ。
   *    - `resolution.kind === "both_active"`: 両側とも `status: "active"`。
   *    - `resolution.kind === "supersede"`: `winnerId` 側は `status: "active"`、もう一方は
   *      `status: "superseded"` + `supersededById: <winnerId>`。
   *
   *    成功すれば `{ supported: true, outcome: { kind: "resolved", first, second } }`。
   * 6. {@link MemoryStatusConflictError} が投げられたら（4で読んだ後、5で書く前に別の
   *    書き込みが割り込んだ TOCTOU）、`markContested` と同じく**1回だけ**再読して
   *    `conflicts` に両側の現在の `status` を積み、
   *    `{ supported: true, outcome: { kind: "conflict", conflicts } }` を返す——上限の無い
   *    再試行ループにはしない。
   *
   * `memory_events` へ両側それぞれ1件ずつ積む（`docs/memory-model.md` §11 行7
   * 「`updated` または `superseded`」）:
   * - `"supersede"`: 勝者に `kind: 'updated'`、敗者に `kind: 'superseded'`。
   * - `"both_active"`: 両側とも `kind: 'updated'`。
   *
   * どちらも `meta.reason` は固定値 `'contested_resolved'`、`meta.resolution` に
   * `'supersede' | 'both_active'`（監査ログから「なぜ contested が消えたか」を追えるように
   * するための欄——`meta.reason` だけでは決着の種類までは分からない）。`opts.reason` を
   * 渡すと `meta.note` に追加で入る（`meta.reason`/`meta.resolution` は上書きしない）。
   * `digestSnapshot` にはその Memory の現在の `digest` を入れる（`content` は運ばない。
   * `markContested`/`forget`/`reextract` と同じ規律）。
   *
   * ⚠ **`recall()` 側は一切変更していない。**`status` が `'contested'` から
   * `'active'`/`'superseded'` へ離れた時点で、既存の段1 status ゲート
   * （`["active","contested"]`）・段3 mandatory companion retrieval（`contestedWithId` を
   * 辿る既存実装）から自然に外れる——敗者側は次の `recall` から二度と単独でも同伴でも
   * 出てこない（同伴として出てくるのは、対向がまだ `contested` のときだけ）。
   *
   * 🔴 **`tick()`/`observe()` からは一度も呼ばれない。**明示的に呼んだときだけ動く
   * ——`markContested`/`forget`/`purge`/`restoreArchived` と同じ立場。
   */
  resolveContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    resolution: ContestedResolution,
    opts?: ResolveContestedOptions,
  ): Promise<ResolveContestedResult>;
  /**
   * Issue #103（ADR 0089）: 複数の Memory を1件に統合する（docs/vision.md「5動詞」の1つ）。
   *
   * **`forget`/`purge`/減衰のどれでもない、第4の位置——`status: 'superseded'`
   * （機構の都合）を使う。** 統合元は `status: 'superseded'` + `supersededById: <統合先>` へ
   * 動き、行も `content` も消えない（`superseded_by_id` で統合先を辿れる。docs/north-star.md
   * 表4「元を消さない」）。**`forgotten` は絶対に統合元にしない**——利用者が意図して
   * 忘れさせたものを、機構の都合（統合）で上書きしない（`runtime.forget` の先例と同じ理由）。
   *
   * 手順（ADR 0089 §3。**この順序が冪等性と安全性を買っている**）:
   * 1. `target` を正規化する。`{ memoryIds }` はそのまま（重複・入力順を保つ）。空配列は
   *    store に一切触れず `outcome: 'not_examined'`。`{ query, maxCandidates }` は
   *    `recall(ctx, query)` を1回呼び、返った `memories` の id を順に採る
   *    （`maxCandidates` があれば先頭からその件数で切る）。0件も `not_examined`。
   *    `{ seedMemoryId, maxCandidates?, minAffinity? }`（Issue #135、ADR 0152）は
   *    種の Memory を `get` し、その `digest` を `text` にして `recall()` を1回呼ぶ
   *    （`{ query }` とまったく同じ経路）。`recall()` が返した候補のうち、
   *    `RecalledMemory.score` から `computeAffinity`（`max(similarity, lexicalMatch)`、
   *    `strategies/consolidate.ts`）が `minAffinity`（既定
   *    {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY}）未満のものは落とす。**種そのものは
   *    この判定を受けず、必ず先頭に含める**（種の embedding がまだ無いと ANN に
   *    載らないため）。`maxCandidates` は結果の配列全体（種＋近傍）を先頭から切る。
   *    種が見つからなければ `recall()` を呼ばず、対象は種の id 1件のみになる。
   * 2. `getMany` で一括読み。無ければ `not_found`、`status !== 'active'` なら
   *    `status_not_active`、`active` なら eligible。
   * 3. eligible が0件なら `nothing_to_consolidate`/`no_eligible_sources`、1件だけなら
   *    `nothing_to_consolidate`/`single_eligible_source`——どちらも `llmCalls: 0`・書き込み無し。
   *    **これが冪等性の芯**——同じ id 集合で2回目を呼ぶと eligible が0件になり、LLM も
   *    呼ばず何も書かずに終わる。
   * 4. `dryRun: true` ならここで打ち切る。eligible は `{ kind: 'eligible' }`、他は2の判定の
   *    まま。`outcome: 'dry_run'`、`llmCalls: 0`、書き込みゼロ。
   * 5. LLM を1回呼ぶ（`completeStructured`）。失敗したら `outcome: 'llm_failed'`・
   *    `llmFailure`・`llmCalls: 1`・書き込みゼロ（失敗を根拠に既存の記憶を置き換えない。
   *    `ReextractResult.supersededMemoryIds` の doc と同じ規律）。
   * 6. 統合先を1件作る（`createMemoryWithOutbox`。`buildConsolidatedMemory` 参照）。
   * 7. eligible を1件ずつ `updateStatusWithEvent` で `superseded` へ CAS する（`reextract` の
   *    ループと同じ形）。`MemoryStatusConflictError` はその1件だけ `status_changed_concurrently`
   *    として飛ばして続行、それ以外の例外は `failed` を積んでその場で打ち切り、残りを
   *    `not_attempted` として返す（投げない。`forget`/ADR 0087 決定5 と同じ）。
   * 8. `outcome: 'consolidated'`、`consolidatedMemoryId`、`llmCalls: 1`。
   *
   * `memory_events.meta.reason` は `superseded` イベントに `'consolidated'` を積む
   * （`reextract_superseded` に次ぐ2つ目の値、ADR 0074 が予言した形）。`digestSnapshot` は
   * 積むが **`content` は積まない**（`forget`/`reextract` と同じ規律）。
   *
   * ⭐ **`tick()` は `'consolidate'` の outbox ジョブが在ればこれを駆動する**
   * （Issue #204 / ADR 0157。`TICK_SUPPORTED_JOB_KINDS` に足された）。ジョブの
   * `payload` は `{ memoryId }`（既存の `embed` ジョブと同じ形）で、`tick` はそれを
   * `seedMemoryId` として `consolidate(ctx, { target: { seedMemoryId } })` を呼ぶ
   * だけである——このメソッド自身の意味論・呼び出し方は一切変わっていない。
   * ⚠ **そのジョブが自動で積まれるとは限らない**——`extract` がこの種を積むのは
   * `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効にした
   * ときだけである。無効のままでも `consolidate()` を直接呼ぶ経路は変わらず動く
   * （北極星の問い2）。
   */
  consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult>;
  /**
   * Issue #104: 複数の Memory から一般化・気づきを1件作る（docs/vision.md「5動詞」の1つ）。
   *
   * **`consolidate` の双子だが、意味論は正反対である。** `consolidate` は N→1 の**置換**
   * （統合元を `superseded` へ動かす）だが、`reflect` は**足すだけ**の操作であり、
   * 既存の行の `status` を1つも動かさない。書き込みは新しい Memory 1件と `created`
   * イベントだけであり、`updateStatus`/`updateStatusWithEvent` は1度も呼ばない
   * ——`reflect` に `superseded`/`forgotten` へ動かす根拠は無い（`consolidate` が
   * `superseded` を使えるのは N→1 の置換だからである）。
   *
   * 手順（`consolidate` §3 と同じ段取りを踏むが、書き込みの終盤だけ違う）:
   * 1. `target` を正規化する。`{ memoryIds }` はそのまま（重複・入力順を保つ）。空配列は
   *    store に一切触れず `outcome: 'not_examined'`。`{ query, maxCandidates }` は
   *    `recall(ctx, query)` を1回呼び、返った `memories` の id を順に採る
   *    （`maxCandidates` があれば先頭からその件数で切る）。0件も `not_examined`。
   *    `{ seedMemoryId, maxCandidates?, minAffinity? }`（Issue #204、ADR 0154）は
   *    `consolidate` の `{ seedMemoryId }`（ADR 0152）と同じ土台選定——種の Memory を
   *    `get` し、その `digest` を `text` にして `recall()` を1回呼ぶ（`{ query }` と
   *    まったく同じ経路）。`recall()` が返した候補のうち、`RecalledMemory.score` から
   *    `computeAffinity`（`max(similarity, lexicalMatch)`、`strategies/consolidate.ts`）が
   *    `minAffinity`（既定 {@link DEFAULT_REFLECT_MIN_AFFINITY}）未満のものは落とす。
   *    **種そのものはこの判定を受けず、必ず先頭に含める**（種の embedding がまだ無いと
   *    ANN に載らないため）。`maxCandidates` は結果の配列全体（種＋近傍）を先頭から切る。
   *    種が見つからなければ `recall()` を呼ばず、対象は種の id 1件のみになる。
   * 2. `getMany` で一括読み。**この優先順で**分類する: 無ければ `not_found`、
   *    `status !== 'active'` なら `status_not_active`、`active` かつ
   *    `provenance.kind === 'reflected'` なら `basis_is_reflected`（reflect の産物を
   *    土台にまた reflect する自己増幅を、形の側で止める）、それ以外は eligible。
   * 3. eligible（重複除去）が0件なら `nothing_to_reflect`/`no_eligible_basis` で打ち切る
   *    ——**LLM を呼ばない**（`llmCalls: 0`）。`consolidate` と違い、eligible が1件だけでも
   *    ここでは打ち切らない（1件からの一般化も意味を持ちうる）。
   * 4. `dryRun: true` ならここで打ち切る。eligible は `{ kind: 'eligible' }`、他は2の判定の
   *    まま。`outcome: 'dry_run'`、`llmCalls: 0`、書き込みゼロ。
   * 5. LLM を1回呼ぶ（`completeStructured`、スキーマは判別子 `outcome: 'reflected' | 'nothing'`
   *    を持つ判別可能ユニオン——断れないスキーマを渡すと、モデルは毎回何かを捏造するため、
   *    モデルが「一般化するものは無い」と答えられる形にしてある）。失敗したら
   *    `outcome: 'llm_failed'`・`llmFailure`・`llmCalls: 1`・書き込みゼロ（失敗を根拠に
   *    新しい記憶を作らない。`ReextractResult`/`ConsolidationResult` と同じ規律）。
   * 6. LLM が `outcome: 'nothing'` を返したら `nothing_to_reflect`/`llm_declined`、
   *    `llmCalls: 1`、書き込みゼロ。
   * 7. `buildReflectedMemory(...)` で新しい Memory を1件組み立て
   *    （`createMemoryWithOutbox(ctx, newMemory, ['embed'])`）。`provenance` は
   *    `{ kind: 'reflected', sources: <eligible の memoryId> }`——**`sources` は必ず埋める**
   *    （`ReflectedProvenance.sources` は型としては省略可のままだが、この実装が作る値は
   *    常に埋める。公開型の破壊的変更を避けるため型は変えていない）。
   * 8. `created` イベントを1件積む。`meta.reason: 'reflected'`、`meta.sources: <eligible の
   *    id>`、`opts.reason` があれば `meta.note` にも積む（`consolidate` の `superseded`
   *    イベントと同じ形）。
   * 9. `outcome: 'reflected'`、`reflectedMemoryId`、eligible を `'used'` にして返す。
   *
   * ⚠ **冪等性は買っていない。**`sourceObservationId: null` なので `createMemoryWithOutbox`
   * の部分一意索引（`WHERE source_observation_id IS NOT NULL`）は効かず、既存の行の
   * `status` を動かさない（上の手順に `superseded`/`forgotten` が無い）ため `consolidate` の
   * 「読んで status で弾く」も使えない。**⟹ 同じ target で2回呼ぶと、内容が同じ
   * `reflected` Memory が2件できる。**これを塞ぐために `MemoryStore` へメソッドや索引を
   * 足すことはしていない（`reflect.test.ts` がこの挙動を歯で固定している）。
   *
   * ⭐ **`tick()` は `'reflect'` の outbox ジョブが在ればこれを駆動する**
   * （Issue #204 / ADR 0157。`TICK_SUPPORTED_JOB_KINDS` に足された）。`consolidate` と
   * 対称——ジョブの `payload` は `{ memoryId }` で、`tick` はそれを `seedMemoryId` として
   * `reflect(ctx, { target: { seedMemoryId } })` を呼ぶだけである。
   * ⚠ **`reflect()` の *実運用*（Background Cognition・Scheduler による自動起動）は
   * 依然として Phase 1 の範囲外のままである**（docs/roadmap.md §1.1/§1.3）——ここで
   * 変わったのは「`tick` に渡されたジョブを処理できるようになった」ことだけであり、
   * ジョブを**自動で積む**かどうかは別の決定である。`extract` がこの種を積むのは
   * `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効に
   * したときだけであり、無効のままでも `reflect()` を直接呼ぶ経路は変わらず動く
   * （北極星の問い2）。
   */
  reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult>;
}

function extractObservationPayload(
  input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
): unknown {
  switch (input.kind) {
    case "utterance":
      return { text: input.text, speaker: input.speaker };
    case "event":
      return { name: input.name, data: input.data ?? {} };
    case "document":
      return { title: input.title, content: input.content };
    default: {
      const exhaustive: never = input;
      throw new Error(`unreachable observe input kind: ${String(exhaustive)}`);
    }
  }
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const clock = deps.clock ?? systemClock;
  const extractorVersion = deps.config?.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION;
  const llmModelId = deps.config?.llmModelId ?? DEFAULT_LLM_MODEL_ID;
  const promptVersion = deps.config?.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const digestFallbackLength = deps.config?.digestFallbackLength ?? DEFAULT_DIGEST_FALLBACK_LENGTH;
  const defaultClaimedBy = deps.config?.defaultClaimedBy ?? DEFAULT_CLAIMED_BY;
  const autoQueueConsolidateReflectOnExtract =
    deps.config?.autoQueueConsolidateReflectOnExtract ?? false;

  /**
   * 抽出候補から Memory を作る核（`runExtraction` と `reextract` の共通経路）。
   * `createMemoryWithOutbox` の ON CONFLICT により冪等——同じ候補で複数回呼んでも
   * 新規行は増えない（`created: false` の場合はイベントも積まない）。
   * `contentHashes` は `reextract` が「今回作られた集合」を判定するために使う。
   */
  /**
   * 候補から `NewMemory` を組み立てるだけ（**書き込まない**）。
   *
   * Issue #134 / ADR 0100 で切り出した。`reextract` は「今回作る content_hash の集合」を
   * supersede 判定（`classifyReextractTargets`）に渡す必要があり、かつ ADR 0100 の
   * `supersedeWithNewMemories` は**作成と supersede を1回の呼び出しで**受け取る——
   * ⟹ 作成より前に content_hash を知る必要がある。組み立てと書き込みを分けないと、
   * この2つを同時に満たせない。
   */
  /**
   * [ADR 0165](../../docs/decisions/0165-decay-activity-clock.md) 決めたこと1・3・5・12:
   * Memory 書き込み側3箇所（抽出・consolidate 手順6・reflect 手順7）が共通して要る、
   * 活動時計の入力の組み立て。
   *
   * **`decay_clock === 'wall'` のテナントでは `tenant_activity` を一度も読まない**
   * ——`{}` を返し、`activitySeq`/`halfLifeRecalls` は `undefined` のまま
   * `buildNewMemoryFromCandidate` 等へ渡る。これらの関数は両方揃っているときだけ
   * 活動時計の3つ組（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）を作る
   * （`extraction.ts` の doc 参照）ので、`'wall'` のテナントで作られる Memory は
   * 本 ADR の前後で1バイトも変わらない。
   *
   * ⚠ **これは 0163 の話であり、tick が consolidate/reflect を駆動する ADR 0157 とは無関係**
   * ——ここで読むのは `decay_clock`/`activity_seq` だけで、tick のスケジューリングには触れない。
   */
  async function resolveActivityClockInputs(
    ctx: Ctx,
  ): Promise<{ activitySeq?: number; halfLifeRecalls?: number }> {
    const decayClock = await readDecayClock(deps.tenantSettingsStore, ctx);
    if (decayClock === "wall") {
      return {};
    }
    const [activitySeq, halfLifeRecalls] = await Promise.all([
      readActivitySeq(deps.tenantSettingsStore, ctx),
      readDefaultHalfLifeRecalls(deps.tenantSettingsStore, ctx),
    ]);
    return { activitySeq, halfLifeRecalls };
  }

  /**
   * [ADR 0165](../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
   * `reinforce` の呼び出し側2箇所（使用報告ループ・`restoreArchived`）が共通して要る、
   * 活動時計の「いま」の解決。
   *
   * `resolveActivityClockInputs` と同じく `decay_clock === 'wall'` のテナントでは
   * `tenant_activity` を一度も読まない。`reinforce` は Memory 単位の `halfLifeRecalls` を
   * 対象の Memory 自身から読む（store 側の実装、`ReinforceOptions.nowSeq` の doc
   * コメント参照）ので、ここでは `activitySeq` だけを読めば足り、
   * `resolveActivityClockInputs` が読む `default_half_life_recalls` は不要——
   * 読まない分だけ `'activity'`/`'either'` のテナントでも `tenant_settings` への
   * 往復を1回減らせる。
   */
  async function resolveReinforceNowSeq(ctx: Ctx): Promise<number | undefined> {
    const decayClock = await readDecayClock(deps.tenantSettingsStore, ctx);
    if (decayClock === "wall") {
      return undefined;
    }
    return readActivitySeq(deps.tenantSettingsStore, ctx);
  }

  function toReinforceOptions(nowSeq: number | undefined): { nowSeq: number } | undefined {
    return nowSeq === undefined ? undefined : { nowSeq };
  }

  async function buildNewMemoriesForCandidates(
    ctx: Ctx,
    observation: Observation,
    candidates: ExtractedMemoryCandidate[],
  ): Promise<NewMemory[]> {
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // ADR 0165 決めたこと3・5・12: 活動時計の3つ組を、書き込み側3箇所のうちの1つとして
    // ここで織り込む。
    const activityClockInputs = await resolveActivityClockInputs(ctx);
    return candidates.map((candidate) =>
      buildNewMemoryFromCandidate({
        ctx,
        observation,
        candidate,
        hashContent: deps.hashContent,
        extractorVersion,
        llmModelId,
        promptVersion,
        halfLifeHours,
        now,
        digestFallbackLength,
        ...activityClockInputs,
      }),
    );
  }

  /**
   * 新しく作られた Memory について `created` イベントを積む。
   *
   * ⚠ **このイベントは `memories` への INSERT と同一トランザクションではない**
   * （`EventStore.append` は別コミット）。ADR 0100 が満たしたのは
   * docs/memory-model.md §11 行5 が名指しした「旧行の更新」と「新 Memory の作成」の
   * 対であり、`created` イベントはその要求文に含まれていない——この非同時性は
   * ADR 0100 の「守れないもの」に記録してある。
   */
  async function appendCreatedEvent(
    ctx: Ctx,
    memory: Memory,
    observation: Observation,
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
  ): Promise<void> {
    await deps.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: memory.id,
      kind: "created",
      actor: { type: "system" },
      digestSnapshot: memory.digest,
      sizeBeforeBytes: null,
      meta: {
        reason:
          outcome === "llm_failed_whole_observation"
            ? "extraction_failed_whole_observation_fallback"
            : "extracted",
        sourceObservationId: observation.id,
        extractorVersion,
        // `meta` は既存の jsonb NOT NULL 列へのキー追加のみ（マイグレーション不要）。
        // 失敗経路（outcome: "llm_failed_whole_observation"）のときだけ足す——
        // 成功経路の meta.reason: "extracted" の形は変えない。
        ...(outcome === "llm_failed_whole_observation"
          ? { failureKind: failure?.kind ?? null }
          : {}),
      },
    });
  }

  async function createMemoriesFromCandidates(
    ctx: Ctx,
    observation: Observation,
    candidates: ExtractedMemoryCandidate[],
    outcome: ExtractionOutcome,
    failure: ExtractionFailure | null,
  ): Promise<{ memoryIds: MemoryId[]; contentHashes: Set<string> }> {
    const newMemories = await buildNewMemoriesForCandidates(ctx, observation, candidates);
    const memoryIds: MemoryId[] = [];
    const contentHashes = new Set<string>();
    // Issue #204 / ADR 0157: 既定 `["embed"]` のみ。opt-in（config.autoQueueConsolidateReflectOnExtract）
    // が true のときだけ、同じ memoryId を種にした consolidate/reflect ジョブも積む——
    // `createMemoryWithOutbox` は jobKinds の各要素に同じ payload `{ memoryId }` を使うので、
    // 新しい payload 形を発明する必要がない（下の processConsolidateJob/processReflectJob 参照）。
    const jobKinds: OutboxJobKind[] = autoQueueConsolidateReflectOnExtract
      ? ["embed", "consolidate", "reflect"]
      : ["embed"];
    for (const newMemory of newMemories) {
      contentHashes.add(newMemory.contentHash);
      const { memory, created } = await deps.memoryStore.createMemoryWithOutbox(
        ctx,
        newMemory,
        jobKinds,
      );
      memoryIds.push(memory.id);
      if (created) {
        await appendCreatedEvent(ctx, memory, observation, outcome, failure);
      }
      // embed/consolidate/reflect ジョブは常に outbox 経由（非同期、docs/memory-model.md §11 行3）。
      // ここでは何もしない — tick() の各 processXxxJob が処理する。
    }
    return { memoryIds, contentHashes };
  }

  /** 1件の Observation に対して抽出を実行し、作られた（または冪等に既存の）Memory の id を返す。 */
  async function runExtraction(
    ctx: Ctx,
    observation: Observation,
  ): Promise<{
    memoryIds: MemoryId[];
    outcome: ExtractionOutcome;
    failure: ExtractionFailure | null;
  }> {
    const { candidates, usedWholeObservationFallback, failure } = await extractCandidates(
      deps.llmProvider,
      ctx,
      observation,
    );
    const outcome: ExtractionOutcome = usedWholeObservationFallback
      ? "llm_failed_whole_observation"
      : "ok";
    if (candidates.length === 0) {
      return { memoryIds: [], outcome, failure };
    }
    const { memoryIds } = await createMemoriesFromCandidates(
      ctx,
      observation,
      candidates,
      outcome,
      failure,
    );
    return { memoryIds, outcome, failure };
  }

  /**
   * ADR 0028: `observe()` が LLM 障害で全文フォールバックへ倒れた（または単に古い抽出器版で
   * 作られた）Observation に対して、抽出をやり直す。
   *
   * 🔴 安全弁1: LLM がまた失敗したら（`usedWholeObservationFallback`）、何も supersede せずに
   * 返す。失敗を根拠に既存の記憶を置き換えない。
   * 🔴 安全弁2: 候補が0件なら、何も supersede しない。「何も記憶に値しない」という正常な
   * 抽出結果を根拠に既存を消さない（`superseded_by_id` の指す先も無い）。
   * 🔴 安全弁3（ADR 0030）: `classifyReextractTargets` が「今回作る前」に読んだ時点で
   * `active` だった Memory でも、実際に書きに行くまでの間（TOCTOU の窓）に別の書き込みで
   * status が変わっていることがある。`updateStatus` を `expectedStatus: "active"` の
   * compare-and-swap で呼び、弾かれたら `classifySupersedeFailure` で判定して `skipped` に
   * 積む（`supersededMemoryIds` には入れず、`superseded` イベントも積まない）。
   *
   * supersede 対象は、同じ `(sourceObservationId, extractorVersion)` を持つ既存 Memory のうち
   * **`status: 'active'`** かつ今回作られた content_hash の集合に含まれないものだけ。
   * `forgotten`（利用者が意図して忘れさせた）は絶対に含めない。`contested` も対象外にする
   * ——contested は対向 Memory との対で初めて意味を持つ契約（mandatory companion retrieval）を
   * 持つため、機構都合の reextract がその対の片方だけを動かすと契約を壊しかねない
   * （ADR 0028「確かめていないこと」参照）。
   */
  async function reextract(ctx: Ctx, observationId: ObservationId): Promise<ReextractResult> {
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.reextract: observation not found: ${observationId}`);
    }

    const { candidates, usedWholeObservationFallback, failure } = await extractCandidates(
      deps.llmProvider,
      ctx,
      observation,
    );

    if (usedWholeObservationFallback) {
      // ADR 0029: この早期 return は `listBySourceObservation` を呼ぶ前に return する——
      // つまり既存 Memory を「見ていない」。`skipped: []`（既定値の顔）にすると
      // 「何も飛ばさなかった」と嘘をつくことになるため、`not_examined` を明示する。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "llm_failed_whole_observation" }],
        // 安全弁1 で早期 return——書き込みを1件も試みていない。
        atomicity: "not_attempted",
        extraction: "llm_failed_whole_observation",
        extractionFailure: failure,
      };
    }
    if (candidates.length === 0) {
      // ADR 0029: 同じ理由でここも `listBySourceObservation` の前——既存を見ていない。
      return {
        observationId,
        memoryIds: [],
        supersededMemoryIds: [],
        skipped: [{ kind: "not_examined", reason: "no_candidates" }],
        // 安全弁2 で早期 return——書き込みを1件も試みていない。
        atomicity: "not_attempted",
        extraction: "ok",
        extractionFailure: null,
      };
    }

    // supersede 判定は「今回作る前」の既存 Memory を基準にする——これから作る Memory 自身が
    // 混ざって「今回作ったものを今回 supersede する」という自己矛盾を起こさないため。
    const existingBefore = await deps.memoryStore.listBySourceObservation(
      ctx,
      observationId,
      extractorVersion,
    );

    // ADR 0100: content_hash は**作る前**に分かる（`buildNewMemoriesForCandidates` は
    // 書き込まない）——`supersedeWithNewMemories` が「作成と supersede を1回の呼び出しで」
    // 受け取るには、supersede 判定を作成より前に済ませておく必要がある。
    const newMemories = await buildNewMemoriesForCandidates(ctx, observation, candidates);
    const contentHashes = new Set(newMemories.map((m) => m.contentHash));

    // ADR 0029: 判定そのものは純関数（`classifyReextractTargets`）に切り出してある——
    // ここでは判定結果（`toSupersede`・`skipped`）を受け取って I/O するだけ。
    // supersede する対象・順序・イベントの中身は ADR 0028 からミリも変えていない。
    const { toSupersede, skipped } = classifyReextractTargets(existingBefore, contentHashes);

    // `supersededById` を省略すると `meta` からその欄を落とす——ADR 0100 の口を使う経路では
    // アンカーの id が呼び出し前に存在しないため、store が解決した id で埋める契約になって
    // いる（`MemoryStore.supersedeWithNewMemories` の doc 参照）。⟹ 監査ログの中身は
    // 口が在る adapter と無い adapter で**同一**になる。⛔ 同じ論理操作が adapter ごとに
    // 別の監査記録を残す形にはしない。
    const buildSupersedeEventFor = (existing: Memory, supersededById?: MemoryId) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: existing.id,
        kind: "superseded",
        actor: { type: "system" },
        digestSnapshot: existing.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "reextract_superseded",
          ...(supersededById === undefined ? {} : { supersededById }),
          sourceObservationId: observationId,
          extractorVersion,
        },
      }) satisfies NewMemoryEvent;

    // ------------------------------------------------------------------
    // ADR 0100: 口が在れば、作成と supersede を1トランザクションで撃つ。
    // 🔴 フォールバックは**口の不在に対してだけ**（書き込みの前に1度判定する）。
    // ⛔ 撃って投げられたときに今日の経路で撃ち直さない——それをすると
    // 「トランザクションを張れなかった」と「張ったが失敗した」が呼び手から
    // 区別できなくなる（Issue #134 が潰すなと명示した破れ）。
    // ------------------------------------------------------------------
    const supersedeWithNewMemories = deps.memoryStore.supersedeWithNewMemories;
    if (supersedeWithNewMemories !== undefined) {
      // `supersededByIndex: 0` は「この呼び出しの news[0]」——今日の
      // `const supersededById = memoryIds[0]!` と同じ対象を指す（ADR 0028 の
      // 「今回作った Memory の1件」）。
      const result = await supersedeWithNewMemories.call(
        deps.memoryStore,
        ctx,
        newMemories.map((input) => ({ input, jobKinds: ["embed"] as OutboxJobKind[] })),
        toSupersede.map((existing) => ({
          id: existing.id,
          supersededByIndex: 0,
          expectedStatus: "active" as MemoryStatus,
          // `meta.supersededById` は store が解決した id で埋める（上のコメント参照）。
          event: buildSupersedeEventFor(existing),
        })),
      );

      const memoryIds = result.created.map((c) => c.memory.id);
      for (const { memory, created } of result.created) {
        if (created) {
          await appendCreatedEvent(ctx, memory, observation, "ok", null);
        }
      }

      // CAS に弾かれた対象は**既存の語彙**へ写す（⛔ `ReextractSkip` に新しい kind を
      // 足さない。exhaustive switch を持つ第三者を壊しうる）。
      const conflictedIds = new Set(result.conflicted.map((c) => c.id));
      for (const conflict of result.conflicted) {
        skipped.push({
          kind: "status_changed_concurrently",
          memoryId: conflict.id,
          observedStatus: conflict.observedStatus,
        });
      }

      return {
        observationId,
        memoryIds,
        supersededMemoryIds: toSupersede
          .map((existing) => existing.id)
          .filter((id) => !conflictedIds.has(id)),
        skipped,
        extraction: "ok",
        extractionFailure: null,
        atomicity: "store_supported",
      };
    }

    // 口が無い adapter——今日どおりの2段（作成 → supersede ループ）。
    const memoryIds: MemoryId[] = [];
    for (const newMemory of newMemories) {
      const { memory, created } = await deps.memoryStore.createMemoryWithOutbox(ctx, newMemory, [
        "embed",
      ]);
      memoryIds.push(memory.id);
      if (created) {
        await appendCreatedEvent(ctx, memory, observation, "ok", null);
      }
    }
    // `candidates.length === 0` を上で早期リターンしている以上 `memoryIds` は非空
    // ——ここは構造的に保証されている（防御的な二重チェックをあえて置かない。
    // ADR 0028「変異A」参照）。
    const supersededById = memoryIds[0]!;

    const supersededMemoryIds: MemoryId[] = [];
    for (const existing of toSupersede) {
      try {
        // 🔴 安全弁3（ADR 0030）: 読んだ時点で active だったからといって、書きに来た今この
        // 瞬間も active だとは限らない（TOCTOU）。`expectedStatus: "active"` の
        // compare-and-swap で「読んでから書くまでの間に status が変わった」ケースを
        // 検知不能なまま通さない。
        //
        // ADR 0031: status の更新と `superseded` イベントの追記を1トランザクションで行う。
        await deps.memoryStore.updateStatusWithEvent(
          ctx,
          existing.id,
          "superseded",
          { supersededById, expectedStatus: "active" },
          buildSupersedeEventFor(existing, supersededById),
        );
      } catch (error) {
        const skip = classifySupersedeFailure(existing.id, error);
        if (skip === null) {
          // 競合以外の例外——飲み込まずそのまま投げる（classifySupersedeFailure の doc 参照）。
          throw error;
        }
        // CAS に弾かれた——supersededMemoryIds に入れず、superseded イベントも積まない
        // （積むと「置き換えた」という監査ログが嘘になる）。
        skipped.push(skip);
        continue;
      }
      supersededMemoryIds.push(existing.id);
    }

    return {
      observationId,
      memoryIds,
      supersededMemoryIds,
      skipped,
      extraction: "ok",
      extractionFailure: null,
      atomicity: "store_unsupported",
    };
  }

  async function handleMemoryUsage(
    ctx: Ctx,
    input: Extract<ObserveInput, { kind: "memory_usage" }>,
  ): Promise<ObserveResult> {
    const observation = await deps.memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId ?? null,
      externalId: null,
      kind: observeInputKindToObservationKind("memory_usage" satisfies ObserveInputKind),
      payload: { recallId: input.recallId, usedMemoryIds: input.usedMemoryIds },
      occurredAt: null,
      recordedAt: clock.now(),
    });

    // ADR 0009・docs/memory-model.md §6: 使用報告は抽出器を通らず recall_usages へ直接反映される。
    const { insertedMemoryIds } = await deps.memoryStore.recordUsage(
      ctx,
      input.recallId,
      input.usedMemoryIds,
    );
    const reinforcedAt = clock.now();
    // ADR 0165 決めたこと16: 'wall' 以外のテナントでは活動時計の「いま」も一緒に渡し、
    // decayBaseSeq/decayFloorSeq を同じ強化イベントとして進める。
    const reinforceOpts = toReinforceOptions(await resolveReinforceNowSeq(ctx));
    for (const memoryId of insertedMemoryIds) {
      await deps.memoryStore.reinforce(ctx, memoryId, reinforcedAt, reinforceOpts);
    }

    return {
      observationId: observation.id,
      memoryIds: insertedMemoryIds,
      extraction: "skipped",
      extractionFailure: null,
    };
  }

  async function handleExtractableObservation(
    ctx: Ctx,
    input: ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput,
  ): Promise<ObserveResult> {
    const kind = observeInputKindToObservationKind(input.kind);
    const payload = extractObservationPayload(input);
    const extractMode = input.extract ?? "sync";

    const newObservation: NewObservation = {
      tenantId: ctx.tenantId,
      subjectId: input.subjectId ?? ctx.subjectId ?? null,
      externalId: input.externalId ?? null,
      kind,
      payload,
      occurredAt: input.occurredAt ?? null,
      recordedAt: clock.now(),
      // Issue #280: `occurredAt` と同じ経路（`Observation.validFrom`/`validUntil` の
      // doc コメント参照。deferred 抽出でも値が残るよう Observation に持たせる）。
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    };

    const { observation, created, jobs } = await deps.memoryStore.createObservationWithOutbox(
      ctx,
      newObservation,
      ["extract"],
    );

    if (!created) {
      // 冪等な再送（docs/architecture.md §3.5）。extract ジョブは積まれておらず、
      // sync/deferred のどちらであっても、ここで新たに抽出をやり直す必要はない
      // （最初の呼び出しで既に処理済みのはず）。
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    if (extractMode === "deferred") {
      return {
        observationId: observation.id,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
      };
    }

    // extract: 'sync' — その場で抽出する（docs/architecture.md §3.2）。
    const { memoryIds, outcome, failure } = await runExtraction(ctx, observation);
    const extractJob = jobs.find((job) => job.kind === "extract");
    if (extractJob) {
      // CAS（ADR 0142）: この場では claimBatch を経由していないため attempts は
      // 生成時の値（0）のまま——「ここまで誰にも claim/complete/fail されていない」を
      // 表す自分のフェンシングトークンとして渡す。
      await deps.outboxStore.complete(ctx, extractJob.id, extractJob.attempts);
    }
    return {
      observationId: observation.id,
      memoryIds,
      extraction: outcome,
      extractionFailure: failure,
    };
  }

  async function observe(ctx: Ctx, input: ObserveInput): Promise<ObserveResult> {
    const parsed = ObserveInputSchema.parse(input);
    if (parsed.kind === "memory_usage") {
      return handleMemoryUsage(ctx, parsed);
    }
    return handleExtractableObservation(ctx, parsed);
  }

  async function processExtractJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const observationId = job.payload.observationId;
    if (typeof observationId !== "string") {
      throw new Error("runtime.tick: extract job payload missing observationId");
    }
    const observation = await deps.memoryStore.getObservation(ctx, observationId);
    if (!observation) {
      throw new Error(`runtime.tick: extract job references missing observation: ${observationId}`);
    }
    await runExtraction(ctx, observation);
  }

  async function processEmbedJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error("runtime.tick: embed job payload missing memoryId");
    }
    const memory = await deps.memoryStore.get(ctx, memoryId);
    if (!memory) {
      throw new Error(`runtime.tick: embed job references missing memory: ${memoryId}`);
    }
    try {
      const [vector] = await deps.embeddingProvider.embed(ctx, [memory.content]);
      if (!vector) {
        throw new Error("runtime.tick: embedding provider returned no vector");
      }
      await deps.vectorStore.upsert(ctx, deps.embeddingProvider.space, memory.id, vector);
      await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    } catch (err) {
      // 索引の遅れ・失敗を黙って無かったことにしない（docs/architecture.md 原則の姿3）。
      await deps.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
      throw err;
    }
  }

  /**
   * `job.payload` から `memoryId` を取り出す共通部分（Issue #204 / ADR 0157）。
   * `processEmbedJob` の `memoryId` 取り出しと同じ形——`consolidate`/`reflect` の
   * ジョブも `createMemoryWithOutbox` が作る以上、payload の形は embed と同じ
   * `{ memoryId }` である（新しい payload 形を発明しない、ADR 0157 決定2）。
   *
   * 🔴 **payload が壊れていた（`memoryId` が無い/文字列でない）場合は投げる。**
   * `processEmbedJob` と同じ規律——黙って何もしない・空処理として `complete()` しない
   * （ADR 0082 の哲学）。呼び出し元の `tick()` がこれを catch し、`outboxStore.fail()`
   * で終端に落として `TickResult.failed` に数える。
   */
  function readSeedMemoryIdFromPayload(job: OutboxJobRecord): MemoryId {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error(`runtime.tick: ${job.kind} job payload missing memoryId`);
    }
    return memoryId;
  }

  /**
   * `tick` の `consolidate` ジョブハンドラ（Issue #204 / ADR 0157）。
   *
   * **`seedMemoryId` が指す Memory が見つからない場合は投げない。**
   * `consolidate()` 自身が「種が見つからない」を `nothingReason` 経由の正規の結末
   * （`not_found` → `nothing_to_consolidate`/`no_eligible_sources` 等、ADR 0152 決定6）
   * として扱うため、ここで二重に判定しない——`processEmbedJob` が `memory not found` を
   * 例外にしているのとは事情が違う（embed には「対象が無かった」を表す正規の結末が無い）。
   * `consolidate()` が投げるのは LLM/store が本当に失敗したときだけであり、その例外は
   * そのまま伝播させて `tick()` に `fail()` させる。
   */
  async function processConsolidateJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const seedMemoryId = readSeedMemoryIdFromPayload(job);
    await consolidate(ctx, { target: { seedMemoryId } });
  }

  /**
   * `tick` の `reflect` ジョブハンドラ（Issue #204 / ADR 0157）。
   * `processConsolidateJob` と対称——理由は同じ（`reflect()` も種が見つからない場合を
   * `not_found` 経由の正規の結末として扱う、ADR 0154 決定5）。
   */
  async function processReflectJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const seedMemoryId = readSeedMemoryIdFromPayload(job);
    await reflect(ctx, { target: { seedMemoryId } });
  }

  /**
   * `tick` がジョブを配る先。**キーの集合は {@link TICK_SUPPORTED_JOB_KINDS} と型で結ばれている**
   * ——`Record<TickSupportedJobKind, JobHandler>` なので、片方だけ足す/消すと型検査が落ちる。
   * issue #105（型に `consolidate` が在るのに分岐が無い）と同じずれを、次からは
   * コンパイル時に止めるための結び目である。
   */
  const jobHandlers: Record<TickSupportedJobKind, JobHandler> = {
    extract: processExtractJob,
    embed: processEmbedJob,
    consolidate: processConsolidateJob,
    reflect: processReflectJob,
  };
  /**
   * `job.kind`（開いたユニオン＝任意の文字列）で引くための索引。
   *
   * 🔴 **`Map` である理由は1つだけ**——プレーンなオブジェクトを索引にすると
   * `job.kind` が `"constructor"` / `"toString"` のとき `Object.prototype` 側の関数が
   * 返り、**「対応している」と誤判定して呼んでしまう**。`kind` は DB の `text` 列から
   * 来る任意の文字列であり、この2語を弾く仕組みはどこにも無い（`OutboxJobKind` は
   * 開いたユニオンなので型でも止まらない）。`Map` は prototype を持たない。
   * `Object.entries(jobHandlers)` から作るので、出所は `TICK_SUPPORTED_JOB_KINDS` のままである。
   */
  const jobHandlerLookup = new Map<string, JobHandler>(Object.entries(jobHandlers));

  async function tick(ctx: Ctx, opts: TickOptions): Promise<TickResult> {
    const claimOpts: ClaimOutboxJobsOptions = {
      // 既定は「tick が処理できる kind だけ」——ここを広げると、処理できない kind を
      // 呼び出し側が頼んでもいないのに claim して終端で焼くことになる（ADR 0082）。
      kinds: opts.kinds ?? [...TICK_SUPPORTED_JOB_KINDS],
      limit: opts.limit ?? DEFAULT_TICK_LIMIT,
      now: clock.now(),
      claimedBy: opts.claimedBy ?? defaultClaimedBy,
      leaseMs: opts.leaseMs,
    };
    const jobs = await deps.outboxStore.claimBatch(ctx, claimOpts);

    let processed = 0;
    let failed = 0;
    const unsupported: UnsupportedOutboxJob[] = [];
    const leaseConflicts: OutboxLeaseConflict[] = [];
    for (const job of jobs) {
      const handler = jobHandlerLookup.get(job.kind);
      if (handler === undefined) {
        // 🔴 ADR 0082 / issue #105: 処理する分岐が無い kind。ここで2つのことを同時にやる。
        // 1. `fail()` で**終端に落とす**。claim したまま何もしないと lease が切れて
        //    再び claim され、「claim され続けるがいつまでも進まない」になる。
        // 2. `unsupported` に**名指しで積む**。`failed` に数えるだけだと、
        //    「試して失敗した」と同じ顔になって呼び出し側から区別が付かない。
        // CAS（ADR 0142）: `job` はこの tick が `claimBatch` からたった今受け取った
        // ものであり、`job.attempts` は「自分の claim」を指すフェンシングトークンである。
        // 🔴 ADR 0142 決定3: fail() 自体がリース競合（OutboxLeaseConflictError）で
        // 弾かれることもある——別のワーカーが、この worker が fail() を呼ぶより先に
        // このジョブを再 claim して終端まで進めていた場合。良性の競合なので
        // `leaseConflicts` に記録し、`unsupported`/`failed` には数えず次のジョブへ進む。
        try {
          await deps.outboxStore.fail(
            ctx,
            job.id,
            `${UNSUPPORTED_KIND_ERROR_PREFIX}${job.kind}`,
            job.attempts,
          );
        } catch (err) {
          if (err instanceof OutboxLeaseConflictError) {
            leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "fail" });
            continue;
          }
          throw err;
        }
        unsupported.push({ jobId: job.id, kind: job.kind });
        failed += 1;
        continue;
      }
      try {
        await handler(ctx, job);
        // 🔴 ADR 0142: `complete` がリース競合で弾かれることがある——`handler` の
        // 処理自体には成功したが、その完了を記録しようとした時点で、既に別の
        // ワーカーがこのジョブを再 claim して終端まで進めていた場合。良性の競合
        // なので `leaseConflicts` に記録するだけで、`fail()` は呼ばない
        // （呼んでも同じ理由でまた弾かれるだけであり、かつ「処理には成功した」
        // ジョブを `failed` にも数えない——事実と違う顔になる）。
        await deps.outboxStore.complete(ctx, job.id, job.attempts);
        processed += 1;
      } catch (err) {
        if (err instanceof OutboxLeaseConflictError) {
          leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "complete" });
          continue;
        }
        try {
          await deps.outboxStore.fail(
            ctx,
            job.id,
            err instanceof Error ? err.message : String(err),
            job.attempts,
          );
        } catch (failErr) {
          if (failErr instanceof OutboxLeaseConflictError) {
            leaseConflicts.push({ jobId: job.id, kind: job.kind, attemptedOutcome: "fail" });
            continue;
          }
          throw failErr;
        }
        failed += 1;
      }
    }
    return { processed, failed, unsupported, leaseConflicts };
  }

  const tokenCounter = deps.tokenCounter ?? heuristicTokenCounter;

  async function recall(ctx: Ctx, query: RecallQuery): Promise<RecallResult> {
    return runRecall(ctx, query, {
      memoryStore: deps.memoryStore,
      vectorStore: deps.vectorStore,
      lexicalStore: deps.lexicalStore,
      embeddingProvider: deps.embeddingProvider,
      tenantSettingsStore: deps.tenantSettingsStore,
      clock,
      tokenCounter,
      outputValidation: deps.outputValidation,
    });
  }

  /**
   * `Runtime.getRecall` の実装（Issue #312、ADR 0161）。doc コメントは interface 側にある
   * ——ここは素通しそのものだけ。
   */
  async function getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null> {
    return deps.memoryStore.getRecall(ctx, recallId);
  }

  async function reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
    return deps.memoryStore.requeueEmbedJobs(ctx, opts);
  }

  /**
   * `Runtime.sweepArchive` の実装（ADR 0114、Issue #364 /
   * [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md)）。
   * doc コメントは interface 側にある——ここは「口が在るかどうかで分岐する」という
   * アルゴリズムと、`opts.clock` 省略時の解決の2つだけ。
   *
   * `deps.memoryStore.archiveDecayed` を一度ローカル変数へ受けてから `undefined` を
   * 判定するのは、ADR 0100 の `supersedeWithNewMemories` 呼び出しと同じ作法——
   * `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す必要があるため
   * （分割代入したメソッドは `this` を失うので、呼び出し時に元のオブジェクトを渡す）。
   *
   * ADR 0186: `opts.clock` を省略したら `tenant_settings.decay_clock` に従う
   * （`resolveActivityClockInputs`/`resolveReinforceNowSeq` と同じ `readDecayClock`/
   * `readActivitySeq` を使う、同じ規律）。**`opts.clock` を明示で渡した呼び出し元の
   * 挙動は変えない**（`??` で省略時だけ補う）。解決した `clock` が `'wall'` のときは
   * `tenant_activity` を一度も読まない——`resolveActivityClockInputs` 等と同じ理由で、
   * `decay_clock` を設定していないテナント（既定 `'wall'`）の挙動を1バイトも変えない。
   */
  async function sweepArchive(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<SweepArchiveResult> {
    const archiveDecayed = deps.memoryStore.archiveDecayed;
    if (archiveDecayed === undefined) {
      return { supported: false, archived: [], reachedLimit: false };
    }
    const clock = opts.clock ?? (await readDecayClock(deps.tenantSettingsStore, ctx));
    const nowSeq =
      opts.nowSeq ??
      (clock === "wall" ? undefined : await readActivitySeq(deps.tenantSettingsStore, ctx));
    const result = await archiveDecayed.call(deps.memoryStore, ctx, { ...opts, clock, nowSeq });
    return { supported: true, archived: result.archived, reachedLimit: result.reachedLimit };
  }

  /**
   * `Runtime.restoreArchived` の実装（Issue #195、ADR 0122）。doc コメントは interface
   * 側（`restoreArchived` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   * `forget` の実装と意図的に同じ骨格を持つ（`ForgetOutcome`/`RestoreArchivedOutcome`
   * の対応は両者の doc コメント参照）。
   */
  async function restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    if (ids.length === 0) {
      return { outcomes: [] };
    }

    const found = await deps.memoryStore.getMany(ctx, ids);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }

    const actor = opts?.actor ?? { type: "system" };
    const outcomes: RestoreArchivedOutcome[] = [];
    // ADR 0165 決めたこと16: この呼び出し全体で1回だけ読む（`buildNewMemoriesForCandidates`
    // が `resolveActivityClockInputs` を候補バッチ1つにつき1回だけ読むのと同じ理由——
    // 対象 id ごとに読み直すと 'activity'/'either' のテナントで id の数だけ
    // `tenant_activity` への往復が増える）。
    const reinforceOpts = toReinforceOptions(await resolveReinforceNowSeq(ctx));

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const current = byId.get(id);
      if (current === undefined) {
        outcomes.push({ memoryId: id, kind: "not_found" });
        continue;
      }
      if (current.status !== "archived") {
        outcomes.push({
          memoryId: id,
          kind: "status_not_archived",
          status: current.status as Exclude<MemoryStatus, "archived">,
        });
        continue;
      }

      try {
        const { memory } = await deps.memoryStore.updateStatusWithEvent(
          ctx,
          id,
          "active",
          { expectedStatus: "archived" },
          {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "restored",
            actor,
            digestSnapshot: current.digest,
            meta: opts?.reason === undefined ? {} : { reason: opts.reason },
          },
        );
        byId.set(id, memory);

        // マネージャー決定（Issue #196 / ADR 0153「restoreArchived と忘却ゲートの
        // 相互作用」）: 復帰そのものが「いま必要だ」という明示の信号なので、
        // reinforce して decay_floor_at を復帰の瞬間から引き直す。これをしないと、
        // status は active に戻ったのに decayFloorAt が過去を指したままなので、
        // recall() の既定の忘却ゲート（ADR 0153、`RecallQuery.includeFullyDecayed`
        // の既定 false）に阻まれて recall に二度と現れない——「必要な場合だけ過去の
        // 記憶を再び呼び戻せる」（docs/north-star.md「目指す姿」）と正面から食い違う。
        // interface/adapter は増やさない——既存の契約された口 `reinforce`
        // （`docs/memory-model.md` §7、ADR 0041・ADR 0048）をそのまま呼ぶだけである。
        //
        // ⚠ status の復帰は既にここで成功している。reinforce が失敗しても、
        // 既に成功した復帰を握り潰さない——outcome は "restored" のままにし
        // （`kind` を "failed" に落とさない）、reinforce の失敗は追加欄
        // `reinforceError` で運ぶ（additive。既存欄の意味は変えない）。
        // これは既存の「競合以外の例外は打ち切って残りを not_attempted にする」
        // という規律（下の catch 節）とは別の規律である——あちらは「書き込みその
        // ものが起きなかった」場合の安全弁だが、こちらは「主たる書き込み
        // （status の復帰）は成功したあとの、副次的な強化の失敗」であり、
        // 呼び出し側にとっての意味が違う（前者は「何も変わっていない」、
        // 後者は「復帰はしたが、忘却ゲートに再び阻まれるかもしれない」）。
        // だから reinforce 専用の内側の try/catch で切り離し、外側の catch
        // （`MemoryStatusConflictError` 分岐・打ち切り分岐）に一切触れさせない。
        const reinforcedAt = clock.now();
        let reinforceError: string | undefined;
        try {
          const reinforced = await deps.memoryStore.reinforce(ctx, id, reinforcedAt, reinforceOpts);
          byId.set(id, reinforced);
        } catch (err) {
          reinforceError = err instanceof Error ? err.message : String(err);
        }

        if (reinforceError === undefined) {
          outcomes.push({ memoryId: id, kind: "restored", previousStatus: "archived" });
        } else {
          outcomes.push({
            memoryId: id,
            kind: "restored",
            previousStatus: "archived",
            reinforceError,
          });
        }
      } catch (error) {
        if (error instanceof MemoryStatusConflictError) {
          // 安全弁（`forget` と同じ形。1回だけ再読して打ち切る——上限の無い
          // 再試行ループを作らない）。
          const refetched = await deps.memoryStore.get(ctx, id);
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if (refetched.status === "active") {
            // 別の呼び出しが先に同じ復帰（archived → active）を済ませていた——
            // 求めていた状態に既に居るのは対立ではない（`forget` の
            // `already_forgotten` と同じ扱い。interface doc コメント参照）。
            byId.set(id, refetched);
            outcomes.push({ memoryId: id, kind: "status_not_archived", status: "active" });
          } else {
            // active 以外の別の状態に変わっていた（または archived のまま、という
            // 二重の競合）——求めていない状態への変化なので conflicted として扱う。
            byId.set(id, refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外——打ち切って、残りは「見ていない」として返す（interface の
        // doc コメント参照）。例外をここより外へは投げない。
        outcomes.push({
          memoryId: id,
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        for (let j = i + 1; j < ids.length; j += 1) {
          outcomes.push({ memoryId: ids[j]!, kind: "not_attempted" });
        }
        return { outcomes };
      }
    }

    return { outcomes };
  }

  /**
   * `Runtime.forget` の実装（Issue #102）。doc コメントは interface 側
   * （`forget` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   */
  async function forget(
    ctx: Ctx,
    target: ForgetTarget,
    opts?: ForgetOptions,
  ): Promise<ForgetResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;
    if (ids.length === 0) {
      return { outcomes: [] };
    }

    const found = await deps.memoryStore.getMany(ctx, ids);
    // 呼び出しの中で同じ id が複数回現れたとき、1回目の書き込み結果を2回目が見るための
    // ローカルの写し。書き込みが成功するたびに更新する。
    //
    // ⚠ **これは正しさのためではない。**この更新を消しても `outcomes` は変わらない
    // ——2回目は「書き込み前」の status で CAS を撃ち、それが弾かれ、読み直して
    // `already_forgotten` に落ち着くからである（変異試験で確認した。ADR 0087）。
    // **買っているのは往復である**: この写しが無いと、重複した id 1つにつき
    // 「必ず失敗する UPDATE」1回と「読み直しの SELECT」1回が余分に DB へ飛ぶ。
    // 🔴 効果が `outcomes` に出ない以上、歯は**呼び出し回数のほうを数える**
    // （`forget.test.ts` の「重複した id は…往復を増やさない」）。
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }

    const actor = opts?.actor ?? { type: "system" };
    const outcomes: ForgetOutcome[] = [];

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const current = byId.get(id);
      if (current === undefined) {
        outcomes.push({ memoryId: id, kind: "not_found" });
        continue;
      }
      if (current.status === "forgotten") {
        outcomes.push({ memoryId: id, kind: "already_forgotten" });
        continue;
      }

      const observedStatus = current.status;
      try {
        const { memory } = await deps.memoryStore.updateStatusWithEvent(
          ctx,
          id,
          "forgotten",
          { expectedStatus: observedStatus },
          {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "forgotten",
            actor,
            digestSnapshot: current.digest,
            meta: opts?.reason === undefined ? {} : { reason: opts.reason },
          },
        );
        byId.set(id, memory);
        outcomes.push({ memoryId: id, kind: "forgotten", previousStatus: observedStatus });
      } catch (error) {
        if (error instanceof MemoryStatusConflictError) {
          // 安全弁（ADR 0030 と同じ形。ただし `reextract` と違い、ここは1回だけ
          // 再読して打ち切る——上限の無い再試行ループを作らない、という明示の決定）。
          const refetched = await deps.memoryStore.get(ctx, id);
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if (refetched.status === "forgotten") {
            byId.set(id, refetched);
            outcomes.push({ memoryId: id, kind: "already_forgotten" });
          } else {
            byId.set(id, refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外——打ち切って、残りは「見ていない」として返す（interface の
        // doc コメント参照）。例外をここより外へは投げない。
        outcomes.push({
          memoryId: id,
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        for (let j = i + 1; j < ids.length; j += 1) {
          outcomes.push({ memoryId: ids[j]!, kind: "not_attempted" });
        }
        return { outcomes };
      }
    }

    return { outcomes };
  }

  /**
   * `Runtime.purge` の実装（Issue #198、ADR 0124）。doc コメントは interface 側
   * （`purge` の JSDoc）にある——ここはアルゴリズムそのものだけ。`forget`/`restoreArchived`
   * と意図的に同じ骨格を持つ。CAS の条件・`dryRun`・`supported`・`vectorStore.delete` の
   * 4点だけが違う。
   */
  async function purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult> {
    const ids: MemoryId[] = "memoryId" in target ? [target.memoryId] : target.memoryIds;

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（ADR 0100/ADR 0114 と
    // 同じ作法。分割代入したメソッドは `this` を失う）。
    const purgeMemory = deps.memoryStore.purgeMemory;
    const supported = purgeMemory !== undefined;

    if (ids.length === 0) {
      return { supported, outcomes: [] };
    }
    if (!supported) {
      return {
        supported: false,
        outcomes: ids.map((id) => ({ memoryId: id, kind: "not_attempted" }) as const),
      };
    }

    const found = await deps.memoryStore.getMany(ctx, ids);
    // `forget` と同じ理由（往復の節約。`ADR 0087`）——正しさのためではない。
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }

    const actor = opts?.actor ?? { type: "system" };
    const dryRun = opts?.dryRun ?? false;
    const outcomes: PurgeOutcome[] = [];

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]!;
      const current = byId.get(id);
      if (current === undefined) {
        outcomes.push({ memoryId: id, kind: "not_found" });
        continue;
      }
      if (current.status !== "forgotten") {
        outcomes.push({
          memoryId: id,
          kind: "status_not_forgotten",
          status: current.status as Exclude<MemoryStatus, "forgotten">,
        });
        continue;
      }
      if ((current.purgedAt ?? null) !== null) {
        outcomes.push({ memoryId: id, kind: "already_purged" });
        continue;
      }

      if (dryRun) {
        outcomes.push({ memoryId: id, kind: "would_purge", previousStatus: "forgotten" });
        continue;
      }

      try {
        const { memory } = await purgeMemory.call(
          deps.memoryStore,
          ctx,
          id,
          { content: PURGE_TOMBSTONE_CONTENT, digest: PURGE_TOMBSTONE_DIGEST },
          {
            tenantId: ctx.tenantId,
            memoryId: id,
            kind: "purged",
            actor,
            digestSnapshot: current.digest,
            meta: opts?.reason === undefined ? {} : { reason: opts.reason },
          },
        );
        byId.set(id, memory);
        outcomes.push({ memoryId: id, kind: "purged", previousStatus: "forgotten" });

        // ADR 0124 決定5: ベストエフォート。失敗しても "purged" の判定は変えない
        // ——MemoryStore 側の書き込みは既に確定しており、ここで "failed" に格下げすると
        // 「安全に再試行できる」という failed/not_attempted の意味を裏切る。
        try {
          await deps.vectorStore.delete(ctx, deps.embeddingProvider.space, id);
        } catch {
          // 握り潰す。ADR 0124「引き受けた負債」参照。
        }
      } catch (error) {
        if (error instanceof MemoryPurgeConflictError) {
          // 安全弁（`forget`/`restoreArchived` と同じ形。1回だけ再読して打ち切る
          // ——上限の無い再試行ループを作らない）。
          const refetched = await deps.memoryStore.get(ctx, id);
          if (refetched === null) {
            outcomes.push({ memoryId: id, kind: "not_found" });
          } else if ((refetched.purgedAt ?? null) !== null) {
            byId.set(id, refetched);
            outcomes.push({ memoryId: id, kind: "already_purged" });
          } else if (refetched.status !== "forgotten") {
            byId.set(id, refetched);
            outcomes.push({
              memoryId: id,
              kind: "status_not_forgotten",
              status: refetched.status as Exclude<MemoryStatus, "forgotten">,
            });
          } else {
            // status === "forgotten" かつ purgedAt === null のまま——本 PR の時点では
            // 到達しないはずの防御的な分岐（ADR 0124 決定2「並行呼び出し」参照）。
            byId.set(id, refetched);
            outcomes.push({
              memoryId: id,
              kind: "conflicted",
              observedStatus: refetched.status,
            });
          }
          continue;
        }
        // 競合以外の例外——打ち切って、残りは「見ていない」として返す（interface の
        // doc コメント参照）。例外をここより外へは投げない。
        outcomes.push({
          memoryId: id,
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        for (let j = i + 1; j < ids.length; j += 1) {
          outcomes.push({ memoryId: ids[j]!, kind: "not_attempted" });
        }
        return { supported: true, outcomes };
      }
    }

    return { supported: true, outcomes };
  }

  /**
   * `Runtime.markContested` の実装（Issue #197、ADR 0134）。doc コメントは interface 側
   * （`markContested` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   */
  async function markContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    opts?: MarkContestedOptions,
  ): Promise<MarkContestedResult> {
    if (firstId === secondId) {
      throw new RangeError("Runtime.markContested: firstId and secondId must differ");
    }

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（ADR 0100/ADR 0114 と
    // 同じ作法。分割代入したメソッドは `this` を失う）。
    const markContestedPair = deps.memoryStore.markContestedPair;
    if (markContestedPair === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const classify = (id: MemoryId, memory: Memory | undefined): MarkContestedSideOutcome => {
      if (memory === undefined) {
        return { memoryId: id, kind: "not_found" };
      }
      if (memory.status !== "active") {
        return { memoryId: id, kind: "status_not_active", status: memory.status };
      }
      return { memoryId: id, kind: "eligible" };
    };

    const found = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }

    const firstSide = classify(firstId, byId.get(firstId));
    const secondSide = classify(secondId, byId.get(secondId));
    if (firstSide.kind !== "eligible" || secondSide.kind !== "eligible") {
      return { supported: true, outcome: { kind: "ineligible", sides: [firstSide, secondSide] } };
    }

    const actor = opts?.actor ?? { type: "system" };
    const meta: Record<string, unknown> =
      opts?.reason === undefined
        ? { reason: "contested" }
        : { reason: "contested", note: opts.reason };

    try {
      const { first, second } = await markContestedPair.call(
        deps.memoryStore,
        ctx,
        {
          id: firstId,
          event: {
            tenantId: ctx.tenantId,
            memoryId: firstId,
            kind: "updated",
            actor,
            digestSnapshot: byId.get(firstId)!.digest,
            meta,
          },
        },
        {
          id: secondId,
          event: {
            tenantId: ctx.tenantId,
            memoryId: secondId,
            kind: "updated",
            actor,
            digestSnapshot: byId.get(secondId)!.digest,
            meta,
          },
        },
      );
      return { supported: true, outcome: { kind: "contested", first, second } };
    } catch (error) {
      if (error instanceof MemoryStatusConflictError) {
        // 安全弁（`forget`/`restoreArchived`/`purge` と同じ形。1回だけ再読して打ち切る
        // ——上限の無い再試行ループを作らない）。
        const refetched = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
        const refetchedById = new Map(refetched.map((m) => [m.id, m]));
        return {
          supported: true,
          outcome: {
            kind: "conflict",
            conflicts: [
              { id: firstId, observedStatus: refetchedById.get(firstId)?.status ?? null },
              { id: secondId, observedStatus: refetchedById.get(secondId)?.status ?? null },
            ],
          },
        };
      }
      throw error;
    }
  }

  /**
   * `Runtime.resolveContested` の実装（Issue #197、ADR 0150）。doc コメントは interface 側
   * （`resolveContested` の JSDoc）にある——ここはアルゴリズムそのものだけ。`markContested`
   * の実装と対称に書いてある（読み方も同じ順で追える）。
   */
  async function resolveContested(
    ctx: Ctx,
    firstId: MemoryId,
    secondId: MemoryId,
    resolution: ContestedResolution,
    opts?: ResolveContestedOptions,
  ): Promise<ResolveContestedResult> {
    if (firstId === secondId) {
      throw new RangeError("Runtime.resolveContested: firstId and secondId must differ");
    }
    if (
      resolution.kind === "supersede" &&
      resolution.winnerId !== firstId &&
      resolution.winnerId !== secondId
    ) {
      throw new RangeError(
        "Runtime.resolveContested: resolution.winnerId must be firstId or secondId",
      );
    }

    // `.call(deps.memoryStore, ...)` で `this` を明示的に束ね直す（`markContested` と同じ作法。
    // 分割代入したメソッドは `this` を失う）。
    const resolveContestedPair = deps.memoryStore.resolveContestedPair;
    if (resolveContestedPair === undefined) {
      return { supported: false, outcome: { kind: "not_attempted" } };
    }

    const classify = (
      id: MemoryId,
      memory: Memory | undefined,
      otherId: MemoryId,
    ): ResolveContestedSideOutcome => {
      if (memory === undefined) {
        return { memoryId: id, kind: "not_found" };
      }
      if (memory.status !== "contested") {
        return { memoryId: id, kind: "status_not_contested", status: memory.status };
      }
      if (memory.contestedWithId !== otherId) {
        // ADR 0046 が数え上げた「一対一が破れた状態」——今日の実装では
        // `markContestedPair`（ADR 0134）経由でしか `contestedWithId` は書かれないため
        // 到達しないはずだが、防御的に分類する（`PurgeOutcome.conflicted` と同じ立場）。
        return {
          memoryId: id,
          kind: "pair_broken",
          contestedWithId: memory.contestedWithId ?? null,
        };
      }
      return { memoryId: id, kind: "eligible" };
    };

    const found = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }

    const firstMemory = byId.get(firstId);
    const secondMemory = byId.get(secondId);
    const firstSide = classify(firstId, firstMemory, secondId);
    const secondSide = classify(secondId, secondMemory, firstId);
    if (firstSide.kind !== "eligible" || secondSide.kind !== "eligible") {
      return { supported: true, outcome: { kind: "ineligible", sides: [firstSide, secondSide] } };
    }

    const actor = opts?.actor ?? { type: "system" };
    const resolutionKind = resolution.kind;
    const buildMeta = (): Record<string, unknown> =>
      opts?.reason === undefined
        ? { reason: "contested_resolved", resolution: resolutionKind }
        : { reason: "contested_resolved", resolution: resolutionKind, note: opts.reason };

    // `docs/memory-model.md` §11 行7「`updated` または `superseded`」: `both_active` は
    // 両側とも `updated`、`supersede` は勝者が `updated`・敗者が `superseded`。
    const buildSide = (
      id: MemoryId,
      memory: Memory,
    ): {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    } => {
      const buildEvent = (kind: "updated" | "superseded"): NewMemoryEvent => ({
        tenantId: ctx.tenantId,
        memoryId: id,
        kind,
        actor,
        digestSnapshot: memory.digest,
        meta: buildMeta(),
      });
      if (resolution.kind === "both_active") {
        return { id, status: "active", event: buildEvent("updated") };
      }
      if (id === resolution.winnerId) {
        return { id, status: "active", event: buildEvent("updated") };
      }
      return {
        id,
        status: "superseded",
        supersededById: resolution.winnerId,
        event: buildEvent("superseded"),
      };
    };

    try {
      const { first, second } = await resolveContestedPair.call(
        deps.memoryStore,
        ctx,
        buildSide(firstId, firstMemory!),
        buildSide(secondId, secondMemory!),
      );
      return { supported: true, outcome: { kind: "resolved", first, second } };
    } catch (error) {
      if (error instanceof MemoryStatusConflictError) {
        // 安全弁（`markContested` と同じ形。1回だけ再読して打ち切る——上限の無い再試行
        // ループを作らない）。
        const refetched = await deps.memoryStore.getMany(ctx, [firstId, secondId]);
        const refetchedById = new Map(refetched.map((m) => [m.id, m]));
        return {
          supported: true,
          outcome: {
            kind: "conflict",
            conflicts: [
              { id: firstId, observedStatus: refetchedById.get(firstId)?.status ?? null },
              { id: secondId, observedStatus: refetchedById.get(secondId)?.status ?? null },
            ],
          },
        };
      }
      throw error;
    }
  }

  /**
   * `Runtime.consolidate` の実装（Issue #103、ADR 0089）。doc コメントは interface 側
   * （`consolidate` の JSDoc）にある——ここはアルゴリズムそのものだけ。
   */
  async function consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult> {
    const target = opts.target;

    // 1. 対象の正規化。
    let ids: MemoryId[];
    if ("memoryIds" in target) {
      ids = target.memoryIds;
    } else if ("seedMemoryId" in target) {
      // Issue #135（ADR 0152）: 「この記憶に似ているものを mnemora 自身が集めて、
      // 1つに畳め」。ConsolidateTarget の doc コメント参照。
      const seed = await deps.memoryStore.get(ctx, target.seedMemoryId);
      if (seed === null) {
        // 種が無い——recall を呼ばない。対象は種の id 1件のみとなり、後続の getMany が
        // not_found に分類する（新しい nothingReason は発明しない）。
        ids = [target.seedMemoryId];
      } else {
        // 種の digest を text にして recall() を1回呼ぶ——{ query } 形とまったく同じ
        // 経路を通す（新しい「似ている」の判定を作らない）。
        const recallResult = await recall(ctx, { text: seed.digest });
        const minAffinity = target.minAffinity ?? DEFAULT_CONSOLIDATE_MIN_AFFINITY;
        const neighborIds = recallResult.memories
          .filter((m) => m.memoryId !== target.seedMemoryId)
          .filter((m) => computeAffinity(m.score) >= minAffinity)
          .map((m) => m.memoryId);
        // 種は minAffinity の判定を受けず、必ず先頭に置く（種の embedding がまだ無いと
        // recall() の結果に現れないため——ConsolidateTarget の doc コメント参照）。
        ids = [target.seedMemoryId, ...neighborIds];
        if (target.maxCandidates !== undefined) {
          ids = ids.slice(0, target.maxCandidates);
        }
      }
    } else {
      const recallResult = await recall(ctx, target.query);
      const recalledIds = recallResult.memories.map((m) => m.memoryId);
      ids =
        target.maxCandidates === undefined
          ? recalledIds
          : recalledIds.slice(0, target.maxCandidates);
    }
    if (ids.length === 0) {
      // store に一切触れない——「見ていない」。
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "not_examined",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: [],
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 2. `getMany` で一括読み、id ごとに「まだ何も書いていない時点」の分類を固定する。
    type InitialClassification =
      | { kind: "not_found" }
      | { kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
      | { kind: "active" };

    const uniqueIds = Array.from(new Set(ids));
    const found = await deps.memoryStore.getMany(ctx, uniqueIds);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }
    const initialById = new Map<MemoryId, InitialClassification>();
    for (const id of uniqueIds) {
      const memory = byId.get(id);
      if (memory === undefined) {
        initialById.set(id, { kind: "not_found" });
      } else if (memory.status !== "active") {
        initialById.set(id, {
          kind: "status_not_active",
          status: memory.status as Exclude<MemoryStatus, "active">,
        });
      } else {
        initialById.set(id, { kind: "active" });
      }
    }

    /**
     * `ids`（入力順・重複を保つ）を `ConsolidateSourceOutcome[]` へ写す。`active` と分類された
     * id だけ `activeOutcome` に委ねる——`not_found`/`status_not_active` はどの分岐でも同じ顔。
     */
    function mapSources(
      activeOutcome: (id: MemoryId) => ConsolidateSourceOutcome,
    ): ConsolidateSourceOutcome[] {
      return ids.map((id) => {
        const cls = initialById.get(id)!;
        if (cls.kind === "not_found") {
          return { memoryId: id, kind: "not_found" };
        }
        if (cls.kind === "status_not_active") {
          return { memoryId: id, kind: "status_not_active", status: cls.status };
        }
        return activeOutcome(id);
      });
    }

    // eligible: 重複を除いた active id を、`ids` の中で最初に現れた順に並べる。
    const eligibleIds: MemoryId[] = [];
    const seenEligible = new Set<MemoryId>();
    for (const id of ids) {
      if (initialById.get(id)!.kind === "active" && !seenEligible.has(id)) {
        seenEligible.add(id);
        eligibleIds.push(id);
      }
    }

    // 3. eligible が0件・1件なら、ここで打ち切る（冪等性の芯）。
    if (eligibleIds.length === 0) {
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "nothing_to_consolidate",
        nothingReason: "no_eligible_sources",
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }
    if (eligibleIds.length === 1) {
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "nothing_to_consolidate",
        nothingReason: "single_eligible_source",
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 4. dryRun はここで打ち切る。1件も書かない。
    if (opts.dryRun === true) {
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "dry_run",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    const eligibleMemories = eligibleIds.map((id) => byId.get(id)!);

    // 5. LLM を1回呼ぶ。失敗したら1件も書かず、eligible だったものは not_attempted に落とす。
    let llmResult: ConsolidationLLMResult;
    try {
      llmResult = await deps.llmProvider.completeStructured(ctx, {
        prompt: buildConsolidationPrompt(eligibleMemories),
        schema: ConsolidationLLMResultSchema,
      });
    } catch (error) {
      return {
        // 書き込みを1件も試みていない（ADR 0100）。
        atomicity: "not_attempted" as const,
        outcome: "llm_failed",
        nothingReason: null,
        consolidatedMemoryId: null,
        sources: mapSources((id) => ({ memoryId: id, kind: "not_attempted" })),
        llmCalls: 1,
        llmFailure: describeExtractionFailure(error),
      };
    }

    // 6. 統合先を作る。
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // ADR 0165 決めたこと3・5・12: 書き込み側3箇所のうちの1つ（consolidate 手順6）。
    const activityClockInputs = await resolveActivityClockInputs(ctx);
    const newMemory = buildConsolidatedMemory({
      ctx,
      eligible: eligibleMemories,
      llmResult,
      hashContent: deps.hashContent,
      digestFallbackLength,
      halfLifeHours,
      now,
      ...activityClockInputs,
    });
    const actor = opts.actor ?? { type: "system" };
    const buildCreatedEvent = () =>
      ({
        tenantId: ctx.tenantId,
        memoryId: "",
        kind: "created",
        actor: { type: "system" },
        digestSnapshot: "",
        sizeBeforeBytes: null,
        meta: { reason: "consolidated", sources: eligibleIds },
      }) satisfies NewMemoryEvent;
    const buildConsolidateSupersedeEvent = (source: Memory, supersededById?: MemoryId) =>
      ({
        tenantId: ctx.tenantId,
        memoryId: source.id,
        kind: "superseded",
        actor,
        digestSnapshot: source.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "consolidated",
          // 口を使う経路では store が解決した id で埋める（ADR 0100）。⟹ 監査ログの中身は
          // 口が在る adapter と無い adapter で同一になる。
          ...(supersededById === undefined ? {} : { supersededById }),
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
        },
      }) satisfies NewMemoryEvent;

    const finalOutcomeById = new Map<MemoryId, ConsolidateSourceOutcome>();

    // ------------------------------------------------------------------
    // ADR 0100: 口が在れば、統合先の作成と統合元の supersede を1トランザクションで撃つ。
    // 🔴 フォールバックは**口の不在に対してだけ**。⛔ 投げられたときに今日の経路で
    // 撃ち直さない（「張れなかった」と「張ったが失敗した」を潰さない）。
    //
    // 🔴 ADR 0089 決定5 を**部分的に覆す**: あちらは「予期しない例外が出たらそこで打ち切り、
    // 残りを not_attempted にして返す（投げない）」と決めていた。この経路では**投げる**。
    // 理由——ADR 0089 が「投げない」とした理由は逐語で「部分的に起きたことを呼び出し側から
    // 見えなくしないためである」。1トランザクションでは**部分的に起きたことが無くなる**
    // （統合先の作成も supersede も全部巻き戻る）ので、その理由は満たされたままである。
    // ⚠ 型は変わらないため、例外を受け止めていない呼び手はコンパイルでは気づけない。
    // ADR 0100「引き受ける負債」参照。オーナー承認済み（`docs/autonomy.md:114`）。
    // ------------------------------------------------------------------
    const supersedeWithNewMemories = deps.memoryStore.supersedeWithNewMemories;
    if (supersedeWithNewMemories !== undefined) {
      const result = await supersedeWithNewMemories.call(
        deps.memoryStore,
        ctx,
        [{ input: newMemory, jobKinds: ["embed"] as OutboxJobKind[] }],
        eligibleIds.map((id) => ({
          id,
          supersededByIndex: 0,
          expectedStatus: "active" as MemoryStatus,
          event: buildConsolidateSupersedeEvent(byId.get(id)!),
        })),
      );

      const consolidated = result.created[0]!;
      if (consolidated.created) {
        await deps.eventStore.append(ctx, {
          ...buildCreatedEvent(),
          memoryId: consolidated.memory.id,
          digestSnapshot: consolidated.memory.digest,
        });
      }

      const conflictedById = new Map(result.conflicted.map((c) => [c.id, c.observedStatus]));
      for (const id of eligibleIds) {
        const observed = conflictedById.get(id);
        finalOutcomeById.set(
          id,
          observed === undefined
            ? { memoryId: id, kind: "superseded", previousStatus: "active" }
            : { memoryId: id, kind: "status_changed_concurrently", observedStatus: observed },
        );
      }

      return {
        outcome: "consolidated",
        nothingReason: null,
        consolidatedMemoryId: consolidated.memory.id,
        sources: mapSources((id) => finalOutcomeById.get(id)!),
        llmCalls: 1,
        llmFailure: null,
        atomicity: "store_supported",
      };
    }

    // 口が無い adapter——今日どおりの2段（作成 → supersede ループ）。
    const { memory: consolidatedMemory, created } = await deps.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory,
      ["embed"],
    );
    if (created) {
      await deps.eventStore.append(ctx, {
        ...buildCreatedEvent(),
        memoryId: consolidatedMemory.id,
        digestSnapshot: consolidatedMemory.digest,
      });
    }
    // embed ジョブは常に outbox 経由（`createMemoryWithOutbox` が積む）。ここでは何もしない
    // — tick() の processEmbedJob が処理する。

    // 7. eligible を1件ずつ superseded へ CAS する（`reextract` のループと同じ形）。
    for (let i = 0; i < eligibleIds.length; i += 1) {
      const id = eligibleIds[i]!;
      const source = byId.get(id)!;
      try {
        await deps.memoryStore.updateStatusWithEvent(
          ctx,
          id,
          "superseded",
          { supersededById: consolidatedMemory.id, expectedStatus: "active" },
          buildConsolidateSupersedeEvent(source, consolidatedMemory.id),
        );
        finalOutcomeById.set(id, { memoryId: id, kind: "superseded", previousStatus: "active" });
      } catch (error) {
        if (error instanceof MemoryStatusConflictError) {
          // CAS が破れた——この1件だけ飛ばして続行する（`reextract` と同じ）。
          finalOutcomeById.set(id, {
            memoryId: id,
            kind: "status_changed_concurrently",
            observedStatus: error.observedStatus,
          });
          continue;
        }
        // 競合以外の例外——ここで打ち切り、残りは「見ていない」として返す。例外は外へ投げない
        // （ADR 0089 決定5。⚠ この経路では書き込みが部分的に起きているため、ADR 0100 の
        // 判断はここには当てはまらない——投げずに返す形をそのまま残す）。
        finalOutcomeById.set(id, {
          memoryId: id,
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        for (let j = i + 1; j < eligibleIds.length; j += 1) {
          finalOutcomeById.set(eligibleIds[j]!, {
            memoryId: eligibleIds[j]!,
            kind: "not_attempted",
          });
        }
        break;
      }
    }

    // 8. 統合先は既に作られている——途中で supersede が打ち切られても outcome は変わらない
    // （ADR 0089 §3 手順8）。
    return {
      outcome: "consolidated",
      nothingReason: null,
      consolidatedMemoryId: consolidatedMemory.id,
      sources: mapSources((id) => finalOutcomeById.get(id)!),
      llmCalls: 1,
      llmFailure: null,
      atomicity: "store_unsupported",
    };
  }

  /**
   * `Runtime.reflect` の実装（Issue #104）。doc コメントは interface 側
   * （`reflect` の JSDoc）にある——ここはアルゴリズムそのものだけ。`consolidate` の実装の
   * 双子だが、書き込みの終盤（手順7以降）が違う——既存の行へは一切書き込まない。
   */
  async function reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult> {
    const target = opts.target;

    // 1. 対象の正規化。
    let ids: MemoryId[];
    if ("memoryIds" in target) {
      ids = target.memoryIds;
    } else if ("seedMemoryId" in target) {
      // Issue #204（ADR 0154）: `consolidate` の { seedMemoryId }（ADR 0152）と同じ土台選定。
      // ReflectTarget の doc コメント参照。
      const seed = await deps.memoryStore.get(ctx, target.seedMemoryId);
      if (seed === null) {
        // 種が無い——recall を呼ばない。対象は種の id 1件のみとなり、後続の getMany が
        // not_found に分類する（新しい nothingReason は発明しない）。
        ids = [target.seedMemoryId];
      } else {
        // 種の digest を text にして recall() を1回呼ぶ——{ query } 形とまったく同じ
        // 経路を通す（新しい「似ている」の判定を作らない）。
        const recallResult = await recall(ctx, { text: seed.digest });
        const minAffinity = target.minAffinity ?? DEFAULT_REFLECT_MIN_AFFINITY;
        const neighborIds = recallResult.memories
          .filter((m) => m.memoryId !== target.seedMemoryId)
          .filter((m) => computeAffinity(m.score) >= minAffinity)
          .map((m) => m.memoryId);
        // 種は minAffinity の判定を受けず、必ず先頭に置く（種の embedding がまだ無いと
        // recall() の結果に現れないため——ReflectTarget の doc コメント参照）。
        ids = [target.seedMemoryId, ...neighborIds];
        if (target.maxCandidates !== undefined) {
          ids = ids.slice(0, target.maxCandidates);
        }
      }
    } else {
      const recallResult = await recall(ctx, target.query);
      const recalledIds = recallResult.memories.map((m) => m.memoryId);
      ids =
        target.maxCandidates === undefined
          ? recalledIds
          : recalledIds.slice(0, target.maxCandidates);
    }
    if (ids.length === 0) {
      // store に一切触れない——「見ていない」。
      return {
        outcome: "not_examined",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: [],
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 2. `getMany` で一括読み、id ごとに「まだ何も書いていない時点」の分類を固定する。
    // 優先順: not_found → status_not_active → basis_is_reflected → eligible。
    type InitialClassification =
      | { kind: "not_found" }
      | { kind: "status_not_active"; status: Exclude<MemoryStatus, "active"> }
      | { kind: "basis_is_reflected" }
      | { kind: "eligible" };

    const uniqueIds = Array.from(new Set(ids));
    const found = await deps.memoryStore.getMany(ctx, uniqueIds);
    const byId = new Map<MemoryId, Memory>();
    for (const memory of found) {
      byId.set(memory.id, memory);
    }
    const initialById = new Map<MemoryId, InitialClassification>();
    for (const id of uniqueIds) {
      const memory = byId.get(id);
      if (memory === undefined) {
        initialById.set(id, { kind: "not_found" });
      } else if (memory.status !== "active") {
        initialById.set(id, {
          kind: "status_not_active",
          status: memory.status as Exclude<MemoryStatus, "active">,
        });
      } else if (memory.provenance.kind === "reflected") {
        initialById.set(id, { kind: "basis_is_reflected" });
      } else {
        initialById.set(id, { kind: "eligible" });
      }
    }

    /**
     * `ids`（入力順・重複を保つ）を `ReflectBasisOutcome[]` へ写す。`eligible` と分類された
     * id だけ `eligibleOutcome` に委ねる——それ以外はどの分岐でも同じ顔。
     */
    function mapBasis(
      eligibleOutcome: (id: MemoryId) => ReflectBasisOutcome,
    ): ReflectBasisOutcome[] {
      return ids.map((id) => {
        const cls = initialById.get(id)!;
        if (cls.kind === "not_found") {
          return { memoryId: id, kind: "not_found" };
        }
        if (cls.kind === "status_not_active") {
          return { memoryId: id, kind: "status_not_active", status: cls.status };
        }
        if (cls.kind === "basis_is_reflected") {
          return { memoryId: id, kind: "basis_is_reflected" };
        }
        return eligibleOutcome(id);
      });
    }

    // eligible: 重複を除いた「active かつ provenance.kind !== 'reflected'」の id を、`ids`
    // の中で最初に現れた順に並べる。
    const eligibleIds: MemoryId[] = [];
    const seenEligible = new Set<MemoryId>();
    for (const id of ids) {
      if (initialById.get(id)!.kind === "eligible" && !seenEligible.has(id)) {
        seenEligible.add(id);
        eligibleIds.push(id);
      }
    }

    // 3. eligible が0件なら、LLM を呼ばずに打ち切る（`consolidate` と違い、1件だけでも
    // ここでは打ち切らない——1件からの一般化も意味を持ちうる）。
    if (eligibleIds.length === 0) {
      return {
        outcome: "nothing_to_reflect",
        nothingReason: "no_eligible_basis",
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    // 4. dryRun はここで打ち切る。1件も書かない。
    if (opts.dryRun === true) {
      return {
        outcome: "dry_run",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 0,
        llmFailure: null,
      };
    }

    const eligibleMemories = eligibleIds.map((id) => byId.get(id)!);

    // 5. LLM を1回呼ぶ。失敗したら1件も書かない。
    let llmResult: ReflectionLLMResult;
    try {
      llmResult = await deps.llmProvider.completeStructured(ctx, {
        prompt: buildReflectionPrompt(eligibleMemories),
        schema: ReflectionLLMResultSchema,
      });
    } catch (error) {
      return {
        outcome: "llm_failed",
        nothingReason: null,
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 1,
        llmFailure: describeExtractionFailure(error),
      };
    }

    // 6. LLM が「一般化するものは無い」と答えた——書き込みゼロ。
    if (llmResult.outcome === "nothing") {
      return {
        outcome: "nothing_to_reflect",
        nothingReason: "llm_declined",
        reflectedMemoryId: null,
        basis: mapBasis((id) => ({ memoryId: id, kind: "eligible" })),
        llmCalls: 1,
        llmFailure: null,
      };
    }

    // 7. 新しい Memory を1件作る（既存の行へは一切書き込まない——決定4）。
    const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);
    const now = clock.now();
    // ADR 0165 決めたこと3・5・12: 書き込み側3箇所のうちの1つ（reflect 手順7）。
    const activityClockInputs = await resolveActivityClockInputs(ctx);
    const newMemory = buildReflectedMemory({
      ctx,
      eligible: eligibleMemories,
      llmResult,
      hashContent: deps.hashContent,
      digestFallbackLength,
      halfLifeHours,
      now,
      ...activityClockInputs,
    });
    const { memory: reflectedMemory, created } = await deps.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory,
      ["embed"],
    );
    if (created) {
      // 8. `created` イベントを1件積む。`reflect` はこれ以外のイベントを一切積まない
      // （既存の行の status を動かさないため、`superseded`/`forgotten` の類は存在しない）。
      await deps.eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: reflectedMemory.id,
        kind: "created",
        actor: opts.actor ?? { type: "system" },
        digestSnapshot: reflectedMemory.digest,
        sizeBeforeBytes: null,
        meta: {
          reason: "reflected",
          sources: eligibleIds,
          ...(opts.reason !== undefined ? { note: opts.reason } : {}),
        },
      });
    }
    // embed ジョブは常に outbox 経由（`createMemoryWithOutbox` が積む）。ここでは何もしない
    // — tick() の processEmbedJob が処理する。

    // 9. eligible は全件 used——`reflect` は既存の行を一切動かしていないので、`consolidate`
    // の手順7のような「途中で打ち切られる」分岐は存在しない。
    return {
      outcome: "reflected",
      nothingReason: null,
      reflectedMemoryId: reflectedMemory.id,
      basis: mapBasis((id) => ({ memoryId: id, kind: "used" })),
      llmCalls: 1,
      llmFailure: null,
    };
  }

  return {
    observe,
    tick,
    recall,
    getRecall,
    reextract,
    reembed,
    sweepArchive,
    restoreArchived,
    forget,
    purge,
    markContested,
    resolveContested,
    consolidate,
    reflect,
  };
}
