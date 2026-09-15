import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  computeRegressions,
  diffRow,
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

describe("computeRegressions", () => {
  it("一致していれば退行は0件", () => {
    const measured = makeMeasured();
    expect(computeRegressions(measured, baselineFrom(measured))).toEqual([]);
  });

  it("🔴 mnemoraShareOfNaiveChars が基準値より大きくなれば退行(北極星の物差しの悪化)", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 1.5; // 基準値(≈0.9547)より大きい ⟹ 悪化
    const regressions = computeRegressions(measured, baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].turnCount).toBe(10);
    expect(regressions[0].reasons.join()).toContain("mnemoraShareOfNaiveChars");
  });

  it("mnemoraShareOfNaiveChars が基準値より小さくなっても(改善)退行ではない", () => {
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 0.1;
    expect(computeRegressions(measured, baselineFrom(measured))).toEqual([]);
  });

  it("🔴 factStatementSurvived が true→false に退行すれば退行として検出する", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    const regressions = computeRegressions(measured, baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].turnCount).toBe(2);
    expect(regressions[0].reasons.join()).toContain("factStatementSurvived");
  });

  it("factStatementSurvived が false→true(改善)なら退行ではない", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.rows[0].factStatementSurvived = false;
    expect(computeRegressions(measured, baseline)).toEqual([]);
  });

  it("基準値に無い turnCount(新しい会話長)は退行として扱わない", () => {
    const measured = makeMeasured({
      rows: [...makeMeasured().rows, makeRow({ turnCount: 999, mnemoraShareOfNaiveChars: 99 })],
    });
    const baseline = baselineFrom(makeMeasured());
    expect(computeRegressions(measured, baseline)).toEqual([]);
  });

  it("naiveChars 等、判定対象外の欄が動いても退行として扱わない", () => {
    const measured = makeMeasured();
    measured.rows[0].naiveChars = 99999;
    expect(computeRegressions(measured, baselineFrom(measured))).toEqual([]);
  });

  it("複数行が同時に退行すれば両方返す", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    measured.rows[1].mnemoraShareOfNaiveChars = 5;
    const regressions = computeRegressions(measured, baseline);
    expect(regressions.map((r) => r.turnCount).sort((a, b) => a - b)).toEqual([2, 10]);
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

  it("表本体に mnemora/naive比・冒頭の事実の列を持つ", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("mnemora/naive");
    expect(markdown).toContain("冒頭の事実");
    expect(markdown).toContain("✅");
  });
});
