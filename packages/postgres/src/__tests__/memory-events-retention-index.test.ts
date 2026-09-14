import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { buildPurgeExpiredEventsTargetSelect } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 「前」の測定のために落とした索引を作り直すための DDL。**マイグレーションファイルから
 * そのまま読む**——ここに DDL を書き写すと、
 * migrations/0010_memory_events_retention_index.sql を後から直したときに、この復元だけが
 * 古い定義のまま静かにずれる（memories-requeue-embed-index.test.ts の
 * MIGRATION_0007_SQL と同じ理由）。
 */
const MIGRATION_0010_SQL = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, "0010_memory_events_retention_index.sql"),
  "utf8",
);

/**
 * Issue #210 / ADR 0115 の実測。
 *
 * `PostgresMemoryStore.purgeExpiredEvents`（`../memory-store.js`）が対象を選ぶ SELECT の
 * 中身は `buildPurgeExpiredEventsTargetSelect` が組み立てる。**この検査はその関数の
 * 返り値をそのまま `EXPLAIN` する**——テスト側に述語を書き写さない
 * （`memories-requeue-embed-index.test.ts` の `explainTargetSelect` と同じ理由）。
 *
 * `migrations/0010_memory_events_retention_index.sql` はこの述語のための索引
 * `idx_memory_events_by_retention`（`(tenant_id, at)`、部分索引ではない）を足した。
 *
 * このテストは3本ある:
 * 1. **前** = 索引が無い世界。既存の2索引（`idx_memory_events_by_memory`/
 *    `idx_memory_events_by_kind`）はどちらも `memory_id`/`kind` を等値で拘束しないと
 *    `at` の全体順序を提供できないため、`ORDER BY at LIMIT n` に `Sort` が挟まる
 *    （＝ `LIMIT` の早期打ち切りが効かない）ことを確認する。
 * 2. **後** = 索引が在る世界。`idx_memory_events_by_retention` が実際に使われ、
 *    **`Sort` が消える**ことを確認する。
 * 3. `kind <> 'events_purged'` は索引に含めていない（部分索引にしていない）——
 *    Filter として残ることを出力で確認する（母数が小さい除外なので、部分索引にする
 *    動機が薄いという `0010_*.sql` の判断の裏付け）。
 *
 * すべて `console.log` で全文を出力する。
 */

const TENANT = "memory-events-retention-tenant";
const ROW_COUNT = 20_000;

/**
 * `memory_events` に大量の行を用意する。`memory_id` はすべて `NULL` にする
 * ——CHECK 制約（`kind <> 'events_purged' OR memory_id IS NULL`）は
 * `events_purged` 以外の kind に `memory_id` の非 NULL を要求しないため、実在する
 * `memories` 行を用意する必要が無い（索引の実測に本質的でない前提を減らす）。
 *
 * `kind` は 99% を `'created'`（掃除対象になりうる）、1% を `'events_purged'`
 * （掃除対象から除外される）に分ける——除外述語 `kind <> 'events_purged'` が
 * 実際に少数派を弾く形（`0010_*.sql` の「少数派を除外する」という想定どおりの分布）。
 */
async function seedManyEvents(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO memory_events (
      id, tenant_id, memory_id, kind, at, actor, meta
    )
    SELECT
      gen_random_uuid(),
      $1,
      NULL,
      CASE WHEN i % 100 = 0 THEN 'events_purged' ELSE 'created' END,
      now() - (i || ' seconds')::interval,
      '{"type":"system"}'::jsonb,
      '{}'::jsonb
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  await pool.query("ANALYZE memory_events");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const CTX: Ctx = { tenantId: TENANT };
// cutoff を「今より1秒前」より新しくすると母数がほぼ全件になり、狙った選択性
// （「これより古い」がほとんどの行に当たる）を再現できない。中間あたりを切る。
const OLDER_THAN = new Date(Date.now() - (ROW_COUNT / 2) * 1000);
const OPTS = { olderThan: OLDER_THAN, limit: 50 };

/**
 * 🔴 **本体が実際に打つ `SELECT` をそのまま `EXPLAIN` する。**
 */
async function explainTargetSelect(): Promise<string> {
  const { db } = await getTestClient();
  const target = buildPurgeExpiredEventsTargetSelect(CTX, OPTS);
  const result = await db.execute(sql`EXPLAIN (FORMAT TEXT) ${target}`);
  return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
}

describe("memory_events の保持期間掃除索引（Issue #210 / ADR 0115）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("前: idx_memory_events_by_retention が無い世界では Sort が挟まる（LIMIT の早期打ち切りが効かない）", async () => {
    const { pool } = await getTestClient();
    await seedManyEvents(pool, TENANT, ROW_COUNT);

    // 「前」= 本 PR 以前の姿。`idx_memory_events_by_retention` は本 PR が足した索引で
    // あり「前」の世界には存在しない——一時的に落とす。`resetTestDatabase()` はテーブル
    // の中身を TRUNCATE するだけでマイグレーションは再実行しないため、必ず `finally` で
    // 元の定義を作り直す（memories-requeue-embed-index.test.ts と同じ勘所）。
    await pool.query("DROP INDEX idx_memory_events_by_retention");
    try {
      const plan = await explainTargetSelect();
      console.log(`=== EXPLAIN（前: idx_memory_events_by_retention 無し）===\n${plan}`);

      // ⚠ どちらの索引（`idx_memory_events_by_memory`/`idx_memory_events_by_kind`）や
      // Seq Scan が選ばれるかは統計次第であり、この PR の主張には関係ない。測りたいのは
      // 「`ORDER BY at LIMIT n` を索引が供給できていない」——`Sort` が挟まっていること
      // そのもの。
      expect(plan).toContain("Sort");
    } finally {
      await pool.query(MIGRATION_0010_SQL);
    }
  }, 60_000);

  it("後: idx_memory_events_by_retention が実際に使われ、at の全体ソートを索引が肩代わりする", async () => {
    const { pool } = await getTestClient();
    await seedManyEvents(pool, TENANT, ROW_COUNT);

    const plan = await explainTargetSelect();
    console.log(`=== EXPLAIN（後: idx_memory_events_by_retention 在り）===\n${plan}`);

    expect(plan).toContain("idx_memory_events_by_retention");
    // ⚠ `"Sort Key: memory_events.at"` と書かないこと——単一テーブルの `Sort Key` に
    // PostgreSQL は表名を前置しない（`memories-requeue-embed-index.test.ts` と同じ注意）。
    expect(plan).not.toContain("Sort Key");
    // `kind <> 'events_purged'` は索引に無いので Filter として残る（部分索引にしていない
    // ことの裏付け）。
    expect(plan).toContain("Filter");
    expect(plan).toContain("events_purged");
  }, 60_000);
});
