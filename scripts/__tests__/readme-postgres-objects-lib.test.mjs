import { describe, expect, it } from "vitest";
import {
  deriveAdvisoryLockKeys,
  deriveEmbeddingSpaceNaming,
  deriveMigrationObjects,
  extractBulletedIdentifiers,
  extractHeadingCount,
  extractMarkdownSection,
  parseReadmeObjectsSection,
  stripSqlBlockComments,
  stripSqlLineComments,
} from "../readme-postgres-objects-lib.mjs";

describe("stripSqlLineComments", () => {
  it("行コメントを剥がすが、コード部分は残す", () => {
    const input = ["CREATE TABLE foo (", "  id uuid -- primary key candidate", ");"].join("\n");
    expect(stripSqlLineComments(input)).toBe(["CREATE TABLE foo (", "  id uuid ", ");"].join("\n"));
  });

  it("コメントだけの行が丸ごと空行になる", () => {
    expect(stripSqlLineComments("-- CREATE INDEX ghost ON foo (id);")).toBe("");
  });
});

describe("stripSqlBlockComments", () => {
  it("ブロックコメントを剥がすが、コード部分は残す", () => {
    const input = "CREATE TABLE foo (\n  id uuid /* primary key candidate */\n);";
    expect(stripSqlBlockComments(input)).toBe("CREATE TABLE foo (\n  id uuid \n);");
  });

  it("複数行にまたがるブロックコメントも剥がす", () => {
    const input = [
      "/*",
      " * CREATE FUNCTION ghost() RETURNS void AS $$ $$ LANGUAGE sql;",
      " */",
      "CREATE TABLE foo (id uuid);",
    ].join("\n");
    expect(stripSqlBlockComments(input)).toBe("\nCREATE TABLE foo (id uuid);");
  });

  it("ブロックコメントが無ければ変化しない", () => {
    expect(stripSqlBlockComments("CREATE TABLE foo (id uuid);")).toBe(
      "CREATE TABLE foo (id uuid);",
    );
  });
});

