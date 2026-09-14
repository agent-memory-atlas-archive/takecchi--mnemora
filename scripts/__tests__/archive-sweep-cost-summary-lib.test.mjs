import { describe, expect, it } from "vitest";
import {
  buildDegenerateShareSection,
  buildSummaryMarkdown,
  diffPhase,
  findDegenerateRecalledActiveShareRows,
  validateBaseline,
  validateMeasured,
} from "../archive-sweep-cost-summary-lib.mjs";

/**
 * `archive-sweep-cost-summary-lib.mjs`(純関数の側)の歯。DB を要求しない
 * ——`consolidation-cost-summary-lib.test.mjs` と同じ分担・同じ理由(Issue #209)。
 *
 * ⛔ `examples/chat/archive-sweep-baseline.json` はまだコミットされていない
 * (この作業環境に DB が無く、捏造した数値を基準値として残さないため)。ここで使う
 * measured/baseline はすべてこの歯の中で組み立てたインライン fixture である。
 */

function makeProbe(overrides = {}) {
  return {
    probeId: "color",
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    goldRank: 1,
    recalledActiveShare: 0.2,
    omittedArchivedCount: 0,
    omittedKinds: [],
    budgetExceeded: false,
    ...overrides,
  };
}

function makeMean(overrides = {}) {
  return {
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    recalledActiveShare: 0.2,
    omittedArchivedCount: 0,
    goldRank: 1,
    goldRankExcludedCount: 0,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    activeCount: 10,
    supersededCount: 0,
    archivedCount: 0,
    activeContentChars: 500,
    activeContentTokens: 120,
    activeDigestChars: 200,
    activeDigestTokens: 60,
    allContentChars: 500,
    ...overrides,
  };
}

/** measured 側(probes 配列あり)の phase。 */
function makePhase(overrides = {}) {
  return {
    store: makeStore(overrides.store),
    recall: {
      unbudgeted: { probes: [makeProbe()], mean: makeMean() },
      budgeted: [{ budgetTokens: 32, probes: [makeProbe()], mean: makeMean() }],
    },
    ...overrides,
  };
}

/** 基準値側(probes 配列を持たない軽量な phase)。 */
function makeBaselinePhase(overrides = {}) {
  return {
    store: makeStore(overrides.store),
    recall: {
      unbudgeted: { mean: makeMean() },
      budgeted: [{ budgetTokens: 32, mean: makeMean() }],
    },
    ...overrides,
  };
}

function makeSweep(overrides = {}) {
  return { supported: true, limit: 1000, archivedCount: 6, reachedLimit: false, ...overrides };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    probeCount: 1,
    haystackSize: 6,
    halfLifeHours: 1,
    budgetLadder: [32],
    recallLimit: 50,
    sweep: makeSweep(),
    before: makePhase({ store: makeStore({ archivedCount: 0 }) }),
    after: makePhase({ store: makeStore({ archivedCount: 6 }) }),
    ...overrides,
  };
}

