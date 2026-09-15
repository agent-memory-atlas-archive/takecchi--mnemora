#!/usr/bin/env node
/**
 * `examples/chat` の `association-probes` サブコマンド(`MNEMORA_ASSOCIATION_JSON` が
 * 吐く JSON)を人が読める Markdown へ変換し、CI の Job Summary
 * (`$GITHUB_STEP_SUMMARY`)へ載せる CLI(Issue #291)。連想枠(ADR 0151)が
 * 想起の質を動かすかを3本の arm(off / on:maxCount=3 / on:maxCount=5)で比べる。
 *
 * 組み立ては `./association-summary-lib.mjs` の純関数に委ねる
 * (`identifier-probe-summary.mjs`/`-lib.mjs` と同じ分担)。ここは
 *
 * 1. `--measured <path>`(必須)・`--baseline <path>`(任意)を読む
 * 2. ファイルを読んで JSON.parse する(壊れていたら理由を stderr に出して非0で終わる)
 * 3. 形を検査する(`validateMeasured`/`validateBaseline`。壊れていたら同様に非0)
 * 4. Markdown を stdout に出す
 *
 * だけを行う。
 *
 * 使い方:
 *   node scripts/association-summary.mjs --measured <path> [--baseline <path>]
 *
 * 🔴 **基準値ファイルと相違しても exit 0 のままである。**これは意図した設計であり、
 * バグではない——`identifier-probe-summary.mjs`/ADR 0088 §3 と同じ形(「⛔ 門にしない」
 * と「⛔ 基準値と比べない」は別のこと)。**このスクリプトは門ではない。**非0になるのは、
 * 入力そのものが壊れているとき(measured の JSON が読めない・parse できない・必須項目が
 * 無い・型が違う・参照整合性が壊れている。`--baseline` を指定していて、それが読めない/
 * 壊れている場合も含む)だけである。probe は12件しかなく、
 * [ADR 0033](../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md)
 * §3 の規律に照らして閾値の門を置くには足りない標本である。
 *
 * ⚠ **`examples/chat/association-baseline.json` はまだ存在しない**(2026-09-16
 * 時点、CI で1度も実測していないため)。`--baseline` を渡さなければ、基準値なしで
 * Markdown を組み立てる(`./association-summary-lib.mjs` 参照)。
 */
import { readFileSync } from "node:fs";
import {
  buildSummaryMarkdown,
  validateBaseline,
  validateMeasured,
} from "./association-summary-lib.mjs";

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
  console.error(
    "使い方: node scripts/association-summary.mjs --measured <path> [--baseline <path>]",
  );
  process.exit(1);
}

/**
 * ファイルを読んで JSON.parse する。**読めない/parse できない理由をそのまま返す**
 * ——「壊れている」と一括りにせず、次に来る人がどこを見ればいいか分かるようにする
 * (`identifier-probe-summary.mjs` の `readJson` と同じ形)。
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
// **明示的に 0 を宣言する**——`--baseline` が相違を含んでいても、warmup が失敗していても、
// ここまで来たら入力は壊れていない。門ではない、という設計の要をコード上で目に見える
// 形にする(`identifier-probe-summary.mjs` と同じ)。
process.exit(0);
