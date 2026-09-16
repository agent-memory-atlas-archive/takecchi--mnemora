import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryStatus } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと8・9
 * （Issue #305）: `idx_memories_recall_gate_seq`
 * （`(tenant_id, status, decay_floor_seq)`、`WHERE status IN ('active', 'contested')`。
 * `migrations/0015_decay_activity_clock.sql`）に対して、`recall-gate-index.test.ts` が
 * Issue #150 で確立した3本立て（歯1 形・歯2 適用可能性・歯3 同値）を**同じ形で**置く。
 *
 * **`recall-gate-index.test.ts` 冒頭の doc コメントを先に読むこと。** ここでは繰り返さない
 * ——要点だけ書くと、「プランナがこの索引を選んだ」と「この索引がこの述語に使える」は
 * 別の主張であり、後者（性質）だけを assert する。前者（コスト比較で実際に選ばれるか）は
 * 他にどんな索引が在るかに依存して揺れる。
 *
 * ⚠ **この歯が測らないもの**: 段1の実際のゲート述語（`packages/postgres/src/vector-store.ts`）は
 * `(decay_floor_seq IS NULL OR decay_floor_seq > $n)` という、**NULL を通す OR** を含む形である
 * （ADR 0165 決めたこと4「NULL はこの軸には床が無いことを意味する」）。この索引テストの
 * 代表クエリ（`GATE_SELECT`、下記）は `recall-gate-index.test.ts` の `decay_floor_at`
 * 版と同じく**「本番が実際に発行する SQL ではない」**——`decay_floor_at` がそうであるのと
 * 同じ理由で、ここでは NULL 分岐を持たない素の範囲比較にしてある。
 * **`IS NULL OR >` という複合条件は、同じ列に対する2つの選言（NULL 判定・範囲判定）を
 * bitmap 経由でしか1本の索引にまとめられない**（`enable_bitmapscan = off` で歯2を測ると
 * この複合条件では索引が引けなくなる、という制約そのものを検査してしまうことになり、
 * 「この索引が range 述語に使えるか」という測りたい性質から外れる）。
 * ⟹ **NULL 分岐を含む実際のゲート述語の検査は、`packages/testkit` の
 * `vector-store-conformance.ts`（`decayFloorSeqAfter` の適合テスト、`PostgresVectorStore.search`
 * を実際に叩く）に委ねる。**そちらは代表クエリではなく本番の実装コードを直接検査する。
 */

const TENANT = "recall-gate-seq-tenant";

/** `recall-gate-index.test.ts` と同じ理由で 4000（歯1〜3 はいずれも行数に依存しない）。 */
const ROW_COUNT = 4000;

/** 段1の関門が候補に含める status。索引の部分述語と同じ集合であること自体を歯1が測る。 */
const GATE_STATUSES = ["active", "contested"] as const;

/**
 * 全行に同じ `decay_floor_seq`（非 null）を持たせ、閾値 `0` は常に真になるようにしてある
 * ——`recall-gate-index.test.ts` の `decay_floor_at > now() - interval '1000 days'`
 * （seed した全行が常に通る、非選択的な条件）と同じ役割。この歯が測るのは
 * 「`status` の集合」であって、`decay_floor_seq` の値そのものの選択性ではない。
 */
const FIXED_DECAY_FLOOR_SEQ = 1_000_000;

/**
 * 段1の関門クエリ（活動時計版）。`recall-gate-index.test.ts` の `GATE_SELECT` と同じ理由で、
 * **本番が実際に発行している SQL ではない**——NULL 分岐を持たない素の範囲比較にしてある
 * （ファイル冒頭 doc コメント参照）。
 */
const GATE_SELECT = `SELECT id, status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[]) AND decay_floor_seq > $3
       ORDER BY decay_floor_seq, id
       LIMIT 50`;

const GATE_PARAMS: [string, string[], number] = [TENANT, [...GATE_STATUSES], 0];

async function insertManyMemories(
  store: PostgresMemoryStore,
  ctx: Ctx,
  statuses: MemoryStatus[],
  pool: Pool,
) {
  // ADR 0140: `createMemory` は `status: 'contested'` を `contestedWithId` 無しでは
  // 作れない。`recall-gate-index.test.ts` と同じ理由・同じ形で対向を1件だけ用意する。
  const contestedCompanion = await store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      decayBaseSeq: 0,
      decayFloorSeq: FIXED_DECAY_FLOOR_SEQ,
      halfLifeRecalls: 720,
    }),
  );
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const status = statuses[i % statuses.length]!;
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        status,
        contestedWithId: status === "contested" ? contestedCompanion.id : undefined,
        decayBaseSeq: 0,
        decayFloorSeq: FIXED_DECAY_FLOOR_SEQ,
        halfLifeRecalls: 720,
      }),
    );
  }
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引を選んでしまう
  // （`recall-gate-index.test.ts` と同じ勘所）。
  await pool.query("ANALYZE memories");
}

