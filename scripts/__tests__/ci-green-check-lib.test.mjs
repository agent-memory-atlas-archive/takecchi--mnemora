import { describe, expect, it } from "vitest";
import {
  compareCheckRunNameSets,
  formatMatchHeadCommitHint,
  summarizeCheckRuns,
  summarizeRequiredContexts,
  verdict,
} from "../ci-green-check-lib.mjs";

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
    const result = verdict([], ["a"]);
    expect(result.status).toBe("pending");
    expect(result.reason).toContain("check-runs が0件");
  });

  it("未完了が在れば pending", () => {
    const result = verdict([{ name: "a", status: "in_progress", conclusion: null }], ["a"]);
    expect(result.status).toBe("pending");
  });

  it("全完了・全success なら green", () => {
    const result = verdict(
      [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "success" },
      ],
      ["a", "b"],
    );
    expect(result.status).toBe("green");
  });

  it("全完了だが1件でも success でなければ red（run 全体ではなく job 単位で見る）", () => {
    // Issue #228 観測2 の再現: run 全体は failure でも、他のジョブは success ということが
    // あるが、ここでの判定対象はあくまで job（check run）単位の集合である。
    const result = verdict(
      [
        { name: "typecheck / lint / test / build", status: "completed", conclusion: "failure" },
        { name: "archive-sweep-cost", status: "completed", conclusion: "success" },
      ],
      ["typecheck / lint / test / build", "archive-sweep-cost"],
    );
    expect(result.status).toBe("red");
    expect(result.reason).toContain("typecheck / lint / test / build");
  });

  describe("required status checks による下限（ADR 0215）", () => {
    it("required が全部在って全部 success なら green", () => {
      const checkRuns = [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "success" },
        { name: "c-not-required", status: "completed", conclusion: "success" },
      ];
      const result = verdict(checkRuns, ["a", "b"]);
      expect(result.status).toBe("green");
      expect(result.required).toEqual({
        contexts: ["a", "b"],
        missing: [],
        pending: [],
        nonSuccess: [],
      });
    });

    it("部分登録の窓の再現: required 6件のうち1件が未登録で残り5件は completed+success でも green にしない（pending）", () => {
      const requiredContexts = ["job1", "job2", "job3", "job4", "job5", "postgres-regime-coverage"];
      const checkRuns = [
        { name: "job1", status: "completed", conclusion: "success" },
        { name: "job2", status: "completed", conclusion: "success" },
        { name: "job3", status: "completed", conclusion: "success" },
        { name: "job4", status: "completed", conclusion: "success" },
        { name: "job5", status: "completed", conclusion: "success" },
        // postgres-regime-coverage はまだ登録されていない（needs: postgres の依存元待ち）
      ];
      const result = verdict(checkRuns, requiredContexts);
      expect(result.status).toBe("pending");
      expect(result.reason).toContain("postgres-regime-coverage");
      expect(result.reason).toContain("集合が不完全");
      expect(result.required.missing).toEqual(["postgres-regime-coverage"]);
    });

    it("required は全部在るが1件が in_progress なら pending", () => {
      const checkRuns = [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "in_progress", conclusion: null },
      ];
      const result = verdict(checkRuns, ["a", "b"]);
      expect(result.status).toBe("pending");
    });

    it("required の1件が failure なら red、reason にその名前が出る", () => {
      const checkRuns = [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "failure" },
      ];
      const result = verdict(checkRuns, ["a", "b"]);
      expect(result.status).toBe("red");
      expect(result.reason).toContain("b");
      expect(result.required.nonSuccess).toEqual([{ name: "b", conclusion: "failure" }]);
    });

    it("required 以外の1件が failure（required は全部 success）なら red", () => {
      const checkRuns = [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "success" },
        { name: "not-required", status: "completed", conclusion: "failure" },
      ];
      const result = verdict(checkRuns, ["a", "b"]);
      expect(result.status).toBe("red");
      expect(result.required.nonSuccess).toEqual([]);
    });

    it("requiredContexts が null なら pending（下限を取得できていない）", () => {
      const checkRuns = [{ name: "a", status: "completed", conclusion: "success" }];
      const result = verdict(checkRuns, null);
      expect(result.status).toBe("pending");
      expect(result.reason).toContain("ADR 0215");
    });

    it("requiredContexts が undefined（省略）なら pending", () => {
      const checkRuns = [{ name: "a", status: "completed", conclusion: "success" }];
      const result = verdict(checkRuns, undefined);
      expect(result.status).toBe("pending");
    });

    it("requiredContexts が空配列なら pending（下限が取れない）", () => {
      const checkRuns = [{ name: "a", status: "completed", conclusion: "success" }];
      const result = verdict(checkRuns, []);
      expect(result.status).toBe("pending");
      expect(result.reason).toContain("必須チェックが0件");
    });
  });
});

describe("summarizeRequiredContexts", () => {
  it("required がすべて揃って success なら missing/pending/nonSuccess は空", () => {
    const result = summarizeRequiredContexts(
      [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "success" },
      ],
      ["a", "b"],
    );
    expect(result).toEqual({ missing: [], pending: [], nonSuccess: [] });
  });

  it("checkRuns に存在しない required 名は missing に入る", () => {
    const result = summarizeRequiredContexts(
      [{ name: "a", status: "completed", conclusion: "success" }],
      ["a", "b"],
    );
    expect(result.missing).toEqual(["b"]);
  });

  it("同名の check-run が複数在るとき、全部が completed かつ success でなければ満たしたとみなさない", () => {
    // 再実行のような状況: 同名 "a" の1回目が failure、2回目（再実行）が success。
    const result = summarizeRequiredContexts(
      [
        { name: "a", status: "completed", conclusion: "failure" },
        { name: "a", status: "completed", conclusion: "success" },
      ],
      ["a"],
    );
    // 「同名の全部が success」でなければ満たされたとみなさない仕様——1回目の failure が
    // nonSuccess に残る（missing には入らない。名前自体は存在するため）。
    expect(result.missing).toEqual([]);
    expect(result.nonSuccess).toEqual([{ name: "a", conclusion: "failure" }]);
  });

  it("同名の check-run が複数在り、1件でも completed でなければ pending に入る（success/failure が既に在っても）", () => {
    const result = summarizeRequiredContexts(
      [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "a", status: "in_progress", conclusion: null },
      ],
      ["a"],
    );
    expect(result.pending).toEqual(["a"]);
    expect(result.nonSuccess).toEqual([]);
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

describe("formatMatchHeadCommitHint（Issue #294: 緑は sha に紐づく、を貼れるコマンドにする）", () => {
  it("PR 番号とフル sha を、そのまま実行できる gh pr merge コマンドへ埋め込む", () => {
    const result = formatMatchHeadCommitHint(365, "309303ab4ee5d0a07f7a094782cd80b6a7840dbe");
    expect(result).toContain("sha 309303a");
    expect(result).toContain(
      "gh pr merge 365 --squash --delete-branch --match-head-commit 309303ab4ee5d0a07f7a094782cd80b6a7840dbe",
    );
  });

  it("フル sha をそのまま渡す（短縮しない）——match-head-commit に短縮 sha を渡すと不一致になりうる", () => {
    const fullSha = "abcdef0123456789abcdef0123456789abcdef01";
    const result = formatMatchHeadCommitHint("42", fullSha);
    expect(result).toContain(`--match-head-commit ${fullSha}`);
    expect(result).not.toContain(`--match-head-commit ${fullSha.slice(0, 7)} `);
  });
});
