import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/compare-summary.mjs` の歯。**本物のスクリプトを子プロセスとして実際に
 * 起動する**(`time-term-summary.test.mjs`/`identifier-probe-summary.test.mjs`と
 * 同じ形・同じ理由)——`compare-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・**exit code**)はここでしか測れない。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **⭐ `compare` は他5本と違い門である(ADR 0133)**——`mnemoraShareOfNaiveChars` が
 *    基準値より悪化(増加)した、または `factStatementSurvived` が true→false に
 *    退行したら非0で終わる。
 * 2. **それ以外の相違(`naiveChars` 等、退行の判定対象外の欄)だけなら exit 0**。
 *    改善(`mnemoraShareOfNaiveChars` が減った / `factStatementSurvived` が
 *    false→true)も exit 0。
 * 3. **`--baseline` を省略すれば exit 0**——基準値が無ければ退行の判定そのものが
 *    できない(門として機能しない)。
 * 4. **入力そのものが壊れていれば非0**(JSON が読めない・parse できない・rows が
 *    欠ける・`--baseline` が壊れている)。
 *
 * DB もネットワークも要求しない——このスクリプトは JSON ファイルを最大2つ読むだけである。
 */

const script = fileURLToPath(new URL("../compare-summary.mjs", import.meta.url));

function makeRow(overrides = {}) {
  return {
    fillerPairs: 4,
    turnCount: 10,
    naiveChars: 243,
    naiveTokens: 120,
    mnemoraChars: 232,
    mnemoraTokens: 110,
    mnemoraShareOfNaiveChars: 232 / 243,
    totalInScope: 10,
    omitted: [],
    returnedCount: 8,
    annCandidateCount: 10,
    factStatementSurvived: true,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "abc123",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    rowCount: 2,
    rows: [makeRow({ turnCount: 2, fillerPairs: 0 }), makeRow({ turnCount: 10, fillerPairs: 4 })],
    ...overrides,
  };
}

function baselineFrom(measured) {
  return { rows: measured.rows.map((r) => structuredClone(r)) };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "compare-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("compare-summary.mjs（子プロセスで起動）", () => {
  it("--measured だけを渡すと exit 0 で、「基準値がまだ無い」旨を出す", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("## 基準値との差分");
    expect(result.stdout).toContain("基準値ファイルがまだ無い");
    expect(result.stdout).toContain("mnemora/naive");
  });

  it("基準値と一致するときは exit 0 で『一致』と出す", () => {
    const measured = makeMeasured();
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(measured)),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)");
  });

  it("🔴 mnemoraShareOfNaiveChars が悪化(基準値より増加)したときは非0（⭐ 門。ADR 0133）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 5; // 基準値より大きい ⟹ 悪化
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("相違した会話長が 1 件ある");
    expect(result.stderr).toContain("turnCount=2");
    expect(result.stderr).toContain("mnemoraShareOfNaiveChars");
  });

  it("🔴 factStatementSurvived が true→false に退行したときは非0（⭐ 門。ADR 0133）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("factStatementSurvived");
  });

  it("mnemoraShareOfNaiveChars が改善(基準値より減少)しただけなら exit 0", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 0.01; // 基準値より小さい ⟹ 改善
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した会話長が 1 件ある");
  });

  it("退行の判定対象外の欄(naiveChars 等)だけが相違しても exit 0", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].naiveChars = 99999;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("naiveChars");
  });

  it("--measured を渡さないと非0", () => {
    expect(run([]).status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-compare-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON（構文エラー）だと非0", () => {
    const result = run(["--measured", writeJson("broken.json", "{ これは JSON ではない")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured に rows が無いと非0", () => {
    const result = run([
      "--measured",
      writeJson("no-rows.json", { llmMode: "deterministic", embeddingMode: "deterministic" }),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rows");
  });

  it("--baseline を指定してそれが読めないと非0（baseline も『入力』である）", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      join(tmpdir(), "does-not-exist-compare-baseline-12345.json"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の中身が壊れていると非0", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      writeJson("broken-baseline.json", "not json at all"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の rows に turnCount が無いと非0", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    delete baseline.rows[0].turnCount;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("turnCount");
  });
});
