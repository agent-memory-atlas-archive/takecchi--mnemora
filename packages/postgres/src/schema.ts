import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle のテーブル定義（docs/memory-model.md §10）。
 *
 * **これらの定義はスキーマの生成には使わない。** テーブル・索引の実体は
 * `migrations/0001_init.sql`（手書き DDL、ADR 0001）が作る。この `schema.ts` は
 * `drizzle-orm` のクエリビルダに型を与えるためだけに存在し、`drizzle-kit push`
 * には一切渡さない。したがってここでの `CHECK` 制約や `DEFAULT` の宣言は
 * ドキュメントとしての意味しか持たず、実際の制約は `migrations/0001_init.sql` 側にある
 * （二重管理になるが、`drizzle-kit push` の operator class 欠落バグを踏まないための
 * 意図的なトレードオフ。ADR 0001 参照）。
 *
 * `memory_embeddings_<space>` は空間ごとに動的にテーブルが増えるため、ここでは
 * 定義しない（`./vector-space.ts` が生 SQL で扱う）。
 */

export const observations = pgTable("observations", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subjectId: text("subject_id"),
  externalId: text("external_id"),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
  // Issue #280: `migrations/0014_observations_valid_from_until.sql` が足す。
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }),
  validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
});

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectId: text("subject_id"),

    sourceObservationId: uuid("source_observation_id"),
    extractorVersion: text("extractor_version"),

    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    digest: text("digest").notNull(),
    digestSource: text("digest_source").notNull(),

    /**
     * `provenance.kind`（jsonb 側）と**意図的に二重で持つ、書き込み専用の列**
     * （Issue #206 / [ADR 0117](../../../docs/decisions/0117-unreachable-union-values-inventory.md) で棚卸し済み）。
     *
     * **`rowToMemory`（`./mapping.ts`）はこの列を読み戻さない。** core の `Memory` 型は
     * `provenance: Provenance` だけを持ち、`provenanceKind` という別欄を持たない
     * （jsonb の `provenance.kind` が正）。この列の役割は**フィルタ述語**であり、
     * `vector-store.ts` / `lexical-store.ts` の `excludeProvenanceKinds` が
     * `provenance_kind <> ALL(...)` という形でこの列を直接引く——jsonb を都度展開せず、
     * `idx_memories_provenance_kind`（`tenant_id, provenance_kind`）に載せるためにある。
     * **読み戻す側が増えると、書き込みでの不一致（jsonb とこの列がずれる）が
     * 静かに result へ混入する経路が生まれる**——増やさない。
     */
    provenanceKind: text("provenance_kind").notNull(),
    provenance: jsonb("provenance").notNull(),

    status: text("status").notNull(),
    supersededById: uuid("superseded_by_id"),
    contestedWithId: uuid("contested_with_id"),

    tags: text("tags").array().notNull(),

    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
    lastReinforcedAt: timestamp("last_reinforced_at", { withTimezone: true, mode: "date" }),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }), // Phase 2
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }), // Phase 2

    strength: real("strength").notNull(),
    halfLifeHours: real("half_life_hours").notNull(),
    decayFloorAt: timestamp("decay_floor_at", { withTimezone: true, mode: "date" }).notNull(),

    // ADR 0165（Issue #305）: 活動時計の3つ組。壁時計の
    // recordedAt/lastReinforcedAt → decayFloorAt → halfLifeHours と1対1に対応する。
    // すべて NULL 許容——NULL は「この軸には床が無い＝活動時計では沈まない」を意味する
    // （migrations/0015_decay_activity_clock.sql）。
    decayBaseSeq: bigint("decay_base_seq", { mode: "number" }),
    decayFloorSeq: bigint("decay_floor_seq", { mode: "number" }),
    halfLifeRecalls: real("half_life_recalls"),

    embeddingStatus: text("embedding_status").notNull(),

    purgedAt: timestamp("purged_at", { withTimezone: true, mode: "date" }), // Phase 2

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("idx_memories_by_subject").on(table.tenantId, table.subjectId, table.status)],
);

export const memoryEvents = pgTable("memory_events", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  memoryId: uuid("memory_id"),
  kind: text("kind").notNull(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  actor: jsonb("actor").notNull(),
  digestSnapshot: text("digest_snapshot"),
  sizeBeforeBytes: integer("size_before_bytes"),
  meta: jsonb("meta").notNull(),
});

export const recalls = pgTable("recalls", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subjectId: text("subject_id"),
  query: jsonb("query").notNull(),
  budget: jsonb("budget"),
  omitted: jsonb("omitted").notNull(),
  usage: jsonb("usage").notNull(),
  indexBand: jsonb("index_band").notNull(),
  explain: jsonb("explain").notNull(),
  // Issue #298 / ADR 0155: 旧 `returned_memory_ids uuid[]`（memoryId だけ）を置き換えた。
  // 内訳（score/retrievedVia/companionOf/associationOf）を含む jsonb。
  // `migrations/0013_recall_returned_memories_jsonb.sql` 参照。
  returnedMemories: jsonb("returned_memories").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const recallUsages = pgTable(
  "recall_usages",
  {
    tenantId: text("tenant_id").notNull(),
    recallId: uuid("recall_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.recallId, table.memoryId] })],
);

export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
  claimedBy: text("claimed_by"),
  attempts: integer("attempts").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: text("tenant_id").primaryKey(),
  defaultHalfLifeHours: real("default_half_life_hours").notNull(),
  eventRetentionDays: integer("event_retention_days"),
  taxonomyMode: text("taxonomy_mode").notNull(),
  // ADR 0165（Issue #305）: どちらの時計を使うか、と活動時計の既定の半減期。
  decayClock: text("decay_clock").notNull(),
  defaultHalfLifeRecalls: real("default_half_life_recalls").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

/**
 * ADR 0165（Issue #305）: テナントごとに1行の活動カウンタ。`tenant_settings` の行に
 * 相乗りさせない（recall のたびの UPDATE が設定の読み出しまで行ロックで待たせないため。
 * `migrations/0015_decay_activity_clock.sql` 参照）。
 */
export const tenantActivity = pgTable("tenant_activity", {
  tenantId: text("tenant_id").primaryKey(),
  activitySeq: bigint("activity_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});
