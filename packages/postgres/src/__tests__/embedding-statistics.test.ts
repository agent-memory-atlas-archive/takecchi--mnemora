import { describe, expect, it } from "vitest";
import { INITIAL_ANALYZE_THRESHOLD, isGeometricAnalyzeThreshold } from "../embedding-statistics.js";

/**
 * (丙) Issue #360 / ADR 0194: 等比の閾値判定は純関数であり、DB を要さない。
 *
 * `INITIAL_ANALYZE_THRESHOLD`（1,000）を import して使う——マジックナンバーを
 * このテストに書き写さない（本文書の指示どおり）。
 */
describe("isGeometricAnalyzeThreshold", () => {
  it("初項未満は false（999 は閾値ではない）", () => {
    expect(isGeometricAnalyzeThreshold(INITIAL_ANALYZE_THRESHOLD - 1)).toBe(false);
  });

  it("初項ちょうどは true（1,000）", () => {
    expect(isGeometricAnalyzeThreshold(INITIAL_ANALYZE_THRESHOLD)).toBe(true);
  });

  it("初項の直後は false（1,001）", () => {
    expect(isGeometricAnalyzeThreshold(INITIAL_ANALYZE_THRESHOLD + 1)).toBe(false);
  });

  it("2番目の閾値の1つ手前は false（1,999）", () => {
    expect(isGeometricAnalyzeThreshold(2 * INITIAL_ANALYZE_THRESHOLD - 1)).toBe(false);
  });

  it("2番目の閾値ちょうどは true（2,000）", () => {
    expect(isGeometricAnalyzeThreshold(2 * INITIAL_ANALYZE_THRESHOLD)).toBe(true);
  });

  it("2番目の閾値の直後は false（2,001）", () => {
    expect(isGeometricAnalyzeThreshold(2 * INITIAL_ANALYZE_THRESHOLD + 1)).toBe(false);
  });

  it("倍数だが2の累乗倍ではない（3,000）は false", () => {
    expect(isGeometricAnalyzeThreshold(3 * INITIAL_ANALYZE_THRESHOLD)).toBe(false);
  });

  it("3番目の閾値ちょうどは true（4,000）", () => {
    expect(isGeometricAnalyzeThreshold(4 * INITIAL_ANALYZE_THRESHOLD)).toBe(true);
  });

  it("3番目の閾値の1つ手前は false（3,999）", () => {
    expect(isGeometricAnalyzeThreshold(4 * INITIAL_ANALYZE_THRESHOLD - 1)).toBe(false);
  });

  it("4番目の閾値ちょうどは true（8,000）", () => {
    expect(isGeometricAnalyzeThreshold(8 * INITIAL_ANALYZE_THRESHOLD)).toBe(true);
  });

  it("0・負数は false", () => {
    expect(isGeometricAnalyzeThreshold(0)).toBe(false);
    expect(isGeometricAnalyzeThreshold(-1000)).toBe(false);
  });

  it("initialThreshold を差し替えても同じ規則で動く（等比 100/200/400/…）", () => {
    expect(isGeometricAnalyzeThreshold(99, 100)).toBe(false);
    expect(isGeometricAnalyzeThreshold(100, 100)).toBe(true);
    expect(isGeometricAnalyzeThreshold(101, 100)).toBe(false);
    expect(isGeometricAnalyzeThreshold(300, 100)).toBe(false);
    expect(isGeometricAnalyzeThreshold(400, 100)).toBe(true);
  });
});
