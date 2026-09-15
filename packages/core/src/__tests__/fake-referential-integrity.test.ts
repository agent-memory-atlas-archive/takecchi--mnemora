import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewRecallRecord } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore`/`FakeVectorStore`/`FakeEventStore`（`packages/core` 自身の runtime
 * テスト用フェイク、`runtime-fakes.ts`）が、ADR 0047 で足した外部キー相当の「存在」検査を
 * 実際に守っていることを検査する歯。
 *
 * **`packages/testkit` の適合テストの対象ではない。** これらは adapter 適合テストの
 * 対象である `MemoryStore`/`VectorStore`/`EventStore` 実装（`InMemoryMemoryStore` 等）
 * ではなく、`packages/core` 自身の runtime テスト専用の別系統
 * （`runtime-fakes.ts` 冒頭のコメント: core は testkit に依存しない）。
 * `fake-vector-store-filter.test.ts`（ADR 0034 の穴を core 側で埋めた前例）・
 * `fake-event-store-list.test.ts`（ADR 0042 の同種の前例）と同じ理由・同じ形。
 *
 * **⚠ この歯を置く前は、ADR 0047 が `FakeMemoryStore`/`FakeVectorStore`/`FakeEventStore`
 * に足した9箇所のガードのうち1つも `packages/core` 側からは検査されていなかった**
 * （変異を1つずつ入れて実測: 9箇所とも赤くなる歯が0本だった。「歯が弱い」の実例）。
 * `packages/testkit` の適合テスト（`InMemoryMemoryStore` 等が対象）はこの Fake 系統を
 * 検査できない——テスト対象が違う。この歯はその穴を埋める。
 *
 * すべて非対称——「実在しない参照では失敗する」と「実在する参照では成功する」を
 * 同じ検査の中で見る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function newRecallRecord(): NewRecallRecord {
  return {
    tenantId: "tenant-1",
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
  };
}

function newEvent(
  memoryId: string | null,
  overrides: Partial<NewMemoryEvent> = {},
): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "created",
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...overrides,
  };
}

describe("FakeMemoryStore.createMemory — 外部キー相当（ADR 0047）", () => {
  it("実在しない sourceObservationId に対して失敗し、実在する observation では成功する", async () => {
    const stores = createFakeRuntimeStores();

    await expect(
      stores.memoryStore.createMemory(ctx, newMemory({ sourceObservationId: randomUUID() })),
    ).rejects.toThrow();

    const observation = await stores.memoryStore.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "fixture" },
      occurredAt: null,
    });
    const created = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ sourceObservationId: observation.id }),
    );
    expect(created.sourceObservationId).toBe(observation.id);
  });

  it("実在しない supersededById に対して失敗し、実在する Memory では成功する", async () => {
    const stores = createFakeRuntimeStores();

    await expect(
      stores.memoryStore.createMemory(ctx, newMemory({ supersededById: randomUUID() })),
    ).rejects.toThrow();

    const target = await stores.memoryStore.createMemory(ctx, newMemory());
    const created = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ supersededById: target.id }),
    );
    expect(created.supersededById).toBe(target.id);
  });

  it("実在しない contestedWithId に対して失敗し、実在する Memory では成功する", async () => {
    const stores = createFakeRuntimeStores();

    await expect(
      stores.memoryStore.createMemory(ctx, newMemory({ contestedWithId: randomUUID() })),
    ).rejects.toThrow();

    const target = await stores.memoryStore.createMemory(ctx, newMemory());
    const created = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ contestedWithId: target.id }),
    );
    expect(created.contestedWithId).toBe(target.id);
  });
});

describe("FakeMemoryStore.updateStatus/updateStatusWithEvent — 外部キー相当（ADR 0047）", () => {
  it("updateStatus は実在しない supersededById に対して失敗し、実在する Memory では成功する", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());

    await expect(
      stores.memoryStore.updateStatus(ctx, memory.id, "superseded", {
        supersededById: randomUUID(),
      }),
    ).rejects.toThrow();

    const target = await stores.memoryStore.createMemory(ctx, newMemory());
    const updated = await stores.memoryStore.updateStatus(ctx, memory.id, "superseded", {
      supersededById: target.id,
    });
    expect(updated.supersededById).toBe(target.id);
  });

  it("updateStatusWithEvent は実在しない supersededById に対して失敗し、実在する Memory では成功する", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const buildEvent = (): NewMemoryEvent => ({
      tenantId: "tenant-1",
      memoryId: memory.id,
      kind: "superseded",
      actor: { type: "system" },
      digestSnapshot: memory.digest,
      sizeBeforeBytes: null,
      meta: {},
    });

    await expect(
      stores.memoryStore.updateStatusWithEvent(
        ctx,
        memory.id,
        "superseded",
        { supersededById: randomUUID() },
        buildEvent(),
      ),
    ).rejects.toThrow();

    const target = await stores.memoryStore.createMemory(ctx, newMemory());
    const { memory: updated } = await stores.memoryStore.updateStatusWithEvent(
      ctx,
      memory.id,
      "superseded",
      { supersededById: target.id },
      buildEvent(),
    );
    expect(updated.supersededById).toBe(target.id);
  });
});

describe("FakeMemoryStore.recordUsage — 外部キー相当（ADR 0047）", () => {
  it("実在しない recallId に対して失敗し、実在する recallId では成功する", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());

    await expect(stores.memoryStore.recordUsage(ctx, randomUUID(), [memory.id])).rejects.toThrow();

    const recallId = await stores.memoryStore.createRecall(ctx, newRecallRecord());
    const result = await stores.memoryStore.recordUsage(ctx, recallId, [memory.id]);
    expect(result.insertedMemoryIds).toEqual([memory.id]);
  });

  it("実在しない memoryId を含むと失敗し、実在する memoryId だけなら成功する", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const recallId = await stores.memoryStore.createRecall(ctx, newRecallRecord());

    await expect(
      stores.memoryStore.recordUsage(ctx, recallId, [memory.id, randomUUID()]),
    ).rejects.toThrow();

    const result = await stores.memoryStore.recordUsage(ctx, recallId, [memory.id]);
    expect(result.insertedMemoryIds).toEqual([memory.id]);
  });
});

describe("FakeVectorStore.upsert — 外部キー相当（ADR 0047）", () => {
  it("実在しない memoryId に対して失敗し、実在する memoryId では成功する", async () => {
    const stores = createFakeRuntimeStores();
    const space = { provider: "test", model: "fixture-model", dimensions: 3 };

    await expect(stores.vectorStore.upsert(ctx, space, randomUUID(), [1, 0, 0])).rejects.toThrow();

    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    await expect(
      stores.vectorStore.upsert(ctx, space, memory.id, [1, 0, 0]),
    ).resolves.toBeUndefined();
  });
});

describe("FakeEventStore.append — 外部キー相当（ADR 0047）", () => {
  it("実在しない memoryId に対して失敗し、実在する memoryId では成功する", async () => {
    const stores = createFakeRuntimeStores();

    await expect(stores.eventStore.append(ctx, newEvent(randomUUID()))).rejects.toThrow();

    const memory = await stores.memoryStore.createMemory(ctx, newMemory());
    const appended = await stores.eventStore.append(ctx, newEvent(memory.id));
    expect(appended.memoryId).toBe(memory.id);
  });

  it("memoryId が null なら外部キーを要求しない（events_purged 等、NULL は拒まない）", async () => {
    const stores = createFakeRuntimeStores();

    const appended = await stores.eventStore.append(ctx, newEvent(null, { kind: "events_purged" }));
    expect(appended.memoryId).toBeNull();
  });
});
