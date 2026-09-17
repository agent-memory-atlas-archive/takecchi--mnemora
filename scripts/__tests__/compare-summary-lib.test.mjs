import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  computeComparison,
  diffRow,
  evaluateCompare,
  validateBaseline,
  validateMeasured,
} from "../compare-summary-lib.mjs";

/**
 * Issue #242: `compare-summary-lib.mjs`(純関数の側)の歯。DB を要求しない。
 *
 * ⭐ **最重要の検査**: `turnCount` をキーに `CompareRowJson` の全欄を比べること、
 * 一致すれば1行・相違すれば展開すること(`time-term-summary-lib.mjs`/
 * `archive-sweep-cost-summary-lib.mjs` の対応する歯と同じ形)。
 */

function makeRow(overrides = {}) {
  return {
    fillerPairs: 4,
    turnCount: 10,
    naiveChars: 243,
    naiveTokens: 120,
    mnemoraChars: 232,
    mnemoraTokens: 110,
    mnemoraShareOfNaiveChars: 232 / 243,
    totalInScope: 10,
    omitted: [],
    returnedCount: 8,
    annCandidateCount: 10,
    factStatementSurvived: true,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "abc123",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    rowCount: 2,
    rows: [makeRow({ turnCount: 2, fillerPairs: 0 }), makeRow({ turnCount: 10, fillerPairs: 4 })],
    ...overrides,
  };
}

/** 実測から基準値ファイルの形(`rows` 配列)を作る。 */
function baselineFrom(measured) {
  return { rows: measured.rows.map((r) => structuredClone(r)) };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true を返す", () => {
    expect(validateMeasured(makeMeasured()).ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("not an object").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("llmMode/embeddingMode が文字列でなければ落ちる", () => {
    const broken = makeMeasured();
    delete broken.llmMode;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("llmMode");
  });

  it("rows 配列が無ければ落ちる", () => {
    const broken = makeMeasured();
    delete broken.rows;
    expect(validateMeasured(broken).ok).toBe(false);
  });

  it("rows が空配列なら落ちる(bench が1件も測れなかった)", () => {
    const broken = makeMeasured({ rows: [] });
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("空配列");
  });

  it("row の数値欄が数値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.rows[0].naiveChars = "not a number";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("naiveChars");
  });

  it("row.factStatementSurvived が真偽値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.rows[0].factStatementSurvived = "yes";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("factStatementSurvived");
  });

  it("row.omitted が配列でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.rows[0].omitted = "not an array";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("omitted");
  });

  it("同じ turnCount が2件以上あれば落ちる", () => {
    const broken = makeMeasured({
      rows: [makeRow({ turnCount: 2 }), makeRow({ turnCount: 2 })],
    });
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("turnCount 2");
  });
});

describe("validateBaseline", () => {
  it("正しい形は ok:true を返す", () => {
    const baseline = baselineFrom(makeMeasured());
    expect(validateBaseline(baseline).ok).toBe(true);
  });

  it("rows 配列が無ければ落ちる", () => {
    expect(validateBaseline({}).ok).toBe(false);
  });

  it("row に turnCount が無ければ落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.rows[0].turnCount;
    expect(validateBaseline(baseline).ok).toBe(false);
  });
});

