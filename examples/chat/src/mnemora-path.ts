import type {
  Ctx,
  RecallAssociationQuery,
  RecallBudget,
  RecallResult,
  Runtime,
} from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { Conversation } from "./scenario.js";

/**
 * `queryRecall` が既定で渡す `RecallQuery.association`（Issue #291 / ADR 0168）。
 *
 * **値の根拠**: `association-probes` ベンチ（ADR 0158 / 0167 で器の非決定性・
 * probe の公正性を直した後の実測、Issue #291 の 2026-09-16 コメント）が
 * `maxCount=10` で `goldReturned` 0/12 → 12/12（連想でしか届かない gold の
 * 到達が全件揃う）、費用は `memoryChars` +4.32% だったことに基づく。
 * `maxCount=5` では 10/12 止まり（+2.22%）——「聞かれていないことを自分から
 * 思い出す」という目指す姿を、この12件の範囲で完全に満たすのは 10 だけである。
 * 詳細は ADR 0168。
 */
export const DEFAULT_MNEMORA_PATH_ASSOCIATION: RecallAssociationQuery = { maxCount: 10 };

export interface MnemoraPathOptions {
  budget?: RecallBudget;
  /**
   * `RecallQuery.association` に渡す値。**省略時は
   * {@link DEFAULT_MNEMORA_PATH_ASSOCIATION} を渡す**（ADR 0168。「聞かれていないことを、
   * 自分から思い出す」を実際に呼び手側で使う経路にするための既定）。
   * 連想枠そのものを止めたい呼び出し側（比較・検査のため）は `association: null` を
   * 明示すること——`packages/core` 側の既定（省略時 off）とは別に、この関数だけの
   * 既定を on にしている（ADR 0151「決定」の既定 off はそのまま——ここは
   * `examples/chat` という一呼び手が、明示的にオプトインしている形である）。
   */
  association?: RecallAssociationQuery | null;
}

export interface MnemoraPathResult {
  recall: RecallResult;
}

export function externalIdForTurn(index: number): string {
  return `turn-${index}`;
}

/**
 * 冒頭の事実表明（`FACT_STATEMENT`）を取り込んだ Observation の `externalId`。
 *
 * `buildConversation` は事実表明を必ず先頭（index 0）に置く（`scenario.ts`）。
 * **その前提をここで1箇所に閉じ込める**——`compare.ts` が系譜を辿って
 * 「冒頭の事実が残ったか」を判定するのに使う（ADR 0052）。
 */
export function factStatementExternalId(): string {
  return externalIdForTurn(0);
}

/**
 * 会話全体を observe() し、tick() で embed を処理する（経路Bの取り込み段）。
 *
 * `externalId` に turn の連番を使う——同じ `conversation` に対してこの関数を
 * 2度呼んでも（例: recall() を budget 有り/無しで2通り試したい呼び出し側が、
 * 誤ってもう一度 ingest してしまっても）Observation が重複して作られない
 * （roadmap.md 段階3の冪等性がそのまま効く）。**呼び出し側は ingest と query を
 * 混ぜて何度も呼ばない**のが前提だが、それでも壊れないようにしてある。
 *
 * **なぜ `tick()` を1回だけ呼ばないのか（docs/decisions/0019-real-openai-measurement-cost.md
 * §5、docs/decisions/0021-drain-embed-ticks-in-ingest.md）**: `tick()` の既定 `limit` は
 * 50（`DEFAULT_TICK_LIMIT`、`packages/core/src/runtime.ts`）。embed ジョブは
 * `claimBatch` が `ORDER BY available_at ASC` で先着順に claim するため、
 * この関数がかつて `tick()` を1回しか呼んでいなかった頃は、**会話が長くなって
 * observe() された発話が50件を超えると、51件目以降の記憶が埋め込まれないまま
 * `pending` に残り、`recall()` の ANN 候補にすらならない**という欠陥があった
 * （`recall()` はこれを `omitted` に `not_indexed(reason: "pending")` として
 * 正直に出していたが、`examples/chat` 側はそれを読まずに「スコープ内 N 件のうち
 * 10件を返した」という表を書いていた——ADR 0019 §5 が実測して記録した）。
 * ここでは `drainEmbedTicks`（`./embed-drain.js`）で `processed === 0` になるまで
 * `tick()` を回し切ることで、**取り込んだ量に関わらず、ingest が終わった時点で
 * 全件が embed 済みであること**を保証する。
 */
export async function ingestConversation(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
): Promise<void> {
  for (const turn of conversation.userUtterances) {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: turn.text,
      speaker: turn.role,
      externalId: externalIdForTurn(turn.index),
    });
  }
  await drainEmbedTicks(runtime, ctx);
}

