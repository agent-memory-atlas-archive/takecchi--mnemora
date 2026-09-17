#!/usr/bin/env node
/**
 * `.github/workflows/ci.yml`（`typecheck / lint / test / build` ジョブ）の CLI 入口。
 * 判定そのものは `./check-pr-adr-reference-lib.mjs` の `decidePrAdrReferenceCheck()` が
 * 持つ（副作用が無く、歯から直接呼べる）。ここでは
 *
 * 1. env から `PR_TITLE` / `PR_BODY` を読む（`${{ }}` の直接展開ではなく `env:` 経由——
 *    `scripts/decide-publish-dry-run.mjs` と同じ理由。利用者が書く自由記述の文字列を
 *    shell へ直接展開させないことで、注入面を減らす）。`PR_BODY` は空 PR では空文字・
 *    未定義になりうるので、どちらでも落ちないようにする。
 * 2. `git log` / `git diff` を実行し、「このブランチが `docs/decisions/` 配下で一度でも
 *    名乗った ADR 番号」と「いま `origin/main` に対して追加している ADR 番号」を求める
 *    （パスから4桁番号への分解は `scripts/adr-renumber.mjs` の `adrNumbersFromRef` /
 *    `loadAddedAdrFiles` と同じ形——`generate-adr-index-lib.mjs` の `isAdrFilename` と
 *    `adr-renumber-lib.mjs` の `parseAdrFilename` を再利用する）。
 * 3. `decidePrAdrReferenceCheck()` を呼ぶ。
 * 4. 違反が無ければ何を見て通したかを1行出して 0 で終わる。違反があれば、見つかった
 *    番号・いま何番になっているか・直し方（`gh pr edit` は最後の push の**前**に打つこと）
 *    を名指しして 1 で終わる。
 *
 * ## 前提
 *
 * 呼び出し元（CI のステップ、または手元で叩く場合はそのシェル）が、この script の実行
 * **前**に `git fetch origin main` 済みであることを前提にする（`origin/main` という ref
 * が解決できることに依拠する）。`.github/workflows/publish.yml` の
 * 「Release の tag が main の履歴上に在ることを確かめる」ステップが同じ前提を取っており
 * （`actions/checkout` の `fetch-depth: 0` だけでなく、ステップの中で明示的に
 * `git fetch origin main` を打っている）、ここでも同じ形を踏襲した。
 *
 * ## 🔴 残る穴（塞いでいない）
 *
 * **最後の緑の push の「後」に PR タイトル・本文を編集すると、この検査は効かない。**
 * この CLI は `pull_request` イベントの CI 実行時点のタイトル・本文しか見ない。
 * `ci.yml` の `pull_request` トリガーは既定の types（`opened` / `synchronize` /
 * `reopened`）で動いており、`edited`（タイトル・本文の編集）を足していない——足すと
 * 「本文を編集するたびに13ジョブが回り直す」ことになるため採らなかった（詳細は
 * ADR を見ること）。⟹ 「タイトル／本文を直してから push し、緑を引き直してから
 * マージする」という**儀式の順序に依拠している**。これは検査ではなく依拠である。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAdrFilename } from "./generate-adr-index-lib.mjs";
import { parseAdrFilename } from "./adr-renumber-lib.mjs";
import { decidePrAdrReferenceCheck } from "./check-pr-adr-reference-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const decisionsPrefix = "docs/decisions/";

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${args.join(" ")} が失敗した (exit ${result.status}): ${result.stderr}\n` +
        "（`origin/main` が fetch 済みであることを前提にしています。CI のステップで " +
        "`git fetch origin main` を先に実行しているか確認すること。）",
    );
    err.stderr = result.stderr;
    err.status = result.status;
    throw err;
  }
  return result.stdout;
}

function splitLines(out) {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** git の出力（1行1パス）から、docs/decisions/ 直下の ADR ファイルの4桁番号を拾う。 */
function adrNumbersFromPaths(paths) {
  const numbers = [];
  for (const path of paths) {
    if (!path.startsWith(decisionsPrefix)) continue;
    const rest = path.slice(decisionsPrefix.length);
    if (rest.includes("/")) continue; // ネストしたディレクトリは対象外
    if (!isAdrFilename(rest)) continue;
    const parsed = parseAdrFilename(rest);
    if (parsed) numbers.push(parsed.number);
  }
  return numbers;
}

