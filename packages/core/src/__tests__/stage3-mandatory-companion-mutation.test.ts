import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * この歯が測っているもの: `recall-runtime.ts` 段3「矛盾の解決と必須の同伴取得」
 * （`contradiction_resolution`。`retrievedVia: "mandatory_companion"` の箇所、
 * recall-runtime.ts 616〜663行付近）は、`Runtime.markContested`（Issue #197 /
 * ADR 0134）が入るまで**一度も発火しない死んだ分岐**だった。
 * `mark-contested.test.ts` 末尾の「recall() の段3が実際に発火する」歯は、
 * その分岐が**通ったこと**は示すが、**通らなくなったら赤くなること**は示していない
 * ——歯が「たまたま今日は緑」なのか「壊れたら本当に落ちる」のかは、
 * その歯だけを読んでも区別できない。
 *
 * ここでは、あの歯が実際に立てている assert 群（下の `originalAssertions`。
 * `mark-contested.test.ts` の該当箇所と**式を一字一句揃えてある**）を、
 * 段3が壊れた3つの世界（変異体）にぶつけ、「実際に赤くなる」ことを
 * `expect(() => 元のassert()).toThrow()` の形で直接検算する。
 *
 * **なぜ本番コードを壊す形の変異試験にしなかったか**: `docs/autonomy.md` の
 * 「してはいけないこと」・本タスクの依頼が明示するとおり、`recall-runtime.ts` を
 * 含む本番コードから歯止めを外す変更は、機構そのものを外す行為と区別が付かない
 * （このリポジトリでは「安全装置を外す」形の変異は禁じ手であり、機構に止められる）。
 * ⟹ 変異は**すべてテスト側で `MemoryStore` を包む Proxy**として作る——
 * `recall-runtime.ts` が実際に呼ぶ `memoryStore.get`/`getMany` の**戻り値**だけを
 * すり替え、段3のコード自体は1バイトも触らない。「対向を取りに行った先の店が
 * 嘘を返す」という、本番でも実際に起こりうる形（adapter のバグ・Runtime を経由しない
 * 直接の書き込み。段3コメント714行目が既に「Runtime を経由しない MemoryStore の
 * 直接操作」を通る条件として明記している）に対応する。
 *
 * companionsAdded（段3が自分で出している観測点。`stage.detail.companionsAdded`）を
 * 読むだけで到達を数える——このテストファイルの中に「段3が発火したかどうか」を
 * 判定する述語を書き写さない。
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

/** `mark-contested.test.ts` の `buildRuntime` と同じ形（このファイル限りで独立させてある）。 */
function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

/**
 * `base`（本物のフェイク実装）を Proxy で包み、`overrides` に挙げたメソッドだけ
 * すり替える。挙げなかったメソッドは `base` へそのまま委譲する（`this` 束縛も保つ）。
 * **`recall-runtime.ts` を含む本番コードには一切触れない**——ここで差し替えるのは
 * 「段3が呼ぶ store の戻り値」だけである。
 */
