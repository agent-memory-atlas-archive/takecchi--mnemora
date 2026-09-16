import { describe, expect, it } from "vitest";
import {
  ANY_ENCODING,
  findInconsistentLegs,
  impliedEncodingForLocale,
  parseInitdbArgs,
} from "../initdb-args-lib.mjs";

/**
 * `scripts/initdb-args-lib.mjs`(`--locale=` を含めた自己無矛盾判定そのもの)の歯。
 *
 * ⚠ **このファイルは `ci.yml` を1バイトも読まない。**配線が在るかどうか
 * (`ci-yml-postgres-regime-wiring.test.mjs` が実際に `matrixLegs` へ呼んでいるか)は
 * 使う側の歯が見る——`workflow-expression-lib.test.mjs` と同じ役割分担。
 *
 * 🔴 **陰性対照は「件数」ではなく「集合の一致」で書く。**`toBeGreaterThan(0)` のような
 * 「入力が1件でもあれば常に真」の形は、変異試験でも見つからない
 * (「正しく挙げた」と「全部挙げた/何も挙げない」が同じ顔をする)。⟹ 下のテストは
 * すべて、**弾くものと弾いてはいけないものを同じ1回の呼び出しに混ぜ**、返ってきた
 * 集合が厳密に一致することを見る。
 */
describe("parseInitdbArgs", () => {
  it("--encoding= と --locale= の両方を持つ文字列から両方を取り出す", () => {
    expect(parseInitdbArgs("--encoding=SQL_ASCII --locale=C")).toEqual({
      encoding: "SQL_ASCII",
      locale: "C",
    });
  });

  it("--locale= が無ければ locale は undefined(⛔ 無条件に要求しない)", () => {
    expect(parseInitdbArgs("--encoding=UTF8")).toEqual({
      encoding: "UTF8",
      locale: undefined,
    });
  });
});

describe("impliedEncodingForLocale", () => {
  it("locale が undefined(既定ロケール)なら UTF8 を含意する", () => {
    expect(impliedEncodingForLocale(undefined)).toBe("UTF8");
  });

  // 🔴 Issue #395 / ADR 0196: かつてここは「C なら SQL_ASCII を含意する」と書いて
  // いた。**それは誤りだった**——【実測】`--locale=C` は UTF8 / SQL_ASCII / EUC_JP /
  // LATIN1 のいずれとも両立する(initdb は整合検査を掛けない)。
  it("locale が C なら ANY_ENCODING(どの encoding とも両立する)を返す", () => {
    expect(impliedEncodingForLocale("C")).toBe(ANY_ENCODING);
  });

  it("locale が POSIX でも ANY_ENCODING を返す(C と同じ扱い【実測】)", () => {
    expect(impliedEncodingForLocale("POSIX")).toBe(ANY_ENCODING);
  });

  // ⭐ 関数の前提そのものは生きている: C 系**以外**のロケールは特定の encoding を
  // 含意し、食い違う脚で initdb は実際に `encoding mismatch` で落ちる【実測】。
  it("locale が C.utf8 なら UTF8 を含意する(ANY_ENCODING ではない)", () => {
    expect(impliedEncodingForLocale("C.utf8")).toBe("UTF8");
  });

  it("未知のロケールは undefined(『わからない』)を返す(⛔ わかったことにして通さない)", () => {
    expect(impliedEncodingForLocale("en_US.utf8")).toBeUndefined();
  });
});

