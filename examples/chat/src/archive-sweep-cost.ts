import type { Ctx, EmbeddingProvider, Memory, MemoryStore, Runtime } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  buildArchiveSweepCostRunJson,
  buildArchiveSweepMeanJson,
  buildArchiveSweepProbeJson,
  buildArchiveSweepStoreJson,
  fillerBackdateMs,
} from "./archive-sweep-json.js";
import type {
  ArchiveSweepCostRunJson,
  ArchiveSweepEmbeddingSpaceJson,
  ArchiveSweepPhaseJson,
  ArchiveSweepRecallJson,
  ArchiveSweepRecallBudgetRungJson,
  ArchiveSweepResultJson,
  RawArchiveSweepProbeMeasurement,
} from "./archive-sweep-json.js";
import { drainEmbedTicks } from "./embed-drain.js";
import type { MutableClock } from "./mutable-clock.js";
import {
  DEFAULT_HAYSTACK_SIZE,
  PROBES,
  buildProbeSetConversation,
  goldExternalId,
} from "./probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";

/**
 * `archive-sweep-cost` サブコマンド(Issue #209)——「掃引(`Runtime.sweepArchive`、
 * ADR 0114)が北極星の物差しに効くか」を実測するベンチの、DB/LLM/embedding を
 * 要求する側。JSON の組み立て(型・平均の純関数)は `./archive-sweep-json.js` に
 * 委ねる——ここは「何を読むか」「いつ呼ぶか」だけを持つ(`consolidation-cost.ts`
 * と同じ分担)。
 *
 * **測る手順**:
 * 1. この bench 専用のテナントの `default_half_life_hours` を短く設定する
 *    (受け入れ条件1「half-life を短くした専用 arm」)。裁量の定数をそのまま
 *    JSON へ書かず、書き込んだ後に読み戻した実値を使う。
 * 2. gold/distractor は実時刻で ingest し、haystack(filler)だけを
 *    `decayFloorOffsetMs(halfLifeHours)` 分(+余裕)だけ過去へ backdate して
 *    ingest する(`MutableClock` を注入する。`time-term-arm.ts` と同じ仕掛け)。
 *    ⟹ filler の `decayFloorAt` だけが実行時点の実時刻より前になり、
 *    gold/distractor の `decayFloorAt` は実時刻よりずっと先になる。
 * 3. before を測る(掃引前。`archivedCount` は常に0のはず)。
 * 4. `runtime.sweepArchive()` を実時刻で呼ぶ。
 * 5. after を測る(掃引後)。
 */

/** `MemoryStore` は `@mnemora/postgres` 経由なので `pool` の型はそこから借りる
 *  (`embed-failure-kind.ts` と同じ理由——`pg` への phantom dependency を作らない)。 */
type Pool = PostgresClient["pool"];

export interface RunArchiveSweepCostOptions {
  runtime: Runtime;
  memoryStore: MemoryStore;
  embeddingProvider: EmbeddingProvider;
  pool: Pool;
  /** filler の ingest だけを backdate するために注入する(`createExampleRuntime` の
   *  第4引数と同じインスタンスであること)。 */
  clock: MutableClock;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  tenantId: string;
  /** この bench 専用テナントに設定する `default_half_life_hours`(裁量値)。 */
  halfLifeHours: number;
  /** filler の backdate 量に上乗せる余裕(時間)。 */
  marginHours: number;
  /** `runtime.sweepArchive` の `limit`。 */
  sweepLimit: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  measuredAt: Date;
  commit: string | null;
  /** 既定は `DEFAULT_HAYSTACK_SIZE`(`probe-set.ts`、既存 `retrieval`/`consolidation-cost` と同じ既定)。 */
  haystackSize?: number;
}

/**
 * この bench 専用テナントの `tenant_settings.default_half_life_hours` を設定し、
 * 読み戻した実値を返す。
 *
 * `TenantSettingsStore`(`@mnemora/core`)にはこの列を書く公開の口が無い
 * (`getDefaultHalfLifeHours` のみで、設定できるのは `event_retention_days` だけ)。
 * ⟹ `packages/core`/`packages/postgres` を変更せずにこの bench を作るため、
 * `embed-failure-kind.ts` の `lookupLatestEmbedFailureKind` と同じやり方
 * (`pool.query` への素の SQL)でこの bench 専用テナントの行だけを UPSERT する。
 */
