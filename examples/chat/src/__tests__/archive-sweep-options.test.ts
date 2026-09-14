import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_LADDER, DEFAULT_RECALL_LIMIT } from "../consolidation-cost-options.js";
import {
  DEFAULT_HALF_LIFE_HOURS,
  DEFAULT_MARGIN_HOURS,
  DEFAULT_SWEEP_LIMIT,
  parseArchiveSweepCostOptions,
} from "../archive-sweep-options.js";

describe("parseArchiveSweepCostOptions", () => {
  it("環境変数が無ければ既定値(consolidation-cost-options.tsのbudgetLadder/recallLimitを共有する)", () => {
    const options = parseArchiveSweepCostOptions({});
    expect(options.halfLifeHours).toBe(DEFAULT_HALF_LIFE_HOURS);
    expect(options.marginHours).toBe(DEFAULT_MARGIN_HOURS);
    expect(options.sweepLimit).toBe(DEFAULT_SWEEP_LIMIT);
    expect(options.budgetLadder).toEqual([...DEFAULT_BUDGET_LADDER]);
    expect(options.recallLimit).toBe(DEFAULT_RECALL_LIMIT);
  });

  it("MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS を数値(小数可)として読む", () => {
    const options = parseArchiveSweepCostOptions({
      MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS: "0.25",
    });
    expect(options.halfLifeHours).toBe(0.25);
  });

  it("MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS が0以下なら例外", () => {
    expect(() =>
      parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS: "0" }),
    ).toThrow();
    expect(() =>
      parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS: "-1" }),
    ).toThrow();
  });

  it("MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS を数値(小数可)として読む", () => {
    const options = parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS: "2" });
    expect(options.marginHours).toBe(2);
  });

  it("MNEMORA_ARCHIVE_SWEEP_LIMIT を正の整数として読む", () => {
    const options = parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_LIMIT: "10" });
    expect(options.sweepLimit).toBe(10);
  });

  it("MNEMORA_ARCHIVE_SWEEP_LIMIT が整数でなければ例外", () => {
    expect(() => parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_LIMIT: "1.5" })).toThrow();
    expect(() => parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_LIMIT: "0" })).toThrow();
  });

  it("MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER をカンマ区切りの数値配列として読む", () => {
    const options = parseArchiveSweepCostOptions({
      MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER: "16, 48,96",
    });
    expect(options.budgetLadder).toEqual([16, 48, 96]);
  });

  it("MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER の値が不正なら例外", () => {
    expect(() =>
      parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER: "16,-1" }),
    ).toThrow();
  });

  it("MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT が正の整数でなければ例外", () => {
    expect(() =>
      parseArchiveSweepCostOptions({ MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT: "-5" }),
    ).toThrow();
  });
});