function makeBaseline(overrides = {}) {
  return {
    ...makeMeasured(overrides),
    before: overrides.before ?? makeBaselinePhase({ store: makeStore({ archivedCount: 0 }) }),
    after: overrides.after ?? makeBaselinePhase({ store: makeStore({ archivedCount: 6 }) }),
  };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true を返す", () => {
    expect(validateMeasured(makeMeasured()).ok).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("x").ok).toBe(false);
  });

  it("status が不明な値なら落ちる", () => {
    const result = validateMeasured(makeMeasured({ status: "bogus" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("status");
  });

  describe("status: weights_unavailable", () => {
    it("detail が文字列であれば ok:true(メトリクスの欄を要求しない)", () => {
      const result = validateMeasured({ status: "weights_unavailable", detail: "network error" });
      expect(result.ok).toBe(true);
    });

    it("detail が無い、または空なら落ちる", () => {
      expect(validateMeasured({ status: "weights_unavailable" }).ok).toBe(false);
      expect(validateMeasured({ status: "weights_unavailable", detail: "" }).ok).toBe(false);
    });
  });

  for (const field of [
    "llmMode",
    "embeddingMode",
    "probeCount",
    "haystackSize",
    "halfLifeHours",
    "recallLimit",
  ]) {
    it(`トップレベルの ${field} が欠けていれば名指しで落ちる`, () => {
      const measured = makeMeasured();
      delete measured[field];
      const result = validateMeasured(measured);
      expect(result.ok, `${field} が無いのに ok:true になった`).toBe(false);
      expect(result.error).toContain(field);
    });
  }

  it("budgetLadder が数値配列でなければ落ちる", () => {
    expect(validateMeasured(makeMeasured({ budgetLadder: ["32"] })).ok).toBe(false);
  });

  for (const field of ["provider", "model", "dimensions"]) {
    it(`embeddingSpace.${field} が欠けていれば落ちる`, () => {
      const measured = makeMeasured();
      delete measured.embeddingSpace[field];
      const result = validateMeasured(measured);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`embeddingSpace.${field}`);
    });
  }

  for (const field of ["supported", "limit", "archivedCount", "reachedLimit"]) {
    it(`sweep.${field} が欠けていれば落ちる`, () => {
      const measured = makeMeasured();
      delete measured.sweep[field];
      const result = validateMeasured(measured);
      expect(result.ok).toBe(false);
    });
  }

  it("before/after がオブジェクトでなければ落ちる", () => {
    expect(validateMeasured(makeMeasured({ before: null })).ok).toBe(false);
    expect(validateMeasured(makeMeasured({ after: "x" })).ok).toBe(false);
  });

  for (const field of [
    "activeCount",
    "supersededCount",
    "archivedCount",
    "activeContentChars",
    "activeContentTokens",
    "activeDigestChars",
    "activeDigestTokens",
    "allContentChars",
  ]) {
    it(`before.store.${field} が欠けていれば名指しで落ちる`, () => {
      const before = makePhase();
      delete before.store[field];
      const result = validateMeasured(makeMeasured({ before }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`before.store.${field}`);
    });
  }

  for (const field of [
    "carriedCount",
    "carriedDigestTokens",
    "usageChars",
    "usageEstimatedTokens",
    "usageIndexChars",
    "totalInScope",
    "recalledActiveShare",
    "omittedArchivedCount",
  ]) {
    it(`after.recall.unbudgeted.mean.${field} が欠けていれば名指しで落ちる`, () => {
      const after = makePhase();
      delete after.recall.unbudgeted.mean[field];
      const result = validateMeasured(makeMeasured({ after }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`after.recall.unbudgeted.mean.${field}`);
    });
  }

  it("mean.goldRank が数値でも null でもなければ落ちる", () => {
    const before = makePhase();
    before.recall.unbudgeted.mean.goldRank = "1";
    const result = validateMeasured(makeMeasured({ before }));
    expect(result.ok).toBe(false);
  });

  it("recall.unbudgeted.probes が配列でなければ落ちる(measured は probes を要求する)", () => {
    const before = makePhase();
    delete before.recall.unbudgeted.probes;
    const result = validateMeasured(makeMeasured({ before }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("before.recall.unbudgeted.probes");
  });

  it("recall.budgeted[].probes が配列でなければ落ちる(measured は probes を要求する)", () => {
    const after = makePhase();
    delete after.recall.budgeted[0].probes;
    const result = validateMeasured(makeMeasured({ after }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("after.recall.budgeted[0].probes");
  });

  it("recall.budgeted[].budgetTokens が数値でなければ落ちる", () => {
    const before = makePhase();
    before.recall.budgeted[0].budgetTokens = "32";
    const result = validateMeasured(makeMeasured({ before }));
    expect(result.ok).toBe(false);
  });
});

describe("validateBaseline", () => {
  it("正しい形(probes 無しの軽量な phase)は ok:true を返す", () => {
    expect(validateBaseline(makeBaseline()).ok).toBe(true);
  });

  it("status が measured でなければ落ちる(基準値は常に measured のはず)", () => {
    expect(validateBaseline(makeBaseline({ status: "weights_unavailable" })).ok).toBe(false);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateBaseline(null).ok).toBe(false);
  });

  it("store の必須項目が欠けていれば落ちる(baseline も store は要求する)", () => {
    const before = makeBaselinePhase();
    delete before.store.activeCount;
    const result = validateBaseline(makeBaseline({ before }));
    expect(result.ok).toBe(false);
  });
});

describe("diffPhase", () => {
  it("完全一致なら matches:true", () => {
    const phase = makePhase();
    const result = diffPhase(phase, structuredClone(phase), "before");
    expect(result.matches).toBe(true);
    expect(result.fieldDiffs).toEqual([]);
  });

  it("基準値に対応する phase が無ければ missingBaseline:true", () => {
    const result = diffPhase(makePhase(), undefined, "after");
    expect(result.matches).toBe(false);
    expect(result.missingBaseline).toBe(true);
  });

  it("store の値が違う項目だけを fieldDiffs に載せる", () => {
    const baseline = makePhase();
    const measured = makePhase();
    measured.store.archivedCount = 6;
    const result = diffPhase(measured, baseline, "after");
    const diff = result.fieldDiffs.find((d) => d.field === "store.archivedCount");
    expect(diff).toEqual({ field: "store.archivedCount", baseline: 0, measured: 6 });
  });

  it("mean の値が違う項目だけを fieldDiffs に載せる", () => {
    const baseline = makePhase();
    const measured = makePhase();
    measured.recall.unbudgeted.mean.omittedArchivedCount = 6;
    const result = diffPhase(measured, baseline, "after");
    expect(
      result.fieldDiffs.find((d) => d.field === "recall.unbudgeted.mean.omittedArchivedCount"),
    ).toBeDefined();
  });

  it("budgeted 段は budgetTokens で対応付ける(配列の並び順ではない)", () => {
    const baseline = makePhase({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean() },
        budgeted: [
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean() },
          { budgetTokens: 64, probes: [makeProbe()], mean: makeMean({ carriedCount: 3 }) },
        ],
      },
    });
    const measured = makePhase({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean() },
        budgeted: [
          { budgetTokens: 64, probes: [makeProbe()], mean: makeMean({ carriedCount: 3 }) },
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean() },
        ],
      },
    });
    expect(diffPhase(measured, baseline, "before").matches).toBe(true);
  });

  it("測定側にのみ存在する budget 段は「基準値に無い」と載る", () => {
    const baseline = makePhase();
    const measured = makePhase({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean() },
        budgeted: [
          { budgetTokens: 32, probes: [makeProbe()], mean: makeMean() },
          { budgetTokens: 999, probes: [makeProbe()], mean: makeMean() },
        ],
      },
    });
    const result = diffPhase(measured, baseline, "before");
    expect(result.matches).toBe(false);
    expect(
      result.fieldDiffs.find((d) => d.field === "recall.budgeted[budgetTokens=999]"),
    ).toBeDefined();
  });
});

