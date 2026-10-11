import { describe, expect, it } from "vitest";
import { decideAnnTruncation } from "../ann-truncation.js";
import type { ScoringStrategy } from "../strategies/scoring.js";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/** 上界の宣言を持たない戦略。**素の関数がそのまま `ScoringStrategy` として通る**ことを使う。 */
const undeclaredStrategy: ScoringStrategy = (input) => ({
  decay: 1,
  tagMatch: 1,
  freshness: 1,
  strength: input.strength,
  total: (input.similarity ?? 1) * input.strength,
});

/**
 * 上界を「宣言できない」と申告する戦略。
 * `Object.assign(undeclaredStrategy, ...)` と書かないこと: 第1引数を書き換えるので、`undeclaredStrategy` 側に宣言が生え、
 * 「機構ごと持たない」ほうの歯が別のものを測ることになる。新しい関数を作ってから生やす。
 */
const refusingStrategy: ScoringStrategy = Object.assign(
  ((input) => undeclaredStrategy(input)) as ScoringStrategy,
  {
    nonSimilarityUpperBound: () => ({
      kind: "undeclared" as const,
      reason: "この戦略は上界を持たない",
    }),
  },
);

const base = {
  strategy: defaultScoringStrategy,
  queryTags: [] as readonly string[],
  scoreThreshold: 0.1,
};

describe("decideAnnTruncation — 3つの状態が別の顔で返る（ADR 0069 の芯）", () => {
  it("沈黙・判定不能・発火は、それぞれ別の kind を返す（同じ値・同じ形にならない）", () => {
    const safe = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });
    const fires = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.5,
      lastReturnedTotal: 0.2,
    });
    const undecidable = decideAnnTruncation({
      ...base,
      strategy: undeclaredStrategy,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });

    expect(safe.kind).toBe("provably_safe");
    expect(fires.kind).toBe("loss_possible");
    expect(undecidable.kind).toBe("undecidable");

    const kinds = new Set([safe.kind, fires.kind, undecidable.kind]);
    expect(kinds.size).toBe(3);

    expect("safetyRatio" in undecidable).toBe(false);
    if (undecidable.kind !== "undecidable") throw new Error("unreachable");
    expect(undecidable.reason.length).toBeGreaterThan(0);
  });

  it("上界を宣言しない戦略は undecidable に落ちる（既定の上界を黙って当てはめない）", () => {
    const v = decideAnnTruncation({
      ...base,
      strategy: undeclaredStrategy,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });
    expect(v.kind).toBe("undecidable");
    if (v.kind !== "undecidable") throw new Error("unreachable");
    expect(v.reason).toContain("nonSimilarityUpperBound");
  });

  it("上界を「宣言できない」と申告した戦略も undecidable に落ちる（申告の理由を運ぶ）", () => {
    const v = decideAnnTruncation({
      ...base,
      strategy: refusingStrategy,
      lastAnnSimilarity: 0.2,
      lastReturnedTotal: 0.5,
    });
    expect(v.kind).toBe("undecidable");
    if (v.kind !== "undecidable") throw new Error("unreachable");
    expect(v.reason).toContain("この戦略は上界を持たない");
  });
});

describe("decideAnnTruncation — R = 1 の境界", () => {
  it("R がちょうど 1 なら provably_safe（等号は安全側）", () => {
    const v = decideAnnTruncation({ ...base, lastAnnSimilarity: 0.4, lastReturnedTotal: 0.4 });
    expect(v.kind).toBe("provably_safe");
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.safetyRatio).toBeCloseTo(1, 12);
  });

  it("R が 1 をわずかに下回れば loss_possible", () => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4 * (1 - 1e-9),
    });
    expect(v.kind).toBe("loss_possible");
  });

  it("R が 1 をわずかに上回れば provably_safe", () => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4 * (1 + 1e-9),
    });
    expect(v.kind).toBe("provably_safe");
  });
});

describe("decideAnnTruncation — M_max はクエリタグ数で動く", () => {
  it("クエリにタグが1つ在ると上界が 1.1 倍になり、同じ入力でも判定が変わる", () => {
    const withoutTags = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4,
    });
    const withTag = decideAnnTruncation({
      ...base,
      queryTags: ["x"],
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: 0.4,
    });
    expect(withoutTags.kind).toBe("provably_safe");
    expect(withTag.kind).toBe("loss_possible");
    if (withTag.kind !== "loss_possible") throw new Error("unreachable");
    expect(withTag.safetyRatio).toBeCloseTo(1 / 1.1, 9);
  });
});

