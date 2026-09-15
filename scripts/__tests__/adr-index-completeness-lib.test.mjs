import { describe, expect, it } from "vitest";
import {
  findBrokenIndexLinks,
  findMissingIndexRows,
  findOrphanIndexRows,
  parseAdrFilenames,
  parseIndexRows,
} from "../adr-index-completeness-lib.mjs";

/**
 * `scripts/adr-index-completeness-lib.mjs`（集合演算そのもの）の歯。
 *
 * ⚠ このファイルは実際の `docs/decisions/` を1バイトも読まない。実ファイルへの
 * 配線は `adr-index-completeness.test.mjs` が見る（`ci-yml-*-wiring.test.mjs` と
 * `initdb-args-lib.test.mjs` の役割分担と同じ）。
 *
 * 🔴 陰性対照は「件数」ではなく「集合の一致」で書く（`initdb-args-lib.test.mjs` と
 * 同じ方針）——弾くものと弾いてはいけないものを同じ入力に混ぜ、返ってきた配列が
 * 厳密に一致することを見る。
 */

describe("parseAdrFilenames", () => {
  it("4桁番号+ハイフン区切りslug+.md の形だけを拾い、番号→ファイル名の Map を返す", () => {
    const result = parseAdrFilenames([
      "0001-orm-drizzle.md",
      "0128-adr-index-completeness-tooth.md",
      "README.md",
    ]);
    expect(result).toEqual(
      new Map([
        ["0001", "0001-orm-drizzle.md"],
        ["0128", "0128-adr-index-completeness-tooth.md"],
      ]),
    );
  });

  it("README.md 以外の非ADR名（テンプレート等を想定）も同じ理由で無視する", () => {
    const result = parseAdrFilenames(["TEMPLATE.md", "0001-orm-drizzle.md", "notes.txt"]);
    expect(result).toEqual(new Map([["0001", "0001-orm-drizzle.md"]]));
  });

  it("欠番の穴は、ファイルが存在しない限りこの関数の出力に一切現れない", () => {
    // 0080/0116 のような欠番は「ファイルが無い番号」であり、この関数へ
    // 渡すファイル名リストにそもそも含まれない。よって戻り値にも含まれない
    // ——「連番であること」を検査する余地自体がここに無いことを直接示す。
    const result = parseAdrFilenames([
      "0079-requeue-embed-jobs.md",
      "0081-similarity-is-the-only-term-that-ranks.md",
    ]);
    expect([...result.keys()]).toEqual(["0079", "0081"]);
  });
});

describe("parseIndexRows", () => {
  it("番号・リンク先ファイル名・行番号を取り出す。ヘッダ行/区切り行は無視する", () => {
    const readme = [
      "# Architecture Decision Records",
      "",
      "| 番号 | 題 | 状態 |",
      "| --- | --- | --- |",
      "| [0001](./0001-orm-drizzle.md) | ORM は Drizzle | 採用 (2026-09) |",
      "| [0128](./0128-adr-index-completeness-tooth.md) | 索引の完全性 | 採用 (2026-09) |",
    ].join("\n");
    expect(parseIndexRows(readme)).toEqual([
      { number: "0001", linkedFile: "0001-orm-drizzle.md", line: 5 },
      { number: "0128", linkedFile: "0128-adr-index-completeness-tooth.md", line: 6 },
    ]);
  });

  it("表以外の場所に現れる [NNNN](...) 形の文字列は行頭アンカーで除外する", () => {
    const readme = [
      "| [0001](./0001-orm-drizzle.md) | 本文中に [0002](./0002-x.md) への言及がある行 | 採用 |",
      "地の文にある [0099](./0099-x.md) は行頭が `|` ではないので拾わない",
    ].join("\n");
    expect(parseIndexRows(readme)).toEqual([
      {
        number: "0001",
        linkedFile: "0001-orm-drizzle.md",
        line: 1,
      },
    ]);
  });
});

