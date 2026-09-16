import type {
  EmbeddingProvider,
  Memory,
  MemoryStore,
  Runtime,
  TenantSettingsStore,
} from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import { describe, expect, it, vi } from "vitest";
import { runArchiveSweepCost } from "../archive-sweep-cost.js";
import { createMutableClock } from "../mutable-clock.js";

/**
 * `runArchiveSweepCost()` に `decayClock` を渡したときだけ `writeDecayClock`
 * （`@mnemora/core`。実体は `store.setDecayClock`）が呼ばれることを、DB/LLM/embedding を
 * 実物で叩かずに検査する（ADR 0165 決めたこと11）。
 *
 * **`consolidation-cost-abort.test.ts` と同じやり方**——`RunArchiveSweepCostOptions` の
 * `runtime`/`memoryStore`/`embeddingProvider`/`pool` を最小の偽物で埋め、
 * `runArchiveSweepCost()` を直接呼ぶ。`haystackSize: 0` にして gold/distractor 14件
 * だけの最小構成にし、`budgetLadder: []` で unbudgeted 分の recall だけに絞る。
 *
 * 偽物が実装するのは、この経路で実際に呼ばれると確認した口だけ:
 * - `runtime.observe`/`tick` — ingest 段(gold/distractor 14件)。
 * - `runtime.recall` — `memories: []` を返し、`resolveExternalId` 経由の
 *   `memoryStore.get`/`getObservation` が呼ばれない経路を選ぶ
 *   （`consolidation-cost-abort.test.ts` と同じ切り分け）。
 * - `runtime.sweepArchive` — 何も archive しない偽の結果を返す。
 * - `memoryStore.getMany` — `measureStore` から。
 * - `embeddingProvider.space` — プロパティとして読まれるだけ。
 * - `pool.query` — `setTenantHalfLifeHours` の UPSERT + 読み戻しの2回。
 */

function fakeMemory(id: string): Memory {
  return {
    id,
    tenantId: "t",
    content: `content-${id}`,
    contentHash: `hash-${id}`,
    digest: `digest-${id}`,
    digestSource: "fallback",
    provenance: { kind: "stated" },
    status: "active",
    tags: [],
    recordedAt: new Date(0),
    strength: 1,
    halfLifeHours: 1,
    decayFloorAt: new Date(0),
    embeddingStatus: "ready",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as Memory;
}

function buildFakeRuntime(): Runtime {
  let nextObserveId = 0;
  const observe: Runtime["observe"] = async () => {
    nextObserveId += 1;
    return {
      observationId: `obs-${nextObserveId}`,
      memoryIds: [`mem-observe-${nextObserveId}`],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };
  const tick: Runtime["tick"] = async () =>
    ({ processed: 0, failed: 0, unsupported: [] }) as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;
  const recall: Runtime["recall"] = async () =>
    ({
      recallId: "recall-1",
      memories: [],
      omitted: [],
      index: { groups: [], totalInScope: 0, countKind: "exact" },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      explain: { stages: [] },
    }) as unknown as Awaited<ReturnType<Runtime["recall"]>>;
  const sweepArchive: Runtime["sweepArchive"] = async () =>
    ({ supported: true, archived: [], reachedLimit: false }) as unknown as Awaited<
      ReturnType<Runtime["sweepArchive"]>
    >;
  return { observe, tick, recall, sweepArchive } as unknown as Runtime;
}

function buildFakeMemoryStore(): MemoryStore {
  const getMany: MemoryStore["getMany"] = async (_ctx, ids) => ids.map((id) => fakeMemory(id));
  return { getMany } as unknown as MemoryStore;
}

function buildFakeEmbeddingProvider(): EmbeddingProvider {
  return {
    space: { provider: "fake", model: "fake-model", dimensions: 4 },
  } as unknown as EmbeddingProvider;
}

/** `setTenantHalfLifeHours`(archive-sweep-cost.ts)が撃つ INSERT→SELECT の2回に順に応える。 */
function buildFakePool(halfLifeHours: number): PostgresClient["pool"] {
  let call = 0;
  const query = vi.fn(async () => {
    call += 1;
    if (call === 1) {
      return { rows: [] };
    }
    return { rows: [{ default_half_life_hours: halfLifeHours }] };
  });
  return { query } as unknown as PostgresClient["pool"];
}

function baseOptions() {
  return {
    runtime: buildFakeRuntime(),
    memoryStore: buildFakeMemoryStore(),
    embeddingProvider: buildFakeEmbeddingProvider(),
    pool: buildFakePool(1),
    clock: createMutableClock(),
    llmMode: "deterministic" as const,
    embeddingMode: "local" as const,
    tenantId: "archive-sweep-cost-decay-clock-test",
    halfLifeHours: 1,
    marginHours: 0.5,
    sweepLimit: 1000,
    budgetLadder: [],
    recallLimit: 10,
    measuredAt: new Date(0),
    commit: null,
    haystackSize: 0,
  };
}

describe("runArchiveSweepCost: --decay-clock の有無で writeDecayClock の呼び出しが変わる(ADR 0165 決めたこと11)", () => {
  it("decayClock を渡さなければ setDecayClock は一度も呼ばれない(既定 'wall' を1バイトも変えない)", async () => {
    const setDecayClock = vi.fn();

    const json = await runArchiveSweepCost(baseOptions());

    expect(json.status).toBe("measured");
    expect(setDecayClock).not.toHaveBeenCalled();
  });

  it("decayClock を渡すと、この bench 専用テナントに1回だけ書き込まれる", async () => {
    const setDecayClock = vi.fn(async () => {});
    const tenantSettingsStore = { setDecayClock } as unknown as TenantSettingsStore;

    const options = baseOptions();
    const json = await runArchiveSweepCost({
      ...options,
      decayClock: { store: tenantSettingsStore, clock: "either" },
    });

    expect(json.status).toBe("measured");
    expect(setDecayClock).toHaveBeenCalledTimes(1);
    expect(setDecayClock).toHaveBeenCalledWith(
      { tenantId: "archive-sweep-cost-decay-clock-test" },
      "either",
    );
  });
});