describe("decideAnnTruncation — bar の決め方（limit に満たなかったとき）", () => {
  it("lastReturnedTotal が null なら scoreThreshold を基準にする", () => {
    const v = decideAnnTruncation({
      ...base,
      scoreThreshold: 0.5,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: null,
    });
    expect(v.kind).toBe("provably_safe");
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.safetyRatio).toBeCloseTo(1.25, 9);
  });

  it("閾値が低ければ、limit 未満でも loss_possible になりうる", () => {
    const v = decideAnnTruncation({
      ...base,
      scoreThreshold: 0.1,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: null,
    });
    expect(v.kind).toBe("loss_possible");
  });
});

describe("decideAnnTruncation — 端の入力は黙って握り潰さず undecidable にする", () => {
  it.each([
    ["sim_k' が 0", 0],
    ["sim_k' が負（コサインは負になりうる）", -0.3],
    ["sim_k' が NaN", Number.NaN],
    ["sim_k' が Infinity（非有限）", Number.POSITIVE_INFINITY],
  ])("%s なら undecidable", (_label, sim) => {
    const v = decideAnnTruncation({ ...base, lastAnnSimilarity: sim, lastReturnedTotal: 0.5 });
    expect(v.kind).toBe("undecidable");
  });

  it("bar が NaN（score_not_comparable の領域）なら undecidable", () => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: 0.4,
      lastReturnedTotal: Number.NaN,
    });
    expect(v.kind).toBe("undecidable");
  });
});

/** 上界を `value` で宣言する戦略。`value` の値域の検査だけを測るため、他は何も宣言しない。 */
function declaring(value: number): ScoringStrategy {
  return Object.assign(((input) => undeclaredStrategy(input)) as ScoringStrategy, {
    nonSimilarityUpperBound: () => ({
      kind: "declared" as const,
      value,
      assumptions: [] as readonly string[],
    }),
  });
}

