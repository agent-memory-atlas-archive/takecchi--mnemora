/**
 * `scripts/ci-green-check.mjs`（CI が緑かどうかを判定する CLI）の純関数の側。
 * ファイル I/O・`gh` の起動・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/adr-index-completeness-lib.mjs` と同じ分担・同じ理由。
 *
 * ここでの「check run」は GitHub の Checks API
 * （`GET /repos/{owner}/{repo}/commits/{ref}/check-runs` の `check_runs[]`）の要素で、
 * 各要素は「1つの workflow run の中の1つの job」に対応する（Issue #228）。
 * **「run」（`GET /repos/{owner}/{repo}/actions/runs/{run_id}`）の `conclusion` はここでは
 * 一切扱わない**——run 全体の conclusion と、その中の1 job の conclusion は別物であり
 * （Issue #228 観測2、run `34909106996` は run 全体が `failure` でも `archive-sweep-cost`
 * ジョブは `success` だった）、両者を混同しないことがこのファイルの前提そのものである。
 */

/**
 * check run の配列から、判定に要る形だけを取り出して要約する。
 *
 * @param {{ name: string, status: string, conclusion: string | null }[]} checkRuns
 */
export function summarizeCheckRuns(checkRuns) {
  const total = checkRuns.length;
  const pending = checkRuns.filter((r) => r.status !== "completed").map((r) => r.name);
  const nonSuccess = checkRuns
    .filter((r) => r.status === "completed" && r.conclusion !== "success")
    .map((r) => ({ name: r.name, conclusion: r.conclusion }));
  const allCompleted = pending.length === 0;
  const allSuccess = allCompleted && nonSuccess.length === 0;
  return { total, pending, nonSuccess, allCompleted, allSuccess };
}

/**
 * 「CI が緑か」を1つの判定に落とす。
 *
 * - `total === 0` は `pending` として扱う（まだ check-runs が1件も登録されていない可能性が
 *   あり、Issue #228 観測1 が示す通り「登録されていない ⟹ まだ緑ではない」——0件を
 *   「対象が無いから緑」と読まない）。
 * - **`skipped`/`neutral`/`cancelled`/`timed_out`/`action_required` はどれも `success` では
 *   ないので `red` 側に入る**（issue が名指しした「`skipped` は緑ではない」の一般化）。
 *
 * @param {{ name: string, status: string, conclusion: string | null }[]} checkRuns
 * @returns {{ status: "pending" | "red" | "green", reason: string, summary: ReturnType<typeof summarizeCheckRuns> }}
 */
export function verdict(checkRuns) {
  const summary = summarizeCheckRuns(checkRuns);
  if (summary.total === 0) {
    return {
      status: "pending",
      reason: "check-runs が0件——まだ登録されていない可能性がある（Issue #228 観測1）",
      summary,
    };
  }
  if (!summary.allCompleted) {
    return {
      status: "pending",
      reason: `${summary.pending.length}件が completed でない: ${summary.pending.join(", ")}`,
      summary,
    };
  }
  if (!summary.allSuccess) {
    return {
      status: "red",
      reason: `${summary.nonSuccess.length}件が success でない: ${JSON.stringify(summary.nonSuccess)}`,
      summary,
    };
  }
  return { status: "green", reason: `${summary.total}件すべてが completed かつ success`, summary };
}

/**
 * 2回のポーリングで拾った check run の名前集合を比べる。
 *
 * Issue #228 観測1（同じ sha の check-runs が時間とともに増える）への対策として、
 * 「今回の集合が前回と同じか」を機械的に見る。**これは「もう増えない」ことの証明では
 * ない**——`stable: true` は「少なくともこの2回の間には増減が無かった」だけを意味する
 * （ADR 本文「確かめていないこと」参照）。
 *
 * @param {{ name: string }[]} prevCheckRuns
 * @param {{ name: string }[]} currCheckRuns
 */
export function compareCheckRunNameSets(prevCheckRuns, currCheckRuns) {
  const prevNames = new Set(prevCheckRuns.map((r) => r.name));
  const currNames = new Set(currCheckRuns.map((r) => r.name));
  const added = [...currNames].filter((n) => !prevNames.has(n));
  const removed = [...prevNames].filter((n) => !currNames.has(n));
  return { stable: added.length === 0 && removed.length === 0, added, removed };
}

/**
 * 「CI が緑」は sha に紐づく事実であって、PR に紐づく事実ではない（Issue #294）。
 * 緑と判定した直後に1コミットでも push すると、その確認は無効になる。
 *
 * この関数は、green と判定された sha を**そのまま貼れるマージコマンド**にする。
 * `gh pr merge --match-head-commit <sha>` は、実行時の PR head が渡した sha と
 * 一致しないと失敗する（`gh pr merge --help` で存在を確認済み。挙動そのものは
 * この関数の呼び出し側であるCLIの docstring・ADR の「確かめたこと」を参照）。
 * ⟹ **「緑を見た sha」と「実際にマージされる sha」が一致することを、
 * 道具（`gh`）自身に強制させる**——「引き直せ」という文書の指示だけに頼らない。
 *
 * @param {string|number} prNumber
 * @param {string} sha フルの40桁 sha（省略しない。`--match-head-commit` にはフルを渡す）
 * @returns {string} 判定した sha を明示した上で、そのまま実行できる `gh pr merge` コマンドを含む文字列
 */
export function formatMatchHeadCommitHint(prNumber, sha) {
  const shortSha = sha.slice(0, 7);
  return (
    `この判定は sha ${shortSha} に対するものである。この sha 以外をマージしないこと:\n` +
    `  gh pr merge ${prNumber} --squash --delete-branch --match-head-commit ${sha}`
  );
}
