# ADR 0194: `PostgresVectorStore.upsert` が閾値越えのときだけ埋め込み表を `ANALYZE` する — 新しい埋め込み空間の統計の窓を、プロセスローカルなカウンタと `pg_class.reltuples` の guard で閉じる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける。** 【実測】＝私がこの作業環境で自分の手で実行して確かめた。
【現物】＝このリポジトリのコードを自分で読んだ。【受】＝別の作業者が測定した内容と
Issue #360 本文——**私自身は再現していない**。ADR 0170/0173/0175 と同じ体裁に揃える。

---

## 結論

**`PostgresVectorStore.upsert` に、閾値越えのときだけ埋め込み表を `ANALYZE` する仕組みを足した。**

- 空間（`EmbeddingSpaceId` → テーブル名）ごとに、**このプロセスが `upsert` で書いた行数**
  をカウントする（プロセスローカル、`packages/postgres/src/embedding-statistics.ts`）。
- 累計が**等比の閾値**（1,000 / 2,000 / 4,000 / …、初項は `INITIAL_ANALYZE_THRESHOLD`）
  のちょうどに達したときだけ、`pg_class.reltuples` を1回読む。
- **`reltuples` がこのプロセスの書いた行数より小さいときだけ** `ANALYZE <table>` を撃つ。
  そうでなければ何もしない。
- `PostgresVectorStore.upsert`（`vector-store.ts`）は import 1行と、`upsert` 末尾の
  `await maybeAnalyzeAfterUpsert(this.db, space);` の1行だけを足した。**`search()` は
  1文字も触っていない**（下の「触ったファイル」で確認できる）。

新しい埋め込み空間への大量投入では、`reltuples` は「一度も `ANALYZE` されていない」ことを
示す `-1`（PG14+）なので、1,000行を書いた時点で必ず `ANALYZE` が撃たれる——HNSW が勝ち
始める規模（Issue #360 の実測で約2,000行）に到達する前に、統計が存在する状態を作る。
既に育って統計のある空間では、`reltuples` がこのプロセスの書いた行数を超えるので、
一度も撃たない——定常運用に恒久的な費用を足さない。

**⚠ 本 PR は「採用者が 350倍遅い想起を踏まなくなる」ことを保証しない。** `search()` は
埋め込み表を `memories` と `JOIN` してテナントで絞るため、埋め込み表の統計を本 PR が
正しく保っても、`memories` 側の統計が実態からずれていればプランナは HNSW を検討しない
——実際に CI（後述「CI が実際に教えたこと」）でこの経路が踏まれた。**本 PR が閉じたのは
埋め込み表側の窓だけである。** `memories` 側の窓は「引き受けた負債」2番として残る。

---

## Issue #360 が指摘した問題（【受】——別の作業者が `main` で確認済み。私は再現していない）

- **`memory_embeddings_*` を `ANALYZE` する production 経路は0件だった。** `ANALYZE`
  を撃つ production 経路は4つあるが全部 `memories` 専用（`migrate.ts:610-621` の
  `runAnalyzeMemories`、`bin/migrate.ts:60-63` の `--analyze-memories`/
  `MNEMORA_ANALYZE_MEMORIES`、`migrations/0005_analyze_memories.sql`、
  `migrations/0015_decay_activity_clock.sql`）。
- **埋め込み表を作る/埋める側は `ANALYZE` を一切撃たない**: `vector-space.ts` の
  `registerEmbeddingSpace`（`CREATE TABLE` + `CREATE INDEX ... USING hnsw`）/
  `vector-store.ts` の `upsert`（本 PR 以前）/ `core/src/runtime.ts` の
  `processEmbedJob`・`tick()`。
- **`registerEmbeddingSpace` の production 呼び出し元は1箇所だけ**
  （`examples/chat/src/runtime-factory.ts:106`）で、**常に「まだ1行も embed されていない」
  時点**で呼ばれる ⟹ [ADR 0143](./0143-analyze-memories-after-seed.md) が指摘した構造
  （空の表を `ANALYZE` しても意味が無い）が完全に同型で当たる。
