import { describe, expect, it } from "vitest";
import { compareCheckRunNameSets, summarizeCheckRuns, verdict } from "../ci-green-check-lib.mjs";

/**
 * `scripts/ci-green-check-lib.mjs`（判定そのものの集合演算）の歯。
 *
 * ⚠ このファイルは `gh` を1度も呼ばない。実際の check-runs は合成した入力で表現する
 * ——`adr-index-completeness-lib.test.mjs` が実ファイルを読まないのと同じ役割分担。
 */

describe("summarizeCheckRuns", () => {
  it("全件 completed かつ success なら pending も nonSuccess も空", () => {
    const result = summarizeCheckRuns([
      { name: "a", status: "completed", conclusion: "success" },
      { name: "b", status: "completed", conclusion: "success" },
    ]);
    expect(result).toEqual({
      total: 2,
      pending: [],
      nonSuccess: [],
      allCompleted: true,
      allSuccess: true,
    });
  });

  it("in_progress が1件でもあれば pending に名指しで入り、allCompleted は false", () => {
    const result = summarizeCheckRuns([
      { name: "a", status: "completed", conclusion: "success" },
      { name: "b", status: "in_progress", conclusion: null },
    ]);
    expect(result.allCompleted).toBe(false);
    expect(result.pending).toEqual(["b"]);
  });

  it("completed でも conclusion が success でなければ nonSuccess に名指しで入る（skipped を含む）", () => {
    const result = summarizeCheckRuns([
      { name: "a", status: "completed", conclusion: "success" },
      { name: "b", status: "completed", conclusion: "failure" },
      { name: "c", status: "completed", conclusion: "skipped" },
    ]);
    expect(result.allCompleted).toBe(true);
    expect(result.allSuccess).toBe(false);
    expect(result.nonSuccess).toEqual([
      { name: "b", conclusion: "failure" },
      { name: "c", conclusion: "skipped" },
    ]);
  });
});

describe("verdict", () => {
  it("0件は pending（Issue #228 観測1: 登録されていないだけかもしれない）", () => {
    const result = verdict([]);
    expect(result.status).toBe("pending");
  });

  it("未完了が在れば pending", () => {
    const result = verdict([{ name: "a", status: "in_progress", conclusion: null }]);
    expect(result.status).toBe("pending");
  });

  it("全完了・全success なら green", () => {
    const result = verdict([
      { name: "a", status: "completed", conclusion: "success" },
      { name: "b", status: "completed", conclusion: "success" },
    ]);
    expect(result.status).toBe("green");
  });

  it("全完了だが1件でも success でなければ red（run 全体ではなく job 単位で見る）", () => {
    // Issue #228 観測2 の再現: run 全体は failure でも、他のジョブは success ということが
    // あるが、ここでの判定対象はあくまで job（check run）単位の集合である。
    const result = verdict([
      { name: "typecheck / lint / test / build", status: "completed", conclusion: "failure" },
      { name: "archive-sweep-cost", status: "completed", conclusion: "success" },
    ]);
    expect(result.status).toBe("red");
    expect(result.reason).toContain("typecheck / lint / test / build");
  });
});

describe("compareCheckRunNameSets", () => {
  it("同じ名前集合なら stable=true", () => {
    const result = compareCheckRunNameSets(
      [{ name: "a" }, { name: "b" }],
      [{ name: "b" }, { name: "a" }],
    );
    expect(result).toEqual({ stable: true, added: [], removed: [] });
  });

  it("後から増えた名前を added に、消えた名前を removed に名指しで返す", () => {
    const result = compareCheckRunNameSets(
      [{ name: "a" }, { name: "b" }],
      [{ name: "a" }, { name: "c" }],
    );
    expect(result.stable).toBe(false);
    expect(result.added).toEqual(["c"]);
    expect(result.removed).toEqual(["b"]);
  });
});
