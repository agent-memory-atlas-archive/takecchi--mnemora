/**
 * `scripts/compare-summary.mjs`(CI の Job Summary に載せる Markdown を組み立て、
 * 基準値からの悪化を判定する CLI)の純関数の側。ファイル I/O・`process.argv`・
 * `process.exit` を一切持たない——`time-term-summary-lib.mjs`/
 * `archive-sweep-cost-summary-lib.mjs` と同じ分担(Issue #242)。
 *
 * `examples/chat` の `compare` サブコマンド(`MNEMORA_COMPARE_JSON` が吐く JSON、
 * `examples/chat/src/compare-json.ts` の `CompareRunJson`)を Markdown へ変換する。
 *
 * ## 何を測っているか(docs/north-star.md / Issue #242)
 *
 * `compare` は北極星の物差しそのもの——`mnemoraShareOfNaiveChars`
 * (mnemora が焼く文字数 / naive が焼く文字数)が「使う側が会話ログを全部プロンプトへ
 * 積むのをやめられたか」に直接答える値である。他5本の基準値ファイル
 * (`retrieval-baseline.json`/`identifier-probe-baseline.json`/`time-term-baseline.json`/
 * `consolidation-baseline.json`/`archive-sweep-baseline.json`)には対応する基準値が
 * 無く、この bench だけが退行を機械で見ていなかった(Issue #242)。
 *
 * ## ⭐ 他5本と違い、これは門である(ADR 0133)
 *
 * 他5本(`retrieval-quality`/`identifier-probes`/`consolidation-cost`/
 * `archive-sweep-cost`/`time-term`)は ADR 0088/0094 により意図的に非ゲート
 * (`exit 0`)にされている——理由は「decay/freshness が壁時計時間に依存して run ごとに
 * 揺れる」(ADR 0088 §2 実測)と「標本が小さく統計的な主張ができない」(ADR 0033 §3)の
 * 2点である。
 *
 * `compare` にもこの2つの懸念は一見当てはまるように見えた——**しかし ADR 0133 が
 * 実測した**: 同一 commit で CI を2回実行し(同じ run のジョブを rerun)、
 * `measuredAt` を除いて JSON が完全一致した(12 行すべて含む。大きい会話長で
 * `over_limit` による上位 `DEFAULT_RECALL_LIMIT` 件への絞り込みが起きている行も
 * 含めて揺れなかった)。⟹ **この bench は run 間で揺れないことを実測で確認した**
 * ——他5本とは前提が違う。**だからこの bench だけは、`mnemoraShareOfNaiveChars`
 * の悪化と `factStatementSurvived` の退行(true→false)を検知したら非0で終わる。**
 *
 * ⚠ 標本(会話長12点)が少ないことは他5本と同じだが、ここで問題になる「標本が
 * 小さいと何が主張できないか」(ADR 0033 §3)は**想起の質についての統計的な主張**
 * (hit@1 が真の成功率をどれだけ代表するか等)の話であり、`compare` が測るのは
 * 「この12点の会話長で、決定的な入力に対して機械的に同じ値が出るか」という
 * **再現性**の話である。再現性は個々の点ごとに検証可能であり、標本数の少なさは
 * 「この点で退行したかどうか」の判定を曖昧にしない。
 *
 * ## 何を悪化とみなすか
 *
 * `turnCount` をキーに基準値と突き合わせ、次のどちらかが起きた行を「退行」とする
 * (`computeComparison`。旧 `computeRegressions`——Issue #477 で戻り値の形を変え、名前も変えた):
 *
 * 1. **`mnemoraShareOfNaiveChars` が基準値より大きい**(= mnemora が焼く量が
 *    naive に対して相対的に増えた。北極星の物差しそのものの悪化)。
 * 2. **`factStatementSurvived` が `true` → `false` に変わった**(量を削った結果、
 *    答えが落ちた。README「削減率だけでは意味を持たない」節の懸念そのもの)。
 *
 * **それ以外の欄(`naiveChars`/`totalInScope`/`omitted` 等)は Job Summary の
 * 差分節には出すが、退行の判定には使わない**——`naiveChars` は会話生成側の変更で
 * 動きうるが、それ自体は北極星の物差しの悪化ではない。判定を `mnemoraShareOfNaiveChars`
 * と `factStatementSurvived` の2つに絞ることで、無関係な変更が門を赤くしない
 * (却下した代案は ADR 0133 参照: 全欄の厳密一致を門にする案は、`naiveChars` の
 * ような北極星と無関係な欄が変わるたびに赤くなり、`AGENTS.md`
 * 「機能を足すかどうかは北極星に当てて決める」の運用を阻害するため却下した)。
 *
 * ## 新しい会話長・消えた会話長 —— 退行ではないが、判定不能である(Issue #477)
 *
 * **どちらも「退行」ではない。しかし「退行が無い」でもない——比較していないだけである。**
 * 🔴 2026-09-17 以前、この2つは黙って読み飛ばされ、門は緑を出していた
 * (Issue #477 の実測: 基準値を `turnCount=2` の1行だけにすると、退行11件の実測が
 * `computeRegressions` で0件になり exit 0 で通った。`rows: []` でも同じ)。
 * ⟹ **「失敗が0件」と「N件を比較して失敗が0件」が同じ顔で出ていた。**
 *
 * いまは `evaluateCompare` が、**実測側の `turnCount` 集合と基準値側の `turnCount`
 * 集合が一致したときだけ**判定する:
 *
 * - 実測に在って基準値に無い `turnCount`(新しい会話長) ⟹ **その行は1度も比較されて
 *   いない** ⟹ `indeterminate`。
 * - 基準値に在って実測に無い `turnCount`(消えた会話長、たとえば
 *   `DEFAULT_COMPARE_SEQUENCE` を変更した) ⟹ **測る点が黙って減った**
 *   ⟹ `indeterminate`(`ci-green-check` の「部分登録」と同じ窓。ADR 0215)。
 *
 * **会話長の構成を変える判断は、いまもこの bench の門の役目ではない**——門は
 * 「変えたこと」を赤にするのではなく、**「変わったので比較できていない」と名乗って
 * 止まる**。基準値を更新すれば(意図した変更なら、それが正しい手当てである)通る。
 *
 * ⚠ **「本来いくつの会話長が在るべきか」は、この lib からは引けない。**
 * 母集合の正体は `examples/chat/src/compare.ts` の `DEFAULT_COMPARE_SEQUENCE`(12点)
 * だが、それは TypeScript であり `scripts/*.mjs` から素直に import できない。
 * ⟹ **引かない。** 下限は上の2集合から取る(件数をこのファイルに書かない。
 * ADR 0215 決定4 と同じ「下限を実測側の集合から取る」形)。
 */

