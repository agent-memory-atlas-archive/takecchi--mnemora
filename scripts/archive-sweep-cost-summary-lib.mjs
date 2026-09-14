/**
 * `scripts/archive-sweep-cost-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる
 * CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`consolidation-cost-summary-lib.mjs` と同じ分担・同じ理由(Issue #209)。
 *
 * `examples/chat` の `archive-sweep-cost` サブコマンド(`MNEMORA_ARCHIVE_SWEEP_JSON` が
 * 吐く JSON、`examples/chat/src/archive-sweep-json.ts` の `ArchiveSweepCostRunJson`)を
 * Markdown へ変換する。
 *
 * ## ⛔ 門にしない。ただし基準値とは比べる(渡された場合)
 *
 * `consolidation-cost-summary.mjs`(ADR 0088 §3 由来)と同じ形を踏襲する: 基準値と
 * diff を取って Job Summary に出し、**かつ**相違では落とさない(exit 0)。標本は
 * probe 7件であり、閾値の門を置くには足りない。非0になるのは入力そのものが
 * 壊れているときだけ。
 *
 * 🔴 **この PR では `examples/chat/archive-sweep-baseline.json` を作らない**
 * (この作業環境に DB が無く、捏造した数値を基準値として残さないため。初回 CI の
 * artifact を後続 PR で基準値にする)。⟹ `--baseline` は省略可能でなければならない。
 */

const REQUIRED_STORE_FIELDS = [
  "activeCount",
  "supersededCount",
  "archivedCount",
  "activeContentChars",
  "activeContentTokens",
  "activeDigestChars",
  "activeDigestTokens",
  "allContentChars",
];

const REQUIRED_MEAN_FIELDS = [
  "carriedCount",
  "carriedDigestTokens",
  "usageChars",
  "usageEstimatedTokens",
  "usageIndexChars",
  "totalInScope",
  "recalledActiveShare",
  "omittedArchivedCount",
];

const REQUIRED_SWEEP_NUMBER_FIELDS = ["limit", "archivedCount"];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function findFieldProblems(obj, fields, label) {
  if (!isObject(obj)) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of fields) {
    if (typeof obj[field] !== "number" || Number.isNaN(obj[field])) {
      problems.push(`${label}.${field} が数値でない`);
    }
  }
  return problems;
}

function findMeanProblems(mean, label) {
  const problems = findFieldProblems(mean, REQUIRED_MEAN_FIELDS, label);
  if (!isObject(mean)) {
    return problems;
  }
  if (mean.goldRank !== null && typeof mean.goldRank !== "number") {
    problems.push(`${label}.goldRank が数値でも null でもない`);
  }
  if (typeof mean.goldRankExcludedCount !== "number") {
    problems.push(`${label}.goldRankExcludedCount が数値でない`);
  }
  return problems;
}

function findSweepProblems(sweep) {
  if (!isObject(sweep)) {
    return ["sweep がオブジェクトでない"];
  }
  const problems = findFieldProblems(sweep, REQUIRED_SWEEP_NUMBER_FIELDS, "sweep");
  if (typeof sweep.supported !== "boolean") {
    problems.push("sweep.supported が真偽値でない");
  }
  if (typeof sweep.reachedLimit !== "boolean") {
    problems.push("sweep.reachedLimit が真偽値でない");
  }
  return problems;
}

/**
 * 1 phase(before/after)の形を検査する。`requireProbes: true` のときは
 * `recall.*.probes` 配列の存在も要求する(measured 側だけが要る)。
 */
function findPhaseProblems(phase, label, { requireProbes }) {
  if (!isObject(phase)) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  problems.push(...findFieldProblems(phase.store, REQUIRED_STORE_FIELDS, `${label}.store`));

  const recall = phase.recall;
  if (!isObject(recall)) {
    problems.push(`${label}.recall がオブジェクトでない`);
    return problems;
  }
  if (!isObject(recall.unbudgeted)) {
    problems.push(`${label}.recall.unbudgeted がオブジェクトでない`);
  } else {
    problems.push(...findMeanProblems(recall.unbudgeted.mean, `${label}.recall.unbudgeted.mean`));
    if (requireProbes && !Array.isArray(recall.unbudgeted.probes)) {
      problems.push(`${label}.recall.unbudgeted.probes が配列でない`);
    }
  }
  if (!Array.isArray(recall.budgeted)) {
    problems.push(`${label}.recall.budgeted が配列でない`);
  } else {
    recall.budgeted.forEach((rung, j) => {
      const rungLabel = `${label}.recall.budgeted[${j}]`;
      if (typeof rung.budgetTokens !== "number") {
        problems.push(`${rungLabel}.budgetTokens が数値でない`);
      }
      problems.push(...findMeanProblems(rung.mean, `${rungLabel}.mean`));
      if (requireProbes && !Array.isArray(rung.probes)) {
        problems.push(`${rungLabel}.probes が配列でない`);
      }
    });
  }
  return problems;
}