describe("diffRow", () => {
  it("基準値が無ければ missingBaseline:true", () => {
    const result = diffRow(10, makeRow(), undefined);
    expect(result.matches).toBe(false);
    expect(result.missingBaseline).toBe(true);
  });

  it("全欄一致すれば matches:true", () => {
    const row = makeRow();
    const result = diffRow(10, row, structuredClone(row));
    expect(result.matches).toBe(true);
    expect(result.fieldDiffs).toEqual([]);
  });

  it("mnemoraShareOfNaiveChars が相違すれば fieldDiffs に載る", () => {
    const measured = makeRow({ mnemoraShareOfNaiveChars: 0.5 });
    const baseline = makeRow({ mnemoraShareOfNaiveChars: 0.6 });
    const result = diffRow(10, measured, baseline);
    expect(result.matches).toBe(false);
    expect(result.fieldDiffs.map((d) => d.field)).toContain("mnemoraShareOfNaiveChars");
  });

  it("omitted の中身が違えば相違として検出する(JSON化して比べる)", () => {
    const measured = makeRow({ omitted: [{ kind: "below_threshold", count: 1 }] });
    const baseline = makeRow({ omitted: [{ kind: "below_threshold", count: 2 }] });
    const result = diffRow(10, measured, baseline);
    expect(result.matches).toBe(false);
    expect(result.fieldDiffs.map((d) => d.field)).toContain("omitted");
  });

  it("factStatementSurvived が違えば相違として検出する", () => {
    const measured = makeRow({ factStatementSurvived: true });
    const baseline = makeRow({ factStatementSurvived: false });
    const result = diffRow(10, measured, baseline);
    expect(result.matches).toBe(false);
    expect(result.fieldDiffs.map((d) => d.field)).toContain("factStatementSurvived");
  });
});

describe("computeComparison", () => {
  it("一致していれば退行は0件で、比較していない会話長も0件", () => {
    const measured = makeMeasured();
    const result = computeComparison(measured, baselineFrom(measured));
    expect(result.regressions).toEqual([]);
    expect(result.comparedTurnCounts).toEqual([2, 10]);
    expect(result.measuredOnlyTurnCounts).toEqual([]);
    expect(result.baselineOnlyTurnCounts).toEqual([]);
  });

  it("🔴 mnemoraShareOfNaiveChars が基準値より大きくなれば退行(北極星の物差しの悪化)", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 1.5; // 基準値(≈0.9547)より大きい ⟹ 悪化
    const { regressions } = computeComparison(measured, baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].turnCount).toBe(10);
    expect(regressions[0].reasons.join()).toContain("mnemoraShareOfNaiveChars");
  });

  it("mnemoraShareOfNaiveChars が基準値より小さくなっても(改善)退行ではない", () => {
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 0.1;
    expect(computeComparison(measured, baselineFrom(measured)).regressions).toEqual([]);
  });

  it("🔴 factStatementSurvived が true→false に退行すれば退行として検出する", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    const { regressions } = computeComparison(measured, baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].turnCount).toBe(2);
    expect(regressions[0].reasons.join()).toContain("factStatementSurvived");
  });

  it("factStatementSurvived が false→true(改善)なら退行ではない", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.rows[0].factStatementSurvived = false;
    expect(computeComparison(measured, baseline).regressions).toEqual([]);
  });

  it("🔴 基準値に無い turnCount は、退行ではなく『比較していない』として返る(Issue #477)", () => {
    const measured = makeMeasured({
      rows: [...makeMeasured().rows, makeRow({ turnCount: 999, mnemoraShareOfNaiveChars: 99 })],
    });
    const baseline = baselineFrom(makeMeasured());
    const result = computeComparison(measured, baseline);
    expect(result.regressions).toEqual([]);
    expect(result.measuredOnlyTurnCounts).toEqual([999]);
    expect(result.comparedTurnCounts).toEqual([2, 10]);
  });

  it("🔴 基準値に在って実測に無い turnCount は baselineOnlyTurnCounts に返る(測る点が減った)", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured({ rows: [makeRow({ turnCount: 2, fillerPairs: 0 })] });
    const result = computeComparison(measured, baseline);
    expect(result.regressions).toEqual([]);
    expect(result.baselineOnlyTurnCounts).toEqual([10]);
    expect(result.comparedTurnCounts).toEqual([2]);
  });

  it("naiveChars 等、判定対象外の欄が動いても退行として扱わない", () => {
    const measured = makeMeasured();
    measured.rows[0].naiveChars = 99999;
    expect(computeComparison(measured, baselineFrom(measured)).regressions).toEqual([]);
  });

  it("複数行が同時に退行すれば両方返す", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    measured.rows[1].mnemoraShareOfNaiveChars = 5;
    const { regressions } = computeComparison(measured, baseline);
    expect(regressions.map((r) => r.turnCount).sort((a, b) => a - b)).toEqual([2, 10]);
  });
});

