import { describe, expect, it } from "vitest";
import {
  abandonedNumbers,
  decidePrAdrReferenceCheck,
  findAbandonedReferences,
} from "../check-pr-adr-reference-lib.mjs";

/**
 * `scripts/check-pr-adr-reference-lib.mjs`（PR タイトル・本文が、このブランチ自身が
 * 名乗って自分で捨てた ADR 番号を名指ししていないかを判定する純関数）の歯。
 *
 * このファイルは git を1回も呼ばない——合成データだけで検査する。実際の git 出力からの
 * 分解（パス→4桁番号）は `scripts/check-pr-adr-reference.mjs` 側の責務であり、
 * ここでは対象にしない。
 */

describe("abandonedNumbers", () => {
  it("claimed から added を引いた差分を返す", () => {
    expect(abandonedNumbers(["0199"], ["0200"])).toEqual(["0199"]);
  });

  it("いま追加している番号は捨てた扱いにしない", () => {
    expect(abandonedNumbers(["0199", "0200"], ["0200"])).toEqual(["0199"]);
  });

  it("捨てた番号が無ければ空配列", () => {
    expect(abandonedNumbers(["0200"], ["0200"])).toEqual([]);
  });

  it("一度も名乗っていなければ何も捨てていない（空配列）", () => {
    expect(abandonedNumbers([], ["0200"])).toEqual([]);
  });

  it("重複は除き、最初に現れた順序を保つ", () => {
    expect(abandonedNumbers(["0199", "0173", "0199"], [])).toEqual(["0199", "0173"]);
  });

  it("同じ番号を複数回付け替えても（複数コミットに渡って旧番号が残っても）1件として数える", () => {
    // 0199 -> 0200 と付け替えたあと、さらに 0200 -> 0201 と付け替わった場合、
    // 履歴上は 0199 と 0200 の両方が「touch された」が、いま追加しているのは 0201 だけ。
    expect(abandonedNumbers(["0199", "0200"], ["0201"])).toEqual(["0199", "0200"]);
  });
});

describe("findAbandonedReferences", () => {
  it("`ADR NNNN` 表記を見つける", () => {
    const found = findAbandonedReferences("ルートの test 門を直す（ADR 0209）", ["0209"]);
    expect(found).toEqual([{ number: "0209", form: "adr-mention", count: 1, sample: "ADR 0209" }]);
  });

  it("ファイル名/URL の stem（`NNNN-slug`）を見つける", () => {
    const found = findAbandonedReferences("docs/decisions/0209-something.md を見ること", ["0209"]);
    expect(found).toEqual([{ number: "0209", form: "stem", count: 1, sample: "0209-something" }]);
  });

  it("両方の形が同じテキストに在れば両方見つける", () => {
    const found = findAbandonedReferences("ADR 0209（0209-something.md）", ["0209"]);
    expect(found.map((f) => f.form).sort()).toEqual(["adr-mention", "stem"]);
  });

  it("裸の4桁数字（どちらの形にもマッチしない）は拾わない", () => {
    expect(findAbandonedReferences("2026-09-17 に起きた", ["0917"])).toEqual([]);
    expect(findAbandonedReferences("Issue 0209 を見ること", ["0209"])).toEqual([]);
  });

  it("abandonedNumberList に無い番号は、テキスト中に `ADR NNNN` があっても拾わない", () => {
    // 既存 ADR への正当な参照——この lib の「偽陽性を出さない」性質の核心。
    expect(findAbandonedReferences("ADR 0173 を参照", ["0209"])).toEqual([]);
  });

  it("直後が数字の場合はマッチしない（0209 の中の 020 のような部分一致を防ぐ）", () => {
    expect(findAbandonedReferences("ADR 02091", ["0209"])).toEqual([]);
  });

  it("null/undefined/空文字のテキストでも例外を投げず空配列を返す", () => {
    expect(findAbandonedReferences(null, ["0209"])).toEqual([]);
    expect(findAbandonedReferences(undefined, ["0209"])).toEqual([]);
    expect(findAbandonedReferences("", ["0209"])).toEqual([]);
  });

  it("同じ番号が複数回出現したら count に反映する", () => {
    const found = findAbandonedReferences("ADR 0209 と ADR 0209 の話", ["0209"]);
    expect(found).toEqual([{ number: "0209", form: "adr-mention", count: 2, sample: "ADR 0209" }]);
  });
});

describe("decidePrAdrReferenceCheck", () => {
  it("捨てた番号が無ければ違反も無い", () => {
    const result = decidePrAdrReferenceCheck({
      claimedNumbers: ["0200"],
      addedNumbers: ["0200"],
      prTitle: "ADR 0200 を足す",
      prBody: "本文",
    });
    expect(result.abandonedNumbers).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("タイトルが捨てた番号を名乗っていたら violations に location: title で入る", () => {
    const result = decidePrAdrReferenceCheck({
      claimedNumbers: ["0199"],
      addedNumbers: ["0200"],
      prTitle: "adr-renumber.mjs が付け替えを促す（ADR 0199）",
      prBody: "本文には言及なし",
    });
    expect(result.abandonedNumbers).toEqual(["0199"]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ number: "0199", location: "title" });
  });

  it("本文が捨てた番号を名乗っていたら violations に location: body で入り、出現回数を数える（本件が実際に踏んだ形）", () => {
    // aacb982e の実例: タイトルは直ったが本文6箇所が旧番号のまま残った。
    const result = decidePrAdrReferenceCheck({
      claimedNumbers: ["0199"],
      addedNumbers: ["0200"],
      prTitle: "adr-renumber.mjs が付け替えを促す（ADR 0200）",
      prBody:
        "ADR 0199 を追加した。scripts/__tests__/adr-renumber-lib.test.mjs も ADR 0199 用に足した。",
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ number: "0199", location: "body", count: 2 });
  });

  it("prTitle/prBody が undefined でも例外を投げない", () => {
    const result = decidePrAdrReferenceCheck({
      claimedNumbers: ["0199"],
      addedNumbers: ["0200"],
      prTitle: undefined,
      prBody: undefined,
    });
    expect(result.abandonedNumbers).toEqual(["0199"]);
    expect(result.violations).toEqual([]);
  });

  it("既存 ADR への正当な参照は違反にしない（偽陽性を出さない核心の実例）", () => {
    // このブランチは 0210 だけを名乗って捨てていない。タイトル/本文が既存の
    // ADR 0151 に言及していても、0151 は abandonedNumbers に入らないので無関係。
    const result = decidePrAdrReferenceCheck({
      claimedNumbers: ["0210"],
      addedNumbers: ["0210"],
      prTitle: "連想枠（ADR 0151）を使って測る（ADR 0210）",
      prBody: "ADR 0151 を前提にする。",
    });
    expect(result.abandonedNumbers).toEqual([]);
    expect(result.violations).toEqual([]);
  });
});
