import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkReadmeMatchesBaseline,
  extractBaselineSummary,
  extractGroupCountClaim,
  extractGroupOverviewTableNames,
  extractResultsTable,
} from "../identifier-probes-readme-freshness-lib.mjs";

const README_PATH = fileURLToPath(new URL("../../examples/chat/README.md", import.meta.url));
const BASELINE_PATH = fileURLToPath(
  new URL("../../examples/chat/identifier-probe-baseline.json", import.meta.url),
);

const FIXTURE_README = `
### 5群を別々に集計する（⛔ 混ぜた単一の MRR にしない）

| 群 | probe | haystack | 直接比較できる相手 |
|---|---|---|---|
| \`japanese\` | 7件 | sparse | x |
| \`identifiersSparse\` | 30件 | sparse | x |
| \`identifiersDense\` | 30件 | dense | x |
| \`japaneseNamesSparse\` | 12件 | sparse | x |
| \`japaneseNamesDense\` | 12件 | dense | x |

### 実測結果（fixture）

| 群 | \`(provider, model, dimensions)\` | haystack | MRR | hit@1 | hit@10 |
|---|---|---|---|---|---|
| \`japanese\`(7件) | local | sparse | **0.810** | 5/7 | 7/7 |
| \`identifiersSparse\`(30件) | local | sparse | **1.000** | 30/30 | 30/30 |
| \`identifiersDense\`(30件) | local | dense | **1.000** | 30/30 | 30/30 |
| 🔴 \`japaneseNamesSparse\`(12件) | local | sparse | **0.958** | 11/12 | 12/12 |
| 🔴 \`japaneseNamesDense\`(12件) | local | dense | **0.958** | 11/12 | 12/12 |

### 次の節
`;

const FIXTURE_BASELINE = {
  groups: [
    {
      group: "japanese",
      probeCount: 7,
      hit1Count: 5,
      hit10Count: 7,
      mrrOverall: 0.8095238095238095,
    },
    {
      group: "identifiersSparse",
      probeCount: 30,
      hit1Count: 30,
      hit10Count: 30,
      mrrOverall: 1,
    },
    { group: "identifiersDense", probeCount: 30, hit1Count: 30, hit10Count: 30, mrrOverall: 1 },
    {
      group: "japaneseNamesSparse",
      probeCount: 12,
      hit1Count: 11,
      hit10Count: 12,
      mrrOverall: 0.9583333333333334,
    },
    {
      group: "japaneseNamesDense",
      probeCount: 12,
      hit1Count: 11,
      hit10Count: 12,
      mrrOverall: 0.9583333333333334,
    },
  ],
};

