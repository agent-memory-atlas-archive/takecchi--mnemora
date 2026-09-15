/**
 * ADR 索引（`docs/decisions/README.md`）と `docs/decisions/*.md` の実ファイルの
 * **番号の集合が一致しているか**を判定する純関数の側（Issue #230 案D、ADR 0128）。
 *
 * ## 何を測るか
 *
 * `docs/decisions/README.md` の索引テーブルは、1つの ADR につき1行を手で追記する
 * 形である。並行する PR が同じ行位置（末尾）に追記しようとすると衝突し、
 * どちらかが正しく解かない限り「ADR ファイルは在るのに索引の行が無い」という穴が
 * 残る（issue #230 のコメントが2026-09-15 に実測した実例: #221→#220、#225→#226）。
 *
 * この歯は、その穴を**番号の集合の差分**として検出する。
 *
 * ```
 * missing = fileNumbers - indexNumbers   // ファイルに在って索引に無い（穴）
 * orphan  = indexNumbers - fileNumbers   // 索引に在ってファイルの無い行
 * broken  = 番号は両方に在るが、索引のリンク先ファイル名が実ファイル名と違う行
 * ```
 *
 * ⚠ **行数（絶対値）は比較しない。** ADR 0127 が pgvector ジョブの絶対本数を
 * 「両方が着地して初めて正しい値が決まる、独立に更新される値」として退けたのと
 * 同じ理由——ADR が1本増えるたびに固定値を書き換える歯は、それ自体が
 * `AGENTS.md` の退ける「複製した値の手動同期」になる。**集合の一致だけを見る。**
 *
 * ## ⛔ 欠番（`0080` / `0116`）を検出しない
 *
 * 「番号が連続していること」は一切検査しない。上の集合演算はファイル側・索引側の
 * **どちらの集合にも現れない番号（欠番）を最初から扱わない**——`missing` は
 * 「ファイルに在るのに索引に無い」番号だけを挙げるので、ファイルが存在しない
 * 欠番はそもそも `fileNumbers` に入らず、`missing` にも `orphan` にも現れない。
 *
 * ## `README.md` 以外の非 ADR ファイルの扱い
 *
 * `docs/decisions/` には `README.md` のほかに非 ADR ファイルは無い（【現物】
 * `ls -la docs/decisions/` で確認、ADR 0128「測ったこと」）。`parseAdrFilenames` は
 * 「`README.md` を除外する」という否定条件ではなく、**「4桁の番号 + ハイフン区切りの
 * slug + `.md`」という正の条件にマッチするものだけを拾う**——将来 `README.md` 以外の
 * 非 ADR ファイル（例: テンプレート）が増えても、そのファイル名がこの形に一致しない
 * 限り歯は誤って反応しない。
 */

/** ADR ファイル名の形（4桁の番号 + ハイフン区切りの slug + `.md`）。 */
const ADR_FILENAME_RE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;

/** 索引テーブルの行（`| [0127](./0127-....md) | … | … |`）から番号とリンク先を取る。 */
const INDEX_ROW_RE = /^\|\s*\[(\d{4})\]\(\.\/([^)]+)\)\s*\|/;

/**
 * ファイル名の配列から、ADR ファイルの形にマッチするものだけを拾い、
 * `番号(4桁文字列) → ファイル名` の Map を返す。マッチしないもの
 * （`README.md` 等）は黙って無視する。
 *
 * @param {string[]} filenames
 * @returns {Map<string, string>}
 */
export function parseAdrFilenames(filenames) {
  const byNumber = new Map();
  for (const name of filenames) {
    const m = ADR_FILENAME_RE.exec(name);
    if (!m) continue;
    byNumber.set(m[1], name);
  }
  return byNumber;
}

/**
 * 索引本文（`docs/decisions/README.md` の全文）から、テーブルの行だけを拾う。
 * ヘッダ行・区切り行（`| ---- | ---- |`）は `[NNNN](...)` の形にマッチしないため
 * 自然に除外される。
 *
 * @param {string} readmeText
 * @returns {{ number: string, linkedFile: string, line: number }[]}
 */
export function parseIndexRows(readmeText) {
  const rows = [];
  const lines = readmeText.split("\n");
  lines.forEach((line, idx) => {
    const m = INDEX_ROW_RE.exec(line);
    if (!m) return;
    rows.push({ number: m[1], linkedFile: m[2], line: idx + 1 });
  });
  return rows;
}

/**
 * ファイルに在って索引に無い番号（＝穴）を、番号の昇順で返す。
 *
 * @param {Map<string, string>} fileNumbers `parseAdrFilenames` の結果
 * @param {{ number: string }[]} indexRows `parseIndexRows` の結果
 * @returns {{ number: string, filename: string }[]}
 */
export function findMissingIndexRows(fileNumbers, indexRows) {
  const indexed = new Set(indexRows.map((row) => row.number));
  const missing = [];
  for (const [number, filename] of fileNumbers) {
    if (!indexed.has(number)) missing.push({ number, filename });
  }
  return missing.sort((a, b) => a.number.localeCompare(b.number));
}

/**
 * 索引に在ってファイルの無い行を、出現順で返す。
 *
 * @param {Map<string, string>} fileNumbers `parseAdrFilenames` の結果
 * @param {{ number: string, linkedFile: string, line: number }[]} indexRows
 * @returns {{ number: string, linkedFile: string, line: number }[]}
 */
export function findOrphanIndexRows(fileNumbers, indexRows) {
  return indexRows.filter((row) => !fileNumbers.has(row.number));
}

/**
 * 番号は両方に在るが、索引のリンク先ファイル名が実際のファイル名と違う行を返す
 * （番号だけ合っていてリンクが死んでいる壊れ方を検出する）。
 * ファイルが存在しない番号（＝ `findOrphanIndexRows` が既に拾う対象）はここでは
 * 対象にしない。
 *
 * @param {Map<string, string>} fileNumbers `parseAdrFilenames` の結果
 * @param {{ number: string, linkedFile: string, line: number }[]} indexRows
 * @returns {{ number: string, linkedFile: string, actualFilename: string, line: number }[]}
 */
export function findBrokenIndexLinks(fileNumbers, indexRows) {
  const broken = [];
  for (const row of indexRows) {
    const actualFilename = fileNumbers.get(row.number);
    if (actualFilename !== undefined && row.linkedFile !== actualFilename) {
      broken.push({ ...row, actualFilename });
    }
  }
  return broken;
}