- **歯はテスト側が自分で `ANALYZE` を撃って回避しているだけ**（`vector-search-hnsw.test.ts`
  ほか複数ファイル）。実運用経路には無い、という Issue の主張は正しい。
- **autovacuum の実測**（【受】、この器で `SHOW` により実値を引いたもの:
  `autovacuum_naptime=1min` / `autovacuum_analyze_threshold=50` /
  `autovacuum_analyze_scale_factor=0.1`）: 新しい空間へ3,000行投入 →
  `last_autoanalyze` が入るまで20秒。さらに97,000行追加 → 次の autoanalyze まで41秒。
  ⟹ この低負荷環境での初回の窓は20〜40秒程度。**⚠ 本番相当の負荷（多数のテーブル/
  テナント/DB が autovacuum の対象）では長くなりうる。そこは測っていない。**
- Issue #360 自身の実測（100,000行、`local` 埋め込み・256次元・1テナント・合成データ）:
  `ANALYZE` 前 342.354ms（Nested Loop 経由）→ `ANALYZE` 後 0.981ms（HNSW 経由）。
  約350倍。HNSW が選ばれ始める規模は約2,000行。

---

## 現物を読んだ（出所: 私がこの環境で読んだ）

- `packages/postgres/src/vector-space.ts` の `registerEmbeddingSpace`
  （170〜232行）: `CREATE TABLE IF NOT EXISTS` と `CREATE INDEX IF NOT EXISTS ...
  USING hnsw` を撃つだけで、`ANALYZE` は一切出てこない。
- `packages/postgres/src/vector-store.ts`（本 PR 以前）の `upsert`: `INSERT ... ON
  CONFLICT ... DO UPDATE` のみ。`search()` は距離演算子をそのまま `ORDER BY` に置く
  規約（docs/memory-model.md §10）に従っており、本 PR はここに一切触れていない。
- `packages/postgres/src/migrate.ts:610-621` の `runAnalyzeMemories`: 対象テーブルが
  `qualify(schema, "memories")` に決め打ちで、埋め込み表を渡す経路が無い。
- [ADR 0143](./0143-analyze-memories-after-seed.md): `runMigrations`/CLI の
  `ANALYZE memories` が新規インストールで効かない構造的理由（呼ばれるのが常に
  「データがまだ無い」タイミング）を実測込みで記録している。本 ADR が引き継ぐ先例。

---

## 何を守るか、何の費用を増やすか

### 守れるもの

- **新しい空間への大量投入では、`reltuples` は `-1`（PG14+ の「一度も ANALYZE
  していない」表の値）**——1,000行を書いた時点で必ず `-1 < 1000` が成立し、必ず
  `ANALYZE` が撃たれる。HNSW が勝ち始める規模（Issue #360 の実測で約2,000行）に
  到達する前に統計が存在する。autovacuum の naptime を待たずに、mnemora 自身が
  窓を閉じる。
- **既に大きく育って統計のある空間では、`reltuples`（例 1,000,000）がこのプロセスの
  書いた行数を上回る** ⟹ 一度も撃たない。定常運用に恒久的な費用を足さない。
- 等比の閾値なので、撃つ回数は投入行数に対して O(log n) に収まる。投入中も統計が
  実態の約2倍以上ずれない。

### 増やす費用（正直に書く）

- 閾値を跨いだときだけ `pg_class` を1回読む（プロセス・空間あたり高々 log₂(n) 回）。
  それ以外の `upsert` はカウンタの加算だけ。
- 統計が本当に遅れているときだけ `ANALYZE` が走る。その費用は Issue #360 の【受】で
  100,000行 388ms。**⚠ この PR では再測していない。**
- `ANALYZE` は `ShareUpdateExclusiveLock` を取る（[ADR 0143](./0143-analyze-memories-after-seed.md)
  決定3、PostgreSQL 公式文書からの引用——このリポジトリの既存記録を引いているだけで、
  本 PR で文書を再取得してはいない）⟹ 同じ表への `ANALYZE` 同士は直列化するが、
  通常の読み書き（`SELECT`/`INSERT`/`UPDATE`/`DELETE`）とは競合しない。
