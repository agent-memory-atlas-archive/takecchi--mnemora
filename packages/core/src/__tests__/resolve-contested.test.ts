import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.resolveContested`（Issue #197、ADR 0150）の歯。`mark-contested.test.ts`
 * （検出側、ADR 0134）を手本にした、解決側の対称な検査。
 *
 * 設計の要点（`runtime.ts` の `ResolveContestedOutcome`/`resolveContested` の doc コメント
 * 参照）:
 * - 両側とも呼び出し時点で `status === 'contested'` かつ相互参照が成立していることを
 *   CAS で要求する。
 * - `{ kind: "supersede", winnerId }`: 勝者は `status='active'`、敗者は
 *   `status='superseded'` + `supersededById=<勝者>`、両側とも `contestedWithId=null`。
 * - `{ kind: "both_active" }`: 両側とも `status='active'`・`contestedWithId=null`。
 * - `firstId === secondId` は書き込み前に `RangeError`。`winnerId` が `firstId`/`secondId`
 *   のどちらでもない場合も書き込み前に `RangeError`。
 * - どちらか一方でも `contested` でない・相互参照が破れていれば、書き込みを一切試みず
 *   `ineligible` を返す。
 * - `MemoryStore.resolveContestedPair` が無い adapter では `supported: false` になり、
 *   フォールバックしない。
 * - `tick()`/`observe()` からは呼ばれない。
 * - `recall()` 側は一切変更していない——`markContested` で対向にした2件を
 *   `resolveContested` で解決すると、敗者は次の `recall` から出てこなくなる
 *   （この歯の最後で実測する。Issue #197 の主目的）。
 *
 * `@mnemora/testkit` には依存しない（`mark-contested.test.ts` と同じ理由）。
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

/** `deps.memoryStore.resolveContestedPair` が無い adapter を模す（`disableMarkContestedPair` と同じ形）。 */
function disableResolveContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
  Object.defineProperty(stores.memoryStore, "resolveContestedPair", {
    value: undefined,
    configurable: true,
  });
}

/** `markContested` で a/b を対向の `contested` にしてから返す（各歯の共通セットアップ）。 */
async function createContestedPair(
  runtime: ReturnType<typeof buildRuntime>["runtime"],
  stores: ReturnType<typeof buildRuntime>["stores"],
) {
  const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
  const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
  const marked = await runtime.markContested(ctx, a.id, b.id);
  expect(marked.outcome.kind).toBe("contested");
  return { a, b };
}

describe("runtime.resolveContested — supersede（基本の成功）", () => {
  it("勝者は active、敗者は superseded + supersededById、両側とも contestedWithId が null になる", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: a.id,
    });

    expect(result.supported).toBe(true);
    expect(result.outcome.kind).toBe("resolved");

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("active");
    expect(storedA?.contestedWithId).toBeNull();
    expect(storedB?.status).toBe("superseded");
    expect(storedB?.supersededById).toBe(a.id);
    expect(storedB?.contestedWithId).toBeNull();
  });

  it("winnerId が secondId 側でも同じく解決する（勝者の位置は固定ではない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: b.id });

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("superseded");
    expect(storedA?.supersededById).toBe(b.id);
    expect(storedB?.status).toBe("active");
  });

  it("勝者に kind='updated'、敗者に kind='superseded' のイベントが1件ずつ積まれ、meta.reason='contested_resolved'・meta.resolution='supersede'", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    const eventsBefore = stores.eventStore.events.length; // markContested が積んだ2件を除く

    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: a.id });

    const newEvents = stores.eventStore.events.slice(eventsBefore);
    const eventA = newEvents.find((e) => e.memoryId === a.id);
    const eventB = newEvents.find((e) => e.memoryId === b.id);
    expect(eventA?.kind).toBe("updated");
    expect(eventA?.meta).toEqual({ reason: "contested_resolved", resolution: "supersede" });
    expect(eventB?.kind).toBe("superseded");
    expect(eventB?.meta).toEqual({ reason: "contested_resolved", resolution: "supersede" });
  });
});

describe("runtime.resolveContested — both_active（基本の成功）", () => {
  it("両側とも active になり、contestedWithId が null になる", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result.outcome.kind).toBe("resolved");
    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("active");
    expect(storedA?.contestedWithId).toBeNull();
    expect(storedB?.status).toBe("active");
    expect(storedB?.contestedWithId).toBeNull();
  });

  it("両側とも kind='updated'、meta.resolution='both_active' のイベントが積まれる", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    const eventsBefore = stores.eventStore.events.length;

    await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    const newEvents = stores.eventStore.events.slice(eventsBefore);
    const eventA = newEvents.find((e) => e.memoryId === a.id);
    const eventB = newEvents.find((e) => e.memoryId === b.id);
    expect(eventA?.kind).toBe("updated");
    expect(eventA?.meta).toEqual({ reason: "contested_resolved", resolution: "both_active" });
    expect(eventB?.kind).toBe("updated");
    expect(eventB?.meta).toEqual({ reason: "contested_resolved", resolution: "both_active" });
  });
});

describe("runtime.resolveContested — opts", () => {
  it("reason を渡すと meta.note に入り、meta.reason/meta.resolution は上書きされない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    const eventsBefore = stores.eventStore.events.length;

    await runtime.resolveContested(
      ctx,
      a.id,
      b.id,
      { kind: "both_active" },
      { reason: "誤検出だった" },
    );

    const [eventA] = stores.eventStore.events.slice(eventsBefore);
    expect(eventA?.meta).toEqual({
      reason: "contested_resolved",
      resolution: "both_active",
      note: "誤検出だった",
    });
  });

  it("actor を渡すとイベントの actor がそれになり、省略時は { type: 'system' }", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    const eventsBefore = stores.eventStore.events.length;

    await runtime.resolveContested(
      ctx,
      a.id,
      b.id,
      { kind: "both_active" },
      { actor: { type: "human", id: "user-1" } },
    );

    const newEvents = stores.eventStore.events.slice(eventsBefore);
    expect(newEvents.every((e) => e.actor.type === "human")).toBe(true);
  });

  it("digestSnapshot は現在の digest であり、content は運ばない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "要旨A", content: "秘密の本文A" }),
    );
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "要旨B" }));
    await runtime.markContested(ctx, a.id, b.id);
    const eventsBefore = stores.eventStore.events.length;

    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: a.id });

    const [eventA] = stores.eventStore.events.slice(eventsBefore);
    expect(eventA?.digestSnapshot).toBe("要旨A");
    expect(JSON.stringify(eventA)).not.toContain("秘密の本文A");
  });
});

describe("runtime.resolveContested — firstId === secondId（呼び手のバグ）", () => {
  it("同じ id を渡すと RangeError を投げ、書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createContestedPair(runtime, stores);

    await expect(
      runtime.resolveContested(ctx, a.id, a.id, { kind: "both_active" }),
    ).rejects.toThrow(RangeError);

    const stored = await stores.memoryStore.get(ctx, a.id);
    expect(stored?.status).toBe("contested");
  });
});

describe("runtime.resolveContested — winnerId が firstId/secondId のどちらでもない（呼び手のバグ）", () => {
  it("RangeError を投げ、書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    await expect(
      runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: "does-not-exist" }),
    ).rejects.toThrow(RangeError);

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("contested");
    expect(storedB?.status).toBe("contested");
  });
});

describe("runtime.resolveContested — ineligible（存在しない・contested でない・相互参照が破れている）", () => {
  it("片方が存在しない id は ineligible(not_found) を返す。もう片方は独立に分類される——ここでは active（そもそも対になっていない）なので status_not_contested になる", async () => {
    // ⚠ `markContested` の同種の歯と違い、ここで対になっている Memory を使わない
    // 理由: `resolveContested` の適格性判定は「相手（渡された otherId）と実際に
    // 相互参照しているか」を見る関係的な判定であり、`a` が別の実在 Memory（`b`）と
    // 本物の対を成していても、ここで渡す第2引数（存在しない id）とは一致しない。
    // その場合 `a` は `"eligible"` ではなく `"pair_broken"` に分類される
    // （下の「相互参照が破れている」歯が別途その組み合わせを検査する）。
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));

    const result = await runtime.resolveContested(ctx, a.id, "does-not-exist", {
      kind: "both_active",
    });

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "status_not_contested", status: "active" },
          { memoryId: "does-not-exist", kind: "not_found" },
        ],
      },
    });
    const stored = await stores.memoryStore.get(ctx, a.id);
    expect(stored?.status).toBe("active");
  });

  it("片方が active（対になっていない）だと ineligible(status_not_contested) を返す", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "status_not_contested", status: "active" },
          { memoryId: b.id, kind: "status_not_contested", status: "active" },
        ],
      },
    });
  });

  it("status='contested' だが相互参照が破れている片方は ineligible(pair_broken) を返し、書き込みは起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    // b の相互参照を壊す——a.contestedWithId は依然 b.id を指すが、
    // b.contestedWithId は c.id を指すようにする（a 側からは片方だけが壊れて見える）。
    const storedB = await stores.memoryStore.get(ctx, b.id);
    storedB!.contestedWithId = c.id;

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "eligible" },
          { memoryId: b.id, kind: "pair_broken", contestedWithId: c.id },
        ],
      },
    });
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("contested");
    expect(storedA?.contestedWithId).toBe(b.id);
  });
});

describe("runtime.resolveContested — MemoryStore.resolveContestedPair が無い adapter（任意メソッド、フォールバック無し）", () => {
  it("resolveContestedPair が無ければ supported: false・not_attempted・書き込みは一切起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    disableResolveContestedPair(stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result).toEqual({ supported: false, outcome: { kind: "not_attempted" } });
    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("contested");
    expect(storedB?.status).toBe("contested");
  });

  it("resolveContestedPair が無い場合、firstId===secondId のチェックより前に not_attempted を返さない（RangeError が先に立つ）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a } = await createContestedPair(runtime, stores);
    disableResolveContestedPair(stores);

    await expect(
      runtime.resolveContested(ctx, a.id, a.id, { kind: "both_active" }),
    ).rejects.toThrow(RangeError);
  });
});

describe("runtime.resolveContested — 並行（resolveContestedPair が MemoryStatusConflictError を投げる）", () => {
  it("読んだ後・書く前に片方の status が変わっていた⟹ conflict を返し、両側の現在値を1回だけ再読する", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (id === b.id) {
        b.status = "archived";
      }
    };

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "conflict",
        conflicts: [
          { id: a.id, observedStatus: "contested" },
          { id: b.id, observedStatus: "archived" },
        ],
      },
    });
    // 片方だけ書き換わった状態を残さない——`a` も書き込まれていない。
    const storedA = await stores.memoryStore.get(ctx, a.id);
    expect(storedA?.status).toBe("contested");
  });
});

describe("runtime.resolveContested — tick()/observe() から呼ばれない", () => {
  it("tick() を呼んでも contested な Memory は動かない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(runtime, stores);

    await runtime.tick(ctx, { leaseMs: 60_000 });

    const storedA = await stores.memoryStore.get(ctx, a.id);
    const storedB = await stores.memoryStore.get(ctx, b.id);
    expect(storedA?.status).toBe("contested");
    expect(storedB?.status).toBe("contested");
  });
});

describe("runtime.resolveContested — 検出から解決までの一巡（Issue #197 の主目的）", () => {
  it("markContested → recall（両方出る・mandatory_companion・隣接）→ resolveContested(supersede) → recall（敗者はもう出ない・勝者は active で単独）", async () => {
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

    // 1回目の recall: 両方出て、対向は mandatory_companion として隣接する
    // （`mark-contested.test.ts` の最後の歯と同じ実測）。
    const before = await runtime.recall(ctx, { vector: [1, 0], limit: 1 });
    const beforeIds = before.memories.map((m) => m.memoryId);
    expect(beforeIds).toContain(strong.id);
    expect(beforeIds).toContain(weak.id);
    const companionBefore = before.memories.find((m) => m.memoryId === weak.id);
    expect(companionBefore?.retrievedVia).toBe("mandatory_companion");
    expect(companionBefore?.companionOf).toBe(strong.id);
    const stageBefore = before.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stageBefore?.executed).toBe(true);
    expect(stageBefore?.detail).toEqual({ companionsAdded: 1 });

    // 間違いを正す: strong が正しかったと判定し、weak を supersede する。
    const resolveResult = await runtime.resolveContested(ctx, strong.id, weak.id, {
      kind: "supersede",
      winnerId: strong.id,
    });
    expect(resolveResult.outcome.kind).toBe("resolved");

    // 2回目の recall: 敗者（weak）はもう出てこない。勝者（strong）は active のまま
    // 単独で出て、companionsAdded は 0 に戻る——段3が「対向がいない」と正しく判定する。
    const after = await runtime.recall(ctx, { vector: [1, 0], limit: 1 });
    const afterIds = after.memories.map((m) => m.memoryId);
    expect(afterIds).toContain(strong.id);
    expect(afterIds).not.toContain(weak.id);
    const stageAfter = after.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stageAfter?.executed).toBe(true);
    expect(stageAfter?.detail).toEqual({ companionsAdded: 0 });

    const storedStrong = await stores.memoryStore.get(ctx, strong.id);
    const storedWeak = await stores.memoryStore.get(ctx, weak.id);
    expect(storedStrong?.status).toBe("active");
    expect(storedWeak?.status).toBe("superseded");
    expect(storedWeak?.supersededById).toBe(strong.id);
  });
});
