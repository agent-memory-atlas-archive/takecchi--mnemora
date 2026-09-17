import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Issue #269: ADR 0194 が `packages/postgres/src/embedding-statistics.ts` に入れた
 * 「このプロセスが書いた行数を数え、等比の閾値ちょうどで `pg_class.reltuples` を1回読み、
 * 統計が足りないときだけ `ANALYZE` を撃つ」という核を、**対象テーブル名に依存しない形**に
 * 括り出したもの。
 *
 * ## なぜ括り出したか
 *
 * ADR 0194 はこの仕組みを `memory_embeddings_*`（`EmbeddingSpaceId` から動的に導出される
 * テーブル名）専用に実装した。Issue #269 は同じ仕組みを `memories`（固定のテーブル名）にも
 * 適用したい——`PostgresVectorStore.search()` が `memories` と `JOIN` してテナントで
 * 絞るため、埋め込み表側の統計だけでは JOIN 全体のプラン選択を守れないことが、ADR 0194
 * 自身の CI 実測（「CI が実際に教えたこと」節）で判明している。
 *
 * 2箇所が同じ「カウンタ→閾値判定→reltuples guard→ANALYZE」を必要とするので、
 * このファイルに核だけを1つ置き、呼び出し元（`embedding-statistics.ts` /
 * `memories-statistics.ts`）はそれぞれ「対象テーブル名をどう決めるか」と
 * 「カウンタをどこに persist するか」だけを持つ薄いラッパーにする。
 *
 * ## このファイル自身が知らないこと
 *
 * - どのテーブルを対象にするか（呼び出し側が `table` 引数で渡す）。
 * - カウンタをどう分割するか（呼び出し側が `Map<string, number>` を渡す——
 *   埋め込み表側はテーブルごとに分けたいが、`memories` は常に1つなので
 *   呼び出し側は単一キーの `Map` を持てばよい）。
 */

/** 等比の閾値の初項。以後は倍々（1,000 / 2,000 / 4,000 / …）。 */
export const INITIAL_ANALYZE_THRESHOLD = 1000;

/**
 * `count` が、初項 `initialThreshold` から始まる等比数列
 * （`initialThreshold`, `initialThreshold * 2`, `initialThreshold * 4`, …）の
 * ちょうどどれかに一致するかどうかを判定する純関数。DB 接続を要さない。
 *
 * 呼び出し側（`maybeAnalyzeTableAfterWrite`）は書き込みのたびにテーブルごとの累計を
 * 1ずつ増やすので、「累計が閾値を跨いだ」ことと「累計がちょうど閾値の値になった」ことは
 * 同値になる——増分が常に1だから、閾値を跨ぐ呼び出しは必ず「ちょうどその値になる呼び出し」
 * でもある。
 *
 * 境界の扱い（単体テストが検査する）:
 * - `count < initialThreshold` は常に false（999 → false、1000 → true）。
 * - `initialThreshold` の倍数でも、2の累乗倍でなければ false（3000 → false、
 *   4000 → true）。
 */
export function isGeometricAnalyzeThreshold(
  count: number,
  initialThreshold: number = INITIAL_ANALYZE_THRESHOLD,
): boolean {
  if (
    !Number.isInteger(count) ||
    !Number.isInteger(initialThreshold) ||
    initialThreshold <= 0 ||
    count < initialThreshold
  ) {
    return false;
  }
  if (count % initialThreshold !== 0) {
    return false;
  }
  const ratio = count / initialThreshold;
  // ratio が2の累乗であることの判定（ratio >= 1 の整数前提。ビット演算の定石）。
  return (ratio & (ratio - 1)) === 0;
}

/**
 * `pg_class.reltuples` を1回読む。表が存在しない・一度も ANALYZE されていない場合、
 * PostgreSQL は `-1` を返す（PG14+、「まだ ANALYZE されていない」ことの符号）。
 * `to_regclass` が解決できない場合（行が無い）は `undefined` を返す——
 * 呼び出し側はこれを「統計が無い」と同じ扱い（`ANALYZE` を撃つ）にする。
 */
export async function readReltuples(db: Db, table: string): Promise<number | undefined> {
  const result = await db.execute(sql`
    SELECT reltuples FROM pg_class WHERE oid = to_regclass(${table})
  `);
  const row = result.rows[0] as { reltuples: unknown } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return Number(row.reltuples);
}

export interface MaybeAnalyzeTableResult {
  /** 対象テーブル名。 */
  table: string;
  /** この呼び出しを含む、このプロセスがこのテーブルに書き込んだ累計行数。 */
  count: number;
  /** この呼び出しで実際に `ANALYZE` を撃ったかどうか。 */
  analyzed: boolean;
}

/**
 * 書き込みのたびに呼ぶ。`counters` のうち `table` に対応する値を1増やし、等比の閾値
 * （{@link isGeometricAnalyzeThreshold}）を跨いだときだけ `pg_class.reltuples` を読み、
 * それがこのプロセスの書いた累計行数より小さければ `ANALYZE <table>` を撃つ。
 *
 * 閾値に達していない・統計が既に十分な呼び出しは、カウンタの加算以外のコストを
 * 一切払わない（`pg_class` すら読まない）。
 *
 * `counters` は呼び出し元が所有する（このファイルはテーブルごとの分割方針を知らない）。
 * `table` はこの関数を呼ぶ時点で安全な識別子であることが呼び出し元の責務
 * （`sql.identifier` に渡すため——`embedding-statistics.ts` は `assertSafeIdentifier` を
 * 経由済みのテーブル名だけを渡す。`memories-statistics.ts` は定数 `"memories"` しか渡さない）。
 */
export async function maybeAnalyzeTableAfterWrite(
  db: Db,
  table: string,
  counters: Map<string, number>,
  initialThreshold: number = INITIAL_ANALYZE_THRESHOLD,
): Promise<MaybeAnalyzeTableResult> {
  const count = (counters.get(table) ?? 0) + 1;
  counters.set(table, count);

  if (!isGeometricAnalyzeThreshold(count, initialThreshold)) {
    return { table, count, analyzed: false };
  }

  const reltuples = await readReltuples(db, table);
  if (reltuples !== undefined && reltuples >= count) {
    // 統計は既に、このプロセスが書いた行数以上を見ている ⟹ 遅れていない。撃たない。
    return { table, count, analyzed: false };
  }

  await db.execute(sql`ANALYZE ${sql.identifier(table)}`);
  return { table, count, analyzed: true };
}
