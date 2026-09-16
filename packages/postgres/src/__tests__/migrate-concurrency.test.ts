import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationLockTimeoutError,
  MigrationLockUnavailableError,
  listMigrationFiles,
  runMigrations,
} from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * マネージャー指摘（`0002_outbox_claim_lease_index.sql` の追加で判明）: このファイルの
 * 期待値を `["0001_init.sql"]` のようにハードコードすると、`migrations/` にファイルが
 * 増えるたびに歯が転ぶ——「マイグレーションが1本のときしか通らない歯」になっていた。
 * `listMigrationFiles(DEFAULT_MIGRATIONS_DIR)` を唯一の真実の源にして、期待値を
 * そこから導出する（ハードコードした配列を書き換えるのではなく、導出する形にする）。
 */
const ALL_MIGRATION_FILES = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);

/**
 * `runMigrations` の排他（段階2・ADR 0017）を検査する。
 *
 * 段階1の実測（ADR 0017 §「段階1の実測」）で、まっさらな DB へ複数プロセスが同時に
 * `runMigrations` を呼ぶと**決定的に**（試行した全件で）どこかが落ちることを確認した。
 * 衝突点は `ensureMigrationsTable` の `CREATE TABLE IF NOT EXISTS` /
 * `0001_init.sql` 冒頭の `CREATE EXTENSION IF NOT EXISTS` / 同ファイルの無印
 * `CREATE TABLE` の3層に積み重なっていた。ここでは「advisory lock で塞いだこと」を
 * 直接測る——DDL の中身ではなく、`runMigrations` の入り口の排他そのものを検査対象にする。
 *
 * オーナーが引いた線（3状態を混同しないこと）に対応する4本の歯:
 * 1. 並行: N 本同時に呼んでも、DB が壊れず、実際に適用したのはちょうど1本。
 * 2. 待った→取れた: 先客が少し後に手放す。`lock.waitedMs` に待った時間が乗る。
 * 3. 待った→時間切れ: 先客が手放さない。`MigrationLockTimeoutError` で落ちる
 *    （黙って続行して成功しない）。
 * 4. ロック機構が使えなかった: `pg_advisory_lock` の実行権限が無いロールで呼ぶと
 *    `MigrationLockUnavailableError` で落ちる（時間切れと取り違えない）。
 *
 * ## なぜテストごとに独立したデータベースを作るのか
 *
 * `migrate-ledger-handover.test.ts` と同じ理由（同ファイル冒頭のコメント参照）:
 * advisory lock はデータベースへの接続（session）単位ではなく**データベースクラスタ
 * 全体で共有される名前空間**を持つため、他のテストファイルが同じ `MIGRATION_LOCK_KEY`
 * を使っていても、DB を分ければ「まっさらな DB に対する migrate」という前提までは
 * 独立に保てる。ロックそのものの独立性は歯3・4で `lockKey` オプションを都度変えて確保する
 * （同じ DB を複数の it() が使い回すため、鍵を共有すると前の it() のロック残骸に当たる
 * リスクがある）。
 */

const DB_CONCURRENT = "mnemora_lock_concurrent";
const DB_WAITED = "mnemora_lock_waited";
const DB_TIMEOUT = "mnemora_lock_timeout";
const DB_UNAVAILABLE = "mnemora_lock_unavailable";

const RESTRICTED_ROLE = "mnemora_lock_denied_role";
/**
 * 歯4専用の固定パスワード。値そのものに意味は無く、CI（scram/md5 認証）で
 * このロールに実際に接続できることが目的（詳細は下の `connectionStringFor` のコメント）。
 */
const RESTRICTED_ROLE_PASSWORD = "mnemora-lock-denied-role-password";

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/**
 * `user` を指定するときは `password` も明示的に渡すこと。
 *
 * `requireDatabaseUrl()` のパスワードは管理接続ロール（`postgres` 等）のものであり、
 * `url.username` だけ差し替えて `url.password` を残すと、**別ロールへ管理ロールの
 * パスワードを流用してしまう。** 手元の `trust` 認証ではパスワードを検査しないため
 * これで繋がってしまい問題が顕在化しないが、CI の scram/md5 認証では
 * `password authentication failed for user "..."` で接続そのものが落ちる
 * ——「ロック機構が使えない」ではなく「そもそも繋がらない」を測ってしまい、
 * 歯が空振りする（実際に CI で踏んだ）。
 */
