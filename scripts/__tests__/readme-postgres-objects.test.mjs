import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveAdvisoryLockKeys,
  deriveEmbeddingSpaceNaming,
  deriveMigrationObjects,
  parseReadmeObjectsSection,
} from "../readme-postgres-objects-lib.mjs";

/**
 * ⭐ この歯が測っているもの（消す前に読むこと）
 *
 * `packages/postgres/README.md` の「この package が作るオブジェクト」節が、
 * `packages/postgres/migrations/*.sql` と `packages/postgres/src/*.ts` の**現物**と
 * 一致していること（Issue #168）。**共有 DB へ mnemora を同居させる採用者が、
 * ここで名前の衝突を事前に確認できる**、という README の主張を、この歯が
 * 機械的に裏書きする。
 *
 * - テーブル・索引: `migrations/*.sql` をファイル名順に適用した**最終形**
 *   （`DROP` されたものは数えない。`readme-postgres-objects-lib.mjs` の
 *   `deriveMigrationObjects` を見ること）と、README の箇条書きを突き合わせる。
 * - 埋め込み空間ごとの実行時系列: `embedding-space-table.ts` の
 *   `TABLE_PREFIX` / `HNSW_INDEX_PREFIX` と、README に書いた接頭辞が一致するかを見る。
 * - advisory lock のキー: `migrate.ts` / `vector-space.ts` の
 *   `MIGRATION_LOCK_KEY` / `REGISTER_EMBEDDING_SPACE_LOCK_KEY`（既定スキーマ）と、
 *   `--schema` 指定時のシード文字列の接頭辞が、README に書いてあるかを見る。
 *
 * ⚠ **DB は要らない**——ここで読むのは `.sql` / `.ts` のテキストと README だけ。
 *
 * ⚠ **CREATE FUNCTION は対象外**（`readme-postgres-objects-lib.mjs` の doc comment
 * に理由を書いた）。README 側にも同じ限定を明記してある。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const postgresDir = `${repoRoot}/packages/postgres`;
const migrationsDir = `${postgresDir}/migrations`;

function readMigrationTextsInFileOrder() {
  const fileNames = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(fileNames.length, "packages/postgres/migrations/*.sql が1つも無い").toBeGreaterThan(0);
  return fileNames.map((name) => readFileSync(`${migrationsDir}/${name}`, "utf8"));
}

const readmeText = readFileSync(`${postgresDir}/README.md`, "utf8");
const readmeObjects = parseReadmeObjectsSection(readmeText);
const migrationObjects = deriveMigrationObjects(readMigrationTextsInFileOrder());
const embeddingNaming = deriveEmbeddingSpaceNaming(
  readFileSync(`${postgresDir}/src/embedding-space-table.ts`, "utf8"),
);
const advisoryLockKeys = deriveAdvisoryLockKeys({
  migrateSourceText: readFileSync(`${postgresDir}/src/migrate.ts`, "utf8"),
  vectorSpaceSourceText: readFileSync(`${postgresDir}/src/vector-space.ts`, "utf8"),
});

/** 2つの配列の対称差を「欠けている」「余分」に分ける。エラーメッセージ用。 */
function diffSets(derived, documented) {
  const derivedSet = new Set(derived);
  const documentedSet = new Set(documented);
  const missing = derived.filter((name) => !documentedSet.has(name));
  const extra = documented.filter((name) => !derivedSet.has(name));
  return { missing, extra };
}

describe("packages/postgres/README.md の「この package が作るオブジェクト」節（Issue #168）", () => {
  it("節そのものが存在する", () => {
    expect(readmeText).toMatch(/この package が作るオブジェクト/);
  });

  it("テーブル一覧が migrations/*.sql の最終形と一致する（過不足なし）", () => {
    const { missing, extra } = diffSets(migrationObjects.tables, readmeObjects.tables);
    expect(
      { missing, extra },
      `README に無いテーブル: ${JSON.stringify(missing)} / README にしか無い（実在しない）テーブル: ${JSON.stringify(extra)}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("索引一覧が migrations/*.sql の最終形と一致する（過不足なし。DROP された索引は数えない）", () => {
    const { missing, extra } = diffSets(migrationObjects.indexes, readmeObjects.indexes);
    expect(
      { missing, extra },
      `README に無い索引: ${JSON.stringify(missing)} / README にしか無い（実在しない）索引: ${JSON.stringify(extra)}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("テーブル見出しの件数表記が実際の本数と一致する", () => {
    expect(readmeObjects.tableHeadingCount).toBe(migrationObjects.tables.length);
  });

  it("索引見出しの件数表記が実際の本数と一致する", () => {
    expect(readmeObjects.indexHeadingCount).toBe(migrationObjects.indexes.length);
  });

  it("埋め込み空間ごとのテーブル名の接頭辞が embedding-space-table.ts の TABLE_PREFIX と一致する", () => {
    expect(
      readmeObjects.embeddingTablePattern,
      "README にテーブル名パターンの記載が無い",
    ).toBeDefined();
    expect(readmeObjects.embeddingTablePattern.startsWith(embeddingNaming.tablePrefix)).toBe(true);
  });

  it("埋め込み空間ごとの HNSW 索引名の接頭辞が embedding-space-table.ts の HNSW_INDEX_PREFIX と一致する", () => {
    expect(
      readmeObjects.embeddingIndexPattern,
      "README に索引名パターンの記載が無い",
    ).toBeDefined();
    expect(readmeObjects.embeddingIndexPattern.startsWith(embeddingNaming.indexPrefix)).toBe(true);
  });

  it("runMigrations の既定 advisory lock キー（MIGRATION_LOCK_KEY）が README に書いてある", () => {
    expect(readmeObjects.advisoryLockKeys).toContain(advisoryLockKeys.migrationLockKey);
  });

  it("registerEmbeddingSpace の既定 advisory lock キー（REGISTER_EMBEDDING_SPACE_LOCK_KEY）が README に書いてある", () => {
    expect(readmeObjects.advisoryLockKeys).toContain(
      advisoryLockKeys.registerEmbeddingSpaceLockKey,
    );
  });

  it("--schema 指定時のキー導出シード（runMigrations 側）の接頭辞が README に書いてある", () => {
    expect(readmeObjects.advisoryLockSeedPrefixes).toContain(
      advisoryLockKeys.migrationLockSeedPrefix,
    );
  });

  it("--schema 指定時のキー導出シード（registerEmbeddingSpace 側）の接頭辞が README に書いてある", () => {
    expect(readmeObjects.advisoryLockSeedPrefixes).toContain(
      advisoryLockKeys.registerEmbeddingSpaceLockSeedPrefix,
    );
  });

  it("CREATE FUNCTION は対象外であることが README に明記されている（対象範囲の限定を明示する）", () => {
    expect(readmeText).toMatch(/CREATE FUNCTION|関数.*対象外|対象外.*関数/);
  });
});
