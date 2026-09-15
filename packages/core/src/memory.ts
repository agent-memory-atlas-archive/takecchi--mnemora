import { z } from "zod";
import type { MemoryId, ObservationId } from "./ids.js";
import { ProvenanceSchema, type Provenance } from "./provenance.js";

export type MemoryStatus = "active" | "superseded" | "contested" | "archived" | "forgotten";

export const MemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "contested",
  "archived",
  "forgotten",
]) satisfies z.ZodType<MemoryStatus>;

/**
 * `Memory.strength` の上限（ADR 0078）。
 *
 * `strength` は `total = similarity × decay × tagMatch × freshness × strength`
 * （docs/recall.md §7）に掛かる係数であり、**1 は「素通り」を意味する唯一の値**である。
 * 上限が無いと、値を1つ大きく書いた Memory がそのテナントの想起を支配する——
 * [ADR 0036](../../../docs/decisions/0036-clamp-freshness-at-one.md) が `freshness` で
 * 塞いだのと同じ穴である。
 *
 * `MAX_FRESHNESS`（`strategies/scoring.ts`）と同じ理由で export する:
 * 呼び出し側が**上限の存在と値を読める**形にしておく。
 */
export const MAX_STRENGTH = 1;

/**
 * `Memory.strength` の値域は **`(0, MAX_STRENGTH]`**（ADR 0078）。
 *
 * **0 を含めないのは、`strength = 0` が `total` を恒久的に 0 にする＝「二度と引かれない」
 * という意味になり、それは `status: 'forgotten'` が既に表しているからである。**
 * 同じことを言う道が2つ在ると、どちらで表されているかを読む側が両方見る必要が出る。
 *
 * 🔴 **`NaN` と `Infinity` を弾いているのは、この比較の「向き」である。**
 * `NaN` との比較は全部 false になるので `NaN > 0` が false になって落ちる。
 * `Infinity` は `Infinity <= 1` が false で落ちる。
 * **⚠ だから `value <= 0 || value > MAX_STRENGTH` のように否定で書き直してはならない**
 * ——その形にすると `NaN` は「範囲外ではない」と判定されて素通りする。
 *
 * ⚠ **最初は `Number.isFinite(value) &&` を先頭に置いていたが、変異試験で外した。**
 * それを落としても適合スイートは赤くならなかった——上のとおり冗長だからである。
 * **歯の当たらない防御を「守っている」の顔で残すと、後から比較の向きを変える人が
 * 「`isFinite` が見ているから大丈夫」と読む。**それがいちばん危ない。
 * 経緯は ADR 0078 の「変異試験で分かったこと」に書いてある。
 */
export function isStrengthInRange(value: number): boolean {
  return value > 0 && value <= MAX_STRENGTH;
}

export type EmbeddingStatus = "pending" | "ready" | "failed" | "skipped";

export const EmbeddingStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "skipped",
]) satisfies z.ZodType<EmbeddingStatus>;

export type DigestSource = "llm" | "fallback";

export const DigestSourceSchema = z.enum(["llm", "fallback"]) satisfies z.ZodType<DigestSource>;

/**
 * 解釈済みの記憶単位（docs/memory-model.md §1・§10）。
 *
 * `contentHash` について（D16）: content の SHA-256 の hex 文字列とする規約。
 * **core はこの値を計算しない**（Node の `crypto` に依存させないため、
 * docs/architecture.md §3.6 の「core は zod 以外の実行時依存を持たない」を守る）。
 * 呼び出し側・adapter が `crypto.createHash('sha256').update(content).digest('hex')`
 * （またはそれと同値の実装）で計算し、`NewMemory.contentHash` に渡すこと。
 */
export interface Memory {
  id: MemoryId;
  tenantId: string;
  subjectId?: string | null;

  sourceObservationId?: ObservationId | null;
  extractorVersion?: string | null;

  content: string;
  contentHash: string;
  digest: string;
  digestSource: DigestSource;

  provenance: Provenance;

  status: MemoryStatus;
  supersededById?: MemoryId | null;
  contestedWithId?: MemoryId | null;

  tags: string[];

  occurredAt?: Date | null;
  recordedAt: Date;
  lastReinforcedAt?: Date | null;