function wrapMemoryStore(base: MemoryStore, overrides: Partial<MemoryStore>): MemoryStore {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) {
        return (overrides as Record<string, unknown>)[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryStore;
}

/**
 * `mark-contested.test.ts`「recall() の段3が実際に発火する」歯が立てている assert 群を、
 * **式を変えずに**ここへ複製したもの。「複製した述語」ではなく「複製した assert」——
 * 判定ロジックを書き直したのではなく、同じ式をもう一度評価できる形（サンク）にしてある。
 * これを `expect(() => assertion()).toThrow()` に通すことで、「その世界ではこの assert が
 * 実際に落ちる」ことを検算する。
 *
 * ⚠ Issue #293（このファイル自身の「測ったこと」節が見つけた盲点）で `adjacency` の式を
 * 更新した。`indexOf` は見つからないとき `-1` を返すため、旧式
 * `Math.abs(indexStrong - indexWeak) === 1` は片方が完全に不在の世界（変異体C）で
 * `Math.abs(0 - (-1)) === 1` が偶然成立し、緑のままだった——`mark-contested.test.ts` 側も
 * 同じ式に更新済みなので、**両ファイルは今も同じ式を共有している**（「式を変えずに複製」
 * という前提そのものは崩れていない。崩れたのは mark-contested.test.ts 側の元の式であり、
 * それをここへ揃え直した）。
 */
function originalAssertions(result: RecallResult, strongId: MemoryId, weakId: MemoryId) {
  const ids = result.memories.map((m) => m.memoryId);
  const companion = result.memories.find((m) => m.memoryId === weakId);
  const indexStrong = ids.indexOf(strongId);
  const indexWeak = ids.indexOf(weakId);
  const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
  return {
    strongPresent: () => expect(ids).toContain(strongId),
    weakPresent: () => expect(ids).toContain(weakId),
    companionRetrievedVia: () => expect(companion?.retrievedVia).toBe("mandatory_companion"),
    companionOf: () => expect(companion?.companionOf).toBe(strongId),
    adjacency: () => {
      expect(indexStrong).toBeGreaterThanOrEqual(0);
      expect(indexWeak).toBeGreaterThanOrEqual(0);
      expect(Math.abs(indexStrong - indexWeak)).toBe(1);
    },
    stageExecuted: () => expect(stage?.executed).toBe(true),
    stageDetail: () => expect(stage?.detail).toEqual({ companionsAdded: 1 }),
  };
}
type AssertionKey = keyof ReturnType<typeof originalAssertions>;
const ALL_ASSERTION_KEYS: AssertionKey[] = [
  "strongPresent",
  "weakPresent",
  "companionRetrievedVia",
  "companionOf",
  "adjacency",
  "stageExecuted",
  "stageDetail",
];

/** strong/weak の2件を作り、markContested で結び、`recall({ vector: [1,0], limit: 1 })` を1回走らせる下ごしらえ。 */
async function setupContestedPair(
  mutateStore?: (base: MemoryStore, ids: { strongId: MemoryId; weakId: MemoryId }) => MemoryStore,
) {
  const { runtime, stores } = buildRuntime();
  const strong = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ digest: "強い方", embeddingStatus: "ready" }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, strong.id, [1, 0]);
  // わざとクエリベクトルから離す——スコアだけなら選ばれない側。
  const weak = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ digest: "弱い方", embeddingStatus: "ready" }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, weak.id, [0, 1]);

  const markResult = await runtime.markContested(ctx, strong.id, weak.id);
  expect(markResult.outcome.kind).toBe("contested");

  const recallRuntime =
    mutateStore === undefined
      ? runtime
      : createRuntime({
          memoryStore: mutateStore(stores.memoryStore, { strongId: strong.id, weakId: weak.id }),
          outboxStore: stores.outboxStore,
          vectorStore: stores.vectorStore,
          eventStore: stores.eventStore,
          tenantSettingsStore: stores.tenantSettingsStore,
          llmProvider: notUsedLlm,
          embeddingProvider: stores.embeddingProvider,
          hashContent: (content: string) => `sha256(${content})`,
          clock: { now: () => NOW },
        });

  const result = await recallRuntime.recall(ctx, { vector: [1, 0], limit: 1 });
  return { result, strongId: strong.id, weakId: weak.id, stores };
}

describe("段3「必須の同伴取得」— 対照（変異なし）", () => {
  it("`originalAssertions` は mark-contested.test.ts と同じ式である: 変異していない世界では1つも赤くならない", async () => {
    const { result, strongId, weakId } = await setupContestedPair();
    const assertions = originalAssertions(result, strongId, weakId);
    for (const key of ALL_ASSERTION_KEYS) {
      expect(assertions[key]).not.toThrow();
    }
    // 到達の数え方そのもの: companionsAdded は段3が自分で出している値をそのまま読む。
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.detail).toEqual({ companionsAdded: 1 });
  });
});

type MutantCase = {
  name: string;
  breaks: string;
  expectedBreak: string;
  mutate: (base: MemoryStore, ids: { strongId: MemoryId; weakId: MemoryId }) => MemoryStore;
  expectCompanionsAdded: number;
  expectUnitAssemblyDropped: boolean;
  expectRed: AssertionKey[];
};

