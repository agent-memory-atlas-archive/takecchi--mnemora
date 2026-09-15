import { describe, expect, it } from "vitest";
import { isMain } from "../adr-index-freshness-branch-lib.mjs";

/**
 * 「いま main にいるか」の判定（ADR 0137）。実際の環境変数・git は読まない
 * ——配線側は `adr-index-freshness.test.mjs` を見ること。
 */

describe("isMain", () => {
  it("GITHUB_REF が refs/heads/main なら true", () => {
    expect(isMain({ githubRef: "refs/heads/main" })).toBe(true);
  });

  it("GITHUB_REF が pull_request 由来（refs/pull/N/merge）なら false", () => {
    expect(isMain({ githubRef: "refs/pull/135/merge" })).toBe(false);
  });

  it("GITHUB_REF が別ブランチなら false", () => {
    expect(isMain({ githubRef: "refs/heads/fix/230-adr-index" })).toBe(false);
  });

  it("GITHUB_REF が無ければ git のブランチ名で判定する", () => {
    expect(isMain({ gitBranch: "main" })).toBe(true);
    expect(isMain({ gitBranch: "fix/230-adr-index" })).toBe(false);
  });

  it("GITHUB_REF が在れば git のブランチ名より優先する", () => {
    // detached HEAD 等で git 側が "HEAD" を返しても、CI の GITHUB_REF を信じる。
    expect(isMain({ githubRef: "refs/heads/main", gitBranch: "HEAD" })).toBe(true);
  });

  it("forceOverride が真なら常に true（検証・手元確認専用）", () => {
    expect(isMain({ githubRef: "refs/pull/1/merge", forceOverride: true })).toBe(true);
    expect(isMain({ forceOverride: true })).toBe(true);
  });

  it("何も無ければ false（安全側＝スキップ側に倒れる）", () => {
    expect(isMain({})).toBe(false);
  });
});
