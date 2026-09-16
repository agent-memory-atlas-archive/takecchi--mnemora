import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

// prettier-ignore
import type {
  CountKindSchema,
  NotIndexedReasonSchema,
  OmissionSchema,
  ScopeRelationSchema,
  GroupCountSchema,
  DigestEntrySchema,
  DigestBandLimitedBySchema,
  DigestBandCoverageSchema,
  IndexBandSchema,
  RecallUsageSchema,
  RecallBudgetSchema,
  ScoreBreakdownSchema,
  RecalledMemorySchema,
  StageTraceSchema,
  RecallAssociationQuerySchema,
  RecallQuerySchema,
  RecallScopeSchema,
  RecallOutputValidationIssueSchema,
  RecallOutputValidationSchema,
  RecallResultSchema,
} from "../recall.js";
import type {
  CountKind,
  NotIndexedReason,
  Omission,
  ScopeRelation,
  StageSkippedOmission,
  FilteredOmission,
  BelowThresholdOmission,
  OverLimitOmission,
  BudgetDroppedOmission,
  NotIndexedOmission,
  AnnTruncatedOmission,
  AnnUnreachedOmission,
  LexicalTruncatedOmission,
  ScoreNotComparableOmission,
  UnitAssemblyDroppedOmission,
  GroupCount,
  DigestEntry,
  DigestBandLimitedBy,
  DigestBandCoverage,
  IndexBand,
  RecallUsage,
  RecallBudget,
  ScoreBreakdown,
  RecalledMemory,
  StageTrace,
  RecallAssociationQuery,
  RecallQuery,
  RecallScope,
  RecallOutputValidationIssue,
  RecallOutputValidation,
  RecallResult,
} from "../recall.js";

import type {
  ObservationSchema,
  NewObservationSchema,
  ExtractModeSchema,
  ObserveInputSchema,
} from "../observation.js";
import type {
  Observation,
  NewObservation,
  ExtractMode,
  ObserveInput,
  ObserveUtteranceInput,
  ObserveEventInput,
  ObserveDocumentInput,
  ObserveMemoryUsageInput,
} from "../observation.js";

import type { ProvenanceKindSchema, ProvenanceSchema } from "../provenance.js";
import type {
  ProvenanceKind,
  Provenance,
  StatedProvenance,
  InferredProvenance,
  ConsolidatedProvenance,
  ReflectedProvenance,
  ImportedProvenance,
} from "../provenance.js";

import type {
  MemoryStatusSchema,
  EmbeddingStatusSchema,
  DigestSourceSchema,
  MemorySchema,
  NewMemorySchema,
} from "../memory.js";
import type { MemoryStatus, EmbeddingStatus, DigestSource, Memory, NewMemory } from "../memory.js";

import type {
  MemoryEventKindSchema,
  EventActorSchema,
  MemoryEventSchema,
  NewMemoryEventSchema,
  EventFilterSchema,
} from "../event.js";
import type {
  MemoryEventKind,
  EventActor,
  MemoryEvent,
  NewMemoryEvent,
  EventFilter,
} from "../event.js";

import { OutboxJobRecordSchema } from "../outbox.js";
import type { OutboxJobRecord } from "../outbox.js";

import type { EmbeddingSpaceIdSchema } from "../embedding.js";
import type { EmbeddingSpaceId } from "../embedding.js";

import type { CtxSchema } from "../ctx.js";
import type { Ctx } from "../ctx.js";

