#!/usr/bin/env node
/**
 * 「CI が緑か」を、Issue #228 が観測した4つの外れ方を踏まないやり方で判定する CLI。
 *
 * **踏まないやり方**（詳細は `docs/autonomy.md` §2.1・`docs/decisions/0132-*.md`）:
 *
 * 1. **PR 番号ではなく head sha を明示して引く。** `--pr` を渡された場合も、
 *    まず `gh pr view` で `headRefOid` を取り、以降はその sha だけを使う
 *    ——push されると head は動く。
 * 2. **check-runs（job 単位）だけを見る。** `gh api .../actions/runs/<id>` の
 *    run 全体の `conclusion` は一度も呼ばない（Issue #228 観測2）。
 * 3. **`mergeStateStatus` は一度も判定に使わない**（Issue #228 観測3）。
 *    `--pr` 実行時に参考情報として出力はするが、ラベルに「判定には使っていない」と
 *    明記する。
 * 4. **`--recheck-after` を渡すと、間隔を空けて2回引き直し、check run の名前集合が
 *    増減していないかを見る**（Issue #228 観測1 への対策）。
 *    ⚠ これは「もう増えない」ことの証明ではない——2回とも同じだった、という
 *    それ以上でもそれ以下でもない事実を返すだけである（`compareCheckRunNameSets` の
 *    docstring 参照）。
 * 5. **「CI が緑」は sha に紐づく事実であり、PR に紐づく事実ではない**（Issue #294）。
 *    緑と判定した後に1コミットでも push すると、その確認は無効になる。
 *    `--pr` を渡し、判定が green のとき、**判定した sha を `--match-head-commit` に
 *    埋め込んだ `gh pr merge` コマンドをそのまま印字する**——文書で「引き直せ」と
 *    書くだけでなく、道具（`gh`）自身に「見た sha と違う sha はマージさせない」を
 *    強制させる。
 *
 * **このツールが判定しないこと**: 手元の6つの門（typecheck/lint/format:check/test/
 * build/pack:check）の結果。手元の緑は CI の緑を予測しない（`docs/autonomy.md` §4）
 * ——このツールは常に `gh` 経由で CI 自身に聞く。
 *
 * ## 使い方
 *
 * ```
 * node scripts/ci-green-check.mjs --pr 132
 * node scripts/ci-green-check.mjs --sha <sha> --repo takecchi/mnemora
 * node scripts/ci-green-check.mjs --pr 132 --recheck-after 30
 * node scripts/ci-green-check.mjs --pr 132 --json
 * ```
 *
 * 終了コード: `0` = green（`--recheck-after` 付きなら green かつ stable）、
 * `1` = red、`2` = pending（まだ判定できない）、`3` = 実行時エラー（`gh` 呼び出し失敗等）。
 *
 * ## ADR 索引の鮮度への相乗り（ADR 0192）
 *
 * `--pr` 実行で赤判定が出たとき、**このディレクトリ（＝呼び出し側が現在チェック
 * アウトしている作業木）の `docs/decisions/README.md` が `docs/decisions/*.md` と
 * 一致しているか**を追加でその場で見る。ADR 0137「決定」2番の手順
 * （PR ブランチをローカルへ取得 → `git merge origin/main` → 索引を再生成 →
 * commit → push → **このツールで緑を確認**）を踏む人は、このツールを走らせる
 * 時点で該当 PR ブランチを手元に持っている——赤の原因が索引の陳腐化なら、
 * 同じ場所で気づけたほうが、CI のログを開き直す一往復を省ける。
 * ⚠ **これは CI 自身の判定を置き換えない。**あくまで「赤かどうか」は
 * 従来どおり `gh` 経由で CI に聞く。ローカルの索引が新鮮に見えても、
 * それだけでは「CI も緑になる」とは言えない（コミットし忘れ・push し忘れの
 * 余地が残る）——あくまで診断のヒントである。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareCheckRunNameSets,
  formatMatchHeadCommitHint,
  verdict,
} from "./ci-green-check-lib.mjs";
import {
  buildAdrEntries,
  buildIndexTable,
  extractGeneratedIndex,
} from "./generate-adr-index-lib.mjs";

function parseArgs(argv) {
  const args = { recheckAfter: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") args.pr = argv[++i];
    else if (a === "--sha") args.sha = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--recheck-after") args.recheckAfter = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${cmdArgs.join(" ")} が失敗した (exit ${result.status}): ${result.stderr}`,
    );
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return explicitRepo;
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
}

/** @returns {{ sha: string, isDraft: boolean, mergeStateStatus: string } | { sha: string }} */
function resolvePrHead(repo, prNumber) {
  const out = run("gh", [
    "pr",
    "view",
    prNumber,
    "--repo",
    repo,
    "--json",
    "headRefOid,isDraft,mergeStateStatus",
  ]);
  const parsed = JSON.parse(out);
  return {
    sha: parsed.headRefOid,
    isDraft: parsed.isDraft,
    mergeStateStatus: parsed.mergeStateStatus,
  };
}