- **プロセスが再起動するとカウンタが0に戻る** ⟹ 閾値の確認が一巡だけ余計に走りうる。
  `reltuples` の guard があるので、統計が足りていれば `ANALYZE` は撃たれない。
- **複数プロセスが並行して書くと、それぞれが自分のカウンタで判定する** ⟹ `ANALYZE`
  が重複して撃たれうる。害は無い（冪等・直列化されるだけ）——プロセス間の協調機構は
  意図的に1つも足していない。これが案③を採らなかった主な理由でもある。

---

## 採らなかった案

### 案①: `registerEmbeddingSpace` が `CREATE INDEX` 直後に撃つ

**却下。** [ADR 0143](./0143-analyze-memories-after-seed.md) の構造的却下理由が
そのまま当たる。唯一の production 呼び出し元（`examples/chat/src/runtime-factory.ts:106`）
は表が空の時点でしか呼ばれず、空の表を `ANALYZE` しても統計は作られない
（サンプルする行が無い）。

### 案②: `runAnalyzeMemories`/`--analyze-memories` を埋め込み表へ広げる

**落とさない。が、この PR ではやらない。** 理由: opt-in であり、「採用者が呼ぶことを
覚えている」ことに依存する。`AGENTS.md` が「規律ではなく注意力に依存しており、
必ず失敗する」と別の文脈で書いているのと同じ形——本 issue が言う「採用者が必ず踏む」
を塞げない。**⚠ ただし mnemora の外で直接 SQL で大量投入した採用者には②しか効かない**
——`PostgresVectorStore.upsert` を経由しない書き込みは本 ADR のカウンタに一切乗らない。
「これが覆るとしたら」に、②が別途要ることを明記する。

### 案③: `tick()` の embed ジョブが閾値を見て撃つ

**却下。** `tick()` は `embed` 単独の累計を持たず（`DEFAULT_TICK_LIMIT`=50、複数種
混在の `processed` しか返らない）、新しいカウンタとプロセス間協調が要る。
[ADR 0143](./0143-analyze-memories-after-seed.md) が同じ理由で意図的に先送りした
範囲そのもの。加えて `packages/core` を触ることになり、この作業の時点で別issue
（ADR 0189 進行中の段1 ANN 経路、`kPrime` 周辺・1145〜1200行付近）が同じファイルを
触っている最中だった——**本 PR は `packages/core` に一切触れていない。**

### 案④: 何もしない

**却下。** 実測（【受】）で窓は20〜40秒だが、その窓は「採用者が初回投入の直後に
最初の想起をする」ちょうどその瞬間に開く。しかも索引は在るのに使われないので、
採用者からは原因が見えない。

### 案⑤: `registerEmbeddingSpace` の `CREATE TABLE` 直後に
`ALTER TABLE ... SET (autovacuum_analyze_scale_factor=0, autovacuum_analyze_threshold=1)`
を足す

**採らない。** 別の作業者が実測して推奨したが、以下の理由で検算のうえ落とした
（**⚠ 次の検算は理屈で行ったものであり、`EXPLAIN` で測ってはいない**）:

- **⑤ は初回の窓を縮めない**（【受】、作業者自身の実測: custom でも default でも
  初回は約32秒。下限は `autovacuum_naptime` であり、表ごとの設定では動かせない）。
- **⑤ が効くとされたケース**（100,000行の表に500行追加したとき default では再
  analyze が140秒発火しない）は、**プラン選択を変えない**——`reltuples=100,000`
  に対して実態100,500は0.5%のずれであり、プランナは同じ HNSW を選ぶ。「統計が
  古い」ことと「索引が選ばれない」ことは別で、⑤ が守るのは前者だけである。

---

## 置き場所

`⛔ 触ってはいけないもの`（`packages/postgres/src/vector-store.ts` の `search()`）に
一切触らないため、カウンタ・閾値・`ANALYZE` の判定は新規ファイル
`packages/postgres/src/embedding-statistics.ts` にまとめて置いた。`vector-store.ts`
は import 1行と `upsert` 末尾の呼び出し1行だけ。

