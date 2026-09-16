import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, RecallQuery } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 連想枠（段3.5、ADR 0151）にも忘却ゲート（ADR 0153 / ADR 0165）と `validAt` ゲート
 * （ADR 0164）が掛かることを、**本物の Postgres + pgvector** に対して実測する
 * （Issue #347 / ADR 0172）。
 *
 * ⭐ **なぜユニットの歯（`packages/core` の `recall-association-gates.test.ts`）だけでは
 * 足りないか。** あちらは `FakeVectorStore`（`VectorFilter` の各欄を自前で適用する擬似物）
 * に対する歯であり、`PostgresVectorStore` が**連想枠の呼び出しでも**
 * `decayFloorAtAfter`/`decayFloorSeqAfter`/`decayFloorAnyAxis` を実際に SQL へ効かせる
 * ことは、2つを繋いだ経路として一度も走っていなかった。
 * **連想枠は PR #336 以降 `examples/chat` の既定経路である**——出荷物の既定の道が
 * 実 Postgres で測られていない状態を残さない。
 *
 * ⚠ **`recall-decay-cross-day.postgres.test.ts` には足さない**（そちらは Issue #302 の
 * 北極星 項目1 の歯であり、別の作業（Issue #329）が同じファイルを触っている）。
 *
 * ## 配置（連想枠でしか届かない三角形）
 *
 * - クエリ `Q = [1,0,0]`
 * - アンカー `A = [0.70710678,0.70710678,0]` — `cos(Q,A) ≈ 0.7071` ⟹ 段1で拾われ、
 *   連想のアンカーになる
 * - 相方 `B = [0,1,0]` — **`cos(Q,B) = 0` ちょうど**（段1では below_threshold に落ち、
 *   `withinLimit` に入らない）だが `cos(A,B) ≈ 0.7071`（既定 `minSimilarity` 0.5 以上）
 *
 * ⟹ **`B` が `result.memories` に現れたら、それは段3.5 を通ったということ**である
 * （`retrievedVia: 'association'` と `associationOf` でも検算する）。
 *
 * ⚠ 段3.5 の候補は段2の閾値分割（`scoreThreshold`）を通らない——`recall-runtime.ts` が
 * `associationUnits` を `units` の**後ろに連結**するのは閾値の後である。⟹
 * `recall-decay-cross-day.postgres.test.ts` の `(乙)` が必要とした `scoreThreshold: 0`
 * は、この歯では要らない（ゲートを外せば `B` はそのまま連想枠から返る）。
 */

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by association gate tests");
  },
  completeStructured: async () => {
    throw new Error("not used by association gate tests");
  },
};

/** クエリ・アンカー・相方の三角形（上の doc コメント参照）。 */
const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.70710678, 0.70710678, 0];
const ASSOCIATED_VECTOR = [0, 1, 0];

/**
 * `buildNewMemoryFixture` の既定 `recordedAt`（2026-01-01）に時計を固定する
 * （`recall.postgres.test.ts` の `buildTestRuntime` と同じ理由——実時計のままだと
 * 段2の decay でアンカー自身が below_threshold に化ける）。
 */
const NOW = new Date("2026-01-01T00:00:00.000Z");
/** +100年。壁時計では絶対に沈まない。 */
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);

async function buildTestRuntime() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
  const runtime = createRuntime({
    memoryStore,
    // observe()/tick() は使わない（`createMemory` + `vectorStore.upsert` で直接置く）。
    outboxStore: {
      claimBatch: async () => [],
      complete: async () => {},
      fail: async () => {},
    },
    vectorStore,
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore,
    llmProvider: throwingLlm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      // `RecallQuery.vector` を直接渡すので embed は呼ばれない。
      embed: async () => {
        throw new Error("この歯は RecallQuery.vector を直接渡すので embed を呼ばないはず");
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, memoryStore, vectorStore, tenantSettingsStore };
}

async function createEmbeddedMemory(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  vector: number[],
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      embeddingStatus: "ready",
      contentHash: `hash-${randomUUID()}`,
      ...overrides,
    }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

/** アンカーと、連想でしか届かない相方を1組置く。 */
async function seedAnchorAndAssociated(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  associatedOverrides: Parameters<typeof buildNewMemoryFixture>[0],
  anchorOverrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  const anchor = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ANCHOR_VECTOR, {
    digest: "アンカー本文",
    decayFloorAt: FAR_FUTURE,
    ...anchorOverrides,
  });
  const associated = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ASSOCIATED_VECTOR, {
    digest: "連想本文",
    ...associatedOverrides,
  });
  return { anchor, associated };
}

const ASSOCIATION_QUERY: RecallQuery = {
  vector: QUERY_VECTOR,
  limit: 10,
  association: { maxCount: 5, anchorCount: 1 },
};

describe("runtime.recall() の連想枠に忘却ゲートが掛かる — 本物の Postgres + pgvector（Issue #347）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("対照（この配置が本当に段3.5 を通ることの検算）: 沈んでいない記憶は、連想枠から返る", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-alive-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE,
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    const anchorEntry = result.memories.find((m) => m.memoryId === anchor.id);
    expect(anchorEntry?.retrievedVia).toBe("ann");
    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(甲) 完全に減衰しきった記憶は、連想枠からも返らない（既定のゲート）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-decayed-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      // 「いま」（固定時計）の1秒前に沈んでいる。狭義の `>` なのでゲートに掛かる。
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    // アンカー自身は返る——「連想枠が丸ごと走らなかったから返らなかった」ではない。
    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
  });

  it("(乙) includeFullyDecayed: true を渡すと、実 adapter 経路でも連想枠から返る（opt-out）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-optout-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, { ...ASSOCIATION_QUERY, includeFullyDecayed: true });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
    // ⚠ `recall-decay-cross-day.postgres.test.ts` の (乙) が必要とした `scoreThreshold: 0` を
    // ここでは渡していない——段3.5 の候補は段2の閾値分割を通らないためである
    // （ファイル冒頭の doc コメント参照）。この非対称自体が、この歯が測っている経路が
    // 段1ではなく段3.5 であることの証拠でもある。
  });

  it("(丙) 'activity' のテナントでは、壁時計が遠い未来でも decay_floor_seq を割った記憶は連想枠から返らない（ADR 0165 の2軸目）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-activity-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore, tenantSettingsStore } = await buildTestRuntime();
    await tenantSettingsStore.setDecayClock(ctx, "activity");
    // 新しいテナントの activity_seq は 0（`getActivitySeq` の既定）。
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);

    const { anchor, associated } = await seedAnchorAndAssociated(
      memoryStore,
      vectorStore,
      ctx,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない——活動時計の軸だけが落とせる
        decayBaseSeq: 0,
        decayFloorSeq: 0, // nowSeq(=0) ちょうど。狭義の `>` が効かず沈んでいる
      },
      // アンカーは活動時計の床を持たない（NULL = この軸には床が無い、ADR 0165 決めたこと4）。
      { decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("(戊) 期限切れ（valid_until が過去）の記憶は、連想枠からも返らない（validAt ゲート、Issue #280 / ADR 0164）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-expired-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE, // 忘却ゲートでは落ちない——validAt ゲートだけが落とせる
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("(己) includeOutsideValidity: true を渡すと、実 adapter 経路でも連想枠から返る（opt-out）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-validity-optout-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE,
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      ...ASSOCIATION_QUERY,
      includeOutsideValidity: true,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(丁) 対照: 同じ記憶を 'wall'（既定）のテナントで引くと、活動時計の床は無視され連想枠から返る", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-wall-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    // decay_clock を設定しない = 既定 'wall'。
    const { associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 0,
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });
});
