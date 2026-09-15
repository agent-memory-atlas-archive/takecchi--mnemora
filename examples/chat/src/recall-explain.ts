import { randomUUID } from "node:crypto";
import type {
  Ctx,
  MemoryStore,
  RecallId,
  RecallRecord,
  RecallRecordMemory,
  RecallRecordReturnedMemories,
  Runtime,
  ScoreBreakdown,
} from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";

/**
 * [Issue #312](https://github.com/takecchi/mnemora/issues/312) /
 * [ADR 0161](../../../docs/decisions/0161-runtime-get-recall.md):
 * 北極星「目指す姿」の「なぜそれを思い出したのかを、後から説明できる。」の**「後から」**を、
 * 動く例として見せるデモ（examples/chat/README.md「`explain`」節）。
 *
 * [ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md) で
 * `recalls` にスコア内訳が永続化され `MemoryStore.getRecall` で読み戻せるようになったが、
 * それを呼ぶ本番コードは0件だった（Issue #312 が `git grep` で確認）。このファイルは
 * その空白を埋める——`recall()` を呼んだその場で結果を整形するのではなく、
 * **`recallId` だけを持ち帰り、別の呼び出しとして `runtime.getRecall(ctx, recallId)` を
 * 呼んで、永続化された `recalls` 行を読み戻す**ことを、コードを読んだ人に分かる形にする。
 *
 * **⚠ 北極星の主測定（`compare`/`retrieval`）には一切関わらない。**このファイルは
 * `runComparison`/`runRetrievalQualityArm` を呼ばず、`compare.ts`/`compare-json.ts`/
 * `naive-path.ts`/`scenario.ts`/`probe-set.ts`/`retrieval-quality.ts` のいずれも
 * import しない——測定条件を一切共有しない、独立したデモである（`scope.ts` と同じ規律）。
 * 表示に使う値は `RecallResult`（`recall()` の戻り値）ではなく `RecallRecord`
 * （`getRecall()` の戻り値）から作る——プロンプトへ積む文字列には一切混ぜない。
 */

/** 埋め込みが終わっている2件の事実。recall の候補になり、内訳つきで返る。 */
const EXPLAIN_FACT_FOOD = "好きな食べ物はカレーです。";
const EXPLAIN_FACT_HOBBY = "趣味は写真撮影です。";
/**
 * ⚠ 意図的に embed させないままにする3件目の事実。`drainEmbedTicks` をこの発話の
 * *前*までしか呼ばないことで、`embeddingStatus` が `pending` のまま残る——
 * 「索引に載っていない記憶」を1件意図的に作り、`RecallRecord.omitted` に
 * `{ kind: 'not_indexed', reason: 'pending' }` が現れることを実演する
 * （docs/recall.md §4、ADR 0008「無い」の分類）。
 */
const EXPLAIN_FACT_PENDING = "住んでいる街は京都です。";

const EXPLAIN_EXTERNAL_ID_FOOD = "recall-explain-demo-food";
const EXPLAIN_EXTERNAL_ID_HOBBY = "recall-explain-demo-hobby";
const EXPLAIN_EXTERNAL_ID_PENDING = "recall-explain-demo-pending";

/** 埋め込み済みの2件の話題を両方含む問い合わせ。 */
export const RECALL_EXPLAIN_QUERY = "好きな食べ物と趣味は何ですか?";

export interface RecallExplainDemoResult {
  tenantId: string;
  /** `recall()` の戻り値から使うのはこれだけ（PR 本文の決定どおり、他の欄は使わない）。 */
  recallId: RecallId;
  /**
   * `recall()` がその場で返した `memoryId` の集合。**表示には使わない**——
   * `record`（`getRecall()` の戻り値）と同じ集合になっているかを、歯（テスト）から
   * 突き合わせるためだけに持つ。
   */
  recallResultMemoryIds: string[];
  /**
   * `runtime.getRecall(ctx, recallId)` の戻り値。**その場の `RecallResult` を
   * 整形し直したものではない**——別の呼び出しで、永続化された `recalls` 行を
   * 読み戻したもの。
   */
  record: RecallRecord | null;
  /** 実在しない `recallId`（`getRecall` が `null` を返すことを実演するための値）。 */
  missingRecallId: RecallId;
  /** 上記 `missingRecallId` を引いた結果。常に `null` のはず。 */
  missingRecord: RecallRecord | null;
  /**
   * `record.returnedMemories` に載っている `memoryId` ごとの `digest`。
   * `MemoryStore.get(ctx, memoryId)` で個別に引く——`RecallRecordMemory` 自身は
   * `digest` を運ばない（ADR 0155 決定1。`Runtime.getRecall` の doc コメント参照）。
   */
  digestByMemoryId: Record<string, string>;
}

