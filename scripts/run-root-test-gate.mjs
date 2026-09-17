#!/usr/bin/env node
/**
 * ルートの `test` 門の CLI 入口（Issue #453）。
 *
 * 判定（要約テキストと終了コード）は `./root-test-gate.mjs` が持つ（副作用が無く、
 * 歯から直接呼べる）。ここでは3段を**前段の成否に関わらず順に全部**起動し、
 * 結果を集めて要約を出し、門全体の終了コードで終わる。
 *
 * | 段 | コマンド |
 * |---|---|
 * | 1 | `pnpm exec vitest run` |
 * | 2 | `pnpm -r --if-present --no-bail run test`（`--no-bail`: 対象パッケージのうち1つが落ちても、残りのパッケージの `test` を起動し続ける） |
 * | 3 | `node scripts/run-db-tests.mjs`（ADR 0015。`DATABASE_URL` の有無に応じて DB テストを走らせたかどうかを出力に明示する） |
 *
 * 各段の stdout/stderr は `stdio: "inherit"` でそのまま流す——握り潰したり加工したり
 * しない。特に段3は、出力そのもの（「DB テストは実行していません」等）に意味を
 * 持たせている（ADR 0015）。
 *
 * ⚠ **この CLI 自身を歯から子プロセスとして起動しないこと。** 段2が
 * `pnpm -r run test` を呼ぶため、この門を歯の中から起動すると再帰して
 * 自分自身をまた起動してしまう。歯は `./root-test-gate.mjs` の純関数にだけ当てる
 * （`scripts/__tests__/root-test-gate.test.mjs`）。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGES, gateExitCode, summarizeStages } from "./root-test-gate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** @type {import("./root-test-gate.mjs").StageResult[]} */
const results = [];

for (const stage of STAGES) {
  const run = spawnSync(stage.command, stage.args, { cwd: repoRoot, stdio: "inherit" });
  results.push({
    name: stage.name,
    ran: true,
    // signal で終わった場合（run.status === null）も、未起動と混同しないよう
    // 「起動した・失敗した」として扱う（非ゼロの固定値 1）。
    exitCode: run.status === null ? 1 : run.status,
  });
}

console.log(summarizeStages(results));
process.exit(gateExitCode(results));
