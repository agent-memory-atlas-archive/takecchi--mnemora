import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  diffProbe,
  validateBaseline,
  validateMeasured,
} from "../time-term-summary-lib.mjs";

/**
 * Issue #217: `time-term-summary-lib.mjs`(純関数の側)の歯。DB を要求しない。
 *
 * ⭐ **最重要の検査**: `outcome`/`totalInScope`/`omittedKinds` という**離散値**だけを
 * 比べ、`freshnessRatio`/`decayRatio`/`totalRatio` のような**連続値**は基準値との
 * 比較に使わないこと(壁時計時間にわずかに依存し、厳密等価では常に「相違あり」になる
 * ——ADR 0088 §2 が `retrieval-quality` の `decay`/`freshness` について実測したのと
 * 同じ理由)。
 */

function makeProbe(overrides = {}) {
  return {
    probeId: "half-life",
    outcome: "newer-ranked-higher",
    totalInScope: 2,
    omittedKinds: [],
    similarityGapWithinPair: 0,
    freshnessGapWithinPair: null,
    freshnessRatio: 0.5,
    decayRatio: null,
    totalRatio: 0.5,
    newer: null,
    older: null,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "abc123",
    armLabel: "time-term",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    probeCount: 2,
    probes: [
      makeProbe({ probeId: "half-life", outcome: "newer-ranked-higher" }),
      makeProbe({
        probeId: "same-occurred-at",
        outcome: "tied",
        totalRatio: 1,
        freshnessRatio: 1,
      }),
    ],
    ...overrides,
  };
}

/** 実測から基準値ファイルの形(`probes` 配列)を作る。連続値欄はそのまま持たせても害は無い
 *  (`DIFF_FIELDS` に無いので比較には使われない)——実測の形と基準値の形を近く保つため。 */
function baselineFrom(measured) {
  return { probes: measured.probes.map((p) => structuredClone(p)) };
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

  it("armLabel/llmMode/embeddingMode が文字列でなければ落ちる", () => {
    const broken = makeMeasured();
    delete broken.llmMode;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("llmMode");
  });

  it("probes 配列が無ければ落ちる", () => {
    const broken = makeMeasured();
    delete broken.probes;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("probes 配列が無い");
  });

  it("probes が空配列なら落ちる(bench が1件も測れなかった、を緑にしない)", () => {
    const result = validateMeasured(makeMeasured({ probes: [] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("空配列");
  });

  it("outcome が既知の値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.probes[0].outcome = "something-else";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outcome");
  });

  it("totalInScope が数値でなければ落ちる", () => {
    const broken = makeMeasured();
    delete broken.probes[0].totalInScope;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("totalInScope");
  });

  it("omittedKinds が文字列配列でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.probes[0].omittedKinds = "below_threshold";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("omittedKinds");
  });

  it("同じ probeId が2件以上あれば落ちる", () => {
    const broken = makeMeasured();
    broken.probes.push(makeProbe({ probeId: "half-life" }));
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2件以上");
  });

  it("collapsed も既知の outcome として通る(ADR 0058 が予約している値)", () => {
    const measured = makeMeasured();
    measured.probes[0].outcome = "collapsed";
    expect(validateMeasured(measured).ok).toBe(true);
  });
});

describe("validateBaseline", () => {
  it("正しい形は ok:true を返す", () => {
    expect(validateBaseline(baselineFrom(makeMeasured())).ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateBaseline(null).ok).toBe(false);
  });

  it("probes 配列が無ければ落ちる", () => {
    expect(validateBaseline({}).ok).toBe(false);
  });

  it("probeId が無い要素があれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.probes[0].probeId;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("probeId");
  });

  it("同じ probeId が2件以上あれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.probes[1].probeId = baseline.probes[0].probeId;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2件以上");
  });

  it("必須項目が欠けていれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.probes[0].outcome;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outcome");
  });
});