describe("findDegenerateRecalledActiveShareRows / buildDegenerateShareSection", () => {
  it("recalledActiveShare が全て低ければ該当なし", () => {
    const measured = makeMeasured();
    expect(findDegenerateRecalledActiveShareRows(measured)).toEqual([]);
    expect(buildDegenerateShareSection(measured)).toContain("該当なし");
  });

  it("⭐ after の budget 段の recalledActiveShare が 1.0 なら「退化」の行として検出する", () => {
    const after = makePhase({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean({ recalledActiveShare: 0.3 }) },
        budgeted: [
          {
            budgetTokens: 256,
            probes: [makeProbe()],
            mean: makeMean({ recalledActiveShare: 1.0 }),
          },
        ],
      },
    });
    const measured = makeMeasured({ after });
    const rows = findDegenerateRecalledActiveShareRows(measured);
    expect(rows).toEqual([{ phase: "after", label: "budget=256", recalledActiveShare: 1.0 }]);
    const section = buildDegenerateShareSection(measured);
    expect(section).not.toContain("該当なし");
    expect(section).toContain("budget=256");
    expect(section).toContain("退化");
  });

  it("0.999 未満(しきい値未満)は退化として扱わない", () => {
    const before = makePhase({
      recall: {
        unbudgeted: { probes: [makeProbe()], mean: makeMean({ recalledActiveShare: 0.99 }) },
        budgeted: [],
      },
    });
    expect(findDegenerateRecalledActiveShareRows(makeMeasured({ before }))).toEqual([]);
  });
});

describe("buildSummaryMarkdown", () => {
  it("baseline を省略すると差分節そのものを出さない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("基準値との差分");
  });

  it("baseline と一致すれば1行で黙る(表を展開しない)", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured, baseline: makeBaseline() });
    expect(markdown).toContain("基準値との差分");
    expect(markdown).toContain("✅ 一致(差分なし)。");
    expect(markdown).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("baseline と相違すれば表として展開する", () => {
    const measured = makeMeasured();
    const before = makeBaselinePhase({ store: makeStore({ activeCount: 1 }) });
    const baseline = makeBaseline({ before });
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("相違した箇所がある");
    expect(markdown).toContain("| 項目 | 基準値 | 実測 |");
    expect(markdown).toContain("store.activeCount");
  });

  it("退化検出の節が出る", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("退化検出");
  });

  it("🔴 status: weights_unavailable のときはメトリクスの表も基準値比較も一切出さない", () => {
    const measured = { status: "weights_unavailable", detail: "network error: HF 503" };
    const markdown = buildSummaryMarkdown({ measured, baseline: makeBaseline() });
    expect(markdown).toContain("重みを取得できなかったので、値は測っていない");
    expect(markdown).toContain("network error: HF 503");
    expect(markdown).not.toContain("基準値との差分");
    expect(markdown).not.toContain("退化検出");
  });

  it("読み方の注意書きを含む", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("probe 7件");
    expect(markdown).toContain("omittedArchivedCount");
    expect(markdown).toContain("halfLifeHours");
  });

  it("sweep の内訳を出す", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("sweep: supported=true");
    expect(markdown).toContain("archivedCount=6");
  });
});
