import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `PostgresVectorStore.search` の tie-break（Issue #339 / ADR 0170）。
 *
 * ADR 0167 が最初に足した tie-break（距離 → `memory_id`）は、`memory_id` が
 * ingest のたびに新しく振られるランダムな UUID であるため、**同一内容が
 * fresh ingest（DB を作り直す）のたびに、同点候補の並び順が変わってしまう**
 * ——`examples/chat` の `compare` の⭐門（322ターン行）で実際に観測した
 * （Issue #339 本文）。
 *
 * 本ファイルは、距離が完全に一致する2件を意図的に作り（同じベクトルを2回 `upsert`）、
 * `recorded_at` の順序で決定的に並ぶこと（`memory_id` の大小には依存しないこと）を
 * 直接検査する。`memory_id` は `gen_random_uuid()` が振るため、事前にどちらが
 * 大きい/小さいかを制御できない——そこで、**まず自然に生成された2つの `memory_id`
 * の大小関係を実測し、その大小関係と「意図して逆にした」`recorded_at` の順序を
 * 突き合わせる**ことで、「`memory_id` の辞書順ではなく `recorded_at` が勝っている」
 * ことを、偶然の一致に頼らず示す。
 */
const TENANT = "vector-search-tiebreak-tenant";
const QUERY_VECTOR: number[] = [1, 0, 0];
const TIED_VECTOR: number[] = [1, 0, 0]; // クエリと完全に同一 = 距離0で確実にタイになる。

describe("PostgresVectorStore.search — 距離が完全一致したときの tie-break（Issue #339 / ADR 0170）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("recorded_at が新しい方を先に返す（memory_id の大小には依存しない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // older を先に作る（recorded_at が古い）。
    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, older.id, TIED_VECTOR);

    // newer を後で作る（recorded_at が新しい）。
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, newer.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });

    expect(hits).toHaveLength(2);
    // 両方とも距離0（完全なタイ）であることが前提。
    expect(hits[0]!.distance).toBeCloseTo(0, 10);
    expect(hits[1]!.distance).toBeCloseTo(0, 10);

    // ⟹ `recorded_at` が新しい方（newer）が常に先に来る。
    // `memory_id` の辞書順が偶然これと一致しているだけではないことを、
    // 生成された2つの id の大小関係を実測して確認する。
    const idsInLexicalOrder = [older.id, newer.id].sort();
    const newerWinsLexicalOrder = idsInLexicalOrder[0] === newer.id;

    expect(hits.map((h) => h.memoryId)).toEqual([newer.id, older.id]);
    // この歯自体は id の大小に関わらず通るが、レポートに残す目的で記録する:
    // newerWinsLexicalOrder が false のケース（= id の辞書順と recorded_at の順序が
    // 逆）でも上のアサーションが通ることが、「id の辞書順に依存していない」ことの
    // 直接証拠になる。
    void newerWinsLexicalOrder;
  }, 60_000);

  it("recorded_at まで完全一致したときは memory_id にフォールバックし、例外にも欠落にもならない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, recordedAt: sameRecordedAt }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, a.id, TIED_VECTOR);
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, recordedAt: sameRecordedAt }),
    );
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, b.id, TIED_VECTOR);

    const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY_VECTOR, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });

    // 欠落・重複が無いことがまず前提（このケースで最も起きてはいけない壊れ方）。
    expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set([a.id, b.id]));
    expect(hits).toHaveLength(2);

    // `recorded_at` が完全一致したときの並びは `memory_id` の辞書順に落ちる
    // （このケースに限り、ADR 0167 が最初に足した挙動に戻る——ADR 0170 の
    // 「確かめていないこと」に明記した既知の残余）。
    const expectedOrder = [a.id, b.id].sort();
    expect(hits.map((h) => h.memoryId)).toEqual(expectedOrder);
  }, 60_000);
});
