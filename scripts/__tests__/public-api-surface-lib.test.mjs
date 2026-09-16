import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicApiSnapshotText,
  collectReachableDeclarationFiles,
  collectRelativeImportSpecifiers,
  entryTypesFilesFromExports,
  normalizeDeclarationText,
  parseDeclarationFile,
  resolveRelativeDeclarationImport,
} from "../public-api-surface-lib.mjs";

/**
 * `scripts/check-public-api-surface.mjs`（Issue #342 / ADR 0178）が使う純関数の歯。
 *
 * ⭐ **この歯が測っているもの**: 到達可能性の絞り込み（`exports.*.types` から相対 import を
 * BFS で辿ったものだけを拾い、`dist/` を無差別に拾わないこと）と、コメント剥がし
 * （JSDoc を残さず正規化すること）が実際に効いていること。
 *
 * すべて合成フィクスチャ（一時ディレクトリに手で作った小さな `.d.ts`）に対して行う——
 * `scripts/__tests__/check-cjs-transpile-parse.test.mjs` の docstring が説明するとおり、
 * CI の `build` ジョブで `pnpm run test` が走る「Test」段は「Build」段より**前**にあり、
 * 実物の `packages/<name>/dist` はまだ存在しないことがある。実物に対して走らせる確認は
 * `.github/workflows/ci.yml` の `build` ジョブが `Build` の直後に行う。
 */

/** @type {string | undefined} */
let fixtureRoot;

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
});

function newFixtureDir() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "public-api-surface-lib-"));
  return fixtureRoot;
}

function writeFile(dir, relPath, contents) {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return full;
}

describe("entryTypesFilesFromExports", () => {
  it("exports の各サブパスのうち types を持つオブジェクトエントリだけを拾う", () => {
    const dir = newFixtureDir();
    const packageJson = {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./fixtures": { types: "./dist/fixtures.d.ts", default: "./dist/fixtures.js" },
        // `"./package.json": "./package.json"` のような文字列エントリは types を持たない。
        "./package.json": "./package.json",
      },
    };
    const entries = entryTypesFilesFromExports(packageJson, dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.subpath).sort()).toEqual([".", "./fixtures"]);
    expect(entries.find((e) => e.subpath === ".").absPath).toBe(join(dir, "dist/index.d.ts"));
  });

  it("exports が無ければ例外", () => {
    expect(() => entryTypesFilesFromExports({}, "/x")).toThrow(/exports/);
  });

  it("exports はあるが types を持つエントリが1つも無ければ例外", () => {
    const packageJson = { exports: { "./package.json": "./package.json" } };
    expect(() => entryTypesFilesFromExports(packageJson, "/x")).toThrow(/types/);
  });
});

describe("resolveRelativeDeclarationImport（⭐ .cjs/.mjs の拡張子ずれ、Issue #342 実測の粗さ）", () => {
  it("相対でない指定子（外部パッケージ）は null", () => {
    expect(resolveRelativeDeclarationImport("@mnemora/core", "/x")).toBeNull();
    expect(resolveRelativeDeclarationImport("pg", "/x")).toBeNull();
    expect(resolveRelativeDeclarationImport("node:fs", "/x")).toBeNull();
  });

  it("./package.json は宣言の連鎖ではないので null", () => {
    expect(resolveRelativeDeclarationImport("./package.json", "/x")).toBeNull();
  });

  it("'.js' の相対 import は同名の '.d.ts' に解決する", () => {
    const dir = newFixtureDir();
    writeFile(dir, "client.d.ts", "export {};\n");
    expect(resolveRelativeDeclarationImport("./client.js", dir)).toBe(join(dir, "client.d.ts"));
  });

  it("🔴 '.cjs' の相対 import は '.d.cts' に解決する（packages/postgres/dist/migrate.d.ts が実際に踏む形）", () => {
    const dir = newFixtureDir();
    writeFile(
      dir,
      "migrations-dir.d.cts",
      "export declare const DEFAULT_MIGRATIONS_DIR: string;\n",
    );
    expect(resolveRelativeDeclarationImport("./migrations-dir.cjs", dir)).toBe(
      join(dir, "migrations-dir.d.cts"),
    );
    // 素朴な「.js → .d.ts」変換だと '.cjs' を単純に '.d.ts' へ変えて
    // 'migrations-dir.d.ts'（実在しない）を探しに行き、ここで落ちるか、
    // 見落として BFS から抜け落ちる。ここではそれが起きていないことを別途、
    // 存在しないファイルで確認する。
    writeFile(dir, "migrations-dir.d.ts", "// これは .cjs の解決先ではない\n");
    expect(resolveRelativeDeclarationImport("./migrations-dir.cjs", dir)).toBe(
      join(dir, "migrations-dir.d.cts"),
    );
  });

  it("'.mjs' の相対 import は '.d.mts' に解決する", () => {
    const dir = newFixtureDir();
    writeFile(dir, "esm-only.d.mts", "export {};\n");
    expect(resolveRelativeDeclarationImport("./esm-only.mjs", dir)).toBe(
      join(dir, "esm-only.d.mts"),
    );
  });

  it("未知の拡張子は例外（対応表が古くなったまま黙って読み飛ばさない）", () => {
    const dir = newFixtureDir();
    expect(() => resolveRelativeDeclarationImport("./data.wasm", dir)).toThrow(/未知の拡張子/);
  });

  it("解決先が実在しなければ例外（dist が古い/壊れていることを黙って見逃さない）", () => {
    const dir = newFixtureDir();
    expect(() => resolveRelativeDeclarationImport("./missing.js", dir)).toThrow(/実在しません/);
  });
});

