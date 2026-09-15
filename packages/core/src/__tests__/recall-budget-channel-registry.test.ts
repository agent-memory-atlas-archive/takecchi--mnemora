import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `usage.byTier` の「チャンネル登録表」（Issue #306 受け入れ条件2）。
 *
 * **背景**: `docs/recall.md` §6 は「目次帯（`index`）は budget の対象外」
 * （ADR 0008）、`recall-runtime.ts:949` のコメントは「連想枠（`association`、ADR 0151）は
 * budget の内側」と、それぞれ別の場所に書いている。**しかしこの2つを1箇所に集めて
 * 見張る歯は無かった**——新しい出力チャンネルを足す人が、`byTier` にキーを増やしても、
 * それを段4（`recall-runtime.ts` の budget 切り詰めブロック、`allUnits`/`fits()`）の
 * 算入対象に含めるかどうかを決め忘れても、機械的には何も赤くならない。
 *
 * **この歯がすること**: `BUDGET_CHANNEL_REGISTRY` という「表」をこのテストファイル自身が
 * 持つ（`packages/core` 本体には置かない——本体の変更ではなく、検査の側の意見である）。
 *
 * 1. `usage.byTier` に、この表が知らないキーが現れたら赤くなる
 *    （新チャンネルを足した人が、この表を更新して「内側か外側か」を宣言しない限り通らない）。
 * 2. `inside_budget` と宣言したチャンネルのうち、実際に駆動できるもの（`digest`/`association`）
 *    が、きつい予算で実際に落ちることを確認する。
 * 3. `outside_budget` と宣言した `index` が、きつい予算でも変わらないことを確認する。
 *
 * **引き受けた負債**: `full` は `inside_budget` と宣言してあるが、現在の実装は常に `0`
 * （未使用のプレースホルダ、`recall-runtime.ts` の `usage` 構築部）であり、駆動する経路が
 * 無いため「きつい予算で実際に落ちる」ことは検査できない（検査2はスキップしてある。
 * 理由をテスト本体にも明記した）。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 */

type BudgetSide = "inside_budget" | "outside_budget";

/**
 * ⚠ **この表を更新するのはチャンネルを追加した人の責任である。**
 * `usage.byTier` にここに無いキーが現れると、下の歯が赤くなる。
 */
const BUDGET_CHANNEL_REGISTRY: Record<string, BudgetSide> = {
  full: "inside_budget",
  digest: "inside_budget",
  index: "outside_budget",
  association: "inside_budget",
};

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

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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

function assertKnownChannels(byTier: Record<string, unknown>): void {
  for (const key of Object.keys(byTier)) {
    expect(
      key in BUDGET_CHANNEL_REGISTRY,
      `usage.byTier に登録表が知らないキー "${key}" が現れた。` +
        "新しいチャンネルを足したなら、BUDGET_CHANNEL_REGISTRY に " +
        "'inside_budget'/'outside_budget' のどちらかとして追加すること " +
        "（Issue #306, recall-budget-channel-registry.test.ts）。",
    ).toBe(true);
  }
}

