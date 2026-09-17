import type { EmbeddingSpaceId } from "@mnemora/core";
import type { Db } from "./client.js";
import { assertSafeIdentifier, embeddingSpaceTableName } from "./embedding-space-table.js";
import {
  INITIAL_ANALYZE_THRESHOLD,
  isGeometricAnalyzeThreshold,
  maybeAnalyzeTableAfterWrite,
} from "./analyze-threshold.js";

// Issue #269 の追記: 「カウンタ→閾値判定→reltuples guard→ANALYZE」の核は
// `./analyze-threshold.ts` に括り出した（`memories` にも同じ仕組みを足すため——
// `memories-statistics.ts` が同じ核を使う）。このファイルはそれ以来、
// 「埋め込みテーブル名を `EmbeddingSpaceId` からどう導出するか」と
// 「テーブルごとのカウンタをどう persist するか」だけを持つ薄いラッパーになった。
// 既存の公開 API（`INITIAL_ANALYZE_THRESHOLD` / `isGeometricAnalyzeThreshold` /
// `maybeAnalyzeAfterUpsert` / `resetEmbeddingUpsertCountersForTesting` /
// `MaybeAnalyzeAfterUpsertResult`）は1つも変えていない——下の re-export と
// 委譲がそれを保っている。振る舞い（ADR 0194 の測定・変異試験）も変わらないはず
// ——このファイル自身のテスト（`embedding-statistics.test.ts` /
// `embedding-statistics.postgres.test.ts`）で再確認した。
export { INITIAL_ANALYZE_THRESHOLD, isGeometricAnalyzeThreshold };

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
 * `PostgresVectorStore.upsert` の末尾から呼ぶ。テーブル名を `EmbeddingSpaceId` から
 * 導出し、実際のカウンタ更新・閾値判定・`ANALYZE` の要否判定は
 * {@link maybeAnalyzeTableAfterWrite}（`./analyze-threshold.ts`、Issue #269 で
 * テーブル名非依存の形に括り出したもの）に委譲する。ここに残っているのは
 * 「埋め込みテーブル名をどう決めるか」（`embeddingSpaceTableName` +
 * `assertSafeIdentifier`）だけである。
 */
export async function maybeAnalyzeAfterUpsert(
  db: Db,
  space: EmbeddingSpaceId,
): Promise<MaybeAnalyzeAfterUpsertResult> {
  const table = embeddingSpaceTableName(space);
  assertSafeIdentifier(table);
  return maybeAnalyzeTableAfterWrite(db, table, upsertCountsByTable);
}
