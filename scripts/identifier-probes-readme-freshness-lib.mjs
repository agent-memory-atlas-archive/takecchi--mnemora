/**
 * `examples/chat/README.md` の `identifier-probes` 節が、
 * `examples/chat/identifier-probe-baseline.json` の実体と食い違っていないかを
 * 機械的に検査する純関数の側（Issue #425 件3）。
 *
 * `scripts/identifier-probe-summary-lib.mjs` と同じ分担——ファイル I/O・
 * `process.argv`・`process.exit` を一切持たない。呼び出す側（この場合は
 * `scripts/__tests__/identifier-probes-readme-freshness.test.mjs`）がファイルを
 * 読んで渡す。
 *
 * ## なぜこの歯が要るか
 *
 * Issue #425 が見つけた実例: `identifier-probe-baseline.json` に
 * `identifiersSparse`/`identifiersDense` の probe を12→30件へ増やす変更
 * （`3350e18`）と、`japaneseNamesSparse`/`japaneseNamesDense` の2群を新設する変更
 * （`4602678`）が入ったが、**どちらのコミットメッセージも「本文（README）は
 * 書き換えていない」と自認していた**——README は「3群」「12件」「hit@1=12/12」の
 * ままだった。この歯は、次に同じ形の drift が起きたときに `pnpm run test`（ルート）で
 * 検知できるようにする。
 *
 * ## 何を見て、何を見ないか
 *
 * - **見る**: 群の数（見出し「N群を別々に集計する」）・群の一覧（比較表の1列目）・
 *   実測結果の表（群ごとの `probeCount`・`hit1Count`/`probeCount`・
 *   `hit10Count`/`probeCount`・`mrrOverall`（丸めて3桁）)。
 * - **見ない**: 文章の説明・description の逐語一致・見出し以外のプローズ。
 *   ⛔ **性能の絶対値そのものが「良いか悪いか」は判定しない**——
 *   `docs/autonomy.md` §4「擬似 provider の数字を『性能』と読む」と同じ理由で、
 *   この歯が縛るのは「本数・件数・群数のような、実体から機械的に数え直せるもの」
 *   （Issue #425 の「⭐ どうすれば再発しないか」候補2）だけである。
 */

/** @typedef {{ group: string, probeCount: number, hit1Count: number, hit10Count: number, mrr: number }} BaselineGroupSummary */
/** @typedef {{ group: string, probeCount: number, hit1: number, hit1Total: number, hit10: number, hit10Total: number, mrr: number }} ReadmeResultRow */

/**
 * `## \`identifier-probes\`: ...` から次の `## \`...\`` 見出し（または文末）までを
 * 切り出す。**この節は README 内に「実測結果」という見出しを持つ節が他にもある**
 * （`compare` 節）ため、群一覧表・実測結果の表を探す前に、まずこの節だけへ絞る。
 *
 * @param {string} readmeText
 * @returns {string} 見出しが見つからなければ空文字列
 */