describe("collectRelativeImportSpecifiers", () => {
  function specifiersOf(text) {
    const sourceFile = parseDeclarationFile("virtual.d.ts", text);
    return collectRelativeImportSpecifiers(sourceFile).sort();
  }

  it("import/export の module specifier を拾う", () => {
    const text = [
      'import type { Pool } from "pg";',
      'import { X } from "./a.js";',
      'export { Y } from "./b.js";',
      'export * from "./c.js";',
      'export type { Z } from "./d.js";',
    ].join("\n");
    expect(specifiersOf(text)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "pg"]);
  });

  it('型位置の動的 import（`import("./x.js").Foo`）も拾う', () => {
    const text = 'export declare const w: typeof import("./e.js").Widget;\n';
    expect(specifiersOf(text)).toEqual(["./e.js"]);
  });

  it("同じ指定子は重複排除される", () => {
    const text = ['import { A } from "./a.js";', 'export { B } from "./a.js";'].join("\n");
    expect(specifiersOf(text)).toEqual(["./a.js"]);
  });
});

describe("collectReachableDeclarationFiles（⭐ BFS が到達可能なものだけを拾う）", () => {
  it("エントリから相対 import を辿って到達可能な宣言ファイルだけを集める", () => {
    const dir = newFixtureDir();
    const index = writeFile(dir, "index.d.ts", 'export * from "./a.js";\n');
    const a = writeFile(dir, "a.d.ts", 'import { c } from "./sub/c.mjs";\nexport { c };\n');
    const c = writeFile(dir, "sub/c.d.mts", "export declare const c: number;\n");

    const reachable = collectReachableDeclarationFiles([index]);
    expect(reachable.sort()).toEqual([a, c, index].sort());
  });

  it("🔴 どの .d.ts からも import されていないファイルは、コメントで言及されるだけでは拾わない（postgres の mapping.d.ts 型の事故）", () => {
    const dir = newFixtureDir();
    const index = writeFile(
      dir,
      "index.d.ts",
      "// mapping.d.ts の isUuidLike を参照\nexport declare const x: number;\n",
    );
    writeFile(dir, "mapping.d.ts", "export declare function isUuidLike(s: string): boolean;\n");

    const reachable = collectReachableDeclarationFiles([index]);
    expect(reachable).toEqual([index]);
  });

  it("bin/*.d.ts のように exports に載らないファイルは、起点に含めなければ現れない", () => {
    const dir = newFixtureDir();
    const index = writeFile(dir, "index.d.ts", "export declare const x: number;\n");
    writeFile(dir, "bin/migrate.d.ts", "export {};\n");

    const reachable = collectReachableDeclarationFiles([index]);
    expect(reachable).toEqual([index]);
  });

  it("循環参照があっても無限ループしない", () => {
    const dir = newFixtureDir();
    const a = writeFile(dir, "a.d.ts", 'import "./b.js";\nexport declare const a: number;\n');
    const b = writeFile(dir, "b.d.ts", 'import "./a.js";\nexport declare const b: number;\n');

    const reachable = collectReachableDeclarationFiles([a]);
    expect(reachable.sort()).toEqual([a, b].sort());
  });
});

