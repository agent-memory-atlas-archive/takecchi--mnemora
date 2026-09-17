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
  **この3つで足りる——`pg_trgm` 等の追加の拡張は要求しない**
  （[ADR 0084](../../docs/decisions/0084-lexical-recall-channel.md) §3・
  [ADR 0149](../../docs/decisions/0149-japanese-lexical-no-required-extension.md)）。
  **⚠ ただしその代償として、`recall()` の語彙(lexical)チャンネルは日本語の文に埋もれた
  日本語の語（人名を含む）を引けない。**日本語表記のチャンネル名・社内システム名に
  ついても、人名と同じ穴に落ちる可能性が高いが確かめていない
  （[ADR 0149](../../docs/decisions/0149-japanese-lexical-no-required-extension.md)）。
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

> **⚠ 追記（2026-09-17、[Issue #425](https://github.com/takecchi/mnemora/issues/425)）— 上の数字は、当時・当条件の記録として読むこと**:
>
> 上の実測には行数（100,000）以外の測定条件（`shared_buffers`・次元数・データ分布など）が
> 記録されておらず、**他の環境では再現できない。**⛔ **そのため数字は書き換えない**
> （[ADR 0213](../../docs/decisions/0213-live-docs-cite-adrs-by-anchor-not-line-number.md) 決定5。
> ここは宛先ではなく主張であり、追記で訂正する対象である）。
>
> 【受】別条件（自分専用の PostgreSQL、100,000行、当日の既定 WHERE 述語）で
> 再測した結果は、絶対値が大きく違った——旧来相当の述語で `ANALYZE` 前 median 261.0ms →
> 後 2.09ms、述語を足した当日の既定形で 167.8ms → 2.25ms。**それでも
> 「`ANALYZE` 前後で桁が違う」という定性的な結論は崩れていない。**

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

## この package が作るオブジェクト（共有 DB へ入れる前に確認すること）

**mnemora を、他のアプリと同じ Postgres データベースへ同居させる場合**は、
下の名前が既存のオブジェクトと衝突しないか、導入前に確認すること。専用スキーマへ
隔離したい場合は上の「専用スキーマを指定する」を見ること（テーブル・索引は
`--schema` で指定したスキーマの下に作られる。advisory lock のキーは
「advisory lock のキー」の節を見ること）。

**この一覧は自動生成ではない。**`packages/postgres/migrations/*.sql` を
ファイル名順に適用した最終形として人手で導出し、
[`scripts/__tests__/readme-postgres-objects.test.mjs`](../../scripts/__tests__/readme-postgres-objects.test.mjs)
（[`scripts/readme-postgres-objects-lib.mjs`](../../scripts/readme-postgres-objects-lib.mjs)）が
migrations と `src/` の現物から機械的に導いた集合と突き合わせている。**この一覧が
CI で赤くなったら、コードではなくこの一覧のほうを直すこと**（歯が正、この文章が従。
導出のやり方・DROP された索引を数えない理由は [ADR 0202](../../docs/decisions/0202-postgres-shared-db-object-names.md) 参照。**関数**（`CREATE FUNCTION` /
`CREATE OR REPLACE FUNCTION`）も含めて突き合わせている——
[ADR 0204](../../docs/decisions/0204-postgres-object-names-cover-functions.md) が
ADR 0202 の「引き受けた負債1」を解消した）。

### テーブル（8）

- `memories`
- `memory_events`
- `observations`
- `outbox`
- `recall_usages`
- `recalls`
- `tenant_activity`
- `tenant_settings`

### 索引（20）

- `idx_memories_by_subject`
- `idx_memories_contested`
- `idx_memories_contested_with`
- `idx_memories_lexical`
- `idx_memories_period_ann_stage`
- `idx_memories_provenance_kind`
- `idx_memories_recall_gate`
- `idx_memories_recall_gate_seq`
- `idx_memories_requeue_embed`
- `idx_memories_superseded_by`
- `idx_memories_tags`
- `idx_memory_events_by_kind`
- `idx_memory_events_by_memory`
- `idx_memory_events_by_retention`
- `idx_observations_by_subject`
- `idx_outbox_claimable`
- `idx_outbox_pending`
- `idx_recalls_by_subject`
- `uq_memories_extraction`
- `uq_observations_external_id`

### 関数（5）

- `mnemora_lexical_coverage`
- `mnemora_lexical_normalize`
- `mnemora_lexical_query_or`
- `mnemora_lexical_query_terms`
- `mnemora_lexical_query_tsqueries`

⚠ **引数シグネチャ（`(text)` 等）までは検査していない。**`CREATE OR REPLACE FUNCTION`
で同名を別シグネチャに置き換えても、この歯は気づかない
（[ADR 0204](../../docs/decisions/0204-postgres-object-names-cover-functions.md)「引き受けた負債」1番）。

**なぜこれを埋めずに据え置くのか。**「起きうるから塞ぐ」ではなく、履歴を引いて決めた
（`main` = `d0ce4b3a497ab7218495683ba2f343b4cf22701e` 時点の【実測】）:

- `mnemora_lexical_*` の5関数はすべて `CREATE FUNCTION`（`OR REPLACE` ではない）で、
  それぞれ1回しか定義されていない。
- 定義元の2ファイル（`migrations/0008_memories_lexical_index.sql` /
  `migrations/0009_memories_lexical_or_coverage.sql`）は、それぞれ追加した commit
  （`0a71a57` / `251e4d7`）以降**一度も変更されていない**。
- `git log --all -S'CREATE OR REPLACE FUNCTION' -- packages/postgres/migrations/` は
  **0件**——`CREATE OR REPLACE FUNCTION` はこのリポジトリの履歴に一度も現れていない。
- `packages/postgres/migrations/`（17本）のうち、追加後に変更されたファイルは
  `0011_memory_events_kind_restored.sql` の1本だけで、その変更（commit `f15130b`、
  Issue #227 / PR #236）は**説明コメントの修正**であり、関数定義にもシグネチャにも
  無関係だった。

⟹ **シグネチャが変わった実績は0件。**名前だけを見る形を、今回は据え置く。

⚠ **それでも正直に書いておくこと**: 共有 DB での衝突検査という目的に照らすと、
PostgreSQL は**同名・別シグネチャの多重定義（オーバーロード）を許す**ため、
名前だけの一致では衝突を厳密には判定しきれない。**それでも名前が一致すること自体は
「調べるべき合図」としては十分**であり、この歯が拾った一致をレビューで見る、という
運用でその限界を補っている。これが覆るとしたら、mnemora が実際にオーバーロードを
使い始めたときである（ADR 0204「これが覆るとしたら」）。

### 実行時に増える系列（埋め込み空間ごと）

`registerEmbeddingSpace` を呼ぶたびに、その `EmbeddingSpaceId`
（`(provider, model, dimensions)`）ごとに次の名前が1組ずつ増える
（[`src/embedding-space-table.ts`](./src/embedding-space-table.ts)）:

- テーブル: `memory_embeddings_<space>`
- 索引（HNSW）: `idx_memory_embeddings_hnsw_<space>`

`<space>` は `provider` / `model` / `dimensions` を小文字化・非英数字を `_` に置換して
連結したスラグ（例: `openai_text_embedding_3_small_1536`）。**PostgreSQL の識別子は
63バイトまで**のため、これを超える場合は末尾を切り詰め、内容から導いたハッシュ片
（8桁の16進）を足して衝突を避ける（[`src/embedding-space-table.ts`](./src/embedding-space-table.ts)、
検査は
[`src/__tests__/embedding-space-table.test.ts`](./src/__tests__/embedding-space-table.test.ts)）。

🔴 **索引のほうがテーブルより先に頭打ちになる。**接頭辞の長さが違うため
（【実測】）:

- テーブルの接頭辞 `memory_embeddings_` = **18バイト** ⟹ スラグに使える余地は63−18=**45バイト**
- 索引の接頭辞 `idx_memory_embeddings_hnsw_` = **27バイト** ⟹ スラグに使える余地は63−27=**36バイト**

⟹ **索引のほうが9バイト早く上限に達する。**同じ `<space>` でも、テーブルはまだ
切り詰められていないのに索引だけ切り詰められる、という組み合わせが起こりうる。

**いま使われている中で最長の空間**（`openai` / `text-embedding-3-small` / `1536`。
`docs/memory-model.md` §10・この README の「動く最小の例」・`packages/openai/README.md`
が挙げている組）は、索引名が
`idx_memory_embeddings_hnsw_openai_text_embedding_3_small_1536`（**61バイト**）
——**上限まであと2バイト**しかない。

🔴 **実際に切り詰めが起きる具体例**（`provider`/`model` は
[`packages/core/src/embedding.ts`](../core/src/embedding.ts) の
`EmbeddingSpaceId`（`z.string().min(1)`）で長さの上限を設けていないため、
採用者が普通に踏みうる長さ）: `azure-openai` / `text-embedding-3-large` / `3072` では

- テーブル = `memory_embeddings_azure_openai_text_embedding_3_large_3072`
  （**58バイト、切り詰めなし**）
- 索引 = `idx_memory_embeddings_hnsw_azure_openai_text_embedding_eb32c67b`
  （**63バイト、末尾を切り詰めてハッシュ片を付与済み**）

**⟹ この README がここまで書いていた「索引（HNSW）: `idx_memory_embeddings_hnsw_<space>`」
という規則（＝テーブルと同じ `<space>` が付く）は、この場合には成立しない**
——索引名の末尾はテーブル名の `<space>` とは異なる、独自に切り詰められた文字列になる。
⚠ **この歯は接頭辞の一致と63バイト以内であることまでは検査しているが、
「切り詰め・ハッシュ付与が実際に起きたときの具体名がテーブルと索引で食い違いうる」
ことをここに明記するのが今回の変更である**（ADR 0202「引き受けた負債」2番を、
実測に基づいて埋めた）。

### advisory lock のキー

`runMigrations`（マイグレーション適用）と `registerEmbeddingSpace`
（埋め込み空間ごとのテーブル作成）は、それぞれ別の `pg_advisory_lock` キーで
プロセス間排他を行う（[`src/migrate.ts`](./src/migrate.ts)・
[`src/vector-space.ts`](./src/vector-space.ts)）。**`pg_advisory_lock` のキー空間は
データベース全体で共有される**——同じ DB の別アプリが同じ数値をキーに使っていると
無関係な処理同士が意図せずブロックし合う。

- `--schema` 未指定、または `--schema public`: 固定の既定キーを使う。
  - `runMigrations`: `7190158676462701299`（`MIGRATION_LOCK_KEY`）
  - `registerEmbeddingSpace`: `-4359922960011245935`（`REGISTER_EMBEDDING_SPACE_LOCK_KEY`）
- それ以外の `--schema <name>` を指定した場合: 固定値ではなく、次のシード文字列を
  sha256 でハッシュして導出した値になる（`deriveAdvisoryLockKey`）。
  - `runMigrations`: シード `mnemora:runMigrations:advisory-lock:<schema>`
  - `registerEmbeddingSpace`: シード `mnemora:registerEmbeddingSpace:advisory-lock:<schema>`

## もっと詳しく

- [docs/memory-model.md](../../docs/memory-model.md) §10 — DB schema・規約
- [docs/architecture.md](../../docs/architecture.md) §5 — 主要 interface
- [migrations/](./migrations) — 手書きの DDL（`drizzle-kit push` には頼らない。docs/memory-model.md §10「規約」・[ADR 0001](../../docs/decisions/0001-orm-drizzle.md)「ORM は Drizzle」）
- リポジトリ: https://github.com/takecchi/mnemora