閾値判定 `isGeometricAnalyzeThreshold` は純関数として export してあり、DB 不要の
単体テスト（(丙)）の対象にした。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**無関係。** 本 ADR は統計情報の更新タイミングであり、recall が毎回渡す量には
影響しない。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `maybeAnalyzeAfterUpsert` が一度も `ANALYZE` を撃たなくても（例えば
閾値に一度も達しない小規模な運用）、`upsert`/`search` は変わらず動く——遅いだけで
`omitted`/エラーにはならない。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** ANN の統計情報はプランナの内部状態であり、recall の trace には
現れない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。**

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** `ANALYZE` は SQL 1文であり、LLM を一切呼ばない。閾値判定も
純粋な算術（`isGeometricAnalyzeThreshold`）である。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。DATABASE_URL は
`postgresql://postgres@127.0.0.1:5433/mnemora`（PostgreSQL 17.11 + pgvector 0.8.0、
既に立っている環境。自分では起動していない）。**

- `pnpm -r run typecheck`（全7 workspace projects）— 緑。
- `pnpm run lint`（eslint、リポジトリ全体） — 緑。
- `pnpm run format:check`（prettier、リポジトリ全体） — 緑。
- `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/embedding-statistics.test.ts`
  — (丙) 12本すべて緑。
- `pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/embedding-statistics.postgres.test.ts` — (甲)(乙) 2本すべて緑
  （使い捨てデータベース、下記「(甲) の設計変更」参照）。
- 上記2ファイルに加え、`vector-search-hnsw.test.ts` / `conformance.postgres.test.ts`
  / `vector-search-subject.test.ts` / `vector-search-tiebreak.test.ts` /
  `vector-search-provenance.test.ts` / `vector-space-concurrency.test.ts` を
  まとめて実行 — **8ファイル315本すべて緑**（`upsert` は全ファイルから呼ばれる
  中核関数なので、既存の回帰が無いことをここで確認した）。
- **PR #406 追記**: CI が (甲) を赤くした後（下記「CI が実際に教えたこと」）、
  (甲) を書き換えて `pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/embedding-statistics.test.ts
  src/__tests__/embedding-statistics.postgres.test.ts` を再実行 — **2ファイル
  14本すべて緑**（22秒前後）。`pnpm -r typecheck` / `pnpm run lint` /
  `pnpm run format:check` も再度緑を確認した。

### (甲) の設計変更（実測して踏んだ問題と、直した経緯）

最初の実装は共有テスト DB（`test-db.ts` の `getTestClient()`）を使ったところ、
**(甲) が実際に赤くなった**——原因は埋め込み表ではなく `memories` 側だった。
`search()` のクエリは `memories` と `JOIN` してテナントで絞る。共有 DB は
他のテストファイルが積んだ行と、別のタイミングで走った `ANALYZE memories`
（`vector-search-hnsw.test.ts` 等）の古い統計を持っており、プランナが「この
テナントの行は約1件しかない」と誤って見積もり、安価な Nested Loop
（`idx_memories_period_ann_stage` 経由）を選んで、距離順の HNSW スキャンを
検討すらしなかった（実測: `EXPLAIN` に `rows=1` の Index Scan が出た）。
**これは本 PR の対象外**（`memories` の統計は既存の `runAnalyzeMemories`/
`--analyze-memories`、[ADR 0143](./0143-analyze-memories-after-seed.md) の
領分）。この歯を `memories` の統計ノイズから隔離するため、`dedicated-schema.
postgres.test.ts` と同じ作法（使い捨てデータベース、`temp-database.ts`）に
書き直し、(甲)(乙) とも緑になることを確認した。

### CI が実際に教えたこと（追記 2026-09-17。PR #406）

**【実測】CI（`.github/workflows/ci.yml` の postgres ジョブ、`pgvector/pgvector:pg17`）
で (甲) が赤くなった。** 手元（PostgreSQL 17.11 + pgvector 0.8.0）ではこの前まで
緑だった。CI の実際の出力:

```
AssertionError: expected 'Limit  (cost=115.97..115.99 rows=10 w…' to match /Index Scan.*using idx_memory_embeddin…/
```