/**
 * Issue #272: `satisfies z.ZodType<T>` は片方向の代入可能性
 * （「zod が推論する型 → 手書きの型 T」への代入可能性）しか見ない。
 *
 * - **zod 側だけを広げる**と `satisfies` が落ちる（zod の推論型が T に入らなくなる）。
 * - **型側だけを広げる**と `satisfies` は気づかない（zod の推論型は今までどおり T の
 *   部分集合であり、代入可能性は崩れない）。
 *
 * [ADR 0144](../../../../docs/decisions/0144-drop-unreachable-classification-3-union-values.md)
 * の「開いている穴」2番・[ADR 0164](../../../../docs/decisions/0164-valid-from-until-recall.md)
 * の変異Dが、この非対称性を実測で確認している。この issue はその非対称性そのものを歯にする。
 *
 * ## 採った形（Issue #272 の方向1）
 *
 * `Equals<A, B>` で **相互代入可能性**（実際には、より強い「型としての同一性」——下記
 * 「`Equals` は何を検査しているか」参照）を型レベルで固定する。`satisfies` が
 * 「zod が型を超えないこと」しか見ないのに対し、`Equals` は
 * **「zod が型を超えないこと」と「型が zod を超えないこと」の両方**を同時に見る
 * ——**型だけを広げても、zod だけを広げても、どちらでも `tsc` が赤くなる。**
 *
 * ## `Equals` は何を検査しているか（測った）
 *
 * `(<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)` という
 * よく知られたパターンは、**単純な双方向 `extends`（相互代入可能性）より厳しい**——
 * `X`/`Y` を「同じ型」として同一視するかどうかを、素の相互代入可能性より細かく見る。
 * 【実測、scratch で確認・本ファイルの `OutboxJobRecord` 節で再現】: `OutboxJobKind`
 * （`"extract" | "embed" | "consolidate" | "reflect" | (string & {})` という
 * 「開いた」ブランド型）と素の `string` は、**相互に代入可能ではあるが**
 * `Equals` は `false` を返す。⟹ **この歯は `satisfies` より狭い意味で「同じ」を
 * 要求する**——それが誤検知にならないよう、各ペアで実際に `tsc` を走らせて確認し、
 * 通らないものは個別に理由を書く（下記、各セクション）。
 *
 * ## なぜ「55ペア個別」を、55本の import ではなく discriminated union から `Extract` するか
 *
 * `Omission`/`Provenance`/`ObserveInput` の各枝（`StageSkippedOmissionSchema` 等）は
 * **どれも `export` されていない**——公開 API はまとめの `OmissionSchema`/`ProvenanceSchema`/
 * `ObserveInputSchema` だけである。このテストファイルは `packages/core/src` の外から見た
 * 公開 API だけを検査したいので、`z.infer<typeof OmissionSchema>` を `kind` で
 * `Extract` して個々の枝を取り出す——**これは同時に「まとめの discriminated union 自体が
 * 手書きの union 型と一致するか」も検査する**。
 *
 * **55ペアの外側で見つかったもの**: `OmissionSchema`/`ProvenanceSchema`/`ObserveInputSchema`
 * の3つは、11+5+4=20本の枝それぞれには `satisfies z.ZodType<Xxx>` が付いているのに、
 * まとめのこの1行にだけ付いていなかった。issue #272 の調査（マネージャー経由）は
 * `OmissionSchema` だけを「55箇所のうち唯一 satisfies を持たない箇所」と報告していたが、
 * **同じ形の欠落が `ProvenanceSchema`（provenance.ts）と `ObserveInputSchema`
 * （observation.ts）にもあった**——本ファイルを書く過程で見つけた追加の事実であり、
 * 55ペアの数え上げには含まれない（別途報告する）。`OmissionSchema` には
 * `recall.ts` 側に `satisfies z.ZodType<Omission>` を1行足した（足しても緑のまま
 * だったため——下記 `_p03_Omission_whole` 参照）。`ProvenanceSchema`/`ObserveInputSchema`
 * は対応する `.ts` ファイルを触らず、ここでの `Equals` 検査（`_p40_Provenance_whole`/
 * `_p34_ObserveInput_whole`）だけで同じ効果（相互代入可能性の固定）を持たせてある。
 */

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * `Equals` の弱い形。**「型として同一か」ではなく「相互に代入可能か」**だけを見る、
 * 単純な双方向 `extends`（`[X] extends [Y]` とタプルで包むのは、`X`/`Y` が union の
 * ときに条件型が要素ごとに分配されるのを防ぐため——object 型が対象の本ファイルでは
 * 効果が無いが、意味が変わらない一般形として統一する）。
 *
 * **4ペアでだけ使う**（下記「55ペアのうち Equals が通らなかったもの」参照）。
 * `Equals` より真に弱い——**「同じ型」までは主張できないが「zod のほうが狭くも広くも
 * なっていないこと」は主張できる**。`satisfies` が見ているのはこの一方向
 * （zod→型）だけであり、`MutualAssignable` はその逆方向も足す。
 */
