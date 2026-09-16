import {
  assertValidDecayClock,
  assertValidEventRetentionDays,
  assertValidHalfLifeRecalls,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_HOURS,
  DEFAULT_HALF_LIFE_RECALLS,
  isHalfLifeHoursInRange,
} from "@mnemora/core";
import type {
  Ctx,
  DecayClock,
  EventRetention,
  EventRetentionSetting,
  TenantSettingsStore,
} from "@mnemora/core";

/**
 * `TenantSettingsStore` のインメモリ・プレースホルダ実装（roadmap.md 段階3。
 * `getEventRetention`/`setEventRetention` は
 * `docs/decisions/0050-tenant-event-retention.md` で追加）。
 *
 * ⚠ `overrides = Map<string, number>`（half-life だけの値）ではなく、テナントごとに
 * 「行」を1つ持つ形にしてある。Postgres では `default_half_life_hours` を設定して
 * 行ができたテナントは `event_retention_days` が `NULL` ⟹ `{ kind: "unlimited" }` になる。
 * half-life 用と retention 用を別々の Map にすると、half-life だけ設定したテナントの
 * retention が「行が無い」（`{ kind: "unset" }`）のままになり、Postgres と食い違う
 * （ADR 0050 参照）。
 */
export class InMemoryTenantSettingsStore implements TenantSettingsStore {
  private readonly rows = new Map<
    string,
    {
      defaultHalfLifeHours: number;
      eventRetentionDays: number | null;
      decayClock: DecayClock;
      defaultHalfLifeRecalls: number;
    }
  >();

  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと2・5・13
   * （Issue #305）: `getActivitySeq` が読む `tenant_activity` 相当のカウンタ。
   * `InMemoryMemoryStore.activitySeq`（`createRecall` が書く側）をそのまま渡すことで、
   * 書く側・読む側が同じ値を見る——`packages/core/src/__tests__/runtime-fakes.ts` の
   * `FakeTenantSettingsStore`/`FakeBackingStore` と同じ設計。**省略すると
   * `getActivitySeq` は常に `0` を返す**（`FakeTenantSettingsStore` と同じ規律）。
   */
  constructor(private readonly activitySeqBacking?: Map<string, number>) {}

  /**
   * 行が無ければ全列を既定値で作ってから返す（`setDefaultHalfLifeHours`/`setEventRetention`/
   * `setDecayClock` が共通して使う——UPSERT のたびに「他の列は DB 側の DEFAULT に任せる」
   * という Postgres 実装（`PostgresTenantSettingsStore`）と同じ挙動をここでも揃える）。
   */
  private ensureRow(tenantId: string): {
    defaultHalfLifeHours: number;
    eventRetentionDays: number | null;
    decayClock: DecayClock;
    defaultHalfLifeRecalls: number;
  } {
    let row = this.rows.get(tenantId);
    if (!row) {
      row = {
        defaultHalfLifeHours: DEFAULT_HALF_LIFE_HOURS,
        eventRetentionDays: null,
        decayClock: DEFAULT_DECAY_CLOCK,
        defaultHalfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
      };
      this.rows.set(tenantId, row);
    }
    return row;
  }

  /**
   * 設定行を作る（テスト用フック）。既存の行があれば half-life だけ上書きする。
   *
   * 値域（ADR 0125）: `packages/postgres` は `tenant_settings_default_half_life_range` の
   * CHECK 制約でこれを強制する。この in-memory 実装にも同じ検査を置く——
   * ここで放置すると「本番では落ちる書き込みが手元では黙って成功する」（ADR 0047 と
   * 同じ理由。`isStrengthInRange` の使われ方を参照）。
   */
  setDefaultHalfLifeHours(tenantId: string, hours: number): void {
    if (!isHalfLifeHoursInRange(hours)) {
      throw new Error(`InMemoryTenantSettingsStore: halfLifeHours out of range (0, ∞): ${hours}`);
    }
    this.ensureRow(tenantId).defaultHalfLifeHours = hours;
  }

