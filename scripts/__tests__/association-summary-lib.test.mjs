import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "../association-summary-lib.mjs";

/**
 * Issue #291: `association-summary-lib.mjs`(純関数の側)の歯。DB を要求しない。
 *
 * ⭐ **最重要の検査**: 入力そのものが壊れているとき(必須項目欠け・型違い・本数違い・
 * 参照整合性違反)に `validateMeasured`/`validateBaseline` が ok:false を返すこと、
 * そして**正しい入力では基準値と相違していても `buildSummaryMarkdown` が普通に
 * Markdown を組み立てる**こと(⛔ このベンチは門ではない、ADR 0033 §3)。
 *
 * ⭐ **次に重要な検査**: `hit@10` は連想枠の効果を測れない、という注記が
 * **常に**(基準値の有無・警告の有無に関係なく)出ること。
 */

const PROBE_IDS = [
  ["ascii-project", "ascii-id"],
  ["ascii-printer", "ascii-id"],
  ["ascii-camera", "ascii-id"],
  ["ascii-router", "ascii-id"],
  ["name-meeting", "proper-noun"],
  ["name-trip", "proper-noun"],
  ["name-bank", "proper-noun"],
  ["name-gift", "proper-noun"],
  ["noun-car", "common-noun"],
  ["noun-medicine", "common-noun"],
  ["noun-laptop", "common-noun"],
  ["noun-apartment", "common-noun"],
];

function makeProbe(overrides = {}) {
  return {
    probeId: "ascii-project",
    category: "ascii-id",
    goldRank: null,
    anchorRank: 3,
    distractorRank: 1,
    goldRetrievedVia: null,
    goldAssociationOf: null,
    goldAnchoredOnProbeAnchor: false,
    returnedCount: 10,
    memoryChars: 360,
    associationChars: 0,
    hit1: false,
    hit10: false,
    goldReturned: false,
    reciprocalRank: 0,
    stageSkipped: null,
    associationFrame: [],
    repeatFrameIdentical: true,
    repeatGoldRankSame: true,
    ...overrides,
  };
}

function makeOffProbes() {
  return PROBE_IDS.map(([probeId, category]) => makeProbe({ probeId, category }));
}

function makeOnProbes(goldCount) {
  return PROBE_IDS.map(([probeId, category], i) => {
    if (i < goldCount) {
      return makeProbe({
        probeId,
        category,
        goldRank: 11 + i,
        goldRetrievedVia: "association",
        goldAssociationOf: probeId,
        goldAnchoredOnProbeAnchor: true,
        goldReturned: true,
        associationChars: 90,
        reciprocalRank: 1 / (11 + i),
        associationFrame: [
          {
            externalId: `assoc-gold-${probeId}`,
            rank: 11,
            role: "own-gold",
            anchorExternalId: `assoc-anchor-${probeId}`,
          },
        ],
      });
    }
    return makeProbe({
      probeId,
      category,
      associationFrame: [
        {
          externalId: `assoc-filler-000${i}`,
          rank: 11,
          role: "haystack",
          anchorExternalId: `assoc-anchor-${probeId}`,
        },
      ],
    });
  });
}

function associationFrameRolesOf(probes) {
  const roles = {};
  for (const probe of probes) {
    for (const entry of probe.associationFrame) {
      roles[entry.role] = (roles[entry.role] ?? 0) + 1;
    }
  }
  return roles;
}

function makeArm(overrides = {}) {
  return {
    armLabel: "off: 連想枠なし（既定の recall）",
    associationEnabled: false,
    associationMaxCount: null,
    probeCount: 12,
    ingestedCount: 96,
    goldReturnedCount: 0,
    hit1Count: 0,
    hit10Count: 0,
    goldViaAssociationCount: 0,
    mrr: 0,
    returnedMemoryTotal: 120,
    memoryCharsTotal: 4321,
    associationCharsTotal: 0,
    stageSkippedReasons: {},
    associationFrameRoles: {},
    repeatFrameIdenticalCount: 12,
    repeatGoldRankSameCount: 12,
    probes: makeOffProbes(),
    ...overrides,
  };
}

