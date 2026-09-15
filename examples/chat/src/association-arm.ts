import type {
  Ctx,
  MemoryStore,
  RecallAssociationQuery,
  RecalledMemory,
  Runtime,
} from "@mnemora/core";
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
  /**
   * この probe の recall() が返した「連想由来」（`retrievedVia === "association"`）の
   * 候補を、返った順に並べたもの。⭐ **「なぜ gold が入らなかったか」を、後から
   * 説明できるようにするために記録する**（北極星の問い3）。
   */
  associationFrame: AssociationFrameEntry[];
  /**
   * ⭐ **同じストア・同じクエリで `recall()` をもう一度呼び直したとき、連想枠
   * （`retrievedVia === "association"` の候補列、externalId の並びとして）が
   * 完全一致したか**（Issue #291 フォローアップ）。
   *
   * CI で同一 commit を再実行したところ、12 probe 中 10 件で連想枠の構成員が
   * 入れ替わった。原因の候補は2つ: (甲) ingest ごとの差（毎回まっさらな Postgres へ
   * 入れ直すため memory id・物理配置・HNSW 索引の構築が毎回違う）、(乙) 同じストアへの
   * 引き直しでも変わる（こちらなら北極星の問い3「なぜ思い出したかを説明できるか」に
   * 直接刺さる）。この欄は、**同じ ingest 結果の中でだけ**この非決定性を切り分ける
   * ——`false` が出れば(乙)が確定し、`true` ばかりが出れば非決定性は ingest 側
   * （(甲)）に局在している可能性が高い、と読める。
   */
  repeatFrameIdentical: boolean;
  /** 2回目の `recall()` で `goldRank`（`null` を含む）が一致したか。 */
  repeatGoldRankSame: boolean;
}

export interface AssociationFrameEntry {
  /** `resolveExternalId` で解決した externalId。解決できなければ memoryId のまま。 */
  externalId: string;
  /** 返り値全体での順位（1始まり）。 */
  rank: number;
  /**
   * この externalId が、probe 体系の中で何だったか。
   * - `"own-gold"` … この probe の gold
   * - `"own-anchor"` … この probe の anchor（⚠ ADR 0151 は「アンカー自身は除く」と
   *   決めているので、本来ここには現れない。現れたら実装か理解のどちらかが間違っている）
   * - `"own-distractor"` … この probe の distractor
   * - `"other-probe"` … 別 probe の anchor/gold/distractor（どれかは `externalId` で分かる）
   * - `"haystack"` … 共有 haystack の filler
   * - `"unknown"` … 上のどれでもない（externalId を解決できなかった等）
   */
  role: "own-gold" | "own-anchor" | "own-distractor" | "other-probe" | "haystack" | "unknown";
  /** 連想の起点になったアンカー（`associationOf` を externalId へ解決したもの）。無ければ null。 */
  anchorExternalId: string | null;
}

/**
 * `AssociationProbeOutcome.associationFrame` の1件が、この probe(`currentProbeId`)
 * にとって何であるかを判定する(機械的。文字列を手で書かない——`ASSOCIATION_PROBES`
 * と `associationGoldExternalId`/`associationAnchorExternalId`/
 * `associationDistractorExternalId` の規約関数、そして `haystackExternalIds`
 * (この会話で実際に積んだ haystack の externalId 集合)とだけ突き合わせる)。
 */
function classifyAssociationFrameRole(
  currentProbeId: string,
  externalId: string,
  haystackExternalIds: ReadonlySet<string>,
): AssociationFrameEntry["role"] {
  if (externalId === associationGoldExternalId(currentProbeId)) {
    return "own-gold";
  }
  if (externalId === associationAnchorExternalId(currentProbeId)) {
    return "own-anchor";
  }
  if (externalId === associationDistractorExternalId(currentProbeId)) {
    return "own-distractor";
  }
  for (const probe of ASSOCIATION_PROBES) {
    if (probe.id === currentProbeId) {
      continue;
    }
    if (
      externalId === associationGoldExternalId(probe.id) ||
      externalId === associationAnchorExternalId(probe.id) ||
      externalId === associationDistractorExternalId(probe.id)
    ) {
      return "other-probe";
    }
  }
  if (haystackExternalIds.has(externalId)) {
    return "haystack";
  }
  return "unknown";
}

/**
 * `retrievedVia === "association"` の候補だけを、返った順のまま externalId の配列にする
 * （`resolvedExternalIds[i]` が引けなければ `memoryId` のまま——`associationFrame` を
 * 組み立てる本処理と同じフォールバック）。1回目・2回目の `recall()` 結果を同じロジックで
 * 比べるための共通処理（Issue #291 フォローアップ）。
 */
