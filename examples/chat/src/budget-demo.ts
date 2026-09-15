import type { Ctx, RecallResult, Runtime } from "@mnemora/core";
import { queryRecall } from "./mnemora-path.js";
import type { Conversation } from "./scenario.js";

/**
 * 「予算あり/なし」対比デモ（`examples/chat/README.md`「`chat`」節、北極星 項目7
 * 「どれだけ載せるかを、使う側が決められる」、Issue #306）。
 *
 * **なぜ在るか**: これまで `cli.ts` の `runChat()` にインラインで書かれていた
 * （同一データに対し budget 無し／`{ budget: { maxMemoryChars: TINY_BUDGET_CHARS } }` の
 * 両方で `recall()` を呼び、`usage.chars` の差と `budget_dropped` を画面に出す）ため、
 * `__tests__` から呼べず、リファクタで消えても CI は赤くならなかった。`scope.ts`/
 * `backfill.ts` と同じ形（デモ本体・機械判定・印字を分ける）に倣い、デモ本体を
 * `runBudgetDemo` として切り出し、`checkBudgetDemo` で見せたい性質を機械判定する。
 *
 * **⚠ 北極星の主測定（`compare`/`retrieval`）には一切関わらない。**このファイルは
 * `runComparison`/`runRetrievalQualityArm` を呼ばず、`compare.ts`/`retrieval-quality.ts`/
 * `probe-set.ts`/`naive-path.ts` のいずれも import しない（`scope.ts`/`backfill.ts` と
 * 同じ規律）。`mnemora-path.ts`（`queryRecall`）には依存するが、この関数は変更していない。
 *
 * **`runChat()` との関係**: `runBudgetDemo` は「`ctx` に `conversation` が既に
 * ingest 済みであること」を前提にする——これは `queryRecall` 自身の前提（`mnemora-path.ts`
 * の doc）と同じであり、新しい前提を持ち込んでいない。`cli.ts` はこれまで
 * 通り自分で `ingestConversation` を呼んだ後にこの関数を呼ぶ。**画面への印字は
 * 一切ここでは行わない**——`cli.ts` は既存の `formatRecall`/`buildMnemoraPrompt` を
 * そのまま使い続けるので、`chat` サブコマンドの画面出力は1バイトも変わらない。
 */

/** budget が実際に切り詰めることを見せるための、意図的に小さい文字数予算。 */
export const TINY_BUDGET_CHARS = 60;

export interface BudgetDemoResult {
  /** `recall()` を budget 無しで呼んだ結果。 */
  withoutBudget: RecallResult;
  /** `recall()` を `{ budget: { maxMemoryChars: TINY_BUDGET_CHARS } }` で呼んだ結果。 */
  withBudget: RecallResult;
}

/**
 * 対比デモ本体（印字を持たない、テストから呼べる形）。
 *
 * 同一データ（`ctx` に ingest 済みの `conversation`）に対し、budget 無し／
 * `{ budget: { maxMemoryChars: TINY_BUDGET_CHARS } }` の両方で `recall()` を呼び、
 * 両方の `RecallResult` を返す。
 */
export async function runBudgetDemo(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
): Promise<BudgetDemoResult> {
  const withoutBudget = await queryRecall(runtime, ctx, conversation);
  const withBudget = await queryRecall(runtime, ctx, conversation, {
    budget: { maxMemoryChars: TINY_BUDGET_CHARS },
  });
  return { withoutBudget, withBudget };
}

function budgetTruncationStage(result: RecallResult) {
  return result.explain.stages.find((s) => s.stage === "budget_truncation");
}

function hasBudgetDropped(result: RecallResult): boolean {
  return result.omitted.some((o) => o.kind === "budget_dropped");
}

export interface BudgetDemoCheck {
  /** 前提: budget 無しの経路がそもそも空でないか（空だと以下の判定が無意味な緑になる）。 */
  withoutBudgetIsNonEmpty: boolean;
  /**
   * budget を渡すと、memories tier（`usage.byTier.digest`）が実際に減るか。
   *
   * **⚠ `usage.chars`（memories tier + 目次帯）ではなく `byTier.digest` で比べる。**
   * 実測（本 PR、本物の Postgres・`buildConversation(8)`）で判明した——`usage.chars` は
   * budget を締めても**増えることがある**: `docs/recall.md` §5 の被覆不変条件により、
   * budget で `memories` から押し出された Memory は目次帯（digest 帯）側の対象になり、
   * 目次帯の実費（`indexChars`）がその分だけ増える。実測値: budget 無し
   * `chars=346`(`digest=155`/`index=191`) → budget maxMemoryChars=60
   * `chars=793`(`digest=40`/`index=753`)。**`chars` は増えたが `digest` は確実に
   * 減っている**——「予算が実際に切り詰める」と言えるのは `byTier.digest` の方であり、
   * こちらを見る。
   */
  withBudgetIsSmaller: boolean;
  /** budget を渡した側に `budget_dropped` の omission が実際に出るか。 */
  withBudgetHasDroppedOmission: boolean;
  /** budget 無しの側に `budget_dropped` が1件も出ないか（出なければ true）。 */
  withoutBudgetHasNoBudgetDropped: boolean;
  /**
   * budget 無しの経路で、段4（`budget_truncation`）が「適用されなかった」と
   * 名乗っているか（`explain.stages` の `detail.budgetApplied === false`）。
   * `effectiveTokenBudget()` が `undefined` を返す振る舞い
   * （`packages/core/src/recall-runtime.ts:185-192`）が実際に外へ現れることを見る——
   * 「隠れた既定上限は無い」ことを名指しで検査する。
   */
  withoutBudgetHasNoAppliedTruncation: boolean;
  /**
   * budget を渡した側で、返した memories tier（連想を含む。`byTier.digest`）が
   * 申告した `TINY_BUDGET_CHARS` の内側に収まっているか。
   */
  withBudgetFitsDeclaredCharBudget: boolean;
  /**
   * `maxMemoryChars` だけを申告した経路では `usage.budgetExceeded` は構造的に常に
   * `false` になる（docs/recall.md §6「`budgetExceeded`」節）。この歯はその文書化された
   * 不変条件そのものを検査する。
   */
  withBudgetIsNotExceeded: boolean;
}

/** `BudgetDemoResult` から、見せたい性質を機械的に判定する（印字・歯の両方が使う）。 */
export function checkBudgetDemo(result: BudgetDemoResult): BudgetDemoCheck {
  const withoutBudgetTrace = budgetTruncationStage(result.withoutBudget);
  return {
    withoutBudgetIsNonEmpty: result.withoutBudget.memories.length > 0,
    withBudgetIsSmaller:
      result.withBudget.usage.byTier.digest < result.withoutBudget.usage.byTier.digest,
    withBudgetHasDroppedOmission: hasBudgetDropped(result.withBudget),
    withoutBudgetHasNoBudgetDropped: !hasBudgetDropped(result.withoutBudget),
    withoutBudgetHasNoAppliedTruncation: withoutBudgetTrace?.detail?.budgetApplied === false,
    withBudgetFitsDeclaredCharBudget: result.withBudget.usage.byTier.digest <= TINY_BUDGET_CHARS,
    withBudgetIsNotExceeded: result.withBudget.usage.budgetExceeded === false,
  };
}
