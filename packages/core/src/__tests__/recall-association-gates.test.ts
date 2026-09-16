import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 連想枠（段3.5、ADR 0151）にも忘却ゲート（ADR 0153 / ADR 0165）と `validAt` ゲート
 * （Issue #280 / ADR 0164）が掛かることの歯（Issue #347 / ADR 0172）。
 *
 * 🔴 **この歯が測るのは、段3.5 だけが両ゲートをすり抜けていた穴そのものである。**
 * 段1（`recall-decay-gate.test.ts` / `recall-validity.test.ts`）は同じ境界を既に測っているが、
 * **そこは段1の候補（`candidates`）だけを回る**——連想候補は一度も通らなかった。
 *
 * ⭕ `status`（`superseded` を返さない）は Issue #347 の時点でも壊れていなかった。
 * 下の「回帰」節がそれを固定する——**直したことではなく、壊していないこと**の歯である。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。DB も要らない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
/** +100年。壁時計では絶対に沈まない（`recall-decay-gate.test.ts` と同じ道具立て）。 */
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);

/** Q=[1,0] に対して類似度 0.7071——段1で拾われ、連想のアンカーになる。 */
const ANCHOR_VECTOR = [0.70710678, 0.70710678];
/**
 * Q=[1,0] との類似度は 0 ちょうど（段1では below_threshold）だが、アンカーとの類似度は
 * 0.7071（既定 minSimilarity 0.5 以上）——**連想枠でしか返ってこない**位置。
 * ⟹ この記憶が結果に現れたら、それは段3.5 を通ったということである。
 */
const ASSOCIATED_VECTOR = [0, 1];

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

function buildRuntime(
  overrideVectorStore?: (stores: ReturnType<typeof createFakeRuntimeStores>) => VectorStore,
) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: overrideVectorStore ? overrideVectorStore(stores) : stores.vectorStore,
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

/** 段1のアンカーと、連想でしか届かない相方を1組置く。 */
async function seedAnchorAndAssociated(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  associatedOverrides: Partial<NewMemory>,
  anchorOverrides: Partial<NewMemory> = {},
): Promise<{ anchor: Memory; associated: Memory }> {
  const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, {
    digest: "アンカー本文",
    ...anchorOverrides,
  });
  const associated = await createEmbeddedMemory(stores, ASSOCIATED_VECTOR, {
    digest: "連想本文",
    ...associatedOverrides,
  });
  return { anchor, associated };
}

function captureFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const captured: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (c, space, query, opts) => {
    captured.push(opts.filter);
    return originalSearch(c, space, query, opts);
  };
  return captured;
}

const ASSOCIATION = { maxCount: 5, anchorCount: 1 } as const;

// ---------------------------------------------------------------------------
// 配線の歯: 連想用 search() の filter が、段1の ANN と同じゲートの欄を持つ。
// ---------------------------------------------------------------------------

describe("recall() — 連想用 search() の filter が段1の ANN と同じゲート欄を持つ（配線の歯、Issue #347）", () => {
  it("段1と段3.5の filter の decayFloorAtAfter / decayFloorSeqAfter / decayFloorAnyAxis / validAt が一致する", async () => {
    const { runtime, stores } = buildRuntime();
    await seedAnchorAndAssociated(stores, {});
    const filters = captureFilters(stores);

    await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: ASSOCIATION });

    // 1本目が段1の ANN、2本目が段3.5（アンカー1つぶん）。
    expect(filters).toHaveLength(2);
    const [stage1, association] = filters;
    expect(association?.decayFloorAtAfter).toEqual(stage1?.decayFloorAtAfter);
    expect(association?.decayFloorSeqAfter).toEqual(stage1?.decayFloorSeqAfter);
    expect(association?.decayFloorAnyAxis).toEqual(stage1?.decayFloorAnyAxis);
    expect(association?.validAt).toEqual(stage1?.validAt);
    // 既定では実際に「いま」が載っている（両方 undefined で一致、を通してしまわないため）。
    expect(association?.decayFloorAtAfter).toEqual(NOW);
    expect(association?.validAt).toEqual(NOW);
  });

  it("includeFullyDecayed / includeOutsideValidity を渡すと、連想用 filter でもゲートが外れる", async () => {
    const { runtime, stores } = buildRuntime();
    await seedAnchorAndAssociated(stores, {});
    const filters = captureFilters(stores);

    await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeFullyDecayed: true,
      includeOutsideValidity: true,
    });

    expect(filters).toHaveLength(2);
    expect(filters[1]?.decayFloorAtAfter).toBeUndefined();
    expect(filters[1]?.decayFloorSeqAfter).toBeUndefined();
    expect(filters[1]?.decayFloorAnyAxis).toBe(false);
    expect(filters[1]?.validAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 忘却ゲート（ADR 0153）。
// ---------------------------------------------------------------------------

describe("recall() — 連想枠に忘却ゲートが掛かる（Issue #347）", () => {
  it("完全に減衰しきった記憶は、連想枠からも返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: new Date(NOW.getTime() - 1_000), // 1秒前に沈んでいる
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
  });

  it("対照: 同じ配置で沈んでいなければ、連想枠から返る（歯が「連想が常に空」で通っていないことの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: FAR_FUTURE,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("includeFullyDecayed: true を渡すと、連想枠でも減衰しきったものが返る（opt-out は連想枠でも尊重される）", async () => {
    const { runtime, stores } = buildRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeFullyDecayed: true,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });
});

