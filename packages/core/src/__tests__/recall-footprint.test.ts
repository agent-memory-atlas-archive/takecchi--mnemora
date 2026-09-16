import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
  FOOTPRINT_STRUCTURAL_CONSTANTS,
  calibrateRecallFootprint,
  compareWithFullLog,
  estimateRecallFootprint,
  footprintSampleFromRecall,
  type RecallFootprintProfile,
  type RecallFootprintSample,
  type RecallFootprintShape,
} from "../recall-footprint.js";
import { DEFAULT_RECALL_LIMIT } from "../recall.js";
import type { DigestEntry, RecallResult, RecalledMemory } from "../recall.js";

/**
 * `recall-footprint`（Issue #276）の歯。**DB もネットワークも要らない、純関数の検査のみ。**
 */

// ---------------------------------------------------------------------------
// 構造定数のずれを検知する歯（オーナー側から明示的に求められたもの）
// ---------------------------------------------------------------------------

describe("BUILTIN_RECALL_FOOTPRINT_PROFILE — 構造定数のずれを検知する歯", () => {
  it("origin.measuredUnder は FOOTPRINT_STRUCTURAL_CONSTANTS（現在値）と一致する", () => {
    const origin = BUILTIN_RECALL_FOOTPRINT_PROFILE.origin;
    if (origin.kind !== "builtin_default") {
      throw new Error(
        "unreachable: 同梱の既定プロファイルの origin.kind は builtin_default のはず",
      );
    }
    expect(
      origin.measuredUnder,
      "既定プロファイルの係数（charsPerDigest / fixedIndexChars）は、origin.measuredUnder に" +
        "記録した構造定数の下で測った値である。この歯が赤くなったということは、recall.ts /" +
        "digest-band.ts 側の構造定数（DEFAULT_RECALL_LIMIT・DEFAULT_DIGEST_BAND_LIMIT・" +
        "DIGEST_BAND_MAX_CHARS・DIGEST_BAND_MAX_ENTRY_CHARS・digestBandEntryFixedOverheadChars・" +
        "digestBandEntrySeparatorChars のいずれか）を動かしたのに、既定プロファイルの係数を" +
        "測り直していない、ということである。定数を変えたなら BUILTIN_RECALL_FOOTPRINT_PROFILE を" +
        "（examples/chat/compare-baseline.json を実測し直したうえで）測り直すこと。",
    ).toEqual(FOOTPRINT_STRUCTURAL_CONSTANTS);
  });
});

// ---------------------------------------------------------------------------
// estimateRecallFootprint — 境界
// ---------------------------------------------------------------------------

/**
 * この節専用のテスト用プロファイル。**BUILTIN の実測値ではなく、境界の算術だけを検査する。**
 * charsPerDigest=100（DIGEST_BAND_MAX_ENTRY_CHARS=120 未満なので切り詰めは起きない）にして、
 * DEFAULT_DIGEST_BAND_LIMIT 件（50件）で確実に DIGEST_BAND_MAX_CHARS（4000字）へ当たるようにする
 * （50 × (63+1+100) = 8200 ≫ 4000）。
 */
const shapeTestProfile: RecallFootprintProfile = {
  origin: {
    kind: "calibrated",
    sampleCount: 5,
    observedMemoryCount: { min: 1, max: 200 },
    borrowedFromDefault: [],
  },
  charsPerDigest: 100,
  fixedIndexChars: 100,
};

