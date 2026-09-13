import { describe, expect, it } from "vitest";
import {
  blankOutCommentsAndLiterals,
  findCallsMissingHook,
  findConformanceCalls,
} from "../conformance-hook-wiring-lib.mjs";

/**
 * `scripts/conformance-hook-wiring-lib.mjs`（走査そのもの）の歯。
 *
 * ⚠ **このファイルはリポジトリのソースを1バイトも読まない。**現物に当てる側は
 * `tenant-settings-conformance-hook-wiring.test.mjs` が見る
 * （`workflow-expression-lib.test.mjs` / `initdb-args-lib.test.mjs` と同じ役割分担）。
 *
 * 🔴 **この歯が無いと、走査が「何も見つけない」実装へ退化しても誰も気づかない**——
 * 現物に当てる側の主張は「**挙がった集合が空**」なので、**走査が壊れて空になっても
 * 緑で通る。**⟹ 走査そのものを直接測る。
 */
const FN = "describeTenantSettingsStoreConformance";
const HOOK = "setDefaultHalfLifeHours";

describe("blankOutCommentsAndLiterals（潰す処理そのもの）", () => {
  it("行コメント・ブロックコメントの中身は残らない", () => {
    const { text, unhandled } = blankOutCommentsAndLiterals(
      `const a = 1; // ${HOOK}\n/* ${HOOK} */\nconst b = 2;`,
    );
    expect(unhandled).toEqual([]);
    expect(text).not.toContain(HOOK);
    expect(text).toContain("const a = 1;");
    expect(text).toContain("const b = 2;");
  });

  it("文字列・テンプレートリテラルの中身も残らない（括弧の深さを撹乱させないため）", () => {
    const { text, unhandled } = blankOutCommentsAndLiterals(
      'const s = "a{b,c}"; const t = `INSERT INTO t (x, y) VALUES (${v})`; const u = 3;',
    );
    expect(unhandled).toEqual([]);
    expect(text).not.toContain("INSERT");
    expect(text).not.toContain("a{b,c}");
    expect(text).toContain("const u = 3;");
  });

  it("⛔ 潰したあとも長さと改行の位置は変わらない（行番号がずれないため）", () => {
    const source = 'a\n// x y z\nb\n/* q\n   r */\nc\n"str"\n`tpl`\n';
    const { text } = blankOutCommentsAndLiterals(source);
    expect(text).toHaveLength(source.length);
    expect(text.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("🔴 閉じていないブロックコメントは unhandled に名乗る（黙って全部潰さない）", () => {
    const { unhandled } = blankOutCommentsAndLiterals("const a = 1; /* 閉じていない");
    expect(unhandled).toHaveLength(1);
  });
});

describe("findConformanceCalls", () => {
  it("⛔ import 文・メソッド呼び出し・関数宣言は『呼び出し』として拾わない", () => {
    const source = [
      `import { ${FN} } from "../x.js";`,
      `export function ${FN}(options: Opts): void {}`,
      `helpers.${FN}({ name: "x" });`,
    ].join("\n");
    expect(findConformanceCalls(source, FN)).toEqual([]);
  });

  it("⭐ 最上位のキーだけを拾う（入れ子の同名キーを『渡している』と読まない）", () => {
    const source = `${FN}({ name: "x", createStore: () => ({ ${HOOK}: 1 }) });`;
    expect(findConformanceCalls(source, FN)).toEqual([{ line: 1, keys: ["name", "createStore"] }]);
  });

  it("⭐ 省略記法（{ hook }）も『渡している』として拾う", () => {
    const source = `${FN}({ name: "x", ${HOOK} });`;
    expect(findConformanceCalls(source, FN)).toEqual([{ line: 1, keys: ["name", HOOK] }]);
  });

  it("⭐ SQL のテンプレートリテラルが括弧・カンマを含んでいても最上位のキーを取り違えない", () => {
    const source = [
      `${FN}({`,
      `  name: "postgres",`,
      "  createStore: async () => new Store(),",
      `  ${HOOK}: async (ctx, hours) => {`,
      "    await db.execute(sql`INSERT INTO t (a, b) VALUES (${ctx.id}, ${hours})`);",
      "  },",
      "});",
    ].join("\n");
    expect(findConformanceCalls(source, FN)).toEqual([
      { line: 1, keys: ["name", "createStore", HOOK] },
    ]);
  });
});

describe("findCallsMissingHook（⛔ 陰性対照は件数ではなく集合の一致で書く）", () => {
  // 🔴 `toBeGreaterThan(0)` のような「入力が1件でもあれば常に真」の形は使わない。
  // ⟹ **弾くものと弾いてはいけないものを同じ1回の呼び出しに混ぜ**、
  // **挙げた集合**と**挙げなかった集合（補集合）**の**両方**が厳密に一致することを見る。
  // ⟹ 「全部挙げる」実装でも「何も挙げない」実装でも赤くなる。
  const MIXED = [
    // ⭐ 弾いてはいけない側: フックを渡している（1行目 / 2行目）
    `${FN}({ name: "ok-normal", createStore: c, ${HOOK}: h });`,
    `${FN}({ name: "ok-shorthand", createStore: c, ${HOOK} });`,
    // 🔴 弾くべき側: フックを渡していない（3行目）
    `${FN}({ name: "missing", createStore: c });`,
    // 🔴 弾くべき側: 入れ子にしか無い（4行目）——「渡している」と読んではいけない
    `${FN}({ name: "nested-only", createStore: () => ({ ${HOOK}: h }) });`,
    // 🔴 弾くべき側: 引数が読めない（5行目）——⛔「読めない」を緑で通さない
    `${FN}(sharedOptions);`,
  ].join("\n");

  it("フックを渡していない／読めない呼び出しだけを、行番号の集合として挙げる", () => {
    const flaggedLines = new Set(findCallsMissingHook(MIXED, FN, HOOK).map((c) => c.line));

    expect(flaggedLines).toEqual(new Set([3, 4, 5]));

    // ⭐ 挙げなかった側（補集合）も厳密に一致すること。
    const allLines = findConformanceCalls(MIXED, FN).map((c) => c.line);
    expect(new Set(allLines.filter((line) => !flaggedLines.has(line)))).toEqual(new Set([1, 2]));
  });

  it("🔴 地の文のコメントがフック名を引用しているだけでは『渡している』と読まない", () => {
    const source = [
      `// ${HOOK} を渡すべきだが、まだ渡していない`,
      `${FN}({ name: "commented", createStore: c });`,
    ].join("\n");
    const flaggedLines = new Set(findCallsMissingHook(source, FN, HOOK).map((c) => c.line));
    expect(flaggedLines).toEqual(new Set([2]));
  });

  it("呼び出しが1つも無いソースでは何も挙げない（⚠ これ単独は陰性対照として数えない。空=空の主張でしかない）", () => {
    expect(findCallsMissingHook("const a = 1;\n", FN, HOOK)).toEqual([]);
  });
});