  /**
   * Issue #202（`docs/memory-model.md` §3「三つ（四つ）の時計」の4本目・5本目、
   * [ADR 0145](../../../docs/decisions/0145-valid-from-until-storage.md)）:
   * その事実が**真であり続けた期間**の始点。可（不明・無期限なら NULL）。
   *
   * 🔴 **`occurredAt` と混同しないこと。** `occurredAt` はその出来事・事実が
   * *いつのものか*（1点、鮮度スコアに使う）であり、`validFrom`/`validUntil` は
   * その事実が*いつからいつまで真か*（区間）である。「去年の住所」と「今の住所」は
   * どちらも `occurredAt`（引っ越した/住み始めた時刻）を持ちうるが、**「いまも真か」を
   * 分けるのは `validFrom`/`validUntil` のほうである**——`occurredAt` が同じでも、
   * `validUntil` が過去なら「もう真ではない」を表せる。
   *
   * DB 列自体は `packages/postgres/migrations/0001_init.sql` に Phase 1 から存在するが
   * （`purgedAt` の doc コメントと同じ経緯）、`Memory`/`MemoryRow` にこのフィールドが無く
   * 一度も読み書きされていなかった。ADR 0145 が `packages/postgres` の読み書きを
   * 初めて配線する。
   *
   * ⚠ **この PR は `recall()` のどのフィルタ・スコアにもこの値を使わない。**
   * 「いつ時点で真だった記憶か」を問う口（`RecallQuery`）・段1（ANN）への索引の
   * 押し下げ・`validUntil` を過ぎた記憶を `omitted` で名指しすることは、いずれも
   * この PR の射程外であり、別の ADR に委ねる（ADR 0145「これが覆るとしたら」参照）。
   *
   * **省略可能な既存フィールドとして足した**（`purgedAt` と同じ理由——`Memory` は
   * `@mnemora/core` の公開型。必須にすると、この型を自分でリテラルとして組み立てている
   * 既存の呼び出し元・adapter・テストのフィクスチャすべてに新しい必須プロパティを
   * 強制する破壊的変更になる。省略可能なら、値を持たない既存の組み立て方はそのまま
   * 型を満たす）。
   */
  validFrom?: Date | null;
  /** `validFrom` の doc コメント参照。対になる終点。 */
  validUntil?: Date | null;

  strength: number;
  halfLifeHours: number;
  decayFloorAt: Date;

  /**
   * 活動時計（[ADR 0157](../../../docs/decisions/0157-decay-activity-clock.md)）の3つ組。
   * 壁時計の `recordedAt`/`lastReinforcedAt` → `decayFloorAt` → `halfLifeHours` と
   * **1対1に対応する**——`decayBaseSeq` は起点（書き込み時点の `tenant_activity.activity_seq`）、
   * `decayFloorSeq` は床（書き込み時に一度だけ計算する）、`halfLifeRecalls` は
   * Memory 単位の半減期（単位: そのテナントで `recall()` が起きた回数）。
   *
   * **すべて省略可能。**`undefined` も `null` も**「この軸には床が無い＝活動時計では
   * 沈まない」**を意味する（ADR 0157 決めたこと4）。`decay_clock` が `'wall'` のまま
   * 一度も `'activity'`/`'either'` に切り替えていないテナントでは、この3つは
   * 一度も書かれない。
   *
   * **省略可能な新規フィールドとして足した**（`purgedAt`/`validFrom` と同じ理由——
   * `Memory` は `@mnemora/core` の公開型。必須にすると、この型を自分でリテラルとして
   * 組み立てている既存の呼び出し元・adapter・テストのフィクスチャ（40本以上）すべてに
   * 新しい必須プロパティを強制する破壊的変更になる）。
   */
  decayBaseSeq?: number | null;
  /** `decayBaseSeq` の doc コメント参照。活動時計の床。 */
  decayFloorSeq?: number | null;
  /** `decayBaseSeq` の doc コメント参照。活動時計での Memory 単位の半減期。 */
  halfLifeRecalls?: number | null;

  embeddingStatus: EmbeddingStatus;