describe("estimateRecallFootprint — 境界", () => {
  it("memoryCountInScope が 0 なら、返る件数も帯の件数も 0（chars は固定分だけ）", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 0 }, shapeTestProfile);
    expect(est.returnedMemories).toBe(0);
    expect(est.bandEntries).toBe(0);
    expect(est.memoriesCappedByLimit).toBe(false);
    expect(est.bandSaturated).toBe(false);
    expect(est.chars).toBe(shapeTestProfile.fixedIndexChars);
  });

  it("memoryCountInScope が limit 未満なら、全件返り、目次帯は空", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 5, limit: 10 }, shapeTestProfile);
    expect(est.returnedMemories).toBe(5);
    expect(est.bandEntries).toBe(0);
    expect(est.memoriesCappedByLimit).toBe(false);
    expect(est.bandSaturated).toBe(false);
  });

  it("memoryCountInScope が limit を超えたら returnedMemories は limit で頭打ち、残りが目次帯へ回る（まだ飽和しない大きさ）", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 30, limit: 10 }, shapeTestProfile);
    expect(est.returnedMemories).toBe(10);
    expect(est.memoriesCappedByLimit).toBe(true);
    expect(est.bandEntries).toBe(20); // min(DEFAULT_DIGEST_BAND_LIMIT=50, 30-10)
    expect(est.bandSaturated).toBe(false);
  });

  it("目次帯が DIGEST_BAND_MAX_CHARS に当たると bandSaturated が true になる", () => {
    const est = estimateRecallFootprint({ memoryCountInScope: 100, limit: 10 }, shapeTestProfile);
    expect(est.bandEntries).toBe(50); // DEFAULT_DIGEST_BAND_LIMIT に頭打ち
    expect(est.bandSaturated).toBe(true);
  });
});

describe("estimateRecallFootprint — 帯が飽和した後は件数を増やしても chars が増えない（mnemora は頭打ち、の主張そのもの）", () => {
  it("bandSaturated な状況で memoryCountInScope をさらに増やしても chars は変わらない", () => {
    const a = estimateRecallFootprint({ memoryCountInScope: 100, limit: 10 }, shapeTestProfile);
    const b = estimateRecallFootprint({ memoryCountInScope: 100_000, limit: 10 }, shapeTestProfile);
    expect(a.bandSaturated).toBe(true);
    expect(b.bandSaturated).toBe(true);
    // 返る件数・帯の件数は、それぞれ limit / bandLimit で頭打ちになっているので同じ。
    expect(b.returnedMemories).toBe(a.returnedMemories);
    expect(b.bandEntries).toBe(a.bandEntries);
    // ⭐ chars 自体が増えない（会話が伸びても mnemora 側は伸びないという主張の核）。
    expect(b.chars).toBe(a.chars);
  });
});

// ---------------------------------------------------------------------------
// associationCount（ADR 0166）— 連想枠の項
// ---------------------------------------------------------------------------

/**
 * ⭐ **後方互換の歯**（ADR 0166、オーナーが名指しで要求したもの）。
 *
 * `shape.associationCount` を**渡さない**呼び出しは、ADR 0166 より前と
 * 1ビットも変わらないことを、`toEqual` で丸ごと検査する
 * ——特定の欄だけを見比べると、見落とした欄が静かに変わっていても気づけない。
 */