const REQUIRED_TOP_STRING_FIELDS = ["llmMode", "embeddingMode"];

const REQUIRED_ROW_NUMBER_FIELDS = [
  "fillerPairs",
  "turnCount",
  "naiveChars",
  "naiveTokens",
  "mnemoraChars",
  "mnemoraTokens",
  "mnemoraShareOfNaiveChars",
  "totalInScope",
  "returnedCount",
  "annCandidateCount",
];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * 1 row のオブジェクトが必須項目をすべて正しい型で持っているかを検査する。
 *
 * @param {unknown} row
 * @param {string} label
 * @returns {string[]}
 */
function findRowFieldProblems(row, label) {
  if (!isObject(row)) {
    return [`${label} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of REQUIRED_ROW_NUMBER_FIELDS) {
    if (typeof row[field] !== "number" || Number.isNaN(row[field])) {
      problems.push(`${label}.${field} が数値でない`);
    }
  }
  if (typeof row.factStatementSurvived !== "boolean") {
    problems.push(`${label}.factStatementSurvived が真偽値でない`);
  }
  if (!Array.isArray(row.omitted)) {
    problems.push(`${label}.omitted が配列でない`);
  }
  return problems;
}

/**
 * `MNEMORA_COMPARE_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (!isObject(data)) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const problems = [];
  for (const field of REQUIRED_TOP_STRING_FIELDS) {
    if (typeof (/** @type {any} */ (data)[field]) !== "string") {
      problems.push(`${field} が文字列でない`);
    }
  }
  const rows = /** @type {{ rows?: unknown }} */ (data).rows;
  if (!Array.isArray(rows)) {
    problems.push("rows 配列が無い");
  } else if (rows.length === 0) {
    problems.push("rows が空配列である(bench が1件も測れなかった)");
  } else {
    const seen = new Set();
    rows.forEach((row, i) => {
      problems.push(...findRowFieldProblems(row, `rows[${i}]`));
      const turnCount = /** @type {any} */ (row)?.turnCount;
      if (typeof turnCount === "number") {
        if (seen.has(turnCount)) {
          problems.push(`rows に turnCount ${turnCount} が2件以上ある`);
        }
        seen.add(turnCount);
      }
    });
  }
  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(パース済み)の形を検査する。実測と同じ必須項目を、`rows` 配列の
 * 各要素に要求する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { rows: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (!isObject(data)) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const rows = /** @type {{ rows?: unknown }} */ (data).rows;
  if (!Array.isArray(rows)) {
    return { ok: false, error: "基準値 JSON に rows 配列が無い" };
  }
  const problems = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const turnCount = /** @type {any} */ (row)?.turnCount;
    if (typeof turnCount !== "number") {
      problems.push(`rows[${i}].turnCount が数値でない`);
      return;
    }
    if (seen.has(turnCount)) {
      problems.push(`rows に turnCount ${turnCount} が2件以上ある`);
      return;
    }
    seen.add(turnCount);
    problems.push(...findRowFieldProblems(row, `rows[${i}](turnCount=${turnCount})`));
  });
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON の rows が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {{ rows: Record<string, unknown>[] }} */ (data) };
}

