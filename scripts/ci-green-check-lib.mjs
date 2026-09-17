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
 * 期待する集合（branch protection の required status checks）に対して、
 * check-runs が何を満たしていないかを返す。
 *
 * ⚠ **同じ名前の check-run が複数在りうる**（再実行など）。その場合は厳しい側に倒す
 * ——同名の中に1件でも `completed` でないものが在れば `pending` に、全件 `completed`
 * でも1件でも `conclusion !== "success"` があれば `nonSuccess` に入れる。つまり
 * 「同名の全部が completed かつ success」でなければ、その名前は満たされたとみなさない
 * （「たまたま最後の1件だけ見て success だった」という取り違えを避けるため）。
 *
 * @param {{name:string,status:string,conclusion:string|null}[]} checkRuns
 * @param {string[]} requiredContexts
 * @returns {{ missing: string[], pending: string[], nonSuccess: {name:string,conclusion:string|null}[] }}
 */
export function summarizeRequiredContexts(checkRuns, requiredContexts) {
  const byName = new Map();
  for (const run of checkRuns) {
    if (!byName.has(run.name)) byName.set(run.name, []);
    byName.get(run.name).push(run);
  }

  const missing = [];
  const pending = [];
  const nonSuccess = [];

  for (const name of requiredContexts) {
    const runs = byName.get(name);
    if (!runs || runs.length === 0) {
      missing.push(name);
      continue;
    }
    const incomplete = runs.filter((r) => r.status !== "completed");
    if (incomplete.length > 0) {
      pending.push(name);
      continue;
    }
    const failed = runs.filter((r) => r.conclusion !== "success");
    if (failed.length > 0) {
      // 同名が複数在り、その中の失敗した実行を名指しする（最後の1件だけを見ない）。
      for (const r of failed) nonSuccess.push({ name: r.name, conclusion: r.conclusion });
    }
  }

  return { missing, pending, nonSuccess };
}

/**
 * 「CI が緑か」を1つの判定に落とす。
 *
 * - `total === 0` は `pending` として扱う（まだ check-runs が1件も登録されていない可能性が
 *   あり、Issue #228 観測1 が示す通り「登録されていない ⟹ まだ緑ではない」——0件を
 *   「対象が無いから緑」と読まない）。
 * - **`skipped`/`neutral`/`cancelled`/`timed_out`/`action_required` はどれも `success` では
 *   ないので `red` 側に入る**（issue が名指しした「`skipped` は緑ではない」の一般化）。
 * - **下限は branch protection の required status checks に縛る（ADR 0215）。**
 *   `total` が本来の本数より少ない状態でも、登録済みが全部 success なら旧実装は `green`
 *   を返してしまっていた——`postgres-regime-coverage` のように `needs:` を持つ job は
 *   依存元が終わるまで check-run 自体が存在しないため、push 直後の窓では「まだ登録
 *   されていない一部を除いて全部 success」という状態が実際に起きる（直近 main 30本中
 *   7本で観測）。`requiredContexts` を渡すことで、その集合が揃っているかを独立に
 *   検査し、揃っていなければ `green` を返さない。
 *
 * @param {{ name: string, status: string, conclusion: string | null }[]} checkRuns
 * @param {string[] | null | undefined} requiredContexts branch protection の
 *   required status checks の名前集合。**省略できない**——省略可能にすると
 *   「取得できなかったから従来どおり」で下限が静かに無効化されるため、呼び出し側は
 *   常に明示的に `null`（取得不能）または実際の配列を渡す。
 * @returns {{ status: "pending" | "red" | "green", reason: string, summary: ReturnType<typeof summarizeCheckRuns>, required: { contexts: string[] | null, missing: string[], pending: string[], nonSuccess: {name:string,conclusion:string|null}[] } }}
 */
export function verdict(checkRuns, requiredContexts) {
  const summary = summarizeCheckRuns(checkRuns);

  if (!Array.isArray(requiredContexts)) {
    return {
      status: "pending",
      reason: "必須チェックの集合を取得できていない——下限が無いので判定しない（ADR 0215）",
      summary,
      required: { contexts: null, missing: [], pending: [], nonSuccess: [] },
    };
  }
  if (requiredContexts.length === 0) {
    return {
      status: "pending",
      reason: "必須チェックが0件——下限が取れないので判定しない（ADR 0215）",
      summary,
      required: { contexts: requiredContexts, missing: [], pending: [], nonSuccess: [] },
    };
  }

  const requiredSummary = summarizeRequiredContexts(checkRuns, requiredContexts);
  const required = { contexts: requiredContexts, ...requiredSummary };

  if (summary.total === 0) {
    return {
      status: "pending",
      reason: "check-runs が0件——まだ登録されていない可能性がある（Issue #228 観測1）",
      summary,
      required,
    };
  }
  if (requiredSummary.missing.length > 0) {
    let reason =
      `必須チェック${requiredContexts.length}件のうち${requiredSummary.missing.length}件が` +
      `まだ登録されていない（集合が不完全）: ${requiredSummary.missing.join(", ")}`;
    if (requiredSummary.pending.length > 0) {
      reason += `（登録済みの必須チェックの中にも走っている最中のものが在る: ${requiredSummary.pending.join(", ")}）`;
    }
    return { status: "pending", reason, summary, required };
  }
  if (!summary.allCompleted) {
    return {
      status: "pending",
      reason: `${summary.pending.length}件が completed でない: ${summary.pending.join(", ")}`,
      summary,
      required,
    };
  }
  if (requiredSummary.nonSuccess.length > 0) {
    return {
      status: "red",
      reason:
        `必須チェックのうち${requiredSummary.nonSuccess.length}件が success でない: ` +
        `${JSON.stringify(requiredSummary.nonSuccess)}`,
      summary,
      required,
    };
  }
  if (!summary.allSuccess) {
    return {
      status: "red",
      reason: `${summary.nonSuccess.length}件が success でない: ${JSON.stringify(summary.nonSuccess)}`,
      summary,
      required,
    };
  }
  return {
    status: "green",
    reason: `${summary.total}件すべてが completed かつ success`,
    summary,
    required,
  };
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