describe("findMissingIndexRows（穴 = ファイルに在って索引に無い）", () => {
  it("索引に行が無い番号を、名指しで・番号の昇順に返す", () => {
    const fileNumbers = parseAdrFilenames(["0001-a.md", "0002-b.md", "0003-c.md"]);
    const indexRows = parseIndexRows(
      ["| [0001](./0001-a.md) | a | 採用 |", "| [0003](./0003-c.md) | c | 採用 |"].join("\n"),
    );
    expect(findMissingIndexRows(fileNumbers, indexRows)).toEqual([
      { number: "0002", filename: "0002-b.md" },
    ]);
  });

  it("欠番（0080/0116 を模した番号の不在）を穴として報告しない", () => {
    // ファイル側に 0079 と 0081 だけが在り、0080 のファイルは無い
    // （欠番を模している）。0080 は「ファイルに在って索引に無い」の対象では
    // ないので missing に現れてはいけない。
    const fileNumbers = parseAdrFilenames(["0079-a.md", "0081-b.md"]);
    const indexRows = parseIndexRows(
      ["| [0079](./0079-a.md) | a | 採用 |", "| [0081](./0081-b.md) | b | 採用 |"].join("\n"),
    );
    expect(findMissingIndexRows(fileNumbers, indexRows)).toEqual([]);
  });

  it("全部一致していれば空配列（陰性対照）", () => {
    const fileNumbers = parseAdrFilenames(["0001-a.md"]);
    const indexRows = parseIndexRows("| [0001](./0001-a.md) | a | 採用 |");
    expect(findMissingIndexRows(fileNumbers, indexRows)).toEqual([]);
  });
});

describe("findOrphanIndexRows（索引に在ってファイルの無い行）", () => {
  it("ファイルの無い番号の行を返す", () => {
    const fileNumbers = parseAdrFilenames(["0001-a.md"]);
    const indexRows = parseIndexRows(
      ["| [0001](./0001-a.md) | a | 採用 |", "| [0002](./0002-b.md) | b | 採用 |"].join("\n"),
    );
    expect(findOrphanIndexRows(fileNumbers, indexRows)).toEqual([
      { number: "0002", linkedFile: "0002-b.md", line: 2 },
    ]);
  });

  it("全部一致していれば空配列（陰性対照）", () => {
    const fileNumbers = parseAdrFilenames(["0001-a.md"]);
    const indexRows = parseIndexRows("| [0001](./0001-a.md) | a | 採用 |");
    expect(findOrphanIndexRows(fileNumbers, indexRows)).toEqual([]);
  });
});

describe("findBrokenIndexLinks（番号は一致するがリンク先ファイル名が違う）", () => {
  it("番号は在るがリンク先ファイル名が実ファイルと違う行を返す", () => {
    const fileNumbers = parseAdrFilenames(["0100-supersede-with-new-memories.md"]);
    const indexRows = parseIndexRows("| [0100](./0100-old-slug-name.md) | 題 | 採用 |");
    expect(findBrokenIndexLinks(fileNumbers, indexRows)).toEqual([
      {
        number: "0100",
        linkedFile: "0100-old-slug-name.md",
        line: 1,
        actualFilename: "0100-supersede-with-new-memories.md",
      },
    ]);
  });

  it("ファイル自体が無い番号（orphan）はここでは対象にしない（重複報告しない）", () => {
    const fileNumbers = parseAdrFilenames([]);
    const indexRows = parseIndexRows("| [0999](./0999-nonexistent.md) | 題 | 採用 |");
    expect(findBrokenIndexLinks(fileNumbers, indexRows)).toEqual([]);
  });

  it("リンク先ファイル名が実ファイルと一致していれば空配列（陰性対照）", () => {
    const fileNumbers = parseAdrFilenames(["0001-orm-drizzle.md"]);
    const indexRows = parseIndexRows("| [0001](./0001-orm-drizzle.md) | 題 | 採用 |");
    expect(findBrokenIndexLinks(fileNumbers, indexRows)).toEqual([]);
  });
});
