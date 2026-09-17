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
import {
  INITIAL_ANALYZE_THRESHOLD,
  resetMemoriesWriteCounterForTesting,
} from "../memories-statistics.js";
import { requireDatabaseUrl, seededRandom } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #269 / ADR 0221: ADR 0194 が `memory_embeddings_*` に入れた「等比の閾値越えの
 * ときだけ ANALYZE を撃つ」自動発火を、JOIN の相手側である `memories` にも足す歯。
 *
 * ## なぜこの歯が要るか(実測は Issue #269 / #418)
 *
 * `PostgresVectorStore.search()` は埋め込み表を `memories` と `JOIN` してテナントで
 * 絞る(`vector-store.ts` 参照)。ADR 0194 は埋め込み表側の統計だけを守り、
 * `memories` 側の統計欠如は「引き受けた負債」として残していた——実際に CI
 * (`pgvector/pgvector:pg17`)が、使い捨てデータベース(`memories` に一度も
 * `ANALYZE` が走らない)でこの JOIN のプランを誤らせることを実測で示した
 * (ADR 0194「CI が実際に教えたこと」)。
 *
 * この歯は、その JOIN を含む本物の `search()` の SQL を直接 EXPLAIN する
 * (`embedding-statistics.postgres.test.ts` の (甲) が CI の実測を受けて
 * 「等価クエリ」に後退させたのと逆に、本 PR はまさに `memories` 側の統計が
 * 主題なので、JOIN を含む本物の SQL を検査対象にする)。
 *
 * ## autovacuum を切る理由
 *
 * `ALTER TABLE memories SET (autovacuum_enabled = false)` を投入前に打つ。そうしないと
 * 「upsert 内蔵の ANALYZE が効いた」のか「autovacuum がたまたま拾った」のか区別が
 * 付かない(Issue #269 の実測: autovacuum は既定のままだと、初回投入中に拾うまでの
 * 時間が試行によって 7秒 〜 挿入完了(約60秒)後まで大きくばらつく——歯としては
 * 決定的でなければならない)。
 *
 * ## 使い捨てデータベースを使う理由
 *
 * このテストファイル専用の使い捨てデータベースを使う——他のテストファイルが
 * 積んだ行や `ANALYZE` のノイズから隔離するため(`embedding-statistics.postgres.test.ts`
 * / `dedicated-schema.postgres.test.ts` と同じ作法)。
 */

const TEST_DATABASE = "mnemora_memories_statistics_test";
const TENANT = "memories-statistics-tenant";

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
    provider: "memories-statistics-test",
    model: `${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

async function disableAutovacuum(pool: Pool, table: string): Promise<void> {
  await pool.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
}

/**
 * `pool.query` を一時的に監視し、`matcher` に一致した最初のクエリのテキスト/パラメータを
 * 捕まえる(`scale-bench.ts` / `vector-search-subject.test.ts` の手法をそのまま踏襲)。
 */
async function captureQuery(
  pool: Pool,
  matcher: (text: string) => boolean,
  fn: () => Promise<unknown>,
): Promise<{ text: string; params: unknown[] }> {
  let capturedText: string | undefined;
  let capturedParams: unknown[] | undefined;
  const originalQuery = pool.query.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    const [config, params] = args as [string | { text: string }, unknown[] | undefined];
    const text = typeof config === "string" ? config : config.text;
    if (matcher(text)) {
      capturedText = text;
      capturedParams = params;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any)(...args);
  };
  try {
    await fn();
  } finally {
    pool.query = originalQuery;
  }
  if (capturedText === undefined) {
    throw new Error("captureQuery: matcher に一致するクエリが観測されなかった");
  }
  return { text: capturedText, params: capturedParams ?? [] };
}

describe("PostgresMemoryStore.createMemory と memories の ANALYZE 自動発火(Issue #269)", () => {
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

  it("(甲) 新規インストール相当(memories 未 ANALYZE)で閾値を越える行数を createMemory するだけで、JOIN を含む本物の search() が HNSW 索引を選ぶ", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    const space = uniqueSpace("crossing");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);
    // 埋め込み表側は ADR 0194 の仕組みに任せる(この歯が検査したいのは memories 側のみ)。

    // 4,000 = 4 * INITIAL_ANALYZE_THRESHOLD(等比の閾値ちょうど)。
    const rowCount = 4 * INITIAL_ANALYZE_THRESHOLD;
    const rand = seededRandom(20260917269);
    for (let i = 0; i < rowCount; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    // 事前条件の確認: autovacuum を切ってあるので、ここまでに走った memories の
    // ANALYZE は本 PR のコードが撃ったもの以外にありえない。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(statResult.rows[0]?.last_analyze).not.toBeNull();
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    // JOIN を含む本物の search() SQL を捕まえて EXPLAIN する(#418/ADR 0194 が壊れると
    // 実測した、まさにその形)。
    const queryVector = [0.5, 0.5, 0.5];
    const captured = await captureQuery(
      pool,
      (text) => text.includes(table) && /order by/i.test(text),
      () =>
        vectorStore.search(ctx, space, queryVector, {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT) ${captured.text}`,
      captured.params,
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);

  it("(乙) 統計が既に十分な memories では、createMemory が閾値を跨いでも ANALYZE を撃たない(last_analyze が動かない)", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    // 事前に、このプロセスの memories カウンタを一切進めない形で行を作る
    // (生 SQL で直接 INSERT する——createMemory() を使うとカウンタが進んでしまい、
    // 「まだ createMemory していないのに統計だけ大きい」という(乙)が検査したい
    // 状況を作れない)。
    const preExistingCount = INITIAL_ANALYZE_THRESHOLD + 100; // 1,100
    for (let i = 0; i < preExistingCount; i += 1) {
      await pool.query(
        `INSERT INTO memories (
           id, tenant_id, content, content_hash, digest, digest_source,
           provenance_kind, provenance, status, tags, recorded_at,
           strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, 'llm', 'imported', '{"kind":"imported"}'::jsonb,
           'active', '{}'::text[], now(), 1.0, 720, now() + interval '30 days', 'ready', now(), now()
         )`,
        [TENANT, `memories-statistics 乙 filler #${i}`, `hash-${i}-${randomUUID()}`, `digest-${i}`],
      );
    }

    // ここで初めて、テスト側が明示的に ANALYZE を撃つ((乙) の前提条件そのもの)。
    await pool.query(`ANALYZE memories`);
    const beforeStat = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBefore = beforeStat.rows[0]?.last_analyze;
    expect(lastAnalyzeBefore).not.toBeNull();

    // このプロセスの memories カウンタはまだ0——ちょうど INITIAL_ANALYZE_THRESHOLD
    // (1,000)回だけ createMemory を呼び、閾値を跨がせる。reltuples(≈1,100、上の
    // テーブル全行数と一致)はこのプロセスの累計(1,000)以上なので、guard により
    // ANALYZE は撃たれないはずである。
    const rand = seededRandom(20260917001);
    for (let i = 0; i < INITIAL_ANALYZE_THRESHOLD; i += 1) {
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: `memories-statistics 乙 ${rand()}`,
        }),
      );
    }

    const afterStat = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(afterStat.rows[0]?.last_autoanalyze).toBeNull();
    expect(afterStat.rows[0]?.last_analyze).toEqual(lastAnalyzeBefore);
  }, 120_000);
});

