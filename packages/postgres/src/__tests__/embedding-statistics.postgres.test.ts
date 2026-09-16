import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { INITIAL_ANALYZE_THRESHOLD } from "../embedding-statistics.js";
import { requireDatabaseUrl, seededRandom } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #360 / ADR 0194: `PostgresVectorStore.upsert` が閾値越えのときだけ `ANALYZE` を
 * 撃つ歯（(甲) 端から端までの証明、(乙) 統計が足りている表では撃たないこと）。
 *
 * (丙)（等比閾値の純関数の単体テスト）は `embedding-statistics.test.ts` に別立てで置いた
 * （DB を要さないため）。
 *
 * ## この歯が `vector-search-hnsw.test.ts` と違うところ
 *
 * `vector-search-hnsw.test.ts` の `seed()` は明示的に `ANALYZE`（埋め込み表と `memories`
 * の両方）を撃って HNSW を成立させている。**このファイルの (甲) は、埋め込み表について
 * 一切 `ANALYZE` を撃たない**——`PostgresVectorStore.upsert` 自身が内部で撃つことだけを
 * 頼りに HNSW を成立させる。それがこの歯の存在理由そのものである。
 *
 * ## (甲) が EXPLAIN する SQL は `search()` の実発行 SQL ではない（CI の実測で変えた）
 *
 * 最初の実装は `pool.query` をフックして `vectorStore.search()` が実際に発行する SQL
 * （`memories` と `JOIN` してテナントで絞る）をそのまま `EXPLAIN` していた。**CI
 * （`pgvector/pgvector:pg17`）でこれが赤くなった**（手元では緑だった）:
 * `AssertionError: expected 'Limit  (cost=115.97..115.99 rows=10 w…' to match
 * /Index Scan.*using idx_memory_embeddin…/`。
 *
 * 原因: この歯専用の使い捨てデータベースの `memories` には、**一度も `ANALYZE` が
 * 走らない**（この歯は埋め込み表以外に `ANALYZE` を一切撃たないし、`upsert` も
 * `memories` の統計には触らない）。`search()` の SQL は `memories` と `JOIN` する
 * ため、プランナは `memories` 側の行数を見誤り、HNSW を検討する前に安い Nested Loop
 * を選んだ。**歯は嘘をついていない**——「この PR だけでは、`JOIN` を含む本物の
 * `search()` では HNSW に届かないことがある」を正しく検出した（ADR 0194「引き受けた
 * 負債」2番: `memories` 側に同じ穴が開いたままであることの、CI からの実測の裏付け）。
 * ⚠ 手元で緑だった理由は、28秒ほどの投入中に autovacuum が `memories` を拾った、と
 * いう**見立てであり、確かめていない**。
 *
 * `memories` の統計は本 PR の対象外（既存の `runAnalyzeMemories`/`--analyze-memories`、
 * ADR 0143 の領分）。⟹ (甲) が検査すべきなのは「この PR が実際に触ったもの」（埋め込み
 * 表の統計）だけであり、`memories` という本 PR が触っていない変数を歯から外すため、
 * `vector-search-hnsw.test.ts` の「等価クエリ」の歯（30行目付近、`memories` と
 * `JOIN` しない SQL を直接 `EXPLAIN` する）と同じ形に揃えた。`pool.query` を
 * フックして `search()` の実発行 SQL を捕まえる作りはやめた。
 *
 * ## なぜ使い捨てデータベースを使うか（`temp-database.ts` / `dedicated-schema.postgres.test.ts`
 * と同じ作法）
 *
 * この歯を他のテストファイルが積んだ行・`ANALYZE` のノイズから隔離するため、この歯
 * 専用の使い捨てデータベースを使う——新規データベースの埋め込み表は誰にも触られて
 * おらず、この歯が書いた行だけを持つ。
 *
 * ## autovacuum を切る理由
 *
 * `ALTER TABLE ... SET (autovacuum_enabled = false)` を投入前に打つ。そうしないと、
 * 「upsert 内蔵の ANALYZE が効いた」のか「autovacuum がたまたま拾った」のか区別が
 * 付かず、この歯は何も証明しない（本 Issue の指示どおり）。
 */

