import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { runRecall } from "../recall-runtime.js";
import type { RecallRuntimeDeps } from "../recall-runtime.js";
import type { RecallQuery } from "../recall.js";
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

// ---------------------------------------------------------------------------
// ⭐⭐ ADR 0165: 活動時計（decay_clock）の歯。
//
// 下の歯はどれも「壁時計は永久に生きる設定（decayFloorAt が遠い未来）」にしたうえで
// `decayFloorSeq`/`decayBaseSeq` だけを操作する——`halfLifeRecalls` は Memory に載せない
// ままにしておく。段2の `computeDecay`（scoring.ts）は `decayBaseSeq`/`halfLifeRecalls`
// の両方が揃っていないと活動時計を使わず壁時計へフォールバックするので、この歯の対象
// （段1のゲート・後置フィルタ）に段2のスコア変動が混ざらない。
// ---------------------------------------------------------------------------

const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100); // +100年、壁時計では絶対に沈まない

describe("recall() — 忘却ゲートの時計選択（ADR 0165 決めたこと1）", () => {
  it("'wall'（既定）のテナントでは decayFloorSeq が割れていても無視する", async () => {
    const { runtime, stores } = buildRuntime();
    // decay_clock を明示的に設定しない = 既定 'wall'。
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "wall-alive-activity-dead",
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: -1, // 活動時計では既に沈んでいる値
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'activity' のテナントでは壁時計を無視する: decayFloorAt が遠い未来でも decayFloorSeq を割れば除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const dead = await createEmbeddedMemory(stores, [1, 0], {
      digest: "wall-alive-activity-dead",
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 0, // nowSeq(=0)ちょうどで狭義の`>`が効かず既に沈んでいる
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    // ⚠ ここでは `omitted` に `filtered(decayed)` を期待しない——`FakeVectorStore` が
    // `decayFloorSeqAfter` を正しく段1（ANN）へ押し下げるため、この候補は post-filter
    // まで届く前に候補集合そのものから外れる。ANN の押し下げ分は原理的に数えられない
    // （ADR 0011。上の「本命の歯」の同じ注記）ので、ここで数える術は無い——それ自体が
    // 押し下げが効いていることの証拠であり、post-filter の `filtered(decayed)` は
    // 「adapter が押し下げを守らなかったときの多層防御」の側の歯が別に持つ。
    expect(result.memories.map((m) => m.memoryId)).not.toContain(dead.id);
  });

  it("'activity' のテナントでは decayFloorSeq が nowSeq を上回っていれば生き残る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "activity-alive",
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 100,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'activity' のテナントで decayFloorSeq が NULL（この軸に床が無い）なら常に生き残る（ADR 0165 決めたこと4）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "activity-no-floor",
      decayFloorAt: new Date(NOW.getTime() - 1_000), // 壁時計では既に沈んでいるが 'activity' なので無関係
      decayBaseSeq: null,
      decayFloorSeq: null,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'either' はOR: 壁時計は生きているが活動時計は沈んでいても通る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "either-wall-alive",
      decayFloorAt: FAR_FUTURE, // 壁時計は生きている
      decayBaseSeq: 0,
      decayFloorSeq: 0, // 活動時計は沈んでいる(nowSeq=0で狭義の`>`が効かない)
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'either' はOR: 活動時計は生きているが壁時計は沈んでいても通る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const alive = await createEmbeddedMemory(stores, [1, 0], {
      digest: "either-activity-alive",
      decayFloorAt: new Date(NOW.getTime() - 1_000), // 壁時計は沈んでいる
      decayBaseSeq: 0,
      decayFloorSeq: 100, // 活動時計は生きている
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).toContain(alive.id);
  });

  it("'either' はOR: 両方沈んでいれば除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const dead = await createEmbeddedMemory(stores, [1, 0], {
      digest: "either-both-dead",
      decayFloorAt: new Date(NOW.getTime() - 1_000),
      decayBaseSeq: 0,
      decayFloorSeq: 0,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(dead.id);
  });

  it("explain.stages の detail.clock が実際に使ったテナントの時計を名乗る（'activity'/'either'、北極星の問い3）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    await createEmbeddedMemory(stores, [1, 0], { digest: "m", decayFloorAt: FAR_FUTURE });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["clock"]).toBe("activity");
  });
});

describe("recall() — 語彙チャンネルの後置フィルタにも活動時計が掛かる（ADR 0165 決めたこと12、忘れやすい非対称）", () => {
  it("'activity' のテナントで、語彙チャンネルだけを使っても decayFloorSeq を割れば除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "lexical-activity-dead",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計では既に沈んでいる
      }),
    );
    const alive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "lexical-activity-alive",
        content: "gemstone の価格改定メモ",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 100,
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
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });
});

describe("recall() — 非破壊性: RecallRuntimeDeps.tenantSettingsStore を省略しても 'wall' として動く（ADR 0165 決めたこと13）", () => {
  it("tenantSettingsStore を渡さない runRecall() は、activity 列があっても壁時計だけで判定する", async () => {
    const stores = createFakeRuntimeStores();
    const deps: RecallRuntimeDeps = {
      memoryStore: stores.memoryStore,
      vectorStore: stores.vectorStore,
      embeddingProvider: stores.embeddingProvider,
      clock: { now: () => NOW },
      tokenCounter: {
        count: (text: string) => ({ tokens: text.length, counter: "heuristic" as const }),
      },
      // tenantSettingsStore は省略——外部の呼び出し側を壊さないことの歯そのもの。
    };
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "no-tenant-settings-store",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: -1, // 活動時計では沈んでいる値(読まれれば除外されるはず)
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    const result = await runRecall(ctx, { vector: [1, 0], limit: 10 }, deps);

    // tenantSettingsStore が無いので decay_clock は読めず 'wall' 固定——
    // decayFloorAt が遠い未来である限り、decayFloorSeq の値に関わらず生き残る。
    expect(result.memories.map((m) => m.memoryId)).toContain(memory.id);
    const annTrace = result.explain.stages.find(
      (s) => s.stage === "candidate_generation" && s.detail?.["channel"] === "ann",
    );
    expect(annTrace?.detail?.["clock"]).toBe("wall");
  });
});

