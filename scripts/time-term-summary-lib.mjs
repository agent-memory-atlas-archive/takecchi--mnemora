/**
 * `scripts/time-term-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる CLI)の
 * 純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/retrieval-quality-summary-lib.mjs`/`scripts/identifier-probe-summary-lib.mjs`/
 * `scripts/consolidation-cost-summary-lib.mjs` と同じ分担・同じ理由(Issue #217)。
 *
 * `examples/chat` の `time-term` サブコマンド(`MNEMORA_TIME_TERM_JSON` が吐く JSON、
 * `examples/chat/src/time-term-json.ts` の `TimeTermRunJson`)を Markdown へ変換する。
 *
 * ## 何を測っているか(ADR 0058)
 *
 * 8 probe は「内容は同一・`occurredAt`/`recordedAt` だけ違う」ペアであり、この bench が
 * 出すのは probe ごとの `outcome`(`newer-ranked-higher` 等)——**MRR/hit@k ではない**。
 * ⟹ この要約が比べるのも `outcome`/`totalInScope`/`omittedKinds` という**離散値**であり、
 * `retrieval-quality-summary-lib.mjs`/`identifier-probe-summary-lib.mjs` の MRR/hit@k とは
 * 種類が違う。
 *
 * ## ⛔ 門にしない理由
 *
 * [ADR 0088](../docs/decisions/0088-retrieval-quality-measured-in-ci.md) §2.1 と同じ理由——
 * 標本は8 probe であり、[ADR 0033](../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md)
 * §3 の規律(標本7件からは失敗率も成功率も統計的に主張しない)にそのまま照らせば、
 * 閾値判定に足る母数ではない。非0になるのは**入力そのものが壊れているとき**だけである。
 *
 * ## 🔴 `freshnessRatio`/`decayRatio`/`totalRatio` は基準値と比べない
 *
 * これらは実行ごとの壁時計時間(occurredAt/recordedAt を計算した瞬間から `recall()` が
 * 実際の `now` を読む瞬間までの実経過時間)にわずかに依存する連続値であり、
 * [ADR 0088](../docs/decisions/0088-retrieval-quality-measured-in-ci.md) §2 が
 * `retrieval-quality` の `decay`/`freshness` について実測したのと同じ種類の揺れ
 * (`total` の6桁目が動く)を持つ——**厳密等価では毎回「相違あり」になり、
 * ADR 0088 §3-3「常に同じ量を出す観測口は読まれない」を作り直すことになる。**
 * ⟹ 比べるのは`outcome`(離散・run 間で安定)/`totalInScope`/`omittedKinds` だけにする。
 * 連続値は JSON にはそのまま残す(丸めない)——見比べたい人は artifact を見ればよい。
 *
 * ## 基準値ファイルはまだ無い(2026-09)
 *
 * `examples/chat/time-term-baseline.json` は本 PR では作らない——値を捏造しないためである。
 * 最初の CI 実行で得られる artifact を、後続 PR で基準値にする。`--baseline` を渡さなければ
 * 差分節そのものを出さない(`buildSummaryMarkdown` 参照。`retrieval-quality-summary.mjs`/
 * `identifier-probe-summary.mjs` と同じく `--baseline` は任意)。
 */

const KNOWN_OUTCOMES = [
  "newer-ranked-higher",
  "older-ranked-higher",
  "tied",
  "newer-not-returned",
  "older-not-returned",
  "neither-returned",
  "collapsed",
];

const REQUIRED_TOP_STRING_FIELDS = ["armLabel", "llmMode", "embeddingMode"];

/**
 * 1 probe のオブジェクトが必須項目をすべて正しい型で持っているかを検査する。
 *
 * @param {unknown} probe
 * @param {string} label
 * @returns {string[]}
 */
