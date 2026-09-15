import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0047 の決め手を実測する歯。
 *
 * `packages/core/src/__tests__/runtime.test.ts:277`/`:311`
 * （「使用報告は抽出器を通らず、recall_usages への挿入と reinforce だけを行う」等）は
 * **本番経路**（`runtime.observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })`）
 * を通って `MemoryStore.recordUsage` を呼ぶ。`recall_usages.recall_id` は
 * `NOT NULL REFERENCES recalls(id)`（`migrations/0001_init.sql`）——⟹
 * 実在しない `recallId` を渡す同じ呼び出しは、**Postgres に対しては今日でも外部キー
 * 違反で落ちるはずである**。
 *
 * 擬似物（in-memory）の存在理由は「DB 無しで測れること」である。本番で起こりえない
 * 振る舞い（実在しない recallId で `recordUsage` が黙って成功する）を擬似物の上だけで
 * 緑にすることは、その存在理由を裏切る——これが ADR 0047 の芯であり、この歯はその
 * 前提が実際に成り立っている（Postgres は本当に落ちる）ことを示す。
 *
 * **⚠ 引数なしの `.rejects.toThrow()` は使わない。** 外部キー違反は Postgres の
 * SQLSTATE `23503`（`foreign_key_violation`）であり、そのものを検査する
 * （⚠ ただし drizzle が pg のエラーを包むので、`cause` の連鎖を辿る。下の `sqlStateOf` 参照）。`.toThrow()` だけでは
 * 「何か失敗した」ことしか分からず、例えば型不一致やドライバの別のエラーでも
 * 満たされてしまい、「外部キー制約が実際に効いている」ことの証明にならない。
 *
 * **フィクスチャは非対称**——実在しない recallId では失敗し、実在する recallId
 * （`store.createRecall` で発行したもの）では成功することを同じ検査の中で見る。
 * そうしないと「recordUsage が常に失敗する」実装が通ってしまう。
 */
/**
 * 例外の連鎖から PostgreSQL の SQLSTATE を取り出す。
 *
 * **⚠ `advisory-lock.ts` の `(err as { code?: string }).code` はここでは効かない。**
 * あちらは生の `PoolClient.query()` を使っているので pg のエラーがそのまま上がるが、
 * `PostgresMemoryStore` は drizzle の `db.execute()` を使っており、drizzle が
 * `Error: Failed query: ...` で**包む**——SQLSTATE は `cause` の側に入る。
 * （CI で実測して判明した: `code` を直接読むと `undefined` になる。）
 *
 * 実測（PostgreSQL 17.9、手元）: 連鎖は2段——1段目が包んだ `Error`、2段目が `code` を持つ
 * pg のエラー。上限の 8 はその余裕であって、8段の連鎖を観測したわけではない。
 *
 * ⟹ 連鎖を辿って探す。見つからなければ `undefined` を返し、呼び出し側の
 * assertion が落ちる——「何か失敗した」で済ませないため。
 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("PostgresMemoryStore.recordUsage — 外部キー違反（ADR 0047 の決め手）", () => {
  it("実在しない recallId に対しては外部キー違反（23503）で失敗し、実在する recallId では成功する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-fk-decisive" };

    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));

    // 実在しない recallId（well-formed な UUID だが recalls 行が無い）。
    const missingRecallId = randomUUID();
    let caught: unknown;
    await store.recordUsage(ctx, missingRecallId, [memory.id]).catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeDefined();
    // ⚠ 「何か失敗した」では足りない。外部キー制約が実際に効いていることの証明として、
    // SQLSTATE 23503（foreign_key_violation）そのものを当てる（sqlStateOf の doc 参照）。
    expect(sqlStateOf(caught)).toBe("23503");

    // 非対称の相方: 実在する recallId では成功する。
    const recallId = await store.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
    });
    const result = await store.recordUsage(ctx, recallId, [memory.id]);
    expect(result.insertedMemoryIds).toEqual([memory.id]);
  });
});
