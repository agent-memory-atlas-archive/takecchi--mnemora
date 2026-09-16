import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresLexicalStore.search` の tie-break（Issue #345 /
 * [ADR 0175](../../../../docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)）。
 *
 * `packages/postgres/src/__tests__/vector-search-tiebreak.test.ts`（Issue #339 /
 * ADR 0170、ANN チャンネル側の先例）と同じ作法に揃える。**ただし、決定性を確かめる
 * ためだけに1回引いて同じ順序を見る歯は弱い**——それでは「たまたま `id` の大小関係が
 * 都合よく揃っていただけ」という可能性を排除できない。「DB を作り直しても同じ」を
 * 1つの DB の中で表現するために、以下の性質を使う:
 *
 * - `memories.id` は行ごとに `gen_random_uuid()` が新しく振るランダムな UUID である
 *   （`packages/postgres/src/memory-store.ts` の `createMemory`）。**同じ筋書きを
 *   別々のテナントで N 回繰り返せば、2件の `id` の大小関係は毎回独立に引き直される**
 *   ——これは「DB を作り直す」ことの本質（fresh ingest のたびに `id` の大小関係が
 *   変わる）を、1つの DB・1つのテスト内で標本抽出する形である。
 * - `coverage`/`rank` は**同じ `content` を持つ行を作れば完全に一致する**
 *   （`mnemora_lexical_coverage`/`ts_rank_cd` はどちらも `content` だけの関数——
 *   下記「確かめたこと」参照）。
 *
 * **なぜ N=20 か**: 実装が `id` 順（`ORDER BY coverage DESC, rank DESC, id` のように
 * `recorded_at` を挟まない旧形）に落ちていた場合、`newer`/`older` のどちらが先に
 * 返るかは「たまたま `newer.id` が `older.id` より辞書順で小さいかどうか」という、
 * `gen_random_uuid()` が生む一様乱数のコイントスに帰着する（1回あたり的中確率 ≈ 1/2）。
 * **この歯は「`recorded_at` が新しい方が常に先」を N=20 回連続で要求する**——実装が
 * 正しく `recorded_at` を見ていれば理論上 20/20 で当然通るが、`recorded_at` を見ずに
 * `id` の運に任せているだけなら、20/20 続けて「たまたま」正しい向きに転ぶ確率は
 * **2⁻²⁰ ≈ 0.000095%** しかない。⟹ この歯が緑になることは、単発の歯より遥かに強く
 * 「`recorded_at` を実際に見ている」ことを裏付ける。
 *
 * 各回で生成された2つの `id` の大小関係も記録し、ループ終了後に「両方の向き
 * （`newer.id` が `older.id` より小さい回・大きい回）が少なくとも1回ずつ現れた」ことも
 * 検査する——`newer` が常に先に返るという結果が、たまたま「`newer` の `id` がいつも
 * 小さかった」という偏りの産物ではないことを示すため（ADR 0170 の歯と同じ発想）。
 * **⚠ この追加の検査は確率的に失敗しうる**——20回中、片方の向きが一度も出ない確率は
 * 2 × 2⁻²⁰ ≈ 0.00019%（両方向とも一様独立という前提の概算）。無視できるほど小さいと
 * 判断して残す。
 */
const TENANT_PREFIX = "lexical-search-tiebreak-tenant";
const QUERY = "widget";
// 同じ content を使えば coverage も rank も完全一致する（別の作業者が
// lexical-store-index.test.ts の 20,000 行 seed で実測済み。本ファイルでも
// psql で `mnemora_lexical_coverage`/`ts_rank_cd` に同一 content を2回通し、
// 返り値が完全一致することを事前に確認した上でこの歯を書いている）。
const TIED_CONTENT = "widget alpha bravo tie-break test content";

describe("PostgresLexicalStore.search — coverage/rank が完全一致したときの tie-break（Issue #345 / ADR 0175）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("recorded_at が新しい方を先に返す — N=20回、毎回別テナントで id の大小関係を引き直しても崩れない（実装が id 順に落ちていれば通る確率は2⁻²⁰）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);

    const N = 20;
    const newerIdSmaller: boolean[] = [];

    for (let i = 0; i < N; i++) {
      const tenantId = `${TENANT_PREFIX}-${i}`;
      const ctx: Ctx = { tenantId };

      // older を先に作る（recorded_at が古い）。
      const older = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId,
          content: TIED_CONTENT,
          recordedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );
      // newer を後で作る（recorded_at が新しい）。
      const newer = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId,
          content: TIED_CONTENT,
          recordedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      );

      const hits = await lexicalStore.search(ctx, QUERY, {
        limit: 10,
        filter: { tenantId, status: ["active", "contested"] },
      });

      expect(hits).toHaveLength(2);
      // 両方とも coverage/rank が完全に同点であることが前提。
      expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
      expect(hits[0]!.rank).toBe(hits[1]!.rank);

      // ⟹ `recorded_at` が新しい方（newer）が常に先に来る。
      expect(hits.map((h) => h.memoryId)).toEqual([newer.id, older.id]);

      newerIdSmaller.push(newer.id < older.id);
    }

    // 追加の検査（本文の doc コメント参照）: 20回のうちで、newer.id が older.id より
    // 小さかった回・大きかった回の両方が最低1回ずつ現れていること。これが崩れていたら
    // 「たまたま newer の id がいつも小さかった」という偏りを疑う必要がある
    // （確率的に失敗しうる歯——概算 2 × 2⁻²⁰ ≈ 0.00019%。上のクラス doc 参照）。
    expect(newerIdSmaller).toContain(true);
    expect(newerIdSmaller).toContain(false);
  }, 60_000);

  it("recorded_at まで完全一致したときは id にフォールバックし、例外にも欠落にもならない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const tenantId = `${TENANT_PREFIX}-collision`;
    const ctx: Ctx = { tenantId };

    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, content: TIED_CONTENT, recordedAt: sameRecordedAt }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, content: TIED_CONTENT, recordedAt: sameRecordedAt }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId, status: ["active", "contested"] },
    });

    // 欠落・重複が無いことがまず前提(このケースで最も起きてはいけない壊れ方)。
    expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set([a.id, b.id]));
    expect(hits).toHaveLength(2);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);

    // `recorded_at` が完全一致したときの並びは `id` の辞書順に落ちる（このケースに限り、
    // ADR 0170 が ANN 側で引き受けたのと同じ残余——ADR 0175「決めたこと」参照）。
    const expectedOrder = [a.id, b.id].sort();
    expect(hits.map((h) => h.memoryId)).toEqual(expectedOrder);
  }, 60_000);
});