describe("estimateRecallFootprint — associationCount を渡さない呼び出しは、ADR 0166 より前と1ビットも変わらない（後方互換）", () => {
  const shapesWithoutAssociation: RecallFootprintShape[] = [
    { memoryCountInScope: 0 },
    { memoryCountInScope: 5, limit: 10 },
    { memoryCountInScope: 30, limit: 10 },
    { memoryCountInScope: 100, limit: 10 },
    { memoryCountInScope: 100_000, limit: 10 },
  ];

  it.each(shapesWithoutAssociation)(
    "%o — 省略時と associationCount: 0 を明示したときの見積もりが完全に一致する",
    (shape) => {
      const omitted = estimateRecallFootprint(shape, shapeTestProfile);
      const explicitZero = estimateRecallFootprint(
        { ...shape, associationCount: 0 },
        shapeTestProfile,
      );
      expect(omitted).toEqual(explicitZero);
      // associationCount を渡していないのだから、昇格は起きていない。
      expect(omitted.associationCount).toBe(0);
    },
  );

  it("省略時の見積もりは、ADR 0166 以前の式（returnedMemories = min(limit, memoryCountInScope)）と一致する", () => {
    // ADR 0166 以前の式をそのままここに複製し、実装から独立に検算する。
    function preAdr0166(shape: { memoryCountInScope: number; limit?: number }) {
      const inScope = Math.max(0, shape.memoryCountInScope);
      const limit = shape.limit ?? DEFAULT_RECALL_LIMIT;
      const bandLimit = 50; // DEFAULT_DIGEST_BAND_LIMIT
      const returnedMemories = Math.min(limit, inScope);
      const bandEligible = Math.max(0, inScope - returnedMemories);
      const bandEntries = Math.min(bandLimit, bandEligible);
      const perEntry = 63 + 1 + Math.min(shapeTestProfile.charsPerDigest, 120);
      const bandChars = Math.min(bandEntries * perEntry, 4000);
      const digestChars = returnedMemories * shapeTestProfile.charsPerDigest;
      const indexChars = shapeTestProfile.fixedIndexChars + bandChars;
      return { returnedMemories, bandEntries, chars: digestChars + indexChars };
    }

    for (const shape of shapesWithoutAssociation) {
      const expected = preAdr0166(shape);
      const actual = estimateRecallFootprint(shape, shapeTestProfile);
      expect(actual.returnedMemories).toBe(expected.returnedMemories);
      expect(actual.bandEntries).toBe(expected.bandEntries);
      expect(actual.chars).toBe(expected.chars);
    }
  });
});