上の「(甲) の設計変更」で使い捨てデータベースへ切り替えた後も、**(甲) は
`vectorStore.search()` が実際に発行する SQL（`memories` と `JOIN` してテナントで
絞る）をそのまま `EXPLAIN` していた**。使い捨てデータベースは他のテストファイルの
ノイズからは隔離できたが、**`memories` に一度も `ANALYZE` が走らないこと自体は
変わらない**——この歯は埋め込み表以外に `ANALYZE` を撃たず、`upsert` も
`memories` の統計には触らない。そのため `search()` の `JOIN` 先である `memories`
の行数をプランナが見誤り、HNSW を検討する前に安い Nested Loop を選んだ。

**⟹ 歯は嘘をついていない。**「この PR だけでは、`JOIN` を含む本物の `search()`
では HNSW に届かないことがある」を正しく検出した。これは下の「引き受けた負債」
2番（`memories` 側に同じ穴が開いたまま）に、**CI からの実測の裏付けが付いた**
ということである。

⚠ 手元で（この追記の前まで）緑だった理由は、**確かめていない見立て**として、
投入（28秒ほどかかる）の間に autovacuum が `memories` を拾ったのではないか、
というものがある。裏は取っていない。

**⟹ 対処: (甲) が `EXPLAIN` する対象を、既存の先例（`vector-search-hnsw.test.ts`
の「等価クエリ」の歯）と同じ形に変えた。** `pool.query` をフックして `search()`
の実発行 SQL を捕まえる作りはやめ、埋め込み表だけを引く SQL
（`search()` と同じ `ORDER BY <距離演算子>` の形。`memories` と `JOIN` しない）を
直接 `EXPLAIN` するようにした。**これは歯を弱めたのではなく、対照を正したもの**
である——`memories` の統計は本 PR が触っていない変数であり、(甲) が検査すべきは
「この PR が実際に触ったもの」（埋め込み表の統計）だけである。`ANALYZE` を撃たない
こと・`autovacuum_enabled = false` を先に打つこと・`last_analyze` が入り
`last_autoanalyze` が null のままであることの検査は、そのまま残した（歯の核心は
変えていない）。

この書き換えが実際に検査していることは、下の「⭐ 変異試験」の変異Aで実測した
（`ANALYZE` を撃つ行を消すと、書き換え後の (甲) も赤くなることを確認済み）。

### ⭐ 変異試験（実測。すべて `cp` で退避・復元し、`git checkout` は使っていない）

初出時（Issue #360、上の3本）に加え、**PR #406 で (甲) を書き換えた後、同じ3本の
変異を再実測した**（書き換え後の (甲) が実際に何かを検査しているかを確かめるため。
上の「CI が実際に教えたこと」参照）。以下は PR #406 時点の再実測（退避先
`/tmp/mnemora-mut-406/embedding-statistics.ts.orig`）。

**退避**: `cp packages/postgres/src/embedding-statistics.ts
/tmp/mnemora-mut-406/embedding-statistics.ts.orig`

**変異A**（`ANALYZE` を撃つ行を消す）——**最重要: 書き換えた (甲) がこれを検出するか**:

```
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/embedding-statistics.postgres.test.ts -t "甲"
```
→ **1 failed | 1 skipped**（`AssertionError: expected null not to be null` at
`expect(statResult.rows[0]?.last_analyze).not.toBeNull()` — `last_analyze` が
入っていないことを検出）。書き換え後の (甲) も赤くなることを実測した。

`cp /tmp/mnemora-mut-406/embedding-statistics.ts.orig
packages/postgres/src/embedding-statistics.ts` で復元 → 同じコマンドで
**1 passed | 1 skipped** に戻ることを確認した。`diff` で元の内容と1バイトも
違わないことも確認済み。

**変異B**（`reltuples < count` の guard を外し、常に撃つ）:

```
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/embedding-statistics.postgres.test.ts -t "乙"
```
→ **1 failed | 1 skipped**（`last_analyze` の値が変異前後で変わってしまい、
`toEqual` が失敗——`AssertionError: expected 2026-09-16T17:42:08.555Z to deeply
equal 2026-09-16T17:42:05.087Z`）。(乙) が赤くなることを実測した。

