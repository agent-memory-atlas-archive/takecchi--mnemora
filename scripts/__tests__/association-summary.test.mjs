import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/association-summary.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`scripts/__tests__/identifier-probe-summary.test.mjs` と同じ形・
 * 同じ理由)——`association-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・**exit code**)はここでしか測れない。
 *
 * 🔴 **このファイルが固定している線(歯が噛むことを示す)**:
 *
 * 1. **基準値と相違しても exit 0**(⛔ 門ではない。probe 12件は ADR 0033 §3 の規律に
 *    照らして閾値判定に足る母数ではない)。
 * 2. **入力そのものが壊れていれば非0**(JSON が読めない・parse できない・必須項目が
 *    無い・本数が違う・参照整合性が壊れている・`--baseline` が壊れている)。
 *
 * DB もネットワークも要求しない——このスクリプトは JSON ファイルを最大2つ読むだけである。
 */

const script = fileURLToPath(new URL("../association-summary.mjs", import.meta.url));

const PROBE_IDS = [
  ["ascii-project", "ascii-id"],
  ["ascii-printer", "ascii-id"],
  ["ascii-camera", "ascii-id"],
  ["ascii-router", "ascii-id"],
  ["name-meeting", "proper-noun"],
  ["name-trip", "proper-noun"],
  ["name-bank", "proper-noun"],
  ["name-gift", "proper-noun"],
  ["noun-car", "common-noun"],
  ["noun-medicine", "common-noun"],
  ["noun-laptop", "common-noun"],
  ["noun-apartment", "common-noun"],
];

function makeProbe(overrides = {}) {
  return {
    probeId: "ascii-project",
    category: "ascii-id",
    goldRank: null,
    anchorRank: 3,
    distractorRank: 1,
    goldRetrievedVia: null,
    goldAssociationOf: null,
    goldAnchoredOnProbeAnchor: false,
    returnedCount: 10,
    memoryChars: 360,
    associationChars: 0,
    hit1: false,
    hit10: false,
    goldReturned: false,
    reciprocalRank: 0,
    stageSkipped: null,
    associationFrame: [],
    repeatFrameIdentical: true,
    repeatGoldRankSame: true,
    ...overrides,
  };
}

function makeOffProbes() {
  return PROBE_IDS.map(([probeId, category]) => makeProbe({ probeId, category }));
}

function makeOnProbes(goldCount) {
  return PROBE_IDS.map(([probeId, category], i) => {
    if (i < goldCount) {
      return makeProbe({
        probeId,
        category,
        goldRank: 11 + i,
        goldRetrievedVia: "association",
        goldAssociationOf: probeId,
        goldAnchoredOnProbeAnchor: true,
        goldReturned: true,
        associationChars: 90,
        reciprocalRank: 1 / (11 + i),
        associationFrame: [
          {
            externalId: `assoc-gold-${probeId}`,
            rank: 11,
            role: "own-gold",
            anchorExternalId: `assoc-anchor-${probeId}`,
          },
        ],
      });
    }
    return makeProbe({
      probeId,
      category,
      associationFrame: [
        {
          externalId: `assoc-filler-000${i}`,
          rank: 11,
          role: "haystack",
          anchorExternalId: `assoc-anchor-${probeId}`,
        },
      ],
    });
  });
}

function associationFrameRolesOf(probes) {
  const roles = {};
  for (const probe of probes) {
    for (const entry of probe.associationFrame) {
      roles[entry.role] = (roles[entry.role] ?? 0) + 1;
    }
  }
  return roles;
}

function makeArm(overrides = {}) {
  return {
    armLabel: "off: 連想枠なし（既定の recall）",
    associationEnabled: false,
    associationMaxCount: null,
    probeCount: 12,
    ingestedCount: 96,
    goldReturnedCount: 0,
    hit1Count: 0,
    hit10Count: 0,
    goldViaAssociationCount: 0,
    mrr: 0,
    returnedMemoryTotal: 120,
    memoryCharsTotal: 4321,
    associationCharsTotal: 0,
    stageSkippedReasons: {},
    associationFrameRoles: {},
    repeatFrameIdenticalCount: 12,
    repeatGoldRankSameCount: 12,
    probes: makeOffProbes(),
    ...overrides,
  };
}

function makeOnArm(maxCount, goldCount, extra = {}) {
  const probes = makeOnProbes(goldCount);
  const mrr = probes.reduce((sum, p) => sum + p.reciprocalRank, 0) / probes.length;
  return makeArm({
    armLabel: `on: 連想枠あり（maxCount=${maxCount}）`,
    associationEnabled: true,
    associationMaxCount: maxCount,
    goldReturnedCount: goldCount,
    goldViaAssociationCount: goldCount,
    mrr,
    memoryCharsTotal: 4321 + goldCount * 90,
    associationCharsTotal: goldCount * 90,
    associationFrameRoles: associationFrameRolesOf(probes),
    probes,
    ...extra,
  });
}

function makeMeasured(overrides = {}) {
  const offArm = makeArm();
  const on3Arm = makeOnArm(3, 9);
  const on5Arm = makeOnArm(5, 9);
  const on10Arm = makeOnArm(10, 9);
  const buildDelta = (againstArm) => ({
    baselineArmLabel: offArm.armLabel,
    againstArmLabel: againstArm.armLabel,
    goldReturnedCount: againstArm.goldReturnedCount - offArm.goldReturnedCount,
    goldViaAssociationCount: againstArm.goldViaAssociationCount - offArm.goldViaAssociationCount,
    mrr: againstArm.mrr - offArm.mrr,
    hit10Count: againstArm.hit10Count - offArm.hit10Count,
    memoryCharsTotal: againstArm.memoryCharsTotal - offArm.memoryCharsTotal,
    charsPerAdditionalGold:
      (againstArm.memoryCharsTotal - offArm.memoryCharsTotal) /
      (againstArm.goldReturnedCount - offArm.goldReturnedCount),
  });
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-16T00:00:00.000Z",
    commit: "abc123",
    embedding: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    llmMode: "deterministic",
    probeCount: 12,
    haystackSize: 60,
    recallLimit: 10,
    warmup: { ok: true, detail: null },
    arms: [offArm, on3Arm, on5Arm, on10Arm],
    deltas: [buildDelta(on3Arm), buildDelta(on5Arm), buildDelta(on10Arm)],
    ...overrides,
  };
}

function baselineFrom(measured) {
  return {
    embedding: structuredClone(measured.embedding),
    llmMode: measured.llmMode,
    arms: measured.arms.map((arm) => ({
      armLabel: arm.armLabel,
      associationEnabled: arm.associationEnabled,
      associationMaxCount: arm.associationMaxCount,
      probeCount: arm.probeCount,
      ingestedCount: arm.ingestedCount,
      goldReturnedCount: arm.goldReturnedCount,
      hit1Count: arm.hit1Count,
      hit10Count: arm.hit10Count,
      goldViaAssociationCount: arm.goldViaAssociationCount,
      mrr: arm.mrr,
      returnedMemoryTotal: arm.returnedMemoryTotal,
      memoryCharsTotal: arm.memoryCharsTotal,
      associationCharsTotal: arm.associationCharsTotal,
      repeatFrameIdenticalCount: arm.repeatFrameIdenticalCount,
      repeatGoldRankSameCount: arm.repeatGoldRankSameCount,
    })),
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
  workDir ??= mkdtempSync(join(tmpdir(), "association-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("association-summary.mjs（子プロセスで起動）", () => {
  it("--measured だけを渡すと exit 0 で、Markdown を出す", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("association-probes");
    expect(result.stdout).toContain("off: 連想枠なし");
    expect(result.stdout).toContain("基準値ファイルが渡されていない");
  });

  it("基準値と一致するときも exit 0", () => {
    const measured = makeMeasured();
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(measured)),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("基準値との差");
  });

  it("🔴 基準値と相違するときも exit 0（⛔ 門ではないことをここで固定する）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.arms[1].hit1Count = 99;
    baseline.arms[1].mrr = 0.99;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("基準値との差");
  });

  it("🔴 warmup.ok が false でも exit 0 で、先頭に警告が出る", () => {
    const measured = makeMeasured({ warmup: { ok: false, detail: "simulated failure" } });
    const result = run(["--measured", writeJson("measured.json", measured)]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("🔴 warmup に失敗している");
    expect(result.stdout).toContain("simulated failure");
  });

  it("--measured を渡さないと非0", () => {
    expect(run([]).status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-association-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON（構文エラー）だと非0", () => {
    const result = run(["--measured", writeJson("broken.json", "{ これは JSON ではない")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured に必須項目が無いと非0", () => {
    const measured = makeMeasured();
    delete measured.arms[0].hit1Count;
    const result = run(["--measured", writeJson("missing-field.json", measured)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("hit1Count");
  });

  it("--measured の arms が4本でないと非0", () => {
    const measured = makeMeasured();
    measured.arms.pop();
    const result = run(["--measured", writeJson("bad-arms.json", measured)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("arms の本数");
  });

  it("--baseline を指定してそれが読めないと非0（baseline も『入力』である）", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      join(tmpdir(), "does-not-exist-association-baseline-12345.json"),
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
});
