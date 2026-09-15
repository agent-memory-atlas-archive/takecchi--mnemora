import { describe, expect, it } from "vitest";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";

/**
 * `correction-scenario.ts` の構造的な整合性の歯（Issue #303）。
 *
 * `contestedPair` は「呼び出し側が既に下した決定」（ADR 0134 決定2）——このファイル自身が
 * その決定を正しく保持していることを検査する。判定ロジックの正しさ（`markContested` 自体が
 * 正しく動くか）ではなく、**宣言が自己矛盾していないか**を見る。
 */
describe("CORRECTION_SCENARIO: 構造の整合性", () => {
  it("original/correction の externalId は異なる", () => {
    expect(CORRECTION_SCENARIO.original.externalId).not.toBe(
      CORRECTION_SCENARIO.correction.externalId,
    );
  });

  it("original/correction のテキストは異なる(訂正なので内容が変わっているはず)", () => {
    expect(CORRECTION_SCENARIO.original.text).not.toBe(CORRECTION_SCENARIO.correction.text);
  });

  it("contestedPair.first/secondExternalId は original/correction の externalId の組と一致する(順不同)", () => {
    const declared = [
      CORRECTION_SCENARIO.contestedPair.firstExternalId,
      CORRECTION_SCENARIO.contestedPair.secondExternalId,
    ].sort();
    const actual = [
      CORRECTION_SCENARIO.original.externalId,
      CORRECTION_SCENARIO.correction.externalId,
    ].sort();
    expect(declared).toEqual(actual);
  });

  it("contestedPair.winnerExternalId は original/correction のどちらかを指す", () => {
    expect([
      CORRECTION_SCENARIO.original.externalId,
      CORRECTION_SCENARIO.correction.externalId,
    ]).toContain(CORRECTION_SCENARIO.contestedPair.winnerExternalId);
  });

  it("既定の宣言では correction が勝者である(このシナリオの意図——訂正が正しいとして解決する)", () => {
    expect(CORRECTION_SCENARIO.contestedPair.winnerExternalId).toBe(
      CORRECTION_SCENARIO.correction.externalId,
    );
  });

  it("turns に original.text と correction.text の両方が現れる", () => {
    const texts = CORRECTION_SCENARIO.turns.map((t) => t.text);
    expect(texts).toContain(CORRECTION_SCENARIO.original.text);
    expect(texts).toContain(CORRECTION_SCENARIO.correction.text);
  });

  it("turns 内で original.text が correction.text より先に現れる(会話としての自然な順序)", () => {
    const texts = CORRECTION_SCENARIO.turns.map((t) => t.text);
    const originalIndex = texts.indexOf(CORRECTION_SCENARIO.original.text);
    const correctionIndex = texts.indexOf(CORRECTION_SCENARIO.correction.text);
    expect(originalIndex).toBeGreaterThanOrEqual(0);
    expect(correctionIndex).toBeGreaterThan(originalIndex);
  });

  it("turn の index は 0 始まりの連番", () => {
    CORRECTION_SCENARIO.turns.forEach((turn, i) => {
      expect(turn.index).toBe(i);
    });
  });

  it("query は空でない", () => {
    expect(CORRECTION_SCENARIO.query.length).toBeGreaterThan(0);
  });
});