/** Job Summary の差分節で比べる項目(門の判定には使わない。冒頭 docstring 参照)。 */
const DIFF_FIELDS = [
  "naiveChars",
  "naiveTokens",
  "mnemoraChars",
  "mnemoraTokens",
  "mnemoraShareOfNaiveChars",
  "totalInScope",
  "returnedCount",
  "annCandidateCount",
  "factStatementSurvived",
  "omitted",
];

/**
 * @param {Record<string, any>} row
 * @param {string} field
 */
function readDiffField(row, field) {
  if (field === "omitted") {
    return JSON.stringify(row.omitted ?? []);
  }
  return row[field];
}

/**
 * 実測の1 row と、対応する基準値の1 row(無ければ `undefined`)を比べる。
 *
 * @param {number} turnCount
 * @param {Record<string, any>} measuredRow
 * @param {Record<string, any> | undefined} baselineRow
 */
export function diffRow(turnCount, measuredRow, baselineRow) {
  if (!baselineRow) {
    return { turnCount, matches: false, missingBaseline: true, fieldDiffs: [] };
  }
  const fieldDiffs = [];
  for (const field of DIFF_FIELDS) {
    const baseline = readDiffField(baselineRow, field);
    const measured = readDiffField(measuredRow, field);
    if (baseline !== measured) {
      fieldDiffs.push({ field, baseline: baselineRow[field], measured: measuredRow[field] });
    }
  }
  return { turnCount, matches: fieldDiffs.length === 0, missingBaseline: false, fieldDiffs };
}

/**
 * ⭐ **何を比較し、何を比較できなかったか**を返す(Issue #477)。
 *
 * 🔴 **退行の配列だけを返す関数を、意図的に残していない。** 以前の
 * `computeRegressions()` は「基準値に対応する行が無ければ `continue`」していたため、
 * 呼び手には「比較して退行が無かった」と「そもそも比較していない」が**同じ空配列**
 * として届いていた。⟹ **呼び手が比較漏れを直視せざるを得ない形にする**ため、
 * 戻り値をオブジェクトにし、比較できなかった `turnCount` を必ず同梱する。
 *
 * ⚠ **この関数は合否を決めない。** 合否は `evaluateCompare()`、終了コードは
 * `compare-summary.mjs` が持つ(`publish-run-coverage-lib.mjs` の
 * `evaluatePublishRunCoverage` / `check-publish-run-coverage.mjs` と同じ分担)。
 *
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} baseline
 * @returns {{
 *   comparedTurnCounts: number[],
 *   regressions: { turnCount: number, reasons: string[] }[],
 *   measuredOnlyTurnCounts: number[],
 *   baselineOnlyTurnCounts: number[],
 * }} `comparedTurnCounts` は両側に在って実際に突き合わせた会話長、
 * `measuredOnlyTurnCounts` は実測に在って基準値に無い(1度も比較していない)会話長、
 * `baselineOnlyTurnCounts` は基準値に在って実測に無い(測る点が黙って減った)会話長。
 */
