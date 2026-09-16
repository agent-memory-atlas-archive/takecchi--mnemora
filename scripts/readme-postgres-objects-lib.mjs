/**
 * `packages/postgres/README.md` の「この package が作るオブジェクト」節と、
 * `packages/postgres/migrations/*.sql` / `packages/postgres/src/*.ts` の現物を
 * 突き合わせるための純関数（Issue #168）。
 *
 * ## なぜ要るか
 *
 * `packages/postgres` を共有 DB（他のアプリと同居する Postgres）へ入れる採用者は、
 * mnemora がどんな名前のテーブル・索引・advisory lock キーを持ち込むかを、
 * 手を動かして`migrations/*.sql` を読まなくても確認できる必要がある。README に
 * 一覧を書くだけでは、**マイグレーションを足したのに README を直し忘れる**という
 * ずれが必ず起きる（AGENTS.md「正典と実装が食い違ったら」と同じ形の問題）。
 * この歯は、その一覧が現物と一致していることを機械的に強制する。
 *
 * ## 何を「最終的な集合」と呼ぶか
 *
 * `migrations/*.sql` はファイル名の昇順で1つずつ適用される
 * （`packages/postgres/src/migrate.ts` の `runMigrations`）。ある索引を
 * 後の移行で `DROP INDEX` してから別の索引を作り直す、ということが**将来**
 * 起きうる。⟹ 素朴に「`CREATE INDEX` の出現回数」を数えると、削除されたはずの
 * ものを二重に数えてしまう。**この歯は、全ファイルを結合したテキストを
 * ファイル名順・出現順に1回だけ走査し、`CREATE`/`DROP` を順番に適用した
 * 「最終的に生き残っている集合」を導く**（`deriveMigrationObjects`）。
 * 2026-09 時点の17本の移行には `DROP TABLE` / `DROP INDEX` は1つも無いが、
 * この関数はそれが増えても崩れないように書いてある。
 *
 * ## 関数も対象に含める（ADR 0204。ADR 0202 の「引き受けた負債1」を解消する）
 *
 * `CREATE FUNCTION` / `CREATE OR REPLACE FUNCTION`（`mnemora_lexical_normalize` 等、
 * `0008`/`0009` が作る）も、テーブル・索引と同じ作法で最終形を導く。関数名も
 * 理屈のうえでは共有 DB で衝突しうる——ADR 0202 は「この節・この歯は検査しない」を
 * 負債として引き受けたが、その負債は「検査しない」と書き直すのではなく、
 * 歯を広げて解消する（ADR 0204）。**引数シグネチャ（`(text)` 等）までは見ない**——
 * `CREATE OR REPLACE FUNCTION` で同名を別シグネチャに置き換えても、この歯は
 * 気づかない（ADR 0204「引き受けた負債」）。
 *
 * ## コメントの剥がし方
 *
 * `--` 行コメントに加えて、スラッシュ・アスタリスク形式のブロックコメントも
 * 剥がしてから走査する（`stripSqlLineComments` → `stripSqlBlockComments`）。
 * 2026-09 時点の migrations にブロックコメントは無いが、関数定義の直前に
 * ブロックコメントで理由が書かれることは将来ありうるため、対称に両方剥がす。
 */

/** SQL の `--` 行コメントを剥がす（`postgres-auth-parity-lib.mjs` 等と同じ、正規表現だけの簡易実装）。
 * この repo の migrations は `--` が文字列リテラルの中に現れないことを確認済み。
 * @param {string} sqlText
 * @returns {string}
 */
export function stripSqlLineComments(sqlText) {
  return sqlText
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** SQL のスラッシュ・アスタリスク形式のブロックコメントを剥がす。
 * `stripSqlLineComments` と同じく正規表現だけの簡易実装——この repo の migrations は
 * ブロックコメントの区切りが文字列リテラルの中に現れないことを確認済み。
 * @param {string} sqlText
 * @returns {string}
 */
export function stripSqlBlockComments(sqlText) {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, "");
}

const STATEMENT_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<createTable>[a-zA-Z_][a-zA-Z0-9_]*)|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?<dropTable>[a-zA-Z_][a-zA-Z0-9_]*)|CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?<createIndex>[a-zA-Z_][a-zA-Z0-9_]*)|DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?<dropIndex>[a-zA-Z_][a-zA-Z0-9_]*)|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?<createFunction>[a-zA-Z_][a-zA-Z0-9_]*)\s*\(|DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?<dropFunction>[a-zA-Z_][a-zA-Z0-9_]*)/gi;

