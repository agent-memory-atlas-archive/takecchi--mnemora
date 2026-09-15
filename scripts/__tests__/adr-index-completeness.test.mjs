import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findBrokenIndexLinks,
  findMissingIndexRows,
  findOrphanIndexRows,
  parseAdrFilenames,
  parseIndexRows,
} from "../adr-index-completeness-lib.mjs";

/**
 * 実際の `docs/decisions/` と `docs/decisions/README.md` を読み、索引に穴が
 * 無いことを検査する配線の歯（Issue #230 案D、ADR 0128）。
 *
 * ⚠ **この歯は衝突そのものを消さない。** 索引を触る PR が同時に2本在れば、
 * 依然として手で解く必要が在る。この歯が捕まえるのは
 * 「解き忘れた結果、穴が空いたこと」だけである（ADR 0128「引き受けた負債」）。
 *
 * 集合演算の中身（`missing`/`orphan`/`broken` それぞれの単体テスト、欠番を
 * 誤検出しないことの直接テスト）は `adr-index-completeness-lib.test.mjs` を見ること。
 * ここでは「実ファイルに対して実際に空集合になっているか」だけを見る。
 */

const decisionsDir = fileURLToPath(new URL("../../docs/decisions", import.meta.url));

function readActualState() {
  const filenames = readdirSync(decisionsDir);
  const fileNumbers = parseAdrFilenames(filenames);
  const readmeText = readFileSync(`${decisionsDir}/README.md`, "utf8");
  const indexRows = parseIndexRows(readmeText);
  return { fileNumbers, indexRows };
}

describe("docs/decisions/README.md の索引と docs/decisions/*.md の本数の一致", () => {
  it("ADR ファイルが在るのに索引に行が無いもの（穴）が無い", () => {
    const { fileNumbers, indexRows } = readActualState();
    const missing = findMissingIndexRows(fileNumbers, indexRows);
    expect(missing, `索引に行が無い ADR: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it("索引に行が在るのにファイルが無いもの（孤児行）が無い", () => {
    const { fileNumbers, indexRows } = readActualState();
    const orphan = findOrphanIndexRows(fileNumbers, indexRows);
    expect(orphan, `ファイルの無い索引行: ${JSON.stringify(orphan)}`).toEqual([]);
  });

  it("索引のリンク先ファイル名が、番号は合っているのに実ファイル名と違うもの（壊れたリンク）が無い", () => {
    const { fileNumbers, indexRows } = readActualState();
    const broken = findBrokenIndexLinks(fileNumbers, indexRows);
    expect(broken, `リンク先が実ファイルと食い違う索引行: ${JSON.stringify(broken)}`).toEqual([]);
  });

  it("空振り防止: docs/decisions/ には ADR ファイルが1件以上、索引にも行が1件以上ある", () => {
    // 上の3本は「差分が空である」ことしか見ないため、ディレクトリが空になったり
    // 索引の正規表現が全く何もマッチしなくなったりしても、差分自体は空のまま
    // 緑になりうる（何も測っていないのに緑、という偽陰性）。この it は
    // それを防ぐ最小の陰性対照であり、Issue #224/ADR 0127 が採った
    // 「1本以上」の下限と同じ考え方を踏む。
    const { fileNumbers, indexRows } = readActualState();
    expect(fileNumbers.size).toBeGreaterThan(0);
    expect(indexRows.length).toBeGreaterThan(0);
  });
});