function fetchCheckRuns(repo, sha) {
  const out = run("gh", [
    "api",
    `repos/${repo}/commits/${sha}/check-runs`,
    "--paginate",
    "-q",
    ".check_runs[] | {name, status, conclusion} | @json",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * 呼び出し側の作業木（`import.meta.url` から見た repo ルート）の
 * `docs/decisions/README.md` が `docs/decisions/*.md` と一致しているかを見る
 * （ADR 0192）。読めない・生成に失敗する等は `null`（判定不能）にして
 * 諦める——このツールの主目的（CI の緑判定）を道連れにしない。
 *
 * @returns {boolean | null} true=陳腐化している / false=最新 / null=判定できなかった
 */
function isAdrIndexStaleLocally() {
  try {
    const decisionsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "decisions");
    const filenames = readdirSync(decisionsDir).filter((f) => f !== "README.md");
    const files = filenames.map((filename) => ({
      filename,
      content: readFileSync(join(decisionsDir, filename), "utf8"),
    }));
    const entries = buildAdrEntries(files);
    const expectedTable = buildIndexTable(entries);
    const readmeText = readFileSync(join(decisionsDir, "README.md"), "utf8");
    const actualTable = extractGeneratedIndex(readmeText);
    return expectedTable !== actualTable;
  } catch {
    return null;
  }
}

function printAdrIndexFreshnessHintIfStale() {
  const stale = isAdrIndexStaleLocally();
  if (stale !== true) return;
  console.log(
    "⚠ この作業木の docs/decisions/README.md は docs/decisions/*.md と一致していない" +
      "（ADR 0192）。赤の原因がこれなら、次を実行してからコミット・push し、判定を引き直すこと:\n" +
      "  node scripts/generate-adr-index.mjs\n" +
      "  git add docs/decisions/README.md\n" +
      '  git commit -m "docs(adr-index): regenerate before merging"\n' +
      "  git push\n" +
      "  （手順は ADR 0137「決定」2番。CI の pull_request でも検査する理由は ADR 0192）",
  );
}

function printVerdict(label, v) {
  console.log(`[${label}] status=${v.status} — ${v.reason}`);
  if (v.summary.pending.length > 0) {
    console.log(`  pending: ${v.summary.pending.join(", ")}`);
  }
  if (v.summary.nonSuccess.length > 0) {
    console.log(`  non-success: ${JSON.stringify(v.summary.nonSuccess)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr && !args.sha) {
    console.error(
      "使い方: node scripts/ci-green-check.mjs --pr <number> | --sha <sha> [--repo owner/repo] [--recheck-after <seconds>] [--json]",
    );
    process.exit(3);
  }

  let repo;
  let sha;
  let prMeta = null;
  try {
    repo = resolveRepo(args.repo);
    if (args.pr) {
      prMeta = resolvePrHead(repo, args.pr);
      sha = prMeta.sha;
    } else {
      sha = args.sha;
    }
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(3);
    return;
  }

  if (prMeta) {
    console.log(
      `PR #${args.pr} の head sha: ${sha}（参考・判定には使わない: isDraft=${prMeta.isDraft}, mergeStateStatus=${prMeta.mergeStateStatus}）`,
    );
  } else {
    console.log(`sha: ${sha}`);
  }

  let checkRuns1;
  try {
    checkRuns1 = fetchCheckRuns(repo, sha);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(3);
    return;
  }
  const v1 = verdict(checkRuns1);
  printVerdict("1st poll", v1);

  let finalVerdict = v1;
  let stability = null;

  if (args.recheckAfter != null && v1.status !== "pending") {
    console.log(
      `${args.recheckAfter}秒待ってから引き直す（Issue #228 観測1 の対策。証明ではなく再確認）…`,
    );
    const waitSeconds = Math.max(0, args.recheckAfter);
    // 同期的に待つ（`setTimeout` だと CLI 全体を async にする必要があり、他の関数の
    // 同期的な呼び出し方と揃わない）。`sleep` は CI ランナー（Linux）に常在する。
    spawnSync("sleep", [String(waitSeconds)]);

    let shaNow;
    try {
      shaNow = args.pr ? resolvePrHead(repo, args.pr).sha : sha;
    } catch (err) {
      console.error(String(err.message ?? err));
      process.exit(3);
      return;
    }
    if (shaNow !== sha) {
      console.log(
        `⚠ 2回目の poll までに head sha が変わった（${sha} → ${shaNow}）。新しい push が在ったということであり、` +
          `1回目の判定は古い commit のものになる。名前集合の比較はしない——sha が違う対象を比べても意味が無い。`,
      );
      finalVerdict = {
        ...v1,
        status: "pending",
        reason: `head sha が変わった（${sha} → ${shaNow}）ため再判定が必要`,
      };
    } else {
      let checkRuns2;
      try {
        checkRuns2 = fetchCheckRuns(repo, shaNow);
      } catch (err) {
        console.error(String(err.message ?? err));
        process.exit(3);
        return;
      }
      const v2 = verdict(checkRuns2);
      printVerdict("2nd poll", v2);
      stability = compareCheckRunNameSets(checkRuns1, checkRuns2);
      if (!stability.stable) {
        console.log(
          `⚠ check run の名前集合が変わった（追加: ${JSON.stringify(stability.added)}, ` +
            `消失: ${JSON.stringify(stability.removed)}）。Issue #228 観測1 のとおり、` +
            `本数はまだ変わりうる。`,
        );
      } else {
        console.log(
          "check run の名前集合は2回とも同じだった（stable=true。増えないことの証明ではない）。",
        );
      }
      if (v2.status === "green" && !stability.stable) {
        // 2回目は green でも、名前集合が動いたなら「まだ増えるかもしれない」——
        // green と報告して安心させない。pending に落とす。
        finalVerdict = {
          ...v2,
          status: "pending",
          reason: `${v2.reason}（ただし名前集合が不安定 stable=false）`,
        };
      } else {
        finalVerdict = v2;
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ repo, sha, verdict: finalVerdict, stability }, null, 2));
  }

  if (finalVerdict.status === "red") {
    // ADR 0192: 赤の原因が「索引の陳腐化」なら、CI のログを開き直す一往復を省く。
    // ⚠ CI の判定を置き換えるものではない——あくまで診断のヒントである。
    printAdrIndexFreshnessHintIfStale();
  }

  if (finalVerdict.status === "green" && args.pr) {
    // Issue #294:「緑は sha に紐づく」を、文書の指示だけでなく道具でも強制する。
    // `--sha` 直指定のときは PR 番号が無いため出さない。
    console.log(formatMatchHeadCommitHint(args.pr, sha));
  }

  if (finalVerdict.status === "green") process.exit(0);
  if (finalVerdict.status === "red") process.exit(1);
  process.exit(2);
}

main();