describe("findInconsistentLegs(陰性対照: 集合の一致で書く)", () => {
  it("自己無矛盾な脚(UTF8/既定ロケール、SQL_ASCII/--locale=C)と、矛盾する脚を混ぜても、矛盾する脚だけを集合で挙げる", () => {
    const legs = [
      // ⭐ 弾いてはいけない側(自己無矛盾)
      { serverEncoding: "UTF8", initdbArgs: "--encoding=UTF8" },
      { serverEncoding: "SQL_ASCII", initdbArgs: "--encoding=SQL_ASCII --locale=C" },
      // ⭐ Issue #395 / ADR 0196: `--locale=C` / `--locale=POSIX` はどの encoding とも
      // 両立する【実測】⟹ **挙げてはいけない。**
      // ⚠ かつてここは Issue #162 E3 相当(「UTF8 脚に --locale=C を足す」)として
      //    **挙げるべき側**に置かれていた。実測で覆った側である。
      {
        serverEncoding: "WAS_E3_UTF8_WITH_LOCALE_C",
        initdbArgs: "--encoding=WAS_E3_UTF8_WITH_LOCALE_C --locale=C",
      },
      { serverEncoding: "LOCALE_POSIX", initdbArgs: "--encoding=LOCALE_POSIX --locale=POSIX" },
      // 🔴 弾くべき側(自己矛盾)
      // Issue #162 E1 相当: --locale=C を落とす(含意 UTF8 ≠ 宣言 SQL_ASCII)
      { serverEncoding: "MUTATED_E1", initdbArgs: "--encoding=MUTATED_E1" },
      // 既知のロケールが特定の encoding を含意する側: C.utf8 は UTF8 を含意する
      // ⟹ 宣言と食い違えば initdb は `encoding mismatch` で落ちる【実測】。
      {
        serverEncoding: "MUTATED_KNOWN_LOCALE",
        initdbArgs: "--encoding=MUTATED_KNOWN_LOCALE --locale=C.utf8",
      },
    ];

    const flaggedNames = new Set(findInconsistentLegs(legs).map((leg) => leg.serverEncoding));

    // 🔴 **挙げた側**の集合が厳密に一致すること。
    expect(flaggedNames).toEqual(new Set(["MUTATED_E1", "MUTATED_KNOWN_LOCALE"]));

    // ⭐ **挙げなかった側(補集合)**も厳密に一致すること。
    // ⛔ 片側だけだと「全部挙げる」実装を捕まえ損ねる余地が残る(この入力では
    // 片側の一致だけでも十分だが、**両向きを書くことを形として固定しておく**——
    // 入力が増えたときに片側だけの主張が空回りへ退化するのを防ぐため)。
    // ⛔ 件数(`toBeGreaterThan`)では書かない: 入力が1件でもあれば常に真になる形は、
    // 変異試験でも見つからない(「正しく挙げた」と「空っぽ」が同じ顔をする)。
    const notFlaggedNames = new Set(
      legs.map((leg) => leg.serverEncoding).filter((name) => !flaggedNames.has(name)),
    );
    expect(notFlaggedNames).toEqual(
      new Set(["UTF8", "SQL_ASCII", "WAS_E3_UTF8_WITH_LOCALE_C", "LOCALE_POSIX"]),
    );
  });

  it("未知のロケール(Issue #162 E2 相当)は、既知のロケールを持つ脚と混ぜても単独で挙げる", () => {
    const legs = [
      // ⭐ 弾いてはいけない側
      { serverEncoding: "SQL_ASCII", initdbArgs: "--encoding=SQL_ASCII --locale=C" },
      // 🔴 弾くべき側: --locale=en_US.utf8 は表に無い(未知)
      { serverEncoding: "MUTATED_E2", initdbArgs: "--encoding=MUTATED_E2 --locale=en_US.utf8" },
    ];

    const flaggedNames = new Set(findInconsistentLegs(legs).map((leg) => leg.serverEncoding));

    expect(flaggedNames).toEqual(new Set(["MUTATED_E2"]));
    expect(
      new Set(legs.map((leg) => leg.serverEncoding).filter((name) => !flaggedNames.has(name))),
    ).toEqual(new Set(["SQL_ASCII"]));
  });

  it("空配列を渡せば何も挙げない(⚠ これ単独は陰性対照として数えない。空=空の主張でしかない)", () => {
    expect(findInconsistentLegs([])).toEqual([]);
  });
});
