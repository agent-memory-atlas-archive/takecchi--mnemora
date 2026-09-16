import type { EmbeddingSpaceId } from "@mnemora/core";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";

/**
 * `packages/postgres` のテストは本物の Postgres + pgvector に接続して実行する
 * （擬似物での置き換えを認めない、roadmap.md 段階2の完了条件）。
 *
 * 接続先は `DATABASE_URL` で与える。CI は GitHub Actions の service container
 * （`pgvector/pgvector:pg17`）を、ローカルは手元の実サーバーを指す。
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。packages/postgres のテストは本物の Postgres + " +
        "pgvector が必要（擬似物では代替しない）。ローカルでは export DATABASE_URL=... を " +
        "設定してから `pnpm --filter @mnemora/postgres run test:db` を実行すること。",
    );
  }
  return url;
}

/** テストで使う既定の埋め込み空間（次元は小さく、テストの実行速度を優先する）。 */
export const TEST_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "fixture-model",
  dimensions: 3,
};

let sharedClient: PostgresClient | undefined;
let ready: Promise<void> | undefined;

/**
 * プロセス内で1つの接続プールを使い回す（各テストファイルが個別に接続を張ると
 * CI のサービスコンテナに対して接続過多になりやすいため）。マイグレーションと
 * テスト用埋め込み空間の登録は初回だけ行う。
 */
export async function getTestClient(): Promise<PostgresClient> {
  if (!sharedClient) {
    sharedClient = createPostgresClient(requireDatabaseUrl());
  }
  if (!ready) {
    ready = (async () => {
      await runMigrations(sharedClient!.pool);
      await registerEmbeddingSpace(sharedClient!.pool, TEST_EMBEDDING_SPACE);
    })();
  }
  await ready;
  return sharedClient;
}

const DOMAIN_TABLES = [
  "recall_usages",
  "recalls",
  "memory_events",
  "outbox",
  embeddingSpaceTableName(TEST_EMBEDDING_SPACE),
  "memories",
  "observations",
  "tenant_settings",
  // ADR 0165（Issue #305）: 活動カウンタ。忘れるとテスト間で activity_seq が汚染される
  // （`getActivitySeq`/`createRecall(advanceActivityClock: true)` の歯が偽陽性/偽陰性になる）。
  "tenant_activity",
];

/**
 * 各テストの前にドメインテーブルを空にする。in-memory 実装が「テストケースごとに
 * 独立した新しいインスタンスを返す」のと同じ独立性を、共有 DB 接続でも再現するため
 * （`MemoryStoreConformanceOptions.createStore` が各 `it()` の先頭で呼ばれる設計と対応する）。
 */
export async function resetTestDatabase(): Promise<void> {
  const { pool } = await getTestClient();
  await pool.query(`TRUNCATE TABLE ${DOMAIN_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function closeTestClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.pool.end();
    sharedClient = undefined;
    ready = undefined;
  }
}

/**
 * 決定的な擬似乱数（テストのベクトル生成用）。
 *
 * **`Math.random()` を使わない理由**: HNSW 索引が選ばれるか・ANN が何を返すかは
 * データ分布に依存する。入力が実行のたびに変わると、**落ちたときに再現できない**
 * ——実際に「一度だけ観測したが再現しない」flake の報告が出て、原因を追えなかった。
 * 種を固定すれば、落ちたときに必ず同じ入力で再現できる。
 *
 * mulberry32。テスト用途に十分な質があり、実装が短く依存を増やさない。
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
