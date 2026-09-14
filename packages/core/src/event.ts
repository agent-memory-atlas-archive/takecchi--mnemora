import { z } from "zod";
import type { EventId, MemoryId } from "./ids.js";

/**
 * 監査ログのイベント種別（docs/memory-model.md §9）。
 * 「状態が実際に変わった大分類」だけを列挙し、理由の粒度は `meta` に落とす。
 *
 * **⚠ `"purged"` と `"events_purged"` は、この union に在るが生成するコードが無い**
 * （Issue #206 / [ADR 0117](../../../docs/decisions/0117-unreachable-union-values-inventory.md) で棚卸し済み）。
 * `purge()`（物理削除）の書き手そのものが存在しない——Issue #198（オーナー §5.3 が
 * `forget()`（論理削除）と分けると決めた片割れ）が実装されるまで、どちらも本番コードから
 * 一度も書かれない。**`"purged"` は repo 全体でこの宣言以外に一度も出現しない**
 * （テストのフィクスチャにも無い）。`"events_purged"` は `@mnemora/testkit` の適合テストが
 * FK 制約（`memory_events.memory_id` が NULL を拒まないこと）を検査する
 * リテラルとしてのみ現れ、`purge()` を模してはいない。
 */
export type MemoryEventKind =
  "created" | "updated" | "superseded" | "archived" | "forgotten" | "purged" | "events_purged";

export const MemoryEventKindSchema = z.enum([
  "created",
  "updated",
  "superseded",
  "archived",
  "forgotten",
  "purged",
  "events_purged",
]) satisfies z.ZodType<MemoryEventKind>;

export interface EventActor {
  type: "human" | "system" | "clone";
  id?: string;
}

export const EventActorSchema = z.object({
  type: z.enum(["human", "system", "clone"]),
  id: z.string().min(1).optional(),
}) satisfies z.ZodType<EventActor>;

/**
 * append-only な監査ログの1行（docs/memory-model.md §9）。
 * `EventStore` interface が `update`/`delete` を持たないことと対になる型。
 */
export interface MemoryEvent {
  id: EventId;
  tenantId: string;
  /** `kind = 'events_purged'` の場合のみ null。 */
  memoryId: MemoryId | null;
  kind: MemoryEventKind;
  at: Date;
  actor: EventActor;
  digestSnapshot?: string | null;
  sizeBeforeBytes?: number | null;
  meta: Record<string, unknown>;
}

export const MemoryEventSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    memoryId: z.string().min(1).nullable(),
    kind: MemoryEventKindSchema,
    at: z.date(),
    actor: EventActorSchema,
    digestSnapshot: z.string().nullable().optional(),
    sizeBeforeBytes: z.number().int().nonnegative().nullable().optional(),
    meta: z.record(z.string(), z.unknown()),
  })
  .refine((event) => event.kind !== "events_purged" || event.memoryId === null, {
    message: "events_purged のイベントは memoryId が null でなければならない",
    path: ["memoryId"],
  }) satisfies z.ZodType<MemoryEvent>;

export type NewMemoryEvent = Omit<MemoryEvent, "id" | "at"> & { at?: Date };

export const NewMemoryEventSchema = z
  .object({
    tenantId: z.string().min(1),
    memoryId: z.string().min(1).nullable(),
    kind: MemoryEventKindSchema,
    at: z.date().optional(),
    actor: EventActorSchema,
    digestSnapshot: z.string().nullable().optional(),
    sizeBeforeBytes: z.number().int().nonnegative().nullable().optional(),
    meta: z.record(z.string(), z.unknown()),
  })
  .refine((event) => event.kind !== "events_purged" || event.memoryId === null, {
    message: "events_purged のイベントは memoryId が null でなければならない",
    path: ["memoryId"],
  }) satisfies z.ZodType<NewMemoryEvent>;

export interface EventFilter {
  memoryId?: MemoryId;
  kind?: MemoryEventKind;
  since?: Date;
  until?: Date;
  limit?: number;
}

export const EventFilterSchema = z.object({
  memoryId: z.string().min(1).optional(),
  kind: MemoryEventKindSchema.optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<EventFilter>;
