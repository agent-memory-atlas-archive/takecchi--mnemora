import type { Db } from "./client.js";
import {
  INITIAL_ANALYZE_THRESHOLD,
  isGeometricAnalyzeThreshold,
  maybeAnalyzeTableAfterWrite,
} from "./analyze-threshold.js";

/**
 * Issue #269 / ADR 0221: ADR 0194 が `memory_embeddings_*` に入れた「書き込み経路からの
 * 自動 ANALYZE」を、同じ JOIN の相手側である `memories` にも入れる。
 *
 * ## なぜ `memories` にも要るか
 *
 * `PostgresVectorStore.search()`（`vector-store.ts`）は埋め込み表を `memories` と
 * `JOIN` してテナントで絞る。ADR 0194 は埋め込み表側の統計だけを守ったため、
 * `memories` 側の統計が実態からずれている（＝新規インストール直後、大量投入した
 * 直後）と、プランナは埋め込み表の HNSW 索引を検討する前に、`memories` 側の
 * 行数見積もりを誤って安価な Nested Loop を選ぶ——ADR 0194 自身の CI 実測
 * （「CI が実際に教えたこと」節）と、Issue #269 / #418 の実測（4,000行、
 * 約10〜30倍遅い）がこれを裏付けている。
 *
 * ## この対処の形（Issue #269 の実測に基づく。ADR 0221 参照）
 *
 * `embedding-statistics.ts`（ADR 0194）と**同じ設計**——このプロセスが `memories` に
 * 書き込んだ行数を数え、等比の閾値ちょうどで `pg_class.reltuples` を1回読み、
 * 統計が足りないときだけ `ANALYZE memories` を撃つ。核となるロジック
 * （カウンタ→閾値判定→reltuples guard→ANALYZE）は `./analyze-threshold.ts` に
 * 括り出してあり、`embedding-statistics.ts` と本ファイルの両方がそれを呼ぶ
 * （テーブル名が動的か固定かの違いだけ）。
 *
 * `memories` はテーブル名が常に固定（`EmbeddingSpaceId` のような動的な導出が無い）
 * ので、カウンタは単一の `Map`（実質1エントリ）で足りる——`embedding-statistics.ts`
 * の「テーブルごとに分ける」設計をそのまま流用しつつ、キー空間が1つしか使われない
 * だけである。
 *
 * ## 呼び出し元
 *
 * `PostgresMemoryStore`（`memory-store.ts`）の、`memories` へ実際に新しい行を
 * INSERT した経路の末尾から呼ぶ:
 * - `createMemory`: `INSERT ... RETURNING *` が実際に行を返したときだけ。
 * - `createMemoryWithOutbox`: トランザクションが `created: true` を返したときだけ、
 *   **トランザクションの外側で**呼ぶ（`ANALYZE` 自体はトランザクション内でも実行できるが、
 *   トランザクションが保持する行ロックと `ShareUpdateExclusiveLock` を無用に重ねない
 *   ため。ADR 0221 参照）。
 *
 * ON CONFLICT で既存行を返しただけの呼び出し（新しい行を書いていない）はカウントしない
 * ——`embedding-statistics.ts` の `upsert`（常に書き込む）とはこの点だけ違う。
 */

const MEMORIES_TABLE = "memories";

/**
 * プロセスローカルの `memories` 書き込み累計カウンタ。`analyze-threshold.ts` の
 * `maybeAnalyzeTableAfterWrite` はテーブル名をキーにした `Map` を要求する設計
 * （`embedding-statistics.ts` と共有するインターフェース）だが、`memories` は
 * 常に単一の固定テーブルなので実質1エントリしか使わない。
 */
const memoriesWriteCounts = new Map<string, number>();

/** テスト専用: プロセスローカルのカウンタを空にする。production コードからは呼ばない。 */
export function resetMemoriesWriteCounterForTesting(): void {
  memoriesWriteCounts.clear();
}

export interface MaybeAnalyzeMemoriesResult {
  /** この呼び出しを含む、このプロセスが `memories` に書き込んだ累計行数。 */
  count: number;
  /** この呼び出しで実際に `ANALYZE memories` を撃ったかどうか。 */
  analyzed: boolean;
}

/**
 * `PostgresMemoryStore` の書き込み経路の末尾から呼ぶ。カウンタを1増やし、等比の閾値
 * （`isGeometricAnalyzeThreshold`、`embedding-statistics.ts` と同じ純関数を再利用）を
 * 跨いだときだけ `pg_class.reltuples` を読み、それがこのプロセスの書いた累計行数より
 * 小さければ `ANALYZE memories` を撃つ。
 *
 * 閾値に達していない・統計が既に十分な呼び出しは、カウンタの加算以外のコストを
 * 一切払わない（`pg_class` すら読まない）。
 */
export async function maybeAnalyzeMemoriesAfterWrite(db: Db): Promise<MaybeAnalyzeMemoriesResult> {
  const result = await maybeAnalyzeTableAfterWrite(db, MEMORIES_TABLE, memoriesWriteCounts);
  return { count: result.count, analyzed: result.analyzed };
}

// 埋め込み表側と同じ等比閾値の純関数・初項を、テストや呼び出し元が参照できるよう
// 再エクスポートする（`embedding-statistics.ts` と全く同じ値・同じ関数——
// 別の定数を持たない。閾値を変えるなら `analyze-threshold.ts` の1箇所で足りる）。
export { INITIAL_ANALYZE_THRESHOLD, isGeometricAnalyzeThreshold };