export function computeComparison(measured, baseline) {
  const baselineByTurn = new Map(baseline.rows.map((r) => [/** @type {any} */ (r).turnCount, r]));
  const measuredTurnCounts = new Set(measured.rows.map((r) => r.turnCount));
  /** @type {number[]} */
  const comparedTurnCounts = [];
  /** @type {number[]} */
  const measuredOnlyTurnCounts = [];
  /** @type {{ turnCount: number, reasons: string[] }[]} */
  const regressions = [];
  for (const row of measured.rows) {
    const base = /** @type {Record<string, any> | undefined} */ (baselineByTurn.get(row.turnCount));
    if (!base) {
      // ⛔ ここで黙って読み飛ばさない(Issue #477)——「比較していない」として数える。
      measuredOnlyTurnCounts.push(row.turnCount);
      continue;
    }
    comparedTurnCounts.push(row.turnCount);
    const reasons = [];
    if (row.mnemoraShareOfNaiveChars > base.mnemoraShareOfNaiveChars) {
      reasons.push(
        `mnemoraShareOfNaiveChars が悪化: 基準値 ${base.mnemoraShareOfNaiveChars} → 実測 ${row.mnemoraShareOfNaiveChars}`,
      );
    }
    if (base.factStatementSurvived === true && row.factStatementSurvived === false) {
      reasons.push("factStatementSurvived が true → false に退行(冒頭の事実が失われた)");
    }
    if (reasons.length > 0) {
      regressions.push({ turnCount: row.turnCount, reasons });
    }
  }
  const baselineOnlyTurnCounts = [...baselineByTurn.keys()].filter(
    (turnCount) => !measuredTurnCounts.has(turnCount),
  );
  const ascending = (/** @type {number} */ a, /** @type {number} */ b) => a - b;
  return {
    comparedTurnCounts: [...comparedTurnCounts].sort(ascending),
    regressions,
    measuredOnlyTurnCounts: [...measuredOnlyTurnCounts].sort(ascending),
    baselineOnlyTurnCounts: [...baselineOnlyTurnCounts].sort(ascending),
  };
}

/**
 * ⭐ **門の判定そのもの**(Issue #477)。`evaluatePublishRunCoverage`
 * (`publish-run-coverage-lib.mjs`、ADR 0207)と同じ形——lib が
 * `verdict: "pass" | "fail" | "indeterminate"` と `reason` を返し、**終了コードへの
 * 写し取り(0/1/2)は CLI(`compare-summary.mjs`)が持つ。**
 *
 * ## ⭐ いつ判定してよいか
 *
 * **実測側の `turnCount` 集合と基準値側の `turnCount` 集合が一致したときだけ判定する。**
 * 一致しなければ `indeterminate` ——「比較していない」を「退行が無い」と同じ顔で
 * 出さないためである(冒頭 docstring「新しい会話長・消えた会話長」)。
 *
 * ⚠ **`pending` という語は使わない。** `ci-green-check-lib.mjs` の `pending` は
 * 「後でもう一度見ろ」という再試行含みの意味を持つが、基準値の取りこぼしは
 * 再試行では直らない(基準値を更新するか、実測側を戻すかの判断が要る)。
 *
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} baseline
 * @returns {{
 *   verdict: "pass" | "fail" | "indeterminate",
 *   reason: string,
 *   comparedTurnCounts: number[],
 *   regressions: { turnCount: number, reasons: string[] }[],
 *   measuredOnlyTurnCounts: number[],
 *   baselineOnlyTurnCounts: number[],
 * }}
 */
