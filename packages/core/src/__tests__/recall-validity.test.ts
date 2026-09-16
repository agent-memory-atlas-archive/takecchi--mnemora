import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LexicalFilter } from "../interfaces/lexical-store.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { VectorFilter } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecallQuery.validAt` ゲートの歯（Issue #280、Issue #202 第2弾、マネージャー決定1〜3）。
 *
 * `recall-decay-gate.test.ts`（ADR 0153）と同型: `packages/core` 自身のテストなので
 * `@mnemora/testkit` には依存しない。DB を要さないため手元で実行できる。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        return req.schema.parse({
          memories: [{ content: "抽出結果", provenanceKind: "stated" }],
        }) as T;
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function captureVectorFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const captured: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (ctx, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(ctx, space, query, opts);
  };
  return captured;
}

function captureLexicalFilters(
  stores: ReturnType<typeof createFakeRuntimeStores>,
): LexicalFilter[] {
  const captured: LexicalFilter[] = [];
  const originalSearch = stores.lexicalStore.search.bind(stores.lexicalStore);
  stores.lexicalStore.search = async (ctx, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(ctx, query, opts);
  };
  return captured;
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10; // 長い half-life。既定では減衰しない。
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
    validFrom: null,
    validUntil: null,
    strength,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

const DAY_MS = 1_000 * 60 * 60 * 24;

// ---------------------------------------------------------------------------
// 配線の歯: 既定で段1の filter に validAt = now が渡り、
// includeOutsideValidity:true で undefined に戻る（ADR 0153 の decayFloorAtAfter と同型）。
// ---------------------------------------------------------------------------

describe("recall() — 段1の filter に validAt が載ること（配線の歯、Issue #280）", () => {
  it("既定（validAt/includeOutsideValidity 未指定）では VectorStore.search / LexicalStore.search の opts.filter.validAt に「いま」が渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);
    const lexicalFilters = captureLexicalFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], channels: ["ann", "lexical"], text: "本文" });

    expect(vectorFilters).toHaveLength(1);
    expect(vectorFilters[0]?.validAt).toEqual(NOW);
    expect(lexicalFilters).toHaveLength(1);
    expect(lexicalFilters[0]?.validAt).toEqual(NOW);
  });

  it("validAt を明示すると、その時刻が段1へそのまま渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);
    const past = new Date(NOW.getTime() - 100 * DAY_MS);

    await runtime.recall(ctx, { vector: [1, 0], validAt: past });

    expect(vectorFilters[0]?.validAt).toEqual(past);
  });

  it("includeOutsideValidity: true では validAt は undefined のまま渡る（ゲート無効）", async () => {
    const { runtime, stores } = buildRuntime();
    const vectorFilters = captureVectorFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], includeOutsideValidity: true });

    expect(vectorFilters[0]?.validAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⭐ 本命の歯: ゲートが実際に何を変えるか。
// ---------------------------------------------------------------------------

describe("recall() — validAt ゲートが実際に候補を落とす／浮上させる（ADR 0164）", () => {
  it("受け入れ条件1: 過去の validAt を指定すると、その時点で真だった（今は期限切れの）記憶が返る", async () => {
    const { runtime, stores } = buildRuntime();
    // 「去年の住所」: 365日前から30日前まで真だった。
    const oldAddress = await createEmbeddedMemory(stores, [1, 0], {
      digest: "old-address",
      validFrom: new Date(NOW.getTime() - 365 * DAY_MS),
      validUntil: new Date(NOW.getTime() - 30 * DAY_MS),
    });
    // 「今の住所」: 30日前から無期限に真。
    const currentAddress = await createEmbeddedMemory(stores, [1, 0], {
      digest: "current-address",
      validFrom: new Date(NOW.getTime() - 30 * DAY_MS),
      validUntil: null,
    });

    // 100日前の時点では、old-address は真・current-address はまだ真になっていない。
    const validAt = new Date(NOW.getTime() - 100 * DAY_MS);
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, validAt });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(oldAddress.id);
    expect(ids).not.toContain(currentAddress.id);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "not_yet_valid",
      count: 1,
      countKind: "exact",
    });
  });

  it("条件3: 既定（validAt 省略）では期限切れの記憶が返らず、omitted に 'expired' で名指しされる", async () => {
    const { runtime, stores } = buildRuntime();
    const expired = await createEmbeddedMemory(stores, [1, 0], {
      digest: "expired",
      validFrom: new Date(NOW.getTime() - 365 * DAY_MS),
      validUntil: new Date(NOW.getTime() - 30 * DAY_MS),
    });
    const current = await createEmbeddedMemory(stores, [1, 0], {
      digest: "current",
      validFrom: new Date(NOW.getTime() - 30 * DAY_MS),
      validUntil: null,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(current.id);
    expect(ids).not.toContain(expired.id);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "expired",
      count: 1,
      countKind: "exact",
    });
  });

  it("validFrom が未来の記憶は既定では返らず、omitted に 'not_yet_valid' で名指しされる", async () => {
    const { runtime, stores } = buildRuntime();
    const future = await createEmbeddedMemory(stores, [1, 0], {
      digest: "future-plan",
      validFrom: new Date(NOW.getTime() + 30 * DAY_MS),
      validUntil: null,
    });
    const current = await createEmbeddedMemory(stores, [1, 0], {
      digest: "current-plan",
      validFrom: null,
      validUntil: null,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(current.id);
    expect(ids).not.toContain(future.id);
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "not_yet_valid",
      count: 1,
      countKind: "exact",
    });
  });

  it("includeOutsideValidity: true を渡すと、期限切れ・未到来のどちらも戻る（明示的な逃げ道）", async () => {
    const { runtime, stores } = buildRuntime();
    const expired = await createEmbeddedMemory(stores, [1, 0], {
      digest: "expired",
      validUntil: new Date(NOW.getTime() - 30 * DAY_MS),
    });
    const future = await createEmbeddedMemory(stores, [1, 0], {
      digest: "future",
      validFrom: new Date(NOW.getTime() + 30 * DAY_MS),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      includeOutsideValidity: true,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(expired.id);
    expect(ids).toContain(future.id);
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "expired" }),
    );
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "not_yet_valid" }),
    );
  });

  it("両方 null（既存データの大多数）は「いつでも真」として扱われ、既定でも返る（マネージャー決定1）", async () => {
    const { runtime, stores } = buildRuntime();
    const alwaysValid = await createEmbeddedMemory(stores, [1, 0], {
      digest: "always-valid",
      validFrom: null,
      validUntil: null,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alwaysValid.id);
    expect(result.omitted).toHaveLength(0);
  });

  it("境界: validUntil がちょうど validAt と同じ記憶は含まれない（狭義の `>`）", async () => {
    const { runtime, stores } = buildRuntime();
    const onBoundary = await createEmbeddedMemory(stores, [1, 0], {
      digest: "on-boundary",
      validUntil: NOW,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(onBoundary.id);
  });

  it("境界: validFrom がちょうど validAt と同じ記憶は含まれる（閉じた左端 `<=`）", async () => {
    const { runtime, stores } = buildRuntime();
    const onBoundary = await createEmbeddedMemory(stores, [1, 0], {
      digest: "on-boundary",
      validFrom: NOW,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(onBoundary.id);
  });
});

// ---------------------------------------------------------------------------
// ⭐ 語彙チャンネル: LexicalFilter も validAt を持つ（decayFloorAtAfter とは違う扱い、
// マネージャー決定2）ので、段1の SQL/フィルタで直接絞られる。
// ---------------------------------------------------------------------------

describe("recall() — validAt ゲートが語彙チャンネルにも段1で効く（Issue #280）", () => {
  it("語彙チャンネルだけを使っても、期限切れの記憶は既定では返らない", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "expired-lexical",
        content: "gemstone の在庫確認メモ",
        validUntil: new Date(NOW.getTime() - 30 * DAY_MS),
      }),
    );
    const alive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "alive-lexical",
        content: "gemstone の価格改定メモ",
        validUntil: null,
      }),
    );

    const result = await runtime.recall(ctx, {
      text: "gemstone",
      channels: ["lexical"],
      limit: 10,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(alive.id);
    expect(ids).toHaveLength(1);

    const lexicalTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "lexical",
    );
    expect(lexicalTrace?.detail?.["validityGate"]).toBe("pushed_down");
  });
});

// ---------------------------------------------------------------------------
// ⭐ Runtime.observe() の validFrom/validUntil が Memory まで到達する（条件4）。
// ---------------------------------------------------------------------------

describe("Runtime.observe() — validFrom/validUntil が Memory まで素通しされる（Issue #280、マネージャー決定4）", () => {
  it("observe({ kind: 'utterance', validFrom, validUntil }) が Memory.validFrom/validUntil に到達する", async () => {
    const { runtime, stores } = buildRuntime();
    const validFrom = new Date(NOW.getTime() - 30 * DAY_MS);
    const validUntil = new Date(NOW.getTime() + 30 * DAY_MS);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "郵便番号は123-4567です",
      validFrom,
      validUntil,
    });

    expect(result.memoryIds.length).toBeGreaterThan(0);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.validFrom).toEqual(validFrom);
    expect(memory?.validUntil).toEqual(validUntil);
  });

  it("validFrom/validUntil を渡さない observe() は、これまでどおり null のままである（非破壊）", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "郵便番号は123-4567です",
    });

    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.validFrom ?? null).toBeNull();
    expect(memory?.validUntil ?? null).toBeNull();
  });
});
