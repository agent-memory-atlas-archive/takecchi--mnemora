import { sql } from "drizzle-orm";
import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryId,
  VectorEntry,
  VectorFilter,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import { isUuidLike } from "./mapping.js";
import { maybeAnalyzeAfterUpsert } from "./embedding-statistics.js";

/** `number[]` を pgvector のテキスト表現（`[1,2,3]`）に変換する。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** `toVectorLiteral` の逆——pgvector のテキスト表現（`[1,2,3]`）を `number[]` に戻す。 */
function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}

/**
 * `VectorStore` の Postgres 実装（docs/architecture.md §5.2、pgvector）。
 *
 * 契約（docs/decisions/0003-memorystore-vs-vectorstore.md）: `MemoryStore` が真実の源であり、
 * `VectorStore` はここに実装があっても再構築可能な派生索引に留まる。
 *
 * `search` の `ORDER BY` には距離演算子の結果をそのまま昇順で書く（式にしない）。
 * これは docs/memory-model.md §10「規約」であり、`testkit`/`packages/postgres` の
 * `EXPLAIN` 検査対象そのものである。
 *
 * **tie-break は3段**（Issue #339 / ADR 0170。ADR 0167 で足した `memory_id` 単独の
 * tie-break は Issue #339 で不十分と判明した——`memory_id` は ingest のたびに
 * `gen_random_uuid()` で新しく振られるランダムな UUID であり、同一 DB 内では
 * 決定的でも、**DB を作り直す（fresh ingest）たびに勝者が変わる**。同一内容が
 * 複数の Memory として重複記録される場面（`examples/chat` の `compare` が使う
 * 合成会話は、少数の filler 文を100回以上使い回すため実際に埋め込みが bit-for-bit
 * 一致する重複を大量に作る）で、この揺れが実際に⭐門の数字を動かした）:
 *
 * 1. 距離（そのまま昇順）。
 * 2. `m.recorded_at`（降順——新しい方を先に。ingest はテナント内で逐次的に行われる
 *    ため、同じ内容を何度作り直して ingest しても、**相対順序は再現する**——
 *    `memory_id` と違って、値そのものはテナントの処理順に紐づく）。
 * 3. `e.memory_id`（最終フォールバック）。**`recorded_at` まで完全一致したとき**
 *    （同一トランザクション内の複数書き込み、あるいは同一ミリ秒内の連続書き込みで
 *    起こりうる——`packages/core/src/runtime.ts` は `clock.now()` を呼び出しごとに
 *    評価するため理論上は稀だが、否定はできない）だけ、ここへ落ちる。**この場合、
 *    まさに ADR 0167 が足した動作（ランダム UUID 順）に戻る**——`recorded_at` が
 *    競合した特定の行どうしの間でだけ、ingest ごとに順序が変わりうる。それ以外の
 *    行（`recorded_at` が競合しない行）の順序には影響しない。
 *
 * **⟹ この3段を足しても「タイが起こらない」ことは保証しない。**保証しているのは
 * 「`recorded_at` が競合しない限り、fresh ingest をまたいで順序が再現する」ことだけ
 * である（ADR 0170「確かめていないこと」参照）。
 *
 * テーブルは事前に `registerEmbeddingSpace`（`./vector-space.ts`）で作られている前提。
 * 未登録の空間に対して呼ぶと Postgres の `relation does not exist` エラーになる
 * （黙って何もしない、より安全な失敗の仕方）。
 */
export class PostgresVectorStore implements VectorStore {
  constructor(private readonly db: Db) {}

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await this.db.execute(sql`
      INSERT INTO ${sql.identifier(table)} (tenant_id, memory_id, embedding, model, created_at)
      VALUES (${ctx.tenantId}, ${memoryId}, ${toVectorLiteral(vector)}::vector, ${space.model}, now())
      ON CONFLICT (tenant_id, memory_id)
      DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = now()
    `);
    // Issue #360 / ADR 0194: 統計が実態から遅れているときだけ ANALYZE を撃つ（詳細は
    // ./embedding-statistics.ts のクラス doc）。ここでは呼ぶだけ——判断はそちらに集約する。
    await maybeAnalyzeAfterUpsert(this.db, space);
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    const queryLiteral = toVectorLiteral(query);

