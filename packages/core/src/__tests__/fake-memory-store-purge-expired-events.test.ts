import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.purgeExpiredEvents`（Issue #210 / ADR 0115）の歯。
 *
 * **`packages/testkit` の適合テストの対象ではない。** `FakeMemoryStore` は
 * `packages/core` 自身の runtime テスト専用の別系統であり（`runtime-fakes.ts` 冒頭の
 * コメント、`fake-memory-store-supersede-with-new-memories.test.ts` と同じ構造）。
 * `packages/testkit` の `InMemoryMemoryStore` の同名メソッドは
 * `memory-store-conformance.ts` が別途検査する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const otherCtx: Ctx = { tenantId: "tenant-2" };

describe("FakeMemoryStore.purgeExpiredEvents（Issue #210 / ADR 0115）", () => {
  it("olderThan より古い行だけを消し、境界（at === olderThan）は残す", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "purge-fixture",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });

    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    await eventStore.append(ctx, {
      tenantId: "tenant-1",
      memoryId: memory.id,
      kind: "updated",
      at: new Date(cutoff.getTime() - 1000),
      actor: { type: "system" },
      meta: {},
    });
    await eventStore.append(ctx, {
      tenantId: "tenant-1",
      memoryId: memory.id,
      kind: "updated",
      at: cutoff,
      actor: { type: "system" },
      meta: {},
    });

    const result = await memoryStore.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });

    expect(result.purged).toBe(1);
    expect(result.reachedLimit).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.oldestPurgedAt).toEqual(new Date(cutoff.getTime() - 1000));
    expect(result.newestPurgedAt).toEqual(new Date(cutoff.getTime() - 1000));

    // 境界の行（at === cutoff）だけが残る。`purged > 0` なので `events_purged` の要約行が
    // 1件追加で積まれる——「全部」を数えると2件になる（それ自体が別のテストの主題）ため、
    // ここでは「元の行」だけを見るために kind で絞る。
    const remainingOriginal = (await eventStore.list(ctx, {})).filter(
      (e) => e.kind !== "events_purged",
    );
    expect(remainingOriginal).toHaveLength(1);
    expect(remainingOriginal[0]?.at).toEqual(cutoff);
  });

  it("dryRun のときは1行も消さず、events_purged も積まない", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "purge-dry-run-fixture",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const oldAt = new Date("2024-01-01T00:00:00.000Z");
    await eventStore.append(ctx, {
      tenantId: "tenant-1",
      memoryId: memory.id,
      kind: "updated",
      at: oldAt,
      actor: { type: "system" },
      meta: {},
    });

    const result = await memoryStore.purgeExpiredEvents!(ctx, {
      olderThan: new Date("2024-06-01T00:00:00.000Z"),
      limit: 10,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.purged).toBe(1);
    expect(await eventStore.list(ctx, {})).toHaveLength(1);
    expect(await eventStore.list(ctx, { kind: "events_purged" })).toHaveLength(0);
  });

  it("テナント越境しない", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memoryA = await memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "purge-cross-a",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const memoryB = await memoryStore.createMemory(otherCtx, {
      tenantId: "tenant-2",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "purge-cross-b",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const oldAt = new Date("2024-01-01T00:00:00.000Z");
    await eventStore.append(ctx, {
      tenantId: "tenant-1",
      memoryId: memoryA.id,
      kind: "updated",
      at: oldAt,
      actor: { type: "system" },
      meta: {},
    });
    await eventStore.append(otherCtx, {
      tenantId: "tenant-2",
      memoryId: memoryB.id,
      kind: "updated",
      at: oldAt,
      actor: { type: "system" },
      meta: {},
    });

    const result = await memoryStore.purgeExpiredEvents!(ctx, {
      olderThan: new Date("2024-06-01T00:00:00.000Z"),
      limit: 10,
    });

    expect(result.purged).toBe(1);
    // tenant-1 に元々あった行は消え、代わりに events_purged の要約が1件積まれる
    // （purged > 0 のため）。「越境していない」ことの主眼は tenant-2 側が無傷なこと。
    const tenant1Remaining = await eventStore.list(ctx, {});
    expect(tenant1Remaining).toHaveLength(1);
    expect(tenant1Remaining[0]?.kind).toBe("events_purged");
    expect(await eventStore.list(otherCtx, {})).toHaveLength(1);
    expect((await eventStore.list(otherCtx, {}))[0]?.kind).toBe("updated");
  });

  it("limit を超えた対象を reachedLimit: true で知らせ、超えない呼び出しでは false になる", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "purge-limit-fake",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const base = new Date("2024-01-01T00:00:00.000Z").getTime();
    // 5件、すべて cutoff より古い。
    for (let i = 0; i < 5; i++) {
      await eventStore.append(ctx, {
        tenantId: "tenant-1",
        memoryId: memory.id,
        kind: "updated",
        at: new Date(base + i * 1000),
        actor: { type: "system" },
        meta: {},
      });
    }
    const cutoff = new Date(base + 10_000);

    const first = await memoryStore.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 3 });
    expect(first.purged).toBe(3);
    expect(first.reachedLimit).toBe(true);
    // 最も古い3件（i=0,1,2）が消え、i=3,4 が残る。
    expect(first.oldestPurgedAt).toEqual(new Date(base));
    expect(first.newestPurgedAt).toEqual(new Date(base + 2000));

    const second = await memoryStore.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });
    expect(second.purged).toBe(2);
    expect(second.reachedLimit).toBe(false);

    const remainingOriginal = (await eventStore.list(ctx, {})).filter(
      (e) => e.kind !== "events_purged",
    );
    expect(remainingOriginal).toHaveLength(0);
  });

  it("kind='events_purged' 自身を対象から除外する（無限後退を避ける）", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "purge-no-regress-fake",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const veryOld = new Date("2020-01-01T00:00:00.000Z");
    // 以前の掃除が積んだ古い events_purged 行を直接仕込む。
    await eventStore.append(ctx, {
      tenantId: "tenant-1",
      memoryId: null,
      kind: "events_purged",
      at: veryOld,
      actor: { type: "system" },
      meta: { purgedCount: 1, oldestPurgedAt: veryOld, newestPurgedAt: veryOld },
    });
    // 掃除対象になりうる普通のイベントも1件。
    await eventStore.append(ctx, {
      tenantId: "tenant-1",
      memoryId: memory.id,
      kind: "updated",
      at: veryOld,
      actor: { type: "system" },
      meta: {},
    });

    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    const result = await memoryStore.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });

    // 対象は普通のイベント1件だけ——仕込んだ古い events_purged は除外される。
    expect(result.purged).toBe(1);

    const purgedEvents = await eventStore.list(ctx, { kind: "events_purged" });
    // 仕込んだ古い events_purged（1件）+ 今回の掃除が積んだ新しい events_purged（1件）= 2件。
    // 仕込んだ方が消えていたら1件のままになる。
    expect(purgedEvents).toHaveLength(2);
    expect(purgedEvents.some((e) => e.at.getTime() === veryOld.getTime())).toBe(true);
  });
});
