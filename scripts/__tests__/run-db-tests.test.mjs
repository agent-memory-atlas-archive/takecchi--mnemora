import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { STAGES } from "../root-test-gate.mjs";

/**
 * `scripts/run-db-tests.mjs`（ルートの `test` 門の DB 段）の歯。
 *
 * **この歯が守っているもの**: 「DB テストが通った」と「DB テストを走らせていない」が
 * 同じ緑になっていた欠陥。区別が付くこと、そして**落ちたときに手元で赤くなること**を測る。
 *
 * 擬似の実行器へ差し替えず、**本物の `scripts/run-db-tests.mjs` を子プロセスとして起動する**。
 * 差し替えると「門が本当に DB テストを呼ぶか」を測れなくなり、この歯の意味が無くなる。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../run-db-tests.mjs", import.meta.url));

/**
 * 届かない接続先。**この形の DATABASE_URL では DB テストは必ず落ちる**——
 * 「DB テストが落ちた」状態を、本物の `test:db` を実際に走らせて作るために使う。
 * ポート 1 は接続が即座に拒否されるので、待たされない。
 */
const UNREACHABLE_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/mnemora_gate_probe";

/** 親の DATABASE_URL を歯に持ち込まない（手元に DB が在るかで結果が変わってはいけない）。 */
function envWithout(name) {
  const env = { ...process.env };
  delete env[name];
  return env;
}

function runGate(env) {
  return spawnSync(process.execPath, [gate], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("scripts/run-db-tests.mjs（ルートの test 門の DB 段）", () => {
  it("DATABASE_URL が無いとき: 緑のまま通すが、『実行していない』と分かる", () => {
    const result = runGate(envWithout("DATABASE_URL"));
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("DB テストは実行していません");

    // 何を走らせなかったかが名指しで分かること（数え落としを見つけられる形であること）。
    expect(output).toContain("@mnemora/postgres");
    expect(output).toContain("@mnemora/example-chat");

    // 「通った」と読める文言を出さないこと——ここが、潰してはいけない区別そのもの。
    expect(output).not.toContain("通りました");
  });

  it("DATABASE_URL が在って DB テストが落ちるとき: 門が赤くなる", () => {
    const result = runGate({ ...process.env, DATABASE_URL: UNREACHABLE_DATABASE_URL });
    const output = `${result.stdout}${result.stderr}`;

    // 芯。以前のルート門はこの状況でも緑のままだった。
    expect(result.status).not.toBe(0);

    // 「呼びに行った上で落ちた」ことを確かめる。単に exit 1 する門では、この歯は通らない。
    expect(output).toContain("DB テストを実行します");
    expect(output).toContain("DB テストが落ちました");

    // 未実行の告知と取り違えられないこと。
    expect(output).not.toContain("DB テストは実行していません");

    // **接続先の告知が、この門に実際に配線されていること。**
    // 単体の形は scripts/__tests__/db-server-description.test.mjs が測る。ここで見るのは
    // 「門がそれを呼んでいるか」——呼び出しが外れれば、接続先は再び黙って出なくなる。
    // 届かない DATABASE_URL なので、必ず「取れなかった」側の文言になる。
    expect(output).toContain("版を取得できませんでした");
  });
});

describe("ルートの test 門の配線", () => {
  /**
   * 上の2つの歯は DB 段そのものを測る。**段が門に繋がっていること**は別の話で、
   * 繋がりが外れれば DB は再び黙って未実行になる——それが元の欠陥そのものである。
   * だからここで配線を釘付けにする。
   *
   * ⚠ **配線の場所が変わった（Issue #453 / ADR 0210）。** 以前はルートの
   * `package.json` の `test` が `&&` で3段を直接連結しており、この歯もそれを
   * `split("&&")` して検査していた。いまは `package.json` の `test` は
   * `node scripts/run-root-test-gate.mjs` を呼ぶだけで、3段の配線は
   * `scripts/run-root-test-gate.mjs` の中に在る（前段の成否に関わらず全部
   * 起動するため、shell の `&&` では表現できない）。⟹ **検査対象をそちらへ移す。**
   */
  it("ルートの test は run-root-test-gate.mjs を呼ぶ", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    expect(manifest.scripts.test).toBe("node scripts/run-root-test-gate.mjs");
  });

  /**
   * ⛔ **ソースを文字列として読んで語の並び順を見る形にしないこと。**
   * `run-root-test-gate.mjs` の冒頭コメントには3段が同じ順で表になって書いてあるので、
   * `indexOf` で順序を測ると**コードを並べ替えても緑のまま**になる。
   * ⟹ 配線の実体（`STAGES`）を import して、そのものを測る。
   */
  it("門は、vitest → pnpm -r --no-bail run test → run-db-tests.mjs の順に3段を起動する", () => {
    const commandLines = STAGES.map((stage) => [stage.command, ...stage.args].join(" "));

    expect(commandLines).toEqual([
      "pnpm exec vitest run",
      "pnpm -r --if-present --no-bail run test",
      "node scripts/run-db-tests.mjs",
    ]);
  });

  it("段2には --no-bail が在る（1パッケージ落ちても残りのパッケージを起動し続ける）", () => {
    const packageStage = STAGES.find((stage) => stage.args.includes("-r"));

    expect(packageStage?.args).toContain("--no-bail");
  });
});
