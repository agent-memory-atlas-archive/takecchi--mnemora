import type { Ctx, MemoryStore, RecallAssociationQuery, Runtime } from "@mnemora/core";
import {
  ASSOCIATION_PROBES,
  associationAnchorExternalId,
  associationDistractorExternalId,
  associationGoldExternalId,
  buildAssociationProbeSetConversation,
} from "./association-probe-set.js";
import type { AssociationProbe } from "./association-probe-set.js";
import { drainEmbedTicks } from "./embed-drain.js";
import { resolveExternalId } from "./provenance-trace.js";

/**
 * 連想枠（段3.5、ADR 0151、Issue #200）が想起の質を動かすかを測る arm（Issue #291）。
 *
 * **`./identifier-arm.ts` / `./retrieval-quality.ts` の `runRetrievalQualityArm` と同じ形**
 * （probe set を1本の会話に ingest → probe ごとに `recall()` を1回投げて順位を測る）だが、
 * この probe set（`./association-probe-set.js`）は**query だけでは gold に届かない**よう
 * 設計されている（三角形: `query ≈ anchor` / `anchor ≈ gold` / `query ≉ gold`）。⟹
 * `hit@10` は連想枠の効果を測れない（gold は本体の11位以降にしか現れない、
 * `recall-runtime.ts` の段3.5の doc 参照）。この arm が主に見るのは
 * `goldReturned`/`goldRank`/`mrr`/`goldRetrievedVia` である。
 *
 * ⛔ **`recall()` には `text` と `association` 以外を渡さない**
 * （`retrieval-quality.ts` の `runRetrievalQualityArm` と同じ規律。閾値・limit・
 * overFetchFactor は `packages/core` の既定値のまま）。
 */

export interface AssociationProbeOutcome {
  probeId: string;
  /** `AssociationProbe.category`（3カテゴリ×4件）。 */
  category: AssociationProbe["category"];
  /** `recall().memories` の中の gold の順位（1始まり）。居なければ null。 */
  goldRank: number | null;
  /** 同じ順位付けでの anchor の順位。 */
  anchorRank: number | null;
  /** 同じ順位付けでの distractor の順位。 */
  distractorRank: number | null;
  /** gold が返っていたときの `RecalledMemory.retrievedVia`。返っていなければ null。 */
  goldRetrievedVia: "ann" | "lexical" | "mandatory_companion" | "association" | null;
  /**
   * gold が `retrievedVia: "association"` で、`associationOf`（アンカーの memoryId）を
   * externalId へ解決できた場合はその値。解決できなければ memoryId のまま。
   * `associationOf` 自体が無ければ null。
   */
  goldAssociationOf: string | null;
  /** `goldRetrievedVia === "association"` かつ、そのアンカーがこの probe 自身の anchor か。 */
  goldAnchoredOnProbeAnchor: boolean;
  /** `recall().memories` の件数。 */
  returnedCount: number;
  /** `usage.chars`（返した全量、tier 合計）。 */
  memoryChars: number;
  /** `usage.byTier.association`（連想が焼いた digest 文字数）。渡していなければ 0。 */
  associationChars: number;
  hit1: boolean;
  /** `goldRank !== null && goldRank <= 10`。 */
  hit10: boolean;
  goldReturned: boolean;
  reciprocalRank: number;
  /** この probe の `omitted` に出た `stage_skipped{stage:"association"}` の reason。無ければ null。 */
  stageSkipped: string | null;
}

export interface AssociationArmReport {
  armLabel: string;
  /** `options.association` を渡したかどうか。 */
  associationEnabled: boolean;
  /** `options.association?.maxCount`。渡していなければ null。 */
  associationMaxCount: number | null;
  probeCount: number;
  /** ingest した発話の総数（anchor+gold+distractor × probe数 + haystack）。 */
  ingestedCount: number;
  goldReturnedCount: number;
  hit1Count: number;
  hit10Count: number;
  /** `goldRetrievedVia === "association"` だった probe の件数。 */
  goldViaAssociationCount: number;
  mrr: number;
  returnedMemoryTotal: number;
  memoryCharsTotal: number;
  associationCharsTotal: number;
  /** stage_skipped(stage:"association") の reason → 件数。 */
  stageSkippedReasons: Record<string, number>;
  probes: AssociationProbeOutcome[];
}