type MutualAssignable<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

/**
 * 型レベルの表明。`Equals<A, B>`（または `MutualAssignable<A, B>`）が `true` でなければ、
 * この型エイリアスの宣言そのものが `tsc` のコンパイルエラーになる
 * （`TS2344: Type 'false' does not satisfy the constraint 'true'.`）。
 * 実行時コードは生成しない——`pnpm run typecheck` / `pnpm --filter @mnemora/core run typecheck`
 * だけがこれを検査する。
 */

type Expect<T extends true> = T;

// =============================================================================
// packages/core/src/recall.ts — 29ペア
// =============================================================================

type _p01_CountKind = Expect<Equals<z.infer<typeof CountKindSchema>, CountKind>>;

type _p02_NotIndexedReason = Expect<
  Equals<z.infer<typeof NotIndexedReasonSchema>, NotIndexedReason>
>;

// --- Omission（discriminated union。`recall.ts` に satisfies を足した——上記コメント参照） ---
type _OmissionInfer = z.infer<typeof OmissionSchema>;

type _p03_Omission_whole = Expect<Equals<_OmissionInfer, Omission>>;

type _p04_StageSkippedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "stage_skipped" }>, StageSkippedOmission>
>;

type _p05_FilteredOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "filtered" }>, FilteredOmission>
>;

type _p06_BelowThresholdOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "below_threshold" }>, BelowThresholdOmission>
>;

type _p07_OverLimitOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "over_limit" }>, OverLimitOmission>
>;

type _p08_BudgetDroppedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "budget_dropped" }>, BudgetDroppedOmission>
>;

type _p09_NotIndexedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "not_indexed" }>, NotIndexedOmission>
>;

type _p10_AnnTruncatedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "ann_truncated" }>, AnnTruncatedOmission>
>;

type _p11_AnnUnreachedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "ann_unreached" }>, AnnUnreachedOmission>
>;

type _p12_LexicalTruncatedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "lexical_truncated" }>, LexicalTruncatedOmission>
>;

type _p13_ScoreNotComparableOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "score_not_comparable" }>, ScoreNotComparableOmission>
>;

type _p14_UnitAssemblyDroppedOmission = Expect<
  Equals<Extract<_OmissionInfer, { kind: "unit_assembly_dropped" }>, UnitAssemblyDroppedOmission>
>;

type _p15_GroupCount = Expect<Equals<z.infer<typeof GroupCountSchema>, GroupCount>>;

type _p16_DigestEntry = Expect<Equals<z.infer<typeof DigestEntrySchema>, DigestEntry>>;

type _p17_DigestBandLimitedBy = Expect<
  Equals<z.infer<typeof DigestBandLimitedBySchema>, DigestBandLimitedBy>
>;

type _p18_DigestBandCoverage = Expect<
  Equals<z.infer<typeof DigestBandCoverageSchema>, DigestBandCoverage>
>;

type _p19_IndexBand = Expect<Equals<z.infer<typeof IndexBandSchema>, IndexBand>>;

type _p20_RecallUsage = Expect<Equals<z.infer<typeof RecallUsageSchema>, RecallUsage>>;

type _p21_RecallBudget = Expect<Equals<z.infer<typeof RecallBudgetSchema>, RecallBudget>>;

type _p22_ScoreBreakdown = Expect<Equals<z.infer<typeof ScoreBreakdownSchema>, ScoreBreakdown>>;

type _p23_RecalledMemory = Expect<Equals<z.infer<typeof RecalledMemorySchema>, RecalledMemory>>;

type _p24_StageTrace = Expect<Equals<z.infer<typeof StageTraceSchema>, StageTrace>>;

type _p25_RecallAssociationQuery = Expect<
  Equals<z.infer<typeof RecallAssociationQuerySchema>, RecallAssociationQuery>
>;

type _p26_RecallQuery = Expect<Equals<z.infer<typeof RecallQuerySchema>, RecallQuery>>;

type _p27_RecallScope = Expect<Equals<z.infer<typeof RecallScopeSchema>, RecallScope>>;