describe("deriveMigrationObjects", () => {
  it("複数ファイルのテーブル・索引を集める", () => {
    const result = deriveMigrationObjects([
      "CREATE TABLE memories (id uuid);\nCREATE INDEX idx_a ON memories (id);",
      "CREATE UNIQUE INDEX uq_b ON memories (id);",
    ]);
    expect(result.tables).toEqual(["memories"]);
    expect(result.indexes).toEqual(["idx_a", "uq_b"]);
    expect(result.functions).toEqual([]);
  });

  it("後続ファイルの DROP INDEX が先行ファイルの CREATE を打ち消す（最終集合のみを返す）", () => {
    const result = deriveMigrationObjects([
      "CREATE TABLE memories (id uuid);\nCREATE INDEX idx_old ON memories (id);",
      "DROP INDEX idx_old;\nCREATE INDEX idx_new ON memories (id);",
    ]);
    expect(result.indexes).toEqual(["idx_new"]);
  });

  it("DROP TABLE も同様に最終集合から消える", () => {
    const result = deriveMigrationObjects([
      "CREATE TABLE scratch (id uuid);\nCREATE TABLE memories (id uuid);",
      "DROP TABLE scratch;",
    ]);
    expect(result.tables).toEqual(["memories"]);
  });

  it("コメント中の CREATE INDEX / CREATE TABLE 言及は無視する", () => {
    const result = deriveMigrationObjects([
      "-- 誤り: CREATE INDEX idx_ghost ON memories (id);\nCREATE TABLE memories (id uuid);",
    ]);
    expect(result.tables).toEqual(["memories"]);
    expect(result.indexes).toEqual([]);
  });

  it("同名の索引を作り直しても重複しない（Set なので1つに畳まれる）", () => {
    const result = deriveMigrationObjects([
      "CREATE INDEX idx_a ON t (id);",
      "DROP INDEX idx_a;\nCREATE INDEX idx_a ON t (id, other);",
    ]);
    expect(result.indexes).toEqual(["idx_a"]);
  });

  it("CREATE FUNCTION を集める", () => {
    const result = deriveMigrationObjects([
      "CREATE FUNCTION mnemora_lexical_normalize(text) RETURNS text AS $$\n  SELECT $1;\n$$ LANGUAGE sql IMMUTABLE;",
    ]);
    expect(result.functions).toEqual(["mnemora_lexical_normalize"]);
  });

  it("CREATE OR REPLACE FUNCTION も拾う（素朴な CREATE FUNCTION 探しだと取りこぼす形）", () => {
    const result = deriveMigrationObjects([
      "CREATE OR REPLACE FUNCTION mnemora_lexical_query_or(text) RETURNS tsquery AS $$\n  SELECT NULL;\n$$ LANGUAGE sql IMMUTABLE;",
    ]);
    expect(result.functions).toEqual(["mnemora_lexical_query_or"]);
  });

  it("DROP FUNCTION が最終集合から関数を消す", () => {
    const result = deriveMigrationObjects([
      "CREATE FUNCTION ghost_fn(text) RETURNS text AS $$ SELECT $1; $$ LANGUAGE sql;",
      "DROP FUNCTION ghost_fn(text);",
    ]);
    expect(result.functions).toEqual([]);
  });

  it("コメント中の CREATE FUNCTION 言及（行コメント・ブロックコメント両方）は無視する", () => {
    const result = deriveMigrationObjects([
      [
        "-- 誤り: CREATE FUNCTION ghost_line(text) RETURNS text AS $$ $$ LANGUAGE sql;",
        "/* CREATE FUNCTION ghost_block(text) RETURNS text AS $$ $$ LANGUAGE sql; */",
        "CREATE FUNCTION mnemora_lexical_normalize(text) RETURNS text AS $$ SELECT $1; $$ LANGUAGE sql;",
      ].join("\n"),
    ]);
    expect(result.functions).toEqual(["mnemora_lexical_normalize"]);
  });

  it("packages/postgres/migrations の現物から導くと、テーブル8・索引20・関数5になる（回帰止め）", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const migrationsDir = fileURLToPath(
      new URL("../../packages/postgres/migrations", import.meta.url),
    );
    const fileNames = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const texts = fileNames.map((name) => readFileSync(`${migrationsDir}/${name}`, "utf8"));
    const result = deriveMigrationObjects(texts);
    expect(result.tables).toHaveLength(8);
    expect(result.indexes).toHaveLength(20);
    expect(result.functions).toEqual([
      "mnemora_lexical_coverage",
      "mnemora_lexical_normalize",
      "mnemora_lexical_query_or",
      "mnemora_lexical_query_terms",
      "mnemora_lexical_query_tsqueries",
    ]);
  });
});

describe("deriveEmbeddingSpaceNaming", () => {
  it("TABLE_PREFIX / HNSW_INDEX_PREFIX を読む", () => {
    const source = [
      'const TABLE_PREFIX = "memory_embeddings_";',
      'const HNSW_INDEX_PREFIX = "idx_memory_embeddings_hnsw_";',
    ].join("\n");
    expect(deriveEmbeddingSpaceNaming(source)).toEqual({
      tablePrefix: "memory_embeddings_",
      indexPrefix: "idx_memory_embeddings_hnsw_",
    });
  });

  it("定数が見つからなければ、読み取れなかったことが分かるエラーで落ちる", () => {
    expect(() => deriveEmbeddingSpaceNaming("// no consts here")).toThrow(/読み取れなかった/);
  });
});

