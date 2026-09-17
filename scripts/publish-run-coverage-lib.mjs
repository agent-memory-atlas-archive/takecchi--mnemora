/**
 * `scripts/check-publish-run-coverage.mjs`（publish 段のログから網羅を数える CLI）の
 * 純関数の側。ファイル I/O・`gh` の起動・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/ci-green-check-lib.mjs` と同じ分担・同じ理由。
 *
 * ## 背景（ADR 0207「引き受けた負債」）
 *
 * [ADR 0207](../docs/decisions/0207-dry-run-reads-existence-and-coverage-degrades-silently.md)
 * は、`.github/workflows/publish.yml` の予行が「木の版が registry に既に在るパッケージは
 * 冪等の分岐へ短絡し、`npm publish` の経路そのものを一度も通らない」ことを実測した。
 * この劣化は run の `conclusion` にも段の `success`/`skipped` にも現れず、
 * **「段14 のログを `::group::` ごとに1本ずつ人が読む」ことに依拠していた。**
 * 同 ADR の「引き受けた負債」は「機械化するなら、段14 のログから『publish した』の
 * 件数を数えて `PUBLISH_TARGETS` の本数と突き合わせる歯が置ける」と書いて止めていた
 * ——この歯がそれである。
 *
 * ## 読んでいる文言（`.github/workflows/publish.yml` の npm publish 段が出す3つだけ）
 *
 * - `✔ <spec> を publish した` — `npm publish` が exit 0（＝経路を通った）
 * - `✔ <spec> は既に registry に在る（飛ばした）` — 既存版で短絡した
 * - `✗ <spec> の publish が失敗した（exit N）` — 失敗（この場合 step 自体が落ちる。
 *   `::endgroup::` の echo に届かないまま group が閉じないことがある——下の
 *   `parsePublishGroups` はそれも group として拾う）
 *
 * 各本は `::group::npm publish <spec>` / `::endgroup::` で囲まれている。GitHub Actions の
 * runner は、実行時にワークフローコマンドを `##[group]` / `##[endgroup]` へ変換して
 * ログへ出す（**素の `gh api .../logs` は変換後の `##[group]` 形を返す**。run
 * `35169553262` の生ログで実測した）。⟹ **両方の表記を受ける。**
 *
 * ## 確かめていないこと（このファイル自身のドキュメントとして明記する）
 *
 * **このファイルは、ログに印字された文言を読んでいるだけである。**`npm publish` が
 * 実際に何を registry へ送ったか・registry が何を受け取ったかは一切見ていない
 * ——ADR 0066「測ったこと8」が `npm view` を成否の判断に使わない理由と同じで、
 * ここでは逆に「`publish.yml` 自身が印字する、`npm publish` の exit code に基づく文言」
 * を読んでいる。**この文言と registry の実際の状態がずれる経路**（たとえば
 * `publish.yml` の該当行が将来書き換わって文言が変わる）は、このファイルの
 * `classifyPublishOutcome` が新しい文言を「未知」として返すことでしか検知できない
 * ——`unknown` を静かに `published`/`skipped` のどちらかへ倒さないのは、そのための設計である。
 */

/** `2026-09-17T01:14:00.3481028Z ` のような行頭タイムスタンプ。 */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;
/** ANSI SGR エスケープ（`\x1b[36;1m` 等）。runner が「これから打つ script」を色付きで
 * 先に印字する行（`Run set -euo pipefail` group の中身）に付く。 */