function findProbeFieldProblems(probe, label) {
  if (typeof probe !== "object" || probe === null) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  if (typeof probe.probeId !== "string" || probe.probeId === "") {
    problems.push(`${label}.probeId が文字列でない、または空`);
  }
  if (typeof probe.outcome !== "string" || !KNOWN_OUTCOMES.includes(probe.outcome)) {
    problems.push(`${label}.outcome が既知の値でない(実際: ${JSON.stringify(probe.outcome)})`);
  }
  if (typeof probe.totalInScope !== "number" || Number.isNaN(probe.totalInScope)) {
    problems.push(`${label}.totalInScope が数値でない`);
  }
  if (!Array.isArray(probe.omittedKinds) || probe.omittedKinds.some((k) => typeof k !== "string")) {
    problems.push(`${label}.omittedKinds が文字列配列でない`);
  }
  return problems;
}

/**
 * `MNEMORA_TIME_TERM_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * **壊れている、と判定する条件はここに限定する**——`probes` の連続値欄
 * (`similarityGapWithinPair` 等)は `number | null` のどちらでもよく、型が
 * 崩れていても致命傷とは見なさない(この要約が使わない欄のため)。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const problems = [];
  for (const field of REQUIRED_TOP_STRING_FIELDS) {
    if (typeof (/** @type {any} */ (data)[field]) !== "string") {
      problems.push(`${field} が文字列でない`);
    }
  }
  const probes = /** @type {{ probes?: unknown }} */ (data).probes;
  if (!Array.isArray(probes)) {
    problems.push("probes 配列が無い");
  } else if (probes.length === 0) {
    problems.push("probes が空配列である(bench が1件も測れなかった)");
  } else {
    const seen = new Set();
    probes.forEach((probe, i) => {
      problems.push(...findProbeFieldProblems(probe, `probes[${i}]`));
      const id = /** @type {any} */ (probe)?.probeId;
      if (typeof id === "string") {
        if (seen.has(id)) {
          problems.push(`probes に probeId "${id}" が2件以上ある`);
        }
        seen.add(id);
      }
    });
  }
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(パース済み)の形を検査する。実測と同じ必須項目を、`probes` 配列の
 * 各要素に要求する。
 *
 * **⚠ この関数は、まだコミットされている基準値ファイルが無い時点で書いている。**
 * `--baseline` が渡されたときだけ呼ばれる(`time-term-summary.mjs` 参照)——
 * 基準値ファイルが無くてもこのスクリプト自体は動く。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { probes: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const probes = /** @type {{ probes?: unknown }} */ (data).probes;
  if (!Array.isArray(probes)) {
    return { ok: false, error: "基準値 JSON に probes 配列が無い" };
  }
  const problems = [];
  const seen = new Set();
  probes.forEach((probe, i) => {
    const id = /** @type {any} */ (probe)?.probeId;
    if (typeof id !== "string" || id === "") {
      problems.push(`probes[${i}].probeId が文字列でない、または空`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`probes に probeId "${id}" が2件以上ある`);
      return;
    }
    seen.add(id);
    problems.push(...findProbeFieldProblems(probe, `probes[${i}](${id})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の probes が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ probes: Record<string, unknown>[] }} */ (data) };
}

/** 比べる項目。連続値(`*Ratio`/`*GapWithinPair`)は含めない(冒頭 docstring 参照)。 */
const DIFF_FIELDS = ["outcome", "totalInScope", "omittedKinds"];

/**
 * @param {Record<string, any>} probe
 * @param {string} field
 */
function readDiffField(probe, field) {
  if (field === "omittedKinds") {
    return JSON.stringify([...(probe.omittedKinds ?? [])].sort());
  }
  return probe[field];
}

/**
 * 実測の1 probe と、対応する基準値の1 probe(無ければ `undefined`)を比べる。
 *
 * @param {string} probeId
 * @param {Record<string, any>} measuredProbe
 * @param {Record<string, any> | undefined} baselineProbe
 */
export function diffProbe(probeId, measuredProbe, baselineProbe) {
  if (!baselineProbe) {
    return { probeId, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readDiffField(baselineProbe, field);
    const measured = readDiffField(measuredProbe, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline: baselineProbe[field], measured: measuredProbe[field] });
    }
  }
  return { probeId, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**(ADR 0088 §3-3)。
 *
 * @param {Record<string, any>} measured
 * @param {{ probes: Record<string, unknown>[] }} baseline
 */
function buildDiffSection(measured, baseline) {
  const measuredById = new Map(measured.probes.map((p) => [p.probeId, p]));
  const baselineById = new Map(baseline.probes.map((p) => [/** @type {any} */ (p).probeId, p]));
  const diffs = [...measuredById.keys()].map((probeId) =>
    diffProbe(probeId, measuredById.get(probeId), baselineById.get(probeId)),
  );
  const extraBaselineProbes = [...baselineById.keys()].filter((id) => !measuredById.has(id));

  const lines = ["## 基準値との差分", ""];
  if (diffs.every((diff) => diff.matches) && extraBaselineProbes.length === 0) {
    lines.push(
      "✅ 一致(差分なし)。全 probe で outcome / totalInScope / omittedKinds が" +
        " `examples/chat/time-term-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した probe が ${mismatched.length} 件ある` +
      "(🔴 これは失敗ではない——コードの変更で outcome が動くことは起こり得る。" +
      "下の内訳を読み、意図した変化かどうかを人が判断し、意図した変化なら" +
      "基準値ファイルを更新すること)。",
  );
  for (const diff of mismatched) {
    lines.push("", `### ${diff.probeId}`);
    if (diff.missingBaseline) {
      lines.push("", "この probe には基準値が無い(新しい probe か、基準値がまだ追随していない)。");
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(
        `| ${fieldDiff.field} | ${JSON.stringify(fieldDiff.baseline)} | ${JSON.stringify(fieldDiff.measured)} |`,
      );
    }
  }
  if (extraBaselineProbes.length > 0) {
    lines.push(
      "",
      "### 基準値にのみ存在する probe(今回の実測には無い)",
      "",
      ...extraBaselineProbes.map((id) => `- ${id}`),
    );
  }
  return lines.join("\n");
}

/** `newer-ranked-higher` のような outcome を1行にする。 */
function buildProbeRow(probe) {
  return (
    `| ${probe.probeId} | ${probe.outcome} | ${probe.totalInScope} | ` +
    `${probe.omittedKinds.length === 0 ? "-" : probe.omittedKinds.join(",")} |`
  );
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと**
 * (`retrieval-quality-summary-lib.mjs`/`identifier-probe-summary-lib.mjs` と同じ分担)。
 *
 * `baseline` は任意(`--baseline` を渡さなければ差分節そのものを出さない
 * ——基準値ファイルがまだ無いため。冒頭 docstring 参照)。
 *
 * @param {{ measured: Record<string, any>, baseline?: { probes: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [
    "# time-term(ADR 0058 / Issue #217): freshness/decay が順位を動かすかの実測",
    "",
    `provider: llm=${measured.llmMode} / embedding=${measured.embeddingMode}`,
    "",
    "| probe | outcome | totalInScope | omitted |",
    "|---|---|---|---|",
    ...measured.probes.map(buildProbeRow),
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  } else {
    lines.push(
      "⚠ 基準値ファイルがまだ無い(`examples/chat/time-term-baseline.json`)。" +
        "この CI 実行の artifact を、後続 PR で基準値にする。",
      "",
    );
  }
  lines.push(
    `⚠ ADR 0033 §3: 標本${measured.probes.length}件からは失敗率も成功率も統計的に主張しない。` +
      "ここで言えるのは「今回、この probe で outcome が何だったか」までである。",
    "",
    "⚠ `freshnessRatio`/`decayRatio`/`totalRatio` は artifact(機械可読 JSON)には残るが、" +
      "この要約・基準値との比較には含めない——壁時計時間にわずかに依存する連続値であり、" +
      "厳密等価で比べると常に「相違あり」になる(ADR 0088 §2 が `retrieval-quality` の" +
      "`decay`/`freshness` について実測したのと同じ種類の揺れ)。",
  );
  return lines.join("\n");
}