/**
 * ⭐⭐⭐ いちばん大事な歯（マネージャー指示）: **'activity' 単独で「素通りされ続けた記憶が
 * 速く沈む」ことを示す。** 多忙なテナント（recall() が何度も起きて activity_seq が
 * 速く進む）では、壁時計なら生きている記憶が活動時計では床を割る。
 *
 * `advanceActivityClock`（`NewRecallRecord`、ADR 0165 決めたこと5）は `decay_clock` が
 * `'wall'` 以外のテナントの `recall()` 呼び出しごとに `activity_seq` を+1する
 * ——`FakeMemoryStore.createRecall` と `FakeTenantSettingsStore.getActivitySeq` が
 * 同じ `FakeBackingStore.activitySeq` を共有することで、この歯はスタブを1つも追加せず
 * 本番と同じ配線（`recall-runtime.ts` の `advanceActivityClock: decayClock !== "wall"`）を
 * そのまま通す。
 */
describe("recall() — ⭐ 'activity' 単独で、素通りされ続けた記憶は壁時計より速く沈む（多忙なテナント）", () => {
  /**
   * ⚠ **意図的に語彙チャンネルを使う（ANN ではない）。** `LexicalFilter` は
   * `decayFloorAtAfter`/`decayFloorSeqAfter` のどちらも持たない（マネージャー決定3）ため、
   * 段1の押し下げに助けられる余地が無く、`recall-runtime.ts` の `survivesDecayGate`
   * （後置フィルタそのもの）だけがこの歯を通す。ANN チャンネルだと `FakeVectorStore` が
   * 段1で正しく押し下げてしまい、`survivesDecayGate` を素通りしても歯が気づけない
   * ——実測: `survivesDecayGate` の 'activity' 分岐を壊す変異（`activityAxisAlive` の
   * 代わりに `wallAxisAlive` を返す）を注入したところ、ANN 版のこの歯は**赤くならなかった**
   * （段1の押し下げが先に候補を落としていたため）。この歯は同じ変異で確実に赤くなる。
   */
  it("壁時計なら生きているはずの記憶が、activity_seq の前進（recall の繰り返し）だけで沈む", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");

    // decayBaseSeq=0, decayFloorSeq=3: 3回 recall が起きた時点(nowSeq=3)で
    // `decayFloorSeq(3) > nowSeq(3)` が false になり沈む。壁時計側は FAR_FUTURE で
    // 「何回 recall しても絶対に沈まない」設定にしてある——対比のための対照条件。
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "busy-tenant-target",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 3,
      }),
    );
    const query: RecallQuery = { text: "gemstone", channels: ["lexical"], limit: 10 };

    // 1回目: nowSeq=0 (activity_seq はまだ1回も進んでいない)。3>0 で生存。
    const first = await runtime.recall(ctx, query);
    expect(first.memories.map((m) => m.memoryId)).toContain(target.id);

    // 2回目: nowSeq=1(1回目の recall で+1された)。3>1 で生存。
    const second = await runtime.recall(ctx, query);
    expect(second.memories.map((m) => m.memoryId)).toContain(target.id);

    // 3回目: nowSeq=2。3>2 で、まだぎりぎり生存。
    const third = await runtime.recall(ctx, query);
    expect(third.memories.map((m) => m.memoryId)).toContain(target.id);

    // 4回目: nowSeq=3。3>3 は false——ここで初めて沈む。
    // ⚠ この記憶自身は一度も参照されていない(素通りされ続けている)——4回とも
    // 「別のクエリのついでに候補窓へ入ったが、この記憶自体は使われなかった」を模している。
    const fourth = await runtime.recall(ctx, query);
    expect(fourth.memories.map((m) => m.memoryId)).not.toContain(target.id);
    expect(fourth.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "decayed" }),
    );
  });

  it("対照条件: 同じ4回の recall を 'wall' のテナントに対して行うと、壁時計だけを見るので何回呼んでも沈まない", async () => {
    const { runtime, stores } = buildRuntime();
    // decay_clock を設定しない = 既定 'wall'。decayFloorSeq を割っていても無視される。
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "wall-tenant-target",
        content: "gemstone の在庫確認メモ",
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 3,
      }),
    );
    const query: RecallQuery = { text: "gemstone", channels: ["lexical"], limit: 10 };

    for (let i = 0; i < 4; i += 1) {
      const result = await runtime.recall(ctx, query);
      expect(result.memories.map((m) => m.memoryId)).toContain(target.id);
    }

    // 'wall' のテナントでは activity_seq が1本も進んでいないことも検算する
    // (ADR 0165 決めたこと5「advanceActivityClock は decay_clock != 'wall' のテナントに限る」)。
    expect(await stores.tenantSettingsStore.getActivitySeq(ctx)).toBe(0);
  });
});
