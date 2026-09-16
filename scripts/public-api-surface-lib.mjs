/**
 * `scripts/check-public-api-surface.mjs`（Issue #342 / ADR 0178）が使う純関数群。
 *
 * ここに実装を持たせ、CLI 本体（`check-public-api-surface.mjs`）を薄く保つのは
 * `scripts/publish-pack-checks.mjs` / `scripts/check-publish-pack.mjs` と同じ理由——
 * `scripts/__tests__/public-api-surface-lib.test.mjs` が合成フィクスチャ（実際の
 * ビルド成果物を用意せずに作った小さな `.d.ts` 群）へ直接これらの関数を呼べるようにする。
 *
 * **既存 devDependency の `typescript`（ルート package.json）だけを使う。**新規依存は
 * オーナー専権（`docs/autonomy.md` §3）であり、この設計は新規依存ゼロで成立する
 * （ADR 0178「測ったこと」）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * 相対 import の拡張子から、対応する宣言ファイルの拡張子への対応表。
 *
 * このリポジトリの publish 対象パッケージはすべて `"type": "module"`（ESM）であり、
 * `.ts` は `.js`（宣言は `.d.ts`）、`.mts` は `.mjs`（宣言は `.d.mts`）、`.cts` は
 * `.cjs`（宣言は `.d.cts`）へコンパイルされる。**素朴に「`.js` を `.d.ts` に変える」
 * 変換だけでは `packages/postgres/dist/migrate.d.ts` の
 * `import { DEFAULT_MIGRATIONS_DIR } from "./migrations-dir.cjs"` を取りこぼす**
 * （ADR 0086 / Issue #110 — `import.meta` を CommonJS の `.cts` サイドカーへ追い出した
 * 副産物として、この import だけ `.cjs` を指す）。ここを詰めないと BFS が
 * `migrations-dir.d.cts` へ辿り着かず、公開型として認識しないまま snapshot に穴が空く。
 */
const DECLARATION_EXTENSION_BY_SOURCE_EXTENSION = {
  ".js": ".d.ts",
  ".mjs": ".d.mts",
  ".cjs": ".d.cts",
};

function toPosixPath(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * `package.json` の `exports` から、`types` を持つエントリ（起点となる `.d.ts`）を
 * すべて拾う。
 *
 * **`exports` だけを見る**（トップレベルの `types`/`main` は見ない）。`exports` が
 * このリポジトリの publish 対象パッケージすべてで存在し、`"./package.json":
 * "./package.json"` のような文字列エントリ（`types` を持たない）はここで除外される。
 *
 * `@mnemora/testkit` のように `"."` と `"./fixtures"` の2エントリを持つパッケージも
 * ここで両方拾う——1エントリだけを起点にすると、もう一方のエントリからしか
 * 到達できない宣言ファイルを見落とす。
 */
export function entryTypesFilesFromExports(packageJson, packageDir) {
  const exportsField = packageJson.exports;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    throw new Error(`package.json に exports（オブジェクト）が無い: ${packageDir}`);
  }
  const entries = [];
  for (const [subpath, value] of Object.entries(exportsField)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // `"./package.json": "./package.json"` のような文字列エントリはここで除外する。
      continue;
    }
    const typesPath = value.types;
    if (typeof typesPath !== "string") {
      continue;
    }
    entries.push({ subpath, absPath: resolve(packageDir, typesPath) });
  }
  if (entries.length === 0) {
    throw new Error(`package.json の exports に types を持つエントリが1つも無い: ${packageDir}`);
  }
  return entries;
}

/**
 * `.d.ts`/`.d.mts`/`.d.cts` の相対 import 指定子（`"./foo.js"` 等）を、対応する
 * 宣言ファイルの絶対パスへ解決する。
 *
 * - 相対でない指定子（`"@mnemora/core"`・`"pg"`・`"node:fs"` 等）は `null` を返す
 *   （外部パッケージの型はこのパッケージの公開面ではない——素通しでよい）。
 * - `.json` で終わる指定子（`"./package.json"` 等）も `null`（宣言の連鎖ではない）。
 * - 対応表に無い拡張子は例外を投げる。**黙って読み飛ばさない**——対応表が古くなったまま
 *   気づかれない事故（`docs/autonomy.md` §4.1「静かに失敗する道具」の族）を避ける。
 * - 解決先が実在しなければ例外を投げる。理由は同上。
 */
export function resolveRelativeDeclarationImport(specifier, fromDir) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const ext = extname(specifier);
  if (ext === ".json") {
    return null;
  }
  const declExt = DECLARATION_EXTENSION_BY_SOURCE_EXTENSION[ext];
  if (!declExt) {
    throw new Error(
      `未知の拡張子を持つ相対 import です（対応表 DECLARATION_EXTENSION_BY_SOURCE_EXTENSION に ` +
        `追加すること）: "${specifier}"（${fromDir} 内）`,
    );
  }
  const withoutExt = specifier.slice(0, specifier.length - ext.length);
  const candidate = resolve(fromDir, `${withoutExt}${declExt}`);
  if (!existsSync(candidate)) {
    throw new Error(
      `相対 import が指す宣言ファイルが実在しません: "${specifier}" -> ${candidate}（${fromDir} 内）。` +
        `dist が古いか、ビルドが壊れています。`,
    );
  }
  return candidate;
}

