import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// `delete` は渡した space の行だけを消す。全 space から消すのは `deleteAcrossSpaces` の役目で、
// embed ジョブの後始末（ADR 0382）は「今の space に書いたばかりの1行」だけを消す前提で `delete` を呼ぶ。
// testkit の `in-memory-vector-store-delete-space.test.ts` と同じ約束を、core の Fake にも当てる。
const ctx: Ctx = { tenantId: "fake-delete-space" };
const SPACE_A: EmbeddingSpaceId = { provider: "test", model: "delete-space-a", dimensions: 3 };
const SPACE_B: EmbeddingSpaceId = { provider: "test", model: "delete-space-b", dimensions: 3 };
// provider・model が同じで次元だけが違う空間も、別の space である。
const SPACE_A_4D: EmbeddingSpaceId = { ...SPACE_A, dimensions: 4 };

async function setup(): Promise<{
  stores: ReturnType<typeof createFakeRuntimeStores>;
  target: MemoryId;
}> {
  const stores = createFakeRuntimeStores();
  const created = await stores.memoryStore.createMemory(ctx, newMemory("fake-delete-space"));
  return { stores, target: created.id };
}

function newMemory(contentHash: string): NewMemory {
  const recordedAt = new Date("2026-06-01T00:00:00.000Z");
  const halfLifeHours = 24 * 365;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-delete-space" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
  };
}

describe("FakeVectorStore.delete は渡した space の行だけを消す", () => {
  it("同じ memoryId の、他の space の行は残る", async () => {
    const { stores, target } = await setup();
    const vs = stores.vectorStore;
    await vs.upsert(ctx, SPACE_A, target, [1, 0, 0]);
    await vs.upsert(ctx, SPACE_B, target, [0, 1, 0]);
    await vs.upsert(ctx, SPACE_A_4D, target, [0, 0, 1, 0]);
    const beforeB = await vs.getVectors!(ctx, SPACE_B, [target]);
    const beforeA4d = await vs.getVectors!(ctx, SPACE_A_4D, [target]);
    expect(beforeB).toHaveLength(1);
    expect(beforeA4d).toHaveLength(1);

    await vs.delete(ctx, SPACE_A, target);

    expect(await vs.getVectors!(ctx, SPACE_A, [target])).toEqual([]);
    expect(await vs.getVectors!(ctx, SPACE_B, [target])).toEqual(beforeB);
    expect(await vs.getVectors!(ctx, SPACE_A_4D, [target])).toEqual(beforeA4d);
  });

  it("他の space の行は、search でも引ける", async () => {
    const { stores, target } = await setup();
    const vs = stores.vectorStore;
    await vs.upsert(ctx, SPACE_A, target, [1, 0, 0]);
    await vs.upsert(ctx, SPACE_B, target, [1, 0, 0]);

    await vs.delete(ctx, SPACE_A, target);

    const filter = { tenantId: ctx.tenantId };
    const hitsA = await vs.search(ctx, SPACE_A, [1, 0, 0], { limit: 10, filter });
    const hitsB = await vs.search(ctx, SPACE_B, [1, 0, 0], { limit: 10, filter });
    expect(hitsA.map((h) => h.memoryId)).toEqual([]);
    expect(hitsB.map((h) => h.memoryId)).toEqual([target]);
  });

  it("同じ space の、他の memoryId の行は残る", async () => {
    const { stores, target } = await setup();
    const vs = stores.vectorStore;
    const other = (await stores.memoryStore.createMemory(ctx, newMemory("fake-delete-other"))).id;
    await vs.upsert(ctx, SPACE_A, target, [1, 0, 0]);
    await vs.upsert(ctx, SPACE_A, other, [0, 1, 0]);
    const beforeOther = await vs.getVectors!(ctx, SPACE_A, [other]);
    expect(beforeOther).toHaveLength(1);

    await vs.delete(ctx, SPACE_A, target);

    expect(await vs.getVectors!(ctx, SPACE_A, [target])).toEqual([]);
    expect(await vs.getVectors!(ctx, SPACE_A, [other])).toEqual(beforeOther);
  });
});

// `Ctx.tenantId` は「store はこの値で行を分ける。跨いだら事故である」（ctx.ts の TSDoc）。
// Postgres の `tenant-boundary-reads-and-writes.postgres.test.ts` と同じ形を、Fake にも当てる。
describe("FakeVectorStore.delete は他のテナントの行を消さない", () => {
  it("A の ctx で B の memoryId を delete しても、B の行は残る", async () => {
    const stores = createFakeRuntimeStores();
    const vs = stores.vectorStore;
    const ctxB: Ctx = { tenantId: "fake-delete-space-b" };
    const ofB = (
      await stores.memoryStore.createMemory(ctxB, {
        ...newMemory("fake-delete-of-b"),
        tenantId: ctxB.tenantId,
      })
    ).id;
    await vs.upsert(ctxB, SPACE_A, ofB, [1, 0, 0]);
    const beforeB = await vs.getVectors!(ctxB, SPACE_A, [ofB]);
    expect(beforeB).toHaveLength(1);

    await vs.delete(ctx, SPACE_A, ofB);

    expect(await vs.getVectors!(ctxB, SPACE_A, [ofB])).toEqual(beforeB);
  });
});
