import { defaultDecayStrategy, heuristicTokenCounter } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import {
  buildArchiveSweepCostRunJson,
  buildArchiveSweepMeanJson,
  buildArchiveSweepProbeJson,
  buildArchiveSweepStoreJson,
  buildWeightsUnavailableArchiveSweepCostRunJson,
  computeRecalledActiveShare,
  decayFloorOffsetMs,
  exitCodeForArchiveSweepCostRun,
  fillerBackdateMs,
} from "../archive-sweep-json.js";
import type {
  ArchiveSweepPhaseJson,
  ArchiveSweepProbeJson,
  RawArchiveSweepProbeMeasurement,
} from "../archive-sweep-json.js";

describe("decayFloorOffsetMs", () => {
  it("defaultDecayStrategy.floorAt(strength=1, threshold既定)をそのまま呼んだ結果と一致する", () => {
    const halfLifeHours = 12;
    const epoch = new Date(0);
    const expected = defaultDecayStrategy
      .floorAt({ recordedAt: epoch, lastReinforcedAt: null, strength: 1, halfLifeHours })
      .getTime();
    expect(decayFloorOffsetMs(halfLifeHours)).toBe(expected);
  });

  it("halfLifeHoursに比例する(式を書き写していないことの間接確認)", () => {
    expect(decayFloorOffsetMs(2)).toBeCloseTo(decayFloorOffsetMs(1) * 2, 6);
  });
});

describe("fillerBackdateMs", () => {
  it("decayFloorOffsetMs(halfLifeHours) + marginHours*3600*1000 を返す", () => {
    const halfLifeHours = 1;
    const marginHours = 0.5;
    expect(fillerBackdateMs(halfLifeHours, marginHours)).toBe(
      decayFloorOffsetMs(halfLifeHours) + marginHours * 60 * 60 * 1000,
    );
  });
});

describe("computeRecalledActiveShare", () => {
  it("carriedCount / activeCount", () => {
    expect(computeRecalledActiveShare(5, 10)).toBeCloseTo(0.5);
    expect(computeRecalledActiveShare(10, 10)).toBeCloseTo(1);
  });

  it("activeCount が0以下なら0を返す(NaN/Infinityを出さない)", () => {
    expect(computeRecalledActiveShare(5, 0)).toBe(0);
    expect(computeRecalledActiveShare(0, 0)).toBe(0);
  });
});

function rawProbe(
  overrides: Partial<RawArchiveSweepProbeMeasurement> = {},
): RawArchiveSweepProbeMeasurement {
  return {
    probeId: "color",
    memoryDigests: ["digest one", "digest two"],
    goldRank: 1,
    totalInScope: 20,
    omittedKinds: [],
    omittedArchivedCount: 0,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    budgetExceeded: false,
    ...overrides,
  };
}

describe("buildArchiveSweepProbeJson", () => {
  it("carriedCount は memoryDigests.length、carriedDigestTokens は連結して数えた値", () => {
    const raw = rawProbe();
    const json = buildArchiveSweepProbeJson(raw, 10);
    expect(json.probeId).toBe("color");
    expect(json.carriedCount).toBe(2);
    expect(json.carriedDigestTokens).toBe(
      heuristicTokenCounter.count(raw.memoryDigests.join("\n")).tokens,
    );
    expect(json.recalledActiveShare).toBeCloseTo(0.2);
    expect(json.goldRank).toBe(1);
    expect(json.omittedArchivedCount).toBe(0);
    expect(json.usageChars).toBe(100);
    expect(json.totalInScope).toBe(20);
    expect(json.omittedKinds).toEqual([]);
    expect(json.budgetExceeded).toBe(false);
  });

  it("omittedArchivedCountは掃引後に正の値へ動きうる(0のまま埋めない)", () => {
    const json = buildArchiveSweepProbeJson(rawProbe({ omittedArchivedCount: 3 }), 10);
    expect(json.omittedArchivedCount).toBe(3);
  });

  it("goldRank が null なら null のまま伝わる(0 や -1 に化けない)", () => {
    const json = buildArchiveSweepProbeJson(rawProbe({ goldRank: null }), 10);
    expect(json.goldRank).toBeNull();
  });

  it("omittedKinds は写しであり、呼び出し側の元配列を変更しても影響しない", () => {
    const original = ["not_indexed"];
    const json = buildArchiveSweepProbeJson(rawProbe({ omittedKinds: original }), 10);
    original.push("filtered");
    expect(json.omittedKinds).toEqual(["not_indexed"]);
  });
});

