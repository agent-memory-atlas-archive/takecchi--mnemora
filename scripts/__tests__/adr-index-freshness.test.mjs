import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldEnforceAdrIndexFreshness } from "../adr-index-freshness-branch-lib.mjs";
import {
  buildAdrEntries,
  buildIndexTable,
  extractGeneratedIndex,
  extractIndexedNumbers,
} from "../generate-adr-index-lib.mjs";

/**
 * 実際の `docs/decisions/` と `docs/decisions/README.md` を読み、索引の
 * 生成部分が最新かどうかを検査する配線の歯（Issue #230 案A、ADR 0137 / ADR 0192）。
 * ADR 0128 の「索引と ADR 本数の一致を検査する歯」の後継。
 *
 * ⚠ **この歯は ADR PR 自身の「手元」では意図してスキップされる。**
 * ADR 0137 の設計では、ADR を追加する PR の**作成者**は
 * `docs/decisions/README.md` を一切触らない（並行 PR 間の行位置の衝突を
 * 構造的に無くすため）。そのため ADR PR のブランチ上では「ファイルは在るが
 * 索引にまだ無い」状態が、マージする側が再生成コマンドを打つまでの間
 * **常に**一時的に起こる——作者の手元の `pnpm run test` をこれで赤くすると、
 * 6つの門のうち関係の無い1つを毎回落とすことになる。だから**手元
 * （`GITHUB_REF` が無い環境）では、ブランチが `main` のときだけ有効になる**
 * （`shouldEnforceAdrIndexFreshness` — 手元で ADR PR の作業をしていても、
 * ブランチは `main` ではないので、この歯は鳴らない）。
 *
 * ## `main` の push に加えて、CI の `pull_request` でも有効にする（ADR 0192）
 *
 * 2026-09-16、ADR 0190 / 0191 が**マージ直前の索引再生成を経ずに** squash
 * merge され、`main` の `f46af8c` で `typecheck / lint / test / build` が
 * 失敗した——ADR 0137「決定」2番の手順（マージする側がマージ直前に
 * PR ブランチ上で再生成する）は、「PR を準備する層」と「マージする層」が
 * 同じ人であることを暗黙に前提しており、その前提が崩れると鮮度は人の
 * 注意力だけに委ねられていた。
 *
 * `.github/workflows/ci.yml` の `actions/checkout@v6` は `ref:` を指定して
 * いない。`pull_request` イベントでは GitHub が計算したマージプレビュー
 * （`refs/pull/<n>/merge`）を checkout する——つまり **CI の `pull_request`
 * は、マージ後の `main` がどうなるかを、マージする前に測れる位置に
 * 既にいる。** ここでこの歯を有効にすると、`typecheck / lint / test / build`
 * （branch protection の required status check、`enforce_admins: true`）が
 * 赤くなり、**GitHub 自身がマージを拒む**——マージする側が手順を忘れても、
 * 機構が止める。詳しい経緯・引き受けた負債・確かめていないことは
 * [ADR 0192](../../docs/decisions/0192-adr-index-freshness-enforced-in-pull-request-ci.md)。
 *
 * **手元の6つの門は従来どおり影響を受けない**——`shouldEnforceAdrIndexFreshness`
 * は `GITHUB_REF` が無い環境では常に「ブランチが `main` かどうか」だけで
 * 判定するため、作者が手元で `pnpm run test` を走らせても赤くならない。
 *
 * ## 手順が守られている限り、なぜ routine では鳴らないか
 *
 * 索引の再生成は「マージ**後**の `main` 上」ではなく「マージ**直前**の
 * PR ブランチ上」で、マージする側が行う（ADR 0137「決定」2番）。これにより、
 * `main` へ実際に着地する squash コミットは、ADR ファイルの追加と索引の
 * 再生成を最初から同じコミットとして含む——**`main` が索引の陳腐化した
 * 状態を一瞬でも持つことが無い。** ADR 0192 で `pull_request` の CI にも
 * 同じ検査を足したのは、その手順が**踏まれたかどうか自体**を、squash merge
 * が起きる前に確認できるようにするためである。
 *
 * ## 手元での確認手順（`main` 以外でも強制する）
 *
 * `ADR_INDEX_FRESHNESS_FORCE=1` を立てると、ブランチに関わらずこの歯を
 * 有効にする。ADR 0137「測ったこと」の変異試験はこの環境変数を使って行った
 * （`git checkout` で退避コピーを戻さない・`cp` で退避する、ADR 0066/`docs/autonomy.md`
 * §4 の教訓を踏む）。
 */

