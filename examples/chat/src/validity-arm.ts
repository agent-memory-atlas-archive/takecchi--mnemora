import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import {
  VALIDITY_PROBES,
  buildValidityConversation,
  currentExternalId,
  historicalValidAt,
  otherExternalId,
} from "./validity-probe-set.js";
import type { ValidityProbe } from "./validity-probe-set.js";

/**
 * `RecallQuery.validAt` ゲート（Issue #280、Issue #202 第2弾）を測る arm(PR 本文)。
 *
 * **ペアの本文を厳密に同一にする**（`time-term-arm.ts` と同じ設計思想）。⟹ `similarity`
 * は構成上ぴったり同じになるので、recall に候補として残るかどうかの違いは
 * `validFrom`/`validUntil`/`validAt` 由来だとしか説明できない。
 *
 * **書く経路は `Runtime.observe()` の `validFrom`/`validUntil`（マネージャー決定4）を使う**
 * ——`MemoryStore` を直に叩かない。これは、issue が要求する「書き口が端から端まで通る」
 * ことの実演そのものである。
 *
 * **probe ごとに別テナントを使う**（`time-term-arm.ts` と同じ理由——スコープ内にその
 * ペアの2件だけを置き、`limit`/`scoreThreshold` の外に落ちる可能性や語彙的な競合を消す）。
 */

export interface ValidityMemberOutcome {
  /** 既定（`validAt` 省略 = いま）の recall にこの member が含まれたか。 */
  returnedAtNow: boolean;
}

export interface ValidityHistoricalCheck {
  /** 過去の `validAt` を指定した recall。 */
  validAt: Date;
  currentReturned: boolean;
  otherReturned: boolean;
  omittedConditions: string[];
}

export interface ValidityOptOutCheck {
  currentReturned: boolean;
  otherReturned: boolean;
}

export interface ValidityProbeOutcome {
  probeId: string;
  otherReason: ValidityProbe["otherReason"];
  current: ValidityMemberOutcome;
  other: ValidityMemberOutcome;
  /** 既定の recall で `omitted` に積まれた `filtered` の `condition` 一覧。 */
  omittedConditionsAtNow: string[];
  /** `probe.historicalValidAtDaysAgo` を持つ probe だけ在る（受け入れ条件1）。 */
  historical: ValidityHistoricalCheck | null;
  /** `includeOutsideValidity: true` の recall（ゲートの明示的な opt-out）。 */
  optOut: ValidityOptOutCheck;
  totalInScope: number;
}

export interface ValidityArmReport {
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  now: Date;
  probes: ValidityProbeOutcome[];
}

export interface RunValidityArmOptions {
  armLabel: string;
  tenantIdPrefix: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** 既定は `new Date()`。検査から固定できるように受ける。 */
  now?: Date;
}

async function memoryIdsByExternalId(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memoryIds: string[],
): Promise<string[]> {
  return Promise.all(memoryIds.map((id) => resolveExternalId(memoryStore, ctx, id))).then(
    (resolved) => resolved.filter((id): id is string => id !== null),
  );
}

async function runOneProbe(
  probe: ValidityProbe,
  options: RunValidityArmOptions,
  now: Date,
): Promise<ValidityProbeOutcome> {
  const ctx: Ctx = { tenantId: `${options.tenantIdPrefix}-${probe.id}` };
  const utterances = buildValidityConversation(probe, now);

  // ⭐ 書く経路は Runtime.observe() の validFrom/validUntil（マネージャー決定4）。
  for (const utterance of utterances) {
    await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
      ...(utterance.validFrom !== undefined ? { validFrom: utterance.validFrom } : {}),
      ...(utterance.validUntil !== undefined ? { validUntil: utterance.validUntil } : {}),
    });
  }

  await drainEmbedTicks(options.runtime, ctx);

  const currentId = currentExternalId(probe.id);
  const otherId = otherExternalId(probe.id);

  // 既定（validAt 省略 = いま）。
  const atNow = await options.runtime.recall(ctx, { text: probe.query });
  const atNowExternalIds = await memoryIdsByExternalId(
    options.memoryStore,
    ctx,
    atNow.memories.map((m) => m.memoryId),
  );
  const omittedConditionsAtNow = atNow.omitted
    .filter((o): o is Extract<typeof o, { kind: "filtered" }> => o.kind === "filtered")
    .map((o) => o.condition);

  // 受け入れ条件1: 過去の validAt を指定すると、その時点で真だった記憶が返る。
  let historical: ValidityHistoricalCheck | null = null;
  const validAt = historicalValidAt(probe, now);
  if (validAt !== undefined) {
    const atValidAt = await options.runtime.recall(ctx, { text: probe.query, validAt });
    const atValidAtExternalIds = await memoryIdsByExternalId(
      options.memoryStore,
      ctx,
      atValidAt.memories.map((m) => m.memoryId),
    );
    historical = {
      validAt,
      currentReturned: atValidAtExternalIds.includes(currentId),
      otherReturned: atValidAtExternalIds.includes(otherId),
      omittedConditions: atValidAt.omitted
        .filter((o): o is Extract<typeof o, { kind: "filtered" }> => o.kind === "filtered")
        .map((o) => o.condition),
    };
  }

  // includeOutsideValidity: true — ゲートの明示的な opt-out。
  const optOutResult = await options.runtime.recall(ctx, {
    text: probe.query,
    includeOutsideValidity: true,
  });
  const optOutExternalIds = await memoryIdsByExternalId(
    options.memoryStore,
    ctx,
    optOutResult.memories.map((m) => m.memoryId),
  );

  return {
    probeId: probe.id,
    otherReason: probe.otherReason,
    current: { returnedAtNow: atNowExternalIds.includes(currentId) },
    other: { returnedAtNow: atNowExternalIds.includes(otherId) },
    omittedConditionsAtNow,
    historical,
    optOut: {
      currentReturned: optOutExternalIds.includes(currentId),
      otherReturned: optOutExternalIds.includes(otherId),
    },
    totalInScope: atNow.index.totalInScope,
  };
}

export async function runValidityArm(options: RunValidityArmOptions): Promise<ValidityArmReport> {
  const now = options.now ?? new Date();
  const probes: ValidityProbeOutcome[] = [];
  for (const probe of VALIDITY_PROBES) {
    probes.push(await runOneProbe(probe, options, now));
  }
  return {
    armLabel: options.armLabel,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    now,
    probes,
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

export function formatValidityReport(report: ValidityArmReport): string {
  const lines: string[] = [];
  lines.push(`=== validity arm ${report.armLabel} ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(`now: ${report.now.toISOString()}`);
  for (const p of report.probes) {
    lines.push(`  - ${p.probeId} (otherReason=${p.otherReason}):`);
    lines.push(
      `      いま: current=${p.current.returnedAtNow ? "返った" : "返らない"} ` +
        `other=${p.other.returnedAtNow ? "返った" : "返らない"} ` +
        `omitted=[${p.omittedConditionsAtNow.join(",")}] totalInScope=${p.totalInScope}`,
    );
    if (p.historical) {
      lines.push(
        `      過去(validAt=${p.historical.validAt.toISOString()}): ` +
          `current=${p.historical.currentReturned ? "返った" : "返らない"} ` +
          `other=${p.historical.otherReturned ? "返った" : "返らない"} ` +
          `omitted=[${p.historical.omittedConditions.join(",")}]`,
      );
    }
    lines.push(
      `      includeOutsideValidity: current=${p.optOut.currentReturned ? "返った" : "返らない"} ` +
        `other=${p.optOut.otherReturned ? "返った" : "返らない"}`,
    );
  }
  return lines.join("\n");
}
