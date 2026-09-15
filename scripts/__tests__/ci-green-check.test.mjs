import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/ci-green-check.mjs`（CLI 入口）の歯。
 *
 * ⚠ **`gh` を実際に呼ぶ経路は、ここでは検査しない。** CI のこのジョブ（typecheck/lint/
 * test/build）に GitHub API への到達性・認証済み `gh` が在る保証が無く、それに依存する
 * 歯を書くと「歯が赤い」のか「この環境に `gh` が届いていない」のかが区別できなくなる
 * （`db-server-description.mjs` が「取れなかったことも情報として出す」のと同じ理由で、
 * ここでは最初から依存しない設計を選ぶ）。**検査するのは、`gh` を呼ぶ前に決着する
 * 引数検査の経路だけである。** `gh` 呼び出し以降のロジック（判定そのもの）は
 * `ci-green-check-lib.test.mjs` が純関数として検査している。
 */

const script = fileURLToPath(new URL("../ci-green-check.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("scripts/ci-green-check.mjs（gh を呼ぶ前に決着する経路）", () => {
  it("--pr も --sha も無ければ使い方を出して exit 3", () => {
    const result = run([]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--pr");
    expect(result.stderr).toContain("--sha");
  });

  it("未知のフラグは exit 3 で名指しして落ちる", () => {
    const result = run(["--not-a-real-flag"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("--not-a-real-flag");
  });
});