async function setTenantHalfLifeHours(
  pool: Pool,
  tenantId: string,
  halfLifeHours: number,
): Promise<number> {
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, default_half_life_hours, updated_at)
       VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET default_half_life_hours = EXCLUDED.default_half_life_hours, updated_at = now()`,
    [tenantId, halfLifeHours],
  );
  const result = await pool.query<{ default_half_life_hours: number }>(
    `SELECT default_half_life_hours FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `setTenantHalfLifeHours: 書き込んだはずの tenant_settings 行が読めない(tenantId=${tenantId})`,
    );
  }
  return row.default_half_life_hours;
}

interface StoreSnapshot {
  json: ArchiveSweepPhaseJson["store"];
}

/** `consolidation-cost.ts` の `measureStore` と同じ形。`archived` バケットを追加で数える。 */
export async function measureStore(
  memoryStore: MemoryStore,
  ctx: Ctx,
  allIds: readonly string[],
): Promise<StoreSnapshot> {
  const memories = await memoryStore.getMany(ctx, [...allIds]);
  const byStatus = new Map<string, Memory[]>();
  for (const memory of memories) {
    const bucket = byStatus.get(memory.status) ?? [];
    bucket.push(memory);
    byStatus.set(memory.status, bucket);
  }
  const active = byStatus.get("active") ?? [];
  const superseded = byStatus.get("superseded") ?? [];
  const archived = byStatus.get("archived") ?? [];
  // この bench は `forget`/`consolidate`/`contest` を一切呼ばないので、
  // active/superseded/archived 以外の status を持つ Memory はここに現れない想定である
  // (superseded 自体も本来0のはず——出た場合は allContentChars にだけ含め、隠さない)。
  const allContentChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  return {
    json: buildArchiveSweepStoreJson({
      activeContentsAndDigests: active.map((m) => ({ content: m.content, digest: m.digest })),
      supersededCount: superseded.length,
      archivedCount: archived.length,
      allContentChars,
    }),
  };
}

async function measureProbe(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  probeId: string,
  query: string,
  budget: { maxMemoryTokens: number } | undefined,
  limit: number | undefined,
): Promise<RawArchiveSweepProbeMeasurement> {
  const result = await runtime.recall(
    ctx,
    budget !== undefined ? { text: query, limit, budget } : { text: query },
  );
  const resolvedExternalIds = await Promise.all(
    result.memories.map((m) => resolveExternalId(memoryStore, ctx, m.memoryId)),
  );
  const goldIndex = resolvedExternalIds.indexOf(goldExternalId(probeId));
  const goldRank = goldIndex === -1 ? null : goldIndex + 1;
  let omittedArchivedCount = 0;
  for (const omission of result.omitted) {
    if (omission.kind === "filtered" && omission.condition === "archived") {
      omittedArchivedCount += omission.count;
    }
  }
  return {
    probeId,
    memoryDigests: result.memories.map((m) => m.digest),
    goldRank,
    totalInScope: result.index.totalInScope,
    omittedKinds: result.omitted.map((o) => o.kind),
    omittedArchivedCount,
    usageChars: result.usage.chars,
    usageEstimatedTokens: result.usage.estimatedTokens,
    usageIndexChars: result.usage.indexChars,
    budgetExceeded: result.usage.budgetExceeded ?? false,
  };
}

/** `consolidation-cost.ts` の `measureRecallForRound` と同じ形(round ではなく phase 単位)。 */
export async function measureRecallForPhase(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  activeCount: number,
  budgetLadder: readonly number[],
  recallLimit: number,
): Promise<ArchiveSweepRecallJson> {
  const unbudgetedRaw = await Promise.all(
    PROBES.map((probe) =>
      measureProbe(runtime, memoryStore, ctx, probe.id, probe.query, undefined, undefined),
    ),
  );
  const unbudgetedProbes = unbudgetedRaw.map((raw) => buildArchiveSweepProbeJson(raw, activeCount));

  const budgeted: ArchiveSweepRecallBudgetRungJson[] = [];
  for (const budgetTokens of budgetLadder) {
    const rungRaw = await Promise.all(
      PROBES.map((probe) =>
        measureProbe(
          runtime,
          memoryStore,
          ctx,
          probe.id,
          probe.query,
          { maxMemoryTokens: budgetTokens },
          recallLimit,
        ),
      ),
    );
    const rungProbes = rungRaw.map((raw) => buildArchiveSweepProbeJson(raw, activeCount));
    budgeted.push({
      budgetTokens,
      probes: rungProbes,
      mean: buildArchiveSweepMeanJson(rungProbes),
    });
  }

  return {
    unbudgeted: { probes: unbudgetedProbes, mean: buildArchiveSweepMeanJson(unbudgetedProbes) },
    budgeted,
  };
}

