import { describe, expect, it } from "vitest";
import { DECAY_CLOCK_FLAG, parseDecayClockFlag } from "../decay-clock-options.js";

/**
 * `--decay-clock <wall|activity|either>` の argv 解析(純関数。ADR 0165 決めたこと11)。
 *
 * ⭐ **いちばん重要な歯は「未指定なら `undefined`」である**——`examples/chat` の既定挙動
 * （既定 `'wall'`）をビット単位で保つための唯一の入口がここ。呼び出し側（`cli.ts`）は
 * この関数が `undefined` を返したときに `writeDecayClock` を一度も呼ばない
 * （`decay-clock-write.test.ts` 参照）。
 */
describe("parseDecayClockFlag", () => {
  it("フラグが無ければ undefined を返す(既定 'wall' のまま何も書かない)", () => {
    expect(parseDecayClockFlag([])).toBeUndefined();
    expect(parseDecayClockFlag(["--decay-clock-typo", "wall"])).toBeUndefined();
  });

  it("他の引数に混ざっていても見つける", () => {
    expect(parseDecayClockFlag(["--foo", "bar", DECAY_CLOCK_FLAG, "activity"])).toBe("activity");
  });

  it.each(["wall", "activity", "either"] as const)("'%s' を受け付ける", (value) => {
    expect(parseDecayClockFlag([DECAY_CLOCK_FLAG, value])).toBe(value);
  });

  it("3値のいずれでもない値は例外(黙って既定へ倒さない)", () => {
    expect(() => parseDecayClockFlag([DECAY_CLOCK_FLAG, "hourly"])).toThrow(
      /decay clock must be 'wall', 'activity', or 'either'/,
    );
  });

  it("値が無い(末尾に置かれた)場合は例外", () => {
    expect(() => parseDecayClockFlag([DECAY_CLOCK_FLAG])).toThrow(DECAY_CLOCK_FLAG);
  });

  it("フラグが複数回渡された場合は最初の1つを使う(indexOf の仕様通り)", () => {
    expect(parseDecayClockFlag([DECAY_CLOCK_FLAG, "wall", DECAY_CLOCK_FLAG, "activity"])).toBe(
      "wall",
    );
  });
});