    const conditions = [sql`e.tenant_id = ${opts.filter.tenantId}`];
    if (opts.filter.status !== undefined) {
      conditions.push(sql`m.status = ANY(${sql.param(opts.filter.status)}::text[])`);
    }
    // ADR 0165 決めたこと1・4・12: 忘却ゲートの2軸。`decayFloorAnyAxis` が true かつ
    // 両方の境界が渡されているときだけ OR で結ぶ（`VectorFilter.decayFloorAnyAxis` の doc
    // 参照）。それ以外は今日どおり AND のまま個別に効く。
    const decayFloorAtCondition =
      opts.filter.decayFloorAtAfter !== undefined
        ? sql`m.decay_floor_at > ${opts.filter.decayFloorAtAfter}`
        : undefined;
    // `decay_floor_seq IS NULL` の行は通す（ADR 0165 決めたこと4——NULL は「この軸には
    // 床が無い＝活動時計では沈まない」）。
    const decayFloorSeqCondition =
      opts.filter.decayFloorSeqAfter !== undefined
        ? sql`(m.decay_floor_seq IS NULL OR m.decay_floor_seq > ${opts.filter.decayFloorSeqAfter})`
        : undefined;
    if (
      opts.filter.decayFloorAnyAxis === true &&
      decayFloorAtCondition !== undefined &&
      decayFloorSeqCondition !== undefined
    ) {
      conditions.push(sql`(${decayFloorAtCondition} OR ${decayFloorSeqCondition})`);
    } else {
      if (decayFloorAtCondition !== undefined) {
        conditions.push(decayFloorAtCondition);
      }
      if (decayFloorSeqCondition !== undefined) {
        conditions.push(decayFloorSeqCondition);
      }
    }
    if (opts.filter.subjectId !== undefined) {
      conditions.push(sql`m.subject_id = ${opts.filter.subjectId}`);
    }
    // ADR 0059: period の押し下げ。比較対象は COALESCE(occurred_at, recorded_at)
    // （ADR 0039 が定義した「実効時刻」——4箇所あった判定規則の5箇所目)。両端とも包含
    // （`>=`/`<=`）——`VectorFilter.occurredAfter`/`occurredBefore` の doc、および
    // 既存の厳密経路（`memory-store.ts` の `aggregateScope`）と同じ境界の含み方に揃える。
    if (opts.filter.occurredAfter !== undefined) {
      conditions.push(sql`COALESCE(m.occurred_at, m.recorded_at) >= ${opts.filter.occurredAfter}`);
    }
    if (opts.filter.occurredBefore !== undefined) {
      conditions.push(sql`COALESCE(m.occurred_at, m.recorded_at) <= ${opts.filter.occurredBefore}`);
    }
    // Issue #280（Issue #202 第2弾）: `validAt` ゲート。両端 NULL は「いつでも真」
    // （`VectorFilter.validAt` の doc 参照）。`valid_until` は狭義の `>`（非包含）——
    // `decayFloorAtAfter` と同じ境界の向き。
    if (opts.filter.validAt !== undefined) {
      conditions.push(
        sql`(m.valid_from IS NULL OR m.valid_from <= ${opts.filter.validAt}) AND (m.valid_until IS NULL OR m.valid_until > ${opts.filter.validAt})`,
      );
    }
    // ADR 0056: 空配列は no-op（`VectorFilter.excludeProvenanceKinds` の doc 参照）。
    // `length > 0` で番わないと `<> ALL('{}')` という無駄な条件が出る——常に真になり実害は
    // 無いが（`<> ALL` は空配列に対して真）、`EXPLAIN` を読みにくくするので出さない。
    if (
      opts.filter.excludeProvenanceKinds !== undefined &&
      opts.filter.excludeProvenanceKinds.length > 0
    ) {
      conditions.push(
        sql`m.provenance_kind <> ALL(${sql.param(opts.filter.excludeProvenanceKinds)}::text[])`,
      );
    }
    const whereClause = sql.join(conditions, sql` AND `);

    // ORDER BY には距離演算子の結果をそのまま昇順で置く（式にしない。docs/recall.md §3）。
    // tie-break はクラス doc コメント（このファイル冒頭）のとおり3段
    // （距離 → `m.recorded_at` DESC → `e.memory_id`、Issue #339 / ADR 0170）。
    // **ADR 0167 が足した `e.memory_id` 単独の tie-break では、Issue #339 で
    // 不十分と判明した**——`memory_id` は fresh ingest のたびにランダムに振り直される
    // ため、同一内容の重複行が多数あるとき（`examples/chat` の `compare` の filler
    // 会話がまさにこれを作る）、tie-break の勝者が ingest ごとに変わっていた。
    // `m.recorded_at` はテナント内の処理順に紐づく値であり、fresh ingest をまたいでも
    // **相対順序が再現する**ため、これを第2キーに昇格する。`e.memory_id` は
    // `recorded_at` まで完全一致したときだけ効く最終フォールバックとして残す。
    const result = await this.db.execute(sql`
      SELECT e.memory_id AS memory_id, e.embedding <=> ${queryLiteral}::vector AS distance
      FROM ${sql.identifier(table)} e
      JOIN memories m ON m.id = e.memory_id AND m.tenant_id = e.tenant_id
      WHERE ${whereClause}
      ORDER BY e.embedding <=> ${queryLiteral}::vector, m.recorded_at DESC, e.memory_id
      LIMIT ${opts.limit}
    `);
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; distance: number };
      return { memoryId: r.memory_id, distance: r.distance };
    });
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    // memory_id 列は uuid 型。この口の契約は「無い == 何もしない」（void、族A）なので、
    // 形式が壊れた memoryId もクエリを投げる前に同じ no-op へ寄せる——DELETE は
    // 0行に終わるだけで実害は無いが、素通しすると invalid input syntax for type uuid が
    // 飛んでしまい「無い」と「壊れた入力」の区別が呼び出し側に漏れる
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(memoryId)) {
      return;
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    await this.db.execute(sql`
      DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
  }

  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<VectorEntry[]> {
    // `memory_id` 列は uuid 型。形式不正な id は「存在しない」の一種として扱う
    // （`delete` と同じ判断。`isUuidLike` の doc コメント参照）——クエリを投げる前に
    // 落とし、DB 由来の invalid input syntax を漏らさない。
    const validIds = memoryIds.filter(isUuidLike);
    if (validIds.length === 0) {
      return [];
    }
    const table = embeddingSpaceTableName(space);
    assertSafeIdentifier(table);
    // tenant 境界を必ず掛ける（`VectorEntry` の doc・`search` の `filter.tenantId` と
    // 同じ境界）——他テナントの memoryId が偶然 validIds に混ざっていても返さない。
    const result = await this.db.execute(sql`
      SELECT memory_id AS memory_id, embedding::text AS embedding
      FROM ${sql.identifier(table)}
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ANY(${sql.param(validIds)}::uuid[])
    `);
    return result.rows.map((row) => {
      const r = row as unknown as { memory_id: string; embedding: string };
      return { memoryId: r.memory_id, vector: parseVectorLiteral(r.embedding) };
    });
  }
}
