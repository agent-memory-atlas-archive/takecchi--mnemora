import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildArchiveDecayedTargetSelect, PostgresMemoryStore } from "../memory-store.js";
import * as schema from "../schema.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0114 の実測: `archiveDecayed` が対象を選ぶ `buildArchiveDecayedTargetSelect`
 * （`../memory-store.js`）が、**新しい索引を追加せずに**既存の `idx_memories_recall_gate`
 * （`(tenant_id, status, decay_floor_at)`、`WHERE status IN ('active', 'contested')`。
 * `migrations/0001_init.sql`）だけで適用可能であることを確かめる。
 *
 * `docs/memory-model.md` §10 はこの索引を「Phase 2 で `decay_floor_at` を読み取りに
 * 使い始めるとき、索引を作り直さずに済むように」3列目を先置きしたと明記している
 * （ADR 0011）。この掃引がまさにその Phase 2 的な読み取りの最初の使用者であり、
 * **索引の3列目が実際に効くことを確かめないと、その先置きが絵に描いた餅で終わる。**
 *
 * `recall-gate-index.test.ts` が確立した作法をそのまま踏襲する:
 * - **本体の関数の返り値をそのまま `EXPLAIN`/実行する。**述語をテスト側に書き写さない
 *   （`memories-requeue-embed-index.test.ts` の `explainTargetSelect` と同じ理由）。
 * - **「選ばれること」ではなく「選べること」を測る。**seq scan と bitmap scan を
 *   プランナから外し、コスト比較という揺れる軸を外して、含意という揺れない軸だけを見る
 *   （`recall-gate-index.test.ts` 冒頭の doc コメント「🔑 プランナがこの索引を選んだ、と
 *   この索引がこの述語に使える、は別の主張である」を参照）。
 * - **本番でこの索引が実際に選ばれることは、この歯は保証しない。**それは
 *   `vector-search-provenance.test.ts` の歯Bのような、強制なしの不変条件が拾う話であり、
 *   ここではまだそういう歯を立てていない——**確かめていないこと**として PR 本文に書く。
 *
 * ⚠ **`buildArchiveDecayedTargetSelect` は drizzle の `SQL` フラグメントを返す。**
 * `SET LOCAL enable_seqscan = off` 等のプランナ強制は `pool` から取り出した特定の
 * `PoolClient` の上でしか効かない（`pool.query()` は呼ぶたびに違う接続を借りうる）。
 * `drizzle(pool, ...)` で作った `db`（`getTestClient()` が返すもの）も同様にプールから
 * 借りるだけなので、**強制した接続とクエリを発行する接続が一致する保証が無い。**
 * ⟹ ここでは `drizzle(client, { schema })` で「強制を掛けたその `PoolClient` 自身」に
 * 束ねた一時的な `Db` を作り、`target`（本体の関数の返り値）をその上で実行する。
 */

const TENANT = "archive-decayed-index-tenant";

/**
 * `memories-requeue-embed-index.test.ts` と同じ勘所——大量行・現実に近い分布でないと
 * プランナが「行数が少ないのでどうせ Seq Scan」を選び、含意の検査にならない。
 * `active` を大半にし、掃引の対象外になる status を少数混ぜる。
 */
const ROW_COUNT = 20_000;

