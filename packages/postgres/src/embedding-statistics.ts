import { sql } from "drizzle-orm";
import type { EmbeddingSpaceId } from "@mnemora/core";
import type { Db } from "./client.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";

/**
 * Issue #360 / ADR 0194: `registerEmbeddingSpace` が作る `memory_embeddings_*` を
 * `ANALYZE` する production 経路が存在しなかった問題への対処。
 *
 * ## 何が起きていたか（Issue #360、【受】——この PR では再現していない）
 *
 * 新しい埋め込み空間へ大量投入した直後、`pg_class.reltuples` が更新されるまでの間、
 * 段1（ANN）の `PostgresVectorStore.search()` は HNSW 索引を選ばない
 * （プランナが行数を見誤るため）。Issue #360 の実測: 100,000行、`ANALYZE` 前は
 * 342.354ms（Nested Loop 経由）、`ANALYZE` 後は 0.981ms（HNSW 経由）——約350倍。
 * HNSW が選ばれ始める規模は約2,000行だった（同issue の表）。
 *
 * ## この対処の形（マネージャーが決めた設計。詳細は ADR 0194）
 *
 * `PostgresVectorStore.upsert` が呼ばれるたびに、**このプロセスが upsert で書いた行数**を
 * 埋め込み空間（テーブル）ごとに数える。その累計が**等比の閾値**
 * （{@link INITIAL_ANALYZE_THRESHOLD} から倍々——1,000 / 2,000 / 4,000 / …）の
 * ちょうどに達したときだけ、`pg_class.reltuples` を1回読み、**それがこのプロセスの
 * 書いた行数より小さければ** `ANALYZE` を撃つ。閾値に達していない呼び出し・
 * 統計が既に十分な呼び出しは、カウンタの加算以外のコストを一切払わない。
 *
 * - **新しい空間への大量投入**: `reltuples` は PG14+ で「一度も ANALYZE していない」
 *   表について `-1` を返す ⟹ 1,000行時点で必ず `-1 < 1000` が成立し、必ず撃つ。
 * - **既に育って統計のある空間**: `reltuples`（例 1,000,000）がこのプロセスの
 *   書いた行数を上回る ⟹ 一度も撃たない。定常運用に恒久的な費用を足さない。
 * - 等比なので、投入行数に対して `ANALYZE` を撃つ回数は O(log n)。
 *
 * ## 増やす費用（正直に書く）
 *
 * - 閾値を跨いだときだけ `pg_class` を1回読む（空間・プロセスあたり高々 log₂(n) 回）。
 *   それ以外の `upsert` はカウンタの加算だけ。
 * - 統計が本当に遅れているときだけ `ANALYZE` が走る。その費用は Issue #360 の実測で
 *   100,000行 388ms——⚠ **この PR では再測していない**。
 * - `ANALYZE` は `ShareUpdateExclusiveLock` を取る（ADR 0143 決定3、PostgreSQL 公式文書
 *   からの引用）——同じ表への `ANALYZE` 同士は直列化するが、通常の読み書き
 *   （`SELECT`/`INSERT`/`UPDATE`/`DELETE`）とは競合しない。
 * - **プロセスが再起動するとカウンタが0に戻る** ⟹ 閾値の確認が一巡だけ余計に走りうる。
 *   `reltuples` の guard があるので、統計が足りていれば `ANALYZE` は撃たれない。
 * - **複数プロセスが並行して書くと、それぞれが自分のカウンタで判定する** ⟹ `ANALYZE` が
 *   重複して撃たれうる。害は無い（冪等・直列化されるだけ）——プロセス間の協調機構は
 *   意図的に1つも足していない。
 *
 * ## 採らなかった案（ADR 0194 に詳細）
 *
 * - `registerEmbeddingSpace` が `CREATE INDEX` 直後に撃つ: ADR 0143 と同じ構造的却下
 *   （唯一の production 呼び出し元は表が空の時点でしか呼ばれない）。
 * - `runAnalyzeMemories`/`--analyze-memories` を埋め込み表へ広げる: opt-in であり、
 *   「採用者が呼ぶことを覚えている」ことに依存する。落とさないが本 PR ではやらない。
 * - `tick()` の embed ジョブが閾値を見て撃つ: `packages/core` を触ることになり、
 *   別issueで進行中の変更と衝突する。プロセス間協調も新たに要る。
 * - 何もしない: 窓（20〜40秒〜、環境依存）が「採用者が初回投入直後に最初の想起をする」
 *   瞬間に開き、しかも原因が採用者から見えない。
 * - `registerEmbeddingSpace` の `CREATE TABLE` 直後に `autovacuum_analyze_scale_factor`/
 *   `threshold` をテーブル単位で変える: 初回の窓を縮めない（下限は `autovacuum_naptime`
 *   であり、テーブル単位の設定では動かない）。かつ「大きな表に少量追記」のケースで
 *   プラン選択そのものは変わらない（統計のずれと索引が選ばれないことは別の問題）。
 */

