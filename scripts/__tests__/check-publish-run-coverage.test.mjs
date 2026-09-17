import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";

/**
 * `scripts/check-publish-run-coverage.mjs`（CLI 入口）の歯。
 *
 * ⚠ **`gh` を実際に呼ぶ経路（`--run <id>`）は、ここでは検査しない。** CI のこのジョブに
 * GitHub API への到達性・認証済み `gh` が在る保証が無く、それに依存する歯を書くと
 * 「歯が赤い」のか「この環境に `gh` が届いていない」のかが区別できなくなる
 * （`ci-green-check.test.mjs` と同じ理由）。
 *
 * 代わりに、CLI に `--log-file <path>` という経路を持たせてある——ログをファイルから
 * 読む形にすれば、`gh` を1度も呼ばずに**本物のスクリプトを子プロセスとして起動して**
 * 配線（引数解析・ログの読み込み・純関数への受け渡し・印字・終了コード）を検査できる。
 * `decide-publish-dry-run.test.mjs` が `$GITHUB_OUTPUT` をファイル経由でやり取りして
 * 本物の CLI を子プロセスで起動するのと同じ考え方。
 *
 * 判定そのもの（文言の分類・突き合わせ）は `publish-run-coverage-lib.test.mjs` が
 * 純関数として検査している。ここで見るのは「CLI がその通りに配線されているか」だけ。
 */

const script = fileURLToPath(new URL("../check-publish-run-coverage.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const TIMESTAMP = "2026-09-17T01:14:00.3481028Z ";

/** @type {string | undefined} */
let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function githubGroup(spec, resultLine) {
  return (
    `${TIMESTAMP}##[group]npm publish ${spec}\n` +
    `${TIMESTAMP}${resultLine}\n` +
    `${TIMESTAMP}##[endgroup]\n`
  );
}

function writeLogFile(content) {
  workDir = mkdtempSync(join(tmpdir(), "check-publish-run-coverage-"));
  const logPath = join(workDir, "job.log");
  writeFileSync(logPath, content);
  return logPath;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("scripts/check-publish-run-coverage.mjs（引数検査）", () => {
  it("--run も --log-file も無ければ使い方を出して exit 3", () => {
    const result = run([]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--run");
    expect(result.stderr).toContain("--log-file");
  });

  it("--run と --log-file を同時に渡すと exit 3", () => {
    const result = run(["--run", "1", "--log-file", "/tmp/does-not-matter"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("同時に渡せない");
  });

  it("未知のフラグは exit 3 で名指しして落ちる", () => {
    const result = run(["--not-a-real-flag"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--not-a-real-flag");
  });

  it("--log-file に存在しないパスを渡すと exit 3", () => {
    const result = run(["--log-file", "/does/not/exist/anywhere.log"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--log-file が読めない");
  });
});

describe("scripts/check-publish-run-coverage.mjs（--log-file 経由。PUBLISH_TARGETS は実物を使う）", () => {
  it("全 PUBLISH_TARGETS が publish した ⟹ exit 0、pass を印字する", () => {
    const log = PUBLISH_TARGETS.map((t) =>
      githubGroup(`${t.name}@9.9.9`, `✔ ${t.name}@9.9.9 を publish した`),
    ).join("");
    const logPath = writeLogFile(log);
    const result = run(["--log-file", logPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("判定: pass");
    expect(result.stdout).toContain(`${PUBLISH_TARGETS.length}/${PUBLISH_TARGETS.length}`);
  });

  it("run 35169553262 の実測どおり（先頭4本が飛ばし、後方2本が publish した）を再現すると exit 1、名指しできる", () => {
    // ADR 0207「測ったこと2」の実測をそのまま再現する。ここでは並び順を仮定せず、
    // PUBLISH_TARGETS の並びに沿って「先頭側を飛ばした・末尾側を publish した」形にする
    // ——本数を PUBLISH_TARGETS.length から動的に決め、リテラルの6を書かない。
    const skippedCount = Math.max(1, PUBLISH_TARGETS.length - 2);
    const log = PUBLISH_TARGETS.map((t, i) => {
      if (i < skippedCount) {
        return githubGroup(
          `${t.name}@9.9.9`,
          `✔ ${t.name}@9.9.9 は既に registry に在る（飛ばした）`,
        );
      }
      return githubGroup(`${t.name}@9.9.9`, `✔ ${t.name}@9.9.9 を publish した`);
    }).join("");
    const logPath = writeLogFile(log);
    const result = run(["--log-file", logPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("判定: fail");
    // 飛ばした側の先頭のパッケージが名指しされていること
    expect(result.stdout).toContain(`${PUBLISH_TARGETS[0].name}: 飛ばした`);
  });

  it("publish 段の group が1つも無いログは exit 2（判定不能）で pass に倒さない", () => {
    const logPath = writeLogFile("Set up job\nCheckout\n何も publish していないログ\n");
    const result = run(["--log-file", logPath]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("判定: indeterminate");
  });

  it("--json は result を機械可読な形でも出す", () => {
    const log = PUBLISH_TARGETS.map((t) =>
      githubGroup(`${t.name}@9.9.9`, `✔ ${t.name}@9.9.9 を publish した`),
    ).join("");
    const logPath = writeLogFile(log);
    const result = run(["--log-file", logPath, "--json"]);
    expect(result.status).toBe(0);
    // --json は JSON.stringify(..., null, 2) の整形出力を最後にまとめて出す
    // ——先頭の "{" から末尾までを取り直してパースする。
    const jsonStart = result.stdout.indexOf("{");
    const parsed = JSON.parse(result.stdout.slice(jsonStart));
    expect(parsed.result.verdict).toBe("pass");
  });
});