describe("normalizeDeclarationText（⭐ コメント剥がし）", () => {
  it("JSDoc・行コメントを剥がす", () => {
    const dir = newFixtureDir();
    const file = writeFile(
      dir,
      "x.d.ts",
      [
        "/**",
        " * これは長い JSDoc である。",
        " * 何行あっても構わない。",
        " */",
        "export declare function foo(): number; // 行コメント",
      ].join("\n"),
    );
    const normalized = normalizeDeclarationText(file);
    expect(normalized).not.toContain("JSDoc");
    expect(normalized).not.toContain("行コメント");
    expect(normalized).toContain("export declare function foo(): number;");
  });

  it("シグネチャそのもの（型・名前）は保持する", () => {
    const dir = newFixtureDir();
    const file = writeFile(
      dir,
      "y.d.ts",
      "export interface Foo {\n  bar: string;\n  baz?: number;\n}\n",
    );
    const normalized = normalizeDeclarationText(file);
    expect(normalized).toContain("bar: string;");
    expect(normalized).toContain("baz?: number;");
  });
});

describe("buildPublicApiSnapshotText（統合）", () => {
  it("複数ファイルを見出し付きで連結し、パス順に安定する", () => {
    const dir = newFixtureDir();
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "dist/index.d.ts"),
      '/** doc */\nexport * from "./a.js";\nexport declare const z: number;\n',
      "utf8",
    );
    writeFileSync(join(dir, "dist/a.d.ts"), "export declare const a: string;\n", "utf8");
    const packageJson = {
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    };
    const text = buildPublicApiSnapshotText(dir, packageJson);
    expect(text).toContain("// ===== dist/a.d.ts =====");
    expect(text).toContain("// ===== dist/index.d.ts =====");
    expect(text).not.toContain("doc");
    // a.d.ts が index.d.ts より辞書順で先に来る。
    expect(text.indexOf("dist/a.d.ts")).toBeLessThan(text.indexOf("dist/index.d.ts"));
  });

  it("exports.*.types が指すファイルが実在しなければ、ビルドを促す例外", () => {
    const dir = newFixtureDir();
    mkdirSync(dir, { recursive: true });
    const packageJson = {
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    };
    expect(() => buildPublicApiSnapshotText(dir, packageJson)).toThrow(/pnpm run build/);
  });

  it("🔴 必須メソッドの追加（ADR 0161 型の破壊的変更）が出力の差分として現れる", () => {
    const dir = newFixtureDir();
    mkdirSync(join(dir, "dist"), { recursive: true });
    const packageJson = {
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    };
    writeFileSync(
      join(dir, "dist/index.d.ts"),
      "export interface Runtime {\n  observe(): void;\n}\n",
      "utf8",
    );
    const before = buildPublicApiSnapshotText(dir, packageJson);
    writeFileSync(
      join(dir, "dist/index.d.ts"),
      "export interface Runtime {\n  observe(): void;\n  getRecall(): void;\n}\n",
      "utf8",
    );
    const after = buildPublicApiSnapshotText(dir, packageJson);
    expect(before).not.toBe(after);
    expect(after).toContain("getRecall(): void;");
  });

  it("🔴 任意フィールドが必須へ変わる（ADR 0165 型の破壊的変更）が出力の差分として現れる", () => {
    const dir = newFixtureDir();
    mkdirSync(join(dir, "dist"), { recursive: true });
    const packageJson = {
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    };
    writeFileSync(
      join(dir, "dist/index.d.ts"),
      "export interface Options {\n  supportsDecayClock?: boolean;\n}\n",
      "utf8",
    );
    const before = buildPublicApiSnapshotText(dir, packageJson);
    writeFileSync(
      join(dir, "dist/index.d.ts"),
      "export interface Options {\n  supportsDecayClock: boolean;\n}\n",
      "utf8",
    );
    const after = buildPublicApiSnapshotText(dir, packageJson);
    expect(before).not.toBe(after);
    expect(before).toContain("supportsDecayClock?: boolean;");
    expect(after).toContain("supportsDecayClock: boolean;");
    expect(after).not.toContain("supportsDecayClock?: boolean;");
  });
});
