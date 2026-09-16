import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import type { FilteredOmission } from "../recall.js";
import { FILTERED_CONDITION_SCOPE_RELATION } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #352 / [ADR 0174](../../../../docs/decisions/0174-filtered-omission-scope-relation.md):
 * `FilteredOmission.condition` が分かれる2群（`scopeRelation`）の歯。
 *
 * **この歯が検査すること（2本）:**
 *
 * 1. `FILTERED_CONDITION_SCOPE_RELATION` が `FilteredOmission["condition"]` の
 *    **全メンバーを網羅している**こと。型（このファイル自身が持つ
 *    `Record<FilteredOmission["condition"], true>`）と、実行時（そのキー集合と
 *    `FILTERED_CONDITION_SCOPE_RELATION` のキー集合を突き合わせる）の両方で見る
 *    ——`omission-kind-generation.test.ts` が `Omission["kind"]` に対してやっている
 *    「二重の歯」と同じ形（型だけでは zod 側・実装側の緩みに気づけない）。
 * 2. `recall()` が実際に返す `omitted` の各 `filtered` エントリが、その `condition` に
 *    対応する `scopeRelation` を実際に持っていること——**本番の生成経路
 *    （`recall-runtime.ts`）を駆動して**確認する。値を手で組み立てて schema に通す
 *    だけでは、`recall-runtime.ts` 側が定数を読み忘れて別の値を push する事故を
 *    捕まえられない。
 *
 * **この歯の限界**: 各 `condition` について1状況ずつしか駆動していない
 * （`decayed`・`archived`・`superseded`・`forgotten`・`period`・`expired`・
 * `not_yet_valid` の7つ。`tenant`/`taxonomy` は本番コードが生成しない値であり
 * ADR 0117 の棚卸しの対象——ここでも駆動しない）。境界値・複数条件の組み合わせは
 * 個々の `recall-decay-gate.test.ts` / `recall-validity.test.ts` / `recall-pipeline.test.ts`
 * が持つ。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// 歯1: 網羅性（型 + 実行時）
// ---------------------------------------------------------------------------

describe("FILTERED_CONDITION_SCOPE_RELATION の網羅性", () => {
  // 型: このオブジェクトが `Record<FilteredOmission["condition"], true>` であること自体が、
  // `condition` の union に値を足したのにここへ足し忘れると tsc で落ちる
  // （`recall.test.ts` の `ALL_FILTERED_CONDITIONS` と同じ形。ここでは独立に持つ
  // ——`FILTERED_CONDITION_SCOPE_RELATION` 自身の宣言を検査対象にするテストが、
  // 同じ宣言を「正解」として借りると自明になってしまうため）。
  const ALL_FILTERED_CONDITIONS: Record<FilteredOmission["condition"], true> = {
    tenant: true,
    superseded: true,
    forgotten: true,
    archived: true,
    taxonomy: true,
    period: true,
    decayed: true,
    expired: true,
    not_yet_valid: true,
  };

  it("キー集合が FilteredOmission['condition'] の全値と実行時に一致する（型を緩める変異はここで赤くなる）", () => {
    const expectedKeys = Object.keys(ALL_FILTERED_CONDITIONS).sort();
    const actualKeys = Object.keys(FILTERED_CONDITION_SCOPE_RELATION).sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it.each(Object.keys(ALL_FILTERED_CONDITIONS) as FilteredOmission["condition"][])(
    "condition: %s は 'outside_scope' か 'within_scope' のどちらかを持つ",
    (condition) => {
      expect(["outside_scope", "within_scope"]).toContain(
        FILTERED_CONDITION_SCOPE_RELATION[condition],
      );
    },
  );

  it("decayed だけが within_scope である（他の6つは outside_scope）— Issue #352 の非対称そのもの", () => {
    const entries = Object.entries(FILTERED_CONDITION_SCOPE_RELATION) as [
      FilteredOmission["condition"],
      string,
    ][];
    const withinScope = entries.filter(([, rel]) => rel === "within_scope").map(([c]) => c);
    expect(withinScope).toEqual(["decayed"]);
  });
});

// ---------------------------------------------------------------------------
// 歯2: recall() が実際に返す omitted.filtered が、正しい scopeRelation を持つ
// ---------------------------------------------------------------------------

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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
    occurredAt: new Date("2026-03-01T00:00:00.000Z"),
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({ recordedAt, lastReinforcedAt: null, strength, halfLifeHours }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("recall() が返す omitted.filtered の scopeRelation（本番の生成経路を駆動する）", () => {
  it("archived/superseded/forgotten/period/expired/not_yet_valid/decayed の7条件すべてで、omitted.filtered の scopeRelation が FILTERED_CONDITION_SCOPE_RELATION と一致する", async () => {
    const { runtime, stores } = buildRuntime();

    await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "superseded" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt: new Date("2020-01-01T00:00:00.000Z") }), // period の外
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validUntil: new Date(NOW.getTime() - 1_000) }), // expired
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ validFrom: new Date(NOW.getTime() + 1_000) }), // not_yet_valid
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(NOW.getTime() - 1_000) }), // decayed
    );
    // スコープ内に残る「生きている」記憶も1件混ぜる——全部落ちて index が空、という
    // 縮退したケースにしない。
    await stores.memoryStore.createMemory(ctx, newMemory({}));

    const result = await runtime.recall(ctx, {
      occurredAfter: new Date("2026-01-01T00:00:00.000Z"),
    });

    const filteredOmissions = result.omitted.filter(
      (o): o is FilteredOmission => o.kind === "filtered",
    );
    // 前提: 期待した7条件が実際にすべて発生していること（fixture がずれていないことの検算）。
    const seenConditions = filteredOmissions.map((o) => o.condition).sort();
    expect(seenConditions).toEqual(
      [
        "archived",
        "decayed",
        "expired",
        "forgotten",
        "not_yet_valid",
        "period",
        "superseded",
      ].sort(),
    );

    // ⭐ 本題: 各エントリの scopeRelation が、唯一の出所である
    // FILTERED_CONDITION_SCOPE_RELATION と一致する。
    for (const omission of filteredOmissions) {
      expect(omission.scopeRelation).toBe(FILTERED_CONDITION_SCOPE_RELATION[omission.condition]);
    }

    // 非対称そのものも固定する: decayed だけ within_scope、残り6つは outside_scope。
    const decayedOmission = filteredOmissions.find((o) => o.condition === "decayed");
    expect(decayedOmission?.scopeRelation).toBe("within_scope");
    const outsideScopeOmissions = filteredOmissions.filter((o) => o.condition !== "decayed");
    for (const omission of outsideScopeOmissions) {
      expect(omission.scopeRelation).toBe("outside_scope");
    }
  });
});