  /**
   * Issue #198（[ADR 0124](../../../docs/decisions/0124-purge-physical-delete.md)）:
   * 非 `null` なら `content`/`digest` は物理削除のトゥームストーンで上書き済み
   * （docs/memory-model.md §9・§11 行10）。`status` はこの操作で動かないため
   * （`purged` は `memories.status` の値ではない）、「purge されたか」は常にこの列で判定する。
   *
   * DB 列自体は `packages/postgres/migrations/0001_init.sql` に Phase 1 から存在するが、
   * `Memory`/`MemoryRow` にこのフィールドが無く一度も読み書きされていなかった
   * （`purge()` の書き手そのものが無かったため）。本 ADR がここに初めて配線する。
   *
   * **省略可能な既存フィールドとして足した**（`Memory` は `@mnemora/core` の公開型。
   * `purgedAt` を必須にすると、この型を自分でリテラルとして組み立てている既存の
   * 呼び出し元・adapter・テストのフィクスチャすべてに新しい必須プロパティを強制する
   * 破壊的変更になる。省略可能なら、値を持たない既存の組み立て方はそのまま型を満たす）。
   */
  purgedAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * `createMemory` への入力。`id` / `createdAt` / `updatedAt` は store が採番する。
 *
 * `contentHash` と `decayFloorAt` は呼び出し側（runtime/adapter）が計算して渡す。
 * `decayFloorAt` は `defaultDecayStrategy.floorAt(...)` を書き込み時に一度だけ呼んで
 * 得た値を渡すこと（docs/memory-model.md §7・ADR 0010）。
 */
export type NewMemory = Omit<
  Memory,
  "id" | "createdAt" | "updatedAt" | "status" | "supersededById" | "contestedWithId"
> &
  Partial<Pick<Memory, "status" | "supersededById" | "contestedWithId">>;

export const MemorySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),

  sourceObservationId: z.string().min(1).nullable().optional(),
  extractorVersion: z.string().min(1).nullable().optional(),

  content: z.string(),
  contentHash: z.string().min(1),
  digest: z.string().min(1),
  digestSource: DigestSourceSchema,

  provenance: ProvenanceSchema,

  status: MemoryStatusSchema,
  supersededById: z.string().min(1).nullable().optional(),
  contestedWithId: z.string().min(1).nullable().optional(),

  tags: z.array(z.string()),

  occurredAt: z.date().nullable().optional(),
  recordedAt: z.date(),
  lastReinforcedAt: z.date().nullable().optional(),

  // Issue #202（ADR 0145）: `Memory.validFrom`/`validUntil` の doc コメント参照。
  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),

  // ADR 0078: 値域は `(0, MAX_STRENGTH]`。
  // ⚠ **この schema は書き込み経路では走らない**——`MemorySchema` / `NewMemorySchema` を
  // `.parse()` している箇所はリポジトリに0件であり、型の導出元として使われている。
  // 実際に値域を強制するのは store の層（`packages/postgres` の CHECK 制約と、
  // in-memory 実装の検査）である。ここを締めるのは**公開された型の契約**としてであって、
  // これが防波堤なのではない。
  strength: z.number().gt(0).max(MAX_STRENGTH),
  // ADR 0125: 値域は `(0, ∞)`（有限の正の実数、`isHalfLifeHoursInRange` と同じ域）。
  // `z.number().positive()` は実測（zod v4、`safeParse`）で `0`・負・`NaN`・`±Infinity` を
  // 既にすべて拒んでいる——zod は NaN を `invalid_type`（"expected number, received nan"）
  // として扱うため、`.positive()` だけで境界を正しく塞げている。
  // ⚠ ただし ADR 0078 の実測3と同じ理由で、**この schema は書き込み経路では走らない**
  // （`MemorySchema` / `NewMemorySchema` を `.parse()` している箇所は0件）。
  // 実際に値域を強制するのは store の層（`packages/postgres` の CHECK 制約と、
  // in-memory 実装の `isHalfLifeHoursInRange` 検査）である。
  halfLifeHours: z.number().positive(),
  decayFloorAt: z.date(),

  // ADR 0157: 活動時計の3つ組。3つとも省略可能——`Memory.decayBaseSeq` の doc コメント参照。
  // ⚠ この schema は書き込み経路では走らない（上の halfLifeHours の doc コメントと同じ注記）。
  decayBaseSeq: z.number().nullable().optional(),
  decayFloorSeq: z.number().nullable().optional(),
  halfLifeRecalls: z.number().nullable().optional(),

  embeddingStatus: EmbeddingStatusSchema,

  // Issue #198（ADR 0124）: `Memory.purgedAt` の doc コメント参照。
  purgedAt: z.date().nullable().optional(),

  createdAt: z.date(),
  updatedAt: z.date(),
}) satisfies z.ZodType<Memory>;

export const NewMemorySchema = MemorySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  supersededById: true,
  contestedWithId: true,
}).extend({
  status: MemoryStatusSchema.optional(),
  supersededById: z.string().min(1).nullable().optional(),
  contestedWithId: z.string().min(1).nullable().optional(),
}) satisfies z.ZodType<NewMemory>;
