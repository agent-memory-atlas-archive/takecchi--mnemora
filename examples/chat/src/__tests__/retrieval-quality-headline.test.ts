import { describe, expect, it } from "vitest";
import type { RecalledMemory, ScoreBreakdown } from "@mnemora/core";
import type { ArmReport, ProbeOutcome } from "../retrieval-quality.js";
import {
  armHeadline,
  computeDecayFreshnessRowwise,
  computeTermSpreads,
  formatArmSummaryTable,
} from "../retrieval-quality.js";

/** `computeTermSpreads`/`computeDecayFreshnessRowwise` の検査用に、最小の `RecalledMemory` を作る。 */
function memory(score: ScoreBreakdown): RecalledMemory {
  return {
    memoryId: `memory-${JSON.stringify(score)}`,
    digest: "d",
    retrievedVia: "ann",
    provenanceKind: "stated",
    score,
  };
}

/**
 * ADR 0068 ②: 「arm を跨いで数字を拾えてしまう」を塞ぐ歯。
 *
 * **現物の事故**: `formatArmSummaryTable` は MRR しか持っておらず、`hit@1`/`hit@10` を
 * 知るには `formatProbeComparisonTable`(arm ごとに5列 × 3 arm = 17列の横長の表)へ行き、
 * そこで行を横に数えて arm を跨ぐ必要があった。実際に「arm B の MRR」と「arm C の
 * hit@10」を束ねて読み違えた実例がある。
 *
 * **直し方の検査**: (1) `formatArmSummaryTable` の同じ行に MRR・hit@1・hit@10 が
 * 揃っていて、別の表へ行く理由が無いこと。(2) `armHeadline()` が `ArmReport` を
 * 1つしか受け取らない(構造上、他の arm の数字が混ざりようがない)こと。
 */

function makeProbe(id: string, hit1: boolean, hit10: boolean): ProbeOutcome {
  const goldRank = !hit10 ? null : hit1 ? 1 : 2;
  return {
    probeId: id,
    lexicalControl: false,
    goldRank,
    distractorRank: null,
    hit1,
    hit10,
    distractorBeatsGold: false,
    reciprocalRank: goldRank === null ? 0 : 1 / goldRank,
    omittedKinds: [],
    totalInScope: 74,
    scoreDetails: [],
    termSpreads: [],
    recalledRows: 10,
    lexicalMatchRows: 0,
    decayFreshnessRowwise: { rows: 0, equalRows: 0, differentRows: 0 },
  };
}

function makeArmReport(armLabel: string, probes: ProbeOutcome[], mrrOverall: number): ArmReport {
  return {
    armLabel,
    tenantId: `tenant-${armLabel}`,
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    ingest: {
      observationCount: 74,
      drain: { ticks: 2, totalProcessed: 74, totalFailed: 0, firstTickProcessed: 50 },
      extractionCounts: { ok: 74, skipped: 0, llmFailedWholeObservation: 0 },
      measurement: "measured",
      singleTickWouldHaveStalled: true,
    },
    probes,
    mrrOverall,
    // ②-3 の対照用に、わざと probes/mrrOverall と無関係な値を入れておく——
    // `armHeadline()` がこれらを見ていないことを検査できるようにするため。
    mrrLexicalControl: 0.123,
    mrrNonLexical: 0.456,
    usageReport: "(usage)",
    channels: ["ann"],
  };
}

// arm A: 7 probe すべて hit@1 かつ hit@10(見出しの数字が「よく効いた」側の極)。
const armA = makeArmReport(
  "A",
  Array.from({ length: 7 }, (_, i) => makeProbe(`p${i}`, true, true)),
  1.0,
);

// arm B: 7 probe すべて外す(「まったく効いていない」側の極)。
const armB = makeArmReport(
  "B",
  Array.from({ length: 7 }, (_, i) => makeProbe(`p${i}`, false, false)),
  0.0,
);

// arm C: 混在(hit@1=4/7, hit@10=6/7 — hit@1 と hit@10 も互いに違う値にして、
// 列の取り違えも検出できるようにする)。
const armC = makeArmReport(
  "C",
  [
    makeProbe("p0", true, true),
    makeProbe("p1", true, true),
    makeProbe("p2", true, true),
    makeProbe("p3", true, true),
    makeProbe("p4", false, true),
    makeProbe("p5", false, true),
    makeProbe("p6", false, false),
  ],
  0.714,
);

/** `| a | b | c |` 形式の1行を、先頭・末尾の空セルを落として配列にする。 */
function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

describe("formatArmSummaryTable — arm を跨いで数字が混ざらない（ADR 0068 ②-1・②-2）", () => {
  const table = formatArmSummaryTable([armA, armB, armC]);
  const lines = table.split("\n");
  const header = parseTableRow(lines[0]!);
  const armIdx = header.indexOf("arm");
  const mrrIdx = header.indexOf("MRR(全体)");
  const hit1Idx = header.indexOf("hit@1");
  const hit10Idx = header.indexOf("hit@10");
  const dataRows = lines.slice(2).map(parseTableRow);
  const rowFor = (label: string): string[] => {
    const row = dataRows.find((r) => r[armIdx] === label);
    if (!row) {
      throw new Error(`arm ${label} の行が見つからない: ${table}`);
    }
    return row;
  };

  it("②-2: MRR・hit@1・hit@10 の3列がすべて存在する(別の表へ行く理由が無い)", () => {
    expect(armIdx).toBeGreaterThanOrEqual(0);
    expect(mrrIdx).toBeGreaterThanOrEqual(0);
    expect(hit1Idx).toBeGreaterThanOrEqual(0);
    expect(hit10Idx).toBeGreaterThanOrEqual(0);
  });

  it("②-1: 各行が自分の arm の数字だけを含む(全部 hit の arm A)", () => {
    const row = rowFor("A");
    expect(row[mrrIdx]).toBe("1.000");
    expect(row[hit1Idx]).toBe("7/7");
    expect(row[hit10Idx]).toBe("7/7");
  });

  it("②-1: 各行が自分の arm の数字だけを含む(全部外す arm B)", () => {
    const row = rowFor("B");
    expect(row[mrrIdx]).toBe("0.000");
    expect(row[hit1Idx]).toBe("0/7");
    expect(row[hit10Idx]).toBe("0/7");
  });

  it("②-1: 各行が自分の arm の数字だけを含む(混在の arm C — B の 0/7 も A の 7/7 も出ない)", () => {
    const row = rowFor("C");
    expect(row[mrrIdx]).toBe("0.714");
    expect(row[hit1Idx]).toBe("4/7");
    expect(row[hit10Idx]).toBe("6/7");
  });
});