const TEST_DATABASE = "mnemora_embedding_statistics_test";
const TENANT = "embedding-statistics-tenant";

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function uniqueSpace(label: string): EmbeddingSpaceId {
  return {
    provider: "embedding-statistics-test",
    model: `${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

async function disableAutovacuum(pool: Pool, table: string): Promise<void> {
  await pool.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
}

describe("PostgresVectorStore.upsert と ANALYZE の自動発火（Issue #360 / ADR 0194）", () => {
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    await dropTempDatabase(admin(), TEST_DATABASE);
    await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
    client = createPostgresClient(connectionStringFor(TEST_DATABASE));
    await runMigrations(client.pool);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await closePostgresClient(client);
    }
    await dropTempDatabase(admin(), TEST_DATABASE);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 30_000);

  it("(甲) 新しい空間へ upsert だけで閾値を越える行数を書くと、テスト側が一度も ANALYZE を撃たなくても HNSW 索引が選ばれる", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const space = uniqueSpace("crossing");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);
    await disableAutovacuum(pool, table);

    // 4,000 = 4 * INITIAL_ANALYZE_THRESHOLD。等比の閾値（1,000 / 2,000 / 4,000）に
    // ちょうど一致させる——最後の ANALYZE（4,000行目）が、投入完了時点の実際の行数と
    // 過不足なく一致するようにするため（閾値が投入総数と一致しない場合、最後の
    // ANALYZE から先の未反映分だけ統計が古くなるが、この歯ではその誤差要因を
    // 排除して「upsert 内蔵の ANALYZE だけで HNSW が選ばれる」ことを最短で示す）。
    const rowCount = 4 * INITIAL_ANALYZE_THRESHOLD;
    const rand = seededRandom(20260917);
    for (let i = 0; i < rowCount; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    // ⚠ 事前条件の確認: autovacuum を切ってあるので、ここまでに走った ANALYZE は
    // upsert 内蔵のもの以外にありえない。last_analyze（明示 ANALYZE 用の列。
    // autovacuum が動かす last_autoanalyze とは別）が入っていることを確認する。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = $1`,
      [table],
    );
    expect(statResult.rows[0]?.last_analyze).not.toBeNull();
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    // `search()` の実発行 SQL は `memories` と JOIN するため、この歯が検査したい変数
    // （埋め込み表の統計だけで HNSW に届くか）から `memories` の統計を切り離せない
    // （上のファイル doc「(甲) が EXPLAIN する SQL は search() の実発行 SQL ではない」
    // 参照）。`vector-search-hnsw.test.ts` の「等価クエリ」の歯と同じ形——埋め込み表
    // だけを引く、`search()` と同じ `ORDER BY <距離演算子>` の SQL——を直接 EXPLAIN する。
    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT memory_id, embedding <=> '[0.5,0.5,0.5]'::vector AS distance
       FROM ${table}
       WHERE tenant_id = $1
       ORDER BY embedding <=> '[0.5,0.5,0.5]'::vector
       LIMIT 10`,
      [TENANT],
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);

  it("(乙) 統計が既に十分な表では、upsert が閾値を跨いでも ANALYZE を撃たない（last_analyze が動かない）", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const space = uniqueSpace("guard");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);
    await disableAutovacuum(pool, table);

    // 事前に、このプロセスの upsert カウンタを一切進めない形で行を作る
    // （生 SQL で直接 INSERT する——vectorStore.upsert() を使うとこのテーブルの
    // プロセスカウンタが進んでしまい、「まだ upsert していないのに統計だけ大きい」
    // という(乙)が検査したい状況を作れない）。
    const rand = seededRandom(20260917001);
    const preExistingCount = INITIAL_ANALYZE_THRESHOLD + 100; // 1,100
    for (let i = 0; i < preExistingCount; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await pool.query(
        `INSERT INTO ${table} (tenant_id, memory_id, embedding, model, created_at)
           VALUES ($1, $2, $3::vector, $4, now())`,
        [TENANT, memory.id, `[${vector.join(",")}]`, space.model],
      );
    }

    // ここで初めて、テスト側が明示的に ANALYZE を撃つ（(乙) の前提条件そのもの——
    // 「先に ANALYZE を撃って reltuples を十分大きくしておき」）。
    await pool.query(`ANALYZE ${table}`);
    const beforeStat = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = $1`,
      [table],
    );
    const lastAnalyzeBefore = beforeStat.rows[0]?.last_analyze;
    expect(lastAnalyzeBefore).not.toBeNull();

    // このプロセスの upsert カウンタは、このテーブルについてはまだ0——
    // ちょうど INITIAL_ANALYZE_THRESHOLD（1,000）回だけ upsert を呼び、閾値を跨がせる。
    // reltuples（≈1,100、上のテーブル全行数と一致——1,100行しかないので ANALYZE の
    // サンプリングが全件走査になる）はこのプロセスの累計（1,000）以上なので、
    // guard により ANALYZE は撃たれないはずである。
    for (let i = 0; i < INITIAL_ANALYZE_THRESHOLD; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    const afterStat = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = $1`,
      [table],
    );
    expect(afterStat.rows[0]?.last_autoanalyze).toBeNull();
    expect(afterStat.rows[0]?.last_analyze).toEqual(lastAnalyzeBefore);
  }, 120_000);
});
