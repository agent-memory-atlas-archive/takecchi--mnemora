import { heuristicTokenCounter, writeDecayClock } from "@mnemora/core";
import type {
  Ctx,
  DecayClock,
  MemoryStore,
  Omission,
  Runtime,
  TenantSettingsStore,
} from "@mnemora/core";
import { buildConversation } from "./scenario.js";
import { measureNaive } from "./naive-path.js";
import { factStatementExternalId, reportMemoryUsage, runMnemoraPath } from "./mnemora-path.js";
import { resultContainsObservation } from "./provenance-trace.js";

/**
 * `recall().memories` の中に、冒頭の事実表明の**出典に到達しているか**を判定する
 * （経緯: 当初は `digest.includes("青")` という文字列一致だったが、本物の LLM の要約・
 * 言い換えに耐えないため ADR 0052 で系譜追跡へ置き換えた）。
 *
 * 🔴 **`sourceObservationId` を辿って `externalId` で照合するだけであり
 * （`./provenance-trace.js`）、digest の中身は一切見ない。** ⟹ 要約で答えの情報が
 * 失われていても、出典が同じなら true になる——**情報が残ったこと・全文なしで
 * 答えられたことの証明ではない**（`docs/autonomy.md` §2.2 の2番、ADR 0226）。
 *
 * ⚠ **この関数名・返り値は `ComparisonRow.factStatementSurvived` として公開 JSON へ
 * そのまま写る（⭐門、ADR 0133）。関数名（呼び出し側にしか見えないローカル名）は
 * 出典到達と分かる名前に変えたが、JSON のキー名は変えていない**——理由は
 * `ComparisonRow.factStatementSurvived` の docstring を見ること。
 */
async function factStatementSourceReached(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memories: readonly { memoryId: string }[],
): Promise<boolean> {
  return resultContainsObservation(memoryStore, ctx, memories, factStatementExternalId());
}

/** `omitted` のうち `not_indexed`（reason 問わず）の `count` を合算する。 */
function notIndexedCount(omitted: Omission[]): number {
  return omitted
    .filter((o): o is Extract<Omission, { kind: "not_indexed" }> => o.kind === "not_indexed")
    .reduce((sum, o) => sum + o.count, 0);
}

/**
 * `compare` が測る会話の長さ（filler 往復数）の既定の列。
 *
 * **`cli.ts` から移した**（ADR 0052）——カセットの被覆を検査する歯
 * （`cassette-coverage.test.ts`）が、実 API を何回叩く列なのかを知る必要があるため。
 * 合計 Σ(fillerPairs+1) = 657 回の LLM 呼び出しになる。
 */
export const DEFAULT_COMPARE_SEQUENCE = [0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320];

export interface ComparisonRow {
  fillerPairs: number;
  turnCount: number;
  naiveChars: number;
  naiveTokens: number;
  mnemoraChars: number;
  mnemoraTokens: number;
  mnemoraShareOfNaiveChars: number;
  /** そのテナントのスコープ内総数（`recall().index.totalInScope`）。テナント分離の検査に使う。 */
  totalInScope: number;
  /**
   * `recall().omitted` をそのまま持つ（要約しない）。
   *
   * 以前はここを `omittedKinds: string[]`（`kind` だけ）にしていたが、それでは
   * `reason`・`count`・`countKind` が消え、「スコープ内321件のうち271件が埋め込まれて
   * いない」のような、北極星の物差しに答えるために要る情報が失われる。ADR 0008 の芯は
   * 「推定値を実測値の顔で出さない」ことであり、`countKind`（`exact`/`lower_bound`/
   * `unknown`）を捨てるとその区別自体が消えるため、`Omission` を丸ごと保持する。
   */
  omitted: Omission[];
  /** 実際に返った件数（`recall().memories.length`）。 */
  returnedCount: number;
  /**
   * スコープ内（`totalInScope`）のうち、実際に ANN の候補になれた件数
   * （= totalInScope − `omitted` の `not_indexed`（reason 問わず）の合計）。
   *
   * これが「321件と競ったのか、50件と競ったのか」（PR 本文の核心の問い）に直接答える列。
   * ADR 0021 で `ingestConversation` が `tick()` を回し切るようになった後は、
   * この値が `totalInScope` と一致し（`not_indexed(pending)` が `omitted` に現れず）
   * なるはず——ただし本 PR ではそれを実測していない（README・報告参照）。
   *
   * ⚠ `not_indexed` の `countKind` が `exact` でない場合（Phase 1 の実装では常に
   * `exact`）でも、この引き算は常に count をそのまま差し引く。`countKind` は
   * `omitted` 列にそのまま残るので、不確かさの有無はそちらで確認できる。
   */
  annCandidateCount: number;
  /**
   * 冒頭の事実表明（`FACT_STATEMENT`）の出典（`sourceObservationId` → `externalId`）に、
   * `recall().memories` が到達しているか。判定方法は `factStatementSourceReached`
   * （このファイル）を見ること。
   *
   * 🔴 **測っているのは出典への到達だけである。情報保持・最終回答の正誤は測っていない**
   * （`docs/autonomy.md` §2.2 の2番、ADR 0226）。要約で答えの情報が失われていても、
   * 出典が同じなら true になる。
   *
   * ⚠ **かつてここには「このシナリオと擬似 provider に固有の近似判定であり、一般的な
   * 判定ではない」と書かれていたが、これは陳腐化していた**——`resultContainsObservation`
   * は provider が擬似か本物かに依らず同じ意味になる（`provenance-trace.ts`）。`compare`
   * は ADR 0133 により `recorded`（記録した実 API 応答の再生）で走り、「擬似だから
   * 質を主張しない」という理由自体を ADR 0146 が「正解集合を持たない器だから」へ
   * 差し替えている。
   *
   * 🔴 **欄名（`factStatementSurvived`）は据え置いている。** 意味は「生存」ではなく
   * 「到達」だが、⭐門（ADR 0133）と `examples/chat/compare-baseline.json` がこの
   * 名前を JSON のキーとして参照しており、改名すると単なる改名のために契約と検査を
   * 破壊することになる（Issue #496 完了条件2）。名前と意味のずれの是正は、改名では
   * なくこのコメント・表示・文書で行う——詳細は ADR 0226。
   */
  factStatementSurvived: boolean;
  /**
   * ⭐ Issue #301 / ADR 0163: この行の `recall()` で実際にプロンプトへ積んだ Memory
   * （`recall.memories`）を `observe({kind:'memory_usage'})` で報告したか。
   *
   * **`compare-json.ts` の `buildCompareJson` はこの欄を写さない**——`compare.json`
   * のスキーマ（⭐ 門、ADR 0133）を変えないため、明示的に列挙から外してある。
   * この欄はテスト・呼び出し側からの可視化のためだけに在る。
   */
  memoryUsageReported: boolean;
}

