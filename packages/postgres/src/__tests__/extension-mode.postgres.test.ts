import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MissingExtensionsError, REQUIRED_EXTENSIONS, runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `vector` だけが未設置の DB に、`CREATE EXTENSION` 権限を持たないロールで接続する状況を作る。
 *
 * `IF NOT EXISTS` 付きで指定した拡張が既に存在する場合、PostgreSQL の `CreateExtension()` は既存を検出した時点で早期リターンし、
 * 権限チェックに到達しない。そのため拡張が全部揃っている状況では、`extensionMode: "create"`（既定）も権限の無いロールで成功する。
 * verify モードの意味は「`CREATE EXTENSION` 文を一切送らない」ことそのものであり、「揃っている場合に create モードが落ちる」という主張ではない。
 * create と verify の生の失敗を対照する測定4は、「拡張が足りない」状況でだけ行う。
 * 測定4・5は `CREATE EXTENSION` の権限を持たない実ロールを使い、測定5は測定4の低権限ロールの土台（`ensureRestrictedRole`）を共有する。
 * 測定5は、拡張が全部設置済みの DB に権限の無いロールで既定モードのまま `runMigrations` を呼ぶと成功することを実測で確かめる。
 */

const DB_ALL_PRESENT = "mnemora_extmode_all_present";
const DB_SCHEMA_VERIFY = "mnemora_extmode_schema_verify";
const DB_MISSING_VERIFY = "mnemora_extmode_missing_verify";
const DB_MISSING_CREATE_DEFAULT = "mnemora_extmode_missing_create_default";
const DB_MISSING_VERIFY_CLI = "mnemora_extmode_missing_verify_cli";
const DB_RESTRICTED_ROLE = "mnemora_extmode_restricted_role";
const DB_ALL_PRESENT_RESTRICTED_ROLE = "mnemora_extmode_all_present_restricted_role";

const RESTRICTED_ROLE = "mnemora_extmode_denied_role";
/** 値そのものに意味は無い。CI（scram/md5 認証）でこのロールに実際に接続できることが目的。 */
const RESTRICTED_ROLE_PASSWORD = "mnemora-extmode-denied-role-password";

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/** `user` を指定するときは `password` も明示的に渡すこと。`url.password` を残したまま `url.username` だけ差し替えると、別ロールへ管理ロールのパスワードを流用して、CI の scram/md5 認証で別の失敗に化ける。 */
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

/** 使い捨てのデータベースを作り、専用の Pool を返す（`temp-database.ts` の作法どおり FORCE を使わない）。 */
async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 5 });
  openedPools.push(pool);
  return pool;
}

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const MIGRATE_ENTRY = path.join("src", "bin", "migrate.ts");

/**
 * CLI を子プロセスとして起動する（`migrate-cli-schema.postgres.test.ts` と同じ形。`dist` に依存しないよう `tsx` で `src` を叩く）。
 * `env` は `process.env` をそのまま渡さない——`PATH` と、渡したものだけ。
 */
async function runMigrateCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [MIGRATE_ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof failure.code === "number" ? failure.code : 1;
    return { exitCode: code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** `table`（裸の名前、既定の search_path = public）が存在するかどうか。 */
async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [
    table,
  ]);
  return rows[0]!.oid !== null;
}

/** `RESTRICTED_ROLE`（`CREATE EXTENSION` に要る権限を一切持たないロール）を用意する。既に存在すればパスワードを合わせるだけ（冪等）。 */
async function ensureRestrictedRole(): Promise<void> {
  await admin().query(
    `DO $do$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RESTRICTED_ROLE}') THEN
           CREATE ROLE ${RESTRICTED_ROLE} LOGIN PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
         ELSE
           ALTER ROLE ${RESTRICTED_ROLE} PASSWORD '${RESTRICTED_ROLE_PASSWORD}';
         END IF;
       END $do$;`,
  );
}