  async getDefaultHalfLifeHours(ctx: Ctx): Promise<number> {
    return this.rows.get(ctx.tenantId)?.defaultHalfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    const row = this.rows.get(ctx.tenantId);
    if (!row) {
      return { kind: "unset" };
    }
    if (row.eventRetentionDays === null) {
      return { kind: "unlimited" };
    }
    return { kind: "days", days: row.eventRetentionDays };
  }

  async setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
    }
    const eventRetentionDays = retention.kind === "days" ? retention.days : null;
    this.ensureRow(ctx.tenantId).eventRetentionDays = eventRetentionDays;
  }

  /**
   * [ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと1・13
   * （Issue #305）: 行が無ければ `DEFAULT_DECAY_CLOCK`（`'wall'`）——`getDefaultHalfLifeHours`
   * と同じ規律。
   */
  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    return this.rows.get(ctx.tenantId)?.decayClock ?? DEFAULT_DECAY_CLOCK;
  }

  /**
   * 不正な値は `assertValidDecayClock`（core 共有、`PostgresTenantSettingsStore.setDecayClock`
   * と同じ検証関数）で拒む——実装ごとに条件式を書き直さない。
   */
  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertValidDecayClock(clock);
    this.ensureRow(ctx.tenantId).decayClock = clock;
  }

  /**
   * ADR 0165 決めたこと3・13: 行が無ければ `DEFAULT_HALF_LIFE_RECALLS`（720）——
   * `getDefaultHalfLifeHours` と同じ規律。
   */
  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    return this.rows.get(ctx.tenantId)?.defaultHalfLifeRecalls ?? DEFAULT_HALF_LIFE_RECALLS;
  }

  /**
   * [ADR 0197](../../../../docs/decisions/0197-set-default-half-life-recalls.md):
   * `TenantSettingsStore` interface の本番の書き込み口。`setDecayClock`
   * （このファイル上）と同じ規律——不正な値は `assertValidHalfLifeRecalls`（core 共有、
   * `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls` と同じ検証関数）で拒む。
   *
   * ⚠ **これ以前はここに `setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void`
   * というテスト専用フックが在った**（`setDefaultHalfLifeHours` と対になる形。値域検査は
   * 同じ `isHalfLifeRecallsInRange`）。ADR 0197 が `TenantSettingsStore` interface に
   * 同名の本番メソッドを足したため名前が衝突し、**「本番の口だけを残す」を選んで削除した**
   * （ADR 0197「決めたこと」参照。`setDefaultHalfLifeHours` を削除しなかったのは、
   * `setDefaultHalfLifeHours` には対応する本番メソッドが無く、テスト用フックが唯一の
   * 設定手段のままだから——非対称ではなく、対称にする理由が無くなっただけである）。
   * 旧フックを直接呼んでいた外部コードがあれば、この呼び出しは
   * `store.setDefaultHalfLifeRecalls({ tenantId }, recalls)`（`Promise` を返す）に
   * 書き換える必要がある——**破壊的変更**（testkit の公開型）。
   *
   * ⚠ この列は新規作成時の初期値としてのみ使われる——既存 Memory の
   * `halfLifeRecalls`/`decayFloorSeq` はこの呼び出しでは変わらない
   * （`InMemoryMemoryStore` 側は本 ADR の対象外）。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertValidHalfLifeRecalls(recalls);
    this.ensureRow(ctx.tenantId).defaultHalfLifeRecalls = recalls;
  }

  /**
   * ADR 0165 決めたこと2・5・13: `activitySeqBacking`（コンストラクタで渡された、
   * `InMemoryMemoryStore.activitySeq` と共有する Map）を読む。**読み出し専用**——
   * 進めるのは `InMemoryMemoryStore.createRecall`（`advanceActivityClock: true`）だけ。
   * 渡されていなければ常に `0`（`FakeTenantSettingsStore` と同じ規律）。
   */
  async getActivitySeq(ctx: Ctx): Promise<number> {
    return this.activitySeqBacking?.get(ctx.tenantId) ?? 0;
  }
}
