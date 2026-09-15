import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.restoreArchived`（Issue #195、[ADR 0122](../../../../docs/decisions/0122-restore-archived-memory.md)）の歯。
 *
 * 設計の要点（`runtime.ts` の `RestoreArchivedOutcome`/`restoreArchived` の doc コメント参照）:
 * - `archived` → `active` の明示的な復帰のみ。`MemoryStore` に新しい任意メソッドを足していない
 *   ——既存の必須メソッド `updateStatusWithEvent`（ADR 0031）で表現できる compare-and-swap。
 * - `memory_events` へ `kind: 'restored'`（ADR 0122 が `MemoryEventKind` へ足した新しい値）を
 *   同一トランザクションで積む。
 * - 冪等寄りの設計: 既に `archived` でない対象は書き込みをせず `status_not_archived` を返す。
 * - `recall()` 側は一切変更していない——歯②（下の「往復」節）で裏取りする。
 * - `decay_floor_at` は動かさない——復帰の直後に `sweepArchive` を同じ `now` で呼べば
 *   再び archived になりうることを歯で確認する（ドキュメント化した既知の相互作用）。
 *
 * `@mnemora/testkit` には依存しない（`forget.test.ts` と同じ理由。`runtime-fakes.ts` 冒頭の
 * コメント参照）。
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

function restoredEvents(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: MemoryId) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "restored");
}

describe("runtime.restoreArchived — 基本の1件", () => {
  it("archived な Memory を restoreArchived すると active になり、kind='restored' のイベントが1件だけ積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "restored", previousStatus: "archived" },
    ]);
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.status).toBe("active");
    expect(restoredEvents(stores, memory.id)).toHaveLength(1);
  });

  it("存在しない id は not_found・イベントは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.restoreArchived(ctx, { memoryId: "no-such-memory" });

    expect(result.outcomes).toEqual([{ memoryId: "no-such-memory", kind: "not_found" }]);
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.restoreArchived — status のバリエーション（archived 以外は書き込まない）", () => {
  it.each<Exclude<MemoryStatus, "archived">>(["active", "superseded", "contested", "forgotten"])(
    "status=%s な Memory は status_not_archived を返し、書き込みが起きない",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status }));

      const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

      expect(result.outcomes).toEqual([
        { memoryId: memory.id, kind: "status_not_archived", status },
      ]);
      const stored = await stores.memoryStore.get(ctx, memory.id);
      expect(stored?.status).toBe(status);
      expect(stores.eventStore.events).toHaveLength(0);
    },
  );

  it("同じ id を1回の呼び出しの中に2回渡すと [restored, status_not_archived]・イベントは1件", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const result = await runtime.restoreArchived(ctx, { memoryIds: [memory.id, memory.id] });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "restored", previousStatus: "archived" },
      { memoryId: memory.id, kind: "status_not_archived", status: "active" },
    ]);
    expect(restoredEvents(stores, memory.id)).toHaveLength(1);
  });
});

describe("runtime.restoreArchived — target の2つの形", () => {
  it("{ memoryId } と { memoryIds: [...] } は同じように効く", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const viaSingular = await runtime.restoreArchived(ctx, { memoryId: a.id });
    const viaPlural = await runtime.restoreArchived(ctx, { memoryIds: [b.id] });

    expect(viaSingular.outcomes).toEqual([
      { memoryId: a.id, kind: "restored", previousStatus: "archived" },
    ]);
    expect(viaPlural.outcomes).toEqual([
      { memoryId: b.id, kind: "restored", previousStatus: "archived" },
    ]);
  });

  it("空の { memoryIds: [] } は { outcomes: [] } を返し、store への書き込みは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.restoreArchived(ctx, { memoryIds: [] });

    expect(result).toEqual({ outcomes: [] });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.restoreArchived — outcomes の順序・長さ", () => {
  it("複数 id を混ぜた並びでも、outcomes は入力と同じ順序・同じ長さになる", async () => {
    const { runtime, stores } = buildRuntime();
    const archived = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    const alreadyActive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active" }),
    );
    const missingId: MemoryId = "does-not-exist";

    const result = await runtime.restoreArchived(ctx, {
      memoryIds: [missingId, archived.id, alreadyActive.id],
    });

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({ memoryId: missingId, kind: "not_found" });
    expect(result.outcomes[1]).toEqual({
      memoryId: archived.id,
      kind: "restored",
      previousStatus: "archived",
    });
    expect(result.outcomes[2]).toEqual({
      memoryId: alreadyActive.id,
      kind: "status_not_archived",
      status: "active",
    });
  });
});

describe("runtime.restoreArchived — reason / actor", () => {
  it("reason を渡すと meta.reason に入り、省略すると meta に reason キーが無い", async () => {
    const { runtime, stores } = buildRuntime();
    const withReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "archived" }),
    );
    const withoutReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "archived" }),
    );

    await runtime.restoreArchived(
      ctx,
      { memoryId: withReason.id },
      { reason: "問い合わせで必要になった" },
    );
    await runtime.restoreArchived(ctx, { memoryId: withoutReason.id });

    const [reasonEvent] = restoredEvents(stores, withReason.id);
    expect(reasonEvent?.meta).toEqual({ reason: "問い合わせで必要になった" });

    const [noReasonEvent] = restoredEvents(stores, withoutReason.id);
    expect(noReasonEvent?.meta).toEqual({});
    expect(Object.hasOwn(noReasonEvent?.meta ?? {}, "reason")).toBe(false);
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const withActor = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    const withoutActor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "archived" }),
    );

    await runtime.restoreArchived(
      ctx,
      { memoryId: withActor.id },
      { actor: { type: "human", id: "user-42" } },
    );
    await runtime.restoreArchived(ctx, { memoryId: withoutActor.id });

    const [actorEvent] = restoredEvents(stores, withActor.id);
    expect(actorEvent?.actor).toEqual({ type: "human", id: "user-42" });

    const [defaultActorEvent] = restoredEvents(stores, withoutActor.id);
    expect(defaultActorEvent?.actor).toEqual({ type: "system" });
  });

  it("digestSnapshot はその Memory の digest であり、content は運ばない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "archived", content: "秘密の本文", digest: "要旨だけ" }),
    );

    await runtime.restoreArchived(ctx, { memoryId: memory.id });

    const [event] = restoredEvents(stores, memory.id);
    expect(event?.digestSnapshot).toBe("要旨だけ");
    expect(JSON.stringify(event)).not.toContain("秘密の本文");
  });
});

describe("runtime.restoreArchived — 並行（updateStatusWithEvent が MemoryStatusConflictError を投げる）", () => {
  /**
   * `getMany` で読んだ後、実際に `updateStatusWithEvent` を撃つまでの間に別の書き込みが
   * 割り込んだ状況を、既存のテスト用フック `FakeMemoryStore.beforeUpdateStatus`
   * （`forget.test.ts`・`runtime.test.ts` の TOCTOU の歯と同じもの）で再現する。
   */
  it("再読すると active になっている（別の呼び出しが先に復帰させていた）⟹ status_not_archived(status: 'active')", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        memory.status = "active";
      }
    };

    const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "status_not_archived", status: "active" },
    ]);
    expect(restoredEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読しても別の status（forgotten）⟹ conflicted(observedStatus: 'forgotten')", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        memory.status = "forgotten";
      }
    };

    const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "conflicted", observedStatus: "forgotten" },
    ]);
    expect(restoredEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読すると行が消えていた（get が null を返す）⟹ not_found・再試行ループにしない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        memory.status = "forgotten";
      }
    };
    let getCalls = 0;
    const originalGet = stores.memoryStore.get.bind(stores.memoryStore);
    stores.memoryStore.get = async (c, id) => {
      getCalls += 1;
      if (id === memory.id && getCalls === 2) {
        return null;
      }
      return originalGet(c, id);
    };

    const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "not_found" }]);
    expect(getCalls).toBe(2); // 1回だけ再読した（上限の無いループになっていない）
    expect(restoredEvents(stores, memory.id)).toHaveLength(0);
  });
});

describe("runtime.restoreArchived — 打ち切り（競合でない例外）", () => {
  it("2件目で普通の Error が投げられたら [restored, failed, not_attempted]・例外は伝播せず・3件目は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const originalUpdate = stores.memoryStore.updateStatusWithEvent.bind(stores.memoryStore);
    stores.memoryStore.updateStatusWithEvent = async (c, id, status, opts, event) => {
      if (id === m2.id) {
        throw new Error("simulated connection reset");
      }
      return originalUpdate(c, id, status, opts, event);
    };

    const result = await runtime.restoreArchived(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result.outcomes).toEqual([
      { memoryId: m1.id, kind: "restored", previousStatus: "archived" },
      { memoryId: m2.id, kind: "failed", error: "simulated connection reset" },
      { memoryId: m3.id, kind: "not_attempted" },
    ]);

    const m3After = await stores.memoryStore.get(ctx, m3.id);
    expect(m3After?.status).toBe("archived"); // 3件目には一切触れていない
  });
});

describe("runtime.restoreArchived — 往復（sweepArchive → archived → restoreArchived → recall、ADR 0114/ADR 0122）", () => {
  /**
   * 🔴 この歯が「往復」そのものである（オーナー側条件3）。片道（archived にするだけ、
   * または active に戻すだけ）ではなく、掃引で archived になったものが実際に
   * restoreArchived で戻り、`recall()` に再び現れることを1本で確認する。
   *
   * 同時に `docs/recall.md` §5 の被覆不変条件（`index.totalInScope` と `groups` の総和が
   * 一致する）が、この往復の前後で崩れていないことも見る——`recall-runtime.ts` を
   * 一切変更していないので、崩れようがないはずだが、それを主張ではなく実測で示す。
   */
  it("sweepArchive で archived になった Memory は restoreArchived で active に戻り、recall() に再び現れる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "active",
        embeddingStatus: "ready",
        decayFloorAt: new Date(NOW.getTime() - 1_000), // 既に減衰しきっている
      }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    // 0. 往復の前: recall に出る。totalInScope はこの1件を含む。
    const before = await runtime.recall(ctx, { vector: [1, 0] });
    expect(before.memories.map((m) => m.memoryId)).toContain(memory.id);
    const totalInScopeBefore = before.index.totalInScope;

    // 1. 掃引（ADR 0114）。
    const swept = await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });
    expect(swept).toEqual({
      supported: true,
      archived: [{ memoryId: memory.id, decayFloorAt: memory.decayFloorAt }],
      reachedLimit: false,
    });
    const afterSweep = await stores.memoryStore.get(ctx, memory.id);
    expect(afterSweep?.status).toBe("archived");

    // 2. recall から消え、archived として filtered に計上され、totalInScope が1件分減る。
    const duringArchive = await runtime.recall(ctx, { vector: [1, 0] });
    expect(duringArchive.memories.map((m) => m.memoryId)).not.toContain(memory.id);
    expect(duringArchive.omitted).toContainEqual({
      kind: "filtered",
      condition: "archived",
      count: 1,
      countKind: "exact",
    });
    expect(duringArchive.index.totalInScope).toBe(totalInScopeBefore - 1);

    // 3. 明示的に呼び戻す（ADR 0122、本 PR の主題）。
    const restored = await runtime.restoreArchived(ctx, { memoryId: memory.id });
    expect(restored.outcomes).toEqual([
      { memoryId: memory.id, kind: "restored", previousStatus: "archived" },
    ]);
    expect(restoredEvents(stores, memory.id)).toHaveLength(1);
    const afterRestore = await stores.memoryStore.get(ctx, memory.id);
    expect(afterRestore?.status).toBe("active");

    // 4. recall() に戻り、archived の filtered 計上が消え、totalInScope が元に戻る
    // （被覆不変条件: groups の総和 === totalInScope は、recall-runtime.ts を一切
    // 変更していないため常に成り立つが、その値そのものが往復の前後で復元することを
    // ここで実測する）。
    const after = await runtime.recall(ctx, { vector: [1, 0] });
    expect(after.memories.map((m) => m.memoryId)).toContain(memory.id);
    expect(after.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "archived" }),
    );
    expect(after.index.totalInScope).toBe(totalInScopeBefore);
  });

  it("⚠ ドキュメント化した既知の相互作用: 復帰は decay_floor_at を動かさないため、同じ now で sweepArchive をもう一度呼ぶと即座に再び archived になる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", decayFloorAt: new Date(NOW.getTime() - 1_000) }),
    );

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });
    await runtime.restoreArchived(ctx, { memoryId: memory.id });
    const betweenSweeps = await stores.memoryStore.get(ctx, memory.id);
    expect(betweenSweeps?.status).toBe("active");

    const secondSweep = await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(secondSweep.archived.map((a) => a.memoryId)).toEqual([memory.id]);
    const afterSecondSweep = await stores.memoryStore.get(ctx, memory.id);
    expect(afterSecondSweep?.status).toBe("archived");
  });
});