describe("extensionMode: 'verify'（ADR 0093、本物の PostgreSQL）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("測定1: 拡張が全部揃っていれば、CREATE EXTENSION を発行せずに一式が出来る", async () => {
    const pool = await createBlankDatabase(DB_ALL_PRESENT);
    for (const ext of REQUIRED_EXTENSIONS) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }

    const result = await runMigrations(pool, undefined, { extensionMode: "verify" });

    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    expect(await tableExists(pool, "observations")).toBe(true);
    expect(await tableExists(pool, "memories")).toBe(true);
  });

  it("測定1b: 専用スキーマ（経路1）でも verify は CREATE EXTENSION を発行せず、CREATE SCHEMA は今日どおり発行する", async () => {
    const pool = await createBlankDatabase(DB_SCHEMA_VERIFY);
    for (const ext of REQUIRED_EXTENSIONS) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }

    const result = await runMigrations(pool, undefined, {
      schema: "mnemora_ext_verify",
      extensionMode: "verify",
    });

    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    const { rows } = await pool.query<{ oid: string | null }>(
      `SELECT to_regclass('"mnemora_ext_verify"."observations"')::text AS oid`,
    );
    expect(rows[0]!.oid, "専用スキーマ側に observations が作られていること").not.toBeNull();
  });

  it("測定2: 拡張が足りない（virchamate の実例どおり vector だけ無い）と MissingExtensionsError で落ち、DB に何も作らない", async () => {
    const pool = await createBlankDatabase(DB_MISSING_VERIFY);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    const err = await runMigrations(pool, undefined, { extensionMode: "verify" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MissingExtensionsError);
    expect((err as MissingExtensionsError).missing).toEqual(["vector"]);
    expect((err as MissingExtensionsError).message).toContain(
      "CREATE EXTENSION IF NOT EXISTS vector;",
    );
    expect(await tableExists(pool, "observations")).toBe(false);
  });

  it("測定3（対照）: 同じ状況で create モード（既定）は superuser なら今日どおり成功する（既定の挙動は変えていない）", async () => {
    const pool = await createBlankDatabase(DB_MISSING_CREATE_DEFAULT);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    const result = await runMigrations(pool);

    expect(result.extensionCheck).toBeUndefined();
    expect(await tableExists(pool, "observations")).toBe(true);
  });

  // `packages/postgres/README.md` の CLI の節: `--extension-mode verify` は何も発行せず `pg_extension` を読み、
  // 足りない拡張があれば拡張名と実行すべき SQL を示して失敗する。測定2と同じ状況を、CLI の配線ごと見る。
  it("測定2b: CLI の --extension-mode verify も、拡張が足りない DB では拡張名と SQL を示して終了コード1で止まり、拡張も表も作らない", async () => {
    const pool = await createBlankDatabase(DB_MISSING_VERIFY_CLI);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    const cli = await runMigrateCli(["--extension-mode", "verify"], {
      DATABASE_URL: connectionStringFor(DB_MISSING_VERIFY_CLI),
    });

    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toContain("CREATE EXTENSION IF NOT EXISTS vector;");
    const { rows } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(rows).toEqual([]);
    expect(await tableExists(pool, "observations")).toBe(false);
  });

  it("測定4: CREATE EXTENSION 権限を持たない実ロールで virchamate の状況を再現する——create モードは生の権限エラーで落ち、verify モードは制御されたエラーで落ち、拡張が揃った後は同じロールで成功する", async () => {
    const pool = await createBlankDatabase(DB_RESTRICTED_ROLE);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // 既定で public への CREATE を PUBLIC から剥奪しているとは限らないので、イメージの初期化スクリプトに依存せず明示的に剥奪する。
    await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

    await ensureRestrictedRole();
    await pool.query(`GRANT CONNECT ON DATABASE ${DB_RESTRICTED_ROLE} TO ${RESTRICTED_ROLE}`);
    // RESTRICTED_ROLE 自身には schema public への CREATE を戻す。`runMigrations` は `extensionMode` に関わらず自分の台帳とアプリのテーブルを作る必要があるため。
    // ⭐ vector は trusted = false（superuser 必須）であることが測定4a・4b の成立条件で、このロールが create/verify どちらのモードでも自力で vector を作れてはいけない。
    await pool.query(`GRANT CREATE ON SCHEMA public TO ${RESTRICTED_ROLE}`);

    // `max: 2` にすること（`max: 1` にしない）。`runMigrations` は advisory lock 用のコネクションを1本借り切ったまま、
    // 本体の DDL がさらにもう1本を要求する。`max: 1` だと2本目がプールの空きを待ち続け、`connectionTimeoutMillis` を設定していないこのプールには待ちの上限が無いので、永久に止まる。
    const restrictedPool = new Pool({
      connectionString: connectionStringFor(DB_RESTRICTED_ROLE, {
        user: RESTRICTED_ROLE,
        password: RESTRICTED_ROLE_PASSWORD,
      }),
      max: 2,
    });
    openedPools.push(restrictedPool);

    const createModeErr = await runMigrations(restrictedPool).catch((e: unknown) => e);
    expect(createModeErr).toBeInstanceOf(Error);
    expect(createModeErr).not.toBeInstanceOf(MissingExtensionsError);
    // 文言の先頭は変えない（先頭を正規表現で拾う呼び手が居うる）。どうすればよいかは、その後ろに足す。
    const createModeMessage = (createModeErr as Error).message;
    expect(createModeMessage).toMatch(
      /^migration 0001_init\.sql failed: permission denied to create extension "vector"/,
    );
    expect(((createModeErr as Error).cause as { code?: unknown }).code).toBe("42501");
    expect(createModeMessage).toContain('extensionMode: "verify"');
    expect(createModeMessage).toContain("--extension-mode verify");
    expect(await tableExists(pool, "observations")).toBe(false);

    const verifyModeErr = await runMigrations(restrictedPool, undefined, {
      extensionMode: "verify",
    }).catch((e: unknown) => e);
    expect(verifyModeErr).toBeInstanceOf(MissingExtensionsError);
    expect((verifyModeErr as MissingExtensionsError).missing).toEqual(["vector"]);
    expect(await tableExists(pool, "observations")).toBe(false);

    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    const result = await runMigrations(restrictedPool, undefined, { extensionMode: "verify" });
    expect(result.extensionCheck).toEqual({ verified: REQUIRED_EXTENSIONS });
    expect(await tableExists(pool, "observations")).toBe(true);
  });

  it("測定5: 拡張が既に全部揃っていれば、CREATE EXTENSION 権限を持たないロールでも既定（create）モードのまま成功する（早期リターンの実測）", async () => {
    const pool = await createBlankDatabase(DB_ALL_PRESENT_RESTRICTED_ROLE);
    for (const ext of REQUIRED_EXTENSIONS) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }

    await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

    await ensureRestrictedRole();
    await pool.query(
      `GRANT CONNECT ON DATABASE ${DB_ALL_PRESENT_RESTRICTED_ROLE} TO ${RESTRICTED_ROLE}`,
    );
    await pool.query(`GRANT CREATE ON SCHEMA public TO ${RESTRICTED_ROLE}`);

    const restrictedPool = new Pool({
      connectionString: connectionStringFor(DB_ALL_PRESENT_RESTRICTED_ROLE, {
        user: RESTRICTED_ROLE,
        password: RESTRICTED_ROLE_PASSWORD,
      }),
      max: 2,
    });
    openedPools.push(restrictedPool);

    // extensionMode を指定しない（既定 = "create"）。拡張は全部既に存在するので、権限チェックに到達する前に早期リターンする。
    const result = await runMigrations(restrictedPool);

    expect(result.extensionCheck).toBeUndefined();
    expect(await tableExists(pool, "observations")).toBe(true);
  });
});
