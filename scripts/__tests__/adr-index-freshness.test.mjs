import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMain } from "../adr-index-freshness-branch-lib.mjs";
import {
  buildAdrEntries,
  buildIndexTable,
  extractGeneratedIndex,
  extractIndexedNumbers,
} from "../generate-adr-index-lib.mjs";

/**
 * 実際の `docs/decisions/` と `docs/decisions/README.md` を読み、索引の
 * 生成部分が最新かどうかを検査する配線の歯（Issue #230 案A、ADR 0137）。
 * ADR 0128 の「索引と ADR 本数の一致を検査する歯」の後継——ただし
 * **`main` に限って**検査する（下記「なぜ `main` 限定か」）。
 *
 * ⚠ **この歯は ADR PR 自身のブランチでは意図してスキップされる。**
 * ADR 0137 の設計では、ADR を追加する PR の**作成者**は
 * `docs/decisions/README.md` を一切触らない（並行 PR 間の行位置の衝突を
 * 構造的に無くすため）。そのため ADR PR のブランチ上では「ファイルは在るが
 * 索引にまだ無い」状態が、マージする側が再生成コマンドを打つまでの間
 * **常に**一時的に起こる——これは ADR 0128 時代なら赤くなるべきバグだったが、
 * いまは意図した過渡状態である。この歯を無条件（PR ブランチでも）で
 * 走らせると、将来のすべての ADR PR で `pnpm run test` が赤くなり、
 * 設計そのものと矛盾する。
 *
 * ## なぜ `main` 限定か、そして routine では鳴らないはずなのはなぜか
 *
 * 索引の再生成は「マージ**後**の `main` 上」ではなく「マージ**直前**の
 * PR ブランチ上」で、マージする側が行う（ADR 0137「決定」2番。
 * `docs/decisions/README.md` の実測に基づき、当初案の「マージ後」から
 * 修正した経緯も同じ節にある）。これにより、`main` へ実際に着地する
 * squash コミットは、ADR ファイルの追加と索引の再生成を最初から
 * 同じコミットとして含む——**`main` が索引の陳腐化した状態を一瞬でも
 * 持つことが無い。** `main` への push は毎回 CI 全体（`ci.yml` の
 * `on: push: branches: [main]`）を走らせるため、もし「マージ後に `main`
 * 上で直す」設計のままだと、陳腐化した squash コミットがそのまま CI に
 * 入り、この歯が ADR をマージするたびに定期的に赤くなる——それは
 * `docs/autonomy.md` §1 段1（壊れているものを最優先で拾う）の信号を
 * ノイズ化させる。だから、この歯を `main` 限定にしてもなお
 * **手順（ADR 0137「決定」2番）が守られている限り、`main` 上でこの歯が
 * 赤くなることは routine には起こらない。** 赤くなるのはその手順そのものを
 * 飛ばして直接 squash merge してしまったときだけであり、そのときは
 * 安全網として正しく機能する。
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

const mainNow = isMain({
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

describe.skipIf(!mainNow)("docs/decisions/README.md の生成部分が最新か（main 限定）", () => {
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

    expect(actualTable, `docs/decisions/README.md が陳腐化している: ${detail}`).toBe(expectedTable);
  });

  it("空振り防止: ADR ファイルが1件以上ある", () => {
    const { entries } = readActualEntriesAndReadme();
    expect(entries.length).toBeGreaterThan(0);
  });
});
