import {
  assertValidEventRetentionDays,
  DEFAULT_HALF_LIFE_HOURS,
  isHalfLifeHoursInRange,
} from "@mnemora/core";
import type {
  Ctx,
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
    { defaultHalfLifeHours: number; eventRetentionDays: number | null }
  >();

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
    const row = this.rows.get(tenantId);
    if (row) {
      row.defaultHalfLifeHours = hours;
    } else {
      this.rows.set(tenantId, { defaultHalfLifeHours: hours, eventRetentionDays: null });
    }
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
    const row = this.rows.get(ctx.tenantId);
    if (row) {
      row.eventRetentionDays = eventRetentionDays;
    } else {
      this.rows.set(ctx.tenantId, {
        defaultHalfLifeHours: DEFAULT_HALF_LIFE_HOURS,
        eventRetentionDays,
      });
    }
  }
}
