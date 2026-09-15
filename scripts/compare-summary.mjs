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
 * 5. `--baseline` が在れば `computeRegressions` で退行を判定し、退行が在れば非0で終わる
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/compare-summary.mjs --measured <path> [--baseline <path>]
 *
 * ⭐ **`compare` は他5本(retrieval-quality/identifier-probes/consolidation-cost/
 * archive-sweep-cost/time-term)と違い、門である(ADR 0133)。**
 * `--baseline` を渡し、かつ `mnemoraShareOfNaiveChars` の悪化 または
 * `factStatementSurvived` の true→false 退行を検知したら、非0で終わる
 * (`compare-summary-lib.mjs` の `computeRegressions`)。
 *
 * それ以外で非0になるのは、入力そのものが壊れているとき
 * (measured の JSON が読めない・parse できない・rows が欠ける・必須項目が無い。
 * `--baseline` を指定していて、それが読めない/壊れている場合も含む)である。
 *
 * `--baseline` を渡さない場合はこれまで通り exit 0(門として機能しない。
 * 基準値が無ければ悪化の判定そのものができない)。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  computeRegressions,
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
  const regressions = computeRegressions(measuredValidated.value, baselineValidated.value);
  if (regressions.length > 0) {
    console.error(
      `[compare-summary] ⭐ 北極星の物差しが ${regressions.length} 会話長で退行した(ADR 0133 により門):`,
    );
    for (const regression of regressions) {
      console.error(`  - turnCount=${regression.turnCount}: ${regression.reasons.join(" / ")}`);
    }
    process.exit(1);
  }
}

// **明示的に 0 を宣言する**——ここまで来たら、入力は壊れておらず退行も無い。
process.exit(0);
