import { describe, expect, it } from "vitest";
import {
  GENERATED_END_MARKER,
  GENERATED_START_MARKER,
  buildAdrEntries,
  buildIndexTable,
  extractGeneratedIndex,
  extractIndexedNumbers,
  formatStateCell,
  isAdrFilename,
  parseAdrEntry,
  spliceGeneratedIndex,
} from "../generate-adr-index-lib.mjs";

/**
 * `scripts/generate-adr-index-lib.mjs`（生成器の純関数側）の歯（ADR 0137）。
 *
 * ⚠ このファイルは実際の `docs/decisions/` を1バイトも読まない。実ファイルへの
 * 配線は `adr-index-freshness.test.mjs` が見る（ADR 0128 時代の役割分担を踏襲）。
 */

describe("isAdrFilename", () => {
  it("4桁番号+ハイフン区切りslug+.md だけを ADR ファイルとして認める", () => {
    expect(isAdrFilename("0001-orm-drizzle.md")).toBe(true);
    expect(isAdrFilename("README.md")).toBe(false);
    expect(isAdrFilename("TEMPLATE.md")).toBe(false);
    expect(isAdrFilename("notes.txt")).toBe(false);
  });
});

describe("formatStateCell", () => {
  it("採用 + 状態欄に埋め込まれた日付 は無装飾のまま返す", () => {
    expect(formatStateCell("採用 (2026-09)", undefined)).toBe("採用 (2026-09)");
  });

  it("採用以外（未決）は太字にする。全角丸括弧の埋め込み日付も拾う", () => {
    expect(
      formatStateCell("**未決（2026-09）。実測の記録のみ。直し方はオーナーと決める。**", undefined),
    ).toBe("**未決 (2026-09)**");
  });

  it("提案（未採用）— 状態欄に日付が無いときは日付行から補う", () => {
    expect(formatStateCell("**提案（未採用）。オーナーの判断待ち。**", "2026-09-09")).toBe(
      "**提案 (2026-09)**",
    );
  });

  it("状態欄が長い装飾を持っていても、見出し語直後の日付だけを拾う（ADR 0063 相当）", () => {
    const stateText =
      "採用 (2026-09)（**「`hnsw.iterative_scan` を有効にしない」という決定**であり、実装の変更は伴わない。docs のみ）";
    expect(formatStateCell(stateText, undefined)).toBe("採用 (2026-09)");
  });

  it("日付がどこにも無ければ、日付無しのセルを返す（陰性対照）", () => {
    expect(formatStateCell("採用", undefined)).toBe("採用");
    expect(formatStateCell("未決", undefined)).toBe("**未決**");
  });

  it("日付行が YYYY-MM-DD でも先頭7文字だけを使う", () => {
    expect(formatStateCell("採用", "2026-09-06")).toBe("採用 (2026-09)");
  });
});

describe("parseAdrEntry", () => {
  it("見出し・状態欄から番号・題・状態セルを取り出す", () => {
    const content = ["# ADR 0001: ORM は Drizzle", "", "- **状態**: 採用 (2026-09)", ""].join("\n");
    expect(parseAdrEntry("0001-orm-drizzle.md", content)).toEqual({
      number: "0001",
      filename: "0001-orm-drizzle.md",
      title: "ORM は Drizzle",
      stateCell: "採用 (2026-09)",
    });
  });

  it("題に含まれる | はテーブルを壊さないようエスケープする", () => {
    const content = ["# ADR 0002: A | B の話", "", "- **状態**: 採用 (2026-09)"].join("\n");
    expect(parseAdrEntry("0002-a-or-b.md", content).title).toBe("A \\| B の話");
  });

  it("ファイル名が ADR の形にマッチしなければ例外", () => {
    expect(() => parseAdrEntry("README.md", "# ADR 0001: x\n\n- **状態**: 採用")).toThrow();
  });

  it("1行目が見出しの形でなければ例外", () => {
    expect(() => parseAdrEntry("0001-x.md", "not a heading\n\n- **状態**: 採用")).toThrow(
      /1行目が/,
    );
  });

  it("ファイル名の番号と見出しの番号が食い違えば例外（壊れたリンクの発生源を入口で塞ぐ）", () => {
    expect(() => parseAdrEntry("0001-x.md", "# ADR 0002: x\n\n- **状態**: 採用")).toThrow(
      /食い違って/,
    );
  });

  it("状態行が無ければ例外", () => {
    expect(() => parseAdrEntry("0001-x.md", "# ADR 0001: x\n\n本文だけ")).toThrow(/状態/);
  });
});