describe("estimateRecallFootprint — associationCount（連想枠が本体へ昇格させた件数）", () => {
  it("帯が件数で飽和していない領域では、昇格1件ごとに『帯の1件』が『本体の1件』に置き換わる", () => {
    // shapeTestProfile: charsPerDigest=100, fixedIndexChars=100。
    // memoryCountInScope=30, limit=10 ⟹ 素の返る件数=10、帯資格=20（bandLimit=50未満、非飽和）。
    const without = estimateRecallFootprint(
      { memoryCountInScope: 30, limit: 10 },
      shapeTestProfile,
    );
    const withAssociation = estimateRecallFootprint(
      { memoryCountInScope: 30, limit: 10, associationCount: 3 },
      shapeTestProfile,
    );

    expect(without.bandEntries).toBe(20);
    expect(withAssociation.returnedMemories).toBe(13); // 10 + 3
    expect(withAssociation.associationCount).toBe(3);
    expect(withAssociation.bandEntries).toBe(17); // 20 - 3（帯から本体へ移った）

    // 1件あたり: 帯の費用(63+1+min(100,120)=164) が消え、本体の費用(charsPerDigest=100) が増える。
    // 差は 3 × (100 - 164) = -192（正味で減る）。
    expect(withAssociation.chars).toBe(without.chars - 3 * 64);
  });

  it("帯が件数で既に飽和している領域では、昇格は帯の費用を減らさず、本体側の費用だけ純増する", () => {
    // memoryCountInScope=100, limit=10 ⟹ 帯資格=90 > bandLimit(50) ⟹ 帯は件数で頭打ち。
    const without = estimateRecallFootprint(
      { memoryCountInScope: 100, limit: 10 },
      shapeTestProfile,
    );
    const withAssociation = estimateRecallFootprint(
      { memoryCountInScope: 100, limit: 10, associationCount: 5 },
      shapeTestProfile,
    );

    expect(without.bandEntries).toBe(50);
    expect(withAssociation.returnedMemories).toBe(15); // 10 + 5
    expect(withAssociation.bandEntries).toBe(50); // 帯資格 85 はまだ50を超えるので変わらない
    // 帯の費用は変わらない(どちらも DIGEST_BAND_MAX_CHARS で頭打ち) ので、
    // 本体側の増分(5 × charsPerDigest=100 = 500)がそのまま純増になる。
    expect(withAssociation.chars).toBe(without.chars + 5 * shapeTestProfile.charsPerDigest);
  });

  it("associationCount が limit の外に居る候補の総数を超えていたら、構造上の上限で切り詰める", () => {
    // memoryCountInScope=12, limit=10 ⟹ limit の外は2件しかいない。
    const est = estimateRecallFootprint(
      { memoryCountInScope: 12, limit: 10, associationCount: 999 },
      shapeTestProfile,
    );
    expect(est.associationCount).toBe(2);
    expect(est.returnedMemories).toBe(12); // 全件が本体へ入り、帯は空になる
    expect(est.bandEntries).toBe(0);
  });

  it("負の associationCount は 0 として扱う（構造上ありえない値を静かに受け入れない）", () => {
    const est = estimateRecallFootprint(
      { memoryCountInScope: 30, limit: 10, associationCount: -5 },
      shapeTestProfile,
    );
    expect(est.associationCount).toBe(0);
    expect(est.returnedMemories).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// calibrateRecallFootprint — 3階建て
// ---------------------------------------------------------------------------

describe("calibrateRecallFootprint — 3階建て", () => {
  it("(a) memoryCount が2種類以上ある帯なし標本 → borrowedFromDefault は空（両係数とも標本から決まる）", () => {
    // totalChars = 100 + 40 * memoryCount という厳密な線形標本。
    const samples: RecallFootprintSample[] = [
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 700, memoryCount: 15, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual([]);
    expect(profile.origin.sampleCount).toBe(3);
    expect(profile.origin.observedMemoryCount).toEqual({ min: 5, max: 15 });
    expect(profile.charsPerDigest).toBeCloseTo(40, 9);
    expect(profile.fixedIndexChars).toBeCloseTo(100, 9);
  });

  it("(b) memoryCount が1種類だけ → fixedIndexChars だけを既定値から借りる（charsPerDigest は標本から決まる）", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const samples: RecallFootprintSample[] = [
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
      { totalChars: 520, memoryCount: 10, bandEntryCount: 0 },
    ];
    const profile = calibrateRecallFootprint(samples, fallback);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["fixedIndexChars"]);
    expect(profile.fixedIndexChars).toBe(fallback.fixedIndexChars);
    const meanY = (500 + 520) / 2;
    expect(profile.charsPerDigest).toBeCloseTo((meanY - fallback.fixedIndexChars) / 10, 9);
  });

  it("(c) 使える標本がゼロ（全部 bandEntryCount > 0）→ 両方の係数を既定値から借りる", () => {
    const fallback = BUILTIN_RECALL_FOOTPRINT_PROFILE;
    const samples: RecallFootprintSample[] = [
      { totalChars: 900, memoryCount: 10, bandEntryCount: 3 },
      { totalChars: 950, memoryCount: 12, bandEntryCount: 2 },
    ];
    const profile = calibrateRecallFootprint(samples, fallback);
    if (profile.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(profile.origin.borrowedFromDefault).toEqual(["charsPerDigest", "fixedIndexChars"]);
    expect(profile.origin.sampleCount).toBe(0);
    expect(profile.origin.observedMemoryCount).toEqual({ min: 0, max: 0 });
    expect(profile.charsPerDigest).toBe(fallback.charsPerDigest);
    expect(profile.fixedIndexChars).toBe(fallback.fixedIndexChars);
  });

  it("⭐ (a) と (c) は origin.kind だけでは区別できないが、borrowedFromDefault で分岐できる", () => {
    const allDataDriven = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    const noneUsable = calibrateRecallFootprint([
      { totalChars: 900, memoryCount: 10, bandEntryCount: 3 },
    ]);

    // どちらも kind は同じ "calibrated"。ここだけを見ると区別が付かない。
    expect(allDataDriven.origin.kind).toBe("calibrated");
    expect(noneUsable.origin.kind).toBe("calibrated");

    if (allDataDriven.origin.kind !== "calibrated" || noneUsable.origin.kind !== "calibrated") {
      throw new Error("unreachable");
    }
    // borrowedFromDefault を見れば、全データ駆動か、全部既定値借用かが完全に分かれる。
    expect(allDataDriven.origin.borrowedFromDefault).toEqual([]);
    expect(noneUsable.origin.borrowedFromDefault).toEqual(["charsPerDigest", "fixedIndexChars"]);
  });
});

// ---------------------------------------------------------------------------
// compareWithFullLog
// ---------------------------------------------------------------------------

describe("compareWithFullLog — reasons は空にならない", () => {
  it("較正済みプロファイルでも、較正した範囲の外を尋ねれば outside_calibrated_range が立つ（空にならない）", () => {
    const calibrated = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    // 較正の observedMemoryCount は {min:5, max:10}。100 はその外側 ⟹ extrapolated。
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 100 },
      profile: calibrated,
    });
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.code === "outside_calibrated_range")).toBe(true);
  });

  it("既定プロファイル（BUILTIN_RECALL_FOOTPRINT_PROFILE）なら必ず profile_not_calibrated が立つ", () => {
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 8 },
    });
    expect(result.reasons.some((r) => r.code === "profile_not_calibrated")).toBe(true);
  });

  /**
   * ⭐ **この歯が、本体のバグを1件見つけた**【実測】。
   *
   * 当初 `FullLogComparison.reasons` の doc は「空にならない（**少なくとも出所に関する札が
   * 1枚は立つ**）」と書いていたが、それは誤りだった——較正済み(`kind: "calibrated"`)・
   * `borrowedFromDefault` が空・較正範囲の内側(`extrapolated === false`)・帯が非飽和・
   * 件数が非切り詰め・`estimatedShare` が許容誤差の外、が重なると出所の札も量の札も
   * 1枚も立たず、`reasons` は**空配列**で返っていた。
   *
   * **doc ではなく実装のほうを直した**——`dominant_term`（見積もりの支配項）を常に
   * 立てる形にし、非空を構造的に保証した。**空の `reasons` は「この判定の理由を1つも
   * 説明できない」ことであり、doc を緩めて済ませてよい種類の食い違いではない**
   * （北極星の問い3「説明できない賢さは採らない」）。
   *
   * ⟹ **この歯は、その回帰を止めるためにここに在る。**
   */
  it("出所の札も量の札も1枚も立たない条件でも、dominant_term が立って reasons は空にならない", () => {
    const calibrated = calibrateRecallFootprint([
      { totalChars: 300, memoryCount: 5, bandEntryCount: 0 },
      { totalChars: 500, memoryCount: 10, bandEntryCount: 0 },
    ]);
    // memoryCountInScope=8 は observedMemoryCount {min:5,max:10} の内側 ⟹ extrapolated=false。
    // limit=10(既定)なので capped もされず、帯も飽和しない。
    // chars = 100(fixedIndexChars) + 8*40(charsPerDigest) = 420。420/1000=0.42 は
    // 既定許容誤差(0.05)の外 ⟹ within_tolerance も立たない。
    const result = compareWithFullLog({
      fullLogChars: 1000,
      shape: { memoryCountInScope: 8 },
      profile: calibrated,
    });
    expect(result.verdict).toBe("mnemora_smaller");
    // ⭐ かつてここが空配列だった。
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.map((r) => r.code)).toEqual(["dominant_term"]);
    // 8件 × 40字 = 320字（memories）> 100字（fixed_index）> 0字（帯なし）。
    const dominant = result.reasons.find((r) => r.code === "dominant_term");
    expect(dominant).toBeDefined();
    expect(dominant?.code === "dominant_term" ? dominant.term : undefined).toBe("memories");
  });

  it("どの入力でも reasons は空にならない（dominant_term が必ず立つ）", () => {
    const shapes = [0, 1, 5, 10, 11, 60, 1000, 100_000];
    for (const memoryCountInScope of shapes) {
      for (const fullLogChars of [0, 1, 200, 5000, 1_000_000]) {
        const result = compareWithFullLog({ fullLogChars, shape: { memoryCountInScope } });
        expect(result.reasons.length).toBeGreaterThan(0);
        expect(result.reasons.some((r) => r.code === "dominant_term")).toBe(true);
      }
    }
  });
});

