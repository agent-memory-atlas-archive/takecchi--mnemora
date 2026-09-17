#!/usr/bin/env node
/**
 * リリース当日に、「前回のリリース以降、リリースノート／CHANGELOG に載せるべき候補」を
 * その場で出す道具。
 *
 * ## これは歯ではなく道具である
 *
 * `scripts/__tests__/` の下に置く歯（`release-candidates-lib.test.mjs`）は、この CLI が
 * 使う純関数だけを検査する。**この CLI 自体は、どの CI ワークフローにも配線していない**
 * ——`.github/workflows/*.yml` からは呼ばれない。当日、人がターミナルで直接叩くものである
 * （`node scripts/release-candidates.mjs [--since <tag>] [--json]`）。
 *
 * ## これは判定ではなく候補の一覧である
 *
 * `v0.2.0..origin/main`（70 commit、2026-09-17 時点で実測）には、確定的な破壊的変更が
 * 4件あるが、印の付き方はバラバラだった:
 *
 * | sha | `!` | 本文に「破壊的」/BREAKING | 公開API snapshot を触る |
 * |---|---|---|---|
 * | `c4a3dc7` | ✗ | ✗ | ✗ |
 * | `2097a72` | ✗ | ✓ | ✗ |
 * | `855286a` | ✗ | ✓ | ✓ |
 * | `b84f120` | ✓ | ✗ | ✓ |
 *
 * 🔴 **`c4a3dc7` はどの信号にも掛からない**——それでいて `CHANGELOG.md` の
 * `### 変更（破壊的）` 節には載っている。🔴 **`BREAKING CHANGE:` フッタは repo 全履歴で
 * 0件**（使われていない）。🔴 **`b84f120` は確定的な破壊的変更なのに、この道具を書いている
 * 時点の `CHANGELOG.md` に未収録**（`grep -c LocalEmbeddingPipeline CHANGELOG.md` は 0 を返す）。
 * ⟹ **機械的な信号だけを根拠に「破壊的変更はこれだけ」と結論しないこと。**この道具が
 * 出すのは「人が読むべき候補の一覧」であって、「破壊的変更の確定リスト」ではない。
 * **信号が付かなかった側（`withoutSignals`）も必ず人が読むこと**——`c4a3dc7` はそこにしか
 * 現れない。
 *
 * ## 数字も tag も焼き込んでいない
 *
 * [ADR 0070](../docs/decisions/0070-version-comes-from-the-release-tag.md) は
 * 「**Release の tag が版を決める。`package.json` はそれを受け取る側になる。**」と定めている
 * ——版の権威は tag にあり、この repo のどのファイルにも「現在の版」を焼き込まない設計である。
 * この道具が起点の tag をコマンドライン引数か `gh release view`/`git describe` からその場で
 * 取り、ソースコードに数字や tag 名を書かないのは、その決定と同じ理由による——**焼き込んだ
 * 数字は、次のリリースが出た瞬間に腐る。**`CHANGELOG.md` 自身が「数字を焼き込む以上、
 * `main` が動けば必ず腐る」と明記しているのと同じ規律を、この道具にも掛ける。
 *
 * ## `CHANGELOG.md` を書き換えない
 *
 * [ADR 0169](../docs/decisions/0169-changelog-hand-curated.md) 決定1は「CHANGELOG.md は
 * ルートに置き、手で書く（Keep a Changelog 風）」と定めている。同 ADR の「引き受けた負債」
 * 1番は逐語でこう書いている:
 *
 * > 🔴 **手で書く CHANGELOG は、書き忘れうる。** 自動生成ではないため、ある Release で
 * > 利用者に影響する変更が実際にあったのに、CHANGELOG.md への追記を忘れる、という
 * > 失敗モードを構造的に持つ。**これを検出する歯は無い**——`compare`（ADR 0133）のような
 * > ⭐ 門は、CHANGELOG の鮮度には掛かっていない。
 *
 * **この道具はその負債を埋める側であって、CHANGELOG.md の代わりに書く側ではない。**
 * CHANGELOG は引き続き人が手で書く——この道具は「何を書き忘れていないか」を人が確認する
 * ための材料（候補一覧と鮮度の申告）を出すだけで、ファイルへの書き込みは一切しない。
 *
 * ## 使い方
 *
 * ```
 * node scripts/release-candidates.mjs
 * node scripts/release-candidates.mjs --since v0.2.0
 * node scripts/release-candidates.mjs --since v0.2.0 --json
 * ```
 *
 * `--since` を省くと、`gh release view --repo <repo> --json tagName -q .tagName` で
 * 「最新リリースの tag」を取る。`gh` が失敗したら `git describe --tags --abbrev=0` へ落ちる
 * ——**落ちたことは出力に明記する**。repo 名も `gh repo view` か `git remote get-url origin`
 * から導き、焼き込まない。
 *
 * 終了コード: **常に `0`**（候補が0件でも、信号なし commit が在っても `0`）。
 * ⛔ **これは門ではない**——実行時エラー（`git`/`gh` 呼び出し失敗等）のときだけ `1` で落ちる。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCommits,
  extractChangelogBaseSha,
  groupByType,
  splitBySignal,
} from "./release-candidates-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { since: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", cwd: REPO_ROOT });
}

/** @returns {string} */
function resolveRepo() {
  try {
    return run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  } catch {
    // gh が使えない・未認証等 — origin の URL から owner/repo を導く。
    const url = run("git", ["remote", "get-url", "origin"]).trim();
    // 対応する形: git@github.com:owner/repo.git / https://github.com/owner/repo.git
    const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (!match) {
      throw new Error(`origin の URL から owner/repo を読み取れなかった: ${url}`);
    }
    return match[1];
  }
}