describe("armHeadline — ArmReport を1つだけ受け取り、probes からのみ導く（ADR 0068 ②-3）", () => {
  it("hit1Count/hit10Count/probeCount は probes の実カウントと一致する", () => {
    const headline = armHeadline(armC);
    expect(headline.hit1Count).toBe(armC.probes.filter((p) => p.hit1).length);
    expect(headline.hit10Count).toBe(armC.probes.filter((p) => p.hit10).length);
    expect(headline.probeCount).toBe(armC.probes.length);
    expect(headline.mrrOverall).toBe(armC.mrrOverall);
  });

  it("mrrLexicalControl/mrrNonLexical は見ない(probes と mrrOverall だけから導く)", () => {
    const tweaked: ArmReport = { ...armC, mrrLexicalControl: 999, mrrNonLexical: -999 };
    expect(armHeadline(tweaked)).toEqual(armHeadline(armC));
  });

  it("引数は ArmReport 1つだけ——別の arm を渡さない限り、別の arm の数字は混ざりようがない", () => {
    expect(armHeadline(armA)).not.toEqual(armHeadline(armB));
    expect(armHeadline(armA).hit1Count).toBe(7);
    expect(armHeadline(armB).hit1Count).toBe(0);
  });

  it("recalledRows/lexicalMatchRows は probes の同名欄の総和(ADR 0108)", () => {
    const probes: ProbeOutcome[] = [
      { ...makeProbe("p0", true, true), recalledRows: 10, lexicalMatchRows: 2 },
      { ...makeProbe("p1", true, true), recalledRows: 10, lexicalMatchRows: 0 },
    ];
    const report = makeArmReport("Z", probes, 1.0);
    const headline = armHeadline(report);
    expect(headline.recalledRows).toBe(20);
    expect(headline.lexicalMatchRows).toBe(2);
  });

  /**
   * ⭐ ADR 0109: `termDistinct`/`decayFreshnessEqualRows`/`decayFreshnessDifferentRows`
   * が `report.probes` からのみ導かれること(別計算をしないこと)。
   */
  it("termDistinct は probes の termSpreads から、項ごとの何通りかを arm 単位で集計する", () => {
    // p0: tagMatch/strength は1通り(常に1)、similarity は2通り。
    const memoriesP0 = [
      memory({ similarity: 0.5, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.5 }),
      memory({ similarity: 0.3, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.3 }),
    ];
    // p1: tagMatch は1通りのまま(arm全体でも1通り)、similarity はさらに広い範囲。
    const memoriesP1 = [
      memory({ similarity: 0.9, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.9 }),
      memory({ similarity: 0.1, decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 0.1 }),
    ];
    const probes: ProbeOutcome[] = [
      {
        ...makeProbe("p0", true, true),
        termSpreads: computeTermSpreads(memoriesP0),
        decayFreshnessRowwise: computeDecayFreshnessRowwise(memoriesP0),
      },
      {
        ...makeProbe("p1", true, true),
        termSpreads: computeTermSpreads(memoriesP1),
        decayFreshnessRowwise: computeDecayFreshnessRowwise(memoriesP1),
      },
    ];
    const headline = armHeadline(makeArmReport("Z", probes, 1.0));

    const similarity = headline.termDistinct.find((t) => t.term === "similarity")!;
    expect(similarity.presentRows).toBe(4);
    expect(similarity.minDistinctPerProbe).toBe(2);
    expect(similarity.maxDistinctPerProbe).toBe(2);
    // arm 全体の min/max は probe を跨いだ最小・最大(丸めない生値)。
    expect(similarity.min).toBe(0.1);
    expect(similarity.max).toBe(0.9);

    const tagMatch = headline.termDistinct.find((t) => t.term === "tagMatch")!;
    expect(tagMatch.presentRows).toBe(4);
    // ⟹ どの probe でも1通りしか値を取らない: 重みを触っても順位は動かない。
    expect(tagMatch.minDistinctPerProbe).toBe(1);
    expect(tagMatch.maxDistinctPerProbe).toBe(1);
    expect(tagMatch.min).toBe(1);
    expect(tagMatch.max).toBe(1);

    // decay===freshness は全4行で厳密等価(どちらも1のまま)。
    expect(headline.decayFreshnessEqualRows).toBe(4);
    expect(headline.decayFreshnessDifferentRows).toBe(0);
  });

  it("termSpreads を持たない(空配列の)probe しか無ければ、その項は presentRows=0・min/max=null になる", () => {
    const headline = armHeadline(armA);
    for (const t of headline.termDistinct) {
      expect(t.presentRows).toBe(0);
      expect(t.min).toBeNull();
      expect(t.max).toBeNull();
    }
  });
});
