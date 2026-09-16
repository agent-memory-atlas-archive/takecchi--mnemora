import { describe, expect, it } from "vitest";
import type { Omission } from "@mnemora/core";
import { buildCompareJson } from "../compare-json.js";
import type { ComparisonRow } from "../compare.js";

/**
 * Issue #242: `compare-json.ts` の出力口。DB もネットワークも要らない(純関数)。
 *
 * ⭐ **最重要の検査**: `ComparisonRow[]` をそのまま写していること(集計を作り直さない)、
 * `omitted`(`Omission[]`)を丸ごと保持すること(`retrieval-json.ts`/`time-term-json.ts` の
 * 対応する検査と同じ理由)。
 */

function makeOmission(
  overrides: Partial<Extract<Omission, { kind: "not_indexed" }>> = {},
): Omission {
  return {
    kind: "not_indexed",
    reason: "pending",
    count: 3,
    countKind: "exact",
    ...overrides,
  };
}

function makeRow(overrides: Partial<ComparisonRow> = {}): ComparisonRow {
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
    memoryUsageReported: true,
    ...overrides,
  };
}

describe("buildCompareJson", () => {
  it("schemaVersion/measuredAt/commit/llmMode/embeddingMode をトップレベルに持つ(実際に使われた値)", () => {
    const json = buildCompareJson({
      rows: [makeRow()],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: "abc123",
    });
    expect(json.schemaVersion).toBe(1);
    expect(json.measuredAt).toBe("2026-09-15T01:00:00.000Z");
    expect(json.commit).toBe("abc123");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("deterministic");
  });

  it("commit が null なら null のまま書く(推測で埋めない)", () => {
    const json = buildCompareJson({
      rows: [makeRow()],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.commit).toBeNull();
  });

  it("rowCount は rows.length から導く(書き写さない)", () => {
    const json = buildCompareJson({
      rows: [makeRow({ turnCount: 2 }), makeRow({ turnCount: 4 }), makeRow({ turnCount: 6 })],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.rowCount).toBe(3);
    expect(json.rows).toHaveLength(3);
  });

  it("row の全欄をそのまま写す", () => {
    const row = makeRow({
      fillerPairs: 20,
      turnCount: 42,
      naiveChars: 1048,
      naiveTokens: 500,
      mnemoraChars: 647,
      mnemoraTokens: 300,
      mnemoraShareOfNaiveChars: 647 / 1048,
      totalInScope: 90,
      returnedCount: 10,
      annCandidateCount: 90,
      factStatementSurvived: false,
    });
    const json = buildCompareJson({
      rows: [row],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    const written = json.rows[0]!;
    expect(written.fillerPairs).toBe(20);
    expect(written.turnCount).toBe(42);
    expect(written.naiveChars).toBe(1048);
    expect(written.naiveTokens).toBe(500);
    expect(written.mnemoraChars).toBe(647);
    expect(written.mnemoraTokens).toBe(300);
    expect(written.mnemoraShareOfNaiveChars).toBeCloseTo(647 / 1048);
    expect(written.totalInScope).toBe(90);
    expect(written.returnedCount).toBe(10);
    expect(written.annCandidateCount).toBe(90);
    expect(written.factStatementSurvived).toBe(false);
  });

  it("🔴 omitted(Omission[])を丸ごと写す(kind ごとに欄が違っても落とさない)", () => {
    const omitted: Omission[] = [
      makeOmission({ reason: "pending", count: 271, countKind: "exact" }),
      { kind: "below_threshold", count: 5, countKind: "exact" },
      { kind: "ann_truncated", countKind: "unknown", certainty: "undecidable" },
    ];
    const json = buildCompareJson({
      rows: [makeRow({ omitted })],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.rows[0]!.omitted).toEqual(omitted);
  });

  it("omitted が空配列でも落ちない", () => {
    const json = buildCompareJson({
      rows: [makeRow({ omitted: [] })],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.rows[0]!.omitted).toEqual([]);
  });

  it("呼び出し側の row.omitted 配列への後からの変更が、組み立てた JSON に影響しない(複製している)", () => {
    const omitted: Omission[] = [makeOmission({ count: 1 })];
    const row = makeRow({ omitted });
    const json = buildCompareJson({
      rows: [row],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    omitted.push({ kind: "ann_unreached", countKind: "unknown" });
    expect(json.rows[0]!.omitted).toHaveLength(1);
  });

  it("rows が空配列でも落ちない(rowCount は 0)", () => {
    const json = buildCompareJson({
      rows: [],
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      measuredAt: new Date("2026-09-15T01:00:00.000Z"),
      commit: null,
    });
    expect(json.rowCount).toBe(0);
    expect(json.rows).toEqual([]);
  });
});
