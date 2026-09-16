import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.markContested`（Issue #197、ADR 0134）の歯。
 *
 * 設計の要点（`runtime.ts` の `MarkContestedOutcome`/`markContested` の doc コメント参照）:
 * - 両側とも呼び出し時点で `status === 'active'` であることを CAS で要求する。
 * - 成功すれば両側が `status='contested'` になり、`contestedWithId` を相互に設定する。
 * - `firstId === secondId` は書き込み前に `RangeError` を投げる。
 * - どちらか一方でも `active` でなければ（不在・別 status）、書き込みを一切試みず
 *   `ineligible` を返す。
 * - `MemoryStore.markContestedPair` が無い adapter では `supported: false` になり、
 *   フォールバックしない。
 * - `tick()`/`observe()` からは呼ばれない。
 * - `recall()` 側は一切変更していない——既存の段1 status ゲート・段3 mandatory
 *   companion retrieval にそのまま合流する（この歯の最後で実測する）。
 *
 * `@mnemora/testkit` には依存しない（`purge.test.ts` と同じ理由）。
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

/** `deps.memoryStore.markContestedPair` が無い adapter を模す（`purge.test.ts` の `disablePurgeMemory` と同じ形）。 */
function disableMarkContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "markContestedPair", {
    value: undefined,
    configurable: true,
  });
}

describe("runtime.markContested — 基本の成功", () => {
  it("両側 active な Memory は contested になり、contestedWithId が相互に設定される", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const result = await runtime.markContested(ctx, a.id, b.id);

    expect(result.supported).toBe(true);
    expect(result.outcome.kind).toBe("contested");

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("contested");
    expect(storedB?.status).toBe("contested");
    expect(storedA?.contestedWithId).toBe(b.id);
    expect(storedB?.contestedWithId).toBe(a.id);
  });

  it("両側に kind='updated', meta.reason='contested' のイベントが1件ずつ積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    await runtime.markContested(ctx, a.id, b.id);

    const eventsA = stores.eventStore.events.filter((e) => e.memoryId === a.id);
    const eventsB = stores.eventStore.events.filter((e) => e.memoryId === b.id);
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]?.kind).toBe("updated");
    expect(eventsA[0]?.meta).toEqual({ reason: "contested" });
    expect(eventsB[0]?.kind).toBe("updated");
    expect(eventsB[0]?.meta).toEqual({ reason: "contested" });
  });

  it("reason を渡すと meta.note に入り、meta.reason は上書きされない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    await runtime.markContested(ctx, a.id, b.id, { reason: "ユーザーが前言を訂正した" });

    const [eventA] = stores.eventStore.events.filter((e) => e.memoryId === a.id);
    expect(eventA?.meta).toEqual({ reason: "contested", note: "ユーザーが前言を訂正した" });
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    await runtime.markContested(ctx, a.id, b.id, { actor: { type: "human", id: "user-1" } });

    const [eventA] = stores.eventStore.events.filter((e) => e.memoryId === a.id);
    const [eventB] = stores.eventStore.events.filter((e) => e.memoryId === b.id);
    expect(eventA?.actor).toEqual({ type: "human", id: "user-1" });
    expect(eventB?.actor).toEqual({ type: "human", id: "user-1" });
  });

  it("digestSnapshot は現在の digest であり、content は運ばない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "要旨A", content: "秘密の本文A" }),
    );
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "要旨B" }));

    await runtime.markContested(ctx, a.id, b.id);

    const [eventA] = stores.eventStore.events.filter((e) => e.memoryId === a.id);
    expect(eventA?.digestSnapshot).toBe("要旨A");
    expect(JSON.stringify(eventA)).not.toContain("秘密の本文A");
  });
});

describe("runtime.markContested — firstId === secondId（呼び手のバグ）", () => {
  it("同じ id を渡すと RangeError を投げ、書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));

    await expect(runtime.markContested(ctx, a.id, a.id)).rejects.toThrow(RangeError);

    const stored = await stores.memoryStore.get(ctx, a.id);
    expect(stored?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.markContested — ineligible（存在しない・active でない）", () => {
  it("片方が存在しない id は ineligible(not_found) を返し、もう片方は一切書き換わらない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));

    const result = await runtime.markContested(ctx, a.id, "does-not-exist");

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "eligible" },
          { memoryId: "does-not-exist", kind: "not_found" },
        ],
      },
    });
    const stored = await stores.memoryStore.get(ctx, a.id);
    expect(stored?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it.each<Exclude<MemoryStatus, "active">>(["superseded", "contested", "archived", "forgotten"])(
    "片方が status=%s だと ineligible(status_not_active) を返し、書き込みは起きない",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
      const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B", status }));

      const result = await runtime.markContested(ctx, a.id, b.id);

      expect(result).toEqual({
        supported: true,
        outcome: {
          kind: "ineligible",
          sides: [
            { memoryId: a.id, kind: "eligible" },
            { memoryId: b.id, kind: "status_not_active", status },
          ],
        },
      });
      const storedA = await stores.memoryStore.get(ctx, a.id);
      const storedB = await stores.memoryStore.get(ctx, b.id);
      expect(storedA?.status).toBe("active");
      expect(storedB?.status).toBe(status);
      expect(stores.eventStore.events).toHaveLength(0);
    },
  );

  it("両方とも不適格なら、両方の分類を sides に返す", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "A", status: "archived" }),
    );

    const result = await runtime.markContested(ctx, a.id, "does-not-exist");

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "status_not_active", status: "archived" },
          { memoryId: "does-not-exist", kind: "not_found" },
        ],
      },
    });
  });
});

describe("runtime.markContested — MemoryStore.markContestedPair が無い adapter（任意メソッド、フォールバック無し）", () => {
  it("markContestedPair が無ければ supported: false・not_attempted・書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    disableMarkContestedPair(stores);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const result = await runtime.markContested(ctx, a.id, b.id);

    expect(result).toEqual({ supported: false, outcome: { kind: "not_attempted" } });
    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("active");
    expect(storedB?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("markContestedPair が無い場合、firstId===secondId のチェックより前に not_attempted を返さない（RangeError が先に立つ）", async () => {
    // ⚠ 「対応していない」を名乗るのと「呼び手が壊れた入力を渡した」はどちらも失敗だが、
    // 後者は書き込みの可否に関わらず常に検出できるべきである——`supported` の値に
    // 応じて挙動が変わってしまうと、呼び手は自分の入力ミスを気づけないまま
    // 「対応していないだけ」と誤読しうる。
    const { runtime, stores } = buildRuntime();
    disableMarkContestedPair(stores);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));

    await expect(runtime.markContested(ctx, a.id, a.id)).rejects.toThrow(RangeError);
  });
});

describe("runtime.markContested — 並行（markContestedPair が MemoryStatusConflictError を投げる）", () => {
  it("読んだ後・書く前に片方の status が変わっていた⟹ conflict を返し、両側の現在値を1回だけ再読する", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === b.id) {
        b.status = "archived";
      }
    };

    const result = await runtime.markContested(ctx, a.id, b.id);

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "conflict",
        conflicts: [
          { id: a.id, observedStatus: "active" },
          { id: b.id, observedStatus: "archived" },
        ],
      },
    });
    // 片方だけ書き換わった状態を残さない——`a` も書き込まれていない。
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("active");
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.markContested — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも active な Memory は contested にならない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const stored = await stores.memoryStore.get(ctx, a.id);
    expect(stored?.status).toBe("active");
  });
});

describe("runtime.markContested — recall() の段3が実際に発火する（Issue #197 の主目的）", () => {
  it("markContested した2件は、片方しかスコアで選ばれなくても両方 recall に出て、対向は mandatory_companion として隣接する", async () => {
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

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1 });

    const ids = result.memories.map((m) => m.memoryId);
    // `limit: 1` かつ `weak` はクエリと直交するベクトルなので、スコアだけなら
    // 候補にすら残らないはずである。それでも同伴として強制的に足される。
    expect(ids).toContain(strong.id);
    expect(ids).toContain(weak.id);

    const companion = result.memories.find((m) => m.memoryId === weak.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(companion?.companionOf).toBe(strong.id);

    // 隣接性（docs/memory-model.md §5 機構3）。
    // ⚠ Issue #293（実測で見つかった盲点）: `indexOf` は見つからないとき `-1` を返すため、
    // 片方だけが結果から完全に消えた世界でも `Math.abs(0 - (-1)) === 1` が偶然成立して
    // しまう。⟹ 両方が実際に結果に含まれていること（`index >= 0`）を先に assert してから、
    // 隣接性を比較する（`stage3-mandatory-companion-mutation.test.ts` の変異体Cが、この式を
    // 直さないと緑のままであることを実測している）。
    const indexStrong = ids.indexOf(strong.id);
    const indexWeak = ids.indexOf(weak.id);
    expect(indexStrong).toBeGreaterThanOrEqual(0);
    expect(indexWeak).toBeGreaterThanOrEqual(0);
    expect(Math.abs(indexStrong - indexWeak)).toBe(1);

    // 段3が実際に発火したことを trace 経由でも確認する——これが「今日は一度も通らない
    // 分岐」だった、まさにその段である（recall-runtime.ts の該当コメント参照）。
    // ⚠ Issue #293: `executed` は本番コードが `companions.length` に関わらず常に `true` を
    // 返すため、これ単独では「段3が壊れていない」ことの根拠にならない——「段3のコードが
    // 実行された」ことしか言っていない。段3が実際に発火した（同伴取得が起きた）ことを
    // 測っているのは、直後の `detail.companionsAdded` の方である。
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.executed).toBe(true);
    expect(stage?.detail).toEqual({ companionsAdded: 1 });
  });
});