/**
 * 経路B（mnemora）の想起段。ingest 済みの `ctx` に対して、終盤の質問を recall() する。
 *
 * **呼び出し側が実際にプロンプトへ積むのは `recall().memories`（の digest）と
 * `index` だけであり、`usage` はその量をそのまま計測している**（docs/recall.md §6）。
 * mnemora 自身はプロンプトを組み立てない（同§6「正直に書くべき限界」）——ここでは
 * その組み立てをサンプルアプリ側（呼び出し側の役）が代行して見せている。
 *
 * `opts.budget` を渡すと、段4（予算による切り詰め）が実際に候補を落とす
 * （docs/recall.md §2 段4）。渡さなければ切り詰めは起こらない。
 *
 * **既定で `association`（連想枠、ADR 0151・Issue #291・ADR 0168）を渡す**——
 * `opts.association` を省略すると {@link DEFAULT_MNEMORA_PATH_ASSOCIATION} が使われる。
 * 明示的に `association: null` を渡した呼び出しだけが、連想枠を持たない
 * `packages/core` の既定（off）のまま呼ぶ。
 */
export async function queryRecall(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: MnemoraPathOptions = {},
): Promise<RecallResult> {
  const association =
    opts.association === null ? undefined : (opts.association ?? DEFAULT_MNEMORA_PATH_ASSOCIATION);
  return runtime.recall(ctx, {
    text: conversation.query,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(association !== undefined ? { association } : {}),
  });
}

/** `ingestConversation` + `queryRecall` を1回で行う便宜関数（`compare.ts` が使う）。 */
export async function runMnemoraPath(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: MnemoraPathOptions = {},
): Promise<MnemoraPathResult> {
  await ingestConversation(runtime, ctx, conversation);
  const recall = await queryRecall(runtime, ctx, conversation, opts);
  return { recall };
}

/**
 * mnemora path が実際にプロンプトへ積む文字列を、`recall()` の返り値だけから組み立てる。
 * `usage.chars` が数えているのと同じ材料（各 memory の digest + index band の JSON）を
 * 呼び出し側の視点で再現する——「mnemora はプロンプトを組み立てない」ことを実演する関数。
 */
export function buildMnemoraPrompt(recall: RecallResult): string {
  const digestLines = recall.memories.map((m) => `- ${m.digest}`).join("\n");
  const indexLine = `(索引: スコープ内 ${recall.index.totalInScope} 件のうち ${recall.memories.length} 件を提示)`;
  return [digestLines, indexLine].filter((s) => s.length > 0).join("\n");
}

/**
 * `reportMemoryUsage` の戻り値。
 *
 * `reported: false` は「呼ばなかった」ことをそのまま返す——`observe()` を呼んで
 * 失敗したのではなく、載せる記憶が0件だったので**そもそも呼んでいない**
 * （`ObserveMemoryUsageInputSchema.usedMemoryIds` は `min(1)` であり、空配列を
 * 渡すと zod に弾かれる。呼び出し側はこの分岐を自分で持つ必要がある）。
 */
export type MemoryUsageReport =
  | { reported: true; recallId: RecallResult["recallId"]; usedMemoryIds: string[] }
  | { reported: false };

/**
 * `recall` が実際にプロンプトへ載せた Memory（＝ `buildMnemoraPrompt` が積んでいるのと
 * 同じ集合、`recall.memories`）を、使用報告として `observe({ kind: 'memory_usage' })` で
 * mnemora へ伝え返す（Issue #301、ADR 0009）。
 *
 * **これを呼ばないと `reinforce` が発火しない**（`runtime.observe` の
 * `handleMemoryUsage` → `recordUsage` → `insertedMemoryIds` ごとに `reinforce`。
 * `packages/core/src/runtime.ts`）——使われた記憶と使われなかった記憶が同じ速さで
 * 遠ざかっていた、というのが Issue #301 の欠落そのものである。
 *
 * **明示的な opt-in 関数である。**`tick()` や Scheduler には一切乗せていない
 * ——呼ばない呼び出し側でも `observe`/`recall` はそれまでどおり成立する
 * （ADR 0114 決定3・0115 決定7 と同じ規律。北極星の問い2「これを無効にしたとき、
 * Memory Framework として成立するか」に当てた結果は該当 ADR に書く）。
 *
 * **報告は、呼び出し側が `recall` の測定・表示を終えたあとに呼ぶことを想定している**
 * ——この関数自身は `recall` を撃たない（引数で受け取るだけ）ので、呼んでも
 * その `recall` の測定値（`usage`/`omitted`/`index` 等）は一切変わらない。
 */
export async function reportMemoryUsage(
  runtime: Runtime,
  ctx: Ctx,
  recall: RecallResult,
): Promise<MemoryUsageReport> {
  const usedMemoryIds = recall.memories.map((m) => m.memoryId);
  if (usedMemoryIds.length === 0) {
    return { reported: false };
  }
  await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: recall.recallId,
    usedMemoryIds,
  });
  return { reported: true, recallId: recall.recallId, usedMemoryIds };
}