/**
 * この関数は常に `status: "measured"` を返す(重み取得の失敗は `cli.ts` の
 * `warmupLocalEmbedding` の段で打ち切られる。`consolidation-cost.ts` の
 * `runConsolidationCost` と同じ切り分け)。
 */
export async function runArchiveSweepCost(
  options: RunArchiveSweepCostOptions,
): Promise<Extract<ArchiveSweepCostRunJson, { status: "measured" }>> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const haystackSize = options.haystackSize ?? DEFAULT_HAYSTACK_SIZE;

  const halfLifeHours = await setTenantHalfLifeHours(
    options.pool,
    options.tenantId,
    options.halfLifeHours,
  );
  const backdateMs = fillerBackdateMs(halfLifeHours, options.marginHours);

  const utterances = buildProbeSetConversation(haystackSize);
  const allIds: string[] = [];

  // ⚠ 1点に凍結する(`time-term-arm.ts` の `runOneProbe` と同じ理由)——
  // member ごとに `new Date()` を取り直すと、gold/distractor 間・filler 間に
  // ミリ秒差が残り、この bench が動かすつもりの無い軸(decay)にノイズが乗る。
  const realNow = new Date();
  const backdated = new Date(realNow.getTime() - backdateMs);

  for (const utterance of utterances) {
    options.clock.set(utterance.kind === "haystack" ? backdated : realNow);
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    allIds.push(...observed.memoryIds);
  }

  // ⭐ recall/tick の直前に必ず実時刻へ戻す——`outbox.available_at` は Postgres の
  // 実時刻で入るため、Clock を過去に置いたままだと embed ジョブが1件も claim
  // されない(`mutable-clock.ts` の docstring、`time-term-arm.ts` で実測済みの罠)。
  const afterIngest = new Date();
  options.clock.set(afterIngest);
  await drainEmbedTicks(options.runtime, ctx);

  const embeddingSpace: ArchiveSweepEmbeddingSpaceJson = { ...options.embeddingProvider.space };

  const beforeStore = await measureStore(options.memoryStore, ctx, allIds);
  const beforeRecall = await measureRecallForPhase(
    options.runtime,
    options.memoryStore,
    ctx,
    beforeStore.json.activeCount,
    options.budgetLadder,
    options.recallLimit,
  );
  const before: ArchiveSweepPhaseJson = { store: beforeStore.json, recall: beforeRecall };

  const sweepNow = new Date();
  const sweepResult = await options.runtime.sweepArchive(ctx, {
    now: sweepNow,
    limit: options.sweepLimit,
  });
  const sweep: ArchiveSweepResultJson = {
    supported: sweepResult.supported,
    limit: options.sweepLimit,
    archivedCount: sweepResult.archived.length,
    reachedLimit: sweepResult.reachedLimit,
  };

  const afterStore = await measureStore(options.memoryStore, ctx, allIds);
  const afterRecall = await measureRecallForPhase(
    options.runtime,
    options.memoryStore,
    ctx,
    afterStore.json.activeCount,
    options.budgetLadder,
    options.recallLimit,
  );
  const after: ArchiveSweepPhaseJson = { store: afterStore.json, recall: afterRecall };

  return buildArchiveSweepCostRunJson({
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace,
    probeCount: PROBES.length,
    haystackSize,
    halfLifeHours,
    budgetLadder: options.budgetLadder,
    recallLimit: options.recallLimit,
    sweep,
    before,
    after,
    measuredAt: options.measuredAt,
    commit: options.commit,
  });
}
