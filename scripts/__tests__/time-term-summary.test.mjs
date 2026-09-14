import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/time-term-summary.mjs` の歯。**本物のスクリプトを子プロセスとして実際に
 * 起動する**(`identifier-probe-summary.test.mjs`/`retrieval-quality-summary.test.mjs`と
 * 同じ形・同じ理由)——`time-term-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・**exit code**)はここでしか測れない。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **基準値と相違しても exit 0**(⛔ 門ではない。ADR 0058 / ADR 0088 §2.1)。
 * 2. **`--baseline` を省略しても exit 0**——基準値ファイルはまだコミットされていない
 *    (本 PR の時点)ので、これが動かないと CI の summary 段そのものが組めない。
 * 3. **入力そのものが壊れていれば非0**(JSON が読めない・parse できない・probes が
 *    欠ける・outcome が未知の値・`--baseline` が壊れている)。
 *
 * DB もネットワークも要求しない——このスクリプトは JSON ファイルを最大2つ読むだけである。
 */

const script = fileURLToPath(new URL("../time-term-summary.mjs", import.meta.url));

function makeProbe(overrides = {}) {
  return {
    probeId: "half-life",
    outcome: "newer-ranked-higher",
    totalInScope: 2,
    omittedKinds: [],
    similarityGapWithinPair: 0,
    freshnessGapWithinPair: null,
    freshnessRatio: 0.5,
    decayRatio: null,
    totalRatio: 0.5,
    newer: null,
    older: null,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "abc123",
    armLabel: "time-term",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    probeCount: 2,
    probes: [
      makeProbe({ probeId: "half-life", outcome: "newer-ranked-higher" }),
      makeProbe({ probeId: "same-occurred-at", outcome: "tied", totalRatio: 1, freshnessRatio: 1 }),
    ],
    ...overrides,
  };
}

function baselineFrom(measured) {
  return { probes: measured.probes.map((p) => structuredClone(p)) };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "time-term-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("time-term-summary.mjs（子プロセスで起動）", () => {
  it("--measured だけを渡すと exit 0 で、「基準値がまだ無い」旨を出す", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("## 基準値との差分");
    expect(result.stdout).toContain("基準値ファイルがまだ無い");
    expect(result.stdout).toContain("half-life");
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

  it("🔴 基準値と相違するときも exit 0（⛔ 門ではないことをここで固定する）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.probes[0].outcome = "tied"; // 「時間項が順位を動かさなくなった」に相当
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した probe が 1 件ある");
    expect(result.stdout).toContain("outcome");
  });

  it("🔴 連続値だけが動いても exit 0 で『一致』のまま（比較対象に入れていない）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.probes[0].freshnessRatio = 0.500001;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)");
  });

  it("--measured を渡さないと非0", () => {
    expect(run([]).status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-time-term-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON（構文エラー）だと非0", () => {
    const result = run(["--measured", writeJson("broken.json", "{ これは JSON ではない")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured に probes が無いと非0", () => {
    const result = run(["--measured", writeJson("no-probes.json", { armLabel: "time-term" })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("probes");
  });

  it("--measured の outcome が未知の値だと非0", () => {
    const measured = makeMeasured();
    measured.probes[0].outcome = "とても良かった";
    const result = run(["--measured", writeJson("unknown-outcome.json", measured)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outcome");
  });

  it("--baseline を指定してそれが読めないと非0（baseline も『入力』である）", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      join(tmpdir(), "does-not-exist-time-term-baseline-12345.json"),
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

  it("--baseline の probes に probeId が無いと非0", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    delete baseline.probes[0].probeId;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("probeId");
  });
});
