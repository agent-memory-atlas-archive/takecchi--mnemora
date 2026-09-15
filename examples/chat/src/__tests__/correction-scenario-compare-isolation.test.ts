import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import { DEFAULT_COMPARE_SEQUENCE } from "../compare.js";
import { FACT_STATEMENT, QUERY_TEXT, buildConversation } from "../scenario.js";

/**
 * `compare` の⭐門（ADR 0133）への影響を機械的に確かめる歯（Issue #303 受け入れ条件4）。
 *
 * **ADR 0133 の⭐門は `examples/chat/compare-baseline.json` に対する退行検査**——
 * `mnemoraShareOfNaiveChars` の悪化 / `factStatementSurvived` の退行を CI の
 * `example-chat` ジョブが機械的に落とす。この PR は `compare.ts`/`compare-json.ts`/
 * `scenario.ts`/`compare-baseline.json` のいずれも変更していない——⟹ 影響の測り方は
 * 「変えていないことを主張する」ではなく、**変えようがない構造になっていることを検査する**
 * ことにした。
 *
 * この歯が検査するのは3点:
 * 1. `correction-demo.ts`/`correction-scenario.ts` のソースが `compare.ts`/
 *    `compare-json.ts`/`scenario.ts`/`probe-set.ts`/`naive-path.ts` のどれも import して
 *    いない（import グラフに経路が無い＝実行時に影響しようがない）。
 * 2. `compare.ts`/`scenario.ts` のソースが `correction`（大小無視）を1文字も含まない
 *    （逆方向の依存も無い）。
 * 3. `compare` が実測に使う値（`DEFAULT_COMPARE_SEQUENCE`・`FACT_STATEMENT`・`QUERY_TEXT`・
 *    `buildConversation` の出力）が、このシナリオを足す前と同じ値のままである
 *    （このリポジトリでは `compare-baseline.json` が CI 実測値そのものなので、ここでの
 *    「同じ値」は基準値の欄を書き写したものではなく、既存コードの読み取りである）。
 *
 * **⚠ この歯が測っていないこと**: `compare-baseline.json` に対する実際の退行検査そのもの
 * （`DATABASE_URL`/カセットが要り、この作業環境では実行できない——CI の `example-chat`
 * ジョブが、この PR をマージした後も基準値と一致することで確認する）。
 */

function readSourceText(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("correction シナリオは compare の import グラフに入っていない", () => {
  it("correction-demo.ts は compare/scenario/probe-set/naive-path のいずれも import しない", () => {
    const source = readSourceText("../correction-demo.ts");
    for (const forbidden of [
      "./compare.js",
      "./compare-json.js",
      "./scenario.js",
      "./probe-set.js",
      "./naive-path.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("correction-scenario.ts は compare/scenario/probe-set/naive-path のいずれも import しない", () => {
    const source = readSourceText("../correction-scenario.ts");
    for (const forbidden of [
      "./compare.js",
      "./compare-json.js",
      "./scenario.js",
      "./probe-set.js",
      "./naive-path.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("🔴 逆方向の依存も無い: compare.ts / scenario.ts は 'correction' という語を含まない", () => {
    const compareSource = readSourceText("../compare.ts");
    const scenarioSource = readSourceText("../scenario.ts");
    expect(compareSource.toLowerCase()).not.toContain("correction");
    expect(scenarioSource.toLowerCase()).not.toContain("correction");
  });
});

describe("compare が実測に使う値は、このシナリオを足しても変わっていない", () => {
  it("DEFAULT_COMPARE_SEQUENCE は既知の12点のまま(fillerPairs、ADR 0133 の turnCount = 2×(値+1))", () => {
    expect(DEFAULT_COMPARE_SEQUENCE).toEqual([0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320]);
  });

  it("FACT_STATEMENT / QUERY_TEXT は既知の文言のまま", () => {
    expect(FACT_STATEMENT).toBe("私の好きな色は青です。誕生日は4月3日です。");
    expect(QUERY_TEXT).toBe("ところで、わたしの好きな色を覚えていますか?");
  });

  it("buildConversation(2) の出力は既知の形のまま(会話生成関数の構造を変えていない)", () => {
    const conversation = buildConversation(2);
    expect(conversation.turns).toHaveLength(6);
    expect(conversation.turns[0]).toMatchObject({ role: "user", text: FACT_STATEMENT });
    expect(conversation.userUtterances).toHaveLength(3);
  });
});

describe("correction シナリオの externalId は compare/probe-set の externalId と衝突しない", () => {
  it("correction-scenario の externalId は 'correction-demo-' で始まり、他のシナリオの命名空間と重ならない", () => {
    expect(CORRECTION_SCENARIO.original.externalId.startsWith("correction-demo-")).toBe(true);
    expect(CORRECTION_SCENARIO.correction.externalId.startsWith("correction-demo-")).toBe(true);
  });
});
