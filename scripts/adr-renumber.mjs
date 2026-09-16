#!/usr/bin/env node
/**
 * ADR の番号採番を「マージ直前」に確定させる CLI（Issue #295、ADR 0179）。
 * 純関数側は `scripts/adr-renumber-lib.mjs`。
 *
 * ## 前提となる設計
 *
 * `main` へのマージは直列化されている（マージする側が1本ずつ直列に行う運用。
 * ADR 0137「決定」2番が同じ前提を明示している）。したがって、**マージ直前・
 * PR ブランチ上で、そのときの `main` を取り込んだ状態で番号を確定させれば、
 * その時点で他の ADR が同時に着地することは構造的に無い**——衝突しようがない
 * タイミングまで採番を遅らせる、という設計である（ADR 0179）。
 *
 * マージする側は、squash merge する**直前**に PR ブランチ上で
 * `generate-adr-index.mjs` を実行する儀式を既に持っている（ADR 0137）。
 * このツールは、その儀式に「索引の再生成より前」の一手として挿し込まれる:
 *
 * ```
 * git fetch origin main && git merge origin/main
 * node scripts/adr-renumber.mjs
 * node scripts/generate-adr-index.mjs
 * git add -A && git commit -m "..."
 * git push
 * node scripts/ci-green-check.mjs --pr <N>
 * gh pr merge <N> --squash
 * ```
 *
 * ⚠ **既存の ADR は1本もリネームしない。** 動かすのは「このブランチが
 * `origin/main` に対して新しく追加した `docs/decisions/*.md`」だけであり、
 * かつ、その番号が `origin/main` 側で既に使われている場合だけである。
 *
 * ## 使い方
 *
 * ```
 * node scripts/adr-renumber.mjs           # 衝突を検出し、あれば付け替えて全参照を書き換える
 * node scripts/adr-renumber.mjs --check   # 書き込まず、衝突の有無だけ判定する（0=無し/1=有り）
 * node scripts/adr-renumber.mjs --next    # 楽観的な最初の1本のために、まだ誰も
 *                                         # 取っていなさそうな次の番号を印字する
 * ```
 *
 * `--next` は `origin/main` に加えて、他のリモートブランチ（`refs/remotes/origin/*`）と
 * open な PR（`gh pr list` + `gh pr view --json files`）が主張している番号も見る。
 * **助けにしかならない**——`--next` が返した番号でも、他の PR が同時に同じ番号を
 * 選べば衝突しうる。確定させるのは、マージ直前に実行するこのツールの既定動作
 * （引数無し）のほうである。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isAdrFilename } from "./generate-adr-index-lib.mjs";
import {
  addedLineNumbers,
  parseAdrFilename,
  pickNextFreeNumber,
  planRenumbering,
  rewriteReferencesInText,
} from "./adr-renumber-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const decisionsPrefix = "docs/decisions/";

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${args.join(" ")} が失敗した (exit ${result.status}): ${result.stderr}`,
    );
    err.stderr = result.stderr;
    err.status = result.status;
    throw err;
  }
  return result.stdout;
}

/** 失敗しても例外を投げず null を返す版。存在確認・ベストエフォートの操作に使う。 */
function tryRun(cmd, args, options = {}) {
  try {
    return run(cmd, args, options);
  } catch {
    return null;
  }
}

function adrNumbersFromRef(ref) {
  const out = tryRun("git", ["ls-tree", "-r", "--name-only", ref, "--", "docs/decisions/"]);
  if (out === null) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => basename(path))
    .filter((filename) => isAdrFilename(filename))
    .map((filename) => parseAdrFilename(filename).number);
}

function parseArgs(argv) {
  const modes = argv.filter((a) => a === "--check" || a === "--next");
  if (modes.length > 1) {
    console.error("--check と --next は同時に指定できません。");
    process.exit(3);
  }
  return { check: argv.includes("--check"), next: argv.includes("--next") };
}