/** `.d.ts` テキストを TypeScript の parser で `SourceFile` にする。 */
export function parseDeclarationFile(absPath, text = readFileSync(absPath, "utf8")) {
  return ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * `SourceFile` から、相対 import/export の指定子（重複排除済み）を集める。
 *
 * 3つの形を拾う:
 * - `import ... from "./x.js"` / `import type ... from "./x.js"`
 * - `export ... from "./x.js"` / `export type ... from "./x.js"` / `export * from "./x.js"`
 * - `import("./x.js").Foo` という**式ではなく型位置**の動的 import 型
 *   （`typeof import("./x.js")` のような形で出うる。関数・変数宣言全体を辿るため
 *   `ts.forEachChild` で再帰する——トップレベルの import/export 文だけを見ると、
 *   型注釈の奥に埋め込まれたこの形を見落とす）。
 */
export function collectRelativeImportSpecifiers(sourceFile) {
  const specifiers = new Set();
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.add(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...specifiers];
}

/**
 * エントリの `.d.ts`（`entryTypesFilesFromExports` が返すもの）から、相対 import を
 * BFS で辿って到達可能な宣言ファイルの絶対パス一覧を返す（ソート済み）。
 *
 * **`dist/` を無差別に列挙しない。**この BFS だけが到達可能性の根拠であり、
 * `postgres` の `mapping.d.ts`（コメントの中でしか言及されず、どの `.d.ts` からも
 * import されていない）・`bin/*.d.ts`（`exports` に載っていない `bin` エントリ）、
 * `testkit` の `__fixtures__/id.d.ts`（`fixtures.d.ts` が再 export していない内部専用
 * ファイル）はここに現れない（ADR 0178「採らなかった案」(iii)）。
 */
export function collectReachableDeclarationFiles(entryAbsPaths) {
  const visited = new Set();
  const queue = [...entryAbsPaths];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    if (!existsSync(current)) {
      throw new Error(`宣言ファイルが実在しません: ${current}`);
    }
    visited.add(current);
    const sourceFile = parseDeclarationFile(current);
    const fromDir = dirname(current);
    for (const specifier of collectRelativeImportSpecifiers(sourceFile)) {
      const resolved = resolveRelativeDeclarationImport(specifier, fromDir);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return [...visited].sort();
}

/**
 * `.d.ts` のコメントを剥がして正規化したテキストを返す。
 *
 * TypeScript の parser/printer だけを使う（`removeComments: true`）——JSDoc を
 * 残したまま diff を取ると、全体の約6割が本文（コメント）になり、実際に公開面が
 * 変わった行との signal/noise 比が落ちる（ADR 0178「測ったこと」）。
 *
 * printer は改行やインデントも自分の流儀で出し直す。**これは狙った副作用**——
 * 出力元のソースの改行位置やインデントの揺れに、この歯の緑/赤が左右されなくなる。
 */
export function normalizeDeclarationText(absPath) {
  const sourceFile = parseDeclarationFile(absPath);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(sourceFile);
}

/**
 * 1パッケージぶんの公開型 snapshot テキストを組み立てる。
 *
 * - 起点は `entryTypesFilesFromExports`（`exports.*.types`）。
 * - 到達可能な宣言ファイルを `collectReachableDeclarationFiles` で BFS。
 * - 各ファイルをコメント無しに正規化し、`// ===== <packageDir 相対パス> =====` の
 *   見出しを付けて連結する（見出しがあると diff のどのファイルが動いたかが読める）。
 * - ファイルの並びはパッケージルートからの相対パスの辞書順に固定する
 *   （実行環境や BFS の探索順に左右されない安定した出力にするため）。
 */
export function buildPublicApiSnapshotText(packageDir, packageJson) {
  const entries = entryTypesFilesFromExports(packageJson, packageDir);
  const entryAbsPaths = [...entries.map((e) => e.absPath)].sort();
  for (const absPath of entryAbsPaths) {
    if (!existsSync(absPath)) {
      throw new Error(
        `exports.*.types が指すファイルが実在しません: ${absPath}。` +
          `先に \`pnpm run build\` を実行してください。`,
      );
    }
  }
  const reachable = collectReachableDeclarationFiles(entryAbsPaths);
  const sections = reachable.map((absPath) => {
    const relPath = toPosixPath(relative(packageDir, absPath));
    const normalized = normalizeDeclarationText(absPath).trimEnd();
    return `// ===== ${relPath} =====\n${normalized}\n`;
  });
  return `${sections.join("\n")}`;
}