async function seedManyMemories(pool: Pool, tenant: string, rowCount: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO memories (
      id, tenant_id, subject_id, content, content_hash, digest, digest_source,
      provenance_kind, provenance, status, tags, occurred_at, recorded_at,
      last_reinforced_at, strength, half_life_hours, decay_floor_at,
      embedding_status, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      $1,
      NULL,
      'seed content ' || i,
      'archive-decayed-index-seed-' || i,
      'seed digest ' || i,
      'llm',
      'imported',
      '{"kind":"imported","batchId":"fixture-batch"}'::jsonb,
      -- 大半を 'active'（掃引の対象）にし、'contested'（索引の述語には入るが対象外）・
      -- 'archived'/'superseded'/'forgotten'（索引の述語からも対象からも外れる）を少量混ぜる。
      CASE
        WHEN i % 100 = 0 THEN 'contested'
        WHEN i % 100 = 1 THEN 'archived'
        WHEN i % 100 = 2 THEN 'superseded'
        WHEN i % 100 = 3 THEN 'forgotten'
        ELSE 'active'
      END,
      '{}',
      NULL,
      now() - (i || ' seconds')::interval,
      NULL,
      1.0,
      720,
      -- decay_floor_at: 半分は既に閾値を割っている（過去）、半分はまだ（未来）。
      CASE WHEN i % 2 = 0 THEN now() - (i || ' seconds')::interval ELSE now() + (i || ' seconds')::interval END,
      'ready',
      now() - (i || ' seconds')::interval,
      now() - (i || ' seconds')::interval
    FROM generate_series(1, $2) AS i
    `,
    [tenant, rowCount],
  );
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引や Seq Scan を選ぶ
  // （recall-gate-index.test.ts / memories-requeue-embed-index.test.ts と同じ勘所）。
  await pool.query("ANALYZE memories");
}

function planText(rows: { "QUERY PLAN": string }[]): string {
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const CTX: Ctx = { tenantId: TENANT };
/** `now` は seed の中央（`ROW_COUNT / 2` 秒前）に置く——過去・未来の両方が実在する。 */
const NOW = new Date();
const OPTS = { now: NOW, limit: 50 };

type Forcing = "none" | "btreeIndex" | "seqscan";

/**
 * `recall-gate-index.test.ts` の `withForcing` と同じ形。**`release()` を `ROLLBACK` の
 * 外側に置く**——`ROLLBACK` が投げると `release()` に到達せず、その接続がプールへ
 * 戻らないまま失われる（同ファイルの注意点をそのまま踏襲する）。
 */
async function withForcing<T>(
  pool: Pool,
  forcing: Forcing,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (forcing === "btreeIndex") {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    } else if (forcing === "seqscan") {
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    }
    return await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function explainTarget(pool: Pool, forcing: Forcing): Promise<string> {
  return withForcing(pool, forcing, async (client) => {
    const dbOnClient = drizzle(client, { schema });
    const target = buildArchiveDecayedTargetSelect(CTX, OPTS);
    const result = await dbOnClient.execute(sql`EXPLAIN (FORMAT TEXT) ${target}`);
    return planText(result.rows as unknown as { "QUERY PLAN": string }[]);
  });
}

async function targetRowIds(pool: Pool, forcing: Forcing): Promise<string[]> {
  return withForcing(pool, forcing, async (client) => {
    const dbOnClient = drizzle(client, { schema });
    const target = buildArchiveDecayedTargetSelect(CTX, OPTS);
    const result = await dbOnClient.execute(target);
    return (result.rows as unknown as { id: string }[]).map((row) => row.id);
  });
}

describe("archiveDecayed の対象選択索引（ADR 0114）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("適用可能性: btree 経路だけに絞ると、archiveDecayed の対象選択が idx_memories_recall_gate を引ける（新しい索引を追加しない）", async () => {
    const { pool } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const naturalPlan = await explainTarget(pool, "none");
    console.log(`=== EXPLAIN（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`);

    const forcedPlan = await explainTarget(pool, "btreeIndex");
    console.log(
      `=== EXPLAIN（enable_seqscan = off, enable_bitmapscan = off。この歯が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  it("同値: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行集合を返す（active かつ decay_floor_at <= now のみ）", async () => {
    const { pool, db } = await getTestClient();
    await seedManyMemories(pool, TENANT, ROW_COUNT);

    const natural = await targetRowIds(pool, "none");
    const viaBtree = await targetRowIds(pool, "btreeIndex");
    const viaSeqScan = await targetRowIds(pool, "seqscan");

    expect(new Set(viaBtree)).toEqual(new Set(viaSeqScan));
    expect(new Set(natural)).toEqual(new Set(viaSeqScan));
    // ⚠ `FOR UPDATE SKIP LOCKED` + `LIMIT` のため、順序と件数はプラン非依存に
    // `decay_floor_at` 昇順・上限 `OPTS.limit` で揃うはずだが、ここでは集合としての
    // 一致（「同じ行を落としていない」）だけを見る——順序は下の別の歯（データの分岐）で見る。
    expect(natural.length).toBeGreaterThan(0);
    expect(natural.length).toBeLessThanOrEqual(OPTS.limit);

    // 索引の話とデータの話、両方を検査する（「索引はあるが述語を書き間違えて何も
    // 拾えていない」を見逃さないため）。全件で status を確かめる。
    const store = new PostgresMemoryStore(db);
    const idSet = new Set(natural);
    let sawActive = false;
    for (const id of idSet) {
      const memory = await store.get(CTX, id);
      expect(memory?.status).toBe("active");
      expect(memory && memory.decayFloorAt.getTime() <= NOW.getTime()).toBe(true);
      sawActive = true;
    }
    expect(sawActive).toBe(true);
  }, 60_000);
});