describe("buildArchiveSweepMeanJson", () => {
  it("数値欄は単純平均、goldRank は null を除いた平均+除外件数", () => {
    const probes: ArchiveSweepProbeJson[] = [
      buildArchiveSweepProbeJson(rawProbe({ probeId: "a", goldRank: 1, memoryDigests: ["x"] }), 10),
      buildArchiveSweepProbeJson(rawProbe({ probeId: "b", goldRank: null, memoryDigests: [] }), 10),
      buildArchiveSweepProbeJson(
        rawProbe({ probeId: "c", goldRank: 3, memoryDigests: ["y", "z"] }),
        10,
      ),
    ];
    const mean = buildArchiveSweepMeanJson(probes);
    expect(mean.goldRank).toBeCloseTo(2); // (1+3)/2、null(b)は除外
    expect(mean.goldRankExcludedCount).toBe(1);
    expect(mean.carriedCount).toBeCloseTo((1 + 0 + 2) / 3);
  });

  it("全 probe が goldRank:null なら mean.goldRank は null", () => {
    const probes = [
      buildArchiveSweepProbeJson(rawProbe({ probeId: "a", goldRank: null }), 10),
      buildArchiveSweepProbeJson(rawProbe({ probeId: "b", goldRank: null }), 10),
    ];
    const mean = buildArchiveSweepMeanJson(probes);
    expect(mean.goldRank).toBeNull();
    expect(mean.goldRankExcludedCount).toBe(2);
  });
});

describe("buildArchiveSweepStoreJson", () => {
  it("active の content/digest 文字数・トークン数を数え、archivedCount/allContentChars はそのまま渡す", () => {
    const json = buildArchiveSweepStoreJson({
      activeContentsAndDigests: [
        { content: "hello world", digest: "hi" },
        { content: "foo", digest: "bar" },
      ],
      supersededCount: 0,
      archivedCount: 5,
      allContentChars: 999,
    });
    expect(json.activeCount).toBe(2);
    expect(json.supersededCount).toBe(0);
    expect(json.archivedCount).toBe(5);
    expect(json.activeContentChars).toBe("hello world".length + "foo".length);
    expect(json.activeDigestChars).toBe("hi".length + "bar".length);
    expect(json.allContentChars).toBe(999);
  });

  it("active が0件でも0で埋まる(NaNにならない)", () => {
    const json = buildArchiveSweepStoreJson({
      activeContentsAndDigests: [],
      supersededCount: 0,
      archivedCount: 0,
      allContentChars: 0,
    });
    expect(json.activeCount).toBe(0);
    expect(json.activeContentChars).toBe(0);
    expect(json.activeContentTokens).toBe(0);
  });
});

function phase(overrides: Partial<ArchiveSweepPhaseJson> = {}): ArchiveSweepPhaseJson {
  return {
    store: buildArchiveSweepStoreJson({
      activeContentsAndDigests: [],
      supersededCount: 0,
      archivedCount: 0,
      allContentChars: 0,
    }),
    recall: {
      unbudgeted: { probes: [], mean: buildArchiveSweepMeanJson([]) },
      budgeted: [],
    },
    ...overrides,
  };
}

