import { sql } from "drizzle-orm";
import {
  OutboxLeaseConflictError,
  type ClaimOutboxJobsOptions,
  type Ctx,
  type OutboxJobRecord,
  type OutboxStore,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { isUuidLike, rowToOutboxJob, type OutboxJobRow } from "./mapping.js";

/**
 * `OutboxStore` の Postgres 実装（roadmap.md 段階3、ADR 0005 の transactional outbox
 * 「運搬役」側）。
 *
 * `claimBatch` は `FOR UPDATE SKIP LOCKED` を使う。複数のワーカーが同時に `tick()` を
 * 呼んでも、同じ行を二重に claim しない。
 *
 * 🔴 **この2つの節は別々の仕事をしている。「`SKIP LOCKED` が在るから二重 claim は安全」と
 * 読まないこと。**
 *
 * - **二重 claim を止めているのは `FOR UPDATE` の行ロックである。** READ COMMITTED 下では、
 *   ロック待ちで止まった側はロックの解放後に行を再フェッチして `WHERE` を再評価する。
 *   先に claim した側が書いた `claimed_at` がそこで見えるため、その行は候補から外れる。
 * - **`SKIP LOCKED` が足しているのは「詰まらないこと」だけである。** 既に他のワーカーが
 *   取ろうとしている行を待たずにスキップし、次の行を取りに行く。
 *
 * 【実測】2026-09-17、`main` = `cd4d812`。手元の Postgres 17 に対し、**接続を温めた**
 * `pg.Pool`（既定 `max=10`）上で「claim 可能なジョブ1本・`limit=1`・8並行」を10ラウンド撃った:
 *
 * - `FOR UPDATE SKIP LOCKED` を**丸ごと削る**と、**10ラウンド中8ラウンドで二重 claim**
 *   （8ワーカー全員が同じ job id を返した）。
 * - `SKIP LOCKED` **だけ**を外して `FOR UPDATE` にすると、**10ラウンドとも二重 claim なし。**
 *   ⟹ `SKIP LOCKED` を外しても正しさは壊れない。
 *
 * ⚠ **`SKIP LOCKED` が実際に詰まりを減らすことは測っていない。** 上が見ているのは正しさ側
 * だけであり、「詰まらないこと」は機構からの推論である。
 *
 * 🔴 **上の ⚠ は ADR 0208 が埋めた。** `outbox-skip-locked-non-blocking.postgres.test.ts`
 * が、`claimBatch` を直接呼んで「詰まらないこと」を肯定側で検査する
 * ——外部トランザクションが唯一の候補行の行ロックを保持したまま、`lock_timeout=100ms`
 * を積んだ専用クライアントで撃ち、例外を投げずに0件で解決することを見る。
 * `SKIP LOCKED` を外すとこの歯は `55P03`（canceling statement due to lock timeout）
 * で赤くなる（変異試験は ADR 0208「測ったこと」参照）。
 * ⚠ ただし、この歯が測っているのは「ロックが在るときにブロックせず抜けられるか」という
 * *機構*であって、**実運用の throughput（単位時間あたりに何件捌けるか）そのものは、
 * この歯も含めていまだ測っていない。**
 * ⚠ **接続を温めていない `pg.Pool` に対しては、`FOR UPDATE SKIP LOCKED` を丸ごと削っても
 * 二重 claim が再現しない**【実測、同日】——遅延接続のため `Promise.all` の各呼び出しが接続
 * 確立でずれ、競争の窓が閉じる。⟹ **この振る舞いを検査する歯を書くときは、先に
 * `pool.query` を並行数ぶん撃って接続を張ること。**張らないと、歯が無くても緑になる。
 * ⚠ **10ラウンドで出なかったことは、起きないことの証明ではない。**
 *
 * 🔴 **ただし `FOR UPDATE SKIP LOCKED` の行ロックは、この SQL 文の実行（コミット）が
 * 終わった瞬間に解放される。** 「claim した」こと自体は `claimed_at`/`claimed_by` という
 * 列の値としてしか残らない。そのため `claimBatch` の `WHERE` は `claimed_at` を
 * 単に `IS NULL` で見るのではなく、**リース（ADR 0032）**——`claimed_at` が無いか、
 * `leaseMs` 以上前——で見る。`claimed_at IS NULL` だけにすると、claim 後に処理が
 * 終わらないまま止まったワーカーのジョブが `completed_at`/`failed_at` のどちらも
 * 付かないまま二度と claim されなくなる（「見えない停止」）。詳細は
 * `packages/core/src/interfaces/outbox-store.ts` の doc と ADR 0032。
 *
 * 🔴 **`complete`/`fail` は CAS（ADR 0142, Issue #233）**——`attempts` 列が呼び出し側の
 * `expectedAttempts` と一致する行だけを更新する。リースが切れて別のワーカーに再 claim
 * された後、遅れて戻ってきた古いワーカーが `complete`/`fail` を呼んでも、新しいワーカーが
 * 既に書いた終端状態を黙って上書きしない——`attempts` が一致しなければ
 * `OutboxLeaseConflictError` を投げる。詳細は `packages/core/src/interfaces/outbox-store.ts`
 * の doc と ADR 0142。
 */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db: Db) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    const kindsFilter =
      opts.kinds !== undefined ? sql`AND kind = ANY(${sql.param(opts.kinds)}::text[])` : sql``;
    // リースが切れたとみなす境界時刻。`claimed_at <= leaseExpiresBefore` の行は
    // 「十分前に claim されたまま完了していない」＝止まったワーカーの行とみなす。
    // 境界は `available_at <= opts.now` と同じ `<=`（両端含む）に揃えてある。
    const leaseExpiresBefore = new Date(opts.now.getTime() - opts.leaseMs);

    const result = await this.db.execute(sql`
      WITH claimable AS (
        SELECT id FROM outbox
        WHERE tenant_id = ${ctx.tenantId}
          AND completed_at IS NULL
          AND failed_at IS NULL
          AND available_at <= ${opts.now}
          AND (claimed_at IS NULL OR claimed_at <= ${leaseExpiresBefore})
          ${kindsFilter}
        ORDER BY available_at ASC
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox o
      SET claimed_at = ${opts.now}, claimed_by = ${opts.claimedBy}, attempts = attempts + 1
      FROM claimable c
      WHERE o.id = c.id
      RETURNING o.*
    `);
    return result.rows.map((row) => rowToOutboxJob(row as unknown as OutboxJobRow));
  }

  async complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void> {
    // id 列は uuid 型。べき等な終端更新（存在しない/形式が不正な id でも例外を投げない）
    // という契約のため、UUID の形をしていない入力はここで静かに無視する
    // （実 DB 検査で判明: 素通しすると invalid input syntax for type uuid で例外になる）。
    if (!isUuidLike(jobId)) {
      return;
    }
    const result = await this.db.execute(sql`
      UPDATE outbox
      SET completed_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId} AND attempts = ${expectedAttempts}
      RETURNING id
    `);
    if (result.rows.length > 0) {
      return;
    }
    await this.raiseIfLeaseConflict(ctx, jobId, expectedAttempts);
  }

  async fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void> {
    if (!isUuidLike(jobId)) {
      return;
    }
    const result = await this.db.execute(sql`
      UPDATE outbox
      SET failed_at = now(), last_error = ${error}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId} AND attempts = ${expectedAttempts}
      RETURNING id
    `);
    if (result.rows.length > 0) {
      return;
    }
    await this.raiseIfLeaseConflict(ctx, jobId, expectedAttempts);
  }

  /**
   * `complete`/`fail` の CAS な `UPDATE` が0行だったときに呼ぶ（ADR 0142, Issue #233）。
   * **0行になる理由は2つあり、区別する**——(a) その id の行がそもそも存在しない
   * （べき等な no-op、既存契約）、(b) 行は存在するが `attempts` が一致しない
   * （別のワーカーが既にこの行を再 claim している。{@link OutboxLeaseConflictError}）。
   * 読み直しと実際に条件が破れた瞬間の間にも別の claim が割り込む余地があるため、
   * `observedAttempts` は「弾かれた瞬間の値」の保証ではない（ADR 0030 の
   * `MemoryStatusConflictError` と同じ限界、doc コメント参照）。
   */
  private async raiseIfLeaseConflict(
    ctx: Ctx,
    jobId: string,
    expectedAttempts: number,
  ): Promise<void> {
    const current = await this.db.execute(sql`
      SELECT attempts FROM outbox WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
    `);
    const row = current.rows[0] as { attempts: number } | undefined;
    if (row === undefined) {
      // 行が無い（既に存在しない/最初から無い）。べき等な no-op のまま、例外にしない。
      return;
    }
    throw new OutboxLeaseConflictError(jobId, expectedAttempts, row.attempts);
  }
}