export interface CompareOptions {
  /** 会話の長さ（filler 往復数）を変えた数点。北極星の物差しに答えるための核心。 */
  fillerPairsSequence: number[];
  /** テナントIDの接頭辞。テスト側から重複を避けるために差し替えられるようにしてある。 */
  tenantPrefix?: string;
  /**
   * 冒頭の事実の出典に到達したかを `sourceObservationId` で辿るために必要（ADR 0052）。
   *
   * **省略可能にしていない。**省略を許すと文字列一致へ倒れる経路が残り、
   * 「どちらの判定で出た ❌ なのか」が表から読めなくなる。
   */
  memoryStore: MemoryStore;
  /**
   * `--decay-clock`（ADR 0165 決めたこと11）が指定されたときだけ渡す。
   * `store`/`clock` を1つの欄にまとめているのは、**「書くかどうか」を1個の
   * optional な値の有無だけで判定できるようにするため**——`decayClock` と
   * `tenantSettingsStore` を別々の optional にすると、片方だけ渡された不整合な
   * 状態を型で防げなくなる。
   *
   * 各 `fillerPairs` ごとに新しく作るテナントすべてに対して、会話を ingest する
   * 前に `writeDecayClock`（`@mnemora/core`）で書き込む。**省略時はこの関数を
   * 一度も呼ばない**——既定 `'wall'` のテナントで `tenant_settings` への書き込みが
   * 1本も増えないことの唯一の保証点。
   */
  decayClock?: { store: TenantSettingsStore; clock: DecayClock };
}

/**
 * 会話の長さを変えて、経路A（naive）・経路B（mnemora）が実際に焼く量を測る
 * （PR 本文「量の比較」。docs/roadmap.md §4「計測と抑止を混同しない」を踏まえ、
 * ここでは budget を渡さない——「切り詰めずに、そのままだと何文字になるか」を見る）。
 *
 * `fillerPairsSequence` の要素ごとに新しい tenantId を使う。recall() のスコープは
 * テナント単位（docs/recall.md 段0）であり、同じテナントに会話を積み増していくと、
 * 後の計測が前の会話の記憶を引きずってしまい「その長さの会話単体で何文字になるか」
 * を独立に測れなくなる。
 */
