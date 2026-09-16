import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { DEFAULT_HALF_LIFE_RECALLS } from "../interfaces/tenant-settings-store.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3・5・12 の
 * 書き込み側3箇所（`runtime.ts` の `buildNewMemoriesForCandidates` / `consolidate` 手順6 /
 * `reflect` 手順7）の配線の歯。
 *
 * 3箇所とも同じ形の `resolveActivityClockInputs` を通る——ここでは代表として抽出
 * （`observe`）で両方の分岐（'wall'/'activity'）を厚く検査し、consolidate・reflect は
 * 「同じ配線が効いている」ことを1本ずつ確認する（3箇所を同じ深さで繰り返さない。
 * 核となる分岐ロジックは共有関数なので、重複した深さのテストは同じバグしか捕まえない）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function llmReturningMemories(
  memories: { content: string; provenanceKind: "stated" | "inferred" }[],
): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories }) as T,
  };
}

function llmConsolidatingTo(result: { content: string }): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(result) as T,
  };
}

function llmReflectingTo(result: { content: string }): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ outcome: "reflected", ...result }) as T,
  };
}

function buildRuntime(llmProvider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("runtime.observe（抽出） — 活動時計の3つ組の配線（ADR 0165 決めたこと3・5・12）", () => {
  it("'wall' のテナント（既定）では decayBaseSeq/decayFloorSeq/halfLifeRecalls が3つとも undefined のまま——tenant_activity を読まない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturningMemories([{ content: "東京出張の予定", provenanceKind: "stated" }]),
    );
    let getActivitySeqCalls = 0;
    const originalGetActivitySeq = stores.tenantSettingsStore.getActivitySeq.bind(
      stores.tenantSettingsStore,
    );
    stores.tenantSettingsStore.getActivitySeq = async (c: Ctx) => {
      getActivitySeqCalls += 1;
      return originalGetActivitySeq(c);
    };

    const result = await runtime.observe(ctx, { kind: "utterance", text: "明日東京に出張します" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);

    expect(memory?.decayBaseSeq ?? null).toBeNull();
    expect(memory?.decayFloorSeq ?? null).toBeNull();
    expect(memory?.halfLifeRecalls ?? null).toBeNull();
    // ADR 0165 決めたこと2 の doc「tenant_settings は読み出しの多い設定行」——
    // 'wall' のテナントでは activity_seq を読みに行く理由が無い。
    expect(getActivitySeqCalls).toBe(0);
  });

  it("'activity' のテナントでは decayBaseSeq=activity_seq・halfLifeRecalls=既定値・decayFloorSeq が計算されて書かれる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturningMemories([{ content: "東京出張の予定", provenanceKind: "stated" }]),
    );
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    // activity_seq を先に進めておく(3にする)——recall を3回行う代わりに、
    // createRecall の同じ経路を直接使う(ADR 0165 決めたこと5 と同じ書き込み口)。
    for (let i = 0; i < 3; i += 1) {
      await stores.memoryStore.createRecall(ctx, {
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
        advanceActivityClock: true,
      });
    }
    expect(await stores.tenantSettingsStore.getActivitySeq(ctx)).toBe(3);

    const result = await runtime.observe(ctx, { kind: "utterance", text: "明日東京に出張します" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);

    expect(memory?.decayBaseSeq).toBe(3);
    expect(memory?.halfLifeRecalls).toBe(DEFAULT_HALF_LIFE_RECALLS);
    expect(memory?.decayFloorSeq).toBe(
      3 + Math.ceil(DEFAULT_HALF_LIFE_RECALLS * Math.log2(1 / 0.05)),
    );
  });
});

describe("runtime.consolidate — 活動時計の3つ組の配線（同じ resolveActivityClockInputs を通る、ADR 0165 決めたこと3・5・12）", () => {
  it("'activity' のテナントでは統合先の Memory にも活動時計の3つ組が書かれる", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後の本文" }));
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.consolidatedMemoryId).not.toBeNull();
    const consolidated = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);

    expect(consolidated?.decayBaseSeq).toBe(0); // activity_seq はまだ1度も進んでいない
    expect(consolidated?.halfLifeRecalls).toBe(DEFAULT_HALF_LIFE_RECALLS);
    expect(consolidated?.decayFloorSeq).not.toBeNull();
  });

  it("'wall' のテナント（既定）では統合先の Memory にも活動時計の3つ組が書かれない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後の本文" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const consolidated = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);

    expect(consolidated?.decayBaseSeq ?? null).toBeNull();
    expect(consolidated?.decayFloorSeq ?? null).toBeNull();
    expect(consolidated?.halfLifeRecalls ?? null).toBeNull();
  });
});

describe("runtime.reflect — 活動時計の3つ組の配線（同じ resolveActivityClockInputs を通る、ADR 0165 決めたこと3・5・12）", () => {
  it("'activity' のテナントでは反映先の Memory にも活動時計の3つ組が書かれる", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.reflectedMemoryId).not.toBeNull();
    const reflected = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);

    expect(reflected?.decayBaseSeq).toBe(0);
    expect(reflected?.halfLifeRecalls).toBe(DEFAULT_HALF_LIFE_RECALLS);
    expect(reflected?.decayFloorSeq).not.toBeNull();
  });

  it("'wall' のテナント（既定）では反映先の Memory にも活動時計の3つ組が書かれない", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
    const reflected = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);

    expect(reflected?.decayBaseSeq ?? null).toBeNull();
    expect(reflected?.decayFloorSeq ?? null).toBeNull();
    expect(reflected?.halfLifeRecalls ?? null).toBeNull();
  });
});
