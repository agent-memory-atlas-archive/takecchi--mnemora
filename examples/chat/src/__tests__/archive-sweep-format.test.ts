import { describe, expect, it } from "vitest";
import { formatArchiveSweepCostReport } from "../archive-sweep-format.js";
import { buildArchiveSweepCostRunJson } from "../archive-sweep-json.js";
import type { ArchiveSweepPhaseJson, ArchiveSweepProbeJson } from "../archive-sweep-json.js";

function makeProbe(overrides: Partial<ArchiveSweepProbeJson> = {}): ArchiveSweepProbeJson {
  return {
    probeId: "color",
    carriedCount: 3,
    carriedDigestTokens: 12,
    usageChars: 30,
    usageEstimatedTokens: 10,
    usageIndexChars: 5,
    totalInScope: 20,
    goldRank: 1,
    recalledActiveShare: 0.3,
    omittedArchivedCount: 0,
    omittedKinds: [],
    budgetExceeded: false,
    ...overrides,
  };
}

function makePhase(overrides: {
  activeCount: number;
  archivedCount: number;
  probe?: Partial<ArchiveSweepProbeJson>;
}): ArchiveSweepPhaseJson {
  const probe = makeProbe(overrides.probe);
  const mean = {
    carriedCount: probe.carriedCount,
    carriedDigestTokens: probe.carriedDigestTokens,
    usageChars: probe.usageChars,
    usageEstimatedTokens: probe.usageEstimatedTokens,
    usageIndexChars: probe.usageIndexChars,
    totalInScope: probe.totalInScope,
    recalledActiveShare: probe.recalledActiveShare,
    omittedArchivedCount: probe.omittedArchivedCount,
    goldRank: probe.goldRank,
    goldRankExcludedCount: 0,
  };
  return {
    store: {
      activeCount: overrides.activeCount,
      supersededCount: 0,
      archivedCount: overrides.archivedCount,
      activeContentChars: 100,
      activeContentTokens: 40,
      activeDigestChars: 20,
      activeDigestTokens: 8,
      allContentChars: 100,
    },
    recall: {
      unbudgeted: { probes: [probe], mean },
      budgeted: [{ budgetTokens: 32, probes: [probe], mean }],
    },
  };
}

describe("formatArchiveSweepCostReport", () => {
  it("例外を投げず、主要な数字を含む文字列を返す", () => {
    const json = buildArchiveSweepCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      probeCount: 1,
      haystackSize: 6,
      halfLifeHours: 1,
      budgetLadder: [32],
      recallLimit: 50,
      sweep: { supported: true, limit: 1000, archivedCount: 6, reachedLimit: false },
      before: makePhase({ activeCount: 20, archivedCount: 0 }),
      after: makePhase({
        activeCount: 14,
        archivedCount: 6,
        probe: { omittedArchivedCount: 1 },
      }),
      measuredAt: new Date(),
      commit: null,
    });
    const report = formatArchiveSweepCostReport(json);
    expect(report).toContain("llm=deterministic");
    expect(report).toContain("halfLifeHours=1");
    expect(report).toContain("archivedCount=6");
    expect(report).toContain("| before |");
    expect(report).toContain("| after |");
    expect(report).toContain("budget=32");
  });

  it("goldRank が null(除外あり)の phase でも例外を投げない", () => {
    const json = buildArchiveSweepCostRunJson({
      llmMode: "deterministic",
      embeddingMode: "local",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      probeCount: 1,
      haystackSize: 6,
      halfLifeHours: 1,
      budgetLadder: [],
      recallLimit: 50,
      sweep: { supported: true, limit: 1000, archivedCount: 0, reachedLimit: false },
      before: makePhase({ activeCount: 20, archivedCount: 0, probe: { goldRank: null } }),
      after: makePhase({ activeCount: 20, archivedCount: 0, probe: { goldRank: null } }),
      measuredAt: new Date(),
      commit: null,
    });
    expect(() => formatArchiveSweepCostReport(json)).not.toThrow();
    expect(formatArchiveSweepCostReport(json)).toContain("(無し, 除外0件)");
  });
});
