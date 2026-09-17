/**
 * ルートの `test` 門（`scripts/run-root-test-gate.mjs`）の判定部（Issue #453）。
 *
 * **直す前の門（逐語）**:
 * ```json
 * "test": "vitest run && pnpm -r --if-present run test && node scripts/run-db-tests.mjs"
 * ```
 *
 * **欠陥**: 3段が `&&` で連結されている。段1（`vitest run`）が落ちると、shell は
 * 左辺が非0の時点で評価を止めるため、段2（`pnpm -r --if-present run test`）と
 * 段3（`node scripts/run-db-tests.mjs`）は**一度も起動されない**。手元や CI の出力には
 * 「テストが赤い」としか出ず、どの段がそもそも走っていないかは読み取れない
 * ——**「赤1件」の裏に「未起動の段」が隠れる。**
 *
 * さらに段2自身（`pnpm -r`）も既定で bail する（`pnpm run --help` の `--no-bail` の
 * 説明）ため、対象パッケージのうち1つが落ちると、残りのパッケージの `test` も
 * 未起動のまま終わる——同じ族の欠陥が段2の内側にもう1つある。
 *
 * **⚠ 壊れているのは「赤の読み方」だけで「緑の意味」は壊れていない**（Issue #453 本文）。
 * 3段すべてが実際に通ったときの緑は、直す前も直した後も同じ意味を持つ。壊れていたのは、
 * 赤が出たときに「どこまで実際に検査されたか」を読み取れないことだけである。
 *
 * **直した向き**: 3段を前段の成否に関わらず全部走らせ（`scripts/run-root-test-gate.mjs`）、
 * 各段の結果をこのファイルの純関数で要約する。`&&` を握り潰すのではなく、
 * **止まらずに全部起動したうえで、何が走って何が通って何が落ちたかを1画面に出す。**
 *
 * この関数群は副作用（`console.log` / 子プロセスの起動 / `process.exit`）を持たない。
 * CLI としての入口は `scripts/run-root-test-gate.mjs` にある——`scripts/publish-dry-run.mjs` /
 * `scripts/decide-publish-dry-run.mjs` と同じ「判定関数と実行部を別ファイルに分ける」形に
 * 揃えた（歯が副作用無しに要約・終了コードを直接検査できるようにするため）。
 */

/**
 * @typedef {Object} StageResult
 * @property {string} name - 段の名前（要約に出す表示名）
 * @property {boolean} ran - この段が実際に起動されたか。
 *   `run-root-test-gate.mjs` は3段すべてを前段の成否に関わらず起動するため、
 *   本物の CLI が作る配列ではここは常に `true` になる。それでもこの関数が
 *   `ran` をフィールドとして持つのは、「走ったかどうか」自体を要約に出すことが、
 *   この Issue が直そうとしている性質だからである——`ran` を落とせば、この関数
 *   だけを見て「未起動が起きていないこと」を検査できなくなる。
 * @property {number | null} exitCode - 起動した場合の終了コード（0 = 成功）。
 *   `ran` が `false` のときは意味を持たないので `null` にすること。
 */

const BANNER = "─".repeat(72);

/**
 * 門が起動する3段の定義（**この配列が配線そのものである**）。
 *
 * ⭐ **なぜ CLI ではなくこちら側に置くか**: 配線を釘付けにする歯
 * （`scripts/__tests__/run-db-tests.test.mjs` の「ルートの test 門の配線」）が、
 * **本物のデータを測れるようにするため。**`scripts/run-root-test-gate.mjs` は
 * import された時点で3段を起動してしまうので、歯から import できない
 * ——そちらに配列を置くと、歯はソースを文字列として読むしかなくなり、
 * **冒頭のコメントに同じ語が同じ順で並んでいるだけで緑になる。**
 * ⟹ 副作用の無いこのファイルに置き、歯はここを import する。
 *
 * @type {{ name: string; command: string; args: string[] }[]}
 */
export const STAGES = [
  { name: "vitest run", command: "pnpm", args: ["exec", "vitest", "run"] },
  {
    name: "pnpm -r --if-present --no-bail run test",
    command: "pnpm",
    args: ["-r", "--if-present", "--no-bail", "run", "test"],
  },
  { name: "run-db-tests（ADR 0015）", command: "node", args: ["scripts/run-db-tests.mjs"] },
];

/**
 * 各段の結果から、1画面で読める要約テキストを作る。
 *
 * ⭐ **この門が解こうとしている問題は「赤1件の裏に未起動の段が在る」ことなので**、
 * 要約は必ず「何段中何段が実際に走ったか」を名指しする一行を持つ——
 * **全段が失敗していても、この一行は「3/3 段が実際に走りました」を報告する**
 * （落ちたことと、起動されなかったことは、要約の上でも別の事実として出す）。
 *
 * @param {StageResult[]} results
 * @returns {string}
 */
export function summarizeStages(results) {
  const lines = [BANNER, "ルートの test 門: 各段の結果", ""];

  for (const stage of results) {
    if (!stage.ran) {
      lines.push(`  ⊘ 未起動  ${stage.name}`);
      continue;
    }
    if (stage.exitCode === 0) {
      lines.push(`  ✔ 成功    ${stage.name}（exit 0）`);
    } else {
      lines.push(`  ✗ 失敗    ${stage.name}（exit ${stage.exitCode}）`);
    }
  }

  const ranCount = results.filter((stage) => stage.ran).length;
  const failedNames = results
    .filter((stage) => stage.ran && stage.exitCode !== 0)
    .map((stage) => stage.name);
  const notRunNames = results.filter((stage) => !stage.ran).map((stage) => stage.name);

  lines.push("");
  lines.push(`  ${ranCount}/${results.length} 段が実際に走りました。`);

  if (failedNames.length > 0) {
    lines.push(`  失敗した段: ${failedNames.join(", ")}`);
  }
  if (notRunNames.length > 0) {
    lines.push(`  未起動の段: ${notRunNames.join(", ")}`);
  }

  lines.push("");
  lines.push(gateExitCode(results) === 0 ? "  門: ✔ 通過" : "  門: ✗ 失敗");
  lines.push(BANNER);

  return lines.join("\n");
}

/**
 * 各段の結果から、門全体の終了コードを決める。
 *
 * 1つでも段が失敗した（`ran: true` かつ `exitCode !== 0`）、または
 * 1つでも段が未起動（`ran: false`）であれば非ゼロを返す。未起動の段は
 * 「検査していない」のであって「通った」のではないので、成功として扱わない
 * ——`run-root-test-gate.mjs` は3段を必ず全部起動するため、本物の CLI で
 * `ran: false` が混ざることは無いはずだが、この関数自身は「起動されなかった
 * 段が紛れ込んでも黙って緑にしない」ことを保証する。
 *
 * @param {StageResult[]} results
 * @returns {number} 0 = 全段が走って全段成功、1 = それ以外
 */
export function gateExitCode(results) {
  const allRanAndPassed = results.every((stage) => stage.ran && stage.exitCode === 0);
  return allRanAndPassed ? 0 : 1;
}
