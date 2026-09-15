import type {
  DigestSource,
  EmbeddingStatus,
  EventActor,
  Memory,
  MemoryEvent,
  MemoryEventKind,
  MemoryStatus,
  Observation,
  OutboxJobKind,
  OutboxJobRecord,
  Provenance,
} from "@mnemora/core";

/**
 * DB の行（`pg` ドライバが返す生の行。列名は snake_case）を core の型へ変換する。
 *
 * `packages/postgres` のクエリは `sql` タグ付きテンプレート（drizzle-orm）で書いており、
 * `SELECT *` の結果はドライバがそのまま snake_case のプロパティ名で返す。ここで
 * camelCase の core 型へ変換する境界を1箇所に集める。
 *
 * **`timestamptz` は文字列で返る。** `drizzle-orm/node-postgres` は
 * `TIMESTAMPTZ`/`TIMESTAMP`/`DATE`/`INTERVAL` 等の型パーサをあえて恒等関数に上書きしている
 * （drizzle 独自の decode を後段の schema 経由でしか適用しないための仕様。生 SQL 実行
 * （`db.execute(sql\`...\`)`）ではこの decode を経由しないため、文字列のまま返る）。
 * このファイルの `parsePgTimestamp` がその文字列を `Date` へ変換する境界を1箇所に集める。
 */

/**
 * Postgres の `timestamptz` の既定テキスト出力（例:
 * `"2026-05-11 00:47:17.621+09"`、`"2026-01-01 00:00:00.123456+05:30"`）を `Date` に変換する。
 * `new Date()` にそのまま渡せる ISO 8601 形式（`T` 区切り・コロン付きタイムゾーン）へ
 * 正規化してから変換する。
 */
export function parsePgTimestamp(value: string): Date;
export function parsePgTimestamp(value: string | null): Date | null;
export function parsePgTimestamp(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  let normalized = value.replace(" ", "T");
  const tz = normalized.match(/([+-]\d{2})(:?(\d{2}))?$/);
  if (tz) {
    const sign = tz[1];
    const minutes = tz[3] ?? "00";
    normalized = normalized.slice(0, normalized.length - tz[0].length) + `${sign}:${minutes}`;
  }
  return new Date(normalized);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * core の id 型（`ObservationId` / `MemoryId` 等）は単なる `string` であり、UUID 形式を
 * 強制しない。しかし `packages/postgres` の各テーブルの主キーは `uuid` 型のため、
 * 呼び出し側が任意の文字列（例: 存在確認のための `"does-not-exist"`）を渡すと、
 * Postgres がクエリ実行時点で `invalid input syntax for type uuid` を投げてしまう
 * ——「存在しない」と「壊れた入力」を区別せずに済ませたい箇所（`getObservation` が
 * null を返す契約、`OutboxStore.complete`/`fail` がべき等に成功する契約）では、
 * この形式チェックで**クエリを投げる前に**判定し、DB 由来のエラーメッセージを
 * 呼び出し側に漏らさない（roadmap.md 段階3 で実 DB 検査により判明した不整合の修正）。
 */
export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export interface MemoryRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  source_observation_id: string | null;
  extractor_version: string | null;
  content: string;
  content_hash: string;
  digest: string;
  digest_source: string;
  provenance: Provenance;
  status: string;
  superseded_by_id: string | null;
  contested_with_id: string | null;
  tags: string[];
  occurred_at: string | null;
  recorded_at: string;
  last_reinforced_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  strength: number;
  half_life_hours: number;
  decay_floor_at: string;
  embedding_status: string;
  purged_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    sourceObservationId: row.source_observation_id,
    extractorVersion: row.extractor_version,
    content: row.content,
    contentHash: row.content_hash,
    digest: row.digest,
    digestSource: row.digest_source as DigestSource,
    provenance: row.provenance,
    status: row.status as MemoryStatus,
    supersededById: row.superseded_by_id,
    contestedWithId: row.contested_with_id,
    tags: row.tags,
    occurredAt: parsePgTimestamp(row.occurred_at),
    recordedAt: parsePgTimestamp(row.recorded_at),
    lastReinforcedAt: parsePgTimestamp(row.last_reinforced_at),
    validFrom: parsePgTimestamp(row.valid_from),
    validUntil: parsePgTimestamp(row.valid_until),
    strength: row.strength,
    halfLifeHours: row.half_life_hours,
    decayFloorAt: parsePgTimestamp(row.decay_floor_at),
    embeddingStatus: row.embedding_status as EmbeddingStatus,
    purgedAt: parsePgTimestamp(row.purged_at),
    createdAt: parsePgTimestamp(row.created_at),
    updatedAt: parsePgTimestamp(row.updated_at),
  };
}

export interface ObservationRow {
  id: string;
  tenant_id: string;
  subject_id: string | null;
  external_id: string | null;
  kind: string;
  payload: unknown;
  occurred_at: string | null;
  recorded_at: string;
}

export function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    externalId: row.external_id,
    kind: row.kind,
    payload: row.payload,
    occurredAt: parsePgTimestamp(row.occurred_at),
    recordedAt: parsePgTimestamp(row.recorded_at),
  };
}

export interface MemoryEventRow {
  id: string;
  tenant_id: string;
  memory_id: string | null;
  kind: string;
  at: string;
  actor: EventActor;
  digest_snapshot: string | null;
  size_before_bytes: number | null;
  meta: Record<string, unknown>;
}

export function rowToMemoryEvent(row: MemoryEventRow): MemoryEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    kind: row.kind as MemoryEventKind,
    at: parsePgTimestamp(row.at),
    actor: row.actor,
    digestSnapshot: row.digest_snapshot,
    sizeBeforeBytes: row.size_before_bytes,
    meta: row.meta,
  };
}

export interface OutboxJobRow {
  id: string;
  tenant_id: string;
  kind: string;
  payload: Record<string, unknown>;
  available_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  attempts: number;
  completed_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function rowToOutboxJob(row: OutboxJobRow): OutboxJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as OutboxJobKind,
    payload: row.payload,
    availableAt: parsePgTimestamp(row.available_at),
    claimedAt: parsePgTimestamp(row.claimed_at),
    claimedBy: row.claimed_by,
    attempts: row.attempts,
    completedAt: parsePgTimestamp(row.completed_at),
    failedAt: parsePgTimestamp(row.failed_at),
    lastError: row.last_error,
    createdAt: parsePgTimestamp(row.created_at),
  };
}