describe("decideAnnTruncation — 宣言された上界 value は正の有限値（NonSimilarityUpperBound の TSDoc）", () => {
  // 他の入力は、上界がまともなら provably_safe か loss_possible に決まる値（sim 0.5、bar 0.2）。
  it.each([
    ["0", 0],
    ["負（-1）", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("value が %s なら undecidable（安全とも損失とも言わない）", (_label, value) => {
    const v = decideAnnTruncation({
      ...base,
      strategy: declaring(value),
      lastAnnSimilarity: 0.5,
      lastReturnedTotal: 0.2,
    });
    expect(v.kind).toBe("undecidable");
  });

  it.each([
    ["0.5", 0.5, 0.5, 0.2, "loss_possible"],
    ["1e-300", 1e-300, 0.5, 1e-300, "provably_safe"],
    ["1e-300（bar が小さければ損失）", 1e-300, 0.5, 1e-301, "loss_possible"],
    // Number.MIN_VALUE は sim を掛けても 0 に潰れないよう sim = 1 にし、bar も MIN_VALUE にして比を 1 に保つ。
    ["Number.MIN_VALUE", Number.MIN_VALUE, 1, Number.MIN_VALUE, "provably_safe"],
    ["Number.MIN_VALUE（bar が 0 なら損失）", Number.MIN_VALUE, 1, 0, "loss_possible"],
  ])("value が %s なら undecidable にせず判定する", (_label, value, sim, bar, kind) => {
    const v = decideAnnTruncation({
      ...base,
      strategy: declaring(value),
      lastAnnSimilarity: sim,
      lastReturnedTotal: bar,
    });
    expect(v.kind).toBe(kind);
  });
});

describe("decideAnnTruncation — safetyRatio は kind の名乗りと食い違わない（AnnTruncationVerdict の TSDoc）", () => {
  // sim と value はどちらも正の有限値だが、積が 0 に潰れる組。
  const tinySim = 1e-200;
  const tinyValue = 1e-200;

  it("前提: この組では分母 sim × value が 0 に潰れる", () => {
    expect(tinySim * tinyValue).toBe(0);
    expect(tinySim).toBeGreaterThan(0);
    expect(tinyValue).toBeGreaterThan(0);
  });

  it.each([
    ["bar が 0（0 / 0）", 0],
    ["bar が正（正 / 0）", 0.5],
    ["bar が負（負 / 0）", -0.5],
  ])(
    "分母が 0 に潰れても、loss_possible なら比は 1 未満、provably_safe なら 1 以上: %s",
    (_label, bar) => {
      const v = decideAnnTruncation({
        ...base,
        strategy: declaring(tinyValue),
        lastAnnSimilarity: tinySim,
        lastReturnedTotal: bar,
      });
      if (v.kind === "loss_possible") {
        expect(v.safetyRatio).toBeLessThan(1);
      }
      if (v.kind === "provably_safe") {
        expect(v.safetyRatio).toBeGreaterThanOrEqual(1);
      }
    },
  );

  // 浮動小数の比が使えなくても、真の比 R = bar / (sim × value) の側は bar の符号で決まる。
  // bar が 0 以下なら R は 0 以下。bar が正なら、bar は Number.MIN_VALUE 以上で、0 に丸まった積は
  // Number.MIN_VALUE / 2 以下なので、R は 2 以上。どちらに決めるか・undecidable に倒すかは縛らない。
  it.each([
    ["bar が 0（真の R は 0）", 0, "provably_safe"],
    ["bar が負（真の R は負）", -0.5, "provably_safe"],
    ["bar が正（真の R は 1 を超える）", 0.5, "loss_possible"],
    ["bar が Number.MIN_VALUE（真の R はなお 1 を超える）", Number.MIN_VALUE, "loss_possible"],
  ])("分母が 0 に潰れても、真の R と逆の kind を名乗らない: %s", (_label, bar, contradicting) => {
    const v = decideAnnTruncation({
      ...base,
      strategy: declaring(tinyValue),
      lastAnnSimilarity: tinySim,
      lastReturnedTotal: bar,
    });
    expect(v.kind).not.toBe(contradicting);
  });

  it("やりすぎ: 比が大きくても有限なら undecidable にせず provably_safe と判定する", () => {
    const sim = 1e-300;
    const bar = 1;
    const expected = bar / (sim * 1);
    expect(Number.isFinite(expected)).toBe(true);

    const v = decideAnnTruncation({
      ...base,
      strategy: declaring(1),
      lastAnnSimilarity: sim,
      lastReturnedTotal: bar,
    });
    expect(v.kind).toBe("provably_safe");
    if (v.kind !== "provably_safe") throw new Error("unreachable");
    expect(v.safetyRatio).toBe(expected);
  });
});

describe("decideAnnTruncation — safetyRatio は有限（AnnTruncatedOmission の出力スキーマ）", () => {
  // `ann_truncated.safetyRatio` の出力スキーマは `z.number()` で、zod 4 では ±Infinity を通さない。
  // 比が有限に収まらない入力で、どの kind に倒すかは縛らない。safetyRatio を載せるなら有限であることだけを見る。
  it.each([
    ["分母が 0 に潰れ、bar が 0", 0, 1e-200, 1e-200],
    ["分母が 0 に潰れ、bar が正（正 / 0 は Infinity）", 0.5, 1e-200, 1e-200],
    ["分母が 0 に潰れ、bar が負（負 / 0 は -Infinity）", -0.5, 1e-200, 1e-200],
    ["分母が 0 に潰れ、bar が Number.MIN_VALUE", Number.MIN_VALUE, 1e-200, 1e-200],
    ["比が上に桁あふれする", 1e300, 1e-10, 1],
    ["比が下に桁あふれする（負）", -1e300, 1e-10, 1],
  ])("比が有限に収まらなくても、safetyRatio を載せるなら有限: %s", (_label, bar, sim, value) => {
    const v = decideAnnTruncation({
      ...base,
      strategy: declaring(value),
      lastAnnSimilarity: sim,
      lastReturnedTotal: bar,
    });
    if (v.kind !== "undecidable") {
      expect(Number.isFinite(v.safetyRatio)).toBe(true);
    }
  });

  it.each([
    ["Number.MAX_VALUE", Number.MAX_VALUE, "provably_safe"],
    ["-Number.MAX_VALUE", -Number.MAX_VALUE, "loss_possible"],
  ])(
    "やりすぎ: 比が %s でも有限なら undecidable にせず判定し、比をそのまま載せる",
    (_label, bar, kind) => {
      const v = decideAnnTruncation({
        ...base,
        strategy: declaring(1),
        lastAnnSimilarity: 1,
        lastReturnedTotal: bar,
      });
      expect(v.kind).toBe(kind);
      if (v.kind === "undecidable") throw new Error("unreachable");
      expect(v.safetyRatio).toBe(bar);
    },
  );
});

describe("decideAnnTruncation — 前提を戻り値で名乗る（ADR 0069 §6）", () => {
  // 🔴 **コメントは検査されない。**だから前提は戻り値に載せ、その中身をここで測る。
  it.each([
    ["provably_safe", 0.2, 0.5],
    ["loss_possible", 0.5, 0.2],
  ])("%s のとき assumptions が decay と strength の前提を名乗る", (kind, sim, total) => {
    const v = decideAnnTruncation({
      ...base,
      lastAnnSimilarity: sim,
      lastReturnedTotal: total,
    });
    expect(v.kind).toBe(kind);
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.assumptions.length).toBeGreaterThan(0);
    const joined = v.assumptions.join(" ");
    expect(joined).toContain("decay");
    expect(joined).toContain("strength");
    expect(joined).toContain("clamp");
  });
});

/** ADR 0069 §5 の実測値（`examples/chat/cassettes/retrieval.json`、スコープ75件・k'=40 の `sim@10` と `sim@40`）を固定する。判定式の振る舞いを測るもので、埋め込みの質ではない。数字だけ書き換えて通さないこと。 */
const PROBE_SIMILARITIES: readonly { id: string; sim10: number; sim40: number }[] = [
  { id: "color", sim10: 0.244646, sim40: 0.168179 },
  { id: "pet", sim10: 0.278239, sim40: 0.192306 },
  { id: "exercise", sim10: 0.222407, sim40: 0.172327 },
  { id: "diet", sim10: 0.182948, sim40: 0.097257 },
  { id: "family", sim10: 0.184681, sim40: 0.101286 },
  { id: "language", sim10: 0.146188, sim40: 0.076399 },
  { id: "travel", sim10: 0.230617, sim40: 0.148676 },
];

describe("decideAnnTruncation — ADR 0069 §5 の実測値（retrieval ベンチの 7 probe）", () => {
  it.each(PROBE_SIMILARITIES)("$id: いまの世界（4項が定数）では沈黙する", ({ sim10, sim40 }) => {
    const v = decideAnnTruncation({ ...base, lastAnnSimilarity: sim40, lastReturnedTotal: sim10 });
    expect(v.kind).toBe("provably_safe");
    if (v.kind === "undecidable") throw new Error("unreachable");
    expect(v.safetyRatio).toBeGreaterThanOrEqual(1);
  });

  it.each(PROBE_SIMILARITIES)(
    "$id: occurredAt が入って freshness が 0.5 まで落ちうる世界では鳴る",
    ({ sim10, sim40 }) => {
      // 窓の外の候補は未来の occurredAt を持ちうるので上界は 1.0 のまま（ADR 0036 の clamp）。
      const v = decideAnnTruncation({
        ...base,
        lastAnnSimilarity: sim40,
        lastReturnedTotal: sim10 * 0.5,
      });
      expect(v.kind).toBe("loss_possible");
      if (v.kind !== "loss_possible") throw new Error("unreachable");
      expect(v.safetyRatio).toBeLessThan(1);
    },
  );

  it("7 probe すべてが同じ向きに動く（沈黙 7/7 → 発火 7/7）", () => {
    const silent = PROBE_SIMILARITIES.filter(
      ({ sim10, sim40 }) =>
        decideAnnTruncation({ ...base, lastAnnSimilarity: sim40, lastReturnedTotal: sim10 })
          .kind === "provably_safe",
    );
    const firing = PROBE_SIMILARITIES.filter(
      ({ sim10, sim40 }) =>
        decideAnnTruncation({
          ...base,
          lastAnnSimilarity: sim40,
          lastReturnedTotal: sim10 * 0.5,
        }).kind === "loss_possible",
    );
    expect(silent).toHaveLength(7);
    expect(firing).toHaveLength(7);
  });
});
