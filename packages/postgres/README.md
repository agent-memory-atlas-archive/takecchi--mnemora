# @mnemora/postgres

`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore` の
Postgres + pgvector 実装（[docs/memory-model.md](../../docs/memory-model.md) §10）。
マイグレーション実行用の CLI（`mnemora-postgres-migrate`）も含む。

## インストール

```bash
pnpm add @mnemora/postgres @mnemora/core
# または
npm i @mnemora/postgres @mnemora/core
```

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `moduleResolution` が `node10` か
  `nodenext` なら通る。`node16` は `TS1479` になるので `nodenext` にすること）
- **CommonJS へ変換するテストランナー（ts-jest 等）からも読める。**配布物に
  `import.meta` を含めていないため（[ADR 0086](../../docs/decisions/0086-no-import-meta-in-published-artifacts.md)）。
  `import.meta` は CommonJS として解析されると**構文解析の時点で**落ちるので、
  1箇所在るだけで「import しただけで落ちる」状態になる
- **本物の Postgres + pgvector が要る。**擬似物・インメモリでの代替は無い
  （このリポジトリの CI は [`pgvector/pgvector:pg17`](https://hub.docker.com/r/pgvector/pgvector) の
  Docker イメージに対して実行している。実物は
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) を参照）。
- 接続先には次の3拡張が要る: **`vector`**（pgvector）・**`btree_gin`**・**`pgcrypto`**。
  `mnemora-postgres-migrate`（後述）の `migrations/0001_init.sql` が
  `CREATE EXTENSION IF NOT EXISTS` で作成を試みるが、接続ロールに拡張を作る権限が無い
  環境ではあらかじめ DBA 側で作っておくこと。
- 接続文字列は環境変数 `DATABASE_URL` で渡す。

## マイグレーション（`mnemora-postgres-migrate`）

このパッケージは bin `mnemora-postgres-migrate` を提供する
（実体は [`src/bin/migrate.ts`](./src/bin/migrate.ts)、引数解釈は
[`src/bin/cli-options.ts`](./src/bin/cli-options.ts)）。`DATABASE_URL` を読み、
保留中の `migrations/*.sql` をファイル名の昇順で適用する。

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate
```

- 適用対象が無ければ「適用対象のマイグレーションはありません（すべて適用済み）。」と出て終わる。
- 適用したファイル名を一覧で出す。
- 複数プロセスが同時に実行しても安全（advisory lock で直列化する）。

### ⚠ 新規インストール後、最初のデータ投入が終わったら `--analyze-memories` を実行すること

**新規インストールの直後は、ANN（近似最近傍）検索が「索引が無いのと同じ遅さ」で動く。**
`migrations/0005_analyze_memories.sql` は `memories` の統計情報を更新する `ANALYZE` を
含むが、このファイルは**他のすべてのマイグレーションと同じく、アプリケーションが最初の
行を書き込む前に**適用される——つまり `0005` が走る時点で `memories` はまだ空であり、
`ANALYZE` は集めるべき行を持たない（詳細と実測は `migrations/0005_analyze_memories.sql`
本文のコメントと [ADR 0062](../../docs/decisions/0062-contested-with-id-fk-index.md) (d) を
参照。実測: 新規インストール順のまま100,000行投入した状態での ANN クエリは
**37.4 / 33.2 / 32.9 ms**——`ANALYZE` 未実行の場合と統計的に同じ遅さ。対して
`ANALYZE` 実行後は **4.6 / 4.5 / 5.6 ms**）。

**⟹ 初回のデータ投入（シード・移行元からの一括インポート等）が終わったタイミングで、
一度だけ次を実行すること**（`mnemora-postgres-migrate` と同じバイナリの1オプション、
[ADR 0143](../../docs/decisions/0143-analyze-memories-after-seed.md)）:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate --analyze-memories
```

- 保留中のマイグレーションを適用したうえで、続けて `ANALYZE memories;` を実行する
  （マイグレーションの適用対象が無くても、`--analyze-memories` 単体で実行される）。
- **何度実行しても安全**（冪等）——デプロイの手順書やデプロイ後フックに組み込んでおいて
  差し支えない。`--schema` を指定している場合はそのスキーマの `memories` に対して実行する。
- `MNEMORA_ANALYZE_MEMORIES=1`（空文字・`"0"`・`"false"` 以外の値）でも同じ効果。
- **これは完全な自動化ではない**——`runMigrations`／このマイグレーション自体には
  「データが投入された後」を検知する手段が無いため、実行するタイミングは運用側が
  判断する必要がある。`ANALYZE`（`VACUUM` を伴わない単体の `ANALYZE`）は PostgreSQL の
  公式文書によれば通常の読み書きをブロックしないため、デプロイパイプラインの
  最後や、cron で定期的に呼んでも安全側に倒れる設計だが、**この副作用はこの
  リポジトリでは実測していない**（作業環境に Postgres が無いため）。詳細・
  採らなかった案・確かめていないことは
  [ADR 0143](../../docs/decisions/0143-analyze-memories-after-seed.md) 参照。

