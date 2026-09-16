import { describe, expect, it } from "vitest";
import {
  DECAY_CLOCK_INVALID_MESSAGE,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_HOURS,
  DEFAULT_HALF_LIFE_RECALLS,
  EVENT_RETENTION_DAYS_INVALID_MESSAGE,
} from "@mnemora/core";
import type { Ctx, DecayClock, TenantSettingsStore } from "@mnemora/core";

/**
 * `setEventRetention` に不正な `days` を渡したときのメッセージが `EVENT_RETENTION_DAYS_INVALID_MESSAGE`
 * を含むことを見る。`TypeError` のような別種の失敗と区別するため、`.toThrow()` は引数なしで
 * 使わない（`memory-store-conformance.ts` の `NOT_FOUND_ERROR_MESSAGE` と同じ理由・同じ形）。
 */
const INVALID_DAYS_ERROR = new RegExp(EVENT_RETENTION_DAYS_INVALID_MESSAGE);
/**
 * `setDecayClock` に不正な値を渡したときのメッセージが `DECAY_CLOCK_INVALID_MESSAGE` を
 * 含むことを見る。`INVALID_DAYS_ERROR` と同じ理由・同じ形。
 */
const INVALID_DECAY_CLOCK_ERROR = new RegExp(DECAY_CLOCK_INVALID_MESSAGE);

export interface TenantSettingsStoreConformanceOptions {
  name: string;
  createStore: () => TenantSettingsStore | Promise<TenantSettingsStore>;
  /**
   * テナントの `default_half_life_hours` を明示的に設定するためのフック。
   * 省略時はこのケースをスキップする（in-memory 実装は簡易な setter を持つ想定だが、
   * 将来 setter を持たない読み取り専用 adapter が来た場合にも壊れないようにする）。
   */
  setDefaultHalfLifeHours?: (ctx: Ctx, hours: number) => Promise<void> | void;

  /**
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと13
   * （Issue #305）: `getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`/
   * `getActivitySeq` の4メソッドを検査するかどうか。
   *
   * ⭐ **省略可にしない**——`packages/testkit/src/memory-store-conformance.ts` の
   * `supportsArchiveDecayed`/`supportsPurgeMemory` 等（任意メソッドを検査するかどうかの
   * 明示フラグ、いずれも「省略可にしない」という同じ規律）に倣う。4メソッドは
   * `TenantSettingsStore` interface 上は任意（`?`、外部 adapter が壊れないための配慮、
   * ADR 0165 決めたこと13）だが、**この repo に同梱される2実装
   * （`PostgresTenantSettingsStore`/`InMemoryTenantSettingsStore`）はどちらも実装している**
   * ——呼び出し側（`packages/postgres`/`packages/testkit` それぞれの配線ファイル）に
   * `true`/`false` を明示させることで、「実装したのに配線を忘れて検査されていない」を
   * 型ではなく歯で検出できるようにする。
   */
  supportsDecayClock: boolean;

  /**
   * `supportsDecayClock: true` のときに使う。テナントの `default_half_life_recalls` を
   * 明示的に設定するためのフック。省略時はこのケースをスキップする。
   *
   * ⭐ [ADR 0197](../../../docs/decisions/0197-set-default-half-life-recalls.md) 以降、
   * `setDefaultHalfLifeHours`（本番の書き込み口を持たないため、呼び出し側は生 SQL の
   * UPSERT で行を作る）とは違い、**このフックは `TenantSettingsStore.setDefaultHalfLifeRecalls`
   * （interface 上は `?` 付きだが production の口そのもの）をそのまま呼ぶことを想定する**
   * ——この repo の2つの wiring（`packages/postgres`/`packages/testkit` それぞれの
   * conformance テストファイル）はどちらもそうしている。⟹ 下のテスト群は
   * 「読み書きが正しく往復するか」だけでなく、**production の UPSERT/検証ロジックそのもの**
   * を検査する。
   */
  setDefaultHalfLifeRecalls?: (ctx: Ctx, recalls: number) => Promise<void> | void;

  /**
   * `supportsDecayClock: true` のときに使う。`tenant_activity.activity_seq` を+1する
   * （`MemoryStore.createRecall({ advanceActivityClock: true })` を呼ぶことを想定）。
   * `getActivitySeq` は読み出し専用（ADR 0165 決めたこと2・5・13）なので、`TenantSettingsStore`
   * 単体では進める口が無い——呼び出し側が `MemoryStore` と同じバッキング（in-memory なら
   * 共有 Map、postgres なら同じ DB）を経由してこのフックを実装する。省略時は
   * `getActivitySeq` を「進める」歯をスキップする（`0` を返すことの歯は
   * `supportsDecayClock: true` だけで検査する）。
   */
  advanceActivitySeq?: (ctx: Ctx) => Promise<void> | void;
}

