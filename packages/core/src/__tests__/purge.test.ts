import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.purge`（Issue #198、[ADR 0124](../../../../docs/decisions/0124-purge-physical-delete.md)）の歯。
 *
 * 設計の要点（`runtime.ts` の `PurgeOutcome`/`purge` の doc コメント参照）:
 * - `forgotten` からのみ遷移できる（任意 status からの直接 purge はできない）。
 * - `content`/`digest` をトゥームストーンで上書きし、`purgedAt` を設定。行は消えない。
 * - CAS の条件は `status = 'forgotten' AND purgedAt IS NULL` の両方
 *   ——`status` だけでは2回目の呼び出しを弾けない（この操作は `status` を動かさないため）。
 * - `opts.dryRun` は書き込み無しで下見を返す。
 * - `MemoryStore.purgeMemory` が無い adapter では `supported: false` になり、全対象が
 *   `not_attempted`。
 * - `tick()`/`observe()` からは呼ばれない。
 * - `recall()`/`aggregateScope` は一切変更していない。
 *
 * `@mnemora/testkit` には依存しない（`forget.test.ts`/`restore-archived.test.ts` と同じ理由）。
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

function purgedEvents(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: MemoryId) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "purged");
}

/** `deps.memoryStore.purgeMemory` が無い adapter を模す（own property でプロトタイプの実装を隠す）。 */
function disablePurgeMemory(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "purgeMemory", {
    value: undefined,
    configurable: true,
  });
}

describe("runtime.purge — 基本の1件", () => {
  it("forgotten な Memory を purge すると content/digest がトゥームストーンで上書きされ、purgedAt が入り、kind='purged' のイベントが1件だけ積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", content: "秘密の本文", digest: "要旨" }),
    );

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result).toEqual({
      supported: true,
      outcomes: [{ memoryId: memory.id, kind: "purged", previousStatus: "forgotten" }],
    });
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.status).toBe("forgotten"); // status は動かない
    expect(stored?.content).toBe("[purged]");
    expect(stored?.digest).toBe("[purged]");
    expect(stored?.purgedAt).toBeInstanceOf(Date);
    expect(purgedEvents(stores, memory.id)).toHaveLength(1);
  });

  it("行は消えない（get で読み続けられる）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    await runtime.purge(ctx, { memoryId: memory.id });

    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(memory.id);
  });

  it("存在しない id は not_found・イベントは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.purge(ctx, { memoryId: "no-such-memory" });

    expect(result).toEqual({
      supported: true,
      outcomes: [{ memoryId: "no-such-memory", kind: "not_found" }],
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.purge — status のバリエーション（forgotten 以外は直接 purge できない）", () => {
  it.each<Exclude<MemoryStatus, "forgotten">>(["active", "superseded", "contested", "archived"])(
    "status=%s な Memory は status_not_forgotten を返し、書き込みが起きない",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status }));

      const result = await runtime.purge(ctx, { memoryId: memory.id });

      expect(result).toEqual({
        supported: true,
        outcomes: [{ memoryId: memory.id, kind: "status_not_forgotten", status }],
      });
      const stored = await stores.memoryStore.get(ctx, memory.id);
      expect(stored?.status).toBe(status);
      expect(stored?.purgedAt ?? null).toBeNull();
      expect(stores.eventStore.events).toHaveLength(0);
    },
  );
});

describe("runtime.purge — 冪等性（2回 purge したらどうなるか）", () => {
  it("既に purge 済みの Memory をもう一度 purge すると already_purged を返し、イベントは増えない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const first = await runtime.purge(ctx, { memoryId: memory.id });
    const second = await runtime.purge(ctx, { memoryId: memory.id });

    expect(first.outcomes).toEqual([
      { memoryId: memory.id, kind: "purged", previousStatus: "forgotten" },
    ]);
    expect(second.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(1);
  });

  it("同じ id を1回の呼び出しの中に2回渡すと [purged, already_purged]・イベントは1件", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryIds: [memory.id, memory.id] });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "purged", previousStatus: "forgotten" },
      { memoryId: memory.id, kind: "already_purged" },
    ]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(1);
  });
});

describe("runtime.purge — target の2つの形", () => {
  it("{ memoryId } と { memoryIds: [...] } は同じように効く", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const viaSingular = await runtime.purge(ctx, { memoryId: a.id });
    const viaPlural = await runtime.purge(ctx, { memoryIds: [b.id] });

    expect(viaSingular.outcomes).toEqual([
      { memoryId: a.id, kind: "purged", previousStatus: "forgotten" },
    ]);
    expect(viaPlural.outcomes).toEqual([
      { memoryId: b.id, kind: "purged", previousStatus: "forgotten" },
    ]);
  });

  it("空の { memoryIds: [] } は { supported: true, outcomes: [] } を返し、store への書き込みは0件", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.purge(ctx, { memoryIds: [] });

    expect(result).toEqual({ supported: true, outcomes: [] });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("runtime.purge — outcomes の順序・長さ", () => {
  it("複数 id を混ぜた並びでも、outcomes は入力と同じ順序・同じ長さになる", async () => {
    const { runtime, stores } = buildRuntime();
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const active = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const missingId: MemoryId = "does-not-exist";

    const result = await runtime.purge(ctx, {
      memoryIds: [missingId, forgotten.id, active.id],
    });

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({ memoryId: missingId, kind: "not_found" });
    expect(result.outcomes[1]).toEqual({
      memoryId: forgotten.id,
      kind: "purged",
      previousStatus: "forgotten",
    });
    expect(result.outcomes[2]).toEqual({
      memoryId: active.id,
      kind: "status_not_forgotten",
      status: "active",
    });
  });
});

describe("runtime.purge — reason / actor / digestSnapshot", () => {
  it("reason を渡すと meta.reason に入り、省略すると meta に reason キーが無い", async () => {
    const { runtime, stores } = buildRuntime();
    const withReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const withoutReason = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );

    await runtime.purge(ctx, { memoryId: withReason.id }, { reason: "法的要求への対応" });
    await runtime.purge(ctx, { memoryId: withoutReason.id });

    const [reasonEvent] = purgedEvents(stores, withReason.id);
    expect(reasonEvent?.meta).toEqual({ reason: "法的要求への対応" });

    const [noReasonEvent] = purgedEvents(stores, withoutReason.id);
    expect(noReasonEvent?.meta).toEqual({});
    expect(Object.hasOwn(noReasonEvent?.meta ?? {}, "reason")).toBe(false);
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const withActor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );
    const withoutActor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten" }),
    );

    await runtime.purge(
      ctx,
      { memoryId: withActor.id },
      { actor: { type: "human", id: "user-42" } },
    );
    await runtime.purge(ctx, { memoryId: withoutActor.id });

    const [actorEvent] = purgedEvents(stores, withActor.id);
    expect(actorEvent?.actor).toEqual({ type: "human", id: "user-42" });

    const [defaultActorEvent] = purgedEvents(stores, withoutActor.id);
    expect(defaultActorEvent?.actor).toEqual({ type: "system" });
  });

  it("digestSnapshot は上書き前の digest であり、content は運ばない（purge 後、元の digest が残る唯一の場所）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", content: "秘密の本文", digest: "要旨だけ" }),
    );

    await runtime.purge(ctx, { memoryId: memory.id });

    const [event] = purgedEvents(stores, memory.id);
    expect(event?.digestSnapshot).toBe("要旨だけ");
    expect(JSON.stringify(event)).not.toContain("秘密の本文");

    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.digest).toBe("[purged]"); // 上書き後は store 側にも元の digest は残らない
  });
});

describe("runtime.purge — dryRun（下見）", () => {
  it("forgotten かつ未 purge の対象は would_purge を返し、書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", content: "秘密の本文", digest: "要旨" }),
    );

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result).toEqual({
      supported: true,
      outcomes: [{ memoryId: memory.id, kind: "would_purge", previousStatus: "forgotten" }],
    });
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.content).toBe("秘密の本文");
    expect(stored?.digest).toBe("要旨");
    expect(stored?.purgedAt ?? null).toBeNull();
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("既に purge 済みの対象は dryRun でも already_purged を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await runtime.purge(ctx, { memoryId: memory.id });

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
  });

  it("forgotten ではない対象は dryRun でも status_not_forgotten を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "status_not_forgotten", status: "active" },
    ]);
  });

  it("存在しない対象は dryRun でも not_found を返す", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.purge(ctx, { memoryId: "no-such-memory" }, { dryRun: true });

    expect(result.outcomes).toEqual([{ memoryId: "no-such-memory", kind: "not_found" }]);
  });

  it("dryRun は embedding にも触れない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);

    await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    const hits = await stores.vectorStore.search(ctx, stores.embeddingProvider.space, [1, 0], {
      limit: 10,
      filter: { tenantId: ctx.tenantId, status: ["active", "contested", "forgotten"] },
    });
    expect(hits.map((h) => h.memoryId)).toContain(memory.id);
  });
});

describe("runtime.purge — 対応する embedding が実際に消える", () => {
  it("purge すると VectorStore.delete が呼ばれ、embedding が消える", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    expect(stores.vectorStore.entries.size).toBe(1);

    await runtime.purge(ctx, { memoryId: memory.id });

    expect(stores.vectorStore.entries.size).toBe(0);
  });

  it("VectorStore.delete が例外を投げても、purged の判定は変わらない（ADR 0124 決定5、ベストエフォート）", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.vectorStore.delete = async () => {
      throw new Error("simulated vector store outage");
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "purged", previousStatus: "forgotten" },
    ]);
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.purgedAt).toBeInstanceOf(Date); // MemoryStore 側の書き込みは確定している
  });
});

describe("runtime.purge — MemoryStore.purgeMemory が無い adapter（任意メソッド）", () => {
  it("purgeMemory が無ければ supported: false・全対象が not_attempted・書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    disablePurgeMemory(stores);
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result).toEqual({
      supported: false,
      outcomes: [{ memoryId: memory.id, kind: "not_attempted" }],
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("purgeMemory が無ければ dryRun でも supported: false・not_attempted になる（下見も含めて一様に『対応していない』）", async () => {
    const { runtime, stores } = buildRuntime();
    disablePurgeMemory(stores);
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(ctx, { memoryId: memory.id }, { dryRun: true });

    expect(result).toEqual({
      supported: false,
      outcomes: [{ memoryId: memory.id, kind: "not_attempted" }],
    });
  });

  it("複数対象・空配列でも supported は一様に false", async () => {
    const { runtime, stores } = buildRuntime();
    disablePurgeMemory(stores);

    const empty = await runtime.purge(ctx, { memoryIds: [] });
    expect(empty).toEqual({ supported: false, outcomes: [] });
  });
});

describe("runtime.purge — 並行（purgeMemory が MemoryPurgeConflictError を投げる）", () => {
  it("再読すると既に purge 済み（別の呼び出しが先に purge していた）⟹ already_purged", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        memory.purgedAt = new Date();
        memory.content = "[purged]";
        memory.digest = "[purged]";
      }
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "already_purged" }]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読すると status が forgotten でなくなっていた⟹ status_not_forgotten", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        memory.status = "active";
      }
    };

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([
      { memoryId: memory.id, kind: "status_not_forgotten", status: "active" },
    ]);
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });

  it("再読すると行が消えていた（get が null を返す）⟹ not_found・再試行ループにしない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === memory.id) {
        memory.status = "active";
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

    const result = await runtime.purge(ctx, { memoryId: memory.id });

    expect(result.outcomes).toEqual([{ memoryId: memory.id, kind: "not_found" }]);
    expect(getCalls).toBe(2); // 1回だけ再読した（上限の無いループになっていない）
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });
});

describe("runtime.purge — 打ち切り（競合でない例外）", () => {
  it("2件目で普通の Error が投げられたら [purged, failed, not_attempted]・例外は伝播せず・3件目は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const m1 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m2 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const m3 = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const originalPurgeMemory = stores.memoryStore.purgeMemory!.bind(stores.memoryStore);
    stores.memoryStore.purgeMemory = async (c, id, tombstone, event) => {
      if (id === m2.id) {
        throw new Error("simulated connection reset");
      }
      return originalPurgeMemory(c, id, tombstone, event);
    };

    const result = await runtime.purge(ctx, { memoryIds: [m1.id, m2.id, m3.id] });

    expect(result.outcomes).toEqual([
      { memoryId: m1.id, kind: "purged", previousStatus: "forgotten" },
      { memoryId: m2.id, kind: "failed", error: "simulated connection reset" },
      { memoryId: m3.id, kind: "not_attempted" },
    ]);

    const m3After = await stores.memoryStore.get(ctx, m3.id);
    expect(m3After?.status).toBe("forgotten");
    expect(m3After?.purgedAt ?? null).toBeNull(); // 3件目には一切触れていない
  });
});

describe("runtime.purge — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも purge 対象の Memory は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const tickResult = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(tickResult.unsupported).toEqual([]);
    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.purgedAt ?? null).toBeNull();
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });

  it("observe({ kind: 'memory_usage' }) を呼んでも purge 対象の Memory は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", embeddingStatus: "ready" }),
    );
    const recallId = await stores.memoryStore.createRecall(ctx, {
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
      returnedMemoryIds: [memory.id],
    });

    await runtime.observe(ctx, { kind: "memory_usage", recallId, usedMemoryIds: [memory.id] });

    const stored = await stores.memoryStore.get(ctx, memory.id);
    expect(stored?.purgedAt ?? null).toBeNull();
    expect(stored?.content).toBe("本文");
    expect(purgedEvents(stores, memory.id)).toHaveLength(0);
  });
});

describe("runtime.purge — recall()/aggregateScope への影響（ADR 0124 決定6）", () => {
  /**
   * 🔴 purge は `status` を動かさないため、purge された Memory は purge の前後を通じて
   * 常に `status = 'forgotten'` であり、`docs/recall.md` §2 段0・§5 の決定
   * （スコープ = tenant + subject + period + taxonomy + status ゲート）により、
   * そもそも一度も「スコープ内」に入ったことが無い。この歯はそれを主張ではなく実測で示す
   * ——`forget → purge` の前後で `recall()` の `memories`/`omitted`・
   * `index.totalInScope`/`groups` が変わらないことを見る。
   */
  it("forget → purge の前後で recall() の結果も index.totalInScope/groups も変わらない", async () => {
    const { runtime, stores } = buildRuntime();
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, forgotten.id, [1, 0]);
    // 母数のための別の active な Memory。
    const other = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, other.id, [0, 1]);

    await runtime.forget(ctx, { memoryId: forgotten.id });

    const beforePurge = await runtime.recall(ctx, { vector: [1, 0] });
    expect(beforePurge.memories.map((m) => m.memoryId)).not.toContain(forgotten.id);
    expect(beforePurge.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      count: 1,
      countKind: "exact",
    });
    const totalInScopeBefore = beforePurge.index.totalInScope;
    const groupsBefore = beforePurge.index.groups;

    const purgeResult = await runtime.purge(ctx, { memoryId: forgotten.id });
    expect(purgeResult.outcomes).toEqual([
      { memoryId: forgotten.id, kind: "purged", previousStatus: "forgotten" },
    ]);

    const afterPurge = await runtime.recall(ctx, { vector: [1, 0] });
    expect(afterPurge.memories.map((m) => m.memoryId)).not.toContain(forgotten.id);
    expect(afterPurge.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      count: 1,
      countKind: "exact",
    });
    expect(afterPurge.index.totalInScope).toBe(totalInScopeBefore);
    expect(afterPurge.index.groups).toEqual(groupsBefore);
  });
});