/**
 * ⭐ **Issue #477 の陽性対照を、恒久的な歯として固定する。**
 *
 * この repo の `main`（`dd9ec8e` 時点）の `computeRegressions()` は、**同一の実測**に対し
 * 基準値の側だけを差し替えると次のように振る舞っていた（探り棒で逐語に記録した）:
 *
 * - 基準値12行（現物）× 実測11行が退行 ⟹ **11件検出（赤）**
 * - 基準値を `turnCount=2` の**1行だけ**にする ⟹ **0件（緑）**、`validateBaseline` は `ok: true`
 * - 基準値 `rows: []` ⟹ **0件（緑）**、`validateBaseline` は `ok: true`
 *
 * ⟹ **「退行が0件」と「1件も比較していない」が同じ顔で出ていた。**
 * 下の歯は、その3本を `evaluateCompare` の語彙で言い直したものである。
 */
describe("evaluateCompare（⭐ 門の判定。Issue #477 の陽性対照）", () => {
  /** 実測の `turnCount=10` の行だけを退行させる（`turnCount=2` は据え置く）。 */
  function measuredWithOneRegression() {
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 5;
    measured.rows[1].factStatementSurvived = false;
    return measured;
  }

  it("【陽性対照】基準値が全行そろっていれば、退行を fail として捕まえる", () => {
    const measured = measuredWithOneRegression();
    const result = evaluateCompare(measured, baselineFrom(makeMeasured()));
    expect(result.verdict).toBe("fail");
    expect(result.regressions.map((r) => r.turnCount)).toEqual([10]);
    expect(result.comparedTurnCounts).toEqual([2, 10]);
  });

  it("🔴【本題】基準値が1行だけなら indeterminate（緑にしない。(あ)では閉じない窓）", () => {
    const measured = measuredWithOneRegression();
    const baseline = { rows: [structuredClone(makeRow({ turnCount: 2, fillerPairs: 0 }))] };
    // 🔴 (あ)（validateBaseline に空 rows 検査を足す）はこの窓を閉じない——現に通る。
    expect(validateBaseline(baseline).ok).toBe(true);
    const result = evaluateCompare(measured, baseline);
    expect(result.verdict).toBe("indeterminate");
    expect(result.measuredOnlyTurnCounts).toEqual([10]);
    expect(result.reason).toContain("比較していない");
  });

  it("🔴【本題2】基準値が空配列なら indeterminate（validateBaseline は通したままで落ちる）", () => {
    const measured = measuredWithOneRegression();
    const baseline = { rows: [] };
    // ⭐ (い) が (あ) を包含している証拠——`validateBaseline` に空 rows 検査を足さなくても、
    // 空の基準値は「1会話長も比較していない」として判定不能へ落ちる。
    expect(validateBaseline(baseline).ok).toBe(true);
    const result = evaluateCompare(measured, baseline);
    expect(result.verdict).toBe("indeterminate");
    expect(result.comparedTurnCounts).toEqual([]);
    expect(result.measuredOnlyTurnCounts).toEqual([2, 10]);
    expect(result.reason).toContain("1会話長も比較していない");
  });

  it("【通したい側】集合が一致して退行が無ければ pass", () => {
    const measured = makeMeasured();
    const result = evaluateCompare(measured, baselineFrom(measured));
    expect(result.verdict).toBe("pass");
    expect(result.reason).toContain("一致");
  });

  it("🔴【測る点が減った側】基準値に在って実測に無い会話長が在れば indeterminate", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured({ rows: [makeRow({ turnCount: 2, fillerPairs: 0 })] });
    const result = evaluateCompare(measured, baseline);
    expect(result.verdict).toBe("indeterminate");
    expect(result.baselineOnlyTurnCounts).toEqual([10]);
  });

  it("🔴 集合が一致せず、比較できた範囲に退行も在るときは indeterminate（退行も reason に名指しする）", () => {
    const measured = measuredWithOneRegression();
    measured.rows.push(makeRow({ turnCount: 999 }));
    const result = evaluateCompare(measured, baselineFrom(makeMeasured()));
    expect(result.verdict).toBe("indeterminate");
    expect(result.regressions.map((r) => r.turnCount)).toEqual([10]);
    expect(result.reason).toContain("退行");
  });

  it("⛔ 下限に件数を焼き込んでいない（両側が同じ1行だけでも pass になる）", () => {
    // 期待する行数（`DEFAULT_COMPARE_SEQUENCE` の12点）は TypeScript 側に在り、
    // `scripts/*.mjs` からは引けない。⟹ 下限は「実測側の集合」と「基準値側の集合」の
    // 一致だけから取る。この歯は、件数がコードに焼き込まれていないことを固定する。
    const measured = makeMeasured({ rows: [makeRow({ turnCount: 2, fillerPairs: 0 })] });
    const result = evaluateCompare(measured, baselineFrom(measured));
    expect(result.verdict).toBe("pass");
  });
});