/**
 * デモ本体（印字を持たない、テストから呼べる形。`scope.ts`/`backfill.ts` と同じ分離）。
 *
 * 1. 2件の事実を観測し、embed を干上がらせる（この2件だけが索引に載る）。
 * 2. 3件目を観測するが、**あえて embed を干上がらせない**——`pending` のまま残す。
 * 3. `runtime.recall()` を呼び、返り値からは `recallId` だけを使う。
 * 4. **別の呼び出しとして** `runtime.getRecall(ctx, recallId)` を呼び、`RecallRecord`
 *    を得る——ここが本 issue の核心（PR 本文参照）。
 * 5. 存在しない `recallId` でも `getRecall` を呼び、`null` が返ることを実演する。
 * 6. `record.returnedMemories` の各 `memoryId` について `memoryStore.get` で `digest` を引く。
 */
export async function runRecallExplainDemo(
  runtime: Runtime,
  memoryStore: MemoryStore,
  tenantId: string,
): Promise<RecallExplainDemoResult> {
  const ctx: Ctx = { tenantId };

  await runtime.observe(ctx, {
    kind: "utterance",
    text: EXPLAIN_FACT_FOOD,
    speaker: "user",
    externalId: EXPLAIN_EXTERNAL_ID_FOOD,
  });
  await runtime.observe(ctx, {
    kind: "utterance",
    text: EXPLAIN_FACT_HOBBY,
    speaker: "user",
    externalId: EXPLAIN_EXTERNAL_ID_HOBBY,
  });
  // この時点で干上がらせる — food/hobby だけが embeddingStatus: 'ready' になる。
  await drainEmbedTicks(runtime, ctx);

  // 3件目はこの後で観測し、embed ジョブを積んだままにする(呼ばないのが意図的)。
  await runtime.observe(ctx, {
    kind: "utterance",
    text: EXPLAIN_FACT_PENDING,
    speaker: "user",
    externalId: EXPLAIN_EXTERNAL_ID_PENDING,
  });

  const recallResult = await runtime.recall(ctx, { text: RECALL_EXPLAIN_QUERY });
  const { recallId } = recallResult;

  // ⚠ ここから先は、上の recallResult を一切参照しない。recallId だけを渡して、
  // 別の呼び出しで永続化された行を読み戻す。
  const record = await runtime.getRecall(ctx, recallId);

  // getRecall が null を返す経路も実演する — 実在しない recallId を渡す。
  const missingRecallId: RecallId = randomUUID();
  const missingRecord = await runtime.getRecall(ctx, missingRecallId);

  const digestByMemoryId: Record<string, string> = {};
  if (record && record.returnedMemories.breakdownCaptured) {
    for (const m of record.returnedMemories.memories) {
      const memory = await memoryStore.get(ctx, m.memoryId);
      if (memory) {
        digestByMemoryId[m.memoryId] = memory.digest;
      }
    }
  }

  return {
    tenantId,
    recallId,
    recallResultMemoryIds: recallResult.memories.map((m) => m.memoryId),
    record,
    missingRecallId,
    missingRecord,
    digestByMemoryId,
  };
}

/** `ScoreBreakdown` の全項を、任意項は在るときだけ並べる1行に整形する。 */
function formatScoreBreakdown(score: ScoreBreakdown): string {
  const parts: string[] = [];
  if (score.similarity !== undefined) {
    parts.push(`similarity=${score.similarity.toFixed(3)}`);
  }
  if (score.lexicalMatch !== undefined) {
    parts.push(`lexicalMatch=${score.lexicalMatch.toFixed(3)}`);
  }
  parts.push(`decay=${score.decay.toFixed(3)}`);
  parts.push(`tagMatch=${score.tagMatch.toFixed(3)}`);
  parts.push(`freshness=${score.freshness.toFixed(3)}`);
  parts.push(`strength=${score.strength.toFixed(3)}`);
  parts.push(`total=${score.total.toFixed(3)}`);
  return parts.join(" ");
}

