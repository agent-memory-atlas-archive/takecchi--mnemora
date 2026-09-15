/**
 * ADR 索引（`docs/decisions/README.md` の「## 一覧」表）を、`docs/decisions/*.md` の
 * 実ファイルから機械生成するための純関数（Issue #230 案A、ADR 0137）。
 *
 * ## なぜ生成物にしたか
 *
 * これまでの索引（ADR 0128 まで）は、1つの ADR につき1行を**手で末尾に追記する**形
 * だった。並行 PR が同じ行位置（末尾）に追記すると、git の3-way merge は
 * 「同じ最終行の直後に挿入する」という2つのパッチを区別できず、必ず衝突する
 * ——ADR 0128 の歯はこの衝突が起きたあとの「穴」を検出できたが、**衝突そのものは
 * 消せなかった**（同 ADR「引き受けた負債」1番）。
 *
 * この生成物は、その衝突の芽を構造から断つ。**ADR を追加する PR は
 * `docs/decisions/NNNN-slug.md` という新しいファイルを1本足すだけで、
 * `docs/decisions/README.md` を触らない。** 新しいファイル名は他のどの PR とも
 * 重ならないので、複数の ADR PR が同時に開いていても、それらの diff は
 * git の観点で一切重ならず、**衝突が物理的に起こりようがない**
 * （`docs/decisions-index-conflict-reproduction.md` 相当の再現手順は ADR 0137 の
 * 「測ったこと」を見ること）。
 *
 * その代わり、`docs/decisions/README.md` の生成部分は ADR PR のブランチ上で
 * **陳腐化する**（新しいファイルが増えたのに表がまだ追いついていない）。これは
 * バグではなく、この設計が意図して受け入れる過渡状態である——**ただし、その
 * 陳腐化を `main` へ持ち込まない。** マージする側が、squash merge する
 * **直前**に PR ブランチ上で `node scripts/generate-adr-index.mjs` を実行して
 * コミットし、push してからマージする（手順は README 自身のコメントと
 * ADR 0137「決定」2番を見ること）。こうすると `main` に着地する squash
 * コミットは最初から索引が最新であり、`main` が陳腐化した状態を持つ瞬間が
 * 無い。この「陳腐化していないか」を `main` に限って検査するのが
 * `scripts/__tests__/adr-index-freshness.test.mjs` であり、ADR 0128 の歯が
 * 担っていた役割を引き継ぐ（ただし PR を塞ぐ門ではなく、上の手順が実際に
 * 守られたかを見る `main` の安全網としてのみ働く——手順が守られている限り
 * routine では鳴らない。理由は ADR 0137 の「決定」2番・3番）。
 *
 * ## ソースにするもの
 *
 * 各 ADR ファイルの**1行目の見出し**（`# ADR NNNN: <題>`）から番号と題を取る。
 * ファイル名の4桁番号と見出しの4桁番号が食い違っていたら、生成そのものを失敗させる
 * （黙って片方を信じない——ADR 0128 が「壊れたリンク」として警戒していた壊れ方の
 * 発生源そのものを、生成の入口で塞ぐ）。
 *
 * 状態欄は `- **状態**: ...` 行（太字は無くてもよい）から取る。多くの ADR は
 * この行の中に `(YYYY-MM)` の形で日付を直接埋め込んでいる（例:
 * `採用 (2026-09)`）。埋め込まれていない ADR（実測で4本: 0019 / 0074 / 0099 / 0117）は
 * 別行の `- **日付**: ...` から補う。状態の「見出し語」は先頭の空白・丸括弧までの
 * 連続文字列として抜き出す——`採用` / `未決` / `提案` のように将来値が増えても、
 * この抜き出し方はハードコードした語彙リストを持たずに動く。
 *
 * ## `README.md` の生成部分と手書き部分の境界
 *
 * `<!-- ADR-INDEX:GENERATED:START -->` と `<!-- ADR-INDEX:GENERATED:END -->` という
 * HTML コメントのマーカーで囲む。マーカーの外（冒頭の説明文・「## 一覧」見出し）は
 * この生成器が一切触らない。マーカーが無い・2組以上ある場合は例外を投げる
 * （沈黙して間違った場所へ書き込むより、原因を名指しして落ちる方が安全）。
 */

/** ADR ファイル名の形（4桁の番号 + ハイフン区切りの slug + `.md`）。ADR 0128 と同じ形。 */
const ADR_FILENAME_RE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;