export async function runComparison(
  runtime: Runtime,
  options: CompareOptions,
): Promise<ComparisonRow[]> {
  const tenantPrefix = options.tenantPrefix ?? "example-compare";
  const rows: ComparisonRow[] = [];
  for (const fillerPairs of options.fillerPairsSequence) {
    const ctx: Ctx = { tenantId: `${tenantPrefix}-${fillerPairs}` };
    if (options.decayClock !== undefined) {
      await writeDecayClock(options.decayClock.store, ctx, options.decayClock.clock);
    }
    const conversation = buildConversation(fillerPairs);
    const naive = measureNaive(conversation, heuristicTokenCounter);
    const { recall } = await runMnemoraPath(runtime, ctx, conversation);
    const survived = await factStatementSourceReached(options.memoryStore, ctx, recall.memories);

    // ⭐ Issue #301 / ADR 0163: この行の測定(上の `recall`/`survived`)が終わった
    // あとに使用報告する。`reportMemoryUsage` は recall を撃たない(受け取るだけ)
    // ので、ここで呼んでもこの行の測定値(naiveChars/mnemoraChars/omitted/…)は
    // 一切変わらない——「報告は測定済みの recall の後」という配線方針そのもの。
    const usageReport = await reportMemoryUsage(runtime, ctx, recall);

    rows.push({
      fillerPairs,
      turnCount: conversation.turns.length,
      naiveChars: naive.chars,
      naiveTokens: naive.estimatedTokens,
      mnemoraChars: recall.usage.chars,
      mnemoraTokens: recall.usage.estimatedTokens,
      mnemoraShareOfNaiveChars: recall.usage.chars / naive.chars,
      totalInScope: recall.index.totalInScope,
      omitted: recall.omitted,
      returnedCount: recall.memories.length,
      annCandidateCount: recall.index.totalInScope - notIndexedCount(recall.omitted),
      factStatementSurvived: survived,
      memoryUsageReported: usageReport.reported,
    });
  }
  return rows;
}

export function formatComparisonTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | mnemora/naive (chars) |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const ratio = `${(r.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
    return `| ${r.turnCount} | ${r.naiveChars} | ${r.naiveTokens} | ${r.mnemoraChars} | ${r.mnemoraTokens} | ${ratio} |`;
  });
  return [header, sep, ...body].join("\n");
}

/** `omitted` を `kind(detail):count` の形にまとめた1行にする（件数を落とさない）。 */
function formatOmittedSummary(omitted: Omission[]): string {
  if (omitted.length === 0) {
    return "(無し)";
  }
  return omitted
    .map((o) => {
      switch (o.kind) {
        case "not_indexed":
          return `not_indexed(${o.reason}):${o.count}`;
        case "filtered":
          return `filtered(${o.condition}):${o.count}`;
        case "below_threshold":
          return `below_threshold:${o.count}`;
        case "over_limit":
          return `over_limit:${o.count}`;
        case "budget_dropped":
          return `budget_dropped:${o.count}`;
        case "stage_skipped":
          return `stage_skipped(${o.stage}/${o.reason})`;
        case "ann_truncated":
          return "ann_truncated";
        case "ann_unreached":
          return "ann_unreached";
        // ADR 0084。件数を持たない札なので、ann_truncated / ann_unreached と同じ形で名前だけ出す。
        case "lexical_truncated":
          return "lexical_truncated";
        case "unit_assembly_dropped":
          return `unit_assembly_dropped:${o.count}`;
        case "score_not_comparable":
          return `score_not_comparable:${o.count}`;
        default: {
          // 網羅性の歯: Omission に新しい kind が増えたらここが型エラーになる。
          const exhaustive: never = o;
          return String(exhaustive);
        }
      }
    })
    .join(", ");
}

/**
 * 北極星の物差し（「会話ログを全部プロンプトへ積むのをやめられたか」）に直接答える表。
 *
 * `formatComparisonTable`（量だけの表）と違い、こちらは「削っても目的の記憶の
 * 出典に到達できなくなっていないか」——README「⭐ 削減率だけでは意味を持たない」節の
 * 表に対応する。「返った件数」だけでなく「実際に ANN の候補になれた件数」を並べることで、
 * 「スコープ内 totalInScope 件と競ったのか、それより少ない候補としか競っていないのか」
 * を1行で読めるようにしてある（ADR 0021 が直した欠陥の再発を、この表だけで検知できる
 * ——`annCandidateCount` が `totalInScope` を下回れば、`omitted` 列の
 * `not_indexed(pending):N` がその内訳を示す）。
 *
 * 🔴 「冒頭の事実の出典に到達したか」列が測るのは出典到達だけである。情報保持・
 * 最終回答の正誤はこの表に載っていない（`ComparisonRow.factStatementSurvived` の
 * docstring、`docs/autonomy.md` §2.2 の2番、ADR 0226）。
 */
export function formatRecallQualityTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | スコープ内の Memory | ANN の候補になれた件数 | 返った件数 | 冒頭の事実の出典に到達したか | `omitted` の内訳 |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const survived = r.factStatementSurvived ? "✅" : "❌";
    return `| ${r.turnCount} | ${r.totalInScope} | ${r.annCandidateCount} | ${r.returnedCount} | ${survived} | ${formatOmittedSummary(r.omitted)} |`;
  });
  return [header, sep, ...body].join("\n");
}
