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
 * 5. **🔴 実測と基準値の `turnCount` 集合が一致しなければ exit 2(判定不能)**
 *    (Issue #477)。⛔ **判定不能を 0 に倒さない**——「比較していない」を
 *    「退行が無い」と同じ顔で出さないため。終了コードの語彙
 *    (pass=0 / fail=1 / 判定不能=2)は `check-publish-run-coverage.mjs` に揃えてある。
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

  /**
   * ⭐ **Issue #477 の陽性対照を、CLI の終了コードとして固定する。**
   *
   * `main`（`dd9ec8e` 時点）では、基準値を1行だけ／空配列にすると、**同じ実測が
   * 退行していても** `computeRegressions` が0件を返し、この CLI は **exit 0（緑）**
   * を出していた（探り棒で逐語に記録した）。いまは exit 2（判定不能）である。
   *
   * ⛔ **判定不能を 0 に倒さない**（`check-publish-run-coverage.mjs` と同じ語彙:
   * pass=0 / fail=1 / 判定不能=2）。
   */
  it("🔴【本題】基準値が1行だけなら exit 2（判定不能。緑にしない）", () => {
    const measured = makeMeasured();
    measured.rows[1].mnemoraShareOfNaiveChars = 5; // turnCount=10 が退行している
    const baseline = { rows: [structuredClone(makeRow({ turnCount: 2, fillerPairs: 0 }))] };
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("判定不能");
    expect(result.stderr).toContain("turnCount=10");
    expect(result.stdout).toContain("この会話長は比較していない");
  });

  it("🔴【本題2】基準値が空配列なら exit 2（validateBaseline は通したままで落ちる）", () => {
    const measured = makeMeasured();
    measured.rows[0].factStatementSurvived = false;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", { rows: [] }),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("1会話長も比較していない");
    expect(result.stderr).toContain("turnCount=2, 10");
  });

  it("🔴【測る点が減った側】基準値に在って実測に無い会話長が在れば exit 2", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured({ rows: [makeRow({ turnCount: 2, fillerPairs: 0 })] });
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("基準値に在って実測に無い");
    expect(result.stderr).toContain("turnCount=10");
  });

  it("🔴【退行の門は壊れていない】集合が一致して退行が在れば exit 1（exit 2 に混ぜない）", () => {
    const baseline = baselineFrom(makeMeasured());
    const measured = makeMeasured();
    measured.rows[0].mnemoraShareOfNaiveChars = 5;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("退行した");
  });

  it("【通したい側】集合が一致して退行が無ければ exit 0", () => {
    const measured = makeMeasured();
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(measured)),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("判定不能");
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