type _p28_RecallOutputValidationIssue = Expect<
  Equals<z.infer<typeof RecallOutputValidationIssueSchema>, RecallOutputValidationIssue>
>;

type _p29_RecallOutputValidation = Expect<
  Equals<z.infer<typeof RecallOutputValidationSchema>, RecallOutputValidation>
>;

type _p30_RecallResult = Expect<Equals<z.infer<typeof RecallResultSchema>, RecallResult>>;

// =============================================================================
// packages/core/src/observation.ts — 7ペア
// =============================================================================

type _p31_Observation = Expect<Equals<z.infer<typeof ObservationSchema>, Observation>>;
// ⚠ `NewObservation` は `Equals` を満たさない。`NewObservation` の宣言は
// `Omit<Observation, "id" | "recordedAt"> & { recordedAt?: Date }`——**intersection 型**
// である。zod 側（`.omit({...}).extend({...})`）が返す推論型は、同じメンバーを持つ
// **1つに平らな object 型**であり、値としては同じでも、`Equals` が見ている
// 「同一の型表現か」では一致しない（本ファイル冒頭「55ペアのうち Equals が
// 通らなかったもの」参照。`Omit<T,K> & {...}` という書き方そのものが原因であることを
// 最小再現（`Flat` vs `Omit<Full,"c"|"b"> & {b?: string}`）で確認済み）。
// ⟹ 弱い形（`MutualAssignable`、双方向の単純な `extends`）に落とす。

type _p32_NewObservation = Expect<
  MutualAssignable<z.infer<typeof NewObservationSchema>, NewObservation>
>;

type _p33_ExtractMode = Expect<Equals<z.infer<typeof ExtractModeSchema>, ExtractMode>>;

type _ObserveInputInfer = z.infer<typeof ObserveInputSchema>;

type _p34_ObserveInput_whole = Expect<Equals<_ObserveInputInfer, ObserveInput>>;

type _p35_ObserveUtteranceInput = Expect<
  Equals<Extract<_ObserveInputInfer, { kind: "utterance" }>, ObserveUtteranceInput>
>;

type _p36_ObserveEventInput = Expect<
  Equals<Extract<_ObserveInputInfer, { kind: "event" }>, ObserveEventInput>
>;

type _p37_ObserveDocumentInput = Expect<
  Equals<Extract<_ObserveInputInfer, { kind: "document" }>, ObserveDocumentInput>
>;

type _p38_ObserveMemoryUsageInput = Expect<
  Equals<Extract<_ObserveInputInfer, { kind: "memory_usage" }>, ObserveMemoryUsageInput>
>;

// =============================================================================
// packages/core/src/provenance.ts — 6ペア
// =============================================================================

type _p39_ProvenanceKind = Expect<Equals<z.infer<typeof ProvenanceKindSchema>, ProvenanceKind>>;

type _ProvenanceInfer = z.infer<typeof ProvenanceSchema>;

type _p40_Provenance_whole = Expect<Equals<_ProvenanceInfer, Provenance>>;

type _p41_StatedProvenance = Expect<
  Equals<Extract<_ProvenanceInfer, { kind: "stated" }>, StatedProvenance>
>;

type _p42_InferredProvenance = Expect<
  Equals<Extract<_ProvenanceInfer, { kind: "inferred" }>, InferredProvenance>
>;

type _p43_ConsolidatedProvenance = Expect<
  Equals<Extract<_ProvenanceInfer, { kind: "consolidated" }>, ConsolidatedProvenance>
>;

type _p44_ReflectedProvenance = Expect<
  Equals<Extract<_ProvenanceInfer, { kind: "reflected" }>, ReflectedProvenance>
>;

type _p45_ImportedProvenance = Expect<
  Equals<Extract<_ProvenanceInfer, { kind: "imported" }>, ImportedProvenance>
>;

// =============================================================================
// packages/core/src/memory.ts — 5ペア
// =============================================================================

type _p46_MemoryStatus = Expect<Equals<z.infer<typeof MemoryStatusSchema>, MemoryStatus>>;

type _p47_EmbeddingStatus = Expect<Equals<z.infer<typeof EmbeddingStatusSchema>, EmbeddingStatus>>;