describe("deriveAdvisoryLockKeys", () => {
  it("既定キーとスキーマ別シードの接頭辞を読む", () => {
    const migrateSourceText = [
      "export const MIGRATION_LOCK_KEY = 7190158676462701299n;",
      "  return deriveAdvisoryLockKey(`mnemora:runMigrations:advisory-lock:${schema}`);",
    ].join("\n");
    const vectorSpaceSourceText = [
      "export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = -4359922960011245935n;",
      "  return deriveAdvisoryLockKey(`mnemora:registerEmbeddingSpace:advisory-lock:${schema}`);",
    ].join("\n");
    expect(deriveAdvisoryLockKeys({ migrateSourceText, vectorSpaceSourceText })).toEqual({
      migrationLockKey: "7190158676462701299",
      registerEmbeddingSpaceLockKey: "-4359922960011245935",
      migrationLockSeedPrefix: "mnemora:runMigrations:advisory-lock:",
      registerEmbeddingSpaceLockSeedPrefix: "mnemora:registerEmbeddingSpace:advisory-lock:",
    });
  });

  it("片方でも読み取れなければ落ちる", () => {
    expect(() =>
      deriveAdvisoryLockKeys({ migrateSourceText: "", vectorSpaceSourceText: "" }),
    ).toThrow(/読み取れなかった/);
  });
});

describe("extractMarkdownSection / extractHeadingCount / extractBulletedIdentifiers", () => {
  const markdown = [
    "# タイトル",
    "",
    "### テーブル（2）",
    "",
    "- `memories`",
    "- `outbox`",
    "",
    "### 索引（1）",
    "",
    "- `idx_a`",
    "",
    "## 別の節",
    "本文",
  ].join("\n");

  it("見出しから次の見出しの直前までを切り出す", () => {
    const section = extractMarkdownSection(markdown, "テーブル");
    expect(section).toContain("`memories`");
    expect(section).toContain("`outbox`");
    expect(section).not.toContain("索引");
  });

  it("見出しの（N）から件数を読む", () => {
    expect(extractHeadingCount(markdown, "テーブル")).toBe(2);
    expect(extractHeadingCount(markdown, "索引")).toBe(1);
  });

  it("箇条書きの識別子だけを拾う", () => {
    const section = extractMarkdownSection(markdown, "テーブル");
    expect(extractBulletedIdentifiers(section)).toEqual(["memories", "outbox"]);
  });

  it("見出しが無ければ undefined", () => {
    expect(extractMarkdownSection(markdown, "存在しない見出し")).toBeUndefined();
  });
});

describe("parseReadmeObjectsSection", () => {
  it("テーブル・索引・関数・実行時系列・advisory lock を1つの形にまとめる", () => {
    const markdown = [
      "### テーブル（1）",
      "",
      "- `memories`",
      "",
      "### 索引（1）",
      "",
      "- `idx_a`",
      "",
      "### 関数（1）",
      "",
      "- `mnemora_lexical_normalize`",
      "",
      "### 実行時に増える系列（埋め込み空間ごと）",
      "",
      "- テーブル: `memory_embeddings_<space>`",
      "- 索引: `idx_memory_embeddings_hnsw_<space>`",
      "",
      "### advisory lock のキー",
      "",
      "- runMigrations: `7190158676462701299`（シード `mnemora:runMigrations:advisory-lock:<schema>`）",
      "- registerEmbeddingSpace: `-4359922960011245935`（シード `mnemora:registerEmbeddingSpace:advisory-lock:<schema>`）",
    ].join("\n");

    expect(parseReadmeObjectsSection(markdown)).toEqual({
      tables: ["memories"],
      indexes: ["idx_a"],
      functions: ["mnemora_lexical_normalize"],
      tableHeadingCount: 1,
      indexHeadingCount: 1,
      functionHeadingCount: 1,
      embeddingTablePattern: "memory_embeddings_<space>",
      embeddingIndexPattern: "idx_memory_embeddings_hnsw_<space>",
      advisoryLockKeys: ["7190158676462701299", "-4359922960011245935"],
      advisoryLockSeedPrefixes: [
        "mnemora:runMigrations:advisory-lock:",
        "mnemora:registerEmbeddingSpace:advisory-lock:",
      ],
    });
  });

  it("関数の見出しが無ければ functions は空配列、functionHeadingCount は undefined", () => {
    const markdown = ["### テーブル（1）", "", "- `memories`"].join("\n");
    const result = parseReadmeObjectsSection(markdown);
    expect(result.functions).toEqual([]);
    expect(result.functionHeadingCount).toBeUndefined();
  });
});
