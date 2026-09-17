#!/usr/bin/env node
/**
 * `examples/chat` の `compare` ベンチ(`MNEMORA_COMPARE_JSON` が吐く JSON)を
 * 人が読める Markdown へ変換し、CI の Job Summary(`$GITHUB_STEP_SUMMARY`)へ載せる CLI
 * (Issue #242)。
 *
 * 組み立ては `./compare-summary-lib.mjs` の純関数に委ねる
 * (`time-term-summary.mjs`/`archive-sweep-cost-summary.mjs` と同じ分担)。ここは
 *
 * 1. `--measured <path>`(必須)・`--baseline <path>`(任意)を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. 形を検査する(`validateMeasured`/`validateBaseline`。壊れていたら同様に非0)
 * 4. Markdown を stdout に出す
 * 5. `--baseline` が在れば `evaluateCompare` に判定させ、その `verdict` を終了コードへ写す
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/compare-summary.mjs --measured <path> [--baseline <path>]
 *
 * ⭐ **`compare` は他5本(retrieval-quality/identifier-probes/consolidation-cost/
 * archive-sweep-cost/time-term)と違い、門である(ADR 0133)。**
 *
 * 終了コード(`check-publish-run-coverage.mjs` と同じ語彙。Issue #477):
 * - `0` = pass —— 実測と基準値の `turnCount` 集合が一致し、そのすべてで退行が無い。
 * - `1` = fail —— 集合は一致しているが、`mnemoraShareOfNaiveChars` の悪化 または
 *   `factStatementSurvived` の true→false 退行を検知した。
 * - `2` = 判定不能 —— **実測と基準値の `turnCount` 集合が一致しない**
 *   (実測に在って基準値に無い会話長は1度も比較されておらず、基準値に在って実測に
 *   無い会話長は測る点が黙って減っている)。⛔ **判定不能を pass に倒さない**
 *   ——「比較していない」を「退行が無い」と同じ顔で出さないためである。
 *   stderr に、比較できなかった `turnCount` を名指しで出す。
 *
 * それ以外で非0(`1`)になるのは、入力そのものが壊れているとき
 * (measured の JSON が読めない・parse できない・rows が欠ける・必須項目が無い。
 * `--baseline` を指定していて、それが読めない/壊れている場合も含む)である。
 *
 * `--baseline` を渡さない場合はこれまで通り exit 0(門として機能しない。
 * 基準値が無ければ悪化の判定そのものができない)。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  evaluateCompare,
  validateBaseline,
  validateMeasured,
} from "./compare-summary-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const measuredPath = readArgValue("--measured");
const baselinePath = readArgValue("--baseline");

if (!measuredPath) {
  console.error("使い方: node scripts/compare-summary.mjs --measured <path> [--baseline <path>]");
  process.exit(1);
}

/**
 * ファイルを読んで JSON.parse する。**読めない/parse できない理由をそのまま返す**
 * ——「壊れている」と一括りにせず、次に来る人がどこを見ればいいか分かるようにする。
 *
 * @param {string} path
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `${label} JSON を読めない（${path}）: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} JSON の parse に失敗した（${path}）: ${err.message}` };
  }
}

const measuredRead = readJson(measuredPath, "実測");
if (!measuredRead.ok) {
  console.error(measuredRead.error);
  process.exit(1);
}
const measuredValidated = validateMeasured(measuredRead.value);
if (!measuredValidated.ok) {
  console.error(measuredValidated.error);
  process.exit(1);
}

let baselineValidated;
if (baselinePath) {
  const baselineRead = readJson(baselinePath, "基準値");
  if (!baselineRead.ok) {
    console.error(baselineRead.error);
    process.exit(1);
  }
  baselineValidated = validateBaseline(baselineRead.value);
  if (!baselineValidated.ok) {
    console.error(baselineValidated.error);
    process.exit(1);
  }
}

console.log(
  buildSummaryMarkdown({
    measured: measuredValidated.value,
    ...(baselineValidated ? { baseline: baselineValidated.value } : {}),
  }),
);

if (baselineValidated) {
  const evaluation = evaluateCompare(measuredValidated.value, baselineValidated.value);

  if (evaluation.verdict === "indeterminate") {
    // ⛔ **判定不能を pass に倒さない**(`check-publish-run-coverage.mjs` と同じ規律)。
    console.error("[compare-summary] 判定不能: 比較していない会話長が在る(Issue #477)。");
    console.error(`[compare-summary] 理由: ${evaluation.reason}`);
    console.error(
      `[compare-summary] 比較した会話長: ${evaluation.comparedTurnCounts.length} 件` +
        (evaluation.comparedTurnCounts.length > 0
          ? `(turnCount=${evaluation.comparedTurnCounts.join(", ")})`
          : ""),
    );
    if (evaluation.measuredOnlyTurnCounts.length > 0) {
      console.error(
        `[compare-summary] 🔴 比較していない会話長(実測に在って基準値に無い) ${evaluation.measuredOnlyTurnCounts.length} 件: ` +
          `turnCount=${evaluation.measuredOnlyTurnCounts.join(", ")}`,
      );
    }
    if (evaluation.baselineOnlyTurnCounts.length > 0) {
      console.error(
        `[compare-summary] 🔴 比較していない会話長(基準値に在って実測に無い) ${evaluation.baselineOnlyTurnCounts.length} 件: ` +
          `turnCount=${evaluation.baselineOnlyTurnCounts.join(", ")}`,
      );
    }
    for (const regression of evaluation.regressions) {
      console.error(
        `[compare-summary] ⚠ 比較できた範囲での退行 turnCount=${regression.turnCount}: ${regression.reasons.join(" / ")}`,
      );
    }
    process.exit(2);
  }

  if (evaluation.verdict === "fail") {
    console.error(
      `[compare-summary] ⭐ 北極星の物差しが ${evaluation.regressions.length} 会話長で退行した(ADR 0133 により門):`,
    );
    for (const regression of evaluation.regressions) {
      console.error(`  - turnCount=${regression.turnCount}: ${regression.reasons.join(" / ")}`);
    }
    process.exit(1);
  }
}

// **明示的に 0 を宣言する**——ここまで来たら、入力は壊れておらず、実測と基準値の
// turnCount 集合が一致し、そのすべてで退行が無い。
process.exit(0);
