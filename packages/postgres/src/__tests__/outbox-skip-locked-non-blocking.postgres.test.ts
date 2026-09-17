import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ADR 0208 の決め手。`PostgresOutboxStore.claimBatch` の docstring（ADR 0206 由来）が
 * 残していた ⚠ ——「`SKIP LOCKED` が実際に詰まりを減らすことは測っていない」——を埋める歯。
 *
 * ## この歯が測っているもの
 *
 * **本番の `claimBatch` を実際に呼び、「詰まらないこと」を肯定側で主張する。**
 * 外部トランザクション（`holder`）が唯一の claim 可能な行の行ロックを保持したまま、
 * `lock_timeout` を積んだ専用クライアントで `claimBatch` を撃つ。`SKIP LOCKED` が
 * 効いていれば、ロック済みの行を待たずに飛ばして **0件で解決する**
 * （候補が他に無いので `claimBatch` 全体としては「拾えるものが無かった」になる）。
 *
 * ⛔ **やっていないこと**: 手書きの SQL 文字列に対して `SKIP LOCKED` を外し、それが
 * `55P03` で落ちることを確かめる形（前の担い手が提案したが採らなかった）。**それでは
 * 本番コードを1行も通らない**——`outbox-store.ts` から `SKIP LOCKED` を消しても、
 * その歯は緑のままになる（[Issue #424](https://github.com/takecchi/mnemora/issues/424)
 * が「赤くならないなら、その歯は飾りである」と戒めた形そのもの）。この歯は
 * `PostgresOutboxStore.claimBatch` を直接呼ぶ——`outbox-store.ts` から
 * `SKIP LOCKED` を削ると、この歯自体が `55P03` で赤くなる（ADR 0208「測ったこと」参照）。
 *
 * ## flaky にならない理由
 *
 * 判定は**所要時間の閾値ではなく、例外が出たか出なかったかという離散的な結果**である。
 * `holder` のロック保持は `finally` で明示的に手放すまで確実に続くので、
 * `lock_timeout = 100ms` を跨ぐ猶予は構造的に在る——CI ランナーの負荷でこの歯が
 * 「たまに赤い」になることは無い（ADR 0208「決定」参照）。
 *
 * ## なぜ `packages/testkit` の適合 suite に置かないか
 *
 * `testkit` は store 非依存で `OutboxStore` interface 越しの操作しか受け取らず、
 * 生の接続（`BEGIN` / `lock_timeout` という session レベルの設定）を触れない。加えて
 * `55P03` は PostgreSQL 固有の SQLSTATE であり、他 adapter に移植できる契約になっていない
 * （ADR 0208「採らなかった案」参照）。だからこの歯は `packages/postgres` 側に置く。
 */
describe("PostgresOutboxStore.claimBatch — SKIP LOCKED が詰まりを止めること（ADR 0208）", () => {
  const TENANT = "outbox-skip-locked-non-blocking-tenant";

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("行ロックを保持された唯一の候補行に対して撃つと、待たずに0件で解決する", async () => {
    const { pool } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };

    // 唯一の claim 可能なジョブを1本だけ用意する。
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [TENANT],
    );
    const jobId = seeded.rows[0]?.id;
    expect(jobId).toBeDefined();

    // 1. pool から専用コネクションを1本借り、その行のロックを保持する（コミットしない）。
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM outbox WHERE id = $1 FOR UPDATE", [jobId]);

    // 2. claimer 専用クライアント。`options` を startup parameter として積む設計
    //    （`client.ts` の doc コメント）を使い、`lock_timeout` をこのセッションだけに敷く。
    const claimerClient = createPostgresClient(requireDatabaseUrl(), {
      options: "-c lock_timeout=100ms",
      max: 1,
    });

    try {
      const store = new PostgresOutboxStore(claimerClient.db);
      // 3. 肯定側の主張: 例外を投げずに解決し、ロックされた行をスキップして0件を返す
      //    （＝詰まらなかった）。`SKIP LOCKED` を外すと、`lock_timeout=100ms` の間
      //    ロック解放を待ち続けて `55P03`（canceling statement due to lock timeout）
      //    で例外になり、この行が赤くなる。
      await expect(
        store.claimBatch(ctx, {
          limit: 10,
          now: new Date(),
          claimedBy: "skip-locked-claimer",
          leaseMs: 60_000,
        }),
      ).resolves.toEqual([]);
    } finally {
      // 4. 後始末: 先にロックを手放し、コネクションを返却してから claimer 側を閉じる。
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await closePostgresClient(claimerClient).catch(() => {});
    }
  });
});
