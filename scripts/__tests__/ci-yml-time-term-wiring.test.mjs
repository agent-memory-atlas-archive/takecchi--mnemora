import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `time-term` ジョブが、実際に
 * `scripts/time-term-summary.mjs` へ `--measured` を渡して配線されていること
 * （Issue #217）。**
 *
 * ⚠ **これは `time-term-summary.test.mjs`/`time-term-summary-lib.test.mjs` の
 * 重複ではない**（`ci-yml-identifier-probes-wiring.test.mjs` の docstring と同じ理由）。
 * その2本は**入力を自分で作って**要約の中身と exit code を測る——**どちらも `ci.yml` を
 * 1バイトも読まない。**⟹ 誰かが `ci.yml` から測定段の JSON 書き先をずらしても、
 * summary 段の `--measured` の読み先をずらしても、**その2本は緑のまま通る。**
 *
 * ⚠ **`--baseline` はまだ渡していない**（`examples/chat/time-term-baseline.json` が
 * 存在しないため。冒頭の ADR/PR 参照）。⟹ この歯は「`--baseline` を渡していないこと」
 * ではなく「`--measured` が正しく繋がっていること」を固定する。基準値ファイルを
 * 後続 PR で足すときは、`identifier-probes`/`retrieval-quality`/`consolidation-cost` の
 * 対応する歯（`--baseline` の配線を固定している行）をこのファイルにも足すこと。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `ci-yml-identifier-probes-wiring.test.mjs` と同じ判断で、歯のために YAML パーサの
 * 依存を足していない（依存追加はオーナー専権。`docs/autonomy.md`）。
 * **だからこの歯は書き方の変更に弱い。**壊れたときは「配線が変わった」か
 * 「書き方が変わった」かを見て、**配線が変わっていないなら取り出し方のほうを
 * 直すこと（歯を消さないこと）。**
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "time-term";

/** `jobs:` の下の1ジョブを切り出す（`ci-yml-identifier-probes-wiring.test.mjs` と同じ形）。 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。` +
        "Issue #217 が足したジョブが消えたか、名前が変わったか、インデントが変わった。",
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** `steps:` を段へ切り分け、各段の `name`/`env`/`run` だけを取り出す。 */
function parseSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error(`ci.yml の ${JOB_ID} ジョブに \`    steps:\` が無い`);
  }
  const steps = [];
  let current;
  let mode = "none";

  const flush = () => {
    if (current) {
      steps.push({
        name: current.name,
        env: current.env,
        run: current.runLines.map((l) => l.replace(/^ {10}/, "")).join("\n"),
      });
    }
  };

  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatched = /^ {6}- name: (.*)$/.exec(line);
    if (nameMatched) {
      flush();
      current = { name: nameMatched[1], env: {}, runLines: [] };
      mode = "none";
      continue;
    }
    if (!current) {
      continue;
    }
    if (line === "        env:") {
      mode = "env";
      continue;
    }
    if (/^ {8}run: \|/.test(line)) {
      mode = "run";
      continue;
    }
    const inlineRun = /^ {8}run: (.+)$/.exec(line);
    if (inlineRun) {
      current.runLines.push(`          ${inlineRun[1]}`);
      mode = "none";
      continue;
    }
    if (mode === "env") {
      const envMatched = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (envMatched) {
        current.env[envMatched[1]] = envMatched[2].trim();
        continue;
      }
      mode = "none";
    }
    if (mode === "run") {
      if (line.trim() === "" || /^ {10}/.test(line)) {
        current.runLines.push(line);
        continue;
      }
      mode = "none";
    }
  }
  flush();
  return steps;
}

const jobBlock = extractJob(workflow, JOB_ID);
const steps = parseSteps(jobBlock);

const benchStep = steps.find((step) => step.env.MNEMORA_TIME_TERM_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("time-term-summary.mjs"));
const artifactStep = steps.find((step) => step.name.includes("成果物として残す"));

/** @type {{ stepName: string, unhandled: { lineNumber: number, reason: string, line: string }[] }[]} */
const stepBlockCommentUnhandled = [];

/** ある段の生テキストを切り出す（`if:`/`uses:`/`with:` を読みたいとき用）。コメントは潰す。 */
function extractStepBlock(stepName) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {6}- name:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const raw = lines.slice(start, end).join("\n");
  const { text, unhandled } = blankOutWorkflowComments(raw);
  if (unhandled.length > 0) {
    stepBlockCommentUnhandled.push({ stepName, unhandled });
  }
  return text;
}

function blockDeclaresAlways(blankedBlock) {
  return /^\s*if:\s*always\(\)\s*$/m.test(blankedBlock);
}

