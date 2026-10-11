import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

// `delete` は渡した space の行だけを消す。全 space から消すのは `deleteAcrossSpaces` の役目で、
// embed ジョブの後始末（ADR 0382）は「今の space に書いたばかりの1行」だけを消す前提で `delete` を呼ぶ。
const ctx: Ctx = { tenantId: "in-memory-delete-space" };
const SPACE_A: EmbeddingSpaceId = { provider: "test", model: "delete-space-a", dimensions: 3 };
const SPACE_B: EmbeddingSpaceId = { provider: "test", model: "delete-space-b", dimensions: 3 };
// provider・model が同じで次元だけが違う空間も、別の space である。
const SPACE_A_4D: EmbeddingSpaceId = { ...SPACE_A, dimensions: 4 };

describe("InMemoryVectorStore.delete は渡した space の行だけを消す", () => {
  it("同じ memoryId の、他の space の行は残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "delete-space-target" }),
    );
    await vectorStore.upsert(ctx, SPACE_A, target.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, SPACE_B, target.id, [0, 1, 0]);
    await vectorStore.upsert(ctx, SPACE_A_4D, target.id, [0, 0, 1, 0]);
    const beforeB = await vectorStore.getVectors!(ctx, SPACE_B, [target.id]);
    const beforeA4d = await vectorStore.getVectors!(ctx, SPACE_A_4D, [target.id]);
    expect(beforeB).toHaveLength(1);
    expect(beforeA4d).toHaveLength(1);

    await vectorStore.delete(ctx, SPACE_A, target.id);

    expect(await vectorStore.getVectors!(ctx, SPACE_A, [target.id])).toEqual([]);
    expect(await vectorStore.getVectors!(ctx, SPACE_B, [target.id])).toEqual(beforeB);
    expect(await vectorStore.getVectors!(ctx, SPACE_A_4D, [target.id])).toEqual(beforeA4d);
  });

  it("他の space の行は、search でも引ける", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "delete-space-search" }),
    );
    await vectorStore.upsert(ctx, SPACE_A, target.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, SPACE_B, target.id, [1, 0, 0]);

    await vectorStore.delete(ctx, SPACE_A, target.id);

    const filter = { tenantId: ctx.tenantId };
    const hitsA = await vectorStore.search(ctx, SPACE_A, [1, 0, 0], { limit: 10, filter });
    const hitsB = await vectorStore.search(ctx, SPACE_B, [1, 0, 0], { limit: 10, filter });
    expect(hitsA.map((h) => h.memoryId)).toEqual([]);
    expect(hitsB.map((h) => h.memoryId)).toEqual([target.id]);
  });

  it("同じ space の、他の memoryId の行は残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const target = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "delete-space-target" }),
    );
    const other = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "delete-space-other" }),
    );
    await vectorStore.upsert(ctx, SPACE_A, target.id, [1, 0, 0]);
    await vectorStore.upsert(ctx, SPACE_A, other.id, [0, 1, 0]);
    const beforeOther = await vectorStore.getVectors!(ctx, SPACE_A, [other.id]);
    expect(beforeOther).toHaveLength(1);

    await vectorStore.delete(ctx, SPACE_A, target.id);

    expect(await vectorStore.getVectors!(ctx, SPACE_A, [target.id])).toEqual([]);
    expect(await vectorStore.getVectors!(ctx, SPACE_A, [other.id])).toEqual(beforeOther);
  });
});

// `Ctx.tenantId` は「store はこの値で行を分ける。跨いだら事故である」（ctx.ts の TSDoc）。
// Postgres の `tenant-boundary-reads-and-writes.postgres.test.ts` と同じ形を、InMemory にも当てる。
describe("InMemoryVectorStore.delete は他のテナントの行を消さない", () => {
  it("A の ctx で B の memoryId を delete しても、B の行は残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    const ctxB: Ctx = { tenantId: "in-memory-delete-space-b" };
    const ofB = await memoryStore.createMemory(
      ctxB,
      buildNewMemoryFixture({ tenantId: ctxB.tenantId, contentHash: "delete-space-of-b" }),
    );
    await vectorStore.upsert(ctxB, SPACE_A, ofB.id, [1, 0, 0]);
    const beforeB = await vectorStore.getVectors!(ctxB, SPACE_A, [ofB.id]);
    expect(beforeB).toHaveLength(1);

    await vectorStore.delete(ctx, SPACE_A, ofB.id);

    expect(await vectorStore.getVectors!(ctxB, SPACE_A, [ofB.id])).toEqual(beforeB);
  });
});