// eslint-disable-next-line no-control-regex -- ANSI エスケープの除去に \x1b を使う。
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** `::group::npm publish <spec>` / `##[group]npm publish <spec>` の開始行。 */
const GROUP_START_RE = /^(?:::group::|##\[group\])npm publish (.+?)\s*$/;
/** `::endgroup::` / `##[endgroup]` の終了行。 */
const GROUP_END_RE = /^(?:::endgroup::|##\[endgroup\])\s*$/;

/** publish.yml が予行のときだけ印字する固定文言（`publish.yml` 220行目付近）。 */
const DRY_RUN_MARKER = "予行（--dry-run）です。registry へは何も上がりません。";

/**
 * 行頭のタイムスタンプと ANSI エスケープを取り除く。
 *
 * ⚠ 先頭の空白は取り除かない——「これから打つ script」の中身をそのまま印字する
 * `Run set -euo pipefail` group の行（例:
 * `  echo "::group::npm publish ${spec}"`）は、ANSI を剥がしても
 * `  echo "` が残るため、下の `GROUP_START_RE`（行頭アンカー）に一致しない。
 * **これが、未展開のテンプレート文字列を実際の group と誤認しないための唯一の防波堤
 * である**——行頭アンカー自体を緩めないこと。
 *
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
  return line.replace(TIMESTAMP_RE, "").replace(ANSI_RE, "");
}

/**
 * publish 段の生ログから `npm publish <spec>` の group を1本ずつ切り出す。
 *
 * **`::endgroup::` を見ないまま次の group や末尾に達した場合も、そこまでの本文で
 * 1本として確定する**——`npm publish` が失敗すると `exit "${STATUS}"` が
 * `echo "::endgroup::"` より先に実行され、その回の group は閉じずに step 自体が
 * 落ちる（`.github/workflows/publish.yml` の npm publish 段を参照）。閉じていない
 * ことを理由にその1本を捨てると、**最も知りたい「失敗した」本を取りこぼす。**
 *
 * @param {string} logText
 * @returns {{ spec: string, body: string }[]}
 */
export function parsePublishGroups(logText) {
  const rawLines = logText.split(/\r?\n/);
  /** @type {{ spec: string, bodyLines: string[] } | null} */
  let current = null;
  /** @type {{ spec: string, body: string }[]} */
  const groups = [];

  const closeCurrent = () => {
    if (current) {
      groups.push({ spec: current.spec, body: current.bodyLines.join("\n") });
      current = null;
    }
  };

  for (const rawLine of rawLines) {
    const line = normalizeLine(rawLine);
    const startMatch = line.match(GROUP_START_RE);
    if (startMatch) {
      // 前の group が ::endgroup:: を見ないまま次の group が来た（通常は起きない
      // ——失敗した回で step 自体が落ちるので、その後の group は無い。念のための防御）。
      closeCurrent();
      current = { spec: startMatch[1], bodyLines: [] };
      continue;
    }
    if (GROUP_END_RE.test(line)) {
      closeCurrent();
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  // ログがちょうど group の途中で終わっている（打ち切られた・失敗して step が落ちた）。
  closeCurrent();

  return groups;
}

/**
 * `name@version` の spec からパッケージ名を取り出す。
 *
 * scoped パッケージ（`@mnemora/core@0.1.1`）は `@` を2つ持つので、**最後の `@` を
 * バージョンの区切りとして扱う**（npm 自身の spec 解釈と同じ）。
 *
 * @param {string} spec
 * @returns {{ name: string, version: string | null }}
 */
export function parseSpecName(spec) {
  const match = spec.match(/^(.+)@([^@]+)$/);
  if (!match) return { name: spec, version: null };
  return { name: match[1], version: match[2] };
}

/**
 * 1本の group の本文から、3つの既知の文言のどれに当たるかを判定する。
 *
 * **`publish.yml` が出しうる文言はこの3つだけである**（185-241行を通読して確認した。
 * ADR 0207 も同じ3値を前提にしている）。**どれにも一致しなければ `"unknown"` を返す
 * ——`published`/`skipped` のどちらかへ黙って倒さない。**`unknown` は
 * `evaluatePublishRunCoverage` で「判定不能」に上げる材料になる。
 *
 * @param {string} body
 * @returns {"published" | "skipped" | "failed" | "unknown"}
 */
export function classifyPublishOutcome(body) {
  if (body.includes("を publish した")) return "published";
  if (body.includes("既に registry に在る（飛ばした）")) return "skipped";
  if (body.includes("の publish が失敗した")) return "failed";
  return "unknown";
}

/**
 * ログに予行の固定文言が**実行結果として**出ているかどうかを見る。
 *
 * ⚠ **`logText.includes(DRY_RUN_MARKER)` では足りない**——実測して分かった穴である。
 * GitHub Actions の runner は、`npm publish` 段の実行に先立って「これから打つ script」
 * 全文を `Run set -euo pipefail` group の中に ANSI 色付きでそのまま印字する。
 * この script は `if [ "${DRY_RUN}" = "true" ]; then echo "予行（--dry-run）です。…"; fi`
 * を含むため、**このプレビュー行には `DRY_RUN` の実際の値に関係なく、常に固定文言が
 * 文字通り現れる**（本番 `release` run
 * [`35077566069`](https://github.com/takecchi/mnemora/actions/runs/35077566069) の生ログで
 * 実測した——`DRY_RUN=false` のはずの run でも、このプレビュー行だけは変わらず出る）。
 * ⟹ **単純な部分一致は、本番 run を予行だと誤判定する。**
 *
 * 本物の実行結果は、タイムスタンプの直後に**ANSI も引用符も無い生の行**として出る
 * （予行 run `35169553262` で実測: `…Z 予行（--dry-run）です。registry へは何も上がりません。`）。
 * プレビュー行は必ず ANSI エスケープ＋`  echo "..."` の形を伴うので、
 * **行を正規化（タイムスタンプ除去・ANSI 除去）した後、完全一致で見る**ことで区別できる
 * ——`parsePublishGroups` が `::group::npm publish` のプレビューを弾くのと同じ考え方。
 *
 * @param {string} logText
 * @returns {boolean}
 */
export function detectDryRunMarker(logText) {
  return logText.split(/\r?\n/).some((rawLine) => normalizeLine(rawLine) === DRY_RUN_MARKER);
}

/**
 * `PUBLISH_TARGETS` と、ログから切り出した group を突き合わせて判定する。
 *
 * ⛔ **本数・名前はすべて呼び出し側が渡す `publishTargets` から読む。**このファイルは
 * `6` のようなリテラルを一切持たない——`PUBLISH_TARGETS` が増減しても、この関数は
 * 書き換えを要らない。
 *
 * **pass**: `publishTargets` の全本が `"published"` である。
 * **fail**: 1本でも `"skipped"`/`"failed"`/`"missing"`（ログに1度も現れない）、
 * または `publishTargets` に無い名前がログに出た（`unexpectedNames`）。
 * **indeterminate**: group が1つも見つからない（publish 段が走っていない・
 * ログがそもそも publish 段まで届いていない可能性）、または1本でも `"unknown"`
 * （3つの既知文言のどれにも一致しない——ログの文言が変わった可能性があり、
 * fail と決め打つと「本当は通っていたのに fail と言う」誤りを生みうる。
 * pass と決め打つと逆の誤りを生む。⟹ **どちらにも倒さず判定不能にする。**）。
 *
 * @param {string} logText
 * @param {{ name: string }[]} publishTargets
 * @returns {{
 *   verdict: "pass" | "fail" | "indeterminate",
 *   reason: string,
 *   isDryRun: boolean | null,
 *   totalTargets: number,
 *   publishedCount: number,
 *   perTarget: { name: string, outcome: "published" | "skipped" | "failed" | "missing" | "unknown", spec?: string }[],
 *   unexpectedNames: string[],
 * }}
 */
export function evaluatePublishRunCoverage(logText, publishTargets) {
  const groups = parsePublishGroups(logText);

  const byName = new Map();
  for (const group of groups) {
    const { name } = parseSpecName(group.spec);
    const outcome = classifyPublishOutcome(group.body);
    // 同じ名前の group が複数回現れることは通常無いが、現れた場合は最後のものを採る
    // （途中で退避コピーの規律違反等が無い限り再現しない想定——起きたら unexpectedNames
    // 側ではなく、ここで silently 上書きすることになる。この振る舞い自体は検査していない）。
    byName.set(name, { spec: group.spec, outcome });
  }

  const targetNames = publishTargets.map((t) => t.name);
  const targetNameSet = new Set(targetNames);

  /** @type {{ name: string, outcome: "published" | "skipped" | "failed" | "missing" | "unknown", spec?: string }[]} */
  const perTarget = targetNames.map((name) => {
    const entry = byName.get(name);
    if (!entry) return { name, outcome: "missing" };
    return { name, outcome: entry.outcome, spec: entry.spec };
  });

  const unexpectedNames = [...byName.keys()].filter((name) => !targetNameSet.has(name));
  const publishedCount = perTarget.filter((p) => p.outcome === "published").length;
  const skippedNames = perTarget.filter((p) => p.outcome === "skipped").map((p) => p.name);
  const failedNames = perTarget.filter((p) => p.outcome === "failed").map((p) => p.name);
  const missingNames = perTarget.filter((p) => p.outcome === "missing").map((p) => p.name);
  const unknownNames = perTarget.filter((p) => p.outcome === "unknown").map((p) => p.name);

  const isDryRun = groups.length === 0 ? null : detectDryRunMarker(logText);

  /** @type {"pass" | "fail" | "indeterminate"} */
  let verdict;
  let reason;

  if (groups.length === 0) {
    verdict = "indeterminate";
    reason =
      "ログに npm publish の ::group::（または ##[group]）が1つも見つからなかった。" +
      "publish 段が走っていない・ログが publish 段まで届いていない・ログの取得自体に" +
      "問題がある、のいずれかである可能性がある。";
  } else if (unknownNames.length > 0) {
    verdict = "indeterminate";
    reason =
      `次の対象の本文が、既知の3文言（を publish した / 既に registry に在る（飛ばした） / ` +
      `の publish が失敗した）のどれにも一致しなかった: ${unknownNames.join(", ")}。` +
      `publish.yml の文言が変わった可能性がある。`;
  } else if (
    unexpectedNames.length > 0 ||
    skippedNames.length > 0 ||
    failedNames.length > 0 ||
    missingNames.length > 0
  ) {
    verdict = "fail";
    const parts = [];
    if (skippedNames.length > 0) parts.push(`飛ばした: ${skippedNames.join(", ")}`);
    if (failedNames.length > 0) parts.push(`失敗した: ${failedNames.join(", ")}`);
    if (missingNames.length > 0) parts.push(`ログに無い: ${missingNames.join(", ")}`);
    if (unexpectedNames.length > 0) {
      parts.push(`PUBLISH_TARGETS に無い名前がログに在る: ${unexpectedNames.join(", ")}`);
    }
    reason =
      `${publishedCount}/${targetNames.length} 本しか publish 経路を通っていない（${parts.join("; ")}）。` +
      (isDryRun
        ? "予行なので「壊れている」ではない——この予行が確かめたのはこの本数だけ、という意味である（ADR 0207）。"
        : "");
  } else {
    verdict = "pass";
    reason = `PUBLISH_TARGETS の全 ${targetNames.length} 本が publish 経路を通った（"を publish した"）。`;
  }

  return {
    verdict,
    reason,
    isDryRun,
    totalTargets: targetNames.length,
    publishedCount,
    perTarget,
    unexpectedNames,
  };
}

/**
 * `.github/workflows/publish.yml` の中から、`::group::npm publish` を出している
 * step の `name:` を、テキスト上の探索だけで見つける。
 *
 * ⛔ **段の番号では見つけない**（GitHub の step 番号は「Set up job」を含むかどうかで
 * ずれる。`docs/release-v1.md` §1.2 では同じ段が12番と呼ばれているが、GitHub の
 * Checks UI では14番になる——この関数はどちらの数字も使わない）。
 * ⟹ **step 名そのものを、`::group::npm publish` という現物の目印から逆算する。**
 * これにより、`publish.yml` の該当 step の名前が将来変わっても、この関数は
 * 書き換えを要らない（呼び出し側が現在の `publish.yml` のテキストを渡す限り）。
 *
 * 簡易なテキスト走査であり、YAML パーサではない——`- name: ...` の行を見た時点の
 * 直近の名前を覚えておき、`::group::npm publish` を含む行に出会った時点の
 * 直近の名前を返す。`publish.yml` の step の中身がこの前提を崩す形
 * （`- name:` を持たない step が `::group::npm publish` を出す等）に変わったら、
 * この関数は `null` を返す——**呼び出し側は `null` を「見つからなかった」として
 * 扱うこと。**
 *
 * @param {string} workflowYamlText
 * @returns {string | null}
 */
export function findPublishStepName(workflowYamlText) {
  const lines = workflowYamlText.split(/\r?\n/);
  let currentName = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (nameMatch) {
      currentName = stripYamlScalarQuotes(nameMatch[1]);
      continue;
    }
    if (line.includes("::group::npm publish")) {
      return currentName;
    }
  }
  return null;
}

/**
 * YAML のスカラーが `"..."` / `'...'` で囲まれていたら剥がす（`findPublishStepName` の
 * 入力は `- name: "..."` 形式のこともある）。厳密な YAML アンエスケープではない
 * ——単純に先頭と末尾の一致する引用符を1組だけ取り除く。
 *
 * @param {string} value
 * @returns {string}
 */
function stripYamlScalarQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