function makeOnArm(maxCount, goldCount, extra = {}) {
  const probes = makeOnProbes(goldCount);
  const mrr = probes.reduce((sum, p) => sum + p.reciprocalRank, 0) / probes.length;
  return makeArm({
    armLabel: `on: 連想枠あり（maxCount=${maxCount}）`,
    associationEnabled: true,
    associationMaxCount: maxCount,
    goldReturnedCount: goldCount,
    goldViaAssociationCount: goldCount,
    mrr,
    memoryCharsTotal: 4321 + goldCount * 90,
    associationCharsTotal: goldCount * 90,
    associationFrameRoles: associationFrameRolesOf(probes),
    probes,
    ...extra,
  });
}

function makeMeasured(overrides = {}) {
  const offArm = makeArm();
  const on3Arm = makeOnArm(3, 9);
  const on5Arm = makeOnArm(5, 9);
  const on10Arm = makeOnArm(10, 9);
  const buildDelta = (againstArm) => ({
    baselineArmLabel: offArm.armLabel,
    againstArmLabel: againstArm.armLabel,
    goldReturnedCount: againstArm.goldReturnedCount - offArm.goldReturnedCount,
    goldViaAssociationCount: againstArm.goldViaAssociationCount - offArm.goldViaAssociationCount,
    mrr: againstArm.mrr - offArm.mrr,
    hit10Count: againstArm.hit10Count - offArm.hit10Count,
    memoryCharsTotal: againstArm.memoryCharsTotal - offArm.memoryCharsTotal,
    charsPerAdditionalGold:
      (againstArm.memoryCharsTotal - offArm.memoryCharsTotal) /
      (againstArm.goldReturnedCount - offArm.goldReturnedCount),
  });
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-16T00:00:00.000Z",
    commit: "abc123",
    embedding: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    llmMode: "deterministic",
    probeCount: 12,
    haystackSize: 60,
    recallLimit: 10,
    warmup: { ok: true, detail: null },
    arms: [offArm, on3Arm, on5Arm, on10Arm],
    deltas: [buildDelta(on3Arm), buildDelta(on5Arm), buildDelta(on10Arm)],
    ...overrides,
  };
}

/** 実測から基準値ファイルの形(arm レベルの数値のみ)を作る。 */
function baselineFrom(measured) {
  return {
    embedding: structuredClone(measured.embedding),
    llmMode: measured.llmMode,
    arms: measured.arms.map((arm) => ({
      armLabel: arm.armLabel,
      associationEnabled: arm.associationEnabled,
      associationMaxCount: arm.associationMaxCount,
      probeCount: arm.probeCount,
      ingestedCount: arm.ingestedCount,
      goldReturnedCount: arm.goldReturnedCount,
      hit1Count: arm.hit1Count,
      hit10Count: arm.hit10Count,
      goldViaAssociationCount: arm.goldViaAssociationCount,
      mrr: arm.mrr,
      returnedMemoryTotal: arm.returnedMemoryTotal,
      memoryCharsTotal: arm.memoryCharsTotal,
      associationCharsTotal: arm.associationCharsTotal,
      repeatFrameIdenticalCount: arm.repeatFrameIdenticalCount,
      repeatGoldRankSameCount: arm.repeatGoldRankSameCount,
    })),
  };
}

