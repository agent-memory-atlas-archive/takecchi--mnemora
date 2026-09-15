import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMeasured } from "../association-summary-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`.github/workflows/ci.yml` の `association-probes` ジョブ(Issue #291)が、実際に
 * `scripts/association-summary.mjs` へ、bench が書く JSON と同じパスで `--measured` を
 * 渡していること**、そして **`MNEMORA_ASSOCIATION_JSON`(bench の書き先)と artifact の
 * `path`、`MNEMORA_LOCAL_EMBEDDING_CACHE_DIR`(モデル重みの置き場所)と
 * `actions/cache` の `path` が、それぞれ同じ場所を指していること**。
 *
 * ⚠ **これは `association-summary.test.mjs`/`association-summary-lib.test.mjs` の
 * 重複ではない**(`ci-yml-identifier-probes-wiring.test.mjs` の docstring と同じ理由)。
 * その2本は**入力を自分で作って**要約の中身と exit code を測る——**どちらも `ci.yml` を
 * 1バイトも読まない。**⟹ 誰かが `ci.yml` から summary ステップの `--measured` を
 * 打ち間違えても、`MNEMORA_ASSOCIATION_JSON` の書き先と artifact の `path` をずらしても、
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` とキャッシュの `path` をずらしても、**その2本は
 * 緑のまま通る。**⟹ **配線が閉じていることを、配線の側で固定する。**
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**
 * `ci-yml-identifier-probes-wiring.test.mjs`/`ci-yml-retrieval-wiring.test.mjs` と
 * 同じ判断で、歯のために YAML パーサの依存を足していない(依存追加はオーナー専権。
 * `docs/autonomy.md`)。**だからこの歯は書き方の変更に弱い。**壊れたときは
 * 「配線が変わった」か「書き方が変わった」かを見て、**配線が変わっていないなら
 * 取り出し方のほうを直すこと(歯を消さないこと)。**
 *
 * ⚠ **`examples/chat/association-baseline.json` はまだ存在しない**(Issue #291。
 * このベンチは CI で1度も実測されていないため、数字をでっち上げずに置ける基準値が
 * 無い)。⟹ この歯は `--baseline` の配線を検査しない——`identifier-probes` ジョブの
 * 歯と違う点はここだけである。基準値ファイルができたら、`ci.yml` 側に `--baseline`
 * を足し、この歯にも `identifier-probe-summary` 型の baseline 検査を追加すること。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "association-probes";

/**
 * `jobs:` の下の1ジョブ(`  <id>:` から、次の同じ深さの `  <id>:` まで)を切り出す。
 *
 * @param {string} yaml
 * @param {string} jobId
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。` +
        "Issue #291 が足したジョブが消えたか、名前が変わったか、インデントが変わった。",
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

/**
 * `steps:` を段へ切り分け、各段の `name` / `env` / `run` だけを取り出す
 * (`ci-yml-identifier-probes-wiring.test.mjs` の `parseSteps` と同じ形)。
 *
 * @param {string} jobBlock
 * @returns {{ name: string, env: Record<string, string>, run: string }[]}
 */
function parseSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error(`ci.yml の ${JOB_ID} ジョブに \`    steps:\` が無い`);
  }
  /** @type {{ name: string, env: Record<string, string>, run: string }[]} */
  const steps = [];
  /** @type {{ name: string, env: Record<string, string>, runLines: string[] } | undefined} */
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
    // `- name: 値` は引用符付き("…")のことも無しのこともある——両方拾う。
    const nameMatched = /^ {6}- name: (?:"([^"]*)"|(.*))$/.exec(line);
    if (nameMatched) {
      flush();
      current = { name: nameMatched[1] ?? nameMatched[2], env: {}, runLines: [] };
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

const benchStep = steps.find((step) => step.env.MNEMORA_ASSOCIATION_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("association-summary.mjs"));
const artifactStep = steps.find((step) => step.name.includes("成果物として残す"));
const cacheStep = steps.find((step) => step.name.includes("キャッシュ"));

/**
 * ある段の生テキスト(`- name: <name>` から次の段の `- name:` まで)を切り出し、
 * コメントを空白へ潰したものを返す(`ci-yml-identifier-probes-wiring.test.mjs` の
 * `extractStepBlock` と同じ形・同じ理由——実キーと地の文コメントの引用を区別する)。
 *
 * @type {{ stepName: string, unhandled: { lineNumber: number, reason: string, line: string }[] }[]}
 */
const stepBlockCommentUnhandled = [];

/**
 * @param {string} stepName
 * @returns {string | undefined}
 */
function extractStepBlock(stepName) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}` || line.trim() === `- name: "${stepName}"`,
  );
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

/** `with:` の `path:`/`key:` を読む(段のブロックはコメントを潰した後のテキスト)。 */
function readWithField(blankedBlock, field) {
  const matched = new RegExp(`^\\s*${field}:\\s*(.+)$`, "m").exec(blankedBlock ?? "");
  return matched ? matched[1].trim() : undefined;
}

function substituteWorkspace(text, workspace) {
  const replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (replaced.includes("${{")) {
    throw new Error(
      `この歯が解釈できない GitHub Actions の式が残っている: ${replaced}。` +
        "式が増えたなら、この歯の置き換えのほうを足すこと(歯を消さないこと)。",
    );
  }
  return replaced;
}

describe("ci.yml の association-probes ジョブの配線(Issue #291)", () => {
  it("ジョブが実在する", () => {
    expect(jobBlock).toBeTruthy();
  });

  it("⭐ bench が JSON を書く先(MNEMORA_ASSOCIATION_JSON)と、要約が読む先(--measured)が同じ場所を指している", () => {
    expect(benchStep, "MNEMORA_ASSOCIATION_JSON を渡す段が無い").toBeDefined();
    expect(summaryStep, "association-summary.mjs を打つ段が無い").toBeDefined();
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStep.env.MNEMORA_ASSOCIATION_JSON);
  });

  it("⭐ MNEMORA_ASSOCIATION_JSON と artifact の path が一致している", () => {
    expect(benchStep, "MNEMORA_ASSOCIATION_JSON を渡す段が無い").toBeDefined();
    expect(artifactStep, "成果物を upload する段が無い").toBeDefined();
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    const artifactPath = readWithField(block, "path");
    expect(artifactPath, "artifact 段に path が無い").toBe(benchStep.env.MNEMORA_ASSOCIATION_JSON);
  });

  it("⭐ MNEMORA_LOCAL_EMBEDDING_CACHE_DIR と actions/cache の path が一致している", () => {
    expect(benchStep, "MNEMORA_LOCAL_EMBEDDING_CACHE_DIR を渡す段が無い").toBeDefined();
    expect(
      benchStep.env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR,
      "bench 段に cache dir が無い",
    ).toBeTruthy();
    expect(cacheStep, "actions/cache の段が無い").toBeDefined();
    const block = extractStepBlock(cacheStep.name);
    expect(block, "cache 段の生テキストが見つからない").toBeDefined();
    const cachePath = readWithField(block, "path");
    expect(cachePath).toBe(benchStep.env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR);
  });

  it("🔴 identifier-probes ジョブと同じキャッシュキーを共有している(同じモデル・同じ dtype)", () => {
    const identifierJobBlock = extractJob(workflow, "identifier-probes");
    const identifierCacheKey = /^\s*key:\s*(\S+)/m.exec(
      identifierJobBlock.split("actions/cache@")[1] ?? "",
    );
    const block = extractStepBlock(cacheStep.name);
    const myCacheKey = readWithField(block, "key");
    expect(myCacheKey).toBeTruthy();
    expect(identifierCacheKey, "identifier-probes 側の cache key を取り出せない").not.toBeNull();
    expect(myCacheKey).toBe(identifierCacheKey[1]);
  });

  it("MNEMORA_EMBEDDING=local を明示している(埋め込みは local 固定)", () => {
    expect(benchStep.env.MNEMORA_EMBEDDING).toBe("local");
  });

  it("⛔ MNEMORA_PROVIDER_SOURCE / OPENAI_API_KEY を渡していない(local embedding は鍵を要求しない)", () => {
    // 🔴 素朴な toContain は使わない——このジョブ自身の地の文コメントが
    // 「なぜこの2つを渡していないか」を説明するために、まさにこの2つの識別子を
    // 引用している(`identifier-probes` ジョブの先例と同じ書き方)。コメントを
    // 潰してから見る(`blankOutWorkflowComments`。実キーとコメントの引用を区別する
    // ため、`ci-yml-identifier-probes-wiring.test.mjs` の `blockDeclaresAlways` と
    // 同じ判断)。
    const { text: blanked } = blankOutWorkflowComments(jobBlock);
    expect(blanked).not.toContain("MNEMORA_PROVIDER_SOURCE");
    expect(blanked).not.toContain("OPENAI_API_KEY");
  });

  it("ジョブに timeout-minutes が設定されている(既定 360 分で刺さらない)", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  it("🔴 bench 段(measure ステップ)に continue-on-error が無い(重み取得失敗はジョブを赤くする仕様)", () => {
    const block = extractStepBlock(benchStep.name);
    expect(block).toBeDefined();
    expect(block).not.toContain("continue-on-error");
  });

  it("🔴 summary 段に if: always() の実キーが付いている(measure が落ちても Job Summary は残す)", () => {
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  it("🔴 artifact 段に if: always() の実キーが付いている(measure が落ちても成果物は残す)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(blockDeclaresAlways(block)).toBe(true);
  });

  it("要約の段が --baseline を渡していない(まだ基準値ファイルが無いため)", () => {
    expect(summaryStep.run).not.toContain("--baseline");
  });

  it("⭐ ジョブ先頭のコメントが「門ではない」ことを明記している", () => {
    expect(jobBlock).toMatch(/門ではない/);
  });

  it("services.postgres が identifier-probes ジョブと同じ値である(認証まわりのずれは postgres-auth-parity 側の関心だが、ここでも直接固定する)", () => {
    const identifierJobBlock = extractJob(workflow, "identifier-probes");
    for (const key of [
      "image: pgvector/pgvector:pg17",
      "POSTGRES_USER: postgres",
      "POSTGRES_PASSWORD: postgres",
      "POSTGRES_DB: mnemora_ci",
      'POSTGRES_INITDB_ARGS: "--encoding=UTF8"',
    ]) {
      expect(jobBlock, key).toContain(key);
      expect(identifierJobBlock, key).toContain(key);
    }
  });

  /**
   * yml から取り出した要約の段を、実際に走らせる(`ci-yml-identifier-probes-wiring
   * .test.mjs` の `runSummaryStepFromWorkflow` と同じ形)。まだ `--baseline` が無いので、
   * ここでは measured JSON の正当性だけを見る。
   */
  function runSummaryStepFromWorkflow(measured) {
    const workspace = mkdtempSync(join(tmpdir(), "mnemora-assoc-wiring-"));
    try {
      const script = substituteWorkspace(summaryStep.run, workspace);
      const measuredPath = substituteWorkspace(benchStep.env.MNEMORA_ASSOCIATION_JSON, workspace);
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

  function makeMinimalMeasured() {
    const makeProbe = ([probeId, category]) => ({
      probeId,
      category,
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
    });
    const makeArm = (armLabel, associationEnabled, associationMaxCount) => ({
      armLabel,
      associationEnabled,
      associationMaxCount,
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
      probes: PROBE_IDS.map(makeProbe),
    });
    const offArm = makeArm("off: 連想枠なし（既定の recall）", false, null);
    const on3Arm = makeArm("on: 連想枠あり（maxCount=3）", true, 3);
    const on5Arm = makeArm("on: 連想枠あり（maxCount=5）", true, 5);
    const on10Arm = makeArm("on: 連想枠あり（maxCount=10）", true, 10);
    return {
      schemaVersion: 1,
      measuredAt: "2026-09-16T00:00:00.000Z",
      commit: "0".repeat(40),
      embedding: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      llmMode: "deterministic",
      probeCount: 12,
      haystackSize: 60,
      recallLimit: 10,
      warmup: { ok: true, detail: null },
      arms: [offArm, on3Arm, on5Arm, on10Arm],
      deltas: [
        {
          baselineArmLabel: offArm.armLabel,
          againstArmLabel: on3Arm.armLabel,
          goldReturnedCount: 0,
          goldViaAssociationCount: 0,
          mrr: 0,
          hit10Count: 0,
          memoryCharsTotal: 0,
          charsPerAdditionalGold: null,
        },
        {
          baselineArmLabel: offArm.armLabel,
          againstArmLabel: on5Arm.armLabel,
          goldReturnedCount: 0,
          goldViaAssociationCount: 0,
          mrr: 0,
          hit10Count: 0,
          memoryCharsTotal: 0,
          charsPerAdditionalGold: null,
        },
        {
          baselineArmLabel: offArm.armLabel,
          againstArmLabel: on10Arm.armLabel,
          goldReturnedCount: 0,
          goldViaAssociationCount: 0,
          mrr: 0,
          hit10Count: 0,
          memoryCharsTotal: 0,
          charsPerAdditionalGold: null,
        },
      ],
    };
  }

  it("最小の正しい measured JSON が validateMeasured を通る(yml が期待する形と要約の validate が食い違っていない)", () => {
    const result = validateMeasured(makeMinimalMeasured());
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("要約の段を実際に走らせると exit 0 で Job Summary が埋まる", () => {
    const result = runSummaryStepFromWorkflow(makeMinimalMeasured());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("association-probes");
    expect(result.summary).toContain("hit@10");
  });

  it("🔴 実測 JSON が壊れていたら要約の段は非0で終わる(bench が壊れた＝赤、数字が動いた＝赤ではない)", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });

  it("🔴 warmup.ok=false でも要約の段は exit 0(門ではない)で、警告が Job Summary に出る", () => {
    const measured = makeMinimalMeasured();
    measured.warmup = { ok: false, detail: "simulated failure" };
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("warmup に失敗している");
  });

  describe("コメント潰しが association-probes ジョブの対象範囲で「扱えない」形に当たっていないこと", () => {
    it("association-probes ジョブの全段(name 段)に unhandled が無い", () => {
      stepBlockCommentUnhandled.length = 0;
      for (const step of steps) {
        extractStepBlock(step.name);
      }
      expect(stepBlockCommentUnhandled).toEqual([]);
    });
  });
});