/** 等比の閾値の初項。以後は倍々（1,000 / 2,000 / 4,000 / …）。 */
export const INITIAL_ANALYZE_THRESHOLD = 1000;

/**
 * `count` が、初項 `initialThreshold` から始まる等比数列
 * （`initialThreshold`, `initialThreshold * 2`, `initialThreshold * 4`, …）の
 * ちょうどどれかに一致するかどうかを判定する純関数。DB 接続を要さない。
 *
 * `EmbeddingUpsertCounter`（このファイルの `maybeAnalyzeAfterUpsert`）は `upsert` の
 * たびにテーブルごとの累計を1ずつ増やすので、「累計が閾値を跨いだ」ことと
 * 「累計がちょうど閾値の値になった」ことは同値になる——増分が常に1だから、閾値を
 * 跨ぐ呼び出しは必ず「ちょうどその値になる呼び出し」でもある。
 *
 * 境界の扱い（(丙) の歯が検査する）:
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
 * プロセスローカルの upsert 累計カウンタ。埋め込みテーブル名をキーにする
 * （`EmbeddingSpaceId` そのものではなく、導出済みのテーブル名——同じテーブルを
 * 指す `EmbeddingSpaceId` の値が複数生成されても同じキーに落ちるようにする）。
 *
 * プロセスが再起動すればこの Map ごと消える（意図した振る舞い。上のクラス doc 参照）。
 */
const upsertCountsByTable = new Map<string, number>();

/** テスト専用: プロセスローカルのカウンタを空にする。production コードからは呼ばない。 */
export function resetEmbeddingUpsertCountersForTesting(): void {
  upsertCountsByTable.clear();
}

export interface MaybeAnalyzeAfterUpsertResult {
  /** 対象テーブル名。 */
  table: string;
  /** この呼び出しを含む、このプロセスがこのテーブルに `upsert` した累計行数。 */
  count: number;
  /** この呼び出しで実際に `ANALYZE` を撃ったかどうか。 */
  analyzed: boolean;
}

/**
 * `pg_class.reltuples` を1回読む。表が存在しない・一度も ANALYZE されていない場合、
 * PostgreSQL は `-1` を返す（PG14+、「まだ ANALYZE されていない」ことの符号）。
 * `to_regclass` が解決できない場合（行が無い）は `undefined` を返す——
 * 呼び出し側はこれを「統計が無い」と同じ扱い（`ANALYZE` を撃つ）にする。
 */
async function readReltuples(db: Db, table: string): Promise<number | undefined> {
  const result = await db.execute(sql`
    SELECT reltuples FROM pg_class WHERE oid = to_regclass(${table})
  `);
  const row = result.rows[0] as { reltuples: unknown } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return Number(row.reltuples);
}

/**
 * `PostgresVectorStore.upsert` の末尾から呼ぶ。カウンタを1増やし、等比の閾値
 * （{@link isGeometricAnalyzeThreshold}）を跨いだときだけ `pg_class.reltuples` を読み、
 * それがこのプロセスの書いた累計行数より小さければ `ANALYZE <table>` を撃つ。
 *
 * 閾値に達していない・統計が既に十分な呼び出しは、カウンタの加算以外のコストを
 * 一切払わない（`pg_class` すら読まない）。
 */
export async function maybeAnalyzeAfterUpsert(
  db: Db,
  space: EmbeddingSpaceId,
): Promise<MaybeAnalyzeAfterUpsertResult> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);

  const count = (upsertCountsByTable.get(table) ?? 0) + 1;
  upsertCountsByTable.set(table, count);

  if (!isGeometricAnalyzeThreshold(count)) {
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