describe("validateMeasured", () => {
  it("正しい形は ok:true を返す", () => {
    const result = validateMeasured(makeMeasured());
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateMeasured(null).ok).toBe(false);
    expect(validateMeasured("not an object").ok).toBe(false);
    expect(validateMeasured(42).ok).toBe(false);
  });

  it("トップレベルの必須フィールドが欠けていれば落ちる", () => {
    const broken = makeMeasured();
    delete broken.llmMode;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("llmMode");
  });

  it("commit が文字列でも null でもなければ落ちる", () => {
    const broken = makeMeasured({ commit: 123 });
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("commit");
  });

  it("commit が null なら通る", () => {
    const result = validateMeasured(makeMeasured({ commit: null }));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("embedding.dimensions が欠けていれば落ちる", () => {
    const broken = makeMeasured();
    delete broken.embedding.dimensions;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("embedding.dimensions");
  });

  it("warmup.ok が真偽値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.warmup.ok = "yes";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("warmup.ok");
  });

  it("warmup.ok が false でも(detail が文字列なら)通る", () => {
    const measured = makeMeasured({ warmup: { ok: false, detail: "重みを取得できなかった" } });
    const result = validateMeasured(measured);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("arms が4本でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms = broken.arms.slice(0, 2);
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("arms の本数");
  });

  it("deltas が3本でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.deltas = broken.deltas.slice(0, 1);
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deltas の本数");
  });

  it("arm に armLabel が重複していれば落ちる", () => {
    const broken = makeMeasured();
    broken.arms[1].armLabel = broken.arms[0].armLabel;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2件以上");
  });

  it("probe.category が既知の3値以外なら落ちる", () => {
    const broken = makeMeasured();
    broken.arms[0].probes[0].category = "typo-category";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("category");
  });

  it("probes の長さが arm.probeCount と一致しなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms[0].probes.pop();
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("probes の長さ");
  });

  it("goldRank が文字列なら落ちる(数値でも null でもない)", () => {
    const broken = makeMeasured();
    broken.arms[0].probes[0].goldRank = "3";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("goldRank");
  });

  it("🔴 delta の baselineArmLabel が存在しない arm を指していれば落ちる(参照整合性)", () => {
    const broken = makeMeasured();
    broken.deltas[0].baselineArmLabel = "存在しない arm";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("armLabel とも一致しない");
  });

  it("stageSkippedReasons が配列なら落ちる(オブジェクトでない)", () => {
    const broken = makeMeasured();
    broken.arms[0].stageSkippedReasons = ["reason"];
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("stageSkippedReasons");
  });

  it("⭐ probe.associationFrame が配列でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms[1].probes[0].associationFrame = "not an array";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("associationFrame が配列でない");
  });

  it("⭐ associationFrame エントリの role が既知の6値以外なら落ちる", () => {
    const broken = makeMeasured();
    broken.arms[1].probes[0].associationFrame = [
      {
        externalId: "assoc-gold-ascii-project",
        rank: 11,
        role: "typo-role",
        anchorExternalId: null,
      },
    ];
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("role");
  });

  it("⭐ associationFrame エントリの anchorExternalId が数値なら落ちる(文字列でも null でもない)", () => {
    const broken = makeMeasured();
    broken.arms[1].probes[0].associationFrame = [
      { externalId: "assoc-gold-ascii-project", rank: 11, role: "own-gold", anchorExternalId: 42 },
    ];
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("anchorExternalId");
  });

  it("⭐ arm.associationFrameRoles が配列なら落ちる(オブジェクトでない)", () => {
    const broken = makeMeasured();
    broken.arms[1].associationFrameRoles = ["own-gold"];
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("associationFrameRoles");
  });

  it("⭐ arm.associationFrameRoles の値が数値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms[1].associationFrameRoles = { "own-gold": "9" };
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("associationFrameRoles.own-gold");
  });

  it("⭐ Issue #291 フォローアップ: arm.repeatFrameIdenticalCount が欠けていれば落ちる", () => {
    const broken = makeMeasured();
    delete broken.arms[0].repeatFrameIdenticalCount;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("repeatFrameIdenticalCount");
  });

  it("⭐ Issue #291 フォローアップ: arm.repeatGoldRankSameCount が数値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms[0].repeatGoldRankSameCount = "12";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("repeatGoldRankSameCount");
  });

  it("⭐ Issue #291 フォローアップ: probe.repeatFrameIdentical が真偽値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms[0].probes[0].repeatFrameIdentical = "true";
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("repeatFrameIdentical");
  });

  it("⭐ Issue #291 フォローアップ: probe.repeatGoldRankSame が真偽値でなければ落ちる", () => {
    const broken = makeMeasured();
    broken.arms[0].probes[0].repeatGoldRankSame = null;
    const result = validateMeasured(broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("repeatGoldRankSame");
  });
});

