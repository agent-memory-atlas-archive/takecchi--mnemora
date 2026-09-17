import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateBaseline, validateMeasured } from "../compare-summary-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `example-chat` ジョブが、実際に
 * `scripts/compare-summary.mjs` へ、`--measured` と `--baseline` の両方を渡して
 * 配線されていること（Issue #242 / ADR 0133）。**
 *
 * ⚠ **これは `compare-summary.test.mjs`/`compare-summary-lib.test.mjs` の重複ではない**
 * （`ci-yml-time-term-wiring.test.mjs` の docstring と同じ理由）。その2本は
 * **入力を自分で作って**要約の中身と exit code を測る——**どちらも `ci.yml` を
 * 1バイトも読まない。**⟹ 誰かが `ci.yml` から `--baseline` を落としても、パスを
 * 打ち間違えても、`MNEMORA_COMPARE_JSON` の書き先と `--measured` の読み先をずらしても、
 * **その2本は緑のまま通る。**この歯だけが `ci.yml` を入力に取る。
 *
 * ⚠ **`example-chat` ジョブは `retrieval-quality`/`identifier-probes` 等と違い、
 * 単一目的のジョブではない。**`compare` の前段に Postgres の拡張作成・
 * マイグレーション・`test:db`（本物の DB に対する observe→recall の往復検査）が
 * 同居する。この歯は `MNEMORA_COMPARE_JSON` を渡す step を探して特定するので、
 * 前段の step が増減しても影響を受けない。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `ci-yml-time-term-wiring.test.mjs` と同じ判断で、歯のために YAML パーサの
 * 依存を足していない（依存追加はオーナー専権。`docs/autonomy.md`）。
 * **だからこの歯は書き方の変更に弱い。**壊れたときは「配線が変わった」か
 * 「書き方が変わった」かを見て、**配線が変わっていないなら取り出し方のほうを
 * 直すこと（歯を消さないこと）。**
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "example-chat";

/** `jobs:` の下の1ジョブを切り出す（`ci-yml-time-term-wiring.test.mjs` と同じ形）。 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。` +
        "example-chat ジョブが消えたか、名前が変わったか、インデントが変わった。",
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

const benchStep = steps.find((step) => step.env.MNEMORA_COMPARE_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("compare-summary.mjs"));
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
      "ci.yml の example-chat ジョブに MNEMORA_COMPARE_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_COMPARE_JSON;
}

/** `--baseline <path>` を yml から読む（引用符あり・なしの両方を拾う）。 */
function summaryStepBaselinePath() {
  const matched = /--baseline\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
  return matched ? (matched[1] ?? matched[2]) : undefined;
}

function runSummaryStepFromWorkflow(measured) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の example-chat ジョブに compare-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-compare-wiring-"));
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

/** 基準値ファイル（本物）。差分の有無を作り分けるための土台に使う。 */
const baselineRelativePath = "examples/chat/compare-baseline.json";
const baseline = JSON.parse(readFileSync(join(repoRoot, baselineRelativePath), "utf8"));

/**
 * 本物の基準値ファイルから、実測 JSON（`CompareRunJson` の形）を組み立てる。
 * `rows` は基準値のものをそのまま複製する——順番に依存しない
 * （`diffRow` は `turnCount` で突き合わせる）。
 */
function measuredFromBaseline() {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-15T00:00:00.000Z",
    commit: "0".repeat(40),
    llmMode: baseline.llmMode,
    embeddingMode: baseline.embeddingMode,
    rowCount: baseline.rowCount,
    rows: structuredClone(baseline.rows),
  };
}

describe("ci.yml の example-chat ジョブの compare 配線", () => {
  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("🔴 要約の段が --baseline をコミット済みの基準値ファイルへ渡している（ADR 0133）", () => {
    // ⭐ **これが「輪が閉じている」ことの固定点。**この行が消えると、値が動いても
    // 誰も気づかず、誰も基準値を更新せず、新しい値が PR の diff に現れなくなる
    // （ADR 0088 §3 / ADR 0094 §8 / ADR 0121 と同じ理由）。
    expect(summaryStepBaselinePath(), "要約の段に --baseline の指定が無い").toBe(
      baselineRelativePath,
    );
  });

  it("🔴 --baseline が指すファイルが、実際に validateBaseline を通る", () => {
    const result = validateBaseline(baseline);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("🔴 基準値から組み立てた実測 JSON が validateMeasured を通る（2つの形が食い違っていない）", () => {
    const result = validateMeasured(measuredFromBaseline());
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("基準値と一致していれば、その旨が Job Summary に出る（1行で黙る）", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("一致(差分なし)");
    expect(result.summary).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("🔴 mnemoraShareOfNaiveChars が悪化すれば非0（⭐ このジョブは門である。ADR 0133）", () => {
    const measured = measuredFromBaseline();
    const first = measured.rows[0];
    first.mnemoraShareOfNaiveChars = first.mnemoraShareOfNaiveChars + 1;
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status).not.toBe(0);
    expect(result.summary).toContain(`### turnCount = ${first.turnCount} 🔴 退行`);
    expect(result.summary).toContain("mnemoraShareOfNaiveChars");
  });

  it("🔴 実測から会話長が1つ消えたら、この段は exit 2（判定不能）で非0になる（Issue #477）", () => {
    // ⭐ この歯だけが `ci.yml` を入力に取る——「比較していない」が、実際の CI の段で
    // 緑にならないことを、本物のコマンド行で測る。
    const measured = measuredFromBaseline();
    const dropped = measured.rows.pop();
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status).toBe(2);
    expect(result.summary).toContain("判定不能(比較していない会話長が在る)");
    expect(result.stderr).toContain(`turnCount=${dropped.turnCount}`);
  });

  it("mnemoraShareOfNaiveChars が改善(減少)しただけなら緑のまま", () => {
    const measured = measuredFromBaseline();
    const first = measured.rows[0];
    first.mnemoraShareOfNaiveChars = Math.max(0, first.mnemoraShareOfNaiveChars - 0.001);
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  it("要約段は実際に走り、Job Summary に会話ターン数と mnemora/naive 比を出す", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("mnemora/naive");
  });

  it("🔴 実測 JSON が壊れていたら要約段は非0で落ちる（bench が壊れた＝赤、値が動いた＝赤ではない）", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });

  it("🔴 summary 段に if: always() の実キーが付いている（compare が落ちても Job Summary は残す）", () => {
    expect(summaryStep, "compare-summary.mjs を打つ段が無い").toBeDefined();
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  it("🔴 artifact 段に if: always() の実キーが付いている（compare が落ちても成果物は残す）", () => {
    expect(artifactStep, "成果物を upload する段が無い").toBeDefined();
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  it("ジョブに timeout-minutes が設定されていなくても、少なくとも他ジョブと矛盾しない構造である", () => {
    // ⚠ example-chat ジョブは既存のまま timeout-minutes を持たない（このPRの範囲外の
    // 既存挙動）。この歯は将来 timeout-minutes を足す変更が来ても壊れないよう、
    // 存在を要求しない。
    expect(jobBlock).toContain("runs-on: ubuntu-latest");
  });

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

describe("コメント潰しが example-chat ジョブの対象範囲で「扱えない」形に当たっていないこと", () => {
  it("compare 関連の段(name 段)に unhandled が無い", () => {
    stepBlockCommentUnhandled.length = 0;
    for (const step of [summaryStep, artifactStep].filter(Boolean)) {
      extractStepBlock(step.name);
    }
    expect(stepBlockCommentUnhandled).toEqual([]);
  });
});
