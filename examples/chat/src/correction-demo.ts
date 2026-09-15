import type { Ctx, MemoryId, RecallResult, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { CorrectionScenario } from "./correction-scenario.js";
import { CORRECTION_SCENARIO } from "./correction-scenario.js";

/**
 * 訂正を含む会話シナリオを `Runtime` に対して実際に走らせるデモ（Issue #303）。
 *
 * 北極星「目指す姿」の項目5「間違いを正すと、古いほうが先に出てこなくなる」を、
 * `markContested`（ADR 0134）→`recall`（両方隣接して出る）→`resolveContested`
 * （ADR 0150）→`recall`（敗者はもう出ない）の一巡で実演する。`packages/core`
 * `resolve-contested.test.ts` の「検出から解決までの一巡」と同じ形を、本物の
 * `Runtime`（`examples/chat` の Postgres 配線）に対して行う。
 *
 * **矛盾かどうか・どちらが勝つかの判定はこのファイルではなく `correction-scenario.ts` の
 * `contestedPair` が持つ**（ADR 0134 決定2 / ADR 0150 決定1）。ここでは宣言をそのまま
 * `markContested`/`resolveContested` に渡すだけで、`recordedAt`/`turns` の並び順・
 * 「後に observe したほうが勝つ」といった順序規則からは何も導かない
 * （`resolveContestedIds` 参照）。
 *
 * **⚠ 北極星の主測定（`compare`/`retrieval`）には一切関わらない。**`compare.ts`/
 * `compare-json.ts`/`scenario.ts`/`probe-set.ts`/`naive-path.ts` のいずれも import しない
 * （`scope.ts`/`backfill.ts` と同じ規律）。
 *
 * **⚠ `recall()` は `limit: 1` を明示して呼ぶ（PR #320 の CI 失敗の修正、ADR 0162 決定5）。**
 * この会話には `original`/`correction` の2件しか Memory が無いため、既定の limit（10件）
 * では両方が独立に段2（再スコア）の `withinLimit` へ収まってしまい、段3「矛盾の解決と
 * 必須の同伴取得」（`docs/recall.md` §2 段3）の同伴取得（`retrievedVia: 'mandatory_companion'`）
 * が一度も発火しない——両方ともスコアだけで既に出るので、対向を「必ず連れてくる」機構が
 * 要らない状態になる。`limit: 1` にすると、段2で上位1件だけが `withinLimit` に残り、
 * その1件が `contested` なら対向（もう一方）が limit を超えて強制的に連れてこられる
 * （実測: `afterMark.memories.length` は limit=1 でも 2 になる）。これで Issue #197 の
 * 受け入れ条件「段3 が実際に発火することを測る歯が在る」を、`examples/chat` からも
 * 満たす。
 */

export interface CorrectionDemoResult {
  scenario: CorrectionScenario;
  originalId: MemoryId;
  correctionId: MemoryId;
  /** markContested 前の recall（訂正がまだ対向として宣言されていない状態）。 */
  beforeMark: RecallResult;
  /** markContested の結果。 */
  markOutcomeKind: string;
  /** markContested 後の recall（両方が隣接して出るはず）。 */
  afterMark: RecallResult;
  /** resolveContested の結果。 */
  resolveOutcomeKind: string;
  /** resolveContested 後の recall（敗者はもう出ないはず）。 */
  afterResolve: RecallResult;
}

function findByMemoryId(
  memories: RecallResult["memories"],
  id: MemoryId,
): RecallResult["memories"][number] | undefined {
  return memories.find((m) => m.memoryId === id);
}

/**
 * `scenario.contestedPair`（構造としての宣言）から、`markContested`/`resolveContested` に
 * 渡す `MemoryId` の組（対象2件 + 勝者）を組み立てる。**externalId → MemoryId の対応は
 * `observe()` の戻り値からのみ得る**——`contestedPair` は「どの2件が組で、どちらが勝つか」
 * だけを運び、他のどんな規則からも勝敗を導かない。
 */
function resolveContestedIds(
  scenario: CorrectionScenario,
  originalId: MemoryId,
  correctionId: MemoryId,
): { firstId: MemoryId; secondId: MemoryId; winnerId: MemoryId } {
  const { firstExternalId, secondExternalId, winnerExternalId } = scenario.contestedPair;
  const byExternalId: Record<string, MemoryId> = {
    [scenario.original.externalId]: originalId,
    [scenario.correction.externalId]: correctionId,
  };
  const firstId = byExternalId[firstExternalId];
  const secondId = byExternalId[secondExternalId];
  const winnerId = byExternalId[winnerExternalId];
  if (firstId === undefined || secondId === undefined || winnerId === undefined) {
    throw new Error(
      "resolveContestedIds: scenario.contestedPair が scenario.original/correction の " +
        "externalId と対応していない（シナリオの定義バグ）。",
    );
  }
  return { firstId, secondId, winnerId };
}

/**
 * この3回の `recall()` が共通して使うクエリ。**`limit: 1` を明示する**——理由は
 * このファイル冒頭の doc コメント参照（段3の必須同伴取得を実際に発火させるため、
 * ADR 0162 決定5）。同じクエリを使い回すことで、「訂正の前後で答えがどう変わるか」を
 * 同じ条件で比較できる。
 */
function buildRecallQuery(scenario: CorrectionScenario): { text: string; limit: number } {
  return { text: scenario.query, limit: 1 };
}

/**
 * シナリオを `Runtime` に対して端から端まで走らせる。
 *
 * 1. `original`/`correction` を `observe()` する（別々の Memory になる）。
 * 2. `tick()` を干上がるまで回して埋め込みを済ませる。
 * 3. 訂正前の `recall()`（対向の宣言をまだ `markContested` していない状態。`limit: 1`
 *    なのでこの時点では1件しか返らない）。
 * 4. `markContested`（シナリオの宣言をそのまま渡す）。
 * 5. 訂正を対にした直後の `recall()`（`limit: 1` でも両方が隣接して出るはず——
 *    mandatory companion retrieval が limit を超えて対向を連れてくる、ADR 0134/0162）。
 * 6. `resolveContested({ kind: 'supersede', winnerId })`（`winnerId` もシナリオの宣言）。
 * 7. 解決後の `recall()`（負けた側は `superseded` になり、`limit` に関わらずもう出ない）。
 */
export async function runCorrectionDemo(
  runtime: Runtime,
  ctx: Ctx,
  scenario: CorrectionScenario = CORRECTION_SCENARIO,
): Promise<CorrectionDemoResult> {
  const originalObserved = await runtime.observe(ctx, {
    kind: "utterance",
    text: scenario.original.text,
    speaker: "user",
    externalId: scenario.original.externalId,
  });
  const correctionObserved = await runtime.observe(ctx, {
    kind: "utterance",
    text: scenario.correction.text,
    speaker: "user",
    externalId: scenario.correction.externalId,
  });
  await drainEmbedTicks(runtime, ctx);

  const originalId = originalObserved.memoryIds[0];
  const correctionId = correctionObserved.memoryIds[0];
  if (originalId === undefined || correctionId === undefined) {
    throw new Error(
      "runCorrectionDemo: observe() が Memory を作らなかった（抽出設定を確認すること）。",
    );
  }

  const recallQuery = buildRecallQuery(scenario);
  const beforeMark = await runtime.recall(ctx, recallQuery);

  const { firstId, secondId, winnerId } = resolveContestedIds(scenario, originalId, correctionId);
  const markResult = await runtime.markContested(ctx, firstId, secondId);

  const afterMark = await runtime.recall(ctx, recallQuery);

  const resolveResult = await runtime.resolveContested(ctx, firstId, secondId, {
    kind: "supersede",
    winnerId,
  });

  const afterResolve = await runtime.recall(ctx, recallQuery);

  return {
    scenario,
    originalId,
    correctionId,
    beforeMark,
    markOutcomeKind: markResult.outcome.kind,
    afterMark,
    resolveOutcomeKind: resolveResult.outcome.kind,
    afterResolve,
  };
}

export interface CorrectionDemoCheck {
  /** markContested が実際に "contested" を返したか。 */
  markSucceeded: boolean;
  /** resolveContested が実際に "resolved" を返したか。 */
  resolveSucceeded: boolean;
  /** markContested 後の recall で、両方が同時に出たか。 */
  afterMarkBothPresent: boolean;
  /**
   * markContested 後の recall で、`original`/`correction` の**どちらか片方**の
   * retrievedVia が mandatory_companion か。
   *
   * ⚠ **どちらが mandatory_companion になるかはスコアのランキング次第であり、
   * `resolveContested` の勝者（`scenario.contestedPair.winnerExternalId`）とは無関係**
   * （ADR 0162 決定5）——段2（再スコア）で `limit` 内に自然に残ったほうが「アンカー」、
   * 残らなかったほうが「同伴（mandatory_companion）」として強制的に連れてこられる。
   * このスコア順は実行のたびに変わりうる想定はしていない（決定的な provider・固定の
   * テキストなので同じ実行環境では安定するはずだが、**どちらが勝つかを前提にした
   * 検査にしない**——`afterMarkCompanionOfOther` も参照）。
   */
  afterMarkCompanionRetrieval: boolean;
  /**
   * markContested 後の recall で、mandatory_companion 側の companionOf が、
   * もう片方（アンカー側）の memoryId を指しているか。**`original`/`correction` の
   * どちらがアンカーでどちらが同伴かは決め打たない**（上の `afterMarkCompanionRetrieval`
   * の注記参照）——対がちゃんと相互に指し合っているかだけを見る。
   */
  afterMarkCompanionOfOther: boolean;
  /**
   * 北極星 項目5 の核心: resolveContested 後、**古いほう（original）が recall から
   * 消えたか**。
   */
  afterResolveOriginalAbsent: boolean;
  /** resolveContested 後も、新しいほう（correction）は残っているか。 */
  afterResolveCorrectionPresent: boolean;
}

/** `CorrectionDemoResult` から、見せたい性質を機械的に判定する（印字・歯の両方が使う）。 */
export function checkCorrectionDemo(result: CorrectionDemoResult): CorrectionDemoCheck {
  const afterMarkOriginal = findByMemoryId(result.afterMark.memories, result.originalId);
  const afterMarkCorrection = findByMemoryId(result.afterMark.memories, result.correctionId);

  // 🔑 どちらが mandatory_companion になるかを決め打たない（上の doc コメント参照）。
  // 「ちょうど片方が mandatory_companion で、その companionOf がもう片方を指す」ことだけを
  // 見る——ランキングの勝敗にも resolveContested の勝敗にも依存しない検査にする。
  const companion =
    afterMarkOriginal?.retrievedVia === "mandatory_companion"
      ? afterMarkOriginal
      : afterMarkCorrection?.retrievedVia === "mandatory_companion"
        ? afterMarkCorrection
        : undefined;
  const anchor =
    companion === undefined
      ? undefined
      : companion === afterMarkOriginal
        ? afterMarkCorrection
        : afterMarkOriginal;

  return {
    markSucceeded: result.markOutcomeKind === "contested",
    resolveSucceeded: result.resolveOutcomeKind === "resolved",
    afterMarkBothPresent: afterMarkOriginal !== undefined && afterMarkCorrection !== undefined,
    afterMarkCompanionRetrieval: companion !== undefined,
    afterMarkCompanionOfOther:
      companion !== undefined && anchor !== undefined && companion.companionOf === anchor.memoryId,
    afterResolveOriginalAbsent:
      findByMemoryId(result.afterResolve.memories, result.originalId) === undefined,
    afterResolveCorrectionPresent:
      findByMemoryId(result.afterResolve.memories, result.correctionId) !== undefined,
  };
}

function formatMemoryList(memories: RecallResult["memories"]): string {
  if (memories.length === 0) {
    return "  (0件)";
  }
  return memories
    .map(
      (m) =>
        `  - "${m.digest}" (retrievedVia=${m.retrievedVia}${m.companionOf ? `, companionOf=${m.companionOf}` : ""})`,
    )
    .join("\n");
}

/** 画面向けの印字。訂正の前後で `recall()` の答えがどう変わるかを並べて見せる。 */
export function formatCorrectionDemo(result: CorrectionDemoResult): string {
  const check = checkCorrectionDemo(result);
  const lines: string[] = [];

  lines.push(`元の発話: "${result.scenario.original.text}" (memoryId=${result.originalId})`);
  lines.push(`訂正の発話: "${result.scenario.correction.text}" (memoryId=${result.correctionId})`);
  lines.push(`問い合わせ: recall({ text: "${result.scenario.query}", limit: 1 })`);
  lines.push("");

  lines.push("--- 1. markContested 前（まだ対向として宣言していない） ---");
  lines.push(`件数: ${result.beforeMark.memories.length}`);
  lines.push(formatMemoryList(result.beforeMark.memories));
  lines.push("");

  lines.push(`--- 2. markContested(original, correction) ⟹ outcome=${result.markOutcomeKind} ---`);
  lines.push(`件数: ${result.afterMark.memories.length}`);
  lines.push(formatMemoryList(result.afterMark.memories));
  lines.push(
    `⟹ 両方出た: ${check.afterMarkBothPresent ? "はい" : "いいえ"} / ` +
      `mandatory_companion として出た: ${check.afterMarkCompanionRetrieval ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push(
    `--- 3. resolveContested(supersede, winner=correction) ⟹ outcome=${result.resolveOutcomeKind} ---`,
  );
  lines.push(`件数: ${result.afterResolve.memories.length}`);
  lines.push(formatMemoryList(result.afterResolve.memories));
  lines.push(
    `⟹ 古いほうが消えた: ${check.afterResolveOriginalAbsent ? "はい" : "いいえ"} / ` +
      `新しいほうは残った: ${check.afterResolveCorrectionPresent ? "はい" : "いいえ"}`,
  );
  lines.push("");
  lines.push(
    "⟹ 北極星「間違いを正すと、古いほうが先に出てこなくなる」を、" +
      "markContested → recall（両方隣接）→ resolveContested → recall（敗者は消える）の" +
      "一巡で実演した。",
  );

  return lines.join("\n");
}
