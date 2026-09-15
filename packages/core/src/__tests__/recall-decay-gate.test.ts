import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

/**
 * 忘却ゲート（decay floor gate）の歯（マネージャー決定、Issue #196 /
 * [ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）。
 *
 * ADR 0011「Phase 1 では `decayFloorAtAfter` を読み取りフィルタに使わない」を
 * ADR 0153 が明示的に上書きした——recall は既定でこのゲートを有効にする
 * （opt-in ではなく opt-out。`RecallQuery.includeFullyDecayed`）。
 *
 * `recall-period-filter.test.ts`（ADR 0059）と同型: `packages/core` 自身のテストなので
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 * DB を要さないため手元で実行できる。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(opts: { vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore } = {}) {
  const stores = createFakeRuntimeStores();
  const vectorStore = opts.vectorStoreOverride
    ? opts.vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function captureFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const capturedFilters: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (ctx, space, query, opts) => {
    capturedFilters.push(opts.filter);
    return originalSearch(ctx, space, query, opts);
  };
  return capturedFilters;
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

// ---------------------------------------------------------------------------
// 配線の歯: 既定で段1の filter に decayFloorAtAfter = now が渡り、
// includeFullyDecayed:true で undefined に戻る。
// ---------------------------------------------------------------------------

describe("recall() — 段1の filter に decayFloorAtAfter が載ること（配線の歯、ADR 0153）", () => {
  it("既定（includeFullyDecayed 未指定）では VectorStore.search の opts.filter.decayFloorAtAfter に「いま」が渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.decayFloorAtAfter).toEqual(NOW);
  });

  it("includeFullyDecayed: true では decayFloorAtAfter は undefined のまま渡る（ADR 0153 以前の挙動に戻す）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], includeFullyDecayed: true });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.decayFloorAtAfter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⭐ 本命の歯: ゲートが実際に何を変えるか（ANN チャンネル）。
// ---------------------------------------------------------------------------

describe("recall() — 忘却ゲートが実際に候補を落とす（ANN チャンネル、ADR 0153）", () => {
  it("decayFloorAt が過去（減衰しきった）記憶は既定では返らず、omitted にも explain にも黙って消えない", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "alive",
      decayFloorAt: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(alive.id);
    expect(ids).not.toContain(decayed.id);

    // 段1（ANN）の push-down が候補集合そのものから除いているので、core の後置フィルタは
    // この候補を一度も見ない——⟹ count は 0 のままで、偽の omission を積まない
    // （マネージャー決定「ゲートが1件も落とさなかったときに、偽の omitted を積まない」の
    // 裏側: ここでは「後置フィルタとしては1件も落としていない」ことを固定する）。
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );

    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["decayGate"]).toBe("pushed_down");
  });

  it("includeFullyDecayed: true を渡すと、減衰しきった記憶も戻る（明示的な逃げ道、北極星の問い2）", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      includeFullyDecayed: true,
    });

    expect(result.memories.map((m) => m.memoryId)).toContain(decayed.id);
    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["decayGate"]).toBe("disabled");
  });

  it("境界: decayFloorAt がちょうど now と同じ記憶は含まれない（狭義の `>`、VectorFilter.decayFloorAtAfter と同じ境界）", async () => {
    const { runtime, stores } = buildRuntime();
    const onBoundary = await createEmbeddedMemory(stores, [1, 0], {
      digest: "on-boundary",
      decayFloorAt: NOW,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(onBoundary.id);
  });
});

// ---------------------------------------------------------------------------
// ⭐ 語彙チャンネル: LexicalFilter は decayFloorAtAfter を持たない
// （マネージャー決定3）ので、core の後置フィルタだけがゲートを担う。
// ---------------------------------------------------------------------------

describe("recall() — 忘却ゲートが語彙チャンネルにも同じ述語で効く（後置フィルタ、ADR 0153）", () => {
  it("語彙チャンネルだけを使っても、減衰しきった記憶は既定では返らず、omitted に filtered(decayed) が実測件数で出る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "decayed-lexical",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: new Date(NOW.getTime() - 1_000),
      }),
    );
    const alive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "alive-lexical",
        content: "gemstone の価格改定メモ",
        decayFloorAt: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365),
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

    // ⚠ 件数を偽らない: `LexicalFilter` は decayFloorAtAfter を持たないので
    // `FakeLexicalStore`（postgres 実装と同じく LexicalFilter の契約のみを見る）は
    // decayed-lexical もヒットとして返す。それを core の後置フィルタが実際に1件落とす
    // ——ANN の押し下げ分とは違い、この count は正確に数えられる（`countKind: 'lower_bound'`
    // なのは「ANN 側の押し下げ分は含まれていない」という一般則に合わせているだけで、
    // ここで実際に測った1件という数自体は exact である）。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      count: 1,
      countKind: "lower_bound",
    });

    const lexicalTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "lexical",
    );
    expect(lexicalTrace?.detail?.["decayGate"]).toBe("post_filtered");
  });

  it("includeFullyDecayed: true では語彙チャンネルも減衰しきった記憶を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "decayed-lexical",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: new Date(NOW.getTime() - 1_000),
      }),
    );

    const result = await runtime.recall(ctx, {
      text: "gemstone",
      channels: ["lexical"],
      limit: 10,
      includeFullyDecayed: true,
    });

    expect(result.memories.map((m) => m.memoryId)).toContain(decayed.id);
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
    const lexicalTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "lexical",
    );
    expect(lexicalTrace?.detail?.["decayGate"]).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// ⭐⭐ 検算: 押し下げと後置フィルタが同じ述語であること（マネージャー決定3）。
//
// `DecayFloorAtAfterStrippingVectorStore` は `PeriodStrippingVectorStore`
// （recall-period-filter.test.ts、ADR 0059）と同じ手口——`opts.filter` から
// `decayFloorAtAfter` **だけ**を剥がしてから委譲する。これは「段1の adapter が
// ADR 0034 の契約（filter を実際に適用する）を守らなかった」状況を歯の中だけで
// 再現するものであり、本番コード（recall-runtime.ts / vector-store.ts）は
// 1文字も変えない。
// ---------------------------------------------------------------------------

class DecayFloorAtAfterStrippingVectorStore implements VectorStore {
  constructor(private readonly inner: VectorStore) {}

  upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["upsert"]>[2],
    vector: number[],
  ): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(ctx, space, memoryId, vector);
  }

  delete(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["delete"]>[2],
  ): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(ctx, space, memoryId);
  }

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const { decayFloorAtAfter: _decayFloorAtAfter, ...stripped } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 押し下げと後置フィルタは同じ述語であることの検算（ADR 0153 決めたこと3）", () => {
  it("段1の adapter が decayFloorAtAfter を無視しても、core の後置フィルタが同じ述語で拾う（多層防御）", async () => {
    const { runtime, stores } = buildRuntime({
      vectorStoreOverride: (fvs) => new DecayFloorAtAfterStrippingVectorStore(fvs),
    });
    const decayed = await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed-despite-broken-adapter",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(decayed.id);
    // ここでは ANN の adapter がゲートを守らなかったぶん、候補が core の後置フィルタまで
    // 届いている——⟹ 今回は count に載る（普段の押し下げ経路とは違う数え方になることを
    // 明示する歯）。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("通常の配線（adapter が正しく押し下げる）では、後置フィルタは追加で何も落とさない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "decayed",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "alive",
      decayFloorAt: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    // 押し下げが既に落としているので、後置フィルタが「追加で」落とす分は無い
    // ——`filtered(decayed)` の omission そのものが1件も積まれない。
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });
});