/**
 * 複数の移行ファイルのテキスト（コメント剥がし前でよい。この関数が剥がす）を、
 * **ファイル名順に結合したテキストとして与えること。** 呼び出し側が並べ替えを
 * 済ませてから渡す（`fs.readdirSync` の既定ソートはファイル名昇順と一致するため、
 * 呼び出し側はそのまま渡せる）。
 *
 * @param {string[]} migrationTextsInFileOrder
 * @returns {{ tables: string[], indexes: string[], functions: string[] }} 最終的に生き残っている名前の集合（各々ソート済み・重複無し）
 */
export function deriveMigrationObjects(migrationTextsInFileOrder) {
  const combined = migrationTextsInFileOrder
    .map(stripSqlLineComments)
    .map(stripSqlBlockComments)
    .join("\n");
  /** @type {Set<string>} */
  const tables = new Set();
  /** @type {Set<string>} */
  const indexes = new Set();
  /** @type {Set<string>} */
  const functions = new Set();

  for (const match of combined.matchAll(STATEMENT_RE)) {
    const groups = /** @type {Record<string, string | undefined>} */ (match.groups ?? {});
    if (groups.createTable) {
      tables.add(groups.createTable);
    } else if (groups.dropTable) {
      tables.delete(groups.dropTable);
    } else if (groups.createIndex) {
      indexes.add(groups.createIndex);
    } else if (groups.dropIndex) {
      indexes.delete(groups.dropIndex);
    } else if (groups.createFunction) {
      functions.add(groups.createFunction);
    } else if (groups.dropFunction) {
      functions.delete(groups.dropFunction);
    }
  }

  return {
    tables: [...tables].sort(),
    indexes: [...indexes].sort(),
    functions: [...functions].sort(),
  };
}

/**
 * `packages/postgres/src/embedding-space-table.ts` の現物から、埋め込み空間ごとに
 * 増えるテーブル名・HNSW索引名の接頭辞を読む。
 *
 * @param {string} embeddingSpaceTableSourceText
 * @returns {{ tablePrefix: string, indexPrefix: string }}
 */
export function deriveEmbeddingSpaceNaming(embeddingSpaceTableSourceText) {
  const tableMatch = /const TABLE_PREFIX = "([^"]+)";/.exec(embeddingSpaceTableSourceText);
  const indexMatch = /const HNSW_INDEX_PREFIX = "([^"]+)";/.exec(embeddingSpaceTableSourceText);
  if (!tableMatch || !indexMatch) {
    throw new Error(
      "embedding-space-table.ts から TABLE_PREFIX / HNSW_INDEX_PREFIX を読み取れなかった。" +
        "定数名か書き方が変わった——この歯の正規表現を直すこと（歯を消さないこと）。",
    );
  }
  return { tablePrefix: tableMatch[1], indexPrefix: indexMatch[1] };
}

/**
 * `packages/postgres/src/migrate.ts` と `packages/postgres/src/vector-space.ts` の現物から、
 * 既定スキーマ（未指定 or `public`）での advisory lock キーと、`--schema` 指定時に
 * 使うシード文字列の接頭辞を読む。
 *
 * @param {{ migrateSourceText: string, vectorSpaceSourceText: string }} sources
 * @returns {{
 *   migrationLockKey: string,
 *   registerEmbeddingSpaceLockKey: string,
 *   migrationLockSeedPrefix: string,
 *   registerEmbeddingSpaceLockSeedPrefix: string,
 * }}
 */
export function deriveAdvisoryLockKeys({ migrateSourceText, vectorSpaceSourceText }) {
  const migrationKeyMatch = /export const MIGRATION_LOCK_KEY = (-?\d+)n;/.exec(migrateSourceText);
  const registerKeyMatch = /export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = (-?\d+)n;/.exec(
    vectorSpaceSourceText,
  );
  const migrationSeedMatch =
    /deriveAdvisoryLockKey\(`(mnemora:runMigrations:advisory-lock:)\$\{schema\}`\)/.exec(
      migrateSourceText,
    );
  const registerSeedMatch =
    /deriveAdvisoryLockKey\(`(mnemora:registerEmbeddingSpace:advisory-lock:)\$\{schema\}`\)/.exec(
      vectorSpaceSourceText,
    );
  if (!migrationKeyMatch || !registerKeyMatch || !migrationSeedMatch || !registerSeedMatch) {
    throw new Error(
      "migrate.ts / vector-space.ts から advisory lock キーの定数・シード文字列を読み取れなかった。" +
        "定数名か書き方が変わった——この歯の正規表現を直すこと（歯を消さないこと）。",
    );
  }
  return {
    migrationLockKey: migrationKeyMatch[1],
    registerEmbeddingSpaceLockKey: registerKeyMatch[1],
    migrationLockSeedPrefix: migrationSeedMatch[1],
    registerEmbeddingSpaceLockSeedPrefix: registerSeedMatch[1],
  };
}