describe("validateBaseline", () => {
  it("正しい形は ok:true を返す", () => {
    const result = validateBaseline(baselineFrom(makeMeasured()));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("オブジェクトでなければ落ちる", () => {
    expect(validateBaseline(null).ok).toBe(false);
    expect(validateBaseline("nope").ok).toBe(false);
  });

  it("embedding が無ければ落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.embedding;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("embedding");
  });

  it("arms が配列でなければ落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.arms = "not an array";
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("arms");
  });

  it("arm の必須数値項目が欠けていれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.arms[0].mrr;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mrr");
  });

  it("armLabel が重複していれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    baseline.arms[1].armLabel = baseline.arms[0].armLabel;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2件以上");
  });

  it("⭐ Issue #291 フォローアップ: arm.repeatFrameIdenticalCount が欠けていれば落ちる", () => {
    const baseline = baselineFrom(makeMeasured());
    delete baseline.arms[0].repeatFrameIdenticalCount;
    const result = validateBaseline(baseline);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("repeatFrameIdenticalCount");
  });
});

describe("buildSummaryMarkdown", () => {
  it("基準値なしで組み立てられ、arm・カテゴリ・probe明細の表を含む", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("association-probes");
    expect(markdown).toContain(measured.arms[0].armLabel);
    expect(markdown).toContain(measured.arms[1].armLabel);
    expect(markdown).toContain(measured.arms[2].armLabel);
    expect(markdown).toContain(measured.arms[3].armLabel);
    expect(markdown).toContain("ascii-id");
    expect(markdown).toContain("proper-noun");
    expect(markdown).toContain("common-noun");
    expect(markdown).toContain("ascii-project");
    expect(markdown).not.toContain("基準値との差");
  });

  it("⭐ hit@10 は連想枠の効果を測れない、という注記が常に出る", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("hit@10");
    expect(markdown).toContain("連想枠の効果を測れない");
  });

  it("🔴 warmup.ok が false なら、先頭に目立つ警告が出る", () => {
    const measured = makeMeasured({
      warmup: { ok: false, detail: "HTTP 503 from the model host" },
    });
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("🔴 warmup に失敗している");
    expect(markdown).toContain("HTTP 503 from the model host");
  });

  it("warmup.ok が true なら警告が出ない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("warmup に失敗している");
  });

  it("基準値ありなら「基準値との差」列が出て、相違していても普通に組み立てられる(⛔ 門ではない)", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.arms[1].hit1Count = 99; // 実測と大きく異なる値
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("基準値との差");
  });

  it("基準値なしのときは、その旨の注記が出る", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("基準値ファイルが渡されていない");
  });

  it("stageSkippedReasons が空でなければ内訳が出る", () => {
    const measured = makeMeasured();
    measured.arms[1].stageSkippedReasons = { budget_exhausted: 2 };
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("stageSkippedReasons の内訳");
    expect(markdown).toContain("budget_exhausted: 2");
  });

  it("stageSkippedReasons が全arm空なら内訳節を出さない", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).not.toContain("stageSkippedReasons の内訳");
  });

  it("embedding/llmMode が基準値と実測で違えば、その旨を警告する", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.embedding.model = "text-embedding-3-small";
    const markdown = buildSummaryMarkdown({ measured, baseline });
    expect(markdown).toContain("条件が違う");
  });

  /**
   * ⭐ **実装(`examples/chat/src/cli.ts` の `runAssociationProbes`)を読んで分かった
   * 実物の armLabel は、`"off: 連想枠なし（既定の recall）(llm=deterministic,
   * embedding=local/ruri-v3-30m/sym/256次元)"` のように、埋め込み条件を文字列に
   * 埋めた形である**(タスク仕様が示した3本の固定文字列そのままではない)。
   * ⟹ 基準値との突き合わせが `armLabel` の完全一致に依存していたら、埋め込み
   * モデルを変えるたびに(armLabel が変わって)基準値が「全arm 基準値なし」に
   * 化けてしまう。この歯は、armLabel の文言が違っても
   * (`associationEnabled`/`associationMaxCount` が同じなら)基準値が引けることを
   * 固定する。
   */
  it("🔴 armLabel の文言が(埋め込み条件の埋め込みで)基準値と違っても、構造的な鍵で基準値が引ける", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    // 基準値の armLabel だけを、実装が実際に組み立てる形(埋め込み条件を埋めた文字列)へ
    // 差し替える——associationEnabled/associationMaxCount はそのまま。
    baseline.arms[0].armLabel =
      "off: 連想枠なし（既定の recall）(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元)";
    baseline.arms[1].armLabel =
      "on: 連想枠あり（maxCount=3）(llm=deterministic, embedding=openai/text-embedding-3-small/256次元)";
    const markdown = buildSummaryMarkdown({ measured, baseline });
    // 「基準値なし」に化けていないこと(化けていれば、埋め込みを変えるたびに
    // 基準値との比較が黙って全滅する、という再発を許すことになる)。
    expect(markdown).not.toContain("基準値なし");
  });

  it("🔴 armLabel が違っても、associationEnabled/associationMaxCount が重複していれば validateMeasured が落ちる", () => {
    const measured = makeMeasured();
    // armLabel は別々のままだが、on3 の associationMaxCount を on5 と同じにする
    // ——「同じ arm が2件」という壊れ方を armLabel の違いだけでは検知できない。
    measured.arms[1].associationMaxCount = 5;
    const result = validateMeasured(measured);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("associationEnabled/associationMaxCount");
  });

  it("⭐ 連想枠の中身(role別)の節が出て、各 arm の associationFrameRoles の件数を含む", () => {
    const markdown = buildSummaryMarkdown({ measured: makeMeasured() });
    expect(markdown).toContain("連想枠の中身");
    expect(markdown).toContain("own-gold");
    expect(markdown).toContain("haystack");
  });

  it("⭐ maxCount 最大の arm(on10)で gold が返らなかった probe の連想枠が列挙される", () => {
    const measured = makeMeasured();
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("maxCount 最大の arm");
    // on10 arm(9件 gold) では 9〜11番目の probeId(gold が無い側)が「haystack」枠として
    // 列挙されるはず。
    const missedProbeId = PROBE_IDS[9][0];
    expect(markdown).toContain(missedProbeId);
    expect(markdown).toContain("haystack");
  });

  it("連想枠が全て off(associationEnabled が無い)なら、maxCount 最大の arm の節は出さない", () => {
    const measured = makeMeasured();
    for (const arm of measured.arms) {
      arm.associationEnabled = false;
    }
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).not.toContain("maxCount 最大の arm");
  });

  it("⭐ Issue #291 フォローアップ: 同一ストアで引き直したとき枠が一致した probe 数の節が、arm ごとの件数入りで出る", () => {
    const measured = makeMeasured();
    measured.arms[0].repeatFrameIdenticalCount = 12;
    measured.arms[0].repeatGoldRankSameCount = 12;
    measured.arms[1].repeatFrameIdenticalCount = 2;
    measured.arms[1].repeatGoldRankSameCount = 5;
    const markdown = buildSummaryMarkdown({ measured });
    expect(markdown).toContain("同一ストアで引き直したとき枠が一致した probe 数");
    expect(markdown).toContain("12/12");
    expect(markdown).toContain("2/12");
    expect(markdown).toContain("5/12");
  });
});