`cp` で復元 → **1 passed | 1 skipped** に戻ることを確認した。

**変異C**（等比の判定を「`initialThreshold` の倍数ならすべて true」という固定間隔に
変える）:

```
pnpm --filter @mnemora/postgres exec vitest run src/__tests__/embedding-statistics.test.ts
```
→ **2 failed | 10 passed**（「倍数だが2の累乗倍ではない（3,000）は false」と
「initialThreshold を差し替えても同じ規則で動く」の2本が、期待どおり赤くなった
——変異後は 3,000 も 300 も true 判定になってしまうため）。(丙) が赤くなることを
実測した。

`cp` で復元 → **12 passed** に戻ることを確認した。3本の変異すべてで
`diff /tmp/mnemora-mut-406/embedding-statistics.ts.orig
packages/postgres/src/embedding-statistics.ts` が差分無しであることを確認済み。

---

## 引き受けた負債

1. **mnemora の外で直接 SQL で埋め込みを大量投入する採用者には、この対処は届かない。**
   カウンタは `PostgresVectorStore.upsert` を通った行しか数えないためである。
   ⟹ **案② が別途要る**（`runAnalyzeMemories`/`--analyze-memories` を埋め込み表へ
   広げる）。本 ADR は案②を**落としていない**——「この PR ではやらない」と決めただけで
   あり、この負債はそのまま残る。

2. 🔴 **`memories` 側の統計には、同じ穴がそのまま開いたままである。**
   上記「(甲) の設計変更」で踏んだとおり、`search()` は `memories` と `JOIN` して
   テナントで絞るため、**埋め込み表の統計が正しくても、`memories` の統計が実態から
   ずれていればプランナは HNSW を検討しない**（実測: `rows=1` の見積りで Nested Loop が
   選ばれた）。あの実測は共有テスト DB のノイズが原因であり、当時は「本番で同じことが
   起きると示したわけではない」と書いていた。

   **⟹ PR #406 で、この負債に CI からの実測の裏付けが付いた（上の「CI が実際に
   教えたこと」参照）。** 使い捨てデータベース（他のテストとの共有ノイズが無い状態）
   でも、CI（`pgvector/pgvector:pg17`）は (甲) を赤くした——原因は「古い統計」では
   なく「`memories` に統計が一度も無いこと」だった。**構造としては同型どころか、
   もっと直接的である**——新規インストールでは `migrations/0005` / `0015` の
   `ANALYZE memories` は**表が空のときに走る**ため効かず
   （[ADR 0143](./0143-analyze-memories-after-seed.md)）、`--analyze-memories` は
   opt-in である。⟹ **初回の大量投入の直後、`memories` にも統計が無い窓が開く。**
   **本 ADR はこの窓を閉じていない。**別の issue として追跡する。

   この裏付けを受けて、(甲) の `EXPLAIN` 対象を `search()` の実発行 SQL（`memories`
   と `JOIN` する）から、既存の先例（`vector-search-hnsw.test.ts`）と同じ「埋め込み
   表だけを引く等価クエリ」に変えた。**歯を弱めたのではなく対照を正したもの**——
   `memories` の統計という本 PR が触っていない変数を、この歯の検査対象から外した。

3. **カウンタはプロセスローカルである。** プロセスが再起動すると0に戻り、閾値の確認が
   一巡だけ余計に走る（`reltuples` の guard が在るので `ANALYZE` 自体は撃たれない）。
   複数プロセスが並行して書くと、それぞれが自分のカウンタで判定するため `ANALYZE` が
   重複して撃たれうる。**プロセス間の協調機構は1つも足していない**——これは意図した
   取引であり（案③を落とした主な理由）、重複の害は「直列化されるだけ」という**推論**で
   ある（「確かめていないこと」参照）。

4. **案⑤を落とした根拠は、測定ではなく理屈である。** 「`reltuples=100,000` に対して
   実態 100,500 は 0.5% のずれであり、プランナは同じ HNSW を選ぶ」という推論であり、
   **`EXPLAIN` で確かめてはいない。**⚠ もしこれが誤りなら、案⑤は復活しうる。