type _p48_DigestSource = Expect<Equals<z.infer<typeof DigestSourceSchema>, DigestSource>>;

type _p49_Memory = Expect<Equals<z.infer<typeof MemorySchema>, Memory>>;
// ⚠ `NewMemory` も `NewObservation` と同じ理由で `Equals` を満たさない
// （`Omit<Memory, ...> & Partial<Pick<Memory, ...>>` という intersection 型）。

type _p50_NewMemory = Expect<MutualAssignable<z.infer<typeof NewMemorySchema>, NewMemory>>;

// =============================================================================
// packages/core/src/event.ts — 5ペア
// =============================================================================

type _p51_MemoryEventKind = Expect<Equals<z.infer<typeof MemoryEventKindSchema>, MemoryEventKind>>;

type _p52_EventActor = Expect<Equals<z.infer<typeof EventActorSchema>, EventActor>>;

type _p53_MemoryEvent = Expect<Equals<z.infer<typeof MemoryEventSchema>, MemoryEvent>>;
// ⚠ `NewMemoryEvent` も同じ理由で `Equals` を満たさない
// （`Omit<MemoryEvent, "id" | "at"> & { at?: Date }` という intersection 型）。

type _p54_NewMemoryEvent = Expect<
  MutualAssignable<z.infer<typeof NewMemoryEventSchema>, NewMemoryEvent>
>;

type _p55_EventFilter = Expect<Equals<z.infer<typeof EventFilterSchema>, EventFilter>>;

// =============================================================================
// packages/core/src/outbox.ts — 1ペア
//
// ⚠ このペアは `Equals` を**満たさない**（下記「55ペアのうち Equals が落ちたもの」参照）。
// `OutboxJobRecord.kind: OutboxJobKind`（`"extract" | "embed" | "consolidate" | "reflect" |
// (string & {})` という開いたブランド型）に対し、zod 側は `z.string().min(1)`（素の
// `string`）で受けている。**相互に代入可能**（`MutualAssignable` で下記のとおり確認済み。
// `satisfies` が見ているのはこの片方向——zod→型——であり、今日も緑）だが、`Equals` は
// ブランド型と素の `string` を「同じ型」とは認めない——本ファイル冒頭「`Equals` は
// 何を検査しているか」で実測した限界そのものである。
// ⟹ `MutualAssignable`（弱い形）で型レベルの相互代入可能性を固定したうえ、
// `OutboxJobKind` はそもそも閉じた union ではなく `(string & {})` を持つ意図的に
// 開いた型なので `Record<T, true>` 式の網羅は書けない——代わりに、代表値
// （4リテラル + 任意の文字列1つ）を実際に `safeParse` して「zod が受け付ける値の集合が、
// 型が許す値の集合の範囲に収まっていること」を実行時にも確認する。

type _p56_OutboxJobRecord_kind = Expect<
  MutualAssignable<z.infer<typeof OutboxJobRecordSchema>["kind"], OutboxJobRecord["kind"]>
>;
// =============================================================================

