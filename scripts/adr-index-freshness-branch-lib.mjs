/**
 * 「いま `main` にいるか」を判定する純関数（ADR 0137）。
 *
 * ADR 索引の鮮度検査（`scripts/__tests__/adr-index-freshness.test.mjs`）は、
 * **`main` に限って**赤くなってよい。ADR を足す PR のブランチでは、
 * この生成物（`docs/decisions/README.md`）を意図的に触らない設計にした
 * （`scripts/generate-adr-index-lib.mjs` の説明を見ること）ため、
 * そのブランチ上では「まだ索引に載っていない」ことが常に起こる——それを
 * 毎回 CI で赤くすると、PR を出すたびに索引を書き換えることを強制し、
 * 結局もとの「末尾追記の衝突」に逆戻りする（ADR 0137「決定」参照）。
 *
 * ⚠ `main` に限ってもなお、この歯は routine では鳴らない設計になっている
 * ——索引の再生成は「マージ直前の PR ブランチ上」でマージする側が行うため、
 * `main` へ着地する squash コミットは最初から索引が最新である（ADR 0137
 * 「決定」2番）。`main` 上でこの歯が赤くなるのは、その手順を飛ばしたときだけ。
 *
 * 判定はテスト容易性のため、環境を直接読む部分（`detectIsMainNow`）と
 * 純粋なロジック（`isMain`）に分けてある。
 */

/**
 * @param {{ githubRef?: string, gitBranch?: string, forceOverride?: boolean }} input
 * @returns {boolean}
 */
export function isMain({ githubRef, gitBranch, forceOverride = false }) {
  if (forceOverride) return true;
  // GitHub Actions は push イベントで GITHUB_REF を `refs/heads/<branch>` にする。
  // pull_request イベントでは `refs/pull/<n>/merge` になるので、
  // どちらの場合も GITHUB_REF が在ればそれを信じ、git のブランチ名は見ない
  // （CI の中で `git rev-parse --abbrev-ref HEAD` は "HEAD"（detached）を返すことがあり、
  // 誤って安全側に倒れてしまう）。
  if (typeof githubRef === "string" && githubRef.length > 0) {
    return githubRef === "refs/heads/main";
  }
  return gitBranch === "main";
}