export interface RunAssociationArmOptions {
  runtime: Runtime;
  memoryStore: MemoryStore;
  tenantId: string;
  armLabel: string;
  /** 渡さなければ連想枠は一切走らない（`RecallQuery.association` の既定 off）。 */
  association?: { maxCount: number };
  /** 既定は `./association-probe-set.js` の `DEFAULT_HAYSTACK_SIZE`。 */
  haystackSize?: number;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function runAssociationArm(
  options: RunAssociationArmOptions,
): Promise<AssociationArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const utterances = buildAssociationProbeSetConversation(options.haystackSize);

  for (const utterance of utterances) {
    await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
  }

  await drainEmbedTicks(options.runtime, ctx);

  const association: RecallAssociationQuery | undefined = options.association
    ? { maxCount: options.association.maxCount }
    : undefined;

  const probes: AssociationProbeOutcome[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    // ⛔ `text`/`association` 以外を渡さない(既存 arm と同じ規律)——閾値・limit・
    // overFetchFactor は一切変えない。
    const result = await options.runtime.recall(ctx, {
      text: probe.query,
      ...(association ? { association } : {}),
    });

    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldExternalIdValue = associationGoldExternalId(probe.id);
    const anchorExternalIdValue = associationAnchorExternalId(probe.id);
    const distractorExternalIdValue = associationDistractorExternalId(probe.id);

    const goldIndex = resolvedExternalIds.indexOf(goldExternalIdValue);
    const anchorIndex = resolvedExternalIds.indexOf(anchorExternalIdValue);
    const distractorIndex = resolvedExternalIds.indexOf(distractorExternalIdValue);

    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const anchorRank = anchorIndex === -1 ? null : anchorIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;

    const goldMemory = goldIndex === -1 ? null : result.memories[goldIndex]!;
    const goldRetrievedVia = goldMemory ? goldMemory.retrievedVia : null;

    let goldAssociationOf: string | null = null;
    if (goldMemory && goldMemory.associationOf !== undefined) {
      const resolved = await resolveExternalId(options.memoryStore, ctx, goldMemory.associationOf);
      goldAssociationOf = resolved ?? goldMemory.associationOf;
    }
    const goldAnchoredOnProbeAnchor =
      goldRetrievedVia === "association" && goldAssociationOf === anchorExternalIdValue;

    const stageSkippedEntry = result.omitted.find(
      (o) => o.kind === "stage_skipped" && o.stage === "association",
    );
    const stageSkipped =
      stageSkippedEntry && stageSkippedEntry.kind === "stage_skipped"
        ? stageSkippedEntry.reason
        : null;

    probes.push({
      probeId: probe.id,
      category: probe.category,
      goldRank,
      anchorRank,
      distractorRank,
      goldRetrievedVia,
      goldAssociationOf,
      goldAnchoredOnProbeAnchor,
      returnedCount: result.memories.length,
      memoryChars: result.usage.chars,
      associationChars: result.usage.byTier.association ?? 0,
      hit1: goldRank === 1,
      hit10: goldRank !== null && goldRank <= 10,
      goldReturned: goldRank !== null,
      reciprocalRank: goldRank !== null ? 1 / goldRank : 0,
      stageSkipped,
    });
  }

  const stageSkippedReasons: Record<string, number> = {};
  for (const p of probes) {
    if (p.stageSkipped !== null) {
      stageSkippedReasons[p.stageSkipped] = (stageSkippedReasons[p.stageSkipped] ?? 0) + 1;
    }
  }

  return {
    armLabel: options.armLabel,
    associationEnabled: association !== undefined,
    associationMaxCount: options.association?.maxCount ?? null,
    probeCount: probes.length,
    ingestedCount: utterances.length,
    goldReturnedCount: probes.filter((p) => p.goldReturned).length,
    hit1Count: probes.filter((p) => p.hit1).length,
    hit10Count: probes.filter((p) => p.hit10).length,
    goldViaAssociationCount: probes.filter((p) => p.goldRetrievedVia === "association").length,
    mrr: average(probes.map((p) => p.reciprocalRank)),
    returnedMemoryTotal: probes.reduce((sum, p) => sum + p.returnedCount, 0),
    memoryCharsTotal: probes.reduce((sum, p) => sum + p.memoryChars, 0),
    associationCharsTotal: probes.reduce((sum, p) => sum + p.associationChars, 0),
    stageSkippedReasons,
    probes,
  };
}
