/**
 * ADR 索引の鮮度検査（`scripts/__tests__/adr-index-freshness.test.mjs`）を
 * **いまの文脈で有効にするか**を判定する純関数（ADR 0137 / ADR 0192）。
 *
 * ## 名前が `isMain` から変わった理由（ADR 0192）
 *
 * ADR 0137 時点では「`main` かどうか」と「この歯を有効にするか」が同じ問いだった
 * ——だから関数名は `isMain` でよかった。ADR 0192 で「CI の `pull_request` でも
 * 有効にする」を足した結果、両者はもう同じ問いではない。**`pull_request` の CI は
 * `main` ブランチではない**（GitHub は `GITHUB_REF` を `refs/pull/<n>/merge` にする）
 * が、この歯は有効にしたい。`isMain` という名前のままこの分岐を足すと、
 * 「main ではないのに true を返す」という、名前と中身が食い違う関数になる。
 * ⟹ 「この文脈で鮮度を強制するか」を素直に読める名前へ変えた。
 *
 * ## 判定基準（ADR 0192 で拡張）
 *
 * 1. **手元（`GITHUB_REF` が無い）は、常に `git のブランチ名 === "main"` で判定する。**
 *    ADR 0137 の設計をそのまま保つ——ADR PR の作成者の手元では、この歯は
 *    鳴らない（`docs/decisions/README.md` を意図的に触らない設計そのものと
 *    矛盾しないため）。
 * 2. **CI の `push`（`GITHUB_REF === "refs/heads/main"`）は、従来どおり有効。**
 * 3. **CI の `pull_request`（`GITHUB_REF` が `refs/pull/<n>/merge` の形）も、
 *    ADR 0192 から有効にする。** 理由: `.github/workflows/ci.yml` の
 *    `actions/checkout@v6` は `ref:` を指定しておらず、`pull_request` イベントでは
 *    GitHub が計算したマージプレビュー（`refs/pull/<n>/merge` — 実測では
 *    `git checkout refs/remotes/pull/<n>/merge` で、ログに
 *    `HEAD is now at <sha> Merge <head> into <base>` と出る）を checkout する。
 *    ⟹ `pull_request` の CI は、**マージ後の `main` がどうなるかを、マージする前に
 *    測れる位置に既にいる。** ここでこの歯を有効にすると、ADR 0137 が
 *    「マージ直前に PR ブランチ上で索引を再生成する」と定めた手順が
 *    **実際に踏まれたかどうかを、注意力ではなく機構（CI の required status check）
 *    で確かめられる**——`typecheck / lint / test / build` は branch protection の
 *    required status check であり（`enforce_admins: true`）、赤なら GitHub が
 *    マージを拒む。詳しい経緯・引き受けた負債は ADR 0192。
 *
 * `forceOverride` は手元での変異試験専用（`ADR_INDEX_FRESHNESS_FORCE=1`）。
 * 判定はテスト容易性のため、環境を直接読む部分（呼び出し側、
 * `adr-index-freshness.test.mjs`）と純粋なロジック（この関数）に分けてある。
 */

/** `GITHUB_REF` が `pull_request` イベント由来のマージプレビュー参照かどうか。 */
const PULL_REQUEST_MERGE_REF_RE = /^refs\/pull\/\d+\/merge$/;

/**
 * @param {string} githubRef
 * @returns {boolean}
 */
export function isPullRequestMergeRef(githubRef) {
  return typeof githubRef === "string" && PULL_REQUEST_MERGE_REF_RE.test(githubRef);
}

/**
 * 「いまの文脈で ADR 索引の鮮度検査を有効にするか」を判定する。
 *
 * @param {{ githubRef?: string, gitBranch?: string, forceOverride?: boolean }} input
 * @returns {boolean}
 */
export function shouldEnforceAdrIndexFreshness({ githubRef, gitBranch, forceOverride = false }) {
  if (forceOverride) return true;
  // GitHub Actions は push イベントで GITHUB_REF を `refs/heads/<branch>` に、
  // pull_request イベントでは `refs/pull/<n>/merge` にする。どちらの場合も
  // GITHUB_REF が在ればそれを信じ、git のブランチ名は見ない
  // （CI の中で `git rev-parse --abbrev-ref HEAD` は "HEAD"（detached）を返すことがあり、
  // 誤って安全側に倒れてしまう）。
  if (typeof githubRef === "string" && githubRef.length > 0) {
    return githubRef === "refs/heads/main" || isPullRequestMergeRef(githubRef);
  }
  return gitBranch === "main";
}