5. **`ANALYZE` の失敗は `upsert` の失敗になる。** `maybeAnalyzeAfterUpsert` は例外を
   握り潰していない——**書き込み経路が保守文（`ANALYZE`）の成否に依存する。**
   ⚠ **実運用で最も起こりそうな形（実行時のロールが表の所有者でない）では、
   PostgreSQL は `ANALYZE` を「所有者でないので飛ばす」という WARNING にして
   エラーにしない**ため、`upsert` は落ちない。⟹ 握り潰しを足すと本物の異常
   （表が消えている等）まで隠れるので、**今は足さない**という判断である。
   ⚠ **この「WARNING であってエラーにならない」は PostgreSQL の文書上の挙動であり、
   本 PR ではその経路を実際に走らせて確かめていない。**
## これが覆るとしたら

1. **`ANALYZE` のロックが実運用の書き込みスループットで問題になったとき。**
   そのときは閾値（最初の 1,000、以後倍々）を上げるか、`ANALYZE` を別の接続・別の
   タイミングへ逃がす設計に作り直すことになる。**閾値は `embedding-statistics.ts` の
   定数1箇所に集めてあり、テストがそこから読む**——書き写していないので、変えるのは
   1箇所でよい。

2. **`memories` 側の窓（負債2）が実運用で実際に踏まれたとき。** そのときは
   「`PostgresMemoryStore` の書き込み側にも同じカウンタを置く」か、案②（明示の口）を
   実装するか、のどちらかを選ぶことになる。**どちらも本 ADR の射程外であり、別の ADR の
   仕事である。**

3. **`packages/core` 側に「embed の滞留が捌けた」を知らせる仕組みが入ったとき**
   （案③）。そのときは、プロセスローカルのカウンタより素直な発火点がそちらに現れる
   ため、本 ADR の仕組みは置き換えの候補になる。⚠ ただし**案③は `VectorStore` の
   interface に新しい口を足すことになる**ので、それ自体が別の判断である。

4. **案⑤の根拠（負債4）が `EXPLAIN` で否定されたとき。**

---

## 確かめていないこと

- **`ANALYZE` 自体の所要時間・費用は再測していない。** Issue #360 の実測
  （100,000行で388ms）を出典として引くのみ。本 PR のテスト規模（数千行）では
  体感できる遅延にならなかったが、数値としては測っていない。
- **本番相当の負荷（多数のテナント/テーブル/DB が同時に autovacuum の対象になる
  環境）での窓の長さ**は、この PR でも測っていない（【受】の20〜40秒は低負荷環境の
  実測）。
- **複数プロセスが同時に同じ空間へ `upsert` したときに、実際に `ANALYZE` が重複して
  撃たれること自体**は、この PR では実測していない（設計上「害は無い」という
  推論のみ。プロセス間協調テストは書いていない）。
- **`ANALYZE` の `ShareUpdateExclusiveLock` が実運用の書き込みスループットへ与える
  影響**は、[ADR 0143](./0143-analyze-memories-after-seed.md) が引用した PostgreSQL
  公式文書の記述を再確認しただけで、本 PR ではこの環境で計測していない。
- **CI（`.github/workflows/ci.yml` の postgres ジョブ、`pgvector/pgvector:pg17`）
  での緑**: 一度は赤くなったこと自体は【実測】済み（上の「CI が実際に教えたこと」）。
  (甲) を書き換えた後の CI での緑は、この PR を push した後
  `node scripts/ci-green-check.mjs --pr <番号>` で確認する（この追記の時点では
  まだ確認していない——手元での再実行が緑になったことまでしか言えない）。
- **手元では緑だった理由（autovacuum が投入中に `memories` を拾ったのではないか）
  は、見立てであって確かめていない。** 裏を取るには、投入の途中で
  `pg_stat_user_tables.last_autoanalyze` をポーリングして実際に発火時刻を
  記録する必要があるが、この追記ではそれをやっていない。
- **`registerEmbeddingSpace` が呼ばれる別経路（`examples/chat` 以外の採用者）**が
  存在するかどうかは、このリポジトリからは確認できない（ADR 0142 と同じ理由）。