function loadClaimedNumbers() {
  // ブランチ上の全コミットが docs/decisions/ に対して touch したパスを集める
  // （追加・変更・rename・削除のどれかを問わない——`git mv` によるリネームも、
  // 元の追加コミットと git-mv コミットが別コミットである限り、両方のパスが
  // それぞれのコミットの diff に現れる。1コミットに add と rename を圧縮した
  // 場合は旧番号が履歴に残らず検出できない——「確かめていないこと」参照）。
  const out = run("git", [
    "log",
    "--name-only",
    "--format=",
    "origin/main..HEAD",
    "--",
    decisionsPrefix,
  ]);
  return adrNumbersFromPaths(splitLines(out));
}

function loadAddedNumbers() {
  // 二点 diff（working tree 対 origin/main）——`scripts/adr-renumber.mjs` の
  // `loadAddedAdrFiles()` と同じ取り方。
  const out = run("git", [
    "diff",
    "--diff-filter=A",
    "--name-only",
    "origin/main",
    "--",
    decisionsPrefix,
  ]);
  return adrNumbersFromPaths(splitLines(out));
}

function main() {
  const prTitle = process.env.PR_TITLE ?? "";
  const prBody = process.env.PR_BODY ?? "";

  const claimedNumbers = loadClaimedNumbers();
  const addedNumbers = loadAddedNumbers();

  const { abandonedNumbers, violations } = decidePrAdrReferenceCheck({
    claimedNumbers,
    addedNumbers,
    prTitle,
    prBody,
  });

  if (violations.length === 0) {
    console.log(
      "OK: このブランチが docs/decisions/ 配下で名乗った ADR 番号は " +
        `${new Set(claimedNumbers).size} 件、いま追加している番号は ` +
        `[${addedNumbers.join(", ") || "無し"}]、捨てた番号は [${abandonedNumbers.join(", ") || "無し"}]。` +
        "PR タイトル・本文のどちらにも捨てた番号への参照は見つかりませんでした。",
    );
    process.exit(0);
  }

  console.error(
    "✗ PR タイトル/本文が、このブランチが自分で名乗って自分で捨てた ADR 番号を名指ししています。",
  );
  console.error("");
  console.error(
    `いまこのブランチが origin/main に追加している ADR 番号: [${addedNumbers.join(", ") || "無し"}]`,
  );
  console.error("");
  for (const v of violations) {
    const label = v.location === "title" ? "PR タイトル" : "PR 本文";
    const formLabel = v.form === "stem" ? "ファイル名/URL 参照" : '"ADR NNNN" 表記';
    console.error(
      `  ${label}: ADR ${v.number}（${formLabel}、"${v.sample}" を含めて ${v.count} 箇所）` +
        " — この番号は付け替えで捨てられました。",
    );
  }
  console.error("");
  console.error("直し方:");
  console.error(
    '  gh pr edit <このPRの番号> --title "..." --body "..." で、上の古い番号を、' +
      "いま追加している番号（上に列挙）へ書き換えること。",
  );
  console.error("");
  console.error(
    "⭐ 直すのは「最後の push の前」であること。squash merge のタイトル・本文は、マージ実行時点の",
  );
  console.error(
    "PR タイトル・本文からそのまま作られます（このリポジトリは squash_merge_commit_title=PR_TITLE /",
  );
  console.error(
    "squash_merge_commit_message=PR_BODY）。push の後にタイトル・本文だけを編集しても、この CI は",
  );
  console.error(
    "再実行されません——タイトル・本文を直してから push し、緑を引き直してからマージすること。",
  );
  process.exit(1);
}

main();
