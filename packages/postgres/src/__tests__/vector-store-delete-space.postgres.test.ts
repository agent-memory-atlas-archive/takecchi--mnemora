import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

// `delete` は渡した space の行だけを消す。全 space から消すのは `deleteAcrossSpaces` の役目で、
// embed ジョブの後始末（ADR 0382）は「今の space に書いたばかりの1行」だけを消す前提で `delete` を呼ぶ。
// testkit の `in-memory-vector-store-delete-space.test.ts` と同じ約束を、Postgres にも当てる。
const ctx: Ctx = { tenantId: "pg-delete-space" };
const SPACE_A: EmbeddingSpaceId = TEST_EMBEDDING_SPACE;
const SPACE_B: EmbeddingSpaceId = { provider: "test", model: "pg-delete-space-b", dimensions: 3 };
// provider・model が同じで次元だけが違う空間も、別の space（別のテーブル）である。
const SPACE_A_4D: EmbeddingSpaceId = { ...SPACE_A, dimensions: 4 };

function unitVector(dimensions: number, at: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => (i === at ? 1 : 0));
}

describe("PostgresVectorStore.delete は渡した space の行だけを消す", () => {
  beforeAll(async () => {
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, SPACE_B);
    await registerEmbeddingSpace(pool, SPACE_A_4D);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function setup(contentHash: string): Promise<{
    vs: PostgresVectorStore;
    target: MemoryId;
  }> {
    const { db } = await getTestClient();
    const created = await new PostgresMemoryStore(db).createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }),
    );
    return { vs: new PostgresVectorStore(db), target: created.id };
  }

  it("同じ memoryId の、他の space の行は残る", async () => {
    const { vs, target } = await setup("pg-delete-space-target");
    await vs.upsert(ctx, SPACE_A, target, unitVector(SPACE_A.dimensions, 0));
    await vs.upsert(ctx, SPACE_B, target, unitVector(SPACE_B.dimensions, 1));
    await vs.upsert(ctx, SPACE_A_4D, target, unitVector(SPACE_A_4D.dimensions, 2));
    const beforeB = await vs.getVectors(ctx, SPACE_B, [target]);
    const beforeA4d = await vs.getVectors(ctx, SPACE_A_4D, [target]);
    expect(beforeB).toHaveLength(1);
    expect(beforeA4d).toHaveLength(1);

    await vs.delete(ctx, SPACE_A, target);

    expect(await vs.getVectors(ctx, SPACE_A, [target])).toEqual([]);
    expect(await vs.getVectors(ctx, SPACE_B, [target])).toEqual(beforeB);
    expect(await vs.getVectors(ctx, SPACE_A_4D, [target])).toEqual(beforeA4d);
  });

  it("他の space の行は、search でも引ける", async () => {
    const { vs, target } = await setup("pg-delete-space-search");
    const query = unitVector(SPACE_A.dimensions, 0);
    await vs.upsert(ctx, SPACE_A, target, query);
    await vs.upsert(ctx, SPACE_B, target, query);

    await vs.delete(ctx, SPACE_A, target);

    const filter = { tenantId: ctx.tenantId };
    const hitsA = await vs.search(ctx, SPACE_A, query, { limit: 10, filter });
    const hitsB = await vs.search(ctx, SPACE_B, query, { limit: 10, filter });
    expect(hitsA.map((h) => h.memoryId)).toEqual([]);
    expect(hitsB.map((h) => h.memoryId)).toEqual([target]);
  });
});