type Forcing = "none" | "btreeIndex" | "seqscan";

/** `recall-gate-index.test.ts` の `withForcing` と同じ形（このファイル単独で完結させる）。 */
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

async function explainGate(pool: Pool, forcing: Forcing): Promise<string> {
  return withForcing(pool, forcing, async (client) => {
    const result = await client.query(`EXPLAIN (FORMAT TEXT) ${GATE_SELECT}`, GATE_PARAMS);
    return result.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
  });
}

async function gateRowIds(pool: Pool, forcing: Forcing): Promise<string[]> {
  return withForcing(pool, forcing, async (client) => {
    const result = await client.query<{ id: string }>(GATE_SELECT, GATE_PARAMS);
    return result.rows.map((row) => row.id);
  });
}

describe("idx_memories_recall_gate_seq（ADR 0165 / Issue #305）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /**
   * 歯1（形）: `recall-gate-index.test.ts` と同じ形——catalog から列順・部分述語を読む。
   * プランナを一切通さない。
   */
  it("形: idx_memories_recall_gate_seq は (tenant_id, status, decay_floor_seq) の3列で、部分述語が拾う status は active と contested の2つちょうど", async () => {
    const { pool } = await getTestClient();

    const shape = await pool.query<{
      col0: string | null;
      col1: string | null;
      col2: string | null;
      natts: number;
      is_partial: boolean;
      pred_expr: string | null;
      is_valid: boolean;
    }>(
      `SELECT
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) AS col0,
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[1]) AS col1,
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[2]) AS col2,
         i.indnatts AS natts,
         i.indpred IS NOT NULL AS is_partial,
         pg_get_expr(i.indpred, i.indrelid) AS pred_expr,
         i.indisvalid AS is_valid
       FROM pg_index i
       WHERE i.indexrelid = 'idx_memories_recall_gate_seq'::regclass`,
    );

    expect(shape.rows).toHaveLength(1);
    const row = shape.rows[0]!;
    expect([row.col0, row.col1, row.col2]).toEqual(["tenant_id", "status", "decay_floor_seq"]);
    expect(row.natts).toBe(3);
    expect(row.is_valid).toBe(true);

    expect(row.is_partial).toBe(true);
    const pred = row.pred_expr ?? "";
    const literals = [...pred.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(literals)].sort(), pred).toEqual([...GATE_STATUSES].sort());
  });

  /**
   * 歯2（適用可能性）: `recall-gate-index.test.ts` と同じ形——btree 経路だけに絞ると、
   * 部分述語 `status IN ('active','contested')` を含意する `status = ANY(...)` の下で
   * `idx_memories_recall_gate_seq` が選べること。
   */
  it("適用可能性: btree 経路だけに絞ると、部分述語 (status IN ('active','contested')) でも idx_memories_recall_gate_seq が引ける", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await insertManyMemories(
      store,
      ctx,
      ["active", "contested", "superseded", "archived", "forgotten"],
      pool,
    );

    const naturalPlan = await explainGate(pool, "none");
    console.log(`=== EXPLAIN（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`);

    const forcedPlan = await explainGate(pool, "btreeIndex");
    console.log(
      `=== EXPLAIN（enable_seqscan = off, enable_bitmapscan = off。歯2が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate_seq");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  /**
   * 歯3（同値）: `recall-gate-index.test.ts` と同じ形——自然・btree強制・全走査強制の
   * 3経路が同じ行を返すこと。
   */
  it("同値: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行を返す（contested を含み、他の status を含まない）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await insertManyMemories(
      store,
      ctx,
      ["active", "contested", "superseded", "archived", "forgotten"],
      pool,
    );

    const natural = await gateRowIds(pool, "none");
    const viaBtree = await gateRowIds(pool, "btreeIndex");
    const viaSeqScan = await gateRowIds(pool, "seqscan");

    expect(viaBtree).toEqual(viaSeqScan);
    expect(natural).toEqual(viaSeqScan);
    expect(natural).toHaveLength(50);

    const dataResult = await pool.query<{ status: string }>(
      `SELECT status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[])`,
      [GATE_PARAMS[0], GATE_PARAMS[1]],
    );
    const statusesReturned = new Set(dataResult.rows.map((row) => row.status));
    expect(statusesReturned.has("active")).toBe(true);
    expect(statusesReturned.has("contested")).toBe(true);
    expect(statusesReturned.has("superseded")).toBe(false);
    expect(statusesReturned.has("archived")).toBe(false);
    expect(statusesReturned.has("forgotten")).toBe(false);
  }, 60_000);
});