export function evaluateCompare(measured, baseline) {
  const comparison = computeComparison(measured, baseline);
  const { comparedTurnCounts, regressions, measuredOnlyTurnCounts, baselineOnlyTurnCounts } =
    comparison;

  /** @type {"pass" | "fail" | "indeterminate"} */
  let verdict;
  let reason;

  const notComparedParts = [];
  if (measuredOnlyTurnCounts.length > 0) {
    notComparedParts.push(
      `実測に在って基準値に無い会話長(1度も比較していない): turnCount=${measuredOnlyTurnCounts.join(", ")}`,
    );
  }
  if (baselineOnlyTurnCounts.length > 0) {
    notComparedParts.push(
      `基準値に在って実測に無い会話長(測る点が黙って減った): turnCount=${baselineOnlyTurnCounts.join(", ")}`,
    );
  }

  if (comparedTurnCounts.length === 0) {
    verdict = "indeterminate";
    reason =
      "1会話長も比較していない(実測と基準値で共通する turnCount が1つも無い)。" +
      (notComparedParts.length > 0 ? `${notComparedParts.join("; ")}。` : "") +
      "⟹ 退行の有無について何も言えない——「退行0件」ではない(Issue #477)。";
  } else if (notComparedParts.length > 0) {
    verdict = "indeterminate";
    reason =
      `実測と基準値の turnCount 集合が一致しない——比較できたのは ${comparedTurnCounts.length} 会話長だけである。` +
      `${notComparedParts.join("; ")}。` +
      (regressions.length > 0
        ? `⚠ 比較できた範囲だけでも ${regressions.length} 会話長が退行している。`
        : "") +
      "⟹ 比較していない会話長について退行の有無を言えないので、判定不能にする(Issue #477)。" +
      "意図して会話長の構成を変えたのなら、`examples/chat/compare-baseline.json` を更新すること。";
  } else if (regressions.length > 0) {
    verdict = "fail";
    reason =
      `${comparedTurnCounts.length} 会話長すべてを比較し、うち ${regressions.length} 会話長で` +
      "北極星の物差しが退行した(ADR 0133 の判定基準)。";
  } else {
    verdict = "pass";
    reason =
      `実測と基準値の turnCount 集合が一致し(${comparedTurnCounts.length} 会話長)、` +
      "そのすべてで退行が無かった。";
  }

  return { verdict, reason, ...comparison };
}

/**
 * 基準値との差分節。**一致なら1行、違うときだけ展開する**(ADR 0088 §3-3)。
 *
 * @param {Record<string, any>} measured
 * @param {{ rows: Record<string, unknown>[] }} baseline
 */
function buildDiffSection(measured, baseline) {
  const measuredByTurn = new Map(measured.rows.map((r) => [r.turnCount, r]));
  const baselineByTurn = new Map(baseline.rows.map((r) => [/** @type {any} */ (r).turnCount, r]));
  const diffs = [...measuredByTurn.keys()].map((turnCount) =>
    diffRow(turnCount, measuredByTurn.get(turnCount), baselineByTurn.get(turnCount)),
  );
  const extraBaselineRows = [...baselineByTurn.keys()].filter((t) => !measuredByTurn.has(t));
  const evaluation = evaluateCompare(measured, baseline);
  const { regressions } = evaluation;
  const regressedTurnCounts = new Set(regressions.map((r) => r.turnCount));

  const lines = ["## 基準値との差分", ""];
  if (evaluation.verdict === "pass" && diffs.every((diff) => diff.matches)) {
    lines.push(
      `✅ 一致(差分なし)。${evaluation.comparedTurnCounts.length} 会話長すべてを基準値と` +
        "突き合わせ、北極星の物差し(mnemoraShareOfNaiveChars 他)が" +
        " `examples/chat/compare-baseline.json` と同じだった。",
    );
    return lines.join("\n");
  }

  if (evaluation.verdict === "indeterminate") {
    // 🔴 「比較していない」を、緑とも赤とも別の名前で出す(Issue #477)。
    lines.push(`🔴 **判定不能(比較していない会話長が在る)**: ${evaluation.reason}`, "");
  }

  const mismatched = diffs.filter((diff) => !diff.matches);
  lines.push(
    `⚠ 基準値と相違した会話長が ${mismatched.length} 件ある` +
      (regressions.length > 0
        ? `(🔴 うち ${regressions.length} 件は退行——ADR 0133 の判定基準` +
          "(mnemoraShareOfNaiveChars の悪化 / factStatementSurvived の true→false)" +
          "に当たる。このベンチは⭐門である——このステップは非0で終わる)。"
        : evaluation.verdict === "indeterminate"
          ? "(退行の判定基準に当たる相違は無いが、上のとおり判定不能である" +
            "——このベンチは⭐門であり、このステップは非0(exit 2)で終わる)。"
          : "(ただし退行の判定基準には当たらない相違のみ。このベンチは⭐門だが、" +
            "この相違だけでは exit 0 のまま——下の内訳を読み、意図した変化かを確認すること)。"),
  );
  for (const diff of mismatched) {
    const regressed = regressedTurnCounts.has(diff.turnCount);
    lines.push("", `### turnCount = ${diff.turnCount}${regressed ? " 🔴 退行" : ""}`);
    if (diff.missingBaseline) {
      lines.push(
        "",
        "🔴 **この会話長は比較していない**——基準値にこの turnCount が無い。" +
          "⟹ 退行したかどうかについて、この行は何も言っていない(Issue #477)。",
      );
      continue;
    }
    lines.push("", "| 項目 | 基準値 | 実測 |", "|---|---|---|");
    for (const fieldDiff of diff.fieldDiffs) {
      lines.push(
        `| ${fieldDiff.field} | ${JSON.stringify(fieldDiff.baseline)} | ${JSON.stringify(fieldDiff.measured)} |`,
      );
    }
  }
  if (extraBaselineRows.length > 0) {
    lines.push(
      "",
      "### 🔴 基準値にのみ存在する会話長(今回の実測に無い——比較していない)",
      "",
      "測る点が黙って減っている。**この会話長について、退行したかどうかは何も言っていない**" +
        "(Issue #477)。",
      "",
      ...extraBaselineRows.map((t) => `- turnCount = ${t}`),
    );
  }
  return lines.join("\n");
}