describe("buildArchiveSweepCostRunJson", () => {
  it("与えたメタデータをそのまま組み立てる", () => {
    const measuredAt = new Date("2026-01-01T00:00:00.000Z");
    const json = buildArchiveSweepCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      probeCount: 7,
      haystackSize: 60,
      halfLifeHours: 1,
      budgetLadder: [32, 64],
      recallLimit: 50,
      sweep: { supported: true, limit: 1000, archivedCount: 60, reachedLimit: false },
      before: phase(),
      after: phase(),
      measuredAt,
      commit: "abc",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("measured");
    expect(json.measuredAt).toBe(measuredAt.toISOString());
    expect(json.commit).toBe("abc");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("local");
    expect(json.probeCount).toBe(7);
    expect(json.haystackSize).toBe(60);
    expect(json.halfLifeHours).toBe(1);
    expect(json.budgetLadder).toEqual([32, 64]);
    expect(json.recallLimit).toBe(50);
    expect(json.sweep).toEqual({
      supported: true,
      limit: 1000,
      archivedCount: 60,
      reachedLimit: false,
    });
  });

  it("budgetLadder は写しであり、呼び出し側配列の変更に影響されない", () => {
    const ladder = [32, 64];
    const json = buildArchiveSweepCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      embeddingSpace: { provider: "testkit", model: "deterministic", dimensions: 8 },
      probeCount: 0,
      haystackSize: 0,
      halfLifeHours: 1,
      budgetLadder: ladder,
      recallLimit: 50,
      sweep: { supported: false, limit: 1000, archivedCount: 0, reachedLimit: false },
      before: phase(),
      after: phase(),
      measuredAt: new Date(),
      commit: null,
    });
    ladder.push(999);
    expect(json.budgetLadder).toEqual([32, 64]);
  });
});

describe("buildWeightsUnavailableArchiveSweepCostRunJson", () => {
  it("メトリクスの欄を一切持たない(0/nullで埋めない)", () => {
    const measuredAt = new Date("2026-01-01T00:00:00.000Z");
    const json = buildWeightsUnavailableArchiveSweepCostRunJson({
      measuredAt,
      commit: null,
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("weights_unavailable");
    expect(json.measuredAt).toBe(measuredAt.toISOString());
    expect(json.commit).toBeNull();
    expect("before" in json).toBe(false);
    expect("sweep" in json).toBe(false);
    if (json.status === "weights_unavailable") {
      expect(json.detail).toContain("重みを取得できなかったので、値は測っていない");
    }
  });
});

describe("exitCodeForArchiveSweepCostRun", () => {
  it("status:measured かつ sweep.supported:true なら 0", () => {
    const json = buildArchiveSweepCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "m", dimensions: 1 },
      probeCount: 0,
      haystackSize: 0,
      halfLifeHours: 1,
      budgetLadder: [],
      recallLimit: 1,
      sweep: { supported: true, limit: 10, archivedCount: 0, reachedLimit: false },
      before: phase(),
      after: phase(),
      measuredAt: new Date(),
      commit: null,
    });
    expect(exitCodeForArchiveSweepCostRun(json)).toBe(0);
  });

  it("sweep.supported:false なら 1(store が対応していないのに黙って0件成功にしない)", () => {
    const json = buildArchiveSweepCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "m", dimensions: 1 },
      probeCount: 0,
      haystackSize: 0,
      halfLifeHours: 1,
      budgetLadder: [],
      recallLimit: 1,
      sweep: { supported: false, limit: 10, archivedCount: 0, reachedLimit: false },
      before: phase(),
      after: phase(),
      measuredAt: new Date(),
      commit: null,
    });
    expect(exitCodeForArchiveSweepCostRun(json)).toBe(1);
  });

  it("weights_unavailable は 1(そもそも測っていない)", () => {
    const json = buildWeightsUnavailableArchiveSweepCostRunJson({
      measuredAt: new Date(),
      commit: null,
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    expect(exitCodeForArchiveSweepCostRun(json)).toBe(1);
  });
});
