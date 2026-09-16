import type { Ctx } from "./ctx.js";
import type { MemoryStore, PurgeExpiredEventsResult } from "./interfaces/memory-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";

/**
 * Issue #210 / [ADR 0115](../../../docs/decisions/0115-event-retention-purge.md):
 * `TenantSettingsStore.getEventRetention`（ADR 0050）が返す3状態（`unset`/`unlimited`/
 * `days`）と、`MemoryStore.purgeExpiredEvents?`（任意メソッド、ADR 0115）の
 * 有無を1つの結果に落とす。**`unset` と `unlimited` を同じ顔で返さない**——
 * 呼び出し側（運用ジョブ）が「まだ設定していないテナント」と「明示的に無期限を選んだ
 * テナント」を区別できることを、この関数の返り値でも保つ（ADR 0050 が
 * `TenantSettingsStore.getEventRetention` 自体で守った区別を、ここで潰さない）。
 *
 * - `{ kind: "unset" }` — テナントが event retention を一度も設定していない。
 *   **`memoryStore` には一切触れない**（削除しない理由が「無期限」の一種であり、
 *   store 側の対応の有無を問う必要が無いため）。
 * - `{ kind: "unlimited" }` — テナントが明示的に無期限を選んだ。同上、`memoryStore` に
 *   触れない。
 * - `{ kind: "store_unsupported" }` — 保持期間は有限日数だが、渡された `MemoryStore`
 *   実装が `purgeExpiredEvents` を持たない（任意メソッド未実装の adapter）。
 *   [ADR 0100](../../../docs/decisions/0100-supersede-with-new-memories.md) の
 *   `WriteAtomicity.store_unsupported` と同じ語彙上の判断——「この adapter では
 *   構造的に縮められない」ことを、実行時エラーではなく戻り値の種類で示す。
 * - `{ kind: "executed"; result }` — `purgeExpiredEvents` を実際に呼んだ。
 *   `result` はその戻り値そのもの（`dryRun` を含む。`result.purged` が実削除件数）。
 *   🔴 **値を `"executed"` と名付け、`"purged"` にしなかった**——
 *   `packages/core/src/event.ts` の `MemoryEventKind`（`memory_events.kind` 列の型）にも
 *   同名の値 `"purged"` が存在し、`kind: "purged"` という同じ文字面のオブジェクトリテラルに
 *   なる。両者は無関係の型（あちらは物理削除イベント種別——Issue #198 / ADR 0124で
 *   実装済み、こちらはこのオーケストレータの実行結果）だが、
 *   [ADR 0117](../../../docs/decisions/0117-unreachable-union-values-inventory.md)
 *   の回帰テスト（`unreachable-union-values.test.ts`）は型を見ずテキスト一致で
 *   `kind: "purged"` を探すため、同じ文字列を使うと「`MemoryEventKind.purged` が
 *   生成された」という偽陽性になる。**文字列が衝突するなら、文字列を変えて衝突を解消する**
 *   ——ADR 0117 側のテキストスキャンを型認識に書き換える負担を、無関係な本 PR に持ち込まない。
 */
export type PurgeExpiredEventsForTenantOutcome =
  | { kind: "unset" }
  | { kind: "unlimited" }
  | { kind: "store_unsupported" }
  | { kind: "executed"; result: PurgeExpiredEventsResult };

/**
 * {@link purgeExpiredEventsForTenant} の引数。
 */
export interface PurgeExpiredEventsForTenantOptions {
  /**
   * 1回の呼び出しで削除する上限。**必須・既定値なし**——
   * {@link MemoryStore.purgeExpiredEvents} の `opts.limit` へそのまま渡す
   * （`ClaimOutboxJobsOptions.leaseMs` と同じ理由。取り消せない削除の上限を
   * `packages/core` が勝手に決めない）。
   */
  limit: number;
  /**
   * `true` なら削除もイベント追記も行わず、何が起きるかだけを返す。省略時は `false`。
   */
  dryRun?: boolean;
  /**
   * 「いま」を何とするか。省略時は `new Date()`。テストが決定的な cutoff を
   * 固定するために上書きできる。
   */
  now?: Date;
}

/**
 * Issue #210 / ADR 0115: `TenantSettingsStore.getEventRetention` を読み、有限日数
 * （`{ kind: "days" }`）のときだけ `MemoryStore.purgeExpiredEvents` を呼ぶ。
 *
 * 🔴 **この関数はどこからも自動的に呼ばれない。** `runtime.tick()` にも
 * `runtime.observe()` にも配線しない——設計上の注意7（Issue #210 本文）が
 * 「自動実行しないこと。`tick()` にも `observe()` にも相乗りさせない。明示呼び出しのみ」
 * と明示している。呼び出すのは運用側のスクリプト・cron・別途の保守ジョブの責務であり、
 * `packages/core` はその「呼ぶための部品」だけを提供する。
 *
 * cutoff（`olderThan`）は `opts.now`（省略時 `new Date()`）から
 * `retention.days` 日ぶん遡った時刻として、ここで計算する——
 * {@link MemoryStore.purgeExpiredEvents} 自身は「日数」を知らず、常に確定済みの
 * `Date` だけを受け取る（単体で決定的にテストできるようにするため）。
 */
export async function purgeExpiredEventsForTenant(
  ctx: Ctx,
  deps: { memoryStore: MemoryStore; tenantSettingsStore: TenantSettingsStore },
  opts: PurgeExpiredEventsForTenantOptions,
): Promise<PurgeExpiredEventsForTenantOutcome> {
  const retention = await deps.tenantSettingsStore.getEventRetention(ctx);
  if (retention.kind === "unset") {
    return { kind: "unset" };
  }
  if (retention.kind === "unlimited") {
    return { kind: "unlimited" };
  }
  if (!deps.memoryStore.purgeExpiredEvents) {
    return { kind: "store_unsupported" };
  }
  const now = opts.now ?? new Date();
  const olderThan = new Date(now.getTime() - retention.days * 24 * 60 * 60 * 1000);
  const result = await deps.memoryStore.purgeExpiredEvents(ctx, {
    olderThan,
    limit: opts.limit,
    dryRun: opts.dryRun,
  });
  return { kind: "executed", result };
}