### 専用スキーマを指定する（`--schema` / `--extension-schema`）

共有 DB に他システム（例: Prisma が管理する `public`）が同居していて、mnemora の
テーブル群を別スキーマへ隔離したい場合は、`--schema` を指定する。ライブラリ側の
`runMigrations` の `options.schema` / `options.extensionSchema`
（[`src/schema-namespace.ts`](./src/schema-namespace.ts) の `SchemaNamespaceOptions`）を
そのまま CLI から渡せる口である。

```bash
# コマンドライン引数（--schema=<name> の = 区切りでも可）
npx mnemora-postgres-migrate --schema tenant_a --extension-schema public

# 環境変数（CI・コンテナから渡しやすい）
MNEMORA_SCHEMA=tenant_a MNEMORA_EXTENSION_SCHEMA=public npx mnemora-postgres-migrate

# --help で使い方・引数・環境変数・優先順位を確認できる
npx mnemora-postgres-migrate --help
```

- **優先順位はコマンドライン引数が勝つ**: `--schema` > `MNEMORA_SCHEMA` > 未指定、
  `--extension-schema` > `MNEMORA_EXTENSION_SCHEMA` > 未指定。
- **どちらも指定しなければ、今日と1バイトも変わらない**（`runMigrations(pool)` 相当。
  `search_path` 任せの既定経路）。
- `--extension-schema`（`MNEMORA_EXTENSION_SCHEMA`）は `schema` 側
  （`--schema` または `MNEMORA_SCHEMA`）が最終的に指定されているときだけ効く。
  `schema` 無しで `--extension-schema` だけを指定するとエラー（終了コード 1）になる
  ——黙って無視すると「拡張の置き場所を変えたつもりで実は変わっていない」という
  気付きにくい事故になるため。
- 不正なスキーマ名（PostgreSQL の識別子として使えない・63バイト超）や未知の引数、
  値の無い `--schema` もエラー（終了コード 1）で止まる。

`package.json` の `scripts` に組み込む例:

```json
{
  "scripts": {
    "migrate": "mnemora-postgres-migrate"
  }
}
```

## 動く最小の例（型検査のみ確認・DB へは未実行）

```ts
import {
  createPostgresClient,
  registerEmbeddingSpace,
  PostgresMemoryStore,
  PostgresVectorStore,
  PostgresEventStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
} from "@mnemora/postgres";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import { createRuntime } from "@mnemora/core";
import { createHash } from "node:crypto";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL が設定されていません。");
}

const client = createPostgresClient(connectionString);

const embeddingProvider = new OpenAIEmbeddingProvider({
  model: "text-embedding-3-small",
  dimensions: 1536,
});

// 埋め込み空間ごとのテーブルは、先に registerEmbeddingSpace で作っておく必要がある
// （未登録の空間に PostgresVectorStore.upsert を呼ぶと "relation does not exist" で失敗する）。
await registerEmbeddingSpace(client.pool, embeddingProvider.space);

const runtime = createRuntime({
  memoryStore: new PostgresMemoryStore(client.db),
  vectorStore: new PostgresVectorStore(client.db),
  eventStore: new PostgresEventStore(client.db),
  outboxStore: new PostgresOutboxStore(client.db),
  tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
  llmProvider: new OpenAILLMProvider({ model: "gpt-4o-mini" }),
  embeddingProvider,
  hashContent: (content) => createHash("sha256").update(content).digest("hex"),
});

const ctx = { tenantId: "tenant-1" };
await runtime.observe(ctx, {
  kind: "utterance",
  text: "明日、京都へ出張する",
  speaker: "user",
});
```

上のコードを動かす前に、`mnemora-postgres-migrate` で該当 DB にスキーマを適用しておくこと。

## adapter として自作する場合

`MemoryStore` 等の自作実装を書くなら、[`@mnemora/testkit`](../testkit/README.md) の
適合テスト（conformance suite）に食わせて検査できる。`@mnemora/postgres` 自身の実装も
この適合テストで検査している。

## もっと詳しく

- [docs/memory-model.md](../../docs/memory-model.md) §10 — DB schema・規約
- [docs/architecture.md](../../docs/architecture.md) §5 — 主要 interface
- [migrations/](./migrations) — 手書きの DDL（`drizzle-kit push` には頼らない。docs/memory-model.md §10「規約」・[ADR 0001](../../docs/decisions/0001-orm-drizzle.md)「ORM は Drizzle」）
- リポジトリ: https://github.com/takecchi/mnemora