describe("compareWithFullLog — fullLogChars: 0 で Infinity/NaN が verdict に漏れない", () => {
  it("fullLogChars が 0 でも verdict は3値のどれかであり、estimatedShare は NaN にならない", () => {
    const result = compareWithFullLog({ fullLogChars: 0, shape: { memoryCountInScope: 5 } });
    expect(["mnemora_smaller", "full_log_smaller", "too_close_to_call"]).toContain(result.verdict);
    expect(Number.isNaN(result.estimatedShare)).toBe(false);
    // 会話ログが0文字でも mnemora 側は固定分(fixedIndexChars)を必ず積むので、比は必ず1を超える。
    expect(result.verdict).toBe("full_log_smaller");
    expect(result.estimatedShare).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("compareWithFullLog — 許容誤差の内側は too_close_to_call", () => {
  it("見積もり比が1に十分近ければ too_close_to_call になり、within_tolerance の札が立つ", () => {
    const profile: RecallFootprintProfile = {
      origin: {
        kind: "calibrated",
        sampleCount: 5,
        observedMemoryCount: { min: 1, max: 20 },
        borrowedFromDefault: [],
      },
      charsPerDigest: 10,
      fixedIndexChars: 0,
    };
    // memoryCountInScope=10, limit=既定(10) ⟹ 帯は空。chars = 10 * 10 = 100。
    const est = estimateRecallFootprint({ memoryCountInScope: 10 }, profile);
    expect(est.chars).toBe(100);

    // 100/103 ≈ 0.9709 ⟹ |0.9709 - 1| ≈ 0.0291 は既定許容誤差(0.05)の内側。
    const result = compareWithFullLog({
      fullLogChars: 103,
      shape: { memoryCountInScope: 10 },
      profile,
    });
    expect(result.verdict).toBe("too_close_to_call");
    expect(result.reasons.some((r) => r.code === "within_tolerance")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// footprintSampleFromRecall
// ---------------------------------------------------------------------------

function makeRecalledMemory(id: string): RecalledMemory {
  return {
    memoryId: id,
    digest: "d",
    retrievedVia: "ann",
    provenanceKind: "stated",
    score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 1 },
  };
}

function makeRecallResult(overrides: {
  chars: number;
  memoryCount: number;
  digestBand?: DigestEntry[];
}): RecallResult {
  return {
    recallId: "r1",
    memories: Array.from({ length: overrides.memoryCount }, (_, i) => makeRecalledMemory(`m${i}`)),
    omitted: [],
    index: {
      groups: [],
      totalInScope: overrides.memoryCount,
      countKind: "exact",
      ...(overrides.digestBand !== undefined ? { digestBand: overrides.digestBand } : {}),
    },
    usage: {
      chars: overrides.chars,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

describe("footprintSampleFromRecall — RecallResult から3欄を取り出す", () => {
  it("usage.chars / memories.length / index.digestBand.length をそのまま写す", () => {
    const digestBand: DigestEntry[] = [
      { memoryId: "x1", digest: "a" },
      { memoryId: "x2", digest: "b" },
    ];
    const result = makeRecallResult({ chars: 999, memoryCount: 3, digestBand });
    const sample = footprintSampleFromRecall(result);
    expect(sample).toEqual({ totalChars: 999, memoryCount: 3, bandEntryCount: 2 });
  });

  it("index.digestBand が無ければ bandEntryCount は 0", () => {
    const result = makeRecallResult({ chars: 500, memoryCount: 5 });
    const sample = footprintSampleFromRecall(result);
    expect(sample.bandEntryCount).toBe(0);
  });
});
