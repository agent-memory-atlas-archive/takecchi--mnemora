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
 *
 * ## 🔴 `before` 段の `usageChars`/`usageEstimatedTokens`/`usageIndexChars` は厳密等価では比べない(ADR 0123 / Issue #223)
 *
 * `before`(掃引前)段の active な母集合は、この bench では74件(このリポジトリの実測時点)を
 * decay 込みで順位付けする。壁時計時間のわずかな差で順位境界の記憶が入れ替わり、
 * carry される内容の文字数・トークン数(`usageChars`/`usageEstimatedTokens`/
 * `usageIndexChars`)が run 間で **0.2648%〜1.2671%** 動く(Issue #223、既存 CI artifact
 * 7 run の実測)。一方 `goldRank`/`carriedCount`/`omittedArchivedCount` などは同じ7 runで
 * 1バイトも動かず、`after`(掃引後、母集合14件)の全欄も1バイトも動かない。
 *
 * この bench が捕まえたいのは「掃引が『載る量』を減らしたか」「掃引で想起の質が
 * 落ちていないか」であり、どちらも `usageChars` が 4302→665(約85%減)・`goldRank` が
 * 1.29→1.29(不変)という2桁大きい効果として出る。0.2648%〜1.2671%の揺れはその2桁下であり、
 * 厳密等価で相違を出し続けても、この揺れを「回帰」と区別する情報を何も足さない
 * ——`time-term-summary-lib.mjs` が `freshnessRatio`/`decayRatio`/`totalRatio` について
 * 既に採っている規律(壁時計時間に依存する連続値は比較から除外する)と同じ理由で、
 * `before` 段の `usage*` 3欄を **比較(mismatch のカウント)からは外す**。
 *
 * ただし `time-term` とは1点だけ違う形にする——`before.usageChars` は Issue #209 の
 * 受け入れ条件そのもの(掃引で載る量が減ったか)に使う中心的な値であり、
 * `freshnessRatio` のように「artifact にだけ残せばよい」脇役の値ではない。
 * ⟹ 比較(件数)からは外すが、**summary には基準値と実測を並べた表として残す**
 * (`buildBeforeUsageInfoSection`)——回帰が起きても人が表を読めば気づける形にする。
 * `after` 段の `usage*` は除外しない(7 run で不動という前提が崩れたら、まずここが動く)。
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

/**
 * `before` 段でだけ、壁時計時間に依存して run 間で揺れる連続値(ADR 0123 / Issue #223)。
 * `after` 段では除外しない——7 run で不動という前提が崩れたら、まずここで検知したい。
 */
const NOISY_BEFORE_ONLY_USAGE_FIELDS = ["usageChars", "usageEstimatedTokens", "usageIndexChars"];

/** `label`("before"/"after")に応じて、実際に厳密等価で比較する mean の欄を返す。 */
function meanDiffFieldsForLabel(label) {
  if (label === "before") {
    return MEAN_DIFF_FIELDS.filter((field) => !NOISY_BEFORE_ONLY_USAGE_FIELDS.includes(field));
  }
  return MEAN_DIFF_FIELDS;
}

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
  const meanDiffFields = meanDiffFieldsForLabel(label);
  const fieldDiffs = [];
  for (const field of STORE_DIFF_FIELDS) {
    const baseline = readPath(baselinePhase, field);
    const measured = readPath(measuredPhase, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline, measured });
    }
  }
  for (const field of meanDiffFields) {
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
    for (const field of meanDiffFields) {
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
// `before` 段の usage* — 比較(mismatch のカウント)からは外すが、表示はする(ADR 0123)
// ---------------------------------------------------------------------------

/**
 * `before` 段の `usageChars`/`usageEstimatedTokens`/`usageIndexChars` を、unbudgeted +
 * 全 budget 段について集める。`baselinePhase` が無ければ `baseline` は常に `undefined`
 * ——このセクションは基準値の有無に関わらず表示する。
 *
 * @param {Record<string, any> | undefined} measuredBefore
 * @param {Record<string, any> | undefined} baselineBefore
 */
export function collectBeforeUsageInfoRows(measuredBefore, baselineBefore) {
  const rows = [];
  const pushRows = (label, measuredMean, baselineMean) => {
    for (const field of NOISY_BEFORE_ONLY_USAGE_FIELDS) {
      rows.push({
        label,
        field,
        baseline: baselineMean ? baselineMean[field] : undefined,
        measured: measuredMean ? measuredMean[field] : undefined,
      });
    }
  };
  pushRows(
    "unbudgeted",
    measuredBefore?.recall?.unbudgeted?.mean,
    baselineBefore?.recall?.unbudgeted?.mean,
  );
  const baselineRungsByTokens = new Map(
    (baselineBefore?.recall?.budgeted ?? []).map((r) => [r.budgetTokens, r]),
  );
  for (const rung of measuredBefore?.recall?.budgeted ?? []) {
    const baselineRung = baselineRungsByTokens.get(rung.budgetTokens);
    pushRows(`budgeted[budgetTokens=${rung.budgetTokens}]`, rung.mean, baselineRung?.mean);
  }
  return rows;
}

/**
 * `before` 段の usage* を、基準値と実測を並べた表として出す。**mismatch には数えない**
 * ——`buildDiffSection` の一致/不一致判定はこの欄を見ない(`meanDiffFieldsForLabel` 参照)。
 *
 * @param {Record<string, any>} measured
 * @param {Record<string, any> | undefined} baseline
 */
export function buildBeforeUsageInfoSection(measured, baseline) {
  const rows = collectBeforeUsageInfoRows(measured.before, baseline?.before);
  const lines = [
    "## before 段の usageChars 系(参考表示・基準値との厳密等価では比較していない)",
    "",
    "⚠ `before.recall.*.usageChars`/`usageEstimatedTokens`/`usageIndexChars` は、掃引前の" +
      " active な母集合(この bench では数十件)を decay込みで順位付けする際、壁時計時間の" +
      "わずかな差で順位境界の記憶が入れ替わり、run 間で 0.2648%〜1.2671% 動く連続値である" +
      "(Issue #223、既存 CI artifact 7 run の実測)。`goldRank`/`carriedCount` や `after`" +
      "(掃引後)段の全欄はこの7 runで1バイトも動いていない——動いているのは carry された" +
      "内容の文字数・トークン数だけである。ADR 0123 の判断により、この3欄は基準値との" +
      "厳密等価の比較・相違件数のカウントからは外す(`time-term-summary-lib.mjs` の" +
      "`freshnessRatio` 等と同じ規律)。**ただし値はここに残す**——回帰は表を読んで" +
      "人が気づく。",
    "",
  ];
  if (baseline) {
    lines.push("| 段 | 項目 | 基準値 | 実測 |", "|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${row.label} | ${row.field} | ${row.baseline ?? "-"} | ${row.measured ?? "-"} |`,
      );
    }
  } else {
    lines.push("| 段 | 項目 | 実測 |", "|---|---|---|");
    for (const row of rows) {
      lines.push(`| ${row.label} | ${row.field} | ${row.measured ?? "-"} |`);
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
  lines.push(buildBeforeUsageInfoSection(measured, baseline), "");
  lines.push(buildDegenerateShareSection(measured), "");
  lines.push(buildCautionSection());
  return lines.join("\n");
}