/**
 * Issue #269 の 2026-09-17T09:11:04Z コメント: `supersedeWithNewMemories` も
 * `memories` へ `INSERT` するが、ADR 0221 が入れたフック
 * (`maybeAnalyzeMemoriesAfterWrite`)を呼んでいなかった——`createMemory` /
 * `createMemoryWithOutbox` の2箇所しか呼んでいなかった残りの1経路。
 *
 * この歯は上の (甲) と同じ検査(JOIN を含む本物の search() の EXPLAIN)を、
 * 書き込み経路だけ `createMemory` から `supersedeWithNewMemories` に替えて行う——
 * 「呼ばれたか」ではなく「実際に効いたか」(プランが Seq Scan から Index Scan へ
 * 変わったか)を見る、上の2本と同じ形。
 *
 * `resetMemoriesWriteCounterForTesting()` でプロセスローカルの累計カウンタを
 * 0へ戻してから始める——このカウンタは `memories-statistics.ts` のモジュール
 * スコープに persist するため、同一ファイル内で先に走る (甲)/(乙) の書き込みが
 * 残した累計に依存すると、この歯が本当に閾値を跨いだのか、それとも
 * たまたま前段の残りで跨いだだけなのかが分からなくなる。専用の使い捨て
 * データベースも (甲) と同じ理由(他のテストの行や ANALYZE のノイズからの隔離)で使う。
 */
describe("PostgresMemoryStore.supersedeWithNewMemories と memories の ANALYZE 自動発火(Issue #269 残経路)", () => {
  const TEST_DATABASE_SUPERSEDE = "mnemora_memories_statistics_supersede_test";
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    resetMemoriesWriteCounterForTesting();
    await dropTempDatabase(admin(), TEST_DATABASE_SUPERSEDE);
    await admin().query(`CREATE DATABASE ${TEST_DATABASE_SUPERSEDE}`);
    client = createPostgresClient(connectionStringFor(TEST_DATABASE_SUPERSEDE));
    await runMigrations(client.pool);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await closePostgresClient(client);
    }
    await dropTempDatabase(admin(), TEST_DATABASE_SUPERSEDE);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 30_000);

  it("(丙) supersedeWithNewMemories 経由で新規インストール相当の行数を書くだけで、JOIN を含む本物の search() が HNSW 索引を選ぶ", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    const space = uniqueSpace("crossing-supersede");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);

    // 4,000 = 4 * INITIAL_ANALYZE_THRESHOLD(等比の閾値ちょうど)。(甲) と同じ行数だが、
    // 書き込み経路だけ supersedeWithNewMemories にする——`supersede` は空配列にして
    // news の作成だけを起こす(この歯が検査したいのは news 側の INSERT が
    // ANALYZE フックを起動するかどうかだけである)。
    const rowCount = 4 * INITIAL_ANALYZE_THRESHOLD;
    const rand = seededRandom(20260917270);
    for (let i = 0; i < rowCount; i += 1) {
      const { created } = await memoryStore.supersedeWithNewMemories(
        ctx,
        [
          {
            input: buildNewMemoryFixture({ tenantId: ctx.tenantId }),
            jobKinds: [],
          },
        ],
        [],
      );
      const memory = created[0]!.memory;
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    // 事前条件の確認: autovacuum を切ってあるので、ここまでに走った memories の
    // ANALYZE は本 PR のコードが撃ったもの以外にありえない((甲) と同じ検査)。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(statResult.rows[0]?.last_analyze).not.toBeNull();
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    // JOIN を含む本物の search() SQL を捕まえて EXPLAIN する((甲) と同じ検査)。
    const queryVector = [0.5, 0.5, 0.5];
    const captured = await captureQuery(
      pool,
      (text) => text.includes(table) && /order by/i.test(text),
      () =>
        vectorStore.search(ctx, space, queryVector, {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    const explainResult = await pool.query(
      `EXPLAIN (FORMAT TEXT) ${captured.text}`,
      captured.params,
    );
    const plan = explainResult.rows
      .map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);
});
