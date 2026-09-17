import { describe, expect, it } from "vitest";
import {
  addedLineNumbers,
  parseAdrFilename,
  pickNextFreeNumber,
  planRenumbering,
  renumberedReferenceWarning,
  rewriteReferencesInText,
} from "../adr-renumber-lib.mjs";

/**
 * `scripts/adr-renumber-lib.mjs`（採番を「マージ直前」に確定させる設計の純関数側）
 * の歯（Issue #295、ADR 0179）。
 *
 * このファイルは実際の `docs/decisions/` を1バイトも読まない——合成データだけで
 * 検査する。既存の173本の ADR を動かさないことは、CLI 側
 * （`scripts/adr-renumber.mjs`）が「このブランチが追加したファイルだけ」を
 * 対象にする設計そのもので担保しており、ここでは対象にしない。
 */

describe("parseAdrFilename", () => {
  it("4桁番号 + slug + .md を分解する", () => {
    expect(parseAdrFilename("0146-recall-association-unprompted.md")).toEqual({
      number: "0146",
      slug: "recall-association-unprompted",
    });
  });

  it("ADR ファイルの形でなければ null", () => {
    expect(parseAdrFilename("README.md")).toBeNull();
    expect(parseAdrFilename("notes.txt")).toBeNull();
  });
});

describe("pickNextFreeNumber", () => {
  it("空集合なら 0001", () => {
    expect(pickNextFreeNumber([])).toBe("0001");
  });

  it("最大値 + 1 を返す（欠番を埋めには行かない）", () => {
    expect(pickNextFreeNumber(["0001", "0005", "0173"])).toBe("0174");
  });

  it("最大値+1 も使用済みなら、その次の空きまで進む", () => {
    expect(pickNextFreeNumber(["0173", "0174", "0175"])).toBe("0176");
  });
});

describe("planRenumbering — 衝突なし", () => {
  it("origin/main に無い番号は変更しない", () => {
    const plan = planRenumbering(["0001", "0002"], [{ filename: "0003-new-thing.md" }]);
    expect(plan).toEqual([
      {
        oldFilename: "0003-new-thing.md",
        oldNumber: "0003",
        newNumber: "0003",
        newFilename: "0003-new-thing.md",
        slug: "new-thing",
        renamed: false,
      },
    ]);
  });

  it("空振り防止: 追加ファイルが無ければ空配列", () => {
    expect(planRenumbering(["0001"], [])).toEqual([]);
  });
});

describe("planRenumbering — 衝突あり", () => {
  it("origin/main で既に使われている番号は、次の空き番号へ付け替える", () => {
    const mainNumbers = ["0001", "0002", "0173"];
    const plan = planRenumbering(mainNumbers, [{ filename: "0173-recall-footprint-estimator.md" }]);
    expect(plan).toEqual([
      {
        oldFilename: "0173-recall-footprint-estimator.md",
        oldNumber: "0173",
        newNumber: "0174",
        newFilename: "0174-recall-footprint-estimator.md",
        slug: "recall-footprint-estimator",
        renamed: true,
      },
    ]);
  });

  it("同じブランチが追加した複数の ADR が衝突しても、互いに重複しない番号へ割り当てる", () => {
    const mainNumbers = ["0173"];
    const plan = planRenumbering(mainNumbers, [
      { filename: "0173-a.md" },
      { filename: "0173-b.md" },
    ]);
    expect(plan.map((p) => p.newNumber)).toEqual(["0174", "0175"]);
    expect(plan.map((p) => p.renamed)).toEqual([true, true]);
  });

  it("一部だけ衝突する場合、衝突していないファイルは変更しない", () => {
    const mainNumbers = ["0173"];
    const plan = planRenumbering(mainNumbers, [
      { filename: "0173-conflicts.md" },
      { filename: "0180-no-conflict.md" },
    ]);
    const conflicting = plan.find((p) => p.oldFilename === "0173-conflicts.md");
    const clean = plan.find((p) => p.oldFilename === "0180-no-conflict.md");
    expect(conflicting.renamed).toBe(true);
    expect(conflicting.newNumber).toBe("0174");
    expect(clean.renamed).toBe(false);
    expect(clean.newNumber).toBe("0180");
  });

  it("ADR ファイルの形にマッチしない追加ファイルは例外を投げる", () => {
    expect(() => planRenumbering(["0001"], [{ filename: "not-an-adr.md" }])).toThrow(
      /ADR ファイル名の形/,
    );
  });
});