/**
 * 起点の tag を決める。**数字も tag 名もソースに焼き込まない**——その場で取る。
 *
 * @param {string | null} explicitSince
 * @param {string} repo
 * @returns {{ tag: string, source: string }}
 */
function resolveSinceTag(explicitSince, repo) {
  if (explicitSince) {
    return { tag: explicitSince, source: "--since で指定" };
  }
  try {
    const tag = run("gh", [
      "release",
      "view",
      "--repo",
      repo,
      "--json",
      "tagName",
      "-q",
      ".tagName",
    ]).trim();
    return { tag, source: `gh release view --repo ${repo} から取得（最新リリース）` };
  } catch (err) {
    const tag = run("git", ["describe", "--tags", "--abbrev=0"]).trim();
    return {
      tag,
      source:
        `⚠ gh release view が失敗したため git describe --tags --abbrev=0 へ落ちた` +
        `（gh のエラー: ${String(err.message ?? err).split("\n")[0]}）`,
    };
  }
}

/**
 * `<since>..HEAD` の全 commit を、分類に要る生の形（sha/subject/body/files）で取る。
 * ⭐ 候補だけを探すのではなく、**母集合をまず落としてから**印を当てる。
 */
function collectRawCommits(since) {
  const shas = run("git", ["log", `${since}..HEAD`, "--format=%H"])
    .split("\n")
    .filter((s) => s.trim().length > 0);

  return shas.map((sha) => {
    const [subject, ...bodyParts] = run("git", ["log", "-1", "--format=%s%x1f%b", sha]).split(
      "\x1f",
    );
    const body = bodyParts.join("\x1f");
    const files = run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
      .split("\n")
      .filter((f) => f.trim().length > 0);
    return { sha, subject, body, files };
  });
}

/**
 * `CHANGELOG.md` の鮮度を申告する。**書き換えない。読むだけ。**
 * 読み取れなければ「読み取れなかった」を返す（例外にしない — lib 側の契約どおり）。
 */
function describeChangelogFreshness() {
  const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    return { baseSha: null, note: "CHANGELOG.md が見当たらない" };
  }
  const text = readFileSync(changelogPath, "utf8");
  const baseSha = extractChangelogBaseSha(text);
  if (!baseSha) {
    return {
      baseSha: null,
      note:
        "CHANGELOG.md から基準 sha を読み取れなかった" +
        "（「…の範囲を数えたものである」という記述、またはその直前のバッククォート付き16進数が見当たらない）",
    };
  }
  try {
    const commitsAhead = Number(run("git", ["rev-list", "--count", `${baseSha}..HEAD`]).trim());
    return { baseSha, commitsAhead, note: null };
  } catch (err) {
    return {
      baseSha,
      note: `基準 sha ${baseSha} は読み取れたが、rev-list に失敗した（${String(err.message ?? err).split("\n")[0]}）`,
    };
  }
}