// ---------------------------------------------------------------------------
// 活動時計（ADR 0165）。⚠ 忘れやすい非対称——壁時計だけを見る述語を書くと、ここが赤くなる。
// ---------------------------------------------------------------------------

describe("recall() — 連想枠の忘却ゲートが活動時計の軸も見る（ADR 0165 決めたこと12、Issue #347）", () => {
  it("'activity' のテナントでは、壁時計が遠い未来でも decayFloorSeq を割った記憶は連想枠から返らない", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない
        decayBaseSeq: 0,
        decayFloorSeq: 0, // nowSeq(=0) ちょうど。狭義の `>` が効かず沈んでいる
      },
      { decayFloorAt: FAR_FUTURE, decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("対照: 同じ記憶を 'wall' のテナントで引くと、活動時計の床は無視され連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    // decay_clock を設定しない = 既定 'wall'。
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE,
        decayBaseSeq: 0,
        decayFloorSeq: 0,
      },
      { decayFloorAt: FAR_FUTURE },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });

  it("'either' は OR（最も緩い）: 活動時計は沈んでいても壁時計が生きていれば連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計は生きている
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計は沈んでいる
      },
      { decayFloorAt: FAR_FUTURE, decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });
});

// ---------------------------------------------------------------------------
// validAt ゲート（Issue #280 / ADR 0164）。
// ---------------------------------------------------------------------------

describe("recall() — 連想枠に validAt ゲートが掛かる（Issue #347）", () => {
  it("期限切れ（validUntil が過去）の記憶は、連想枠からも返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, {
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    // `expired` の件数は `aggregateScope` が出す（段3.5 で数え直さない。Issue #347 では
    // omitted の数え方を1バイトも変えていない）。
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "expired", count: 1 }),
    );
  });

  it("未発効（validFrom が未来）の記憶は、連想枠からも返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, {
      validFrom: new Date(NOW.getTime() + 1_000 * 60 * 60 * 24),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "not_yet_valid", count: 1 }),
    );
  });

  it("includeOutsideValidity: true を渡すと、連想枠でも期限切れの記憶が返る（opt-out）", async () => {
    const { runtime, stores } = buildRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(stores, {
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeOutsideValidity: true,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("過去の validAt を指定すると、その時点で真だった（いまは期限切れの）記憶が連想枠から返る", async () => {
    const { runtime, stores } = buildRuntime();
    const expiredAt = new Date(NOW.getTime() - 1_000 * 60 * 60 * 24); // 1日前に失効
    const { associated } = await seedAnchorAndAssociated(stores, { validUntil: expiredAt });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      validAt: new Date(expiredAt.getTime() - 1_000), // まだ真だった時刻
    });

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });
});

// ---------------------------------------------------------------------------
// ⭕ 回帰: status ゲートは Issue #347 の時点でも効いていた。壊していないことの検算。
// ---------------------------------------------------------------------------

describe("recall() — 連想枠から superseded は引き続き返らない（回帰、Issue #347 で壊していないこと）", () => {
  it("status='superseded' の記憶は、連想の近傍に居ても返らない", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, { status: "superseded" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "superseded", count: 1 }),
    );
  });

  it("includeFullyDecayed: true を渡しても superseded は返らない（ゲートの軸が別であることの検算）", async () => {
    const { runtime, stores } = buildRuntime();
    const { associated } = await seedAnchorAndAssociated(stores, { status: "superseded" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
      includeFullyDecayed: true,
      includeOutsideValidity: true,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });
});