describe("rewriteReferencesInText — 正しい形だけを拾う", () => {
  const renames = [{ oldNumber: "0146", newNumber: "0150", slug: "recall-association-unprompted" }];

  it("markdown リンク中のファイル名 stem を書き換える", () => {
    const text = "[ADR 0146](./0146-recall-association-unprompted.md) を見ること。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe("[ADR 0150](./0150-recall-association-unprompted.md) を見ること。");
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "stem", oldNumber: "0146", newNumber: "0150", count: 1 }),
        expect.objectContaining({
          type: "adr-mention",
          oldNumber: "0146",
          newNumber: "0150",
          count: 1,
        }),
      ]),
    );
  });

  it("見出し行（1行目の `# ADR NNNN: ...`）の番号も書き換える", () => {
    const text = "# ADR 0146: 連想枠を実装する\n\n本文。";
    const { text: result } = rewriteReferencesInText(text, renames);
    expect(result).toBe("# ADR 0150: 連想枠を実装する\n\n本文。");
  });

  it("コード内の参照（パス文字列）も書き換える", () => {
    const text = 'const path = "docs/decisions/0146-recall-association-unprompted.md";';
    const { text: result } = rewriteReferencesInText(text, renames);
    expect(result).toBe('const path = "docs/decisions/0150-recall-association-unprompted.md";');
  });

  it("裸の4桁数字は巻き込まない（ADR接頭辞も stem 形も無いもの）", () => {
    const text = "2026年、issue 0146 は関係ない番号として登場する（日付でも起票番号でもない）。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("似た別の slug を持つ同じ番号は誤って巻き込まない（stem の右側境界）", () => {
    const text = "0146-recall-association-unprompted-extended.md は別ファイルである。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("後ろにもっと長い数字が続く場合は ADR 表記として巻き込まない（右側境界）", () => {
    const text = "ADR 01460 は別の ADR である。";
    const { text: result, changes } = rewriteReferencesInText(text, renames);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("oldNumber === newNumber（衝突していない）なら何もしない", () => {
    const text = "ADR 0173 と docs/decisions/0173-x.md を参照。";
    const { text: result, changes } = rewriteReferencesInText(text, [
      { oldNumber: "0173", newNumber: "0173", slug: "x" },
    ]);
    expect(result).toBe(text);
    expect(changes).toEqual([]);
  });

  it("空振り防止: 何も変わらないケースで changes が空であることを確認できる", () => {
    const { changes } = rewriteReferencesInText("何の関係も無い本文。", renames);
    expect(changes).toEqual([]);
  });
});

describe("addedLineNumbers — origin/main から継承した行を巻き込まないための境界", () => {
  it("新規ファイルの追加（全行が +）は、全行番号を返す", () => {
    const diff = ["@@ -0,0 +1,3 @@", "+line1", "+line2", "+line3"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([1, 2, 3]));
  });

  it("既存ファイルへの1行挿入は、その行番号だけを返す（前後の既存行は含まない）", () => {
    // 元ファイルは3行、2行目の直後に1行挿入した想定（--unified=0 はコンテキストを持たない）。
    const diff = ["@@ -2,0 +3 @@", "+inserted"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([3]));
  });

  it("削除だけのハンクは、追加行を含まない", () => {
    const diff = ["@@ -5,2 +4,0 @@", "-removed1", "-removed2"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set());
  });

  it("差分が無い（空文字列）なら空集合 — origin/main と同一のファイルは書き換え対象にならない", () => {
    expect(addedLineNumbers("")).toEqual(new Set());
  });

  it("複数ハンクにまたがる追加行を両方とも拾う", () => {
    const diff = ["@@ -1,0 +2 @@", "+a", "@@ -10,0 +12,2 @@", "+b", "+c"].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([2, 12, 13]));
  });

  it("応用: origin/main 由来の行に同居する衝突番号の言及は、追加行番号に含まれないので書き換え対象から外れる", () => {
    // 1行目は origin/main から継承（変更なし）、2行目だけこのブランチが追加した想定。
    const diff = ["@@ -1,0 +2 @@", "+新しい行に ADR 0146 への言及がある"].join("\n");
    const added = addedLineNumbers(diff);
    expect(added.has(1)).toBe(false); // 継承した1行目は対象外
    expect(added.has(2)).toBe(true); // このブランチが足した2行目だけが対象
  });
});

describe("renumberedReferenceWarning — 付け替えたときだけ PR タイトル・本文の警告を出す（Issue #405、本文への拡張はこの PR）", () => {
  it("付け替えが無い（空配列）なら null——毎回出ると読み飛ばされるため出さない", () => {
    expect(renumberedReferenceWarning([])).toBeNull();
  });

  it("undefined/null を渡しても null（呼び出し側の防御）", () => {
    expect(renumberedReferenceWarning(undefined)).toBeNull();
    expect(renumberedReferenceWarning(null)).toBeNull();
  });

  it("1件付け替えたら、旧番号->新番号と gh pr edit の使い方（タイトルと本文の両方）を含む警告を返す", () => {
    const warning = renumberedReferenceWarning([{ oldNumber: "0192", newNumber: "0193" }]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("ADR 0192 -> ADR 0193");
    expect(warning).toContain("PR タイトル");
    expect(warning).toContain("本文");
    expect(warning).toContain("squash commit");
    expect(warning).toContain("gh pr edit <PR番号> --title");
    expect(warning).toContain("--body");
  });

  it("複数件付け替えたら、両方の旧番号->新番号を列挙する", () => {
    const warning = renumberedReferenceWarning([
      { oldNumber: "0173", newNumber: "0174" },
      { oldNumber: "0173", newNumber: "0175" },
    ]);
    expect(warning).toContain("ADR 0173 -> ADR 0174");
    expect(warning).toContain("ADR 0173 -> ADR 0175");
  });

  it("⛔ gh を呼べという指示は含むが、この関数自身は gh を実行しない（文字列を返すだけ）", () => {
    // 純関数であることの確認——副作用が無いことは型シグネチャからも自明だが、
    // 「文字列を組み立てるだけ」であることをここでも明示する。
    const warning = renumberedReferenceWarning([{ oldNumber: "0001", newNumber: "0002" }]);
    expect(typeof warning).toBe("string");
  });

  it("scripts/check-pr-adr-reference.mjs が CI で本文も検査することを警告文が指す", () => {
    const warning = renumberedReferenceWarning([{ oldNumber: "0199", newNumber: "0200" }]);
    expect(warning).toContain("check-pr-adr-reference.mjs");
  });
});