describe("recall() — usage.byTier のチャンネル登録表（Issue #306 受け入れ条件2）", () => {
  it("byTier に登録表が知らないキーが現れない（association 無し）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "本文A" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    assertKnownChannels(result.usage.byTier);
  });

  it("byTier に登録表が知らないキーが現れない（association 込み）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0.70710678, 0.70710678], { digest: "アンカー" });
    await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    assertKnownChannels(result.usage.byTier);
    // 前提: このテストが実際に association チャンネルを駆動できていること
    // （駆動できていなければ、上の assertKnownChannels は association キーを
    // 一度も見ないまま素通りする無意味な緑になる）。
    expect(result.usage.byTier.association).toBeGreaterThan(0);
  });

  it("inside_budget と宣言した digest チャンネルは、きつい予算で実際に落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    expect(BUDGET_CHANNEL_REGISTRY.digest).toBe("inside_budget");

    await createEmbeddedMemory(stores, [1, 0], { digest: "AAAAA" }); // 5 chars
    await createEmbeddedMemory(stores, [0.99, 0.1411], { digest: "BBBBB" }); // 5 chars

    const withoutBudget = await runtime.recall(ctx, { vector: [1, 0] });
    const withBudget = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 5 },
    });

    expect(withoutBudget.usage.byTier.digest).toBe(10);
    expect(withBudget.usage.byTier.digest).toBeLessThan(withoutBudget.usage.byTier.digest);
    expect(withBudget.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  it("inside_budget と宣言した association チャンネルは、きつい予算で実際に落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    expect(BUDGET_CHANNEL_REGISTRY.association).toBe("inside_budget");

    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "AAAAA", // 5 chars
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], {
      digest: "BBBBB", // 5 chars
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
      budget: { maxMemoryChars: 5 }, // アンカー分だけは入るが、連想分は入らない
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(anchor.id);
    expect(memoryIds).not.toContain(associated.id);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  it("引き受けた負債: inside_budget と宣言した full チャンネルは、常に0で駆動する経路が無い", () => {
    // full は現在の実装では usage.byTier.full が常に 0（recall-runtime.ts のプレースホルダ）
    // であり、「きつい予算で実際に落ちる」ことを検査できる入力を作れない。この歯は
    // その事実そのものを記録する（検査していないことを、検査していないと書く）。
    expect(BUDGET_CHANNEL_REGISTRY.full).toBe("inside_budget");
  });

  /**
   * ⚠ **`index` の「予算の対象外」は「1バイトも変わらない」という意味ではない**——
   * これは書いてみて初めて分かった、この歯を書く過程での発見である。
   *
   * `docs/recall.md` §5 の被覆不変条件は「群カウントの総和 == スコープ内の総数」であり、
   * **段4（budget）で落ちた候補は `memories` から外れるぶん、目次帯（第3階の群カウント・
   * digest 帯）側の対象に回る**（§5「乗るのは、スコープには入ったが段1〜4のどこかで
   * (索引未整備・閾値・件数超過・予算のいずれかで)落ちたものだけである」）。
   * ⟹ **budget を締めると、`memories` から押し出された分だけ `index`（digest 帯）の
   * 内容量はむしろ増えうる。**「変わらない」ものは、そこではない。
   *
   * **「予算の対象外」が実際に意味する不変条件**は、段0で確定する `scope`
   * （`aggregateScope` が返す `totalInScope`/`groups`）が、**段4（budget）より手前で
   * 決まり、budget の値を一切参照しない**ことである——`totalInScope`/`groups` は
   * budget をどれだけ締めても変わらない。これが「recall が0件でも、何が在るかは
   * 言える」という保証の実体であり、`RecallBudget` の doc が「目次帯は budget を
   * どれだけ小さくしても削られない」と言っているのはこの意味である。
   */
  it("outside_budget と宣言した index の第3階（groups/totalInScope）は、きつい予算でも変わらない（docs/recall.md §5・§6）", async () => {
    const { runtime, stores } = buildRuntime();
    expect(BUDGET_CHANNEL_REGISTRY.index).toBe("outside_budget");

    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { digest: `候補${i}` });
    }

    const withoutBudget = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const withBudget = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 1 }, // ほぼ全件を memories から押し出すほど厳しい
    });

    // 前提: budget が実際に何かを押し出していること（押し出していなければ、以下の
    // 「それでも変わらない」は budget が何もしていない無意味な緑になる）。
    expect(withBudget.omitted.some((o) => o.kind === "budget_dropped")).toBe(true);
    expect(withBudget.memories.length).toBeLessThan(withoutBudget.memories.length);

    expect(withBudget.index.totalInScope).toBe(withoutBudget.index.totalInScope);
    expect(withBudget.index.groups).toEqual(withoutBudget.index.groups);
  });
});
