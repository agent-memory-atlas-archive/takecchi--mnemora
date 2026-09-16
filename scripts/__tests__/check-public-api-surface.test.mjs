import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-public-api-surface.mjs`（公開 API 表面の門。Issue #342 / ADR 0178）の CLI 全体
 * を対象にした歯。
 *
 * `scripts/__tests__/check-cjs-transpile-parse.test.mjs` と同じ形——フィクスチャは常に
 * 一時ディレクトリに作り、`afterEach` で必ず消す。作業ツリーの `packages/<name>/dist` や
 * `scripts/__snapshots__/public-api/` には一切触れない（CI の「Test」段は「Build」段より
 * 前にあり、実物の dist はまだ存在しない可能性がある。実物に対して走らせる確認は
 * `.github/workflows/ci.yml` の `build` ジョブが `Build` の直後に行う）。
 *
 * `MNEMORA_API_CHECK_PACKAGES_ROOT` / `MNEMORA_API_CHECK_SNAPSHOT_DIR` の2つの env var で
 * 差し替える（`scripts/check-cjs-transpile-parse.mjs` の `CJS_PARSE_CHECK_PACKAGES_ROOT` と
 * 同じ理由・同じ形）。`./publish-targets.mjs` の `PUBLISH_TARGETS`（パッケージ名・dir 名）は
 * 実物のまま使う——対象リストそのものが正しく `PUBLISH_TARGETS` を参照していることも
 * この歯が同時に確かめる。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../check-public-api-surface.mjs", import.meta.url));

// `./publish-targets.mjs` の `PUBLISH_TARGETS` と同じ6パッケージのディレクトリ名。
const PACKAGE_DIRS = ["core", "testkit", "openai", "postgres", "anthropic", "local-embedding"];

/** @type {string | undefined} */
let packagesRoot;
/** @type {string | undefined} */
let snapshotDir;

afterEach(() => {
  if (packagesRoot) {
    rmSync(packagesRoot, { recursive: true, force: true });
    packagesRoot = undefined;
  }
  if (snapshotDir) {
    rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = undefined;
  }
});

/** 6パッケージすべてに、最小限の `exports`/`dist/index.d.ts` を持つフィクスチャを作る。 */
function newFixtureRoots() {
  const base = mkdtempSync(join(tmpdir(), "api-check-cli-"));
  packagesRoot = join(base, "packages");
  snapshotDir = join(base, "snapshots");
  for (const name of PACKAGE_DIRS) {
    const dir = join(packagesRoot, name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: `@mnemora/${name}`,
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "dist/index.d.ts"), "export declare const ok: true;\n", "utf8");
  }
  return { packagesRoot, snapshotDir };
}

function writeIndexDts(name, contents) {
  writeFileSync(join(packagesRoot, name, "dist/index.d.ts"), contents, "utf8");
}

function runGate(extraArgs = []) {
  const result = spawnSync(process.execPath, [gate, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MNEMORA_API_CHECK_PACKAGES_ROOT: packagesRoot,
      MNEMORA_API_CHECK_SNAPSHOT_DIR: snapshotDir,
    },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("scripts/check-public-api-surface.mjs（公開 API 表面の門）", () => {
  it("snapshot が無ければ、--write を促した上で非0", () => {
    newFixtureRoots();
    const { status, output } = runGate();
    expect(status).not.toBe(0);
    expect(output).toContain("snapshot が存在しません");
    expect(output).toContain("--write");
  });

  it("--write で snapshot を書き、以後は差分なしで緑になる", () => {
    newFixtureRoots();
    const write = runGate(["--write"]);
    expect(write.status, `stderr含む出力:\n${write.output}`).toBe(0);
    for (const name of PACKAGE_DIRS) {
      const snapshot = readFileSync(join(snapshotDir, `${name}.d.ts`), "utf8");
      expect(snapshot).toContain("export declare const ok: true;");
    }

    const check = runGate();
    expect(check.status, `stderr含む出力:\n${check.output}`).toBe(0);
    expect(check.output).toContain("公開 API 表面の門を通りました");
  });

  it("🔴 必須メソッド追加（ADR 0161 型の変異）を与えると赤くなり、diff と次の手順を出す", () => {
    newFixtureRoots();
    expect(runGate(["--write"]).status).toBe(0);

    writeIndexDts(
      "core",
      [
        "export interface Runtime {",
        "  observe(): void;",
        "  getRecall(): Promise<number | null>;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(packagesRoot, "core", "dist/index.d.ts"),
      "export declare const ok: true;\n",
      "utf8",
    );
    // 上の1行を実際の変異に差し替える。
    writeIndexDts(
      "core",
      [
        "export declare const ok: true;",
        "export interface Runtime {",
        "  getRecall(): Promise<number | null>;",
        "}",
        "",
      ].join("\n"),
    );

    const { status, output } = runGate();
    expect(status).not.toBe(0);
    expect(output).toContain("[@mnemora/core]");
    expect(output).toContain("getRecall");
    expect(output).toContain("次にすること");
    expect(output).toContain("ADR 0178");
    expect(output).toContain("--write");
    // 変異していないパッケージは差分なしのまま。
    expect(output).toContain("[@mnemora/testkit] 差分なし");
  });

  it("変異後に --write すれば再び緑に戻る（壊れた→直した の両方向を確かめる）", () => {
    newFixtureRoots();
    expect(runGate(["--write"]).status).toBe(0);

    writeIndexDts(
      "core",
      "export declare const ok: true;\nexport declare const changed: number;\n",
    );
    expect(runGate().status).not.toBe(0);

    expect(runGate(["--write"]).status).toBe(0);
    expect(runGate().status).toBe(0);
  });

  it("差分が無いパッケージは --write でも中身が変わらない（無関係な変異は無い）", () => {
    newFixtureRoots();
    runGate(["--write"]);
    const before = readFileSync(join(snapshotDir, "testkit.d.ts"), "utf8");

    writeIndexDts(
      "core",
      "export declare const ok: true;\nexport declare const changed: number;\n",
    );
    runGate(["--write"]);
    const after = readFileSync(join(snapshotDir, "testkit.d.ts"), "utf8");
    expect(after).toBe(before);
  });
});
