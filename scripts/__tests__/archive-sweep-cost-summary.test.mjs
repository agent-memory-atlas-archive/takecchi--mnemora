import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/archive-sweep-cost-summary.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`consolidation-cost-summary.test.mjs` と同じ判断)——
 * `archive-sweep-cost-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・exit code)はここでしか測れない。
 *
 * DB は要求しない——このスクリプトは JSON ファイル1〜2個を読むだけである。
 *
 * ⛔ `examples/chat/archive-sweep-baseline.json` はまだコミットされていない。ここで使う
 * measured/baseline はすべてこの歯の中で組み立てたインライン fixture である。
 */

const script = fileURLToPath(new URL("../archive-sweep-cost-summary.mjs", import.meta.url));

function makeProbe(overrides = {}) {
  return {
    probeId: "color",
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    goldRank: 1,
    recalledActiveShare: 0.2,
    omittedArchivedCount: 0,
    omittedKinds: [],
    budgetExceeded: false,
    ...overrides,
  };
}

function makeMean(overrides = {}) {
  return {
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    recalledActiveShare: 0.2,
    omittedArchivedCount: 0,
    goldRank: 1,
    goldRankExcludedCount: 0,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    activeCount: 10,
    supersededCount: 0,
    archivedCount: 0,
    activeContentChars: 500,
    activeContentTokens: 120,
    activeDigestChars: 200,
    activeDigestTokens: 60,
    allContentChars: 500,
    ...overrides,
  };
}

function makePhase(overrides = {}) {
  return {
    store: makeStore(overrides.store),
    recall: {
      unbudgeted: { probes: [makeProbe()], mean: makeMean() },
      budgeted: [{ budgetTokens: 32, probes: [makeProbe()], mean: makeMean() }],
    },
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    probeCount: 1,
    haystackSize: 6,
    halfLifeHours: 1,
    budgetLadder: [32],
    recallLimit: 50,
    sweep: { supported: true, limit: 1000, archivedCount: 6, reachedLimit: false },
    before: makePhase({ store: makeStore({ archivedCount: 0 }) }),
    after: makePhase({ store: makeStore({ archivedCount: 6 }) }),
    ...overrides,
  };
}

function makeBaselinePhase(overrides = {}) {
  return {
    store: makeStore(overrides.store),
    recall: {
      unbudgeted: { mean: makeMean() },
      budgeted: [{ budgetTokens: 32, mean: makeMean() }],
    },
  };
}

function makeBaseline(overrides = {}) {
  const measured = makeMeasured(overrides);
  return {
    ...measured,
    before: overrides.before ?? makeBaselinePhase({ store: makeStore({ archivedCount: 0 }) }),
    after: overrides.after ?? makeBaselinePhase({ store: makeStore({ archivedCount: 6 }) }),
  };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "archive-sweep-cost-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("archive-sweep-cost-summary.mjs(子プロセスで起動)", () => {
  it("--measured だけを渡すと exit 0 で、差分節を出さない", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
  });

  it("基準値と一致するときは exit 0 で「一致」と出す", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const baselinePath = writeJson("baseline.json", makeBaseline());
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)。");
  });

  it("🔴 基準値と相違するときも exit 0(門ではないことをここで固定する。ADR 0088 §2.1)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const before = makeBaselinePhase({ store: makeStore({ activeCount: 999 }) });
    const baselinePath = writeJson("baseline.json", makeBaseline({ before }));
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した箇所がある");
    expect(result.stdout).toContain("store.activeCount");
  });

  it("weights_unavailable な measured でも exit 0", () => {
    const measuredPath = writeJson("measured.json", {
      status: "weights_unavailable",
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    const result = run(["--measured", measuredPath]);
    expect(result.status, result.stderr).toBe(0);
  });

  it("🔴 weights_unavailable ＋ --baseline でも exit 0 で、比較を1つも出さない", () => {
    const measuredPath = writeJson("measured.json", {
      status: "weights_unavailable",
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    const baselinePath = writeJson("baseline.json", makeBaseline());
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
  });

  it("sweep の内訳・読み方の注意書きが出る", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.stdout).toContain("sweep: supported=true");
    expect(result.stdout).toContain("probe 7件");
    expect(result.stdout).toContain("halfLifeHours");
  });

  it("退化検出の節が出る", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.stdout).toContain("退化検出");
  });

  it("--measured を渡さないと非0", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON(構文エラー)だと非0", () => {
    const measuredPath = writeJson("broken.json", "{ this is not json");
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured の必須項目が無いと非0(壊れた入力=赤)", () => {
    const measured = makeMeasured();
    delete measured.llmMode;
    const measuredPath = writeJson("missing-field.json", measured);
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("llmMode");
  });

  it("--measured の before.store に必須項目が無いと非0", () => {
    const before = makePhase();
    delete before.store.activeCount;
    const measuredPath = writeJson("missing-store-field.json", makeMeasured({ before }));
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("activeCount");
  });

  it("--baseline を指定してそれが読めないと非0(baseline も「入力」である)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run([
      "--measured",
      measuredPath,
      "--baseline",
      join(tmpdir(), "does-not-exist-baseline-12345.json"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("ADR 0123: before.usageChars だけが基準値と違っても exit 0 で「一致」のまま、値は表示される", () => {
    const before = makePhase();
    before.recall.unbudgeted.mean.usageChars = 99999;
    const measuredPath = writeJson("measured.json", makeMeasured({ before }));
    const baselinePath = writeJson("baseline.json", makeBaseline());
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)。");
    expect(result.stdout).toContain("before 段の usageChars 系");
    expect(result.stdout).toContain("99999");
  });

  it("⭐ ADR 0123: after.usageChars が基準値と違えば「相違した箇所がある」を出す(除外は before 限定)", () => {
    const after = makePhase();
    after.recall.unbudgeted.mean.usageChars = 99999;
    const measuredPath = writeJson("measured.json", makeMeasured({ after }));
    const baselinePath = writeJson("baseline.json", makeBaseline());
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した箇所がある");
    expect(result.stdout).toContain("recall.unbudgeted.mean.usageChars");
  });

  it("--baseline の status が measured でないと非0(基準値は常に measured のはず)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const baselinePath = writeJson("baseline.json", {
      status: "weights_unavailable",
      detail: "x",
    });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).not.toBe(0);
  });
});
