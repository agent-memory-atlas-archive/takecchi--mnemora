import { describe, expect, it } from "vitest";
import {
  isPullRequestMergeRef,
  shouldEnforceAdrIndexFreshness,
} from "../adr-index-freshness-branch-lib.mjs";

/**
 * 「いまの文脈で ADR 索引の鮮度検査を有効にするか」の判定（ADR 0137 / ADR 0192）。
 * 実際の環境変数・git は読まない——配線側は `adr-index-freshness.test.mjs` を見ること。
 */

describe("shouldEnforceAdrIndexFreshness", () => {
  it("GITHUB_REF が refs/heads/main なら true（push イベント、ADR 0137 から）", () => {
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "refs/heads/main" })).toBe(true);
  });

  it("GITHUB_REF が pull_request 由来（refs/pull/N/merge）なら true（ADR 0192 で拡張）", () => {
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "refs/pull/135/merge" })).toBe(true);
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "refs/pull/1/merge" })).toBe(true);
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "refs/pull/99999/merge" })).toBe(true);
  });

  it("GITHUB_REF が pull_request の head 参照（refs/pull/N/head）なら false（マージプレビューではない）", () => {
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "refs/pull/135/head" })).toBe(false);
  });

  it("GITHUB_REF が main でも pull_request でもない別ブランチなら false", () => {
    expect(shouldEnforceAdrIndexFreshness({ githubRef: "refs/heads/fix/230-adr-index" })).toBe(
      false,
    );
  });

  it("GITHUB_REF が無ければ git のブランチ名で判定する（手元は main 限定のまま、ADR 0137）", () => {
    expect(shouldEnforceAdrIndexFreshness({ gitBranch: "main" })).toBe(true);
    expect(shouldEnforceAdrIndexFreshness({ gitBranch: "fix/230-adr-index" })).toBe(false);
  });

  it("GITHUB_REF が在れば git のブランチ名より優先する", () => {
    // detached HEAD 等で git 側が "HEAD" を返しても、CI の GITHUB_REF を信じる。
    expect(
      shouldEnforceAdrIndexFreshness({ githubRef: "refs/heads/main", gitBranch: "HEAD" }),
    ).toBe(true);
  });

  it("forceOverride が真なら常に true（検証・手元確認専用）", () => {
    expect(
      shouldEnforceAdrIndexFreshness({ githubRef: "refs/heads/fix/x", forceOverride: true }),
    ).toBe(true);
    expect(shouldEnforceAdrIndexFreshness({ forceOverride: true })).toBe(true);
  });

  it("何も無ければ false（安全側＝スキップ側に倒れる）", () => {
    expect(shouldEnforceAdrIndexFreshness({})).toBe(false);
  });
});

describe("isPullRequestMergeRef", () => {
  it("refs/pull/<n>/merge の形なら true", () => {
    expect(isPullRequestMergeRef("refs/pull/135/merge")).toBe(true);
  });

  it("refs/pull/<n>/head（PR の head そのもの）は false", () => {
    expect(isPullRequestMergeRef("refs/pull/135/head")).toBe(false);
  });

  it("refs/heads/main は false", () => {
    expect(isPullRequestMergeRef("refs/heads/main")).toBe(false);
  });

  it("undefined / 空文字は false", () => {
    expect(isPullRequestMergeRef(undefined)).toBe(false);
    expect(isPullRequestMergeRef("")).toBe(false);
  });
});