function substituteWorkspace(text, workspace) {
  const replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (replaced.includes("${{")) {
    throw new Error(
      `この歯が解釈できない GitHub Actions の式が残っている: ${replaced}。` +
        "式が増えたなら、この歯の置き換えのほうを足すこと（歯を消さないこと）。",
    );
  }
  return replaced;
}

function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の time-term ジョブに MNEMORA_TIME_TERM_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_TIME_TERM_JSON;
}

function runSummaryStepFromWorkflow(measured) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の time-term ジョブに time-term-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-tt-wiring-"));
  try {
    const script = substituteWorkspace(summaryStep.run, workspace);
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), workspace);
    writeFileSync(
      measuredPath,
      typeof measured === "string" ? measured : `${JSON.stringify(measured, null, 2)}\n`,
      "utf8",
    );
    const summaryPath = join(workspace, "step-summary.md");
    writeFileSync(summaryPath, "", "utf8");
    const result = spawnSync("bash", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });
    return {
      status: result.status ?? -1,
      summary: readFileSync(summaryPath, "utf8"),
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

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

function makeMeasured() {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "0".repeat(40),
    armLabel: "time-term",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    probeCount: 1,
    probes: [makeProbe()],
  };
}

describe("ci.yml の time-term ジョブの配線", () => {
  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("⚠ --baseline はまだ渡していない（基準値ファイルが本 PR には無いため）", () => {
    // このジョブの意図した現状を固定する。基準値ファイルを足すときは、この歯を
    // identifier-probes/retrieval-quality/consolidation-cost 側の対応する歯
    // （--baseline の配線を固定している行）に置き換えること。
    expect(summaryStep?.run ?? "").not.toContain("--baseline");
  });

  it("要約段は実際に走り、Job Summary に probe と outcome を出す", () => {
    const result = runSummaryStepFromWorkflow(makeMeasured());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("half-life");
    expect(result.summary).toContain("newer-ranked-higher");
    expect(result.summary).toContain("基準値ファイルがまだ無い");
  });

  it("🔴 実測 JSON が壊れていたら要約段は非0で落ちる（bench が壊れた＝赤、outcome が動いた＝赤ではない）", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });

  it("ジョブに timeout-minutes が設定されている（既定 360 分で刺さらない）", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  it("🔴 summary 段に if: always() の実キーが付いている（measure が落ちても Job Summary は残す）", () => {
    expect(summaryStep, "time-term-summary.mjs を打つ段が無い").toBeDefined();
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  it("🔴 artifact 段に if: always() の実キーが付いている（measure が落ちても成果物は残す）", () => {
    expect(artifactStep, "成果物を upload する段が無い").toBeDefined();
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  /**
   * `ci-yml-identifier-probes-wiring.test.mjs` の同名の歯と同じ理由
   * （#127 が action を node24 の版へ上げたとき、後から足したジョブだけが
   * 取り残される形が実際に一度起きた）。
   */
  const NODE24_MIN_MAJOR = {
    "actions/checkout": 6,
    "actions/setup-node": 6,
    "actions/upload-artifact": 6,
    "actions/cache": 5,
  };

  function usesInBlock(block) {
    return [...block.matchAll(/^\s*uses: (actions\/[a-z-]+)@v(\d+)$/gm)].map((match) => ({
      action: match[1],
      major: Number(match[2]),
    }));
  }

  it("🔴 このジョブの action が ci.yml の他のジョブに後れを取っていない（#127 型の取り残し）", () => {
    const mine = usesInBlock(jobBlock);
    expect(mine.length).toBeGreaterThan(0);
    const fileWide = usesInBlock(workflow);
    for (const { action, major } of mine) {
      const maxMajor = Math.max(
        ...fileWide.filter((used) => used.action === action).map((used) => used.major),
      );
      expect(
        major,
        `${action}: このジョブは @v${major} だが、ci.yml の他所は @v${maxMajor} を使っている`,
      ).toBe(maxMajor);
    }
  });

  it("🔴 このジョブの action が node24 の版である（2026-09-23 に runner から Node 20 が消える）", () => {
    const mine = usesInBlock(jobBlock);
    expect(mine.length).toBeGreaterThan(0);
    for (const { action, major } of mine) {
      const min = NODE24_MIN_MAJOR[action];
      expect(min, `${action} の node24 下限が表に無い（引き直して表を更新すること）`).toBeDefined();
      expect(
        major,
        `${action}@v${major} は node24 だと確認できている下限 v${min} より古い`,
      ).toBeGreaterThanOrEqual(min);
    }
  });
});

describe("コメント潰しが time-term ジョブの対象範囲で「扱えない」形に当たっていないこと", () => {
  it("time-term ジョブの全段(name 段)に unhandled が無い", () => {
    stepBlockCommentUnhandled.length = 0;
    for (const step of steps) {
      extractStepBlock(step.name);
    }
    expect(stepBlockCommentUnhandled).toEqual([]);
  });
});
