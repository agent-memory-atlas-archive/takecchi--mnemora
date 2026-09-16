import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  assertValidDecayClock,
  DECAY_CLOCK_INVALID_MESSAGE,
  DECAY_CLOCK_UNSUPPORTED_MESSAGE,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_RECALLS,
  isHalfLifeRecallsInRange,
  readActivitySeq,
  readDecayClock,
  readDefaultHalfLifeRecalls,
  writeDecayClock,
} from "../interfaces/tenant-settings-store.js";
import type {
  DecayClock,
  EventRetention,
  EventRetentionSetting,
  TenantSettingsStore,
} from "../interfaces/tenant-settings-store.js";

/**
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと13の歯。
 *
 * `readDecayClock`/`readActivitySeq`/`readDefaultHalfLifeRecalls`/`writeDecayClock` は
 * `packages/core` が `TenantSettingsStore` の4つの省略可能メソッドへ読み書きする
 * **唯一の通り道**である。フォールバックの規律はここにしか無い——呼び出し側
 * （`runtime.ts`/`recall-runtime.ts`）にこの分岐を散らさないための1箇所であることを
 * この歯で固定する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

/** 4メソッドをすべて省略した最小実装（外部の未対応 adapter を模す）。 */
function minimalStore(): TenantSettingsStore {
  return {
    async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
      return 720;
    },
    async getEventRetention(_ctx: Ctx): Promise<EventRetention> {
      return { kind: "unset" };
    },
    async setEventRetention(_ctx: Ctx, _retention: EventRetentionSetting): Promise<void> {},
  };
}

/** 4メソッドを実装しているが、呼ぶと必ず投げる実装(「未実装」ではなく「実行時エラー」を模す)。 */
function throwingStore(message: string): TenantSettingsStore {
  return {
    ...minimalStore(),
    async getDecayClock(_ctx: Ctx): Promise<DecayClock> {
      throw new Error(message);
    },
    async setDecayClock(_ctx: Ctx, _clock: DecayClock): Promise<void> {
      throw new Error(message);
    },
    async getDefaultHalfLifeRecalls(_ctx: Ctx): Promise<number> {
      throw new Error(message);
    },
    async getActivitySeq(_ctx: Ctx): Promise<number> {
      throw new Error(message);
    },
  };
}

describe("readDecayClock", () => {
  it("getDecayClock を持たない adapter では DEFAULT_DECAY_CLOCK（'wall'）へ倒す", async () => {
    const clock = await readDecayClock(minimalStore(), ctx);
    expect(clock).toBe(DEFAULT_DECAY_CLOCK);
    expect(clock).toBe("wall");
  });

  it("getDecayClock が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getDecayClock(_ctx: Ctx): Promise<DecayClock> {
        return "activity";
      },
    };
    expect(await readDecayClock(store, ctx)).toBe("activity");
  });

  it("getDecayClock が在って投げた場合は、既定へ倒さず素通しで投げる（「未実装」と「失敗」を混ぜない）", async () => {
    await expect(readDecayClock(throwingStore("db down"), ctx)).rejects.toThrow("db down");
  });
});

describe("readActivitySeq", () => {
  it("getActivitySeq を持たない adapter では 0 へ倒す", async () => {
    expect(await readActivitySeq(minimalStore(), ctx)).toBe(0);
  });

  it("getActivitySeq が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getActivitySeq(_ctx: Ctx): Promise<number> {
        return 42;
      },
    };
    expect(await readActivitySeq(store, ctx)).toBe(42);
  });

  it("getActivitySeq が在って投げた場合は素通しで投げる", async () => {
    await expect(readActivitySeq(throwingStore("db down"), ctx)).rejects.toThrow("db down");
  });
});

describe("readDefaultHalfLifeRecalls", () => {
  it("getDefaultHalfLifeRecalls を持たない adapter では DEFAULT_HALF_LIFE_RECALLS へ倒す", async () => {
    const value = await readDefaultHalfLifeRecalls(minimalStore(), ctx);
    expect(value).toBe(DEFAULT_HALF_LIFE_RECALLS);
    expect(value).toBe(720);
  });

  it("getDefaultHalfLifeRecalls が在り成功すれば、その値をそのまま返す", async () => {
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async getDefaultHalfLifeRecalls(_ctx: Ctx): Promise<number> {
        return 100;
      },
    };
    expect(await readDefaultHalfLifeRecalls(store, ctx)).toBe(100);
  });

  it("getDefaultHalfLifeRecalls が在って投げた場合は素通しで投げる", async () => {
    await expect(readDefaultHalfLifeRecalls(throwingStore("db down"), ctx)).rejects.toThrow(
      "db down",
    );
  });
});

describe("writeDecayClock", () => {
  it("setDecayClock を持たない adapter では、既定へ倒さず DECAY_CLOCK_UNSUPPORTED_MESSAGE を含む Error で明示的に失敗する", async () => {
    await expect(writeDecayClock(minimalStore(), ctx, "activity")).rejects.toThrow(
      DECAY_CLOCK_UNSUPPORTED_MESSAGE,
    );
  });

  it("setDecayClock が在り成功すれば、そのまま委譲する", async () => {
    const written: DecayClock[] = [];
    const store: TenantSettingsStore = {
      ...minimalStore(),
      async setDecayClock(_ctx: Ctx, clock: DecayClock): Promise<void> {
        written.push(clock);
      },
    };
    await writeDecayClock(store, ctx, "either");
    expect(written).toEqual(["either"]);
  });

  it("setDecayClock が在って投げた場合は素通しで投げる", async () => {
    await expect(writeDecayClock(throwingStore("db down"), ctx, "activity")).rejects.toThrow(
      "db down",
    );
  });
});

describe("assertValidDecayClock", () => {
  it("'wall'/'activity'/'either' はどれも通す", () => {
    expect(() => assertValidDecayClock("wall")).not.toThrow();
    expect(() => assertValidDecayClock("activity")).not.toThrow();
    expect(() => assertValidDecayClock("either")).not.toThrow();
  });

  it("それ以外の文字列は DECAY_CLOCK_INVALID_MESSAGE を含む Error で失敗する", () => {
    expect(() => assertValidDecayClock("nonsense")).toThrow(DECAY_CLOCK_INVALID_MESSAGE);
    expect(() => assertValidDecayClock("")).toThrow(DECAY_CLOCK_INVALID_MESSAGE);
  });
});

describe("isHalfLifeRecallsInRange（ADR 0125 と同じ値域、halfLifeHours の負債参照）", () => {
  it("正の有限値だけを通す", () => {
    expect(isHalfLifeRecallsInRange(1)).toBe(true);
    expect(isHalfLifeRecallsInRange(720)).toBe(true);
  });

  it("0・負・NaN・Infinity は拒む", () => {
    expect(isHalfLifeRecallsInRange(0)).toBe(false);
    expect(isHalfLifeRecallsInRange(-1)).toBe(false);
    expect(isHalfLifeRecallsInRange(Number.NaN)).toBe(false);
    expect(isHalfLifeRecallsInRange(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
