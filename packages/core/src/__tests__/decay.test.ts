import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY_THRESHOLD,
  decayFactor,
  decayFloorOffset,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
} from "../strategies/decay.js";

const HOUR = 1000 * 60 * 60;

describe("defaultDecayStrategy.strengthAt", () => {
  it("elapsed=0 のとき strength をそのまま返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const value = defaultDecayStrategy.strengthAt(recordedAt, {
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(1, 10);
  });

  it("1 half-life 経過で半分になる（recordedAt を起点にする分岐）", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    const value = defaultDecayStrategy.strengthAt(now, {
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(0.5, 10);
  });

  it("lastReinforcedAt があればそちらを起点にする（recordedAt を起点にしない）", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const lastReinforcedAt = new Date(recordedAt.getTime() + 12 * HOUR);
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    // recordedAt を起点にすれば elapsed=24h -> 0.5 になるはずだが、
    // lastReinforcedAt(recordedAt+12h) を起点にすると elapsed=12h -> 0.5^(0.5) になる。
    const value = defaultDecayStrategy.strengthAt(now, {
      recordedAt,
      lastReinforcedAt,
      strength: 1,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(Math.pow(0.5, 0.5), 10);
    expect(value).not.toBeCloseTo(0.5, 5);
  });

  it("strength が 1 以外でも比例して掛かる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(recordedAt.getTime() + 24 * HOUR);
    const value = defaultDecayStrategy.strengthAt(now, {
      recordedAt,
      lastReinforcedAt: null,
      strength: 2,
      halfLifeHours: 24,
    });
    expect(value).toBeCloseTo(1, 10);
  });
});

describe("defaultDecayStrategy.floorAt", () => {
  it("strength > threshold: base + halfLifeHours * log2(strength/threshold) 時間後を返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    // threshold を strength の半分にすると log2(2) = 1 になり、
    // floorAt はちょうど base + halfLifeHours 時間後になる（検算しやすいケース）。
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      0.5,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime() + 24 * HOUR);
  });

  it("strength <= threshold（既に閾値以下）: base をそのまま返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 0.05, halfLifeHours: 24 },
      0.05,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime());
  });

  it("strength < threshold（既に大きく下回っている）でも base をそのまま返す", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 0.01, halfLifeHours: 24 },
      0.05,
    );
    expect(floor.getTime()).toBe(recordedAt.getTime());
  });

  it("threshold を省略すると既定値 DEFAULT_DECAY_THRESHOLD (0.05) が使われる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const withDefault = defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    const withExplicit = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt: null, strength: 1, halfLifeHours: 24 },
      DEFAULT_DECAY_THRESHOLD,
    );
    expect(withDefault.getTime()).toBe(withExplicit.getTime());
  });

  it("lastReinforcedAt があればそちらを起点にする", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const lastReinforcedAt = new Date(recordedAt.getTime() + 5 * HOUR);
    const floor = defaultDecayStrategy.floorAt(
      { recordedAt, lastReinforcedAt, strength: 1, halfLifeHours: 10 },
      0.5,
    );
    expect(floor.getTime()).toBe(lastReinforcedAt.getTime() + 10 * HOUR);
  });
});

/**
 * ADR 0010 は既定の減衰閾値を 0.05 に固定している。この値は Phase 1 で
 * `decay_floor_at` として実際に書き込まれ、Phase 2 で「いつ検索から外れるか」を決める。
 *
 * 直前の「threshold を省略すると既定値が使われる」テストは、両辺で
 * `DEFAULT_DECAY_THRESHOLD` を使っているため**既定値そのものが変わっても赤くならない**。
 * 既定値を数値で釘付けにするのはこの2本である。
 */
describe("DEFAULT_DECAY_THRESHOLD（ADR 0010 が固定する値）", () => {
  it("既定の閾値は 0.05 である", () => {
    expect(DEFAULT_DECAY_THRESHOLD).toBe(0.05);
  });

  it("threshold 省略時の floorAt が 0.05 由来の絶対時刻になる", () => {
    const recordedAt = new Date("2026-01-01T00:00:00.000Z");
    const floor = defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    });
    // 24h * log2(1 / 0.05) = 24 * log2(20) ≈ 103.6987 時間後
    const expectedHours = 24 * Math.log2(20);
    // Date はミリ秒未満を切り捨てるので 1ms の許容で比べる
    expect(floor.getTime()).toBeCloseTo(recordedAt.getTime() + expectedHours * HOUR, -1);
  });
});

/**
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと7:
 * 単位を持たない数値核（`decayFactor`/`decayFloorOffset`）そのものの歯。
 *
 * `defaultDecayStrategy`（壁時計）と `defaultActivityDecayStrategy`（活動時計）は
 * どちらもこの2関数の薄い包みである——**この2関数が壊れれば両方の時計が同時に壊れる**。
 * 上の「defaultDecayStrategy.strengthAt/floorAt」の歯は数値をリテラルで固定しているので、
 * `strengthAt`/`floorAt` の実装をこの核へ書き換えても（ADR 0165 が実際に行った変更）
 * 出力が1つも変わっていないことは、既存の歯がそのまま回帰の歯になっている。
 * ここではさらに核そのものの性質を直接固定する。
 */
describe("decayFactor（単位を持たない核、ADR 0165 決めたこと7）", () => {
  it("elapsed=0 のとき常に1", () => {
    expect(decayFactor(0, 24)).toBe(1);
  });

  it("elapsed=halfLife のとき常に0.5", () => {
    expect(decayFactor(24, 24)).toBeCloseTo(0.5, 10);
  });

  it("elapsed=2*halfLife のとき常に0.25（単位に依らない——時間でも recall 回数でも同じ式）", () => {
    expect(decayFactor(48, 24)).toBeCloseTo(0.25, 10);
    // 単位を「回数」として読んでも式は同じ（ADR 0165 決めたこと7の主張そのもの）。
    expect(decayFactor(10, 5)).toBeCloseTo(0.25, 10);
  });
});