describe("buildSummaryMarkdown", () => {
  it("baseline を渡さなければ「まだ無い」旨を出し、差分節を出さない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("基準値ファイルがまだ無い");
    expect(markdown).not.toContain("## 基準値との差分");
  });

  it("一致していれば1行で黙る", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured, baseline: baselineFrom(measured) });
    expect(markdown).toContain("一致(差分なし)");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("🔴 退行すれば turnCount ごとに展開し、🔴 退行 の印を付ける", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.rows[1].mnemoraShareOfNaiveChars = 0.1; // 実測のほうが大きい ⟹ 退行
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した会話長が 1 件ある");
    expect(markdown).toContain("turnCount = 10 🔴 退行");
    expect(markdown).toContain("mnemoraShareOfNaiveChars");
  });

  it("相違はあるが退行ではない(改善)ときは 🔴 退行 の印を付けない", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.rows[1].mnemoraShareOfNaiveChars = 5; // 実測のほうが小さい ⟹ 改善であり退行ではない
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("turnCount = 10");
    expect(markdown).not.toContain("turnCount = 10 🔴 退行");
  });

  it("🔴 基準値に無い会話長は「比較していない」と名乗る(推測で補わない。Issue #477)", () => {
    const measured = makeMeasured({
      rows: [...makeMeasured().rows, makeRow({ turnCount: 999 })],
    });
    const markdown = buildSummaryMarkdown({ measured, baseline: baselineFrom(makeMeasured()) });
    expect(markdown).toContain("判定不能(比較していない会話長が在る)");
    expect(markdown).toContain("この会話長は比較していない");
    // ⛔ 以前の文言（推測で補っていた）が復活していないこと。
    expect(markdown).not.toContain("新しい会話長か、基準値がまだ追随していない");
  });

  it("🔴 基準値にのみ在る会話長も「比較していない」と名乗る(測る点が減った)", () => {
    const measured = makeMeasured({ rows: [makeRow({ turnCount: 2, fillerPairs: 0 })] });
    const markdown = buildSummaryMarkdown({ measured, baseline: baselineFrom(makeMeasured()) });
    expect(markdown).toContain("判定不能(比較していない会話長が在る)");
    expect(markdown).toContain("基準値にのみ存在する会話長");
    expect(markdown).toContain("退行したかどうかは何も言っていない");
  });

  it("表本体に mnemora/naive比・冒頭の事実の列を持つ", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("mnemora/naive");
    expect(markdown).toContain("冒頭の事実");
    expect(markdown).toContain("✅");
  });
});