function connectionStringFor(
  database: string,
  credentials?: { user: string; password: string },
): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

async function createBlankDatabase(database: string): Promise<Pool> {
  // FORCE を使わない理由は temp-database.ts 冒頭のコメント（ADR 0020）を参照。
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 10 });
  openedPools.push(pool);
  return pool;
}

/**
 * 別セッションから advisory lock を握る（テストの「先客」役）。
 *
 * この client も `openedPools` に登録し、`afterAll` の一括 `pool.end()` に委ねる
 * （以前は登録されておらず、`afterAll` が把握しないまま残る接続だった）。
 * `release()` はロックを手放すことだけを担い、pool を閉じるのは `afterAll` の役目に
 * 一本化する——同じ pool を2箇所で `end()` すると `pg-pool` が
 * 「Called end on pool more than once」で例外を投げるため。
 */
async function grabLockFromAnotherSession(
  database: string,
  lockKey: bigint,
): Promise<{ release: () => Promise<void> }> {
  const client = new Pool({ connectionString: connectionStringFor(database), max: 1 });
  openedPools.push(client);
  await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
  return {
    release: async () => {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
    },
  };
}

describe("runMigrations の排他（advisory lock）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    if (adminPool) {
      await adminPool.query(`DROP OWNED BY ${RESTRICTED_ROLE}`).catch(() => {});
      await adminPool.query(`DROP ROLE IF EXISTS ${RESTRICTED_ROLE}`).catch(() => {});
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  // 歯1: 並行して呼んでも DB は壊れず、実際に適用したのはちょうど1本だけ。
  //
  // **この歯に変異（ロックを外す）を当てると赤くなることを確かめてある
  // （PR 本文に diff と出力を記載）。** 段階1の実測では、この形（まっさらな DB へ
  // N=4 同時）は 12/12 決定的に落ちた。
  it("まっさらな DB へ4プロセス相当が同時に migrate しても、成功しかつ適用は1本だけ", async () => {
    const pool = await createBlankDatabase(DB_CONCURRENT);
    // 各「プロセス」に見立てて、コネクションプールを分ける
    // （同一 Pool を共有すると論理的な区別が付かないため）。
    const pools = Array.from(
      { length: 4 },
      () => new Pool({ connectionString: connectionStringFor(DB_CONCURRENT), max: 2 }),
    );
    openedPools.push(...pools);

    const results = await Promise.all(pools.map((p) => runMigrations(p)));

    const appliedCounts = results.map((r) => r.applied.length);
    // 4本のうち、実際にファイルを適用した「プロセス」はちょうど1本（他はロック待ちの後
    // 「もう適用済み」を見て何もしない）。何本を適用したか（ファイル数）はここでは
    // 問わない——ハードコードした「1」ではなく「未適用ファイルの総数」で測る
    // （マネージャー指摘: migrations/ にファイルが増えるたびに歯が転んでいた）。
    expect(appliedCounts.filter((n) => n > 0)).toHaveLength(1);
    expect(appliedCounts.reduce((a, b) => a + b, 0)).toBe(ALL_MIGRATION_FILES.length);

    // 全員の lock.waitedMs が観測できている（数値であること）。
    for (const r of results) {
      expect(typeof r.lock.waitedMs).toBe("number");
      expect(r.lock.waitedMs).toBeGreaterThanOrEqual(0);
    }

    // DB は完全な状態に落ち着いている（8テーブル・台帳1行）。中途半端な状態が残らない。
    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC",
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      "_mnemora_migrations",
      "memories",
      "memory_events",
      "observations",
      "outbox",
      "recall_usages",
      "recalls",
      "tenant_activity",
      "tenant_settings",
    ]);
    const ledger = await pool.query<{ name: string }>(
      "SELECT name FROM _mnemora_migrations ORDER BY name ASC",
    );
    expect(ledger.rows).toEqual(ALL_MIGRATION_FILES.map((name) => ({ name })));
  }, 20_000);

  // 歯2: 先客が少し後に手放す → 待って取れる。待ったことが戻り値に出る。
  it("先客が手放すまで待ってから migrate が進み、待った時間が戻り値に出る", async () => {
    const lockKey = 111111111111111n;
    const pool = await createBlankDatabase(DB_WAITED);
    const holder = await grabLockFromAnotherSession(DB_WAITED, lockKey);

    const HOLD_MS = 1500;
    const releaseTimer = setTimeout(() => {
      void holder.release();
    }, HOLD_MS);

    const startedAt = Date.now();
    const result = await runMigrations(pool, undefined, { lockKey, lockTimeoutMs: 10_000 });
    const elapsedMs = Date.now() - startedAt;

    clearTimeout(releaseTimer);
    // 待った分だけ経過している。多少の余裕を見て HOLD_MS の半分以上とする。
    expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);
    expect(result.lock.waitedMs).toBeGreaterThanOrEqual(HOLD_MS / 2);
    expect(result.applied).toEqual(ALL_MIGRATION_FILES);
  }, 20_000);

  // 歯3: 先客が手放さない → 時間切れで落ちる。黙って続行して成功してはならない。
  //
  // **この歯に変異（ロックを外す）を当てると、時間切れにならず普通に成功して赤くなる
  // ことを確かめてある。**
  it("先客が手放さないと、短いタイムアウトで MigrationLockTimeoutError を投げる（黙って続行しない）", async () => {
    const lockKey = 222222222222222n;
    const pool = await createBlankDatabase(DB_TIMEOUT);
    const holder = await grabLockFromAnotherSession(DB_TIMEOUT, lockKey);

    try {
      await expect(
        runMigrations(pool, undefined, { lockKey, lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

      // 時間切れの後、DB には何も作られていない（黙って続行していない証拠）。
      const tables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await holder.release();
    }
  }, 20_000);

  // 歯4: ロック機構自体が使えない（権限が無い）→ 時間切れとは別のエラーで落ちる。
  //
  // 本物の PostgreSQL で作る: 通常ロールを作り、`pg_advisory_lock(bigint)` の
  // EXECUTE 権限を PUBLIC から剥奪する。superuser（テスト全体の接続ロール）は
  // 権限チェックを一切迂回するため、この検査だけは非 superuser の別ロールで接続する。
  it("advisory lock を取る権限が無いロールで呼ぶと、MigrationLockUnavailableError を投げる（時間切れと区別できる）", async () => {
    const lockKey = 333333333333333n;
    const pool = await createBlankDatabase(DB_UNAVAILABLE);

    // パスワードは固定で作る/更新する（既存ロールが残っていても揃える）。
    // トークンを $1 で渡せない（DO ブロックはリテラル文字列を要求する）ため、
    // 値は定数の `RESTRICTED_ROLE_PASSWORD` のみを埋め込む。
    await admin().query(
      `DO $do$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RESTRICTED_ROLE}') THEN
             CREATE ROLE ${RESTRICTED_ROLE} LOGIN PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
           ELSE
             ALTER ROLE ${RESTRICTED_ROLE} PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
           END IF;
         END $do$;`,
    );
    const restrictedPool = new Pool({
      connectionString: connectionStringFor(DB_UNAVAILABLE),
      max: 1,
    });
    await restrictedPool.query(`GRANT CONNECT ON DATABASE ${DB_UNAVAILABLE} TO ${RESTRICTED_ROLE}`);
    await restrictedPool.query(`REVOKE EXECUTE ON FUNCTION pg_advisory_lock(bigint) FROM PUBLIC`);
    await restrictedPool.end();

    const deniedPool = new Pool({
      connectionString: connectionStringFor(DB_UNAVAILABLE, {
        user: RESTRICTED_ROLE,
        password: RESTRICTED_ROLE_PASSWORD,
      }),
      max: 1,
    });
    openedPools.push(deniedPool);

    try {
      await expect(
        runMigrations(deniedPool, undefined, { lockKey, lockTimeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(MigrationLockUnavailableError);

      // ロック取得の時点で止まっているので、DB には何も作られていない
      // （時間切れ（歯3）と同じく、黙って続行していない証拠）。
      const tables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(tables.rows).toEqual([]);
    } finally {
      // PUBLIC への EXECUTE を元に戻す（このデータベースは afterAll で丸ごと
      // 捨てるので実害は無いが、「取り消した権限は取り消した先で戻す」を徹底する）。
      const restorePool = new Pool({
        connectionString: connectionStringFor(DB_UNAVAILABLE),
        max: 1,
      });
      await restorePool.query(`GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO PUBLIC`);
      await restorePool.end();
    }
  }, 20_000);
});