/**
 * README 中の `### <headingLabel>...` 見出しから、次の `##`/`###` 見出しの直前までを
 * 切り出す（`ci-yml-time-term-wiring.test.mjs` の `extractJob` と同じ考え方）。
 *
 * @param {string} markdownText
 * @param {string} headingLabel 見出し文字列の先頭一致（例: "テーブル"。"テーブル（8）" にも一致する）
 * @returns {string | undefined}
 */
export function extractMarkdownSection(markdownText, headingLabel) {
  const lines = markdownText.split("\n");
  const startIdx = lines.findIndex((line) => {
    const matched = /^### (.+)$/.exec(line);
    return matched !== null && matched[1].startsWith(headingLabel);
  });
  if (startIdx === -1) {
    return undefined;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * 見出し行の `（N）`/`(N)` から件数を読む（例: "### 索引（20）" → 20）。
 *
 * @param {string} markdownText
 * @param {string} headingLabel
 * @returns {number | undefined}
 */
export function extractHeadingCount(markdownText, headingLabel) {
  const lines = markdownText.split("\n");
  for (const line of lines) {
    const matched = /^### (.+)$/.exec(line);
    if (matched !== null && matched[1].startsWith(headingLabel)) {
      const countMatch = /[（(](\d+)[）)]/.exec(matched[1]);
      return countMatch ? Number(countMatch[1]) : undefined;
    }
  }
  return undefined;
}

/**
 * 節本文の「`- \`name\`" 形式の箇条書き」だけから識別子を拾う。節中の説明文にある
 * 他の識別子への言及（バッククォート付きでも）を巻き込まないよう、**行頭が
 * `- \`` である行だけ**を対象にする。
 *
 * @param {string} sectionText
 * @returns {string[]} 出現順（重複はそのまま残す。呼び出し側で必要なら dedupe すること）
 */
export function extractBulletedIdentifiers(sectionText) {
  const names = [];
  for (const rawLine of sectionText.split("\n")) {
    const line = rawLine.trim();
    const matched = /^-\s+`([a-zA-Z_][a-zA-Z0-9_]*)`/.exec(line);
    if (matched) {
      names.push(matched[1]);
    }
  }
  return names;
}

/**
 * README の「この package が作るオブジェクト」節全体を、比較しやすい形に解析する。
 *
 * @param {string} readmeText
 * @returns {{
 *   tables: string[],
 *   indexes: string[],
 *   functions: string[],
 *   tableHeadingCount: number | undefined,
 *   indexHeadingCount: number | undefined,
 *   functionHeadingCount: number | undefined,
 *   embeddingTablePattern: string | undefined,
 *   embeddingIndexPattern: string | undefined,
 *   advisoryLockKeys: string[],
 *   advisoryLockSeedPrefixes: string[],
 * }}
 */
export function parseReadmeObjectsSection(readmeText) {
  const tableSection = extractMarkdownSection(readmeText, "テーブル");
  const indexSection = extractMarkdownSection(readmeText, "索引");
  const functionSection = extractMarkdownSection(readmeText, "関数");
  const embeddingSection = extractMarkdownSection(readmeText, "実行時に増える系列");
  const advisorySection = extractMarkdownSection(readmeText, "advisory lock のキー");

  const tableMatch = embeddingSection ? /`(memory_embeddings_[^`]*)`/.exec(embeddingSection) : null;
  const indexMatch = embeddingSection
    ? /`(idx_memory_embeddings_hnsw_[^`]*)`/.exec(embeddingSection)
    : null;

  const advisoryLockKeys = advisorySection
    ? [...advisorySection.matchAll(/`(-?\d+)`/g)].map((m) => m[1])
    : [];
  const advisoryLockSeedPrefixes = advisorySection
    ? [...advisorySection.matchAll(/`(mnemora:[a-zA-Z]+:advisory-lock:)/g)].map((m) => m[1])
    : [];

  return {
    tables: tableSection ? extractBulletedIdentifiers(tableSection) : [],
    indexes: indexSection ? extractBulletedIdentifiers(indexSection) : [],
    functions: functionSection ? extractBulletedIdentifiers(functionSection) : [],
    tableHeadingCount: extractHeadingCount(readmeText, "テーブル"),
    indexHeadingCount: extractHeadingCount(readmeText, "索引"),
    functionHeadingCount: extractHeadingCount(readmeText, "関数"),
    embeddingTablePattern: tableMatch ? tableMatch[1] : undefined,
    embeddingIndexPattern: indexMatch ? indexMatch[1] : undefined,
    advisoryLockKeys,
    advisoryLockSeedPrefixes,
  };
}