const REQUIRED_TOP_STRING_FIELDS = ["llmMode", "embeddingMode"];
const REQUIRED_TOP_NUMBER_FIELDS = ["probeCount", "haystackSize", "halfLifeHours", "recallLimit"];

function findTopLevelProblems(data) {
  if (!isObject(data)) {
    return ["JSON がオブジェクトでない"];
  }
  const problems = [];
  for (const field of REQUIRED_TOP_STRING_FIELDS) {
    if (typeof data[field] !== "string" || data[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_TOP_NUMBER_FIELDS) {
    if (typeof data[field] !== "number") {
      problems.push(`${field} が数値でない`);
    }
  }
  if (!Array.isArray(data.budgetLadder) || data.budgetLadder.some((v) => typeof v !== "number")) {
    problems.push("budgetLadder が数値配列でない");
  }
  const space = data.embeddingSpace;
  if (!isObject(space)) {
    problems.push("embeddingSpace がオブジェクトでない");
  } else {
    for (const field of ["provider", "model"]) {
      if (typeof space[field] !== "string" || space[field] === "") {
        problems.push(`embeddingSpace.${field} が文字列でない、または空`);
      }
    }
    if (typeof space.dimensions !== "number") {
      problems.push("embeddingSpace.dimensions が数値でない");
    }
  }
  problems.push(...findSweepProblems(data.sweep));
  return problems;
}

/**
 * 🔴 `examples/chat/src/local-embedding-warmup.ts` の `WEIGHTS_UNAVAILABLE_PREFIX` と
 * 同じ文言をここに逐語で持つ(`consolidation-cost-summary-lib.mjs` と同じ二重管理。
 * このファイルは素の `.mjs` であり TS 側の定数を import できない)。
 */
const WEIGHTS_UNAVAILABLE_PHRASE = "重みを取得できなかったので、値は測っていない";

/**
 * `MNEMORA_ARCHIVE_SWEEP_JSON` が吐いた JSON(パース済み)の形を検査する。
 * `status: "weights_unavailable"` それ自体は壊れた入力ではない。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (!isObject(data)) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  if (data.status === "weights_unavailable") {
    if (typeof data.detail !== "string" || data.detail === "") {
      return { ok: false, error: "weights_unavailable な JSON に detail が無い、または空" };
    }
    return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
  }
  if (data.status !== "measured") {
    return { ok: false, error: `status が不明な値である(実際: ${JSON.stringify(data.status)})` };
  }
  const problems = findTopLevelProblems(data);
  problems.push(...findPhaseProblems(data.before, "before", { requireProbes: true }));
  problems.push(...findPhaseProblems(data.after, "after", { requireProbes: true }));
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON が壊れている: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(`examples/chat/archive-sweep-baseline.json`、パース済み)の形を検査する。
 * **基準値は常に `status: "measured"` であること。**`probes` 配列は要求しない
 * (基準値は before/after・store・mean だけを持つ軽量な形でよい)。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (!isObject(data)) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  if (data.status !== "measured") {
    return {
      ok: false,
      error: `基準値 JSON の status は "measured" であること(実際: ${JSON.stringify(data.status)})`,
    };
  }
  const problems = findTopLevelProblems(data);
  problems.push(...findPhaseProblems(data.before, "before", { requireProbes: false }));
  problems.push(...findPhaseProblems(data.after, "after", { requireProbes: false }));
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON が壊れている: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

// ---------------------------------------------------------------------------
// 差分
// ---------------------------------------------------------------------------

const TOP_DIFF_FIELDS = [
  "llmMode",
  "embeddingMode",
  "probeCount",
  "haystackSize",
  "halfLifeHours",
  "recallLimit",
];
const SWEEP_DIFF_FIELDS = ["supported", "limit", "archivedCount", "reachedLimit"];
const STORE_DIFF_FIELDS = REQUIRED_STORE_FIELDS.map((f) => `store.${f}`);
const MEAN_DIFF_FIELDS = [...REQUIRED_MEAN_FIELDS, "goldRank", "goldRankExcludedCount"];

function readPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

/**
 * 1 phase(before/after)の実測と基準値を比較する。
 *
 * @param {Record<string, any>} measuredPhase
 * @param {Record<string, any> | undefined} baselinePhase
 * @param {string} label
 */
export function diffPhase(measuredPhase, baselinePhase, label) {
  if (!baselinePhase) {
    return { label, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of STORE_DIFF_FIELDS) {
    const baseline = readPath(baselinePhase, field);
    const measured = readPath(measuredPhase, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline, measured });
    }
  }
  for (const field of MEAN_DIFF_FIELDS) {
    const path = `recall.unbudgeted.mean.${field}`;
    const baseline = readPath(baselinePhase, path);
    const measured = readPath(measuredPhase, path);
    if (baseline !== measured) {
      fieldDiffs.push({ field: path, baseline, measured });
    }
  }
  const baselineRungsByTokens = new Map(
    (baselinePhase.recall?.budgeted ?? []).map((r) => [r.budgetTokens, r]),
  );
  const measuredRungs = measuredPhase.recall?.budgeted ?? [];
  for (const rung of measuredRungs) {
    const baselineRung = baselineRungsByTokens.get(rung.budgetTokens);
    if (!baselineRung) {
      fieldDiffs.push({
        field: `recall.budgeted[budgetTokens=${rung.budgetTokens}]`,
        baseline: undefined,
        measured: "(基準値に無い budget 段)",
      });
      continue;
    }
    for (const field of MEAN_DIFF_FIELDS) {
      const baseline = readPath(baselineRung.mean, field);
      const measured = readPath(rung.mean, field);
      if (baseline !== measured) {
        fieldDiffs.push({
          field: `recall.budgeted[budgetTokens=${rung.budgetTokens}].${field}`,
          baseline,
          measured,
        });
      }
    }
  }
  return { label, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

function buildTopLevelDiff(measured, baseline) {
  const diffs = [];
  for (const field of TOP_DIFF_FIELDS) {
    if (measured[field] !== baseline[field]) {
      diffs.push({ field, baseline: baseline[field], measured: measured[field] });
    }
  }
  for (const field of SWEEP_DIFF_FIELDS) {
    const baselineValue = baseline.sweep?.[field];
    const measuredValue = measured.sweep?.[field];
    if (baselineValue !== measuredValue) {
      diffs.push({ field: `sweep.${field}`, baseline: baselineValue, measured: measuredValue });
    }
  }
  const ladderMeasured = JSON.stringify(measured.budgetLadder);
  const ladderBaseline = JSON.stringify(baseline.budgetLadder);
  if (ladderMeasured !== ladderBaseline) {
    diffs.push({ field: "budgetLadder", baseline: ladderBaseline, measured: ladderMeasured });
  }
  for (const field of ["provider", "model", "dimensions"]) {
    const baselineValue = baseline.embeddingSpace?.[field];
    const measuredValue = measured.embeddingSpace?.[field];
    if (baselineValue !== measuredValue) {
      diffs.push({
        field: `embeddingSpace.${field}`,
        baseline: baselineValue,
        measured: measuredValue,
      });
    }
  }
  return diffs;
}

function buildDiffSection(measured, baseline) {
  const topDiffs = buildTopLevelDiff(measured, baseline);
  const beforeDiff = diffPhase(measured.before, baseline.before, "before");
  const afterDiff = diffPhase(measured.after, baseline.after, "after");
  const phaseDiffs = [beforeDiff, afterDiff];

  const allMatch = topDiffs.length === 0 && phaseDiffs.every((d) => d.matches);

  const lines = ["## 基準値との差分", ""];
  if (allMatch) {
    lines.push("✅ 一致(差分なし)。");
    return lines.join("\n");
  }

  const mismatched = phaseDiffs.filter((d) => !d.matches);
  lines.push(
    `⚠ 基準値と相違した箇所がある(トップレベル ${topDiffs.length} 件・phase ${mismatched.length} 件)` +
      "(🔴 これは失敗ではない——コードの変更で値が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら基準値ファイルを更新すること)。",
  );
  if (topDiffs.length > 0) {
    lines.push("", "### トップレベル", "", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const diff of topDiffs) {
      lines.push(`| ${diff.field} | ${diff.baseline} | ${diff.measured} |`);
    }
  }
  for (const diff of mismatched) {
    lines.push("", `### ${diff.label}`);
    if (diff.missingBaseline) {
      lines.push("", "この phase には基準値が無い。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(`| ${fieldDiff.field} | ${fieldDiff.baseline} | ${fieldDiff.measured} |`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 退化検出(recalledActiveShare が 1.0 近傍 = 「全部載せる」に退化している)
// ---------------------------------------------------------------------------

/** `consolidation-cost-summary-lib.mjs` と同じ閾値・同じ理由。 */
const DEGENERATE_SHARE_THRESHOLD = 0.999;

/**
 * measured の before/after・全 budget 段(unbudgeted も含む)を洗い、
 * `mean.recalledActiveShare` が退化しきい値以上の行を集める。
 *
 * @param {Record<string, any>} measured
 * @returns {{ phase: string, label: string, recalledActiveShare: number }[]}
 */
export function findDegenerateRecalledActiveShareRows(measured) {
  const rows = [];
  for (const phaseLabel of ["before", "after"]) {
    const phase = measured[phaseLabel];
    if (!isObject(phase)) {
      continue;
    }
    const unbudgetedShare = phase.recall?.unbudgeted?.mean?.recalledActiveShare;
    if (typeof unbudgetedShare === "number" && unbudgetedShare >= DEGENERATE_SHARE_THRESHOLD) {
      rows.push({ phase: phaseLabel, label: "unbudgeted", recalledActiveShare: unbudgetedShare });
    }
    for (const rung of phase.recall?.budgeted ?? []) {
      const share = rung.mean?.recalledActiveShare;
      if (typeof share === "number" && share >= DEGENERATE_SHARE_THRESHOLD) {
        rows.push({
          phase: phaseLabel,
          label: `budget=${rung.budgetTokens}`,
          recalledActiveShare: share,
        });
      }
    }
  }
  return rows;
}

/** 退化検出の節を組み立てる。基準値とは比べない(`consolidation-cost-summary-lib.mjs` と同じ判断)。 */
export function buildDegenerateShareSection(measured) {
  const rows = findDegenerateRecalledActiveShareRows(measured);
  const lines = ["## 退化検出(recalledActiveShare が 1.0 に近い行)", ""];
  if (rows.length === 0) {
    lines.push("該当なし(before/after・全 budget 段で recalledActiveShare は 1.0 未満)。");
    return lines.join("\n");
  }
  lines.push(
    "⚠ **以下の行は `recalledActiveShare` が 1.0 に近く、「全部載せる」に退化している" +
      "——budget を上げても対象を絞れておらず、この段と他の段を比較しても意味を持たない。**",
    "",
    "| phase | 段 | recalledActiveShare |",
    "|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.phase} | ${r.label} | ${r.recalledActiveShare.toFixed(3)} ⚠ 退化(全部load)＝比較不能 |`,
    ),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 注意書き
// ---------------------------------------------------------------------------

function buildCautionSection() {
  return [
    "## 読み方の注意",
    "",
    "- ⚠ **LLM は擬似(`deterministic`)である。**抽出結果の内容の妥当性ではなく、" +
      "掃引の前後で「載る量」「omitted」「goldRank」がどう動くかだけを見ている。",
    "- ⚠ **標本は probe 7件である。ここから率を主張しない**" +
      "([ADR 0033](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3)。",
    "- ⚠ **`omittedArchivedCount` はテナント/サブジェクトスコープ全体の集計であり、" +
      "その probe の話題との意味的関連性とは無関係に一律で動く。**全 probe が同じ値を" +
      "示すのは正常であり、バグではない。",
    "- ⚠ **`halfLifeHours` はこの bench 専用の裁量値であり、実運用の推奨値ではない。**" +
      "掃引をベンチの実行時間内に発火させるためだけに短くしてある。",
    "",
  ].join("\n");
}

/**
 * Markdown を組み立てる。`validateMeasured`/`validateBaseline` を通した値を渡すこと。
 *
 * @param {{ measured: Record<string, any>, baseline?: Record<string, any> }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const title =
    "# archive-sweep-cost bench の実測(掃引(ADR 0114)が「載る量」に効くかの実測。Issue #209)";

  if (measured.status === "weights_unavailable") {
    return [
      title,
      "",
      `## 🔴 ${WEIGHTS_UNAVAILABLE_PHRASE} — メトリクスは1件も出さない`,
      "",
      "前回の値・既定値・`0` のいずれへも倒していない。**基準値との比較も1つも" +
        "行っていない**——測っていない値を「基準値と違う」に化けさせないためである。",
      "",
      "以下は実際に投げられた理由である:",
      "",
      "```",
      String(measured.detail),
      "```",
    ].join("\n");
  }

  const lines = [
    title,
    "",
    `provider: llm=${measured.llmMode} embedding=${measured.embeddingMode}/` +
      `${measured.embeddingSpace?.model}/${measured.embeddingSpace?.dimensions}次元`,
    `probeCount=${measured.probeCount} haystackSize=${measured.haystackSize} ` +
      `halfLifeHours=${measured.halfLifeHours} recallLimit=${measured.recallLimit}`,
    `sweep: supported=${measured.sweep?.supported} limit=${measured.sweep?.limit} ` +
      `archivedCount=${measured.sweep?.archivedCount} reachedLimit=${measured.sweep?.reachedLimit}`,
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  }
  lines.push(buildDegenerateShareSection(measured), "");
  lines.push(buildCautionSection());
  return lines.join("\n");
}