describe("decayFloorOffset（単位を持たない核、ADR 0165 決めたこと7）", () => {
  it("strength <= threshold のとき 0 を返す（既に閾値以下）", () => {
    expect(decayFloorOffset(0.05, 24, 0.05)).toBe(0);
    expect(decayFloorOffset(0.01, 24, 0.05)).toBe(0);
  });

  it("strength > threshold のとき halfLife * log2(strength/threshold) を返す", () => {
    // threshold を strength の半分にすると log2(2)=1 になり、offset はちょうど halfLife。
    expect(decayFloorOffset(1, 24, 0.5)).toBeCloseTo(24, 10);
    expect(decayFloorOffset(1, 10, 0.05)).toBeCloseTo(10 * Math.log2(20), 10);
  });
});

/**
 * `defaultActivityDecayStrategy` — 壁時計と同じ式を「recall() が起きた回数」の単位で
 * 読む実例（ADR 0165 決めたこと1・3・7）。
 */
describe("defaultActivityDecayStrategy.strengthAt", () => {
  it("elapsed=0 のとき strength をそのまま返す", () => {
    const value = defaultActivityDecayStrategy.strengthAt(100, {
      baseSeq: 100,
      strength: 1,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(1, 10);
  });

  it("1 half-life（recall 回数）経過で半分になる", () => {
    const value = defaultActivityDecayStrategy.strengthAt(110, {
      baseSeq: 100,
      strength: 1,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(0.5, 10);
  });

  it("strength が 1 以外でも比例して掛かる", () => {
    const value = defaultActivityDecayStrategy.strengthAt(110, {
      baseSeq: 100,
      strength: 2,
      halfLifeRecalls: 10,
    });
    expect(value).toBeCloseTo(1, 10);
  });
});

describe("defaultActivityDecayStrategy.floorAt", () => {
  it("strength <= threshold（既に閾値以下）: baseSeq をそのまま返す", () => {
    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq: 100, strength: 0.05, halfLifeRecalls: 10 },
      0.05,
    );
    expect(floor).toBe(100);
  });

  it("threshold を省略すると既定値 DEFAULT_DECAY_THRESHOLD (0.05) が使われる", () => {
    const withDefault = defaultActivityDecayStrategy.floorAt({
      baseSeq: 0,
      strength: 1,
      halfLifeRecalls: 10,
    });
    const withExplicit = defaultActivityDecayStrategy.floorAt(
      { baseSeq: 0, strength: 1, halfLifeRecalls: 10 },
      DEFAULT_DECAY_THRESHOLD,
    );
    expect(withDefault).toBe(withExplicit);
  });

  /**
   * ⭐ ceil の境界（`strategies/decay.ts` の `activityFloorAt` doc コメントが名指しした歯）。
   *
   * strength=1, halfLifeRecalls=3, threshold=0.6 のとき
   * offset = 3 * log2(1/0.6) ≈ 2.2109 — 整数ではない。
   *
   * - `Math.floor` を使う実装なら floor=baseSeq+2 になり、nowSeq=baseSeq+2 で
   *   `decay_floor_seq(=+2) > nowSeq(=+2)` が false になって**まだ閾値を上回っている**
   *   （strengthAt(+2) ≈ 0.63 > 0.6）Memory が忘却ゲートを通ってしまう——これが
   *   `activityFloorAt` の doc コメントが警告する壊れ方そのもの。
   * - `Math.ceil` なら floor=baseSeq+3 になり、`nowSeq=+2` ではまだ `floor(+3) > +2` で
   *   生き残る（正しい）。`nowSeq=+3` で初めて `floor(+3) > +3` が false になり、
   *   その時点の実際の強度 strengthAt(+3)=0.5 は既に threshold(0.6) を下回っている
   *   ——沈める判定が「実際に閾値を割った後」にしか起きない。
   */
  it("offset が非整数のとき ceil する（floor にすると閾値をまだ上回っている seq が忘却ゲートを通ってしまう）", () => {
    const baseSeq = 100;
    const halfLifeRecalls = 3;
    const threshold = 0.6;
    const offset = decayFloorOffset(1, halfLifeRecalls, threshold);
    expect(offset).not.toBe(Math.trunc(offset)); // 非整数であることの前提を確認する

    const floor = defaultActivityDecayStrategy.floorAt(
      { baseSeq, strength: 1, halfLifeRecalls },
      threshold,
    );
    expect(floor).toBe(baseSeq + Math.ceil(offset));
    expect(floor).toBe(103); // ceil(2.2109...) = 3

    // 変異試験の反証: floor にすると 102 になり、下のアサーションが赤くなる
    // （`Math.floor` へ書き換えると 102 !== 103 で落ちることを別途手元で確認した）。
    const strengthAtFloorMinusOne = defaultActivityDecayStrategy.strengthAt(floor - 1, {
      baseSeq,
      strength: 1,
      halfLifeRecalls,
    });
    // floor の1つ手前（=102、Math.floor 実装なら「これが floor」になってしまう seq）は
    // まだ閾値を上回っている——ここで沈めてはならないことの検算。
    expect(strengthAtFloorMinusOne).toBeGreaterThan(threshold);

    const strengthAtFloor = defaultActivityDecayStrategy.strengthAt(floor, {
      baseSeq,
      strength: 1,
      halfLifeRecalls,
    });
    // floor 自身では、実際の強度が既に閾値以下になっている（ceil が正しい側に倒れている）。
    expect(strengthAtFloor).toBeLessThanOrEqual(threshold);
  });
});
