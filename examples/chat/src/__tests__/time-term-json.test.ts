import { describe, expect, it } from "vitest";
import { buildTimeTermJson } from "../time-term-json.js";
import type { PairMember, TimeTermArmReport, TimeProbeOutcome } from "../time-term-arm.js";

/**
 * Issue #217: `time-term-json.ts` の出力口。DB もネットワークも要らない(純関数)。
 *
 * ⭐ **最重要の検査**: `report.probes` をそのまま写していること(集計を作り直さない)、
 * そして `similarity` が `undefined` の member を `null` へ写す(`ScoreBreakdown.similarity`
 * は ANN 経由でない候補には存在しない欄——JSON では `undefined` を書けないので `null` にする)。
 */

function makeMember(overrides: Partial<PairMember> = {}): PairMember {
  return {
    rank: 1,
    score: {
      total: 0.5,
      similarity: 0.9,
      decay: 1,
      tagMatch: 1,
      freshness: 0.5,
      strength: 1,
    },
    digest: "d",
    ...overrides,
  };
}

function makeProbeOutcome(overrides: Partial<TimeProbeOutcome> = {}): TimeProbeOutcome {
  return {
    probeId: "half-life",
    outcome: "newer-ranked-higher",
    newer: makeMember({ rank: 1 }),
    older: makeMember({ rank: 2, score: { ...makeMember().score, total: 0.25, freshness: 0.25 } }),
    similarityGapWithinPair: 0,
    freshnessGapWithinPair: 0.25,
    freshnessRatio: 0.5,
    decayRatio: 1,
    totalRatio: 0.5,
    omittedKinds: [],
    totalInScope: 2,
    termSpreads: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<TimeTermArmReport> = {}): TimeTermArmReport {
  return {
    armLabel: "time-term",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    now: new Date("2026-09-15T00:00:00.000Z"),
    probes: [makeProbeOutcome()],
    ...overrides,
  };
}

describe("buildTimeTermJson", () => {
  it("armLabel/llmMode/embeddingMode/probeCount をトップレベルに持つ(実際に使われた値)", () => {
    const json = buildTimeTermJson({
      report: makeReport(),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: "abc123",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.measuredAt).toBe("2026-09-15T01:00:00.000Z");
    expect(json.commit).toBe("abc123");
    expect(json.armLabel).toBe("time-term");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("deterministic");
    expect(json.probeCount).toBe(1);
  });

  it("commit が null なら null のまま書く(推測で埋めない)", () => {
    const json = buildTimeTermJson({
      report: makeReport(),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.commit).toBeNull();
  });

  it("probes をそのまま写す(outcome/totalInScope/omittedKinds/比の欄)", () => {
    const json = buildTimeTermJson({
      report: makeReport({
        probes: [
          makeProbeOutcome({ probeId: "half-life", outcome: "newer-ranked-higher" }),
          makeProbeOutcome({
            probeId: "far-past",
            outcome: "older-not-returned",
            omittedKinds: ["below_threshold"],
            older: null,
            freshnessRatio: null,
            decayRatio: null,
            totalRatio: null,
          }),
        ],
      }),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.probes).toHaveLength(2);
    expect(json.probes[0]!.probeId).toBe("half-life");
    expect(json.probes[0]!.outcome).toBe("newer-ranked-higher");
    expect(json.probes[1]!.probeId).toBe("far-past");
    expect(json.probes[1]!.outcome).toBe("older-not-returned");
    expect(json.probes[1]!.omittedKinds).toEqual(["below_threshold"]);
    expect(json.probes[1]!.older).toBeNull();
    expect(json.probes[1]!.freshnessRatio).toBeNull();
  });

  it("🔴 similarity が undefined(ANN 経由でない)の member は null に写す", () => {
    const json = buildTimeTermJson({
      report: makeReport({
        probes: [
          makeProbeOutcome({
            newer: makeMember({
              score: { total: 1, decay: 1, tagMatch: 1, freshness: 1, strength: 1 },
            }),
          }),
        ],
      }),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.probes[0]!.newer).not.toBeNull();
    expect(json.probes[0]!.newer!.similarity).toBeNull();
  });

  it("member の rank/total/decay/tagMatch/freshness/strength/digest を写す", () => {
    const json = buildTimeTermJson({
      report: makeReport(),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    const newer = json.probes[0]!.newer!;
    expect(newer.rank).toBe(1);
    expect(newer.total).toBe(0.5);
    expect(newer.similarity).toBe(0.9);
    expect(newer.decay).toBe(1);
    expect(newer.tagMatch).toBe(1);
    expect(newer.freshness).toBe(0.5);
    expect(newer.strength).toBe(1);
    expect(newer.digest).toBe("d");
  });

  it("newer/older の両方が null の probe も落ちずに写す(neither-returned)", () => {
    const json = buildTimeTermJson({
      report: makeReport({
        probes: [
          makeProbeOutcome({
            probeId: "collapsed-case",
            outcome: "neither-returned",
            newer: null,
            older: null,
            similarityGapWithinPair: null,
            freshnessGapWithinPair: null,
            freshnessRatio: null,
            decayRatio: null,
            totalRatio: null,
          }),
        ],
      }),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.probes[0]!.newer).toBeNull();
    expect(json.probes[0]!.older).toBeNull();
    expect(json.probes[0]!.outcome).toBe("neither-returned");
  });

  it("probeCount は probes.length から導く(書き写さない)", () => {
    const json = buildTimeTermJson({
      report: makeReport({
        probes: [
          makeProbeOutcome(),
          makeProbeOutcome({ probeId: "x" }),
          makeProbeOutcome({ probeId: "y" }),
        ],
      }),
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.probeCount).toBe(3);
    expect(json.probes).toHaveLength(3);
  });
});
