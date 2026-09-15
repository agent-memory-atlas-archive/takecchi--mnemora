import { describe, expect, it } from "vitest";
import type { AssociationArmReport } from "../association-arm.js";
import { buildAssociationProbeRunJson } from "../association-json.js";

/**
 * Issue #291: `association-json.ts` の出力口。DB もネットワークも要らない(純関数)。
 *
 * ⭐ この JSON のキー名は確定しており、別担当の summary スクリプトが前提にしている
 * ——ここでは形(キーの有無・値の導出)だけを見る。
 */

function minimalArmReport(overrides: Partial<AssociationArmReport> = {}): AssociationArmReport {
  return {
    armLabel: "off",
    associationEnabled: false,
    associationMaxCount: null,
    probeCount: 12,
    ingestedCount: 96,
    goldReturnedCount: 0,
    hit1Count: 0,
    hit10Count: 0,
    goldViaAssociationCount: 0,
    mrr: 0,
    returnedMemoryTotal: 100,
    memoryCharsTotal: 2000,
    associationCharsTotal: 0,
    stageSkippedReasons: {},
    associationFrameRoles: {},
    repeatFrameIdenticalCount: 0,
    repeatGoldRankSameCount: 0,
    probes: [],
    ...overrides,
  };
}

describe("buildAssociationProbeRunJson", () => {
  it("probeCount/haystackSize を offReport から導く(12件・haystack=96-12*3=60)", () => {
    const json = buildAssociationProbeRunJson({
      offReport: minimalArmReport(),
      on3Report: minimalArmReport({ armLabel: "on3" }),
      on5Report: minimalArmReport({ armLabel: "on5" }),
      on10Report: minimalArmReport({ armLabel: "on10" }),
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      recallLimit: 10,
      warmup: { ok: true, detail: "モデルの読み込みに成功した(warmup() 完了)" },
      measuredAt: new Date("2026-09-16T00:00:00.000Z"),
      commit: "abc123",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.probeCount).toBe(12);
    expect(json.haystackSize).toBe(60);
    expect(json.recallLimit).toBe(10);
    expect(json.llmMode).toBe("deterministic");
    expect(json.embedding).toEqual({
      provider: "local",
      model: "ruri-v3-30m/sym",
      dimensions: 256,
    });
    expect(json.commit).toBe("abc123");
    expect(json.measuredAt).toBe("2026-09-16T00:00:00.000Z");
  });

  it("warmup: ok のとき detail は null(成功時の常套句を残さない)", () => {
    const json = buildAssociationProbeRunJson({
      offReport: minimalArmReport(),
      on3Report: minimalArmReport({ armLabel: "on3" }),
      on5Report: minimalArmReport({ armLabel: "on5" }),
      on10Report: minimalArmReport({ armLabel: "on10" }),
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      recallLimit: 10,
      warmup: { ok: true, detail: "モデルの読み込みに成功した(warmup() 完了)" },
      measuredAt: new Date("2026-09-16T00:00:00.000Z"),
      commit: null,
    });
    expect(json.warmup).toEqual({ ok: true, detail: null });
  });

  it("arms は4件、渡した順(off/on3/on5/on10)のまま", () => {
    const off = minimalArmReport({ armLabel: "off" });
    const on3 = minimalArmReport({ armLabel: "on3" });
    const on5 = minimalArmReport({ armLabel: "on5" });
    const on10 = minimalArmReport({ armLabel: "on10" });
    const json = buildAssociationProbeRunJson({
      offReport: off,
      on3Report: on3,
      on5Report: on5,
      on10Report: on10,
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      recallLimit: 10,
      warmup: { ok: true, detail: "ok" },
      measuredAt: new Date("2026-09-16T00:00:00.000Z"),
      commit: null,
    });
    expect(json.arms).toEqual([off, on3, on5, on10]);
  });

  it("⭐ arm ごとの repeatFrameIdenticalCount/repeatGoldRankSameCount がそのまま乗る(Issue #291 フォローアップ)", () => {
    const off = minimalArmReport({
      armLabel: "off",
      repeatFrameIdenticalCount: 0,
      repeatGoldRankSameCount: 12,
    });
    const on3 = minimalArmReport({
      armLabel: "on3",
      repeatFrameIdenticalCount: 2,
      repeatGoldRankSameCount: 5,
    });
    const on5 = minimalArmReport({ armLabel: "on5" });
    const on10 = minimalArmReport({ armLabel: "on10" });
    const json = buildAssociationProbeRunJson({
      offReport: off,
      on3Report: on3,
      on5Report: on5,
      on10Report: on10,
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      recallLimit: 10,
      warmup: { ok: true, detail: "ok" },
      measuredAt: new Date("2026-09-16T00:00:00.000Z"),
      commit: null,
    });
    expect(json.arms[0]!.repeatFrameIdenticalCount).toBe(0);
    expect(json.arms[0]!.repeatGoldRankSameCount).toBe(12);
    expect(json.arms[1]!.repeatFrameIdenticalCount).toBe(2);
    expect(json.arms[1]!.repeatGoldRankSameCount).toBe(5);
  });

  it("deltas: on(3)/on(5)/on(10) それぞれの対 off。charsPerAdditionalGold は goldReturnedCount<=0 なら null", () => {
    const off = minimalArmReport({
      armLabel: "off",
      goldReturnedCount: 2,
      mrr: 0.1,
      hit10Count: 1,
      memoryCharsTotal: 1000,
    });
    const on3 = minimalArmReport({
      armLabel: "on3",
      goldReturnedCount: 6,
      goldViaAssociationCount: 4,
      mrr: 0.3,
      hit10Count: 1,
      memoryCharsTotal: 1400,
    });
    const on5 = minimalArmReport({
      armLabel: "on5",
      goldReturnedCount: 2,
      goldViaAssociationCount: 0,
      mrr: 0.1,
      hit10Count: 1,
      memoryCharsTotal: 1000,
    });
    const on10 = minimalArmReport({
      armLabel: "on10",
      goldReturnedCount: 5,
      goldViaAssociationCount: 3,
      mrr: 0.2,
      hit10Count: 1,
      memoryCharsTotal: 1300,
    });
    const json = buildAssociationProbeRunJson({
      offReport: off,
      on3Report: on3,
      on5Report: on5,
      on10Report: on10,
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      recallLimit: 10,
      warmup: { ok: true, detail: "ok" },
      measuredAt: new Date("2026-09-16T00:00:00.000Z"),
      commit: null,
    });
    expect(json.deltas).toHaveLength(3);
    const deltaOn3 = json.deltas[0]!;
    const deltaOn5 = json.deltas[1]!;
    const deltaOn10 = json.deltas[2]!;
    expect(deltaOn3.mrr).toBeCloseTo(0.2, 10);
    expect({ ...deltaOn3, mrr: 0 }).toEqual({
      baselineArmLabel: "off",
      againstArmLabel: "on3",
      goldReturnedCount: 4,
      goldViaAssociationCount: 4,
      mrr: 0,
      hit10Count: 0,
      memoryCharsTotal: 400,
      charsPerAdditionalGold: 100,
    });
    // on5 は off と同値(goldReturnedCount の差分が0) ⟹ charsPerAdditionalGold は null。
    expect(deltaOn5).toEqual({
      baselineArmLabel: "off",
      againstArmLabel: "on5",
      goldReturnedCount: 0,
      goldViaAssociationCount: 0,
      mrr: 0,
      hit10Count: 0,
      memoryCharsTotal: 0,
      charsPerAdditionalGold: null,
    });
    expect(deltaOn10.mrr).toBeCloseTo(0.1, 10);
    expect({ ...deltaOn10, mrr: 0 }).toEqual({
      baselineArmLabel: "off",
      againstArmLabel: "on10",
      goldReturnedCount: 3,
      goldViaAssociationCount: 3,
      mrr: 0,
      hit10Count: 0,
      memoryCharsTotal: 300,
      charsPerAdditionalGold: 100,
    });
  });
});
