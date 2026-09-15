import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { resolveDigest } from "../extraction.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import type { ScoreBreakdown } from "../recall.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "./decay.js";

/**
 * `runtime.consolidate`（Issue #103、ADR 0089）が LLM に返させる構造化スキーマ。
 *
 * `extraction.ts` の `ExtractionResultSchema`（`{ memories: [...] }`）とは**別のスキーマ**
 * である——抽出は「1件の Observation → 0〜N件の Memory 候補」だが、統合は
 * 「N件の Memory → ちょうど1件の統合結果」であり、配列に包まない。
 */
export const ConsolidationLLMResultSchema = z.object({
  content: z.string().min(1),
  /**
   * 省略・空文字は「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
   * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type ConsolidationLLMResult = z.infer<typeof ConsolidationLLMResultSchema>;

/**
 * `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約は
 * {@link ConsolidationLLMResultSchema} 側にある。
 */
export function buildConsolidationPrompt(eligible: Memory[]): PromptSpec {
  return {
    system:
      "あなたは複数の記憶を1件に統合するアシスタントです。渡された記憶それぞれの本文と要旨を読み、" +
      "重複を除いて1つの本文にまとめてください。矛盾する内容がある場合はどちらも書き残してください。",
    messages: [
      {
        role: "user",
        content: eligible
          .map((m, i) => `[${i + 1}] content: ${m.content}\ndigest: ${m.digest}`)
          .join("\n\n"),
      },
    ],
  };
}

export interface BuildConsolidatedMemoryParams {
  ctx: Ctx;
  /**
   * 統合される側（`status: 'active'` の eligible）。**入力の順序をそのまま使う**——
   * `occurredAt` の最新判定・`subjectId` の一致判定・タグの和集合はこの並びに従う。
   */
  eligible: Memory[];
  llmResult: ConsolidationLLMResult;
  hashContent: (content: string) => string;
  digestFallbackLength: number;
  halfLifeHours: number;
  now: Date;
  /**
   * [ADR 0157](../../../docs/decisions/0157-decay-activity-clock.md) 決めたこと3・5:
   * `extraction.ts` の `BuildNewMemoryParams.activitySeq`/`halfLifeRecalls` と同じ形
   * ——両方揃っているときだけ活動時計の3つ組を作る。`'wall'` のテナントでは
   * 呼び出し側がどちらも渡さない。
   */
  activitySeq?: number;
  halfLifeRecalls?: number;
}

/**
 * 統合先の `NewMemory` を組み立てる純関数（Issue #103 §手順6、ADR 0089）。
 *
 * ⚠ **`extraction.ts` の `buildNewMemoryFromCandidate` は流用できない**——あちらは
 * Observation 由来の Memory を組み立てる前提（`sourceObservationId`/`extractorVersion`/
 * `provenance.kind: 'stated' | 'inferred'` を Observation から導く）であり、統合はどの
 * Observation にも由来しない。この関数はそのための専用の純関数である。
 *
 * - `subjectId`: eligible 全件の `subjectId` が一致すればその値、割れていれば `null`。
 * - `provenance`: `{ kind: 'consolidated', sources: <eligible の memoryId> }`。
 * - `tags`: LLM が返した `tags` があればそれを使い、無ければ eligible の `tags` の和集合。
 * - `occurredAt`: eligible の `occurredAt` のうち最も新しいもの。全部 `null` なら `null`。
 * - `sourceObservationId` / `extractorVersion`: 常に `null`（Observation 由来ではない）。
 */
export function buildConsolidatedMemory(params: BuildConsolidatedMemoryParams): NewMemory {
  const { eligible, llmResult, now } = params;

  const subjectIds = new Set(eligible.map((m) => m.subjectId ?? null));
  const subjectId = subjectIds.size === 1 ? [...subjectIds][0]! : null;

  const { digest, digestSource } = resolveDigest(
    { content: llmResult.content, digest: llmResult.digest },
    params.digestFallbackLength,
  );

  const tagUnion = Array.from(new Set(eligible.flatMap((m) => m.tags)));
  const tags = llmResult.tags ?? tagUnion;

  const occurredAtCandidates = eligible
    .map((m) => m.occurredAt ?? null)
    .filter((d): d is Date => d !== null);
  const occurredAt =
    occurredAtCandidates.length === 0
      ? null
      : new Date(Math.max(...occurredAtCandidates.map((d) => d.getTime())));

  const decayFloorAt = defaultDecayStrategy.floorAt({
    recordedAt: now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
  });

  // ADR 0157 決めたこと3・5: 活動時計の3つ組（`extraction.ts` の
  // `buildNewMemoryFromCandidate` と同じ規律）。
  const hasActivityInputs =
    params.activitySeq !== undefined && params.halfLifeRecalls !== undefined;
  const decayBaseSeq = hasActivityInputs ? params.activitySeq : undefined;
  const decayFloorSeq = hasActivityInputs
    ? defaultActivityDecayStrategy.floorAt({
        baseSeq: params.activitySeq!,
        strength: 1,
        halfLifeRecalls: params.halfLifeRecalls!,
      })
    : undefined;

  return {
    tenantId: params.ctx.tenantId,
    subjectId,
    sourceObservationId: null,
    extractorVersion: null,
    content: llmResult.content,
    contentHash: params.hashContent(llmResult.content),
    digest,
    digestSource,
    provenance: { kind: "consolidated", sources: eligible.map((m) => m.id) },
    tags,
    occurredAt,
    recordedAt: now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
    decayFloorAt,
    decayBaseSeq,
    decayFloorSeq,
    halfLifeRecalls: hasActivityInputs ? params.halfLifeRecalls : undefined,
    embeddingStatus: "pending",
  };
}

/**
 * `{ seedMemoryId }` 形（Issue #135、ADR 0152）が使う「似ている」の物差し。
 *
 * **新しく発明しない。**`recall()` が既に使っている物差しをそのまま流用する
 * （`strategies/scoring.ts` の `affinity = max(similarity, lexicalMatch)`、ADR 0084 §5）。
 * `consolidate` が別の「似ている」を持つと、recall が近いと言うものと consolidate が
 * 近いと言うものが食い違う——同じ製品の中に「似ている」の定義が2つ立つことになる。
 *
 * `RecalledMemory.score` は候補がどの段を通って見つかったかによって `similarity`/
 * `lexicalMatch` のどちらか・両方・どちらも無し、の3通りがある
 * （`mandatory_companion` 経由は両方とも無い——矛盾の相手として同伴取得されただけで、
 * クエリへの近さを測っていない）。**どちらも無い候補には -Infinity を渡し、
 * どんな `minAffinity`（有限値である限り）でも必ず落ちるようにする**——
 * 「似ているかどうか分からない」を「似ている」側へ倒さない。
 */
export function computeAffinity(score: ScoreBreakdown): number {
  return Math.max(score.similarity ?? -Infinity, score.lexicalMatch ?? -Infinity);
}