describe("identifier-probes-readme-freshness-lib（fixture、純関数の parse）", () => {
  it("見出しから群数を取る", () => {
    expect(extractGroupCountClaim(FIXTURE_README)).toBe(5);
  });

  it("見出しが無ければ null", () => {
    expect(extractGroupCountClaim("# 何もない")).toBeNull();
  });

  it("群一覧表から群名を出現順に取る", () => {
    expect(extractGroupOverviewTableNames(FIXTURE_README)).toEqual([
      "japanese",
      "identifiersSparse",
      "identifiersDense",
      "japaneseNamesSparse",
      "japaneseNamesDense",
    ]);
  });

  it("実測結果の表を group/probeCount/mrr/hit1/hit10 へ parse する（🔴 マーカーを無視する）", () => {
    const rows = extractResultsTable(FIXTURE_README);
    expect(rows).toEqual([
      {
        group: "japanese",
        probeCount: 7,
        mrr: 0.81,
        hit1: 5,
        hit1Total: 7,
        hit10: 7,
        hit10Total: 7,
      },
      {
        group: "identifiersSparse",
        probeCount: 30,
        mrr: 1,
        hit1: 30,
        hit1Total: 30,
        hit10: 30,
        hit10Total: 30,
      },
      {
        group: "identifiersDense",
        probeCount: 30,
        mrr: 1,
        hit1: 30,
        hit1Total: 30,
        hit10: 30,
        hit10Total: 30,
      },
      {
        group: "japaneseNamesSparse",
        probeCount: 12,
        mrr: 0.958,
        hit1: 11,
        hit1Total: 12,
        hit10: 12,
        hit10Total: 12,
      },
      {
        group: "japaneseNamesDense",
        probeCount: 12,
        mrr: 0.958,
        hit1: 11,
        hit1Total: 12,
        hit10: 12,
        hit10Total: 12,
      },
    ]);
  });

  it("基準値 JSON から比較用の要約を取る", () => {
    expect(extractBaselineSummary(FIXTURE_BASELINE)).toEqual([
      { group: "japanese", probeCount: 7, hit1Count: 5, hit10Count: 7, mrr: 0.8095238095238095 },
      { group: "identifiersSparse", probeCount: 30, hit1Count: 30, hit10Count: 30, mrr: 1 },
      { group: "identifiersDense", probeCount: 30, hit1Count: 30, hit10Count: 30, mrr: 1 },
      {
        group: "japaneseNamesSparse",
        probeCount: 12,
        hit1Count: 11,
        hit10Count: 12,
        mrr: 0.9583333333333334,
      },
      {
        group: "japaneseNamesDense",
        probeCount: 12,
        hit1Count: 11,
        hit10Count: 12,
        mrr: 0.9583333333333334,
      },
    ]);
  });

  it("一致する fixture では問題を1つも返さない", () => {
    expect(checkReadmeMatchesBaseline(FIXTURE_README, FIXTURE_BASELINE)).toEqual([]);
  });

  it("群数の見出しが実体とずれていれば検知する（Issue #425 実例1: 3群 vs 5群）", () => {
    const brokenReadme = FIXTURE_README.replace("5群を別々に集計する", "3群を別々に集計する");
    const problems = checkReadmeMatchesBaseline(brokenReadme, FIXTURE_BASELINE);
    expect(problems.some((p) => p.includes("3群") && p.includes("5群"))).toBe(true);
  });

  it("probe件数が実体とずれていれば検知する（Issue #425 実例2: 12件 vs 30件）", () => {
    const brokenReadme = FIXTURE_README.replace(
      "`identifiersSparse`(30件) | local | sparse | **1.000** | 30/30 | 30/30",
      "`identifiersSparse`(12件) | local | sparse | **1.000** | 12/12 | 12/12",
    );
    const problems = checkReadmeMatchesBaseline(brokenReadme, FIXTURE_BASELINE);
    expect(problems.some((p) => p.includes("identifiersSparse"))).toBe(true);
  });

  it("hit@1がベタ書きの天井（12/12）のままずれていれば検知する（Issue #425 実例3）", () => {
    const brokenReadme = FIXTURE_README.replace(
      "🔴 `japaneseNamesSparse`(12件) | local | sparse | **0.958** | 11/12 | 12/12",
      "🔴 `japaneseNamesSparse`(12件) | local | sparse | **0.958** | 12/12 | 12/12",
    );
    const problems = checkReadmeMatchesBaseline(brokenReadme, FIXTURE_BASELINE);
    expect(problems.some((p) => p.includes("japaneseNamesSparse") && p.includes("hit@1"))).toBe(
      true,
    );
  });

  it("群一覧表に群が抜けていれば検知する", () => {
    const brokenReadme = FIXTURE_README.replace(
      "| `japaneseNamesDense` | 12件 | dense | x |\n",
      "",
    );
    const problems = checkReadmeMatchesBaseline(brokenReadme, FIXTURE_BASELINE);
    expect(problems.some((p) => p.includes("japaneseNamesDense") && p.includes("群一覧表"))).toBe(
      true,
    );
  });
});

describe("identifier-probes-readme-freshness（実物: examples/chat/README.md と identifier-probe-baseline.json）", () => {
  it("README の identifier-probes 節が基準値 JSON と一致する（Issue #425 件3）", () => {
    const readmeText = readFileSync(README_PATH, "utf8");
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    expect(checkReadmeMatchesBaseline(readmeText, baseline)).toEqual([]);
  });
});