const mutants: MutantCase[] = [
  {
    name: "A: 同伴取得(getMany)を空配列にすり替える",
    breaks:
      "recall-runtime.ts 634〜657行目: companionIds を引いた直後の " +
      "`deps.memoryStore.getMany(ctx, companionIds)` の戻り値",
    expectedBreak:
      "companionsAdded=0。weak だけでなく、対向を得られない strong も " +
      "ADR 0136 の経路（companion が見つからない contested は単位を組まず落とす）に落ち、" +
      "両方とも recall の結果から消える。unit_assembly_dropped が立つ。",
    mutate: (base, { weakId }) =>
      wrapMemoryStore(base, {
        getMany: async (c, requestedIds) => {
          // 段3の同伴取得だけを狙い撃つ: その呼び出しは「対向1件だけ」を要求する形を取る
          // （recall-runtime.ts 636行目 `deps.memoryStore.getMany(ctx, companionIds)`）。
          // 段1の候補実体取得（複数件、strong を含む）はここでは対象にしない。
          const isCompanionFetch = requestedIds.length === 1 && requestedIds[0] === weakId;
          if (isCompanionFetch) return [];
          return base.getMany(c, requestedIds);
        },
      }),
    expectCompanionsAdded: 0,
    expectUnitAssemblyDropped: true,
    expectRed: [
      "strongPresent",
      "weakPresent",
      "companionRetrievedVia",
      "companionOf",
      "adjacency",
      "stageDetail",
    ],
  },
  {
    name: "B: 相互参照を片方向にする（strong.contestedWithId を null に見せかける）",
    breaks:
      "recall-runtime.ts 619〜625行目: `contestedNeedingCompanion` が読む " +
      "`c.memory.contestedWithId`（get/getMany が返す strong の中身そのもの）",
    expectedBreak:
      "companionsAdded=0。`contestedWithId` が偽になるので companionIds が空になり、" +
      "`memoryStore.getMany` は同伴取得のために一度も呼ばれない" +
      "（A とは違い、取得を試みることさえしない）。strong は ADR 0136 の経路で単位を組まず落ち、" +
      "unit_assembly_dropped が立つ。",
    mutate: (base, { strongId }) =>
      wrapMemoryStore(base, {
        get: async (c, id) => {
          const memory = await base.get(c, id);
          return memory && memory.id === strongId ? { ...memory, contestedWithId: null } : memory;
        },
        getMany: async (c, ids) => {
          const memories = await base.getMany(c, ids);
          return memories.map((m) => (m.id === strongId ? { ...m, contestedWithId: null } : m));
        },
      }),
    expectCompanionsAdded: 0,
    expectUnitAssemblyDropped: true,
    expectRed: [
      "strongPresent",
      "weakPresent",
      "companionRetrievedVia",
      "companionOf",
      "adjacency",
      "stageDetail",
    ],
  },
  {
    name: "C: 隣接そのものは崩せなかったので代わりに段3の入口条件を外す（status を active に見せかける）",
    breaks:
      "recall-runtime.ts 620〜625行目: `contestedNeedingCompanion` が読む " +
      "`c.memory.status === 'contested'`（get/getMany が返す strong の中身そのもの）",
    expectedBreak:
      "companionsAdded=0。status が偽の 'active' に見えるので、段3の入口条件そのものが " +
      "外れる——ADR 0136 の『単独 contested を落とす』分岐にも入らない " +
      "（そちらは status==='contested' を要求するが、ここではそれも偽装しているため）。" +
      "⟹ strong は単独ユニットとして生き残り、weak だけが**何の omission も立てずに**消える。" +
      "A/B（unit_assembly_dropped が立つ）より静かに壊れる、という違いがある。" +
      "⚠ Issue #293: `adjacency` は `indexWeak === -1`（weak 不在）のときも " +
      "`Math.abs(indexStrong - (-1)) === 1` が偶然成立しうるため、**この変異体Cでだけ** " +
      "旧assertは緑のままだった——`indexStrong`/`indexWeak` それぞれが `>= 0`（=実際に" +
      "結果に含まれる）ことを先に assert する形へ直した（`originalAssertions.adjacency` " +
      "参照）ことで、ここでも赤くなる。",
    mutate: (base, { strongId }) =>
      wrapMemoryStore(base, {
        get: async (c, id) => {
          const memory = await base.get(c, id);
          return memory && memory.id === strongId ? { ...memory, status: "active" } : memory;
        },
        getMany: async (c, ids) => {
          const memories = await base.getMany(c, ids);
          return memories.map((m) => (m.id === strongId ? { ...m, status: "active" } : m));
        },
      }),
    expectCompanionsAdded: 0,
    expectUnitAssemblyDropped: false,
    expectRed: ["weakPresent", "companionRetrievedVia", "companionOf", "stageDetail", "adjacency"],
  },
];

describe.each(mutants)(
  "段3「必須の同伴取得」— 変異体 $name",
  ({
    breaks,
    expectedBreak,
    mutate,
    expectCompanionsAdded,
    expectUnitAssemblyDropped,
    expectRed,
  }) => {
    it(`壊す場所: ${breaks} / 期待される壊れ方: ${expectedBreak}`, async () => {
      const { result, strongId, weakId } = await setupContestedPair(mutate);

      // 到達の数え方: 段3が自分で出している companionsAdded をそのまま読む
      // （テスト側に「同伴が取れたか」の判定を書き写さない）。
      const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
      expect(stage?.detail).toEqual({ companionsAdded: expectCompanionsAdded });
      // stage 自体は常に executed: true を名乗る（recall-runtime.ts 661行目、companions.length に
      // 関わらず固定値）——これは段3が壊れているかどうかの区別に使えない項目である。
      expect(stage?.executed).toBe(true);

      const hasUnitAssemblyDropped = result.omitted.some((o) => o.kind === "unit_assembly_dropped");
      expect(hasUnitAssemblyDropped).toBe(expectUnitAssemblyDropped);

      // ⭐ 歯が実際に噛むことの検算: 元のテスト（mark-contested.test.ts）が立てている
      // assert のうち、この変異体で赤くなるはずのものが実際に throw することを確かめる。
      const assertions = originalAssertions(result, strongId, weakId);
      for (const key of expectRed) {
        expect(assertions[key]).toThrow();
      }
      // 赤くならないはずのものは、本当に緑のままであることも確かめる
      // （「全部赤くなる」と大雑把に言わない——どの assert が何を捉えているかを正直に書く）。
      const expectGreen = ALL_ASSERTION_KEYS.filter((k) => !expectRed.includes(k));
      for (const key of expectGreen) {
        expect(assertions[key]).not.toThrow();
      }
    });
  },
);
