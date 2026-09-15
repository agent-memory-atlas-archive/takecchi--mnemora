import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles } from "../migrate.js";
import { stripSqlComments } from "./sql-comments.js";

/**
 * `./sql-comments.ts` の `stripSqlComments` 単体の歯（Issue #227）。
 *
 * `stripSqlComments` は「自前で書いた comment の剥がし方」であり、Issue #227 は
 * 「自前の剥がし方を歯無しで入れないこと」と名指ししている。この歯がその歯である。
 *
 * Issue #227 が名指しした3つのケース（`--` 行 comment・`/` `*` ブロック comment・
 * 文字列リテラルの中に現れる `--`）を直接検査したうえで、`migrations/*.sql` の
 * 実物すべてに対しても壊れずに通ることを確かめる。
 */
describe("stripSqlComments", () => {
  it("`--` 行 comment を取り除く（改行は残す）", () => {
    expect(stripSqlComments("SELECT 1; -- this is a comment\nSELECT 2;")).toBe(
      "SELECT 1; \nSELECT 2;",
    );
  });

  it("PR #226 で実際に踏んだ字面 —— `--` 行 comment の中の `SET LOCAL search_path` も取り除く", () => {
    const sql = "-- SET LOCAL search_path の直後に実行する\nALTER TABLE t ADD COLUMN c int;";
    const stripped = stripSqlComments(sql);
    expect(stripped).not.toMatch(/SET LOCAL search_path/);
    expect(stripped).toContain("ALTER TABLE t ADD COLUMN c int;");
  });

  it("`/* */` ブロック comment を取り除く（1行）", () => {
    expect(stripSqlComments("SELECT /* comment */ 1;")).toBe("SELECT   1;");
  });

  it("`/* */` ブロック comment を取り除く（複数行）", () => {
    const sql = "SELECT 1;\n/*\n複数行の\ncomment\n*/\nSELECT 2;";
    const stripped = stripSqlComments(sql);
    expect(stripped).not.toMatch(/複数行|comment/);
    expect(stripped).toContain("SELECT 1;");
    expect(stripped).toContain("SELECT 2;");
  });

  it("`/* */` ブロック comment の入れ子を取り除く（PostgreSQL は入れ子を許す）", () => {
    const sql = "SELECT /* outer /* inner */ still outer */ 1;";
    const stripped = stripSqlComments(sql);
    expect(stripped).not.toMatch(/outer|inner/);
    expect(stripped).toContain("SELECT");
    expect(stripped).toContain("1;");
  });

  it("トークンが隣接して繋がらない（comment の跡に空白を残す）", () => {
    // `a/*c*/b` を素朴に空文字へ置換すると `ab` になり、別の識別子に化ける。
    expect(stripSqlComments("a/*c*/b")).toBe("a b");
  });

  it("単一引用符の文字列リテラルの中の `--` は comment として扱わない（Issue #227 が名指しした3つ目のケース）", () => {
    const sql = "SELECT '-- not a comment, SET LOCAL search_path here';";
    const stripped = stripSqlComments(sql);
    expect(stripped).toBe(sql);
  });

  it("単一引用符の文字列リテラルの中の `/* */` 風の文字列も comment として扱わない", () => {
    const sql = "SELECT 'a/*b*/c';";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("`''` でエスケープされた引用符をまたいでも文字列は閉じない —— `--` はその内側のまま残る", () => {
    const sql = "SELECT 'it''s -- still inside the string';";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("文字列を閉じたあとの `--` は comment として取り除く", () => {
    const sql = "SELECT 'literal' -- trailing comment\n;";
    expect(stripSqlComments(sql)).toBe("SELECT 'literal' \n;");
  });

  it("二重引用符の識別子の中の `--` は comment として扱わない", () => {
    const sql = 'SELECT 1 AS "col--name";';
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("`$$ ... $$`（dollar-quoting）の中の `--` は comment として扱わない", () => {
    const sql = "DO $$ BEGIN -- not a real comment marker outside\nEND $$;";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("タグ付き dollar-quoting（`$tag$ ... $tag$`）の中の `--` も comment として扱わない", () => {
    const sql = "SELECT $body$ SET LOCAL search_path is just text here -- not a comment $body$;";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("`$1` のような bind パラメータを dollar-quoting の開始と誤認しない", () => {
    const sql = "INSERT INTO t (name) VALUES ($1);";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("空文字列を渡しても壊れない", () => {
    expect(stripSqlComments("")).toBe("");
  });

  it("comment を1つも含まない SQL は1バイトも変えない", () => {
    const sql = "ALTER TABLE memory_events ADD CONSTRAINT c CHECK (kind IN ('a', 'b'));";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("`migrations/*.sql` の実物すべてに対して、剥がした後も comment 由来ではない SQL 本体が残る", () => {
    const files = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
      const stripped = stripSqlComments(sql);

      // 剥がした結果が空にならない —— 説明 comment しか無いファイルは無い。
      expect(stripped.trim().length).toBeGreaterThan(0);
      // 剥がした結果は常に元より短いか同じ（comment を追加することは無い）。
      expect(stripped.length).toBeLessThanOrEqual(sql.length);
    }
  });
});