const WARNING = [
  "⛔ これは判定ではなく候補の一覧である。信号は「読む順番」であって「破壊的かどうか」ではない。",
  "",
  "【実測 2026-09-17】v0.2.0..HEAD の確定的な破壊的変更4件に、信号は一様には付かなかった:",
  "  ・取りこぼす側（高い）: c4a3dc7 は CHANGELOG.md の「変更（破壊的）」節に載っているが、",
  "    `!` も本文の「破壊的」も公開 API snapshot の変更も持たない",
  "    ——粗い src にしか掛からない。⛔ 信号が src だけの commit を「印が無いから安全」と読まないこと。",
  "  ・余計に拾う側（安い）: e1c0793 は本文が逐語で「破壊的変更ではない。」と書いているのに",
  "    body-breaking が立つ——語を見ているだけで、否定文を読み分けない。",
  "",
  "⟹ 信号が付かなかった側も人が読むこと。この道具が減らすのは読む手間であって、読む責任ではない。",
].join("\n");

function formatCommitLine(commit) {
  const scope = commit.scope ? `(${commit.scope})` : "";
  const type = commit.type ?? "type無し";
  const bang = commit.bang ? "!" : "";
  const pr = commit.prNumber != null ? `#${commit.prNumber}` : "-";
  const signals = commit.signals.length > 0 ? commit.signals.join(",") : "-";
  return `  ${commit.sha.slice(0, 7)}  ${type}${scope}${bang}  PR=${pr}  signals=[${signals}]\n    ${commit.subject}`;
}

function printHuman({
  repo,
  since,
  sinceSource,
  totalCommits,
  freshness,
  withSignals,
  withoutSignals,
}) {
  console.log(`repo: ${repo}`);
  console.log(`起点 tag: ${since}（${sinceSource}）`);
  console.log(`範囲: ${since}..HEAD`);
  console.log(`範囲内の commit 総数: ${totalCommits}`);
  console.log("");
  console.log("--- CHANGELOG.md の鮮度（読むだけ・書き換えない） ---");
  if (freshness.baseSha && freshness.commitsAhead != null) {
    console.log(`CHANGELOG.md はここまで数えている: ${freshness.baseSha}`);
    console.log(
      `HEAD はそこから ${freshness.commitsAhead} commit 先（git rev-list --count ${freshness.baseSha}..HEAD）`,
    );
  } else {
    console.log(freshness.note);
  }
  console.log("");
  console.log(`--- 信号が付いた commit（${withSignals.length}件） ---`);
  for (const c of withSignals) console.log(formatCommitLine(c));
  console.log("");
  console.log(`--- 信号が付かなかった commit（${withoutSignals.length}件、type別） ---`);
  const groups = groupByType(withoutSignals);
  for (const [type, commits] of groups) {
    console.log(`[${type}]（${commits.length}件）`);
    for (const c of commits) console.log(formatCommitLine(c));
  }
  console.log("");
  console.log(WARNING);
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repo = resolveRepo();
  const { tag: since, source: sinceSource } = resolveSinceTag(args.since, repo);
  const rawCommits = collectRawCommits(since);
  const classified = classifyCommits(rawCommits);
  const { withSignals, withoutSignals } = splitBySignal(classified);
  const freshness = describeChangelogFreshness();

  const payload = {
    repo,
    since,
    sinceSource,
    totalCommits: classified.length,
    changelogFreshness: freshness,
    withSignals,
    withoutSignals,
    warning: WARNING,
  };

  if (args.json) {
    printJson(payload);
  } else {
    printHuman({
      repo,
      since,
      sinceSource,
      totalCommits: classified.length,
      freshness,
      withSignals,
      withoutSignals,
    });
  }

  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(String(err.stack ?? err.message ?? err));
  process.exit(1);
}