/**
 * `TenantSettingsStore` の適合テスト（roadmap.md 段階3、`decayFloorAt` 計算に使う
 * テナント既定値の読み出し契約。`getEventRetention`/`setEventRetention` は
 * `docs/decisions/0050-tenant-event-retention.md` で追加）。
 */
export function describeTenantSettingsStoreConformance(
  options: TenantSettingsStoreConformanceOptions,
): void {
  const {
    name,
    createStore,
    setDefaultHalfLifeHours,
    supportsDecayClock,
    setDefaultHalfLifeRecalls,
    advanceActivitySeq,
  } = options;

  describe(`TenantSettingsStore conformance (${name})`, () => {
    it("設定行が無いテナントには DEFAULT_HALF_LIFE_HOURS を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-unset-${Math.random()}` };
      expect(await store.getDefaultHalfLifeHours(ctx)).toBe(DEFAULT_HALF_LIFE_HOURS);
    });

    if (setDefaultHalfLifeHours) {
      it("設定済みのテナントにはその値を返す", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-custom-${Math.random()}` };
        await setDefaultHalfLifeHours(ctx, 24);
        expect(await store.getDefaultHalfLifeHours(ctx)).toBe(24);
      });

      it("⚠ 値域の外の default_half_life_hours を拒む（ADR 0125 / Issue #231）", async () => {
        // `default_half_life_hours` は `getDefaultHalfLifeHours` を経由して
        // `Memory.halfLifeHours` の既定値になり、`decay`/`freshness` の式
        // `elapsedHours / halfLifeHours` へそのまま入る。`0`・負・`NaN`・`Infinity` は
        // どれもこの式を壊す（Issue #231。詳細は `isHalfLifeHoursInRange` の doc）。
        //
        // ⚠ **同期的に throw する実装（in-memory）と、Promise を返す実装（postgres）の
        // 両方に対応するため、呼び出しを Promise チェーンで包む**——`await expect(f()).rejects`
        // は `f()` 自体が同期的に throw すると `expect` へ渡す前に例外が飛んでしまう。
        const store = await createStore();
        const outOfRange: Array<[string, number]> = [
          ["ちょうど 0", 0],
          ["負", -1],
          ["NaN", Number.NaN],
          ["Infinity", Number.POSITIVE_INFINITY],
        ];
        for (const [label, hours] of outOfRange) {
          const ctx: Ctx = { tenantId: `tenant-half-life-oor-${Math.random()}` };
          await expect(
            Promise.resolve().then(() => setDefaultHalfLifeHours(ctx, hours)),
            `default_half_life_hours=${hours}（${label}）は拒まれなければならない`,
          ).rejects.toThrow();
        }

        // 前提: 値域の内側なら通る（「何を渡しても落ちる」実装を弾く）。
        // ⚠ `default_half_life_hours` は Postgres 側で `real`（float4）の列である。
        // 小さい非整数（例: `1e-6`）は float4 で丸められうるため（ADR 0078 の float4 実測と
        // 同じ注意）、ここでは float4 でも厳密に表現できる整数を使う——`.toBe` の厳密等価が
        // どちらの adapter でも成り立つようにするため。
        const ctx: Ctx = { tenantId: `tenant-half-life-in-range-${Math.random()}` };
        await setDefaultHalfLifeHours(ctx, 48);
        expect(await store.getDefaultHalfLifeHours(ctx)).toBe(48);
      });
    }

    // -----------------------------------------------------------------
    // getEventRetention / setEventRetention（ADR 0050）
    //
    // ⚠ event_retention_days には3つの状態があり、これを2つに潰さないことが本節の芯。
    // | 状態                     | 意味                                   |
    // |--------------------------|----------------------------------------|
    // | 行が無い                 | まだ設定していない（既定は無期限）      |
    // | 行は在るが NULL          | 明示的に無期限と決めた                  |
    // | 数値                     | その日数                               |
    // -----------------------------------------------------------------

    it("設定行が無いテナントの event retention は unset", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-unset-${Math.random()}` };
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unset" });
    });

    if (setDefaultHalfLifeHours) {
      // ⭐ 3状態が潰れていないことの芯。half-life だけを設定して行を作ったテナントは、
      // event_retention_days が NULL のまま行が存在する状態になる ⟹ unlimited であって
      // unset ではない。in-memory 実装が half-life 用と retention 用を別々の Map に
      // 分けていた場合、この歯だけが unset を返して赤くなる（M2 参照）。
      it("⭐ half-life だけを設定した（行はできたが retention は未設定の）テナントは unlimited（unset と区別できる）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-half-life-only-${Math.random()}` };
        await setDefaultHalfLifeHours(ctx, 24);
        expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
      });
    }

    it("setEventRetention({ kind: 'days' }) は読み直しても同じ日数を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-days-${Math.random()}` };
      await store.setEventRetention(ctx, { kind: "days", days: 30 });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 30 });
    });

    it("setEventRetention({ kind: 'unlimited' }) は明示的に無期限へ戻す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-unlimited-${Math.random()}` };
      await store.setEventRetention(ctx, { kind: "days", days: 30 });
      await store.setEventRetention(ctx, { kind: "unlimited" });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
    });

    // ⚠ 非対称: 正しい値では成功することを、不正な値の検査と同じ歯の中で見る
    // （「常に失敗する」実装を緑にしないため）。
    it("setEventRetention の days は正の整数のみを受け付ける（0・負・非整数は拒み、正の整数は通す）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: `tenant-retention-validation-${Math.random()}` };

      await expect(store.setEventRetention(ctx, { kind: "days", days: 0 })).rejects.toThrow(
        INVALID_DAYS_ERROR,
      );
      await expect(store.setEventRetention(ctx, { kind: "days", days: -1 })).rejects.toThrow(
        INVALID_DAYS_ERROR,
      );
      await expect(store.setEventRetention(ctx, { kind: "days", days: 1.5 })).rejects.toThrow(
        INVALID_DAYS_ERROR,
      );

      // 延長も許す側に倒した（オーナーは「短縮できる口」と言ったが延長を禁じたとは
      // 言っていない）——短い日数の後に長い日数を設定しても成功する。
      await store.setEventRetention(ctx, { kind: "days", days: 7 });
      await store.setEventRetention(ctx, { kind: "days", days: 365 });
      expect(await store.getEventRetention(ctx)).toEqual({ kind: "days", days: 365 });
    });

    // -----------------------------------------------------------------
    // getDecayClock / setDecayClock / getDefaultHalfLifeRecalls / getActivitySeq
    // (ADR 0165, Issue #305)
    //
    // `supportsDecayClock` の理由は `TenantSettingsStoreConformanceOptions` の doc
    // コメント参照——interface 上は任意だが、この repo の2実装は両方実装しているので、
    // 呼び出し側に明示させることで配線漏れを歯で検出する。
    // -----------------------------------------------------------------
    if (supportsDecayClock) {
      it("getDecayClock: 行が無いテナントには DEFAULT_DECAY_CLOCK（'wall'）を返す", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-decay-clock-unset-${Math.random()}` };
        expect(await store.getDecayClock!(ctx)).toBe(DEFAULT_DECAY_CLOCK);
        expect(await store.getDecayClock!(ctx)).toBe("wall");
      });

      it("setDecayClock/getDecayClock: 設定した値を読み直せる（'wall'/'activity'/'either' の3値）", async () => {
        const store = await createStore();
        const values: DecayClock[] = ["wall", "activity", "either"];
        for (const clock of values) {
          const ctx: Ctx = { tenantId: `tenant-decay-clock-${clock}-${Math.random()}` };
          await store.setDecayClock!(ctx, clock);
          expect(await store.getDecayClock!(ctx)).toBe(clock);
        }
      });

      it("setDecayClock: 3値のいずれでもない値を拒む", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-decay-clock-invalid-${Math.random()}` };
        await expect(store.setDecayClock!(ctx, "not-a-real-clock" as DecayClock)).rejects.toThrow(
          INVALID_DECAY_CLOCK_ERROR,
        );
      });

      it("getDefaultHalfLifeRecalls: 行が無いテナントには DEFAULT_HALF_LIFE_RECALLS（720）を返す", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-half-life-recalls-unset-${Math.random()}` };
        expect(await store.getDefaultHalfLifeRecalls!(ctx)).toBe(DEFAULT_HALF_LIFE_RECALLS);
      });

      if (setDefaultHalfLifeRecalls) {
        it("getDefaultHalfLifeRecalls: 設定済みのテナントにはその値を返す", async () => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: `tenant-half-life-recalls-custom-${Math.random()}` };
          await setDefaultHalfLifeRecalls(ctx, 24);
          expect(await store.getDefaultHalfLifeRecalls!(ctx)).toBe(24);
        });

        it("⚠ 値域の外の default_half_life_recalls を拒む（ADR 0165 が isHalfLifeHoursInRange と同じ値域を課す）", async () => {
          // `isHalfLifeRecallsInRange` の doc コメント参照——`isHalfLifeHoursInRange`
          // （Issue #231）と同じ理由・同じ値域。同期 throw の実装にも対応するため
          // Promise チェーンで包む（上の half-life-hours の歯と同じ形）。
          const store = await createStore();
          const outOfRange: Array<[string, number]> = [
            ["ちょうど 0", 0],
            ["負", -1],
            ["NaN", Number.NaN],
            ["Infinity", Number.POSITIVE_INFINITY],
          ];
          for (const [label, recalls] of outOfRange) {
            const ctx: Ctx = { tenantId: `tenant-half-life-recalls-oor-${Math.random()}` };
            await expect(
              Promise.resolve().then(() => setDefaultHalfLifeRecalls(ctx, recalls)),
              `default_half_life_recalls=${recalls}（${label}）は拒まれなければならない`,
            ).rejects.toThrow();
          }

          const ctx: Ctx = { tenantId: `tenant-half-life-recalls-in-range-${Math.random()}` };
          await setDefaultHalfLifeRecalls(ctx, 48);
          expect(await store.getDefaultHalfLifeRecalls!(ctx)).toBe(48);
        });

        // ⭐ 行が無いテナントに書き込むと行ができることの芯（`setDefaultHalfLifeHours` の
        // 「half-life だけを設定した…テナントは unlimited」の歯と同じ発想）。行が
        // 無ければ `getEventRetention` は `{ kind: "unset" }` を返す——`{ kind:
        // "unlimited" }`（行は在るが `event_retention_days` が NULL）に変わったことが、
        // UPSERT で行が作られたことの間接証拠になる。
        it("⭐ 行が無いテナントに setDefaultHalfLifeRecalls すると行ができる（event retention が unset → unlimited になる）", async () => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: `tenant-half-life-recalls-creates-row-${Math.random()}` };
          expect(await store.getEventRetention(ctx)).toEqual({ kind: "unset" });
          await setDefaultHalfLifeRecalls(ctx, 100);
          expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
        });

        // ⭐ UPSERT が `default_half_life_recalls` 以外の列を巻き込まないことの芯
        // （`setDecayClock`/`setEventRetention` と同じ「他の列は指定しない」規律が
        // 実際に守られているかを検査する。変異試験1: `ON CONFLICT DO UPDATE` の `SET` を
        // 落とすと、この歯より前に「設定済みのテナントにはその値を返す」が先に赤くなるが、
        // 本歯は「上書きで他の列を壊していないか」を別の軸で見る）。
        it("⭐ setDefaultHalfLifeRecalls は decay_clock を壊さない", async () => {
          const store = await createStore();
          const ctx: Ctx = {
            tenantId: `tenant-half-life-recalls-keeps-decay-clock-${Math.random()}`,
          };
          await store.setDecayClock!(ctx, "activity");
          await setDefaultHalfLifeRecalls(ctx, 200);
          expect(await store.getDecayClock!(ctx)).toBe("activity");
          expect(await store.getDefaultHalfLifeRecalls!(ctx)).toBe(200);
        });
      }

      it("getActivitySeq: 行が無いテナントには 0 を返す", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: `tenant-activity-seq-unset-${Math.random()}` };
        expect(await store.getActivitySeq!(ctx)).toBe(0);
      });

      if (advanceActivitySeq) {
        it("getActivitySeq: advanceActivitySeq を呼ぶたびに1ずつ進む（読み出し専用——このフック自身は MemoryStore.createRecall 経由）", async () => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: `tenant-activity-seq-advance-${Math.random()}` };
          expect(await store.getActivitySeq!(ctx)).toBe(0);
          await advanceActivitySeq(ctx);
          expect(await store.getActivitySeq!(ctx)).toBe(1);
          await advanceActivitySeq(ctx);
          await advanceActivitySeq(ctx);
          expect(await store.getActivitySeq!(ctx)).toBe(3);
        });

        it("getActivitySeq: テナントごとに独立している", async () => {
          const store = await createStore();
          const ctxA: Ctx = { tenantId: `tenant-activity-seq-a-${Math.random()}` };
          const ctxB: Ctx = { tenantId: `tenant-activity-seq-b-${Math.random()}` };
          await advanceActivitySeq(ctxA);
          await advanceActivitySeq(ctxA);
          await advanceActivitySeq(ctxB);
          expect(await store.getActivitySeq!(ctxA)).toBe(2);
          expect(await store.getActivitySeq!(ctxB)).toBe(1);
        });
      }
    }
  });
}
