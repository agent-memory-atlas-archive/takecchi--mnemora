import { z } from "zod";
import type { ObservationId } from "./ids.js";

/**
 * mnemora の外で起きたことの生の記録（docs/memory-model.md §1・§10）。
 *
 * `kind` はあえて閉じたユニオンにしない（DB 側も CHECK 制約を付けない）。
 * 新しい観測の種類を追加するたびにマイグレーションを要求しない設計のため。
 * 開いているものは開いていると分かる形にする、という規約（memory-model.md §10）を
 * 型としてもそのまま反映し、`kind: string` とする。
 */
export interface Observation {
  id: ObservationId;
  tenantId: string;
  subjectId?: string | null;
  externalId?: string | null;
  kind: string;
  payload: unknown;
  occurredAt?: Date | null;
  recordedAt: Date;
  /**
   * Issue #280（Issue #202 第2弾）: `ObserveXxxInput.validFrom`/`validUntil`（下記）を
   * `occurredAt` と**同じ経路**で運ぶための、`Observation` 側の置き場。
   *
   * `occurredAt` の流れ（`ObserveXxxInput.occurredAt` → `Runtime.observe` →
   * `Observation.occurredAt` → `buildNewMemoryFromCandidate` → `NewMemory.occurredAt`、
   * `runtime.ts`/`extraction.ts`）をそのまま踏襲する——**理由は「deferred 抽出でも
   * 値が残る」ことを構造的に保証するため**。`extract: 'deferred'` を選んだ場合、抽出は
   * `outbox` 経由で後から `processExtractJob`（`runtime.ts`）が拾い、そこでは
   * `deps.memoryStore.getObservation` で**DB から読み直した** `Observation` しか
   * 手元に無い（元の `ObserveXxxInput` はとうに捨てられている）。⟹ `validFrom`/
   * `validUntil` を `Observation` に持たせず sync 経路だけの一時変数として流すと、
   * deferred 経路では値が消える——`occurredAt` が同じ理由で `Observation` の
   * 永続フィールドになっているのと対称の判断。
   */
  validFrom?: Date | null;
  /** `validFrom` の doc コメント参照。対になる終点。 */
  validUntil?: Date | null;
}

export type NewObservation = Omit<Observation, "id" | "recordedAt"> & {
  recordedAt?: Date;
};

export const ObservationSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),
  externalId: z.string().min(1).nullable().optional(),
  kind: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.date().nullable().optional(),
  recordedAt: z.date(),
  // Issue #280: `Observation.validFrom`/`validUntil` の doc コメント参照。
  validFrom: z.date().nullable().optional(),
  validUntil: z.date().nullable().optional(),
}) satisfies z.ZodType<Observation>;

export const NewObservationSchema = ObservationSchema.omit({
  id: true,
  recordedAt: true,
}).extend({
  recordedAt: z.date().optional(),
}) satisfies z.ZodType<NewObservation>;

/**
 * 抽出の既定モード（D2）。`sync` が既定（roadmap §5.2 の推奨、オーナー判断 D2）。
 * `deferred` を選んだ場合、抽出は `outbox` 経由の Scheduler を通る
 * （docs/architecture.md §3.3・§3.4）。
 */
export type ExtractMode = "sync" | "deferred";

export const ExtractModeSchema = z.enum(["sync", "deferred"]) satisfies z.ZodType<ExtractMode>;

/** `observe()` の入力ユニオンの判別子（DB 上は `kind = 'usage'` に対応する点に注意）。 */
export type ObserveInputKind = "utterance" | "event" | "memory_usage" | "document";

/**
 * Issue #280（Issue #202 第2弾、マネージャー決定4）: `validFrom`/`validUntil` を
 * 呼び出し側から渡す口。`occurredAt` と同じ扱い——**抽出（LLM）に推測させない**
 * （Issue #202/#280 が明示的に射程外にしている。北極星の問い5「LLM を呼ばずに
 * 済ませられないか」にも整合する）。ADR 0037 の規律（「まず呼び出し側が渡す形を
 * 検討する」）に従い、まず口を作る。
 *
 * ⚠ **粒度の限界**: この2欄は observation 単位のスカラーである。1回の `observe()`
 * から複数の Memory 候補が抽出されると、**全候補が同じ `validFrom`/`validUntil` を
 * 共有する**——`occurredAt` が既に抱えている限界と同型（ADR 0037 が受け入れ済み）。
 */
export interface ObserveUtteranceInput {
  kind: "utterance";
  subjectId?: string;
  externalId?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  extract?: ExtractMode;
  speaker?: string;
  text: string;
}

export interface ObserveEventInput {
  kind: "event";
  subjectId?: string;
  externalId?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  extract?: ExtractMode;
  name: string;
  data?: Record<string, unknown>;
}

export interface ObserveDocumentInput {
  kind: "document";
  subjectId?: string;
  externalId?: string;
  occurredAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  extract?: ExtractMode;
  title?: string;
  content: string;
}

/**
 * 使用報告（ADR 0009）。抽出器を通らないため `extract` を持たない。
 * `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })`
 * という ADR 0009 の呼び出し形そのままの形にする。
 */
export interface ObserveMemoryUsageInput {
  kind: "memory_usage";
  recallId: string;
  usedMemoryIds: string[];
}

export type ObserveInput =
  ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput | ObserveMemoryUsageInput;

const ObserveUtteranceInputSchema = z.object({
  kind: z.literal("utterance"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  speaker: z.string().min(1).optional(),
  text: z.string().min(1),
}) satisfies z.ZodType<ObserveUtteranceInput>;

const ObserveEventInputSchema = z.object({
  kind: z.literal("event"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  name: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ObserveEventInput>;

const ObserveDocumentInputSchema = z.object({
  kind: z.literal("document"),
  subjectId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
  validFrom: z.date().optional(),
  validUntil: z.date().optional(),
  extract: ExtractModeSchema.optional(),
  title: z.string().min(1).optional(),
  content: z.string().min(1),
}) satisfies z.ZodType<ObserveDocumentInput>;

const ObserveMemoryUsageInputSchema = z.object({
  kind: z.literal("memory_usage"),
  recallId: z.string().min(1),
  usedMemoryIds: z.array(z.string().min(1)).min(1),
}) satisfies z.ZodType<ObserveMemoryUsageInput>;

export const ObserveInputSchema = z.discriminatedUnion("kind", [
  ObserveUtteranceInputSchema,
  ObserveEventInputSchema,
  ObserveDocumentInputSchema,
  ObserveMemoryUsageInputSchema,
]);

/**
 * `observe()` の入力ユニオンの判別子を、`observations.kind` 列の値へ変換する。
 *
 * `memory_usage` だけは DB 列としては `'usage'` に対応する
 * （docs/memory-model.md §10: 「`kind = 'usage'` の Observation」）。
 * それ以外は判別子をそのまま列の値として使う。
 */
export function observeInputKindToObservationKind(kind: ObserveInputKind): string {
  switch (kind) {
    case "memory_usage":
      return "usage";
    case "utterance":
      return "utterance";
    case "event":
      return "event";
    case "document":
      return "document";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unreachable observe input kind: ${String(exhaustive)}`);
    }
  }
}
