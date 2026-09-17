import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-pr-adr-reference.mjs`（CI の CLI 入口）の歯。
 *
 * `scripts/__tests__/check-pr-adr-reference-lib.test.mjs` は判定関数
 * `decidePrAdrReferenceCheck()` を合成データで直接検査するが、ここでは**本物の
 * スクリプトを子プロセスとして起動し**、実際の git 履歴から「捨てた番号」を
 * 正しく拾えるかを測る——`scripts/__tests__/decide-publish-dry-run.test.mjs` と
 * 同じ理由（「CLI がその通りに配線されているか」は判定関数だけを見ていては
 * 分からない）。
 *
 * ## なぜ別リポジトリを作るか
 *
 * `check-pr-adr-reference.mjs` は自分自身のファイル位置から repo root を求め
 * （`scripts/adr-renumber.mjs` と同じ設計）、その root を cwd にして `git log` /
 * `git diff` を実行する。この実際のリポジトリ（mnemora 本体）の履歴を使って
 * 「ブランチが捨てた番号」のシナリオを再現するのは難しい（このテスト自身が
 * どのブランチ上で走るか分からない）ため、**使う本物のファイル（この4本）を
 * 一時ディレクトリへコピーし、そこに合成の git 履歴を作って**本物のコードを
 * 動かす。ロジックを再実装したモックではなく、本物の `.mjs` ファイルそのものを
 * 使う。
 */

const realScriptsDir = fileURLToPath(new URL("..", import.meta.url));
const filesToCopy = [
  "check-pr-adr-reference.mjs",
  "check-pr-adr-reference-lib.mjs",
  "adr-renumber-lib.mjs",
  "generate-adr-index-lib.mjs",
];

/** @type {string | undefined} */
let repoDir;

afterEach(() => {
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  }
});

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * 「origin/main には 0001 だけがあり、このブランチが 0199 として ADR を足した後、
 * `adr-renumber.mjs` の儀式と同じ形（別コミットでの `git mv`）で 0200 へ付け替えた」
 * という、この検査が実際に捕まえるべき形の git 履歴を作る。
 */
function buildFixtureRepo() {
  repoDir = mkdtempSync(join(tmpdir(), "check-pr-adr-reference-"));
  const scriptsDir = join(repoDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const file of filesToCopy) {
    copyFileSync(join(realScriptsDir, file), join(scriptsDir, file));
  }
  mkdirSync(join(repoDir, "docs", "decisions"), { recursive: true });

  git(["init", "-q"], repoDir);
  git(["config", "user.email", "test@example.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);
  git(["config", "commit.gpgsign", "false"], repoDir);
  git(["checkout", "-q", "-b", "main"], repoDir);

  writeFileSync(join(repoDir, "docs", "decisions", "0001-init.md"), "# ADR 0001: init\n");
  git(["add", "-A"], repoDir);
  git(["commit", "-q", "-m", "init"], repoDir);
  const base = git(["rev-parse", "HEAD"], repoDir).trim();
  git(["update-ref", "refs/remotes/origin/main", base], repoDir);

  git(["checkout", "-q", "-b", "feature"], repoDir);
  writeFileSync(join(repoDir, "docs", "decisions", "0199-bar.md"), "# ADR 0199: bar\n");
  git(["add", "-A"], repoDir);
  git(["commit", "-q", "-m", "add ADR 0199"], repoDir);

  git(["mv", "docs/decisions/0199-bar.md", "docs/decisions/0200-bar.md"], repoDir);
  git(["add", "-A"], repoDir);
  git(["commit", "-q", "-m", "renumber ADR 0199 -> 0200"], repoDir);

  return repoDir;
}

function runCheck(dir, { prTitle, prBody } = {}) {
  const env = { ...process.env };
  if (prTitle === undefined) delete env.PR_TITLE;
  else env.PR_TITLE = prTitle;
  if (prBody === undefined) delete env.PR_BODY;
  else env.PR_BODY = prBody;

  return spawnSync(process.execPath, [join(dir, "scripts", "check-pr-adr-reference.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
}

describe("scripts/check-pr-adr-reference.mjs（本物の git 履歴に対して起動したときの配線）", () => {
  it("PR タイトルが捨てた番号（0199）を名乗っていたら赤で終わり、いまの番号（0200）も出力する", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, {
      prTitle: "adr-renumber.mjs が付け替えを促す（ADR 0199）",
      prBody: "",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0199");
    expect(result.stderr).toContain("0200");
    expect(result.stderr).toContain("gh pr edit");
  });

  it("PR 本文が捨てた番号（0199）を名乗っていたら赤で終わる（aacb982e が実際に踏んだ形）", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, {
      prTitle: "adr-renumber.mjs が付け替えを促す（ADR 0200）",
      prBody: "ADR 0199 を追加した。",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PR 本文");
    expect(result.stderr).toContain("0199");
  });

  it("タイトル・本文とも現在の番号（0200）を名乗っていれば緑で終わる", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, {
      prTitle: "adr-renumber.mjs が付け替えを促す（ADR 0200）",
      prBody: "ADR 0200 を追加した。",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("PR_BODY が未定義でも落ちない", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, { prTitle: "ADR 0200 を足す" });
    expect(result.status).toBe(0);
  });

  it("PR_BODY が空文字でも落ちない", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, { prTitle: "ADR 0200 を足す", prBody: "" });
    expect(result.status).toBe(0);
  });

  it("PR_TITLE も未定義でも落ちない（両方とも env に無い状態）", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, {});
    expect(result.status).toBe(0);
  });

  it("既存 ADR（0001）への正当な言及は、捨てた番号ではないので違反にならない", () => {
    const dir = buildFixtureRepo();
    const result = runCheck(dir, {
      prTitle: "ADR 0001 を踏まえて ADR 0200 を足す",
      prBody: "ADR 0001 の設計を前提にする。",
    });
    expect(result.status).toBe(0);
  });
});