export function extractIdentifierProbesSection(readmeText) {
  const headingIndex = readmeText.search(/^## `identifier-probes`:/m);
  if (headingIndex === -1) {
    return "";
  }
  const afterHeading = readmeText.slice(headingIndex);
  const nextTopHeading = afterHeading.slice(1).search(/^## `/m);
  return nextTopHeading === -1 ? afterHeading : afterHeading.slice(0, nextTopHeading + 1);
}

/**
 * 見出し「### N群を別々に集計する」の N を取る（`identifier-probes` 節の中だけを見る）。
 *
 * @param {string} readmeText
 * @returns {number | null} 見つからなければ null
 */
export function extractGroupCountClaim(readmeText) {
  const section = extractIdentifierProbesSection(readmeText) || readmeText;
  const match = section.match(/###\s*(\d+)群を別々に集計する/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

/**
 * 「群 | probe | haystack | 直接比較できる相手」表（`### N群を別々に集計する` の
 * 直後にある、群の一覧表）から、1列目の群名（バッククォートで囲まれた識別子）を
 * 出現順に取る。
 *
 * @param {string} readmeText
 * @returns {string[]}
 */
export function extractGroupOverviewTableNames(readmeText) {
  const section = extractIdentifierProbesSection(readmeText) || readmeText;
  const headingIndex = section.search(/###\s*\d+群を別々に集計する/);
  if (headingIndex === -1) {
    return [];
  }
  const afterHeading = section.slice(headingIndex);
  const tableEnd = afterHeading.search(/\n###\s/);
  const tableSection = tableEnd === -1 ? afterHeading : afterHeading.slice(0, tableEnd);
  const names = [];
  for (const line of tableSection.split("\n")) {
    const rowMatch = line.match(/^\|\s*`([a-zA-Z]+)`\s*\|/);
    if (rowMatch) {
      names.push(rowMatch[1]);
    }
  }
  return names;
}

/**
 * 「実測結果」の表（群名(N件) | (provider,model,dimensions) | haystack | MRR | hit@1 |
 * hit@10）を parse する。行頭の 🔴 等の絵文字マーカーは無視する。
 *
 * ⚠ **README には「実測結果」という見出しを持つ節が `identifier-probes` 以外にも
 * ある**（`compare` 節）——だから、まず `identifier-probes` 節だけへ絞ってから探す。
 *
 * @param {string} readmeText
 * @returns {ReadmeResultRow[]}
 */
export function extractResultsTable(readmeText) {
  const section = extractIdentifierProbesSection(readmeText) || readmeText;
  const headingIndex = section.search(/###\s*実測結果/);
  if (headingIndex === -1) {
    return [];
  }
  const afterHeading = section.slice(headingIndex);
  const tableEnd = afterHeading.search(/\n###\s/);
  const tableSection = tableEnd === -1 ? afterHeading : afterHeading.slice(0, tableEnd);
  const rowPattern =
    /^\|\s*(?:🔴\s*)?`([a-zA-Z]+)`\((\d+)件\)\s*\|[^|]*\|[^|]*\|\s*\*\*([\d.]+)\*\*\s*\|\s*(\d+)\/(\d+)\s*\|\s*(\d+)\/(\d+)\s*\|/;
  /** @type {ReadmeResultRow[]} */
  const rows = [];
  for (const line of tableSection.split("\n")) {
    const match = line.match(rowPattern);
    if (!match) {
      continue;
    }
    const [, group, probeCountStr, mrrStr, hit1Str, hit1TotalStr, hit10Str, hit10TotalStr] = match;
    rows.push({
      group,
      probeCount: Number(probeCountStr),
      mrr: Number(mrrStr),
      hit1: Number(hit1Str),
      hit1Total: Number(hit1TotalStr),
      hit10: Number(hit10Str),
      hit10Total: Number(hit10TotalStr),
    });
  }
  return rows;
}

/**
 * 基準値 JSON（パース済み、`identifier-probe-baseline.json` の形）から、比較に
 * 必要な項目だけを群ごとに取り出す。
 *
 * @param {{ groups: Array<{ group: string, probeCount: number, hit1Count: number, hit10Count: number, mrrOverall: number }> }} baseline
 * @returns {BaselineGroupSummary[]}
 */
export function extractBaselineSummary(baseline) {
  return baseline.groups.map((g) => ({
    group: g.group,
    probeCount: g.probeCount,
    hit1Count: g.hit1Count,
    hit10Count: g.hit10Count,
    mrr: g.mrrOverall,
  }));
}

/**
 * 3桁に丸める（README側の表記 `**0.958**` のような3桁固定に合わせるため）。
 *
 * @param {number} value
 * @returns {number}
 */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * README の記述が基準値 JSON の実体と一致するかを検査し、問題点の一覧を返す
 * （空配列なら一致）。
 *
 * @param {string} readmeText
 * @param {{ groups: Array<{ group: string, probeCount: number, hit1Count: number, hit10Count: number, mrrOverall: number }> }} baseline
 * @returns {string[]}
 */
export function checkReadmeMatchesBaseline(readmeText, baseline) {
  /** @type {string[]} */
  const problems = [];
  const baselineGroups = extractBaselineSummary(baseline);
  const baselineGroupCount = baselineGroups.length;

  const claimedCount = extractGroupCountClaim(readmeText);
  if (claimedCount === null) {
    problems.push("見出し「N群を別々に集計する」が見つからない");
  } else if (claimedCount !== baselineGroupCount) {
    problems.push(
      `見出しは「${claimedCount}群」と書いているが、基準値には${baselineGroupCount}群ある`,
    );
  }

  const overviewNames = extractGroupOverviewTableNames(readmeText);
  const baselineNames = baselineGroups.map((g) => g.group);
  for (const name of baselineNames) {
    if (!overviewNames.includes(name)) {
      problems.push(`群一覧表に基準値の群「${name}」が無い`);
    }
  }
  for (const name of overviewNames) {
    if (!baselineNames.includes(name)) {
      problems.push(`群一覧表に基準値に無い群「${name}」がある`);
    }
  }

  const resultRows = extractResultsTable(readmeText);
  const resultRowsByGroup = new Map(resultRows.map((r) => [r.group, r]));
  for (const baselineGroup of baselineGroups) {
    const row = resultRowsByGroup.get(baselineGroup.group);
    if (!row) {
      problems.push(`実測結果の表に基準値の群「${baselineGroup.group}」の行が無い`);
      continue;
    }
    if (row.probeCount !== baselineGroup.probeCount) {
      problems.push(
        `${baselineGroup.group}: probe件数がREADME=${row.probeCount}件、基準値=${baselineGroup.probeCount}件`,
      );
    }
    if (row.hit1 !== baselineGroup.hit1Count || row.hit1Total !== baselineGroup.probeCount) {
      problems.push(
        `${baselineGroup.group}: hit@1がREADME=${row.hit1}/${row.hit1Total}、` +
          `基準値=${baselineGroup.hit1Count}/${baselineGroup.probeCount}`,
      );
    }
    if (row.hit10 !== baselineGroup.hit10Count || row.hit10Total !== baselineGroup.probeCount) {
      problems.push(
        `${baselineGroup.group}: hit@10がREADME=${row.hit10}/${row.hit10Total}、` +
          `基準値=${baselineGroup.hit10Count}/${baselineGroup.probeCount}`,
      );
    }
    if (row.mrr !== round3(baselineGroup.mrr)) {
      problems.push(
        `${baselineGroup.group}: MRRがREADME=${row.mrr}、基準値=${round3(baselineGroup.mrr)}（丸め後）`,
      );
    }
  }
  for (const row of resultRows) {
    if (!baselineNames.includes(row.group)) {
      problems.push(`実測結果の表に基準値に無い群「${row.group}」の行がある`);
    }
  }

  return problems;
}
