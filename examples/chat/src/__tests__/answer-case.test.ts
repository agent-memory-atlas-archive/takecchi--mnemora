import { describe, expect, it } from "vitest";
import type { AnswerCase, AnswerCategory } from "../answer-case.js";
import {
  answerQualityClaimable,
  assertGroundsPresent,
  gradeAnswer,
  normalizeForGrading,
} from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";

/**
 * `answer-case.ts` の採点関数・仕掛けの単体試験。**DB 不要・鍵不要**——
 * `gradeAnswer`/`normalizeForGrading`/`answerQualityClaimable`/`assertGroundsPresent` は
 * すべて純関数である。
 */

describe("normalizeForGrading", () => {
  it("NFKC正規化・小文字化・空白/句読点の除去を行う", () => {
    expect(normalizeForGrading("紅茶")).toBe("紅茶");
    expect(normalizeForGrading("Ｈｅｌｌｏ")).toBe("hello"); // 全角英字 → NFKC → 半角 → 小文字
    expect(normalizeForGrading("水曜ですが、もとは金曜でした。")).toBe(
      "水曜ですがもとは金曜でした",
    );
    expect(normalizeForGrading("  分かりません  ")).toBe("分かりません");
    expect(normalizeForGrading("「紅茶」です!")).toBe("紅茶です");
  });

  it("句読点だけの入力は空文字になる", () => {
    expect(normalizeForGrading("。、！？")).toBe("");
  });
});

describe("gradeAnswer", () => {
  const expected = { kind: "closed-value" as const, accept: ["水曜"], reject: ["金曜"] };

  it("空文字・空白のみの回答は indeterminate", () => {
    expect(gradeAnswer("", expected)).toBe("indeterminate");
    expect(gradeAnswer("   ", expected)).toBe("indeterminate");
    expect(gradeAnswer("\n\t", expected)).toBe("indeterminate");
  });

  it("reject を含めば fail（accept も含んでいても fail が勝つ）", () => {
    expect(gradeAnswer("水曜ですが、もとは金曜でした。", expected)).toBe("fail");
  });

  it("accept のみ含めば pass", () => {
    expect(gradeAnswer("水曜日です。", expected)).toBe("pass");
  });

  it("accept も reject も含まなければ fail", () => {
    expect(gradeAnswer("火曜日です。", expected)).toBe("fail");
  });

  it("reject を accept より先に判定する（順序の固定）", () => {
    // reject 側だけを含む場合と、両方含む場合とで結果が変わらないことを確認する
    // ——「reject を先に見る」という判定順序そのものを歯にする。
    expect(gradeAnswer("金曜でした。", expected)).toBe("fail");
    expect(gradeAnswer("水曜ですが金曜でした。", expected)).toBe("fail");
  });

  it("must-abstain: 表明の表現を accept、捏造されうる具体値を reject に置いた場合", () => {
    const mustAbstain = {
      kind: "must-abstain" as const,
      accept: ["分かりません", "知りません"],
      reject: ["A型", "B型"],
    };
    expect(gradeAnswer("分かりません。", mustAbstain)).toBe("pass");
    expect(gradeAnswer("A型です。", mustAbstain)).toBe("fail");
    expect(gradeAnswer("さあ、どうでしょうね。", mustAbstain)).toBe("fail");
  });
});

describe("answerQualityClaimable", () => {
  it("deterministic のときだけ false", () => {
    expect(answerQualityClaimable("deterministic")).toBe(false);
    expect(answerQualityClaimable("recorded")).toBe(true);
    expect(answerQualityClaimable("openai")).toBe(true);
    expect(answerQualityClaimable("local")).toBe(true);
  });
});

describe("assertGroundsPresent", () => {
  function makeCase(overrides: Partial<AnswerCase> = {}): AnswerCase {
    return {
      id: "x",
      category: "preference",
      conversation: [{ role: "user", text: "t" }],
      question: "q",
      expected: { kind: "closed-value", accept: ["a"], reject: ["b"] },
      grounds: { turnIndex: [0], rationale: "r" },
      tuningUse: "development",
      ...overrides,
    };
  }

  it("unknown 以外で turnIndex が空なら例外", () => {
    expect(() =>
      assertGroundsPresent(
        makeCase({ category: "preference", grounds: { turnIndex: [], rationale: "r" } }),
      ),
    ).toThrow();
  });

  it("unknown で turnIndex が空でも例外にならない", () => {
    expect(() =>
      assertGroundsPresent(
        makeCase({ category: "unknown", grounds: { turnIndex: [], rationale: "r" } }),
      ),
    ).not.toThrow();
  });

  it("turnIndex が非空なら category を問わず例外にならない", () => {
    expect(() =>
      assertGroundsPresent(
        makeCase({ category: "unknown", grounds: { turnIndex: [0], rationale: "r" } }),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ケース集合そのものの検査（生成していない・規約を満たしているか）
// ---------------------------------------------------------------------------

const ALL_CATEGORIES: AnswerCategory[] = [
  "preference",
  "schedule-change",
  "negation",
  "other-person",
  "other-period",
  "unknown",
];

describe.each([
  ["dev", ANSWER_CASE_SET_DEV, "development"] as const,
  ["eval", ANSWER_CASE_SET_EVAL, "held-out"] as const,
])("answer-case-set.%s.ts", (_label, cases, expectedTuningUse) => {
  it(`最低6件、6類すべてを含む`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    const categories = new Set(cases.map((c) => c.category));
    for (const category of ALL_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
  });

  it(`全件 tuningUse === "${expectedTuningUse}"`, () => {
    for (const c of cases) {
      expect(c.tuningUse).toBe(expectedTuningUse);
    }
  });

  it("全件 6〜12ターン", () => {
    for (const c of cases) {
      expect(c.conversation.length).toBeGreaterThanOrEqual(6);
      expect(c.conversation.length).toBeLessThanOrEqual(12);
    }
  });

  it("全件 assertGroundsPresent を通る（unknown 以外は turnIndex が空でない）", () => {
    for (const c of cases) {
      expect(() => assertGroundsPresent(c)).not.toThrow();
    }
  });

  it("id が重複しない", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("closed-value は accept が非空、must-abstain は accept/reject が非空", () => {
    for (const c of cases) {
      if (c.expected.kind === "closed-value") {
        expect(c.expected.accept.length).toBeGreaterThan(0);
      } else {
        expect(c.expected.accept.length).toBeGreaterThan(0);
        expect(c.expected.reject.length).toBeGreaterThan(0);
      }
    }
  });
});