describe("diffProbe", () => {
  it("同じなら matches:true・fieldDiffs は空", () => {
    const probe = makeProbe();
    const diff = diffProbe("half-life", probe, structuredClone(probe));
    expect(diff.matches).toBe(true);
    expect(diff.fieldDiffs).toEqual([]);
  });

  it("基準値が無ければ missingBaseline:true(matches:false)", () => {
    const diff = diffProbe("half-life", makeProbe(), undefined);
    expect(diff.matches).toBe(false);
    expect(diff.missingBaseline).toBe(true);
  });

  it("outcome が違えば相違になる", () => {
    const diff = diffProbe(
      "half-life",
      makeProbe({ outcome: "tied" }),
      makeProbe({ outcome: "newer-ranked-higher" }),
    );
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.map((d) => d.field)).toContain("outcome");
  });

  it("totalInScope が違えば相違になる(collapsed の検出に効く)", () => {
    const diff = diffProbe(
      "half-life",
      makeProbe({ totalInScope: 1 }),
      makeProbe({ totalInScope: 2 }),
    );
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.map((d) => d.field)).toContain("totalInScope");
  });

  it("omittedKinds の中身が違えば相違になる(順番は無視する)", () => {
    const diff = diffProbe(
      "far-past",
      makeProbe({ omittedKinds: ["below_threshold"] }),
      makeProbe({ omittedKinds: [] }),
    );
    expect(diff.matches).toBe(false);
    expect(diff.fieldDiffs.map((d) => d.field)).toContain("omittedKinds");
  });

  it("🔴 freshnessRatio/decayRatio/totalRatio が違っても相違にならない(比較対象に入れない)", () => {
    const diff = diffProbe(
      "half-life",
      makeProbe({ freshnessRatio: 0.500001, totalRatio: 0.500002 }),
      makeProbe({ freshnessRatio: 0.5, totalRatio: 0.5 }),
    );
    expect(diff.matches).toBe(true);
  });
});

describe("buildSummaryMarkdown", () => {
  it("provider(llm/embedding)と probe ごとの outcome の表を出す", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("llm=deterministic");
    expect(markdown).toContain("embedding=deterministic");
    expect(markdown).toContain("| half-life | newer-ranked-higher | 2 | - |");
    expect(markdown).toContain("| same-occurred-at | tied | 2 | - |");
  });

  it("omittedKinds が非空なら行に含める", () => {
    const measured = makeMeasured();
    measured.probes.push(
      makeProbe({
        probeId: "far-past",
        outcome: "older-not-returned",
        omittedKinds: ["below_threshold"],
      }),
    );
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("| far-past | older-not-returned | 2 | below_threshold |");
  });

  it("基準値を渡さなければ、差分の節そのものが出ない代わりに「まだ無い」旨を出す", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("## 基準値との差分");
    expect(markdown).toContain("基準値ファイルがまだ無い");
  });

  it("⭐ 一致していれば1行で黙る(probe ごとの内訳の表を出さない)", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured, baseline: baselineFrom(measured) });
    expect(markdown).toContain("## 基準値との差分");
    expect(markdown).toContain("一致(差分なし)");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
    expect(markdown).not.toContain("### half-life");
  });

  it("⭐ outcome が相違していれば展開する", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.probes[0].outcome = "tied"; // half-life が newer-ranked-higher → tied に動いた
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した probe が 1 件ある");
    expect(markdown).toContain("### half-life");
    expect(markdown).toContain('| outcome | "tied" | "newer-ranked-higher" |');
    expect(markdown).not.toContain("### same-occurred-at");
  });

  it("🔴 連続値(freshnessRatio 等)が動いても相違として展開されない", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.probes[0].freshnessRatio = 0.5000001;
    baseline.probes[0].totalRatio = 0.4999999;
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("一致(差分なし)");
    expect(markdown).not.toContain("### half-life");
  });

  it("実測にある probe が基準値に無ければ、その旨を出す", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.probes = baseline.probes.filter((p) => p.probeId !== "same-occurred-at");
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("### same-occurred-at");
    expect(markdown).toContain("この probe には基準値が無い");
  });

  it("標本の小ささの注意書きと、連続値を比較に使わない旨の注意書きが常に出る", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("ADR 0033 §3");
    expect(markdown).toContain("統計的に主張しない");
    expect(markdown).toContain("freshnessRatio");
    expect(markdown).toContain("decayRatio");
    expect(markdown).toContain("totalRatio");
  });
});