const decisionsDir = fileURLToPath(new URL("../../docs/decisions", import.meta.url));

function detectGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: decisionsDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

const enforceFreshnessNow = shouldEnforceAdrIndexFreshness({
  githubRef: process.env.GITHUB_REF,
  gitBranch: detectGitBranch(),
  forceOverride: process.env.ADR_INDEX_FRESHNESS_FORCE === "1",
});

function readActualEntriesAndReadme() {
  const filenames = readdirSync(decisionsDir).filter((f) => f !== "README.md");
  const files = filenames.map((filename) => ({
    filename,
    content: readFileSync(`${decisionsDir}/${filename}`, "utf8"),
  }));
  const entries = buildAdrEntries(files);
  const readmeText = readFileSync(`${decisionsDir}/README.md`, "utf8");
  return { entries, readmeText };
}

describe.skipIf(!enforceFreshnessNow)(
  "docs/decisions/README.md の生成部分が最新か（main の push・CI の pull_request 限定、ADR 0192）",
  () => {
    it("docs/decisions/*.md から生成した表が、README.md に commit されている表と一致する", () => {
      const { entries, readmeText } = readActualEntriesAndReadme();
      const expectedTable = buildIndexTable(entries);
      const actualTable = extractGeneratedIndex(readmeText);

      if (expectedTable === actualTable) {
        expect(actualTable).toBe(expectedTable);
        return;
      }

      const expectedNumbers = new Set(entries.map((e) => e.number));
      const actualNumbers = new Set(extractIndexedNumbers(actualTable));
      const missing = [...expectedNumbers].filter((n) => !actualNumbers.has(n)).sort();
      const extra = [...actualNumbers].filter((n) => !expectedNumbers.has(n)).sort();

      const detail = [
        missing.length > 0 ? `索引に無い ADR: ${JSON.stringify(missing)}` : null,
        extra.length > 0 ? `ファイルの無い索引行: ${JSON.stringify(extra)}` : null,
        missing.length === 0 && extra.length === 0
          ? "番号の集合は一致しているが、題・状態欄の内容が生成結果と食い違っている"
          : null,
      ]
        .filter(Boolean)
        .join(" / ");

      const howToFix = [
        "これは ADR PR では想定された過渡状態であることがある",
        "（ADR PR の作成者は索引を意図的に触らない設計——ADR 0137「決定」2番）。",
        "⛔ この PR の【作成者】は、これを自分で直さないこと——【実測】並行する2本が",
        "   どちらも索引を再生成すると、表の末尾の同じ位置へ1行ずつ足すため衝突する",
        "   （ADR 0192「測ったこと」）。作成者が触らないことが、その衝突を消している。",
        "⭐【マージする側】が、マージ直前に PR ブランチ上で次を実行してコミット・push すれば緑になる:",
        "  node scripts/generate-adr-index.mjs",
        "  git add docs/decisions/README.md",
        '  git commit -m "docs(adr-index): regenerate before merging #<PR番号>"',
        "  git push",
        "手順の全体は docs/decisions/0137-adr-index-generated-from-source.md「決定」2番。",
        "この検査を CI の pull_request でも有効にした理由・引き受けた負債は",
        "docs/decisions/0192-adr-index-freshness-enforced-in-pull-request-ci.md。",
      ].join("\n");

      expect(
        actualTable,
        `docs/decisions/README.md が陳腐化している: ${detail}\n\n${howToFix}`,
      ).toBe(expectedTable);
    });

    it("空振り防止: ADR ファイルが1件以上ある", () => {
      const { entries } = readActualEntriesAndReadme();
      expect(entries.length).toBeGreaterThan(0);
    });
  },
);
