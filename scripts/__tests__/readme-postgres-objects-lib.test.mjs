import { describe, expect, it } from "vitest";
import {
  deriveAdvisoryLockKeys,
  deriveEmbeddingSpaceNaming,
  deriveMigrationObjects,
  extractBulletedIdentifiers,
  extractHeadingCount,
  extractMarkdownSection,
  parseReadmeObjectsSection,
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

describe("deriveMigrationObjects", () => {
  it("複数ファイルのテーブル・索引を集める", () => {
    const result = deriveMigrationObjects([
      "CREATE TABLE memories (id uuid);\nCREATE INDEX idx_a ON memories (id);",
      "CREATE UNIQUE INDEX uq_b ON memories (id);",
    ]);
    expect(result.tables).toEqual(["memories"]);
    expect(result.indexes).toEqual(["idx_a", "uq_b"]);
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
  it("テーブル・索引・実行時系列・advisory lock を1つの形にまとめる", () => {
    const markdown = [
      "### テーブル（1）",
      "",
      "- `memories`",
      "",
      "### 索引（1）",
      "",
      "- `idx_a`",
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
      tableHeadingCount: 1,
      indexHeadingCount: 1,
      embeddingTablePattern: "memory_embeddings_<space>",
      embeddingIndexPattern: "idx_memory_embeddings_hnsw_<space>",
      advisoryLockKeys: ["7190158676462701299", "-4359922960011245935"],
      advisoryLockSeedPrefixes: [
        "mnemora:runMigrations:advisory-lock:",
        "mnemora:registerEmbeddingSpace:advisory-lock:",
      ],
    });
  });
});