function loadAddedAdrFiles() {
  // 二点 diff（working tree 対 origin/main）を使う——三点 diff
  // （origin/main...HEAD）は「コミット済み」の差分しか見ないが、この CLI
  // 自身が行う `git mv`（後続の呼び出しで行う）はコミット前の作業木の変更
  // であり、二点 diff でなければ拾えない。`git merge origin/main` 済みの
  // ブランチでは、merge-base(origin/main, HEAD) は origin/main そのものに
  // なるため、二点 diff は三点 diff の「コミット済み分」を完全に含む。
  const diffOut = run("git", [
    "diff",
    "--diff-filter=A",
    "--name-only",
    "origin/main",
    "--",
    "docs/decisions/",
  ]);
  return diffOut
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith(decisionsPrefix))
    .map((path) => basename(path))
    .filter((filename) => isAdrFilename(filename))
    .map((filename) => ({ filename }));
}

function buildPlan() {
  const mainNumbers = adrNumbersFromRef("origin/main");
  const addedFiles = loadAddedAdrFiles();
  const plan = planRenumbering(mainNumbers, addedFiles);
  return { plan, addedCount: addedFiles.length };
}

function runCheck() {
  tryRun("git", ["fetch", "origin", "main", "--quiet"]);
  const { plan, addedCount } = buildPlan();
  if (addedCount === 0) {
    console.log("origin/main に対して新しく追加された ADR ファイルはありません。");
    process.exit(0);
  }
  const conflicts = plan.filter((p) => p.renamed);
  if (conflicts.length === 0) {
    for (const p of plan) {
      console.log(`衝突なし: docs/decisions/${p.oldFilename}`);
    }
    process.exit(0);
  }
  console.error(`衝突あり: ${conflicts.length} 件。`);
  for (const c of conflicts) {
    console.error(
      `  docs/decisions/${c.oldFilename} — 番号 ${c.oldNumber} は origin/main で既に使われています（次の空き番号: ${c.newNumber}）`,
    );
  }
  process.exit(1);
}

function runNext() {
  tryRun("git", ["fetch", "origin", "main", "--quiet"]);
  const fetchBranchesResult = tryRun("git", [
    "fetch",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    "--quiet",
  ]);
  if (fetchBranchesResult === null) {
    console.error(
      "⚠ リモートブランチの一覧を更新できませんでした（ネットワーク不通等）。ローカルに既にある refs/remotes/origin/* だけを使います。",
    );
  }

  const mainNumbers = adrNumbersFromRef("origin/main");

  const refsOut = tryRun("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin",
  ]);
  const branchRefs =
    refsOut === null
      ? []
      : refsOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l !== "origin/HEAD" && l !== "origin/main");

  const branchNumbers = new Set();
  for (const ref of branchRefs) {
    for (const n of adrNumbersFromRef(ref)) branchNumbers.add(n);
  }

  const prNumbers = new Set();
  let ghAvailable = true;
  const prListOut = tryRun("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number",
    "-q",
    ".[].number",
  ]);
  if (prListOut === null) {
    ghAvailable = false;
  } else {
    const prList = prListOut
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const prNumber of prList) {
      const filesOut = tryRun("gh", [
        "pr",
        "view",
        prNumber,
        "--json",
        "files",
        "-q",
        ".files[].path",
      ]);
      if (filesOut === null) continue;
      for (const path of filesOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)) {
        if (!path.startsWith(decisionsPrefix)) continue;
        const filename = basename(path);
        if (isAdrFilename(filename)) prNumbers.add(parseAdrFilename(filename).number);
      }
    }
  }

  if (!ghAvailable) {
    console.error(
      "⚠ `gh` が使えないため、open な PR の主張は見ていません。origin/main と他のリモートブランチだけで判定します（静かに劣化させていません——この行がその告知です）。",
    );
  }

  const used = new Set([...mainNumbers, ...branchNumbers, ...prNumbers]);
  console.log(`origin/main の ADR 数: ${mainNumbers.length}`);
  console.log(`見た他のリモートブランチ: ${branchRefs.length} 本`);
  console.log(
    `見た open な PR: ${ghAvailable ? prNumbers.size + " 本の ADR 主張" : "(gh 不可のため無し)"}`,
  );
  const next = pickNextFreeNumber(used);
  console.log(`次の空き番号（楽観的な最初の1本用。確定はマージ直前の既定動作が行う）: ${next}`);
}