function formatReturnedMemory(
  m: RecallRecordMemory | { memoryId: string },
  breakdownCaptured: boolean,
  digestByMemoryId: Record<string, string>,
): string {
  const digest = digestByMemoryId[m.memoryId] ?? "(digest不明——memoryStore.get で引けなかった)";
  if (!breakdownCaptured || !("score" in m)) {
    return `  - memoryId=${m.memoryId} digest="${digest}" (内訳なし)`;
  }
  const extra = [
    m.companionOf ? `companionOf=${m.companionOf}` : undefined,
    m.associationOf ? `associationOf=${m.associationOf}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(" ");
  return (
    `  - memoryId=${m.memoryId} via=${m.retrievedVia} digest="${digest}" ` +
    `score(${formatScoreBreakdown(m.score)})${extra ? ` ${extra}` : ""}`
  );
}

/**
 * `RecallRecordReturnedMemories` を印字する。
 *
 * 🔴 **`breakdownCaptured: false` を「0」や「空」に読み替えない**（PR 本文の受け入れ条件・
 * ADR 0008「無い」の分類、ADR 0155 決定2）。マイグレーション以前に書かれた行は
 * 内訳を一度も持ったことが無い——それを名指しで印字する。
 */
function formatReturnedMemories(
  returned: RecallRecordReturnedMemories,
  digestByMemoryId: Record<string, string>,
): string[] {
  const lines: string[] = [];
  lines.push(`breakdownCaptured: ${returned.breakdownCaptured}`);
  if (!returned.breakdownCaptured) {
    lines.push(
      "  ⚠ この recall は内訳を持たない(マイグレーション以前に書かれた行)。" +
        "スコアが無いことは「0」でも「空」でもなく、そもそも記録されなかった(ADR 0008)。",
    );
  }
  lines.push(`returnedMemories (${returned.memories.length} 件):`);
  if (returned.memories.length === 0) {
    lines.push("  (0件)");
  }
  for (const m of returned.memories) {
    lines.push(formatReturnedMemory(m, returned.breakdownCaptured, digestByMemoryId));
  }
  return lines;
}

function formatRecallRecordBody(
  record: RecallRecord,
  digestByMemoryId: Record<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`recallId    = ${record.recallId}`);
  lines.push(`tenantId    = ${record.tenantId}`);
  lines.push(`subjectId   = ${record.subjectId ?? "(無し)"}`);
  lines.push(`createdAt   = ${record.createdAt.toISOString()}`);
  lines.push("");
  lines.push(...formatReturnedMemories(record.returnedMemories, digestByMemoryId));
  lines.push("");
  lines.push(`omitted (${record.omitted.length} 件) — なぜ落ちたか:`);
  if (record.omitted.length === 0) {
    lines.push("  (無し)");
  }
  for (const o of record.omitted) {
    lines.push(`  - ${JSON.stringify(o)}`);
  }
  lines.push("");
  lines.push(
    `indexBand: totalInScope=${record.indexBand.totalInScope} ` +
      `(countKind=${record.indexBand.countKind}), groups=${record.indexBand.groups.length}`,
  );
  lines.push(
    `usage: chars=${record.usage.chars} estimatedTokens=${record.usage.estimatedTokens} ` +
      `(counter=${record.usage.counter})`,
  );
  lines.push(`explain.stages (${record.explain.stages.length} 件) — 段トレース:`);
  for (const stage of record.explain.stages) {
    lines.push(
      `  - stage=${stage.stage} executed=${stage.executed}` +
        (stage.detail ? ` detail=${JSON.stringify(stage.detail)}` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * `getRecall` の戻り値（`RecallRecord | null`）を印字する。
 *
 * 🔴 **`null`（見つからなかった）を名指しで印字する**——空配列や「0件」に潰さない
 * （PR 本文の受け入れ条件）。
 */
function formatRecordOrMissing(
  record: RecallRecord | null,
  digestByMemoryId: Record<string, string>,
): string {
  if (record === null) {
    return (
      "見つからなかった(null) — この recallId の recall は存在しないか、別テナントのもの" +
      "である(MemoryStore.get/getObservation と同じ規律。例外にしない)。"
    );
  }
  return formatRecallRecordBody(record, digestByMemoryId);
}

/** 画面向けの印字。`result.record`/`result.missingRecord` のみを元に組み立てる。 */
export function formatRecallExplainDemo(result: RecallExplainDemoResult): string {
  const lines: string[] = [];
  lines.push(`tenantId = ${result.tenantId}`);
  lines.push(`recallId = ${result.recallId}`);
  lines.push("");
  lines.push(
    "⚠ 以下は recall() が返した RecallResult をその場で整形したものではない。" +
      "別の呼び出し runtime.getRecall(ctx, recallId) で、永続化された recalls 行を" +
      "読み戻している。",
  );
  lines.push("");
  lines.push("--- runtime.getRecall(ctx, recallId) ---");
  lines.push(formatRecordOrMissing(result.record, result.digestByMemoryId));
  lines.push("");
  lines.push(`--- runtime.getRecall(ctx, <存在しない recallId=${result.missingRecallId}>) ---`);
  lines.push(formatRecordOrMissing(result.missingRecord, {}));
  return lines.join("\n");
}