/** 1 row を表の1行にする。 */
function buildRowLine(row) {
  const ratio = `${(row.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
  const survived = row.factStatementSurvived ? "✅" : "❌";
  return (
    `| ${row.turnCount} | ${row.naiveChars} | ${row.mnemoraChars} | ${ratio} | ` +
    `${row.totalInScope} | ${row.annCandidateCount} | ${row.returnedCount} | ${survived} |`
  );
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと**
 * (`time-term-summary-lib.mjs`/`archive-sweep-cost-summary-lib.mjs` と同じ分担)。
 *
 * `baseline` は任意——`--baseline` を渡さなければ差分節そのものを出さない
 * (門の判定もできない。`compare-summary.mjs` 側で exit 0 にする)。
 *
 * @param {{ measured: Record<string, any>, baseline?: { rows: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = [
    "# compare(北極星の物差し): mnemora/naive の比が実測でどう動いたか(Issue #242)",
    "",
    `provider: llm=${measured.llmMode} / embedding=${measured.embeddingMode}`,
    "",
    "| 会話ターン数 | naive chars | mnemora chars | mnemora/naive | スコープ内 | ANN候補 | 返った件数 | 冒頭の事実 |",
    "|---|---|---|---|---|---|---|---|",
    ...measured.rows.map(buildRowLine),
    "",
  ];
  if (baseline) {
    lines.push(buildDiffSection(measured, baseline), "");
  } else {
    lines.push(
      "⚠ 基準値ファイルがまだ無い(`examples/chat/compare-baseline.json`)。" +
        "--baseline 無しではこのベンチは門として機能しない(exit 0 のまま)。",
      "",
    );
  }
  lines.push(
    "⭐ ADR 0133: このベンチは他5本と異なり門である——同一commitでのCI再実行が" +
      "measuredAtを除いて完全一致したことを実測で確認したため、" +
      "`mnemoraShareOfNaiveChars` の悪化と `factStatementSurvived` の退行(true→false)を" +
      "検知すると exit 1 になる。それ以外の相違(`naiveChars` 等)は報告のみ。",
    "",
    "⭐ Issue #477: **判定は、実測と基準値の turnCount 集合が一致したときだけ行う。**" +
      "一致しなければ緑を出さず、判定不能(exit 2)にする" +
      "——「比較していない」を「退行が無い」と同じ顔で出さないため。",
  );
  return lines.join("\n");
}
