import { describe, expect, it } from "vitest";
import { defaultScoringStrategy } from "../strategies/scoring.js";

const HOUR = 1000 * 60 * 60;

function baseInput() {
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    now: recordedAt,
    tags: ["a", "b"],
    queryTags: [] as string[],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
  };
}

describe("defaultScoringStrategy", () => {
  it("similarity が無い場合は score.similarity が undefined で total に中立の 1 として掛かる", () => {
    const score = defaultScoringStrategy(baseInput());
    expect(score.similarity).toBeUndefined();
    // decay=1, tagMatch=1(queryTags空), freshness=1, strength=1 のとき total=1
    expect(score.total).toBeCloseTo(1, 10);
  });

  it("similarity がある場合は score.similarity に反映され total にも掛かる", () => {
    const score = defaultScoringStrategy({ ...baseInput(), similarity: 0.5 });
    expect(score.similarity).toBe(0.5);
    expect(score.total).toBeCloseTo(0.5, 10);
  });

  it("queryTags が空のとき tagMatch は中立の 1", () => {
    const score = defaultScoringStrategy({ ...baseInput(), queryTags: [] });
    expect(score.tagMatch).toBe(1);
  });

  it("queryTags があり一致が無いとき tagMatch は 1 のまま（除外条件にしない）", () => {
    const score = defaultScoringStrategy({ ...baseInput(), tags: ["x"], queryTags: ["y", "z"] });
    expect(score.tagMatch).toBe(1);
  });

  it("queryTags と一致があるとき tagMatch は 1 より大きくなる", () => {
    const score = defaultScoringStrategy({
      ...baseInput(),
      tags: ["a", "b"],
      queryTags: ["a", "z"],
    });
    expect(score.tagMatch).toBeCloseTo(1.1, 10);
  });

  it("時間が経つほど decay は小さくなる（lastReinforcedAt 基準）", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const lastReinforcedAt = new Date(recordedAt.getTime() - 100 * HOUR);
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    const score = defaultScoringStrategy({
      now,
      tags: [],
      queryTags: [],
      occurredAt: null,
      recordedAt,
      lastReinforcedAt,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(score.decay).toBeLessThan(1);
  });

  it("freshness は occurredAt を優先し、古い occurredAt ほど低くなる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const occurredAt = new Date(recordedAt.getTime() - 24 * HOUR);
    const score = defaultScoringStrategy({
      now: recordedAt,
      tags: [],
      queryTags: [],
      occurredAt,
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(score.freshness).toBeCloseTo(0.5, 10);
  });

  it("occurredAt が無ければ recordedAt を鮮度の起点にする", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const score = defaultScoringStrategy({
      now: recordedAt,
      tags: [],
      queryTags: [],
      occurredAt: null,
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(score.freshness).toBeCloseTo(1, 10);
  });

  it("strength は score.strength にそのまま反映され total にも掛かる", () => {
    const score = defaultScoringStrategy({ ...baseInput(), strength: 0.5 });
    expect(score.strength).toBe(0.5);
    expect(score.total).toBeCloseTo(0.5, 10);
  });
});

/**
 * docs/memory-model.md §3「三つの時計」の中心的な要求:
 * **鮮度は `occurred_at ?? recorded_at` を使い、減衰は `last_reinforced_at` を使う。**
 * この2つを混ぜると「昔起きたが最近よく使う記憶」と「最近起きたが一度も使われていない記憶」を
 * 区別できなくなる——文書が名指しで禁じている取り違えである。
 *
 * 下の2本は、その混同が起きたときに実際に赤くなるための歯である。
 * 3つの時刻をすべて異なる値にしないと、混同しても値が一致してしまい検出できない。
 */
describe("defaultScoringStrategy: 鮮度と減衰は別の時計を使う（docs/memory-model.md §3）", () => {
  const occurredAt = new Date("2026-01-01T00:00:00.000Z");
  const recordedAt = new Date("2026-01-02T00:00:00.000Z"); // occurredAt + 24h
  const lastReinforcedAt = new Date("2026-01-04T00:00:00.000Z"); // occurredAt + 72h
  const now = new Date("2026-01-05T00:00:00.000Z"); // occurredAt + 96h

  const input = {
    now,
    tags: [],
    queryTags: [],
    occurredAt,
    recordedAt,
    lastReinforcedAt,
    strength: 1,
    halfLifeHours: 24,
  };

  it("freshness は occurredAt を起点にする（lastReinforcedAt にも recordedAt にも寄らない）", () => {
    const score = defaultScoringStrategy(input);
    // occurredAt 起点なら elapsed=96h = 4 half-life -> 0.0625
    expect(score.freshness).toBeCloseTo(Math.pow(0.5, 4), 10);
    // lastReinforcedAt 起点(elapsed=24h -> 0.5) でも recordedAt 起点(elapsed=72h -> 0.125) でもない
    expect(score.freshness).not.toBeCloseTo(0.5, 5);
    expect(score.freshness).not.toBeCloseTo(0.125, 5);
  });

  it("decay は lastReinforcedAt を起点にする（occurredAt にも寄らない）", () => {
    const score = defaultScoringStrategy(input);
    // lastReinforcedAt 起点なら elapsed=24h = 1 half-life -> 0.5
    expect(score.decay).toBeCloseTo(0.5, 10);
    // occurredAt 起点(0.0625) でも recordedAt 起点(0.125) でもない
    expect(score.decay).not.toBeCloseTo(Math.pow(0.5, 4), 5);
    expect(score.decay).not.toBeCloseTo(0.125, 5);
  });
});

describe("defaultScoringStrategy: freshness は 1 で頭打ちにする（ADR 0036）", () => {
  // `occurredAt` は docs/memory-model.md §3 の定義上ふつうに未来になる（「来月、京都へ出張する」）。
  // 減衰式は経過時間が負のとき 1 を超え、上限を持たない。
  //
  // ⚠ 未来側だけを見ると「常に 1 を返す」実装も通ってしまう。過去側が1ミリも動いていない
  // ことを、上限を入れる前に実測した値そのもので押さえる。
  const NOW = new Date("2026-09-06T00:00:00.000Z");
  const DAY = 24 * HOUR;

  function freshnessFor(occurredAt: Date | null): number {
    return defaultScoringStrategy({
      now: NOW,
      tags: [],
      queryTags: [],
      occurredAt,
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
    }).freshness;
  }

  it("未来の occurredAt では freshness がちょうど 1 になる（+30日 / +365日 / +10年）", () => {
    // 上限が無ければ順に 2 / 4597.6 / 4.22e36 だった（本 PR 前に実測した値）。
    expect(freshnessFor(new Date(NOW.getTime() + 30 * DAY))).toBe(1);
    expect(freshnessFor(new Date(NOW.getTime() + 365 * DAY))).toBe(1);
    expect(freshnessFor(new Date(NOW.getTime() + 3650 * DAY))).toBe(1);
  });

  it("過去の occurredAt は1ミリも動かない（上限を入れる前に実測した値そのもの）", () => {
    expect(freshnessFor(new Date(NOW.getTime() - 30 * DAY))).toBe(0.5);
    expect(freshnessFor(new Date(NOW.getTime() - 365 * DAY))).toBe(0.00021750456985848138);
    expect(freshnessFor(new Date(NOW.getTime() - HOUR))).toBe(0.9990377588337834);
  });

  it("occurredAt === now ちょうどでも 1（境界で1つずれていないこと）", () => {
    expect(freshnessFor(NOW)).toBe(1);
    // 1ミリ秒だけ過去は 1 未満、1ミリ秒だけ未来は 1。
    expect(freshnessFor(new Date(NOW.getTime() - 1))).toBeLessThan(1);
    expect(freshnessFor(new Date(NOW.getTime() + 1))).toBe(1);
  });

  it("occurredAt が無い記憶（いまのリポジトリの全件）では、上限に当たらず何も変わらない", () => {
    // recordedAt 起点になり、now === recordedAt なので 1。上限の有無に依らない。
    expect(freshnessFor(null)).toBe(1);
    const past = defaultScoringStrategy({
      now: NOW,
      tags: [],
      queryTags: [],
      occurredAt: null,
      recordedAt: new Date(NOW.getTime() - 30 * DAY),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
    });
    expect(past.freshness).toBe(0.5);
  });

  it("上限を掛けたのは freshness だけで、decay には掛けていない", () => {
    // occurredAt は未来、lastReinforcedAt は過去。freshness は 1 に丸められるが、
    // decay は過去起点のまま 0.5 でなければならない（両方 1 に丸める実装を弾く）。
    const score = defaultScoringStrategy({
      now: NOW,
      tags: [],
      queryTags: [],
      occurredAt: new Date(NOW.getTime() + 365 * DAY),
      recordedAt: new Date(NOW.getTime() - 30 * DAY),
      lastReinforcedAt: new Date(NOW.getTime() - 30 * DAY),
      strength: 1,
      halfLifeHours: 720,
    });
    expect(score.freshness).toBe(1);
    expect(score.decay).toBe(0.5);
    expect(score.total).toBe(0.5);
  });
});

/**
 * `computeDecay`（`strategies/scoring.ts`、非 export）の歯——`defaultScoringStrategy` 越しに
 * `score.decay` だけを見て検査する（[ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)
 * 決めたこと12）。
 *
 * 壁時計側は「1 half-life 経過 → 0.5」（halfLifeHours=24, elapsed=24h）に固定し、
 * 活動時計側はそれとは違う値（0.25 or 0.933...）になるよう別の half-life を選ぶ——
 * 2つの時計の値が偶然一致すると「どちらが使われたか」を判別できない歯になる。
 */
describe("defaultScoringStrategy: computeDecay の時計選択（ADR 0165 決めたこと12）", () => {
  const recordedAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(recordedAt.getTime() + 24 * HOUR); // 壁時計: elapsed=24h, halfLifeHours=24 → wallDecay=0.5

  function baseWallInput() {
    return {
      now,
      tags: [] as string[],
      queryTags: [] as string[],
      occurredAt: null as Date | null,
      recordedAt,
      lastReinforcedAt: null as Date | null,
      strength: 1,
      halfLifeHours: 24,
    };
  }

  it("decayClock 省略時は壁時計のみ——活動時計の入力があっても無視する", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(),
      nowSeq: 20,
      decayBaseSeq: 0,
      halfLifeRecalls: 10, // 使われれば elapsed=20,half=10 → 0.25 になるはずの値
    });
    expect(score.decay).toBeCloseTo(0.5, 10);
  });

  it("decayClock: 'wall' を明示しても同じ——活動時計の入力を無視する", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(),
      decayClock: "wall",
      nowSeq: 20,
      decayBaseSeq: 0,
      halfLifeRecalls: 10,
    });
    expect(score.decay).toBeCloseTo(0.5, 10);
  });

  it("decayClock: 'activity' で3つの入力が揃っていれば活動時計だけを使う（壁時計の値を無視する）", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(), // 使われれば 0.5 になってしまう壁時計の入力をそのまま残す
      decayClock: "activity",
      nowSeq: 20,
      decayBaseSeq: 0,
      halfLifeRecalls: 10, // elapsed=20, half=10 → 2 half-life → 0.25
    });
    expect(score.decay).toBeCloseTo(0.25, 10);
    expect(score.decay).not.toBeCloseTo(0.5, 5);
  });

  it("decayClock: 'activity' でも活動時計の入力が欠けていれば壁時計へフォールバックする（ADR 0165 決めたこと4と同じ向き）", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(),
      decayClock: "activity",
      // nowSeq を渡さない = 'wall' のテナント、または activity_seq を読んでいない状態。
      decayBaseSeq: 0,
      halfLifeRecalls: 10,
    });
    expect(score.decay).toBeCloseTo(0.5, 10);
  });

  it("decayClock: 'activity' でも decayBaseSeq が null（NULL＝この軸に床が無い）なら壁時計へフォールバックする", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(),
      decayClock: "activity",
      nowSeq: 20,
      decayBaseSeq: null,
      halfLifeRecalls: 10,
    });
    expect(score.decay).toBeCloseTo(0.5, 10);
  });

  it("decayClock: 'either' は Math.max——活動時計のほうが大きい（生きている）とき活動時計を採る", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(), // wallDecay=0.5
      decayClock: "either",
      nowSeq: 5,
      decayBaseSeq: 0,
      halfLifeRecalls: 50, // elapsed=5, half=50 → 0.5^(0.1) ≈ 0.933（wall より大きい）
    });
    expect(score.decay).toBeGreaterThan(0.5);
    expect(score.decay).toBeCloseTo(Math.pow(0.5, 5 / 50), 10);
  });

  it("decayClock: 'either' は Math.max——壁時計のほうが大きい（生きている）とき壁時計を採る", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(), // wallDecay=0.5
      decayClock: "either",
      nowSeq: 20,
      decayBaseSeq: 0,
      halfLifeRecalls: 10, // elapsed=20, half=10 → 0.25（wall より小さい）
    });
    expect(score.decay).toBeCloseTo(0.5, 10);
    expect(score.decay).not.toBeCloseTo(0.25, 5);
  });

  it("decayClock: 'either' でも活動時計の入力が欠けていれば壁時計の値だけになる（Math.max のもう片方が存在しないのと同じ）", () => {
    const score = defaultScoringStrategy({
      ...baseWallInput(),
      decayClock: "either",
    });
    expect(score.decay).toBeCloseTo(0.5, 10);
  });
});