describe("OutboxJobRecord.kind — Equals が落ちる箇所の弱い形", () => {
  it("OutboxJobKind の4リテラルは OutboxJobRecordSchema を通る", () => {
    const kinds: OutboxJobRecord["kind"][] = ["extract", "embed", "consolidate", "reflect"];
    for (const kind of kinds) {
      const result = OutboxJobRecordSchema.safeParse({
        id: "j1",
        tenantId: "t1",
        kind,
        payload: {},
        availableAt: new Date(),
        attempts: 0,
        createdAt: new Date(),
      });
      expect(result.success).toBe(true);
    }
  });

  it("OutboxJobKind の (string & {}) 側——任意の非空文字列も通る（型どおり開いている）", () => {
    const result = OutboxJobRecordSchema.safeParse({
      id: "j1",
      tenantId: "t1",
      kind: "future_custom_kind",
      payload: {},
      availableAt: new Date(),
      attempts: 0,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// packages/core/src/embedding.ts — 1ペア
// =============================================================================

type _p57_EmbeddingSpaceId = Expect<
  Equals<z.infer<typeof EmbeddingSpaceIdSchema>, EmbeddingSpaceId>
>;

// =============================================================================
// packages/core/src/ctx.ts — 1ペア
// =============================================================================

type _p58_Ctx = Expect<Equals<z.infer<typeof CtxSchema>, Ctx>>;

// =============================================================================
// 後から `main` で増えたペア（番号は末尾に足す）
//
// ⭐ **この節は、本 PR の歯が実際に噛んだ結果として生まれた。**
// PR #376（[ADR 0174](../../../../docs/decisions/0174-filtered-omission-scope-relation.md)、
// `FilteredOmission` に `scopeRelation` を足した）が `ScopeRelation` の型と
// `ScopeRelationSchema` を `main` へ入れたが、**対応する `_pNN` はここに無かった。**
// 本 PR の手元の門は緑のままだったが（枝は `main` より前の木を見ている）、
// **CI は PR と `main` のマージ後の木を検査するため、出現数の歯が
// `expected 59 to be 58` で赤くなった**——`main` を取り込み、このペアを足して直した。
// ⟹ **「新しい型を足した人が登録し忘れる」を、この歯が初回から実際に拾った。**
// （ADR 0181「引き受けた負債」に書いたとおり、これは「気づける」であって
// 「強制できる」ではない——気づいた後に足すのは人間の仕事である。）
// =============================================================================

type _p59_ScopeRelation = Expect<Equals<z.infer<typeof ScopeRelationSchema>, ScopeRelation>>;

// =============================================================================
// 実行時の存在証明
//
// 上の `type _pNN_... = Expect<Equals<...>>` は、`Equals<A,B>` が `false` になった
// 瞬間にこのファイル自体の宣言でコンパイルエラーになる（型検査だけで完結する——
// 実行時コードは無い）。`vitest` にも「この歯が実在する」ことを見えるようにするため、
// この it が要る。
//
// ⚠ **2026-09-17 追記（マネージャー指摘、[ADR 0177](../../../docs/decisions/0177-fix-stage3-tooth-blind-asserts.md)
// と同種の欠陥）**: 当初この it は `expect(55 + 3).toBe(58)` という**定数どうしの比較**
// だった——`_pNN` を何本消しても、このファイルの外の事実は何も見ていないので永久に緑の
// ままである。ADR 0177 が `mark-contested.test.ts` の「壊れても緑のままの assert」を
// 直した直後に、同じ形の欠陥を新しい PR で持ち込みかけていた。**このファイル自身の
// ソースを `readFileSync` で読み、実際に `_pNN` 宣言の本数と番号を数える形に直した。**
// =============================================================================

const THIS_FILE_PATH = join(__dirname, "schema-type-equals-parity.test.ts");
const EXPECTED_PAIR_COUNT = 59;

/**
 * このファイル自身のソースを読み、`type _pNN_Name = ...` の形の宣言（行頭、
 * インデント無し）が持つ番号をすべて拾う。`_OmissionInfer`/`_ObserveInputInfer`/
 * `_ProvenanceInfer` のような補助型（`_pNN` 接頭辞を持たない）は対象外。
 */
function findDeclaredPairNumbers(): number[] {
  const source = readFileSync(THIS_FILE_PATH, "utf8");
  const matches = [...source.matchAll(/^type _p(\d+)_[A-Za-z_]+ =/gm)];
  return matches.map((m) => Number(m[1]));
}

describe("schema ↔ 型 の Equals parity（Issue #272）", () => {
  it(`_pNN 宣言が${EXPECTED_PAIR_COUNT}本あり、番号1..${EXPECTED_PAIR_COUNT}に重複も欠番も無い`, () => {
    const numbers = findDeclaredPairNumbers();
    const howToFix =
      "packages/core/src/__tests__/schema-type-equals-parity.test.ts の " +
      "`type _pNN_...` 宣言を数え直したところ期待値と食い違った。" +
      "ペアを足した／消したなら、この EXPECTED_PAIR_COUNT を更新すること。" +
      "そうでないなら、番号の重複・欠番（コピペミス等）を疑うこと。" +
      "内訳: 55本が本来の55ペア（`satisfies` 宣言との1対1対応）、" +
      "3本（_p03 Omission_whole / _p34 ObserveInput_whole / _p40 Provenance_whole）が" +
      "discriminated union 自体の全体一致、1本（_p59 ScopeRelation）が `main` から" +
      "取り込んだ分（Issue #272 / ADR 0181 参照）。";

    expect(numbers.length, howToFix).toBe(EXPECTED_PAIR_COUNT);

    const sorted = [...numbers].sort((a, b) => a - b);
    const expectedSequence = Array.from({ length: EXPECTED_PAIR_COUNT }, (_, i) => i + 1);
    expect(sorted, `${howToFix}（番号が1..${EXPECTED_PAIR_COUNT}の連番になっていない）`).toEqual(
      expectedSequence,
    );
  });
});

// =============================================================================
// 網羅を「強制」できるかの部分的な答え（ADR 0181「引き受けた負債」参照）
//
// 上の `_pNN` 群は、55ペアを**手で**書き出したものである——`packages/core/src` に
// 56本目の `satisfies z.ZodType<...>` が増えても、このファイルはそれを**自動では
// 検出しない**（`ALL_FILTERED_CONDITIONS`/`OmissionProbe` レジストリのように
// `Record<Union, ...>` の形で union から機械的に導いてはいない——55ペアは55個の
// **別々の型**への言及であり、単一の union から取り出せる形ではないため）。
//
// ここで足せるのは「新しい型を足した人が登録し忘れたら**気づける**」までである
// （「登録し忘れたら通らない」という完全な強制ではない）。`satisfies z.ZodType<...>`
// の出現数を数え、期待値と食い違えば赤くする——`unreachable-union-values.test.ts` と
// 同じ静的な文字列走査であり、同じ限界を持つ（コメント中の引用や別の書式の
// `satisfies` は数えない・数えすぎる可能性がある）。**「新しい satisfies が増えたら、
// この期待値を更新するのと同時に、対応する `_pNN` をこのファイルへ足すこと」という
// 運用上の合図として使う**——この数が変わったのに `_pNN` を足し忘れても、この歯は
// 気づけない（数だけを見ているため）。
// =============================================================================

const CORE_SRC_ROOT = join(__dirname, "..");
const EXCLUDE_DIR_NAMES = new Set(["__tests__", "node_modules", "dist"]);

function listTsFilesUnder(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listTsFilesUnder(full, files);
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const EXPECTED_SATISFIES_COUNT = 59;

describe("satisfies z.ZodType<...> の出現数が変わったら気づく（強制ではなく合図）", () => {
  it(`packages/core/src（__tests__ を除く）の satisfies z.ZodType<...> は${EXPECTED_SATISFIES_COUNT}件`, () => {
    const files = listTsFilesUnder(CORE_SRC_ROOT);
    let count = 0;
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        // `*`/`//` から始まる行（JSDoc コメント・行コメント）は、コード例としての
        // 引用を誤検出しないため読み飛ばす——`unreachable-union-values.test.ts` と
        // 同じ規約（本ファイルの `recall.ts` への追記コメント自身が、この規約が
        // 必要であることを実例で示した——最初の実装では自分のコメント中の引用を
        // 誤って3件多く数えていた）。
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        const matches = line.match(/satisfies z\.ZodType</g);
        count += matches ? matches.length : 0;
      }
    }
    // 55（issue #272 の調査で数えたペア）+ 3（OmissionSchema・ProvenanceSchema・
    // ObserveInputSchema。いずれも discriminated union のまとめに足りなかった1行、
    // ADR 0181「決定」参照）+ 1（`ScopeRelationSchema`、`main` から取り込んだ分）= 59。
    expect(
      count,
      "packages/core/src の satisfies z.ZodType<...> の出現数が期待値と食い違った。" +
        "新しい satisfies を足したなら、対応する Equals（または MutualAssignable）の " +
        "`_pNN` を packages/core/src/__tests__/schema-type-equals-parity.test.ts へ足し、" +
        "この EXPECTED_SATISFIES_COUNT とファイル冒頭の it の EXPECTED_PAIR_COUNT も " +
        "一緒に更新すること（Issue #272 / ADR 0181 参照）。",
    ).toBe(EXPECTED_SATISFIES_COUNT);
  });
});