function performRenumber() {
  tryRun("git", ["fetch", "origin", "main", "--quiet"]);
  const { plan, addedCount } = buildPlan();

  if (addedCount === 0) {
    console.log("origin/main に対して新しく追加された ADR ファイルはありません。何もしません。");
    process.exit(0);
  }

  const conflicts = plan.filter((p) => p.renamed);
  if (conflicts.length === 0) {
    console.log(`衝突なし（新しく追加された ADR ${addedCount} 本）。何も変更しません。`);
    for (const p of plan) console.log(`  docs/decisions/${p.oldFilename}`);
    process.exit(0);
  }

  console.log(`衝突を検出しました（${conflicts.length} 件）。付け替えます:`);
  for (const c of conflicts) {
    const oldPath = `docs/decisions/${c.oldFilename}`;
    const newPath = `docs/decisions/${c.newFilename}`;
    console.log(`  git mv ${oldPath} ${newPath}`);
    run("git", ["mv", oldPath, newPath]);
  }

  const renames = conflicts.map((c) => ({
    oldNumber: c.oldNumber,
    newNumber: c.newNumber,
    slug: c.slug,
  }));

  // ⚠ 書き換えの対象は「origin/main に対してこのブランチが変更した行」だけに
  // 絞る。`origin/main` から継承した行（このブランチが触っていない行）は、
  // たとえ衝突した番号への正当な言及が同居していても一切変更しない——
  // このリポジトリで実際に `git grep -n "ADR <番号>\b"` を打つと、衝突した
  // 番号（定義上 origin/main で既に使われている番号）への正当な言及が
  // repo 全体に多数見つかる（`adr-renumber-lib.mjs` の docstring 参照）。
  // それらを巻き込まないために、`git mv` 後の現在の diff（working tree
  // 対 origin/main）を見て、追加された行だけを対象にする。
  const changedFiles = run("git", ["diff", "--name-only", "origin/main"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let touchedFiles = 0;
  for (const relPath of changedFiles) {
    const absPath = join(repoRoot, relPath);
    let buf;
    try {
      buf = readFileSync(absPath);
    } catch {
      continue; // 削除された側なので書き換え対象にならない
    }
    if (buf.includes(0)) continue; // NUL バイトを含む＝バイナリとみなしスキップ

    const diffText = run("git", ["diff", "--unified=0", "origin/main", "--", relPath]);
    const addedLines = addedLineNumbers(diffText);
    if (addedLines.size === 0) continue;

    const lines = buf.toString("utf8").split("\n");
    const fileChanges = [];
    for (const lineNo of addedLines) {
      const idx = lineNo - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const { text: newLine, changes } = rewriteReferencesInText(lines[idx], renames);
      if (changes.length === 0) continue;
      lines[idx] = newLine;
      fileChanges.push(...changes);
    }
    if (fileChanges.length === 0) continue;

    writeFileSync(absPath, lines.join("\n"), "utf8");
    touchedFiles += 1;
    console.log(`${relPath}:`);
    for (const c of fileChanges) {
      const label = c.type === "stem" ? "ファイル名参照" : '"ADR NNNN" 表記';
      console.log(`  ${label}: ADR ${c.oldNumber} -> ADR ${c.newNumber}（${c.count} 箇所）`);
    }
  }

  console.log(
    `完了。${conflicts.length} 本の ADR を付け替え、${touchedFiles} ファイルの参照を書き換えました。`,
  );
}

function main() {
  const { check, next } = parseArgs(process.argv.slice(2));
  if (next) {
    runNext();
    return;
  }
  if (check) {
    runCheck();
    return;
  }
  performRenumber();
}

main();