function associationExternalIdSequence(
  memories: readonly RecalledMemory[],
  resolvedExternalIds: readonly (string | null)[],
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < memories.length; i += 1) {
    const memory = memories[i]!;
    if (memory.retrievedVia !== "association") {
      continue;
    }
    ids.push(resolvedExternalIds[i] ?? memory.memoryId);
  }
  return ids;
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
  /** 連想枠に入ったものの `role` 別の件数(全 probe の合計)。 */
  associationFrameRoles: Record<string, number>;
  /**
   * `repeatFrameIdentical` が `true` だった probe の件数(Issue #291 フォローアップ、
   * 上の docstring 参照)。`probeCount` 件中いくつが「同じストアへの引き直しでも
   * 連想枠が変わらなかった」かを示す。
   */
  repeatFrameIdenticalCount: number;
  /** `repeatGoldRankSame` が `true` だった probe の件数。 */
  repeatGoldRankSameCount: number;
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

  // ⭐ 枠の中身を判定するための「共有 haystack の externalId 一覧」。この会話に
  // 実際に積んだ utterances(`buildAssociationProbeSetConversation` の戻り値)自身から
  // 導く——`kind: "haystack"` を機械的に見るだけであり、文字列を手で書かない。
  const haystackExternalIds = new Set(
    utterances.filter((u) => u.kind === "haystack").map((u) => u.externalId),
  );

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

    // ⭐ 連想枠の中身(「gold ではない何かが枠に入っていたとき、それが何だったか」を
    // 後から説明できるようにする、北極星の問い3)。`retrievedVia === "association"` の
    // 候補だけを、返った順のまま拾う。
    const associationFrame: AssociationFrameEntry[] = [];
    for (let i = 0; i < result.memories.length; i += 1) {
      const memory = result.memories[i]!;
      if (memory.retrievedVia !== "association") {
        continue;
      }
      const externalId = resolvedExternalIds[i] ?? memory.memoryId;
      let anchorExternalId: string | null = null;
      if (memory.associationOf !== undefined) {
        const resolvedAnchor = await resolveExternalId(
          options.memoryStore,
          ctx,
          memory.associationOf,
        );
        anchorExternalId = resolvedAnchor ?? memory.associationOf;
      }
      associationFrame.push({
        externalId,
        rank: i + 1,
        role: classifyAssociationFrameRole(probe.id, externalId, haystackExternalIds),
        anchorExternalId,
      });
    }

    // ⭐ 同じストア・同じクエリでもう一度 recall() を呼び直す(Issue #291
    // フォローアップ、`AssociationProbeOutcome.repeatFrameIdentical` の docstring
    // 参照)。⛔ text/association 以外を渡さない、という規律は一回目とまったく
    // 同じ引数を繰り返すことで保たれる。
    const resultRepeat = await options.runtime.recall(ctx, {
      text: probe.query,
      ...(association ? { association } : {}),
    });
    const resolvedExternalIdsRepeat = await Promise.all(
      resultRepeat.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndexRepeat = resolvedExternalIdsRepeat.indexOf(goldExternalIdValue);
    const goldRankRepeat = goldIndexRepeat === -1 ? null : goldIndexRepeat + 1;
    const repeatGoldRankSame = goldRank === goldRankRepeat;

    const associationFrameExternalIds = associationFrame.map((entry) => entry.externalId);
    const associationFrameExternalIdsRepeat = associationExternalIdSequence(
      resultRepeat.memories,
      resolvedExternalIdsRepeat,
    );
    const repeatFrameIdentical =
      associationFrameExternalIds.length === associationFrameExternalIdsRepeat.length &&
      associationFrameExternalIds.every((id, i) => id === associationFrameExternalIdsRepeat[i]);

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
      associationFrame,
      repeatFrameIdentical,
      repeatGoldRankSame,
    });
  }

  const stageSkippedReasons: Record<string, number> = {};
  const associationFrameRoles: Record<string, number> = {};
  for (const p of probes) {
    if (p.stageSkipped !== null) {
      stageSkippedReasons[p.stageSkipped] = (stageSkippedReasons[p.stageSkipped] ?? 0) + 1;
    }
    for (const entry of p.associationFrame) {
      associationFrameRoles[entry.role] = (associationFrameRoles[entry.role] ?? 0) + 1;
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
    associationFrameRoles,
    repeatFrameIdenticalCount: probes.filter((p) => p.repeatFrameIdentical).length,
    repeatGoldRankSameCount: probes.filter((p) => p.repeatGoldRankSame).length,
    probes,
  };
}