/** ADR 本文1行目の見出し（`# ADR 0001: ORM は Drizzle`）。 */
const TITLE_HEADING_RE = /^# ADR (\d{4}): (.+)\r?$/;

/** `- **状態**: ...` / `- 状態: ...`（太字は任意）。 */
const STATE_LINE_RE = /^- \**状態\**:\s*(.+?)\s*$/m;

/** `- **日付**: ...` / `- 日付: ...`（太字は任意）。 */
const DATE_LINE_RE = /^- \**日付\**:\s*(.+?)\s*$/m;

/** 状態欄の先頭にある「見出し語」（空白・半角/全角丸括弧の手前まで）。 */
const STATE_KEYWORD_RE = /^\**([^\s(（]+)/;

/** 見出し語の直後に丸括弧で埋め込まれた `YYYY-MM` 形の日付。 */
const INLINE_DATE_RE = /^\**[^\s(（]+\s*[(（](\d{4}-\d{2})/;

/** `- **日付**: 2026-09-06` のような行から `YYYY-MM` だけを取る。 */
const DATE_VALUE_RE = /^(\d{4}-\d{2})/;

export const GENERATED_START_MARKER = "<!-- ADR-INDEX:GENERATED:START -->";
export const GENERATED_END_MARKER = "<!-- ADR-INDEX:GENERATED:END -->";

/**
 * ファイル名が ADR ファイルの形にマッチするか。
 * @param {string} filename
 * @returns {boolean}
 */
export function isAdrFilename(filename) {
  return ADR_FILENAME_RE.test(filename);
}

/**
 * 状態欄のテキストから、表示用の1セルを組み立てる。
 * 「採用」は無装飾、それ以外（未決・提案など）は目立つよう太字にする
 * ——これは元データの再現ではなく、この生成器が採用した表示規約
 * （ADR 0137「決定」参照。過去の索引の装飾は手書きで一貫していなかった）。
 *
 * @param {string} stateText `- **状態**: ` を除いた本文
 * @param {string | undefined} dateLineText `- **日付**: ` を除いた本文（無ければ undefined）
 * @returns {string}
 */
export function formatStateCell(stateText, dateLineText) {
  const keywordMatch = STATE_KEYWORD_RE.exec(stateText);
  const keyword = keywordMatch ? keywordMatch[1] : stateText.trim();

  const inlineDateMatch = INLINE_DATE_RE.exec(stateText);
  let date = inlineDateMatch ? inlineDateMatch[1] : null;

  if (date === null && dateLineText !== undefined) {
    const dateValueMatch = DATE_VALUE_RE.exec(dateLineText.trim());
    if (dateValueMatch) date = dateValueMatch[1];
  }

  const label = date ? `${keyword} (${date})` : keyword;
  return keyword === "採用" ? label : `**${label}**`;
}

/**
 * 1つの ADR ファイルの内容から、索引の1行分のデータを取り出す。
 * 壊れている入力（見出しが無い・番号が食い違う・状態欄が無い）は、
 * 黙ってそれらしい値を返すのではなく例外を投げる。
 *
 * @param {string} filename
 * @param {string} content
 * @returns {{ number: string, filename: string, title: string, stateCell: string }}
 */
export function parseAdrEntry(filename, content) {
  const filenameMatch = ADR_FILENAME_RE.exec(filename);
  if (!filenameMatch) {
    throw new Error(`ADR ファイル名の形にマッチしません: ${filename}`);
  }
  const numberFromFilename = filenameMatch[1];

  const firstLine = content.split("\n", 1)[0] ?? "";
  const titleMatch = TITLE_HEADING_RE.exec(firstLine);
  if (!titleMatch) {
    throw new Error(
      `${filename}: 1行目が "# ADR NNNN: <題>" の形ではありません（見出し: ${JSON.stringify(firstLine)}）`,
    );
  }
  const [, numberFromHeading, title] = titleMatch;
  if (numberFromHeading !== numberFromFilename) {
    throw new Error(
      `${filename}: ファイル名の番号（${numberFromFilename}）と見出しの番号（${numberFromHeading}）が食い違っています`,
    );
  }

  const stateMatch = STATE_LINE_RE.exec(content);
  if (!stateMatch) {
    throw new Error(`${filename}: "- **状態**: ..." 行が見つかりません`);
  }
  const dateMatch = DATE_LINE_RE.exec(content);

  const stateCell = formatStateCell(stateMatch[1], dateMatch ? dateMatch[1] : undefined);

  return {
    number: numberFromFilename,
    filename,
    title: title.replaceAll("|", "\\|"),
    stateCell,
  };
}

/**
 * ADR ファイル名の配列から、索引の対象になるものだけを拾い、番号順に
 * `parseAdrEntry` した結果を返す。`README.md` や ADR らしくない名前
 * （テンプレート等）は黙って無視する——ADR 0128 の `parseAdrFilenames` と同じ判断。
 *
 * @param {{ filename: string, content: string }[]} files
 * @returns {ReturnType<typeof parseAdrEntry>[]}
 */
export function buildAdrEntries(files) {
  return files
    .filter((f) => isAdrFilename(f.filename))
    .map((f) => parseAdrEntry(f.filename, f.content))
    .sort((a, b) => a.number.localeCompare(b.number));
}

/**
 * 索引テーブル（ヘッダ行込み）を組み立てる。
 * 列の桁揃え（padding）はしない——揃えると、1行足すたびに全行の空白量が
 * 変わって差分が肥大化し、それ自体が「1行の追加のはずが全行に触る」という
 * 別種の衝突面を作る（この repo の `format:check` は markdown を対象外にしており
 * 揃える強制も無い。ADR 0137「測ったこと」参照）。
 *
 * @param {ReturnType<typeof parseAdrEntry>[]} entries
 * @returns {string} 改行区切りの表（末尾に改行は付けない）
 */
export function buildIndexTable(entries) {
  const lines = ["| 番号 | 題 | 状態 |", "| --- | --- | --- |"];
  for (const entry of entries) {
    lines.push(`| [${entry.number}](./${entry.filename}) | ${entry.title} | ${entry.stateCell} |`);
  }
  return lines.join("\n");
}

/**
 * マーカーの位置を探す。無い・2組以上あるときは例外を投げる。
 * @param {string} readmeText
 * @returns {{ startIndex: number, endIndex: number }}
 */
function locateMarkers(readmeText) {
  const startIndex = readmeText.indexOf(GENERATED_START_MARKER);
  const endIndex = readmeText.indexOf(GENERATED_END_MARKER);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      `docs/decisions/README.md に ${GENERATED_START_MARKER} / ${GENERATED_END_MARKER} のマーカーが見つかりません`,
    );
  }
  if (
    readmeText.indexOf(GENERATED_START_MARKER, startIndex + 1) !== -1 ||
    readmeText.indexOf(GENERATED_END_MARKER, endIndex + 1) !== -1
  ) {
    throw new Error("docs/decisions/README.md のマーカーが2組以上あります");
  }
  if (endIndex < startIndex) {
    throw new Error("docs/decisions/README.md の END マーカーが START より前にあります");
  }
  return { startIndex, endIndex };
}

/**
 * README のマーカー間の内容を、生成した表で置き換える。マーカー自体は残す。
 * マーカーの外側は一切変更しない。
 *
 * @param {string} readmeText
 * @param {string} tableMarkdown `buildIndexTable` の結果
 * @returns {string}
 */
export function spliceGeneratedIndex(readmeText, tableMarkdown) {
  const { startIndex, endIndex } = locateMarkers(readmeText);
  const before = readmeText.slice(0, startIndex + GENERATED_START_MARKER.length);
  const after = readmeText.slice(endIndex);
  return `${before}\n\n${tableMarkdown}\n\n${after}`;
}

/**
 * README のマーカー間に**いま**入っている生の文字列を取り出す
 * （鮮度検査で「現物」と「生成した結果」を比べるときに使う）。
 *
 * @param {string} readmeText
 * @returns {string}
 */
export function extractGeneratedIndex(readmeText) {
  const { startIndex, endIndex } = locateMarkers(readmeText);
  return readmeText.slice(startIndex + GENERATED_START_MARKER.length, endIndex).trim();
}

/**
 * 生成した表テキストから、行頭の ADR 番号だけを拾う（鮮度検査が赤くなったときの
 * 診断メッセージ用。ヘッダ行・区切り行は `[` を含まないので自然に除外される）。
 *
 * @param {string} tableMarkdown
 * @returns {string[]}
 */
export function extractIndexedNumbers(tableMarkdown) {
  return [...tableMarkdown.matchAll(/^\|\s*\[(\d{4})\]/gm)].map((m) => m[1]);
}