// ---------------------------------------------------------------------------
// ⭐⭐ 多層防御: 押し下げと後置が同じ述語であることの検算（ADR 0153 決めたこと3 と同型）。
//
// `AssociationGateStrippingVectorStore` は **2本目以降の search()**（= 連想用の呼び出し）
// からだけゲートの欄を剥がす——段1（1本目）の押し下げはそのまま効かせる。⟹ 段1の候補集合には
// 何も混ざらず、**連想用 search() だけが契約を破った**状況を歯の中だけで再現できる。
// 本番コードは1文字も変えない（`DecayFloorAtAfterStrippingVectorStore` と同じ手口）。
// ---------------------------------------------------------------------------

class AssociationGateStrippingVectorStore implements VectorStore {
  private searchCount = 0;

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

  getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: Parameters<NonNullable<VectorStore["getVectors"]>>[2],
  ): ReturnType<NonNullable<VectorStore["getVectors"]>> {
    if (this.inner.getVectors === undefined) {
      throw new Error("inner VectorStore lacks getVectors");
    }
    return this.inner.getVectors(ctx, space, memoryIds);
  }

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    this.searchCount += 1;
    if (this.searchCount === 1) {
      return this.inner.search(ctx, space, query, opts);
    }
    const {
      decayFloorAtAfter: _a,
      decayFloorSeqAfter: _b,
      decayFloorAnyAxis: _c,
      validAt: _d,
      ...stripped
    } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: stripped });
  }
}

describe("recall() — 連想用 adapter がゲートを無視しても、後置フィルタが同じ述語で拾う（Issue #347）", () => {
  it("減衰しきった記憶は、連想用 search() がゲートを剥がしても返らない", async () => {
    const { runtime, stores } = buildRuntime(
      (s) => new AssociationGateStrippingVectorStore(s.vectorStore),
    );
    const { associated } = await seedAnchorAndAssociated(stores, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    // 🔴 **二重計上しないことの歯**（Issue #347 / ADR 0172 決めたこと3 を、Issue #329 /
    // ADR 0173 の後の形に読み替えたもの）。
    //
    // ⚠ **この行は 2026-09-16 に反転している。**ADR 0172 当時は
    // `not.toContainEqual({condition:"decayed"})` だった——「連想枠の後置で落ちた分は
    // `filtered(decayed)` に載らない」を固定していた。その根拠として当時のコメントが
    // 挙げていたのは「段1の押し下げで落ちた分を数えないのと同じ扱いであり、**Issue #329 の
    // 対応と数え方を混ぜないため**」であり、**#329 を名指しで待っている歯だった。**
    // ⟹ ADR 0173 が段5の `aggregateScope` で厳密に数えるようにした以上、
    // 「載らない」はもう実態ではない。**ADR 0172 の主張（連想枠の後置は件数を足さない）は
    // 1ミリも変わっていない**——変わったのは、別の場所（段5）が数え始めたことである。
    //
    // ⛔ **弱めていない。**`not.toContainEqual` を消したのではなく、
    // **`count` がちょうど 1 であること**を固定した。この scope に減衰しきった Memory は
    // `associated` の1件しか無いので、もし連想枠の後置（または段1の後置）が
    // 集約とは別に足し込んでいたら **2 になる。**⟹ この行は
    // **「数えるのは段5の1箇所だけ」の検算**であり、ADR 0172 が守りたかったものを
    // より強く守る。
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: "within_scope",
      count: 1,
      countKind: "exact",
    });
  });

  /**
   * ⚠ **この歯だけが、連想枠の後置で活動時計の軸を忘れる変異を捕まえる。**
   * 【実測】`survivesDecayGate` の代わりに `wallAxisAlive` を呼ぶ変異を入れると、
   * 押し下げが効いている通常の配線では **16本すべてが緑のまま**だった——連想用 `search()` の
   * 押し下げが先に候補を落としてしまうためである。ゲートを剥がしたこの配置でだけ、
   * 後置の述語そのものが露出する（`recall-decay-gate.test.ts` の語彙チャンネルの歯と同型の理屈）。
   */
  it("'activity' のテナントで、連想用 search() がゲートを剥がしても活動時計で沈んだ記憶は返らない", async () => {
    const { runtime, stores } = buildRuntime(
      (s) => new AssociationGateStrippingVectorStore(s.vectorStore),
    );
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const { associated } = await seedAnchorAndAssociated(
      stores,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない——活動時計の軸だけが落とせる
        decayBaseSeq: 0,
        decayFloorSeq: 0,
      },
      { decayFloorAt: FAR_FUTURE, decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("期限切れの記憶も、連想用 search() がゲートを剥がしても返らない", async () => {
    const { runtime, stores } = buildRuntime(
      (s) => new AssociationGateStrippingVectorStore(s.vectorStore),
    );
    const { associated } = await seedAnchorAndAssociated(stores, {
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: ASSOCIATION,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });
});