describe("buildAdrEntries", () => {
  it("ADR らしくないファイル名（README.md 等）は無視し、番号順に並べる", () => {
    const files = [
      { filename: "0002-b.md", content: "# ADR 0002: B\n\n- **状態**: 採用 (2026-09)" },
      { filename: "README.md", content: "# not an adr" },
      { filename: "0001-a.md", content: "# ADR 0001: A\n\n- **状態**: 採用 (2026-09)" },
    ];
    const entries = buildAdrEntries(files);
    expect(entries.map((e) => e.number)).toEqual(["0001", "0002"]);
  });
});

describe("buildIndexTable", () => {
  it("ヘッダ + 区切り + 各行を組み立てる。桁揃えはしない", () => {
    const entries = [
      { number: "0001", filename: "0001-a.md", title: "A", stateCell: "採用 (2026-09)" },
      { number: "0002", filename: "0002-b.md", title: "B", stateCell: "**未決**" },
    ];
    expect(buildIndexTable(entries)).toBe(
      [
        "| 番号 | 題 | 状態 |",
        "| --- | --- | --- |",
        "| [0001](./0001-a.md) | A | 採用 (2026-09) |",
        "| [0002](./0002-b.md) | B | **未決** |",
      ].join("\n"),
    );
  });

  it("0件でもヘッダだけの表を返す（空振り防止の対象は配線側の歯が持つ）", () => {
    expect(buildIndexTable([])).toBe(["| 番号 | 題 | 状態 |", "| --- | --- | --- |"].join("\n"));
  });
});

describe("extractIndexedNumbers", () => {
  it("行頭の [NNNN] だけを拾い、ヘッダ・区切り行は無視する", () => {
    const table = [
      "| 番号 | 題 | 状態 |",
      "| --- | --- | --- |",
      "| [0001](./0001-a.md) | A | 採用 |",
      "| [0128](./0128-b.md) | B | 採用 |",
    ].join("\n");
    expect(extractIndexedNumbers(table)).toEqual(["0001", "0128"]);
  });

  it("表以外の場所に現れる [NNNN](...) は行頭アンカーで除外する", () => {
    const table = "地の文にある [0099](./0099-x.md) は行頭が | ではないので拾わない";
    expect(extractIndexedNumbers(table)).toEqual([]);
  });
});

describe("spliceGeneratedIndex / extractGeneratedIndex", () => {
  const readme = [
    "# Architecture Decision Records",
    "",
    "手書きの説明文。",
    "",
    GENERATED_START_MARKER,
    "古い表",
    GENERATED_END_MARKER,
    "",
    "マーカーの外側にある手書きの結び。",
  ].join("\n");

  it("マーカーの外側を変えず、内側だけを新しい表に置き換える", () => {
    const updated = spliceGeneratedIndex(readme, "新しい表");
    expect(updated).toContain("手書きの説明文。");
    expect(updated).toContain("マーカーの外側にある手書きの結び。");
    expect(updated).not.toContain("古い表");
    expect(extractGeneratedIndex(updated)).toBe("新しい表");
  });

  it("往復（生成 → 抽出）で同じ表が戻る", () => {
    const table = "| 番号 | 題 | 状態 |\n| --- | --- | --- |\n| [0001](./0001-a.md) | A | 採用 |";
    const updated = spliceGeneratedIndex(readme, table);
    expect(extractGeneratedIndex(updated)).toBe(table);
  });

  it("START マーカーが無ければ例外", () => {
    expect(() => spliceGeneratedIndex(`本文のみ\n${GENERATED_END_MARKER}`, "表")).toThrow(
      /マーカーが見つかりません/,
    );
  });

  it("END マーカーが無ければ例外", () => {
    expect(() => spliceGeneratedIndex(`${GENERATED_START_MARKER}\n本文のみ`, "表")).toThrow(
      /マーカーが見つかりません/,
    );
  });

  it("マーカーが2組以上あれば例外", () => {
    const doubled = [readme, GENERATED_START_MARKER, "別の表", GENERATED_END_MARKER].join("\n");
    expect(() => spliceGeneratedIndex(doubled, "表")).toThrow(/2組以上/);
  });
});
