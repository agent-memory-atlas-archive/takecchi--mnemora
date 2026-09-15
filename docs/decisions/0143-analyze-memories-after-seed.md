# ADR 0143: 新規インストール後に `ANALYZE memories;` を明示的に実行できるようにする — `runMigrations`/migrate CLI 末尾での自動実行は構造的に効かないため、独立コマンドにする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける。**「私がこの作業環境で実行して確かめた」「この作業でウェブから
取得して確認した」「このリポジトリの既存の記録（ADR 0062・`0005_analyze_memories.sql`）
を読んだ」「読んだだけで実測していない」を混ぜない。

---

## 結論

**新規インストール直後、ANN（近似最近傍）検索が「索引が無いのと統計的に同じ遅さ」で
本番に出うる**（[Issue #234](https://github.com/takecchi/mnemora/issues/234)）。実測値は
**37.4 / 33.2 / 32.9 ms（`ANALYZE` 未実行）対 4.6 / 4.5 / 5.6 ms（`ANALYZE` 実行後）**——
約8倍。**この数字の出典は [ADR 0062](./0062-contested-with-id-fk-index.md) (d)(ii) であり、
`migrations/0005_analyze_memories.sql` 本文のコメントが同じ数字をそのまま引き写している**
（下記「§2 の数字の出典」で検算した）。

**`packages/postgres` に次を追加した**（実装は本 PR）:

- ライブラリ関数 `runAnalyzeMemories(pool, { schema? })`（`src/migrate.ts`）—
  `ANALYZE memories;` をマイグレーションのライフサイクルから独立に、いつでも呼べる形で実行する。
- CLI フラグ `mnemora-postgres-migrate --analyze-memories`（環境変数版
  `MNEMORA_ANALYZE_MEMORIES`）— マイグレーション適用後に上記を呼ぶ。
- `packages/postgres/README.md` に、**新規インストール後の初回データ投入が終わったら
  これを実行すること**という運用手順を明記した。

**Issue #234 が名指しした2つの自動化案（`runMigrations` 自身が最後に打つ／migrate CLI が
最後に打つ）は、検討のうえ、どちらも採らなかった。** 理由は「設計の好み」ではなく
**構造的な事実**である——マイグレーションはアプリケーションが最初の行を書き込む**前**に
適用されるため、`runMigrations`/CLI の実行タイミングそのものが「`memories` がまだ空」の
タイミングであり、そこで `ANALYZE` を打っても `0005` と同じくサンプルする行が無い
（下記「検討した案」で詳述）。**⟹ Issue が提案した2案は、新規インストール問題の解決に
そもそも寄与しない。** この事実は新しい測定ではなく、`ADR 0062` が既に実測した内容と
`migrate.ts` の実行順を読み合わせるだけで導ける論理である。

**この PR は「文書に書くだけ」で終わらせていない**——`--analyze-memories` という、
データ投入後に運用側が呼べる実働コマンドを足した。ただし**これは完全な自動化ではない**：
「データが投入された」ことを検知して自動的に発火する仕組みではなく、依然として
**運用側がいつ呼ぶかを判断する必要がある**。真の自動化（アプリケーション実行時に
周期的に、あるいは書き込み量に応じて発火する）は、本 PR の範囲外として「開いている穴」に
明記する（下記）。

---

## §2 の数字の出典（この issue 自身が「特定していない」と書いていたもの）

Issue #234 は次を逐語で書いている:

> ⛔ この数字の出典（どの ADR / PR / run で測ったか）を、私は特定していない。
> 着手する人はそこから始めること。

**特定した。** `docs/decisions/` を `grep -rl "37.4"` / `grep -rln "4\.6"` で横断すると、
両方の数字が [ADR 0062](./0062-contested-with-id-fk-index.md) と
`packages/postgres/migrations/0005_analyze_memories.sql` の両方にヒットする。
`0005_analyze_memories.sql` 本文の末尾コメント（実測を行った当のファイル）が
「詳細と一次資料は ADR 0062 参照」と自ら明記しており、ADR 0062 (d)(ii) を開くと
次の実測記録がそのまま載っている（ADR 0062 からの逐語引用）:

> - `0001`〜`0004` を適用 → 100,000行を投入 → **`ANALYZE` を一切走らせない**まま測定:
>   プランナは誤った索引（`idx_memories_recall_gate` + 事後の `Filter`）を選び、
>   `reltuples|relpages` は `-1|0`。**35.0 / 39.8 / 42.4 ms。**
> - 同じ状態から `0005`（`ANALYZE memories;`）を実際の migrate 経路で適用:
>   プランナは `idx_memories_period_ann_stage` に切り替わり、見積もり **535** 行
>   対 実際 **491** 行。**4.6 / 4.5 / 5.6 ms。**
> - 対して「新規インストール順」（`0001`〜`0005` を空テーブルに全部適用してから
>   100,000行を投入し、**以降 `ANALYZE` を一切走らせない**）: **37.4 / 33.2 / 32.9 ms**
>   ——**本 PR の修正が何も無い場合と統計的に同じ遅さ。**

**⟹ Issue #234 の「実測: 37.4ms vs 4.6ms」は、この ADR 0062 (d)(ii) の測定
（「新規インストール順」列 vs 「アップグレード経路で `0005` 適用後」列の先頭値）を指している
と判断できる。** ADR 0062 (d)(ii) 自身がこの測定の方法・環境（PostgreSQL 17.11 /
pgvector 0.8.6、実際の `runMigrations()` 経由）を記録済みであり、**再測定はしていない**
——本 ADR はこの既存の記録を出典として引くにとどめる（**この作業環境には Postgres が無く、
再測定はできない**。下記「確かめていないこと」参照）。

**⚠ 別途、狭い時間窓で報告されていた「14.0ms/228.6ms/0.9-3.0ms」という数字は、ADR 0062 (d)(ii)
自身が「再現しなかった」と明記している**（0.62%窓のはずが実際の行数が矛盾していた）。
Issue #234 が引いた「37.4ms vs 4.6ms」はこちらではなく、上記の再現済みの数字と一致する。

---

## 問い（Issue #234、`0005_analyze_memories.sql` が自ら「範囲外」と書いた運用手順）

`packages/postgres/migrations/0005_analyze_memories.sql` 本文（逐語）:

> 🔴 **正直な限界: 新規インストールでは、このマイグレーションは何もしない。**
> [...] この運用手順の整備は本マイグレーションの範囲外——ここでは
> 「必要である」という事実だけを記録する。

Issue #234 の受け入れ条件（案）は3点:

1. 新規インストール後に何をすべきかが利用者の目に入る場所に書かれていること
   （README が第一候補、ただし置き場所は現物を見て決めること）
2. 「書いた」で終わらせるかどうかを決めること。`AGENTS.md` は「規律ではなく注意力に
   依存する形は必ず失敗する」と名指ししており、`runMigrations` 自身が打つ／migrate CLI が
   最後に打つ、を検討したうえで、採らないなら理由を書くこと
3. 自動で打つ案の副作用（所要時間・ロック・トランザクション境界）を、測らずに
   「軽いはず」と書かないこと

---

## 現物を読んだ（出所: 私がこの環境で読んだ）

### `packages/postgres/src/migrate.ts` の `runMigrations`（本 PR 以前）

`runMigrations` は `migrations/*.sql` を**ファイル名の昇順で、advisory lock の下、
1ファイル1トランザクションで**適用する（`migrate.ts:530-548`、本 PR 以前の行番号）。
呼び出し元は次の3箇所である（`grep -rn "runMigrations(" --include=*.ts packages examples`
で確認、`__tests__` を除く）:

- `packages/postgres/src/bin/migrate.ts` の `main()`（CLI のエントリポイント、
  唯一の production 呼び出し元）

**この呼び出しが起きるタイミングは「デプロイ手順の一部として、アプリケーションを起動する
前」である**——`packages/postgres/README.md`（本 PR 以前の版）が「上のコードを動かす前に、
`mnemora-postgres-migrate` で該当 DB にスキーマを適用しておくこと」と明記しているとおり、
`runMigrations`/CLI は**アプリケーションが1行も書き込む前**に走る設計である。

### `packages/postgres/migrations/0005_analyze_memories.sql`

本文（既に「問い」節で引用した「正直な限界」に加え）が、この構造的な理由をそのまま
記録している（逐語）:

> `0001`〜`0005` は新規インストールでは1つの `runMigrations()` 呼び出しの中で
> 順に適用される——つまりこの `ANALYZE memories;` が走る時点で `memories` は
> まだ空である。

**⟹ `0005` は既に `ANALYZE memories;` を持っている。それでも新規インストールで効かない
理由は「`ANALYZE` 文が足りない」ではなく「呼ばれるタイミングが常にデータの前」である。**
この事実は、`runMigrations` の呼び出しタイミング（上記）と `0005` 自身の記録を読み合わせる
だけで導ける——**新しい測定ではなく、既存の記録からの論理的な導出である。**

---

## 検討した案（Issue #234 が名指しした2案を含む）と、採らなかった理由

### 案A: `runMigrations` 自身が、最後に `ANALYZE memories;` を打つ

**却下。** `runMigrations` は `migrations/*.sql` を適用するためだけに呼ばれ、その呼び出し
自体が「アプリケーションがまだ1行も書いていない」タイミングで起きる（上記「現物を読んだ」）。
`runMigrations` の最後に `ANALYZE` を追加しても、**新規インストールでは `memories` が
空のままなので、`0005` と同じ「サンプルする行が無い」結果にしかならない。** これは
`0005` が既に踏んでいる同じ穴を、置き場所を変えて掘り直すだけであり、Issue #234 が
解決を求めている問題（新規インストール後の ANN 性能）には一切寄与しない。

**⚠ この却下は「新しいデータで実測して確かめた」わけではない。** `runMigrations` の
呼び出しタイミングと `0005` の既存実測から導ける論理的な帰結であり、**導出であって
実験ではない**——本 ADR はこの区別を明示する。

### 案B: migrate CLI（`bin/migrate.ts`）が、`runMigrations` の後に `ANALYZE` を打つ

**部分的に採用したが、Issue が想定した形（「migrate を叩けば自動的に効く」）そのままでは
採らなかった。** `runMigrations` の**呼び出し元**を変えても、`runMigrations` 自身の
呼び出しタイミングという構造は変わらない——`bin/migrate.ts` の `main()` が
`runMigrations` の直後に無条件で `ANALYZE` を打つ形にしても、新規インストールでは
依然として `memories` は空である。**⟹ 「migrate を実行するだけで自動的に効く」形にしても
効果が無い、という点は案Aと同じ構造的な理由で却下する。**

**採ったのは、この構造を認めたうえで「migrate と同じバイナリの、独立したオプション」に
すること**——`--analyze-memories` は `runMigrations` の成否・適用対象の有無とは無関係に
呼び出せる（実装は `bin/migrate.ts` の `if (analyzeMemories) { await runAnalyzeMemories(...) }`
——`runMigrations` の**後**に、しかし**独立した条件**で呼ぶ）。**これは「migrate 実行のたびに
自動で効く」ではなく「運用側がデータ投入後に明示的に呼ぶための、専用の呼び出し口を
用意する」という、Issue の提案とは似て非なる形である**——この違いを消さずに書く。

### 案C: 文書に書くだけで終わらせる（既存の `AGENTS.md` の指摘により却下）

**却下。** `AGENTS.md` が「複製した瞬間から正文と要約はずれ始める」「規律ではなく注意力に
依存しており、必ず失敗する」と、手順を人に委ねる形を名指しで退けている（該当節は
北極星の要約についての文脈だが、Issue #234 はこの論法を運用手順にも当てている）。
**「README に書くだけ」では、実行するかどうかが完全に読む人の注意力に依存する**——
これは AGENTS.md が拒否する形そのものである。⟹ 本 PR は文書化だけでなく、
「読まなくても、コマンド名さえ知っていれば実行できる」専用のコマンド
（`--analyze-memories`）を必ず併せて用意した。

**ただし、これでも完全な自動化ではないことを認める。** 運用側が「このコマンドを
実行する」ことを依然として選択しなければならない——「実行を選ぶこと」自体への
依存は残る。これは下記「開いている穴」に named debt として明記する。

### 案D: `docs/roadmap.md` §5 へ送り、実装せずに止まる

**検討したが採らなかった。** `docs/autonomy.md` §3.1 の見分け方
（「どちらを選んでも技術的には成立するが、選び方が製品の性格を決める」なら §5 行き）に
照らすと、**本件は「技術的に決められる」側に倒れると判断した**——Issue 自身が
「検討したうえで、採らないなら理由を ADR に書くこと」と、実装まで到達する経路を明示的に
許容しており、また優先度は「C群の中でも下位・一度 ANALYZE が走れば解消する・恒久的な
欠陥ではない」と明記されている。**製品の性格（mnemora がどれだけ『自己管理』するかという
思想）に関わる、より踏み込んだ自動化（下記「開いている穴」のランタイム自動発火）は
別issueとして残すが、「運用手順を実行可能な形で提供する」という本 PR の射程自体は、
技術的な決定で足りると判断した。**

---

## 決定1: どこに書くか — `packages/postgres/README.md`

**README を採った。** 理由:

- `mnemora-postgres-migrate` の使い方そのものが既に README に書かれており
  （「マイグレーション（`mnemora-postgres-migrate`）」節）、`--analyze-memories` は
  **その同じバイナリの1オプション**である——CLI の使い方を割って別の文書に置く理由が無い。
- `docs/` 配下の設計文書（`architecture.md`・`memory-model.md` 等）は**現状に対して
  `mnemora-postgres-migrate` や `ANALYZE` に一切言及していない**（`grep -n
  "mnemora-postgres-migrate\|ANALYZE\|runMigrations" docs/architecture.md
  docs/memory-model.md docs/roadmap.md` はヒット0件、本 PR で確認）——運用手順を
  そちらに新設するより、**既に運用手順の置き場所として機能している README** に足すほうが
  一貫する。
- `--help` の出力（`formatMigrateCliUsage`）にも同じ説明を足した——README を読めない
  状況（ネットワーク越しにドキュメントへアクセスできないデプロイ環境等）でも、
  運用者はコマンドの `--help` から辿れる。

---

## 決定2: 自動化の形 — `runAnalyzeMemories` + `--analyze-memories`（案B の修正版）

`packages/postgres/src/migrate.ts` に次を追加した:

```ts
export interface AnalyzeMemoriesOptions {
  schema?: string;
}

export interface AnalyzeMemoriesResult {
  table: string;
}

export async function runAnalyzeMemories(
  pool: Pool,
  options: AnalyzeMemoriesOptions = {},
): Promise<AnalyzeMemoriesResult> {
  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const table = qualify(schema, "memories");
  await pool.query(`ANALYZE ${table}`);
  return { table };
}
```

`packages/postgres/src/bin/cli-options.ts` に `--analyze-memories`（値を取らない真偽
フラグ）/ `MNEMORA_ANALYZE_MEMORIES`（環境変数、`""`/`"0"`/`"false"` 以外を真とする）を
追加し、`packages/postgres/src/bin/migrate.ts` の `main()` が、`runMigrations` の**後**に
`analyzeMemories` が真なら `runAnalyzeMemories` を呼ぶ。

**設計上の要点**:

- **`runMigrations` の中身にはしない**（上記「検討した案」の案A・案Bの却下理由）。
  `RunMigrationsOptions` に `analyzeAfter` のようなフラグを足す設計も検討したが、
  `runMigrations` は「保留中のマイグレーションを適用する」という単一の責務を持つ関数であり、
  「新規インストールでは効かないことが分かっている操作」をその中に混ぜると、
  `runMigrations` を呼ぶだけのテスト・呼び出し元（`test-db.ts` の `getTestClient` 等）が
  暗黙に `ANALYZE` の対象になる・ならないを気にする必要が生まれる。責務を分けた。
- **`--analyze-memories` は `runMigrations` の適用対象の有無と無関係に実行される**
  （`applied.length === 0` でも呼ばれる）——「保留中のマイグレーションは無いが、
  統計だけ更新したい」という、まさに本 issue が想定する使い方（初回データ投入後の
  1回限りの呼び出し、または cron での定期呼び出し）を主用途にしているため。
- **冪等**。`ANALYZE` は何度実行しても安全（PostgreSQL の性質そのもの）。
- **`--schema` と独立に組み合わせられる**——専用スキーマを使っている場合も
  `runAnalyzeMemories(pool, { schema })` が `"<schema>"."memories"` の形で修飾する
  （`schema-namespace.ts` の `qualify` を再利用、既存の規約と揃える）。

---

## 決定3: 副作用について — 文書から引いた（この作業環境では実測していない）

Issue #234 は「測らずに『軽いはず』と書くな」と明記している。**この作業環境には
Postgres も docker も無く、実測はできない**
（`which docker podman psql postgres initdb` はいずれも何も返さない。実測。
Issue #247 / alteroid #965 / alteroid #1015 の族として既知の構造的な穴）。

**そこで、実測の代わりに PostgreSQL の公式文書を、この作業の中で実際に取得して確認した**
（出所: 私が本 PR の作業中に `WebFetch` で取得した。2026-09-16）:

- [`https://www.postgresql.org/docs/current/explicit-locking.html`](https://www.postgresql.org/docs/current/explicit-locking.html)
  （Table-Level Locks の節）から、逐語:

  > Acquired by `VACUUM` (without `FULL`), `ANALYZE`, `CREATE INDEX CONCURRENTLY`,
  > `CREATE STATISTICS`, `COMMENT ON`, `REINDEX CONCURRENTLY`, and certain
  > `ALTER INDEX` and `ALTER TABLE` variants [...]

  （`SHARE UPDATE EXCLUSIVE` を取得するコマンドの一覧に `ANALYZE` が明記されている）

  > Conflicts with the `SHARE UPDATE EXCLUSIVE`, `SHARE`, `SHARE ROW EXCLUSIVE`,
  > `EXCLUSIVE`, and `ACCESS EXCLUSIVE` lock modes. This mode protects a table
  > against concurrent schema changes and `VACUUM` runs.

  **`SHARE UPDATE EXCLUSIVE` は `ACCESS SHARE`（`SELECT`）・`ROW SHARE`・
  `ROW EXCLUSIVE`（`INSERT`/`UPDATE`/`DELETE`）とは競合しない**——通常の読み書きを
  ブロックしない、と文書からは読める。

- [`https://www.postgresql.org/docs/current/sql-analyze.html`](https://www.postgresql.org/docs/current/sql-analyze.html)
  から、逐語:

  > For large tables, `ANALYZE` takes a random sample of the table contents,
  > rather than examining every row. This allows even very large tables to be
  > analyzed in a small amount of time.

  > The largest statistics target among the columns being analyzed determines
  > the number of table rows sampled to prepare the statistics.

  **`ANALYZE` はテーブル全体を舐めず、`default_statistics_target`（既定100）に基づく
  固定サイズのサンプルだけを読む**——大きなテーブルでもサンプリング自体の時間は
  比例して伸びない、と文書からは読める。

**⟹ 素の `CREATE INDEX`（`ACCESS EXCLUSIVE` を取り、`memories` への全ての書き込みを
止める——[ADR 0062](./0062-contested-with-id-fk-index.md) (c) が実測・記録済み）とは
性質が異なり、`ANALYZE` は書き込みを止めない設計だと文書からは読める。** この読みを
根拠に、`--analyze-memories` をデプロイパイプラインの一部や cron に組み込んでも
安全側に倒れる設計だと判断し、README にもその旨を書いた。

**ただし、これは「文書から読める」であって「この環境・このスキーマで測った」ではない**
——`ANALYZE` のサンプリング自体に大きなテーブルでどれだけの壁時計時間がかかるか、
`default_statistics_target` の既定値がこのスキーマ（特に `idx_memories_period_ann_stage`
の式索引）に対して十分かどうか、プランキャッシュの無効化などの副次効果が実運用で
どう効くかは、**この作業では一切測っていない**（下記「確かめていないこと」に明記）。

---

## 開いている穴（塞げなかった・意図的に塞がなかった入口）

1. **これは「操作を実行しなくても効く」という意味での完全な自動化ではない。**
   `--analyze-memories` は、運用側が「いつ呼ぶか」を依然として判断し、実際に呼ぶ必要がある
   ——`AGENTS.md` が退けている「手順を人に委ねる形」の弱い版が残る（「何をすべきか覚える」を
   「コマンド名を覚える」まで縮めたに過ぎない）。**真の自動化**（アプリケーションの
   実行時、`@mnemora/core` の `runtime.observe`/`tick` などが書き込み量に応じて自律的に
   `ANALYZE` を発火する）は、本 PR の範囲外として意図的に踏み込まなかった——
   これは `runMigrations` に1行足すような小さな変更ではなく、**発火の頻度・複数プロセス間の
   協調（重複発火の抑止）・ホットパスへの追加コストという、新しい設計判断を要する**
   （1 PR = 1 ADR の原則を超える）。名前付きの負債としてここに残す
   ——ADR 0032 が `fail()` の自動リトライを name only の負債として残した形と同じ。
2. **PostgreSQL の自動バキューム（autovacuum）が、`ANALYZE` 未実行のギャップを自然に
   埋める可能性については検討していない。** 既定の `autovacuum_analyze_scale_factor`/
   `autovacuum_analyze_threshold` の下では、行が一定数変化すれば autovacuum が自律的に
   `ANALYZE` 相当を実行するはずだが、それが実際にどれだけの遅延で発火するか
   （`autovacuum_naptime` や他のテーブルとの競合次第で変わりうる）は、この作業では
   一切調べていない——「autovacuum に任せれば実質自動化ではないか」という論点は、
   検討しないまま残す。
3. **`ANALYZE` の副作用（決定3）は文書からの読みであり、この環境・このスキーマでの
   実測ではない。** 大きなテーブル（`docs/roadmap.md` が想定する規模）でのサンプリング
   所要時間、プランキャッシュ無効化の頻度・コストは未計測。
4. **サードパーティが `@mnemora/postgres` を消費するコードから、独自に `ANALYZE` を
   呼んでいる可能性**は確認していない——本 PR が追加した `runAnalyzeMemories` は
   新しい export であり、既存の呼び出し元との衝突は無いが、外部の利用実態は
   ADR 0142「誰が壊れうるか」と同じ理由でこのリポジトリからは確認できない。

---

## 採らなかった案

### `runMigrations` の `options` に `analyzeAfter?: boolean` を足す

却下。「検討した案」の案A・決定2参照——新規インストールでは効かないことが分かっている
操作を、責務の異なる関数に混ぜる理由が無い。

### `RunMigrationsOptions` を経由せず、`bin/migrate.ts` が無条件で毎回 `ANALYZE` を打つ

却下。「検討した案」の案B参照——新規インストールでは無意味な `ANALYZE` を、既に
統計が最新のケースも含めて毎回実行することになり、`--analyze-memories` という明示的な
オプションにする理由（「いつ呼ぶかは運用側が決める」）と矛盾する。

### `docs/roadmap.md` §5 へ送り、実装しない（案D）

決定1直前の「検討した案」参照。優先度・issue の記述・`docs/autonomy.md` §3.1 の
見分け方に照らして、技術的に決定可能と判断した。

### `packages/core`（ランタイム）に自動 `ANALYZE` 発火を実装する

却下（今回は）。「開いている穴」1番参照——発火頻度・複数プロセス間の協調・ホットパスへの
コストという新しい設計判断を要し、1 PR = 1 ADR の原則を超える。将来の issue として
切り出すべき規模だと判断した。

---

## これが覆るとしたら

- **`--analyze-memories` を実際に呼ぶ運用が定着せず、新規インストール後の ANN 性能問題が
  引き続き報告される場合**——「開いている穴」1番のランタイム自動発火（`@mnemora/core`
  側での実装）を、独立した issue/ADR として起こす引き金になる。
- **本 ADR の決定3（`ANALYZE` の副作用は書き込みをブロックしない）が、実際の CI の
  postgres ジョブ、または実運用の大きなテーブルで反証された場合**——README の
  「安全側に倒れる」という記述を差し替え、より慎重な運用手順（メンテナンスウィンドウでの
  実行を推奨する等）へ書き換える。
- **autovacuum の既定設定が、実運用でこのギャップを十分速く埋めることが確認された場合**
  ——「開いている穴」2番の論点が解け、`--analyze-memories` の位置づけを
  「必須の運用手順」から「autovacuum を待てない場合の早道」へ格下げできるかもしれない。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**無関係。** 本 ADR は運用手順・統計情報の更新であり、recall が毎回渡す量には影響しない。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `--analyze-memories` を一度も呼ばなくても、機能としては変わらず動く
（遅いだけで、`omitted`/エラーにはならない）——本 issue が「壊れてはおらず、遅いだけ」と
明記しているとおり。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** ANN の統計情報はプランナの内部状態であり、recall の trace には現れない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。**

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** `ANALYZE` は SQL 1文であり、LLM を一切呼ばない。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。**

- `pnpm --filter @mnemora/postgres run typecheck`（個別）、`pnpm run typecheck`
  （ルート、全7 workspace projects）— 緑。
- `pnpm run lint`（eslint、リポジトリ全体） — 緑。
- `pnpm run format:check`（prettier、リポジトリ全体） — 緑。
- `rm -rf packages/*/dist && pnpm run build` — 緑。
- `pnpm run pack:check` — 緑（6パッケージとも publish 梱包の検査を通過）。
- `pnpm run test`（ルート） — root 941 passed + 2 skipped / `@mnemora/core` 628 /
  `@mnemora/testkit` 260 / `@mnemora/openai` 43 passed + 11 skipped /
  `@mnemora/anthropic` 49 passed + 2 skipped / `@mnemora/local-embedding` 83 passed +
  15 skipped、すべて緑。**`packages/postgres` と `examples/chat` の DB テストは
  実行していない**（`DATABASE_URL` 未設定。「DB テストは実行していません」と明示的に
  告知されることを確認した）。
- `packages/postgres` の**DB を要さないテスト**（`cli-options.test.ts` /
  `migrate-cli-process.test.ts`）は、`pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/cli-options.test.ts src/__tests__/migrate-cli-process.test.ts` で
  直接実行し、**45本すべて緑**を確認した（`packages/postgres` の既定の `test:db`
  スクリプトは `DATABASE_URL` を要求しゲートするため、この2ファイルだけを個別に
  `vitest` へ渡してゲートを迂回した——迂回してよい理由は、この2ファイルが
  `Pool`/DB 接続を一切登場させない純関数の歯だから）。

### ⭐ WebFetch で PostgreSQL 公式文書を取得した（決定3の根拠）

上記「決定3」に引用した2URLを、この作業の中で実際に `WebFetch` で取得し、
`ANALYZE` の取得ロック（`SHARE UPDATE EXCLUSIVE`）・競合しないロック種別
（`ACCESS SHARE`/`ROW SHARE`/`ROW EXCLUSIVE`）・サンプリング方式
（`default_statistics_target` に基づく固定サイズ、全件走査ではない）を確認した。
**これは「読んだ」であって「測った」ではない**——この区別は決定3・「確かめていないこと」
で繰り返し明記している。

### 変異試験（DB を要さない部分。実際に実行した）

**手順**: 変異の前に `packages/postgres/src/bin/cli-options.ts` を
`/tmp/mnemora-backup-234/` へ退避コピーしてから、その場でコードを直接書き換えて赤を確認し、
退避コピーから `cp` で戻して緑を確認した（`git checkout` は使っていない——
`docs/autonomy.md` §4 が指摘する「未コミットの編集も消える」穴を踏まないため）。

- **M1**（`isTruthyEnvFlag` を `return true` で早期 return させ、`""`/`"0"`/`"false"` も
  真として扱わせる変異）: `cli-options.test.ts` 39本中**5本が固有に赤くなった**
  （`MNEMORA_ANALYZE_MEMORIES` の偽値5パターンすべてを検査する `it.each` の各ケース）。
  `cp` で復元後、45本（`migrate-cli-process.test.ts` と合わせて）すべて緑に戻ることを
  確認した。
- **M2**（`--analyze-memories` フラグの認識分岐を `if (false && arg ===
  ANALYZE_MEMORIES_FLAG)` に変異させ、フラグを一切認識させない）: **3本が固有に赤く
  なった**（「--analyze-memories を渡すと true になる」「--schema と併用できる」
  「フラグと環境変数のどちらか片方だけでも true になる（OR）」——いずれも
  `--analyze-memories` を渡した結果を検査する歯。この変異では `--analyze-memories` が
  `SCHEMA_FLAG`/`EXTENSION_SCHEMA_FLAG`/`EXTENSION_MODE_FLAG` のいずれにも一致せず
  「未知のオプション」としてエラーになるため、`expectOk` が失敗する形で赤くなった）。
  `cp` で復元後、45本すべて緑に戻ることを確認した。
- `git diff --stat`（変異が実際に入ったこと）・`cp` 復元後の `diff -u` に差分が無いこと
  （元に戻ったこと）の両方を確認した。

**⚠ この2本の変異試験が捕まえていないもの（DB を要するため、この環境では検証できない）**:

- `bin/migrate.ts` の `if (analyzeMemories) { await runAnalyzeMemories(pool, { schema }); }`
  という配線そのもの——`runAnalyzeMemories` の呼び出しを削除する・条件を反転させる、
  といった変異を当てても、**DB 接続が無いためこの環境ではテストの赤/緑を観測できない**。
  この配線を検査する歯は `analyze-memories.postgres.test.ts`（本 PR で新規追加、
  「CLI 配線」の it ブロック）に書いたが、**この環境では実行できておらず、変異試験も
  行っていない**。CI の postgres ジョブが唯一の実測経路である。
- `runAnalyzeMemories` 自体が実際に `ANALYZE` を発行し、`pg_class.reltuples` を
  更新することも同じ理由で未検証（`analyze-memories.postgres.test.ts` の
  「ライブラリ関数」の it ブロックに書いたが、実行はできていない）。

**⟹ 「歯が実際に噛むことを示した」と言えるのは、DB を要さない CLI 引数解釈の部分
（cli-options.ts）に限られる。DB を要する部分（runAnalyzeMemories の実体・
bin/migrate.ts の配線）は、歯を書いたが実行・変異試験のどちらもこの環境ではできておらず、
CI が唯一の実測経路である。** この区別を消さずに書く。

### `packages/postgres/README.md` の更新

**この文言の字面を検査する歯は無い**——先に `grep -rln "README.md" packages/postgres/src/
__tests__/*.ts scripts/*.mjs` で確認したが、`README.md` の内容を検査する既存の歯
（`ci-yml-compare-wiring.test.mjs` のような字面の歯）はこのリポジトリに見当たらず、
本 PR も新設していない。`pack:check`（`scripts/check-publish-pack.mjs`）は
「README.md がtarball に実在するか」だけを見ており、中身は見ない。

---

## 確かめていないこと

- **`packages/postgres` の DB を伴うテスト全体**（本 PR で追加した
  `analyze-memories.postgres.test.ts` を含む）。この作業環境には `DATABASE_URL` も
  docker も無い（`which docker podman psql postgres initdb` は全部何も返さない、実測）。
  Issue #247 / alteroid #965 / alteroid #1015 の族として既知の構造的な穴。
- **決定3（`ANALYZE` の副作用）はこの環境・このスキーマで測っていない。** PostgreSQL の
  公式文書から `SHARE UPDATE EXCLUSIVE` の競合表とサンプリング方式を確認したが
  （この作業で `WebFetch` により取得・確認済み）、大きなテーブルでの実際の壁時計時間・
  プランキャッシュへの影響は未計測。
- **`bin/migrate.ts` の配線（`--analyze-memories` → `runAnalyzeMemories` 呼び出し）と
  `runAnalyzeMemories` 自体の実行**。DB が無く、この環境では実行も変異試験もできていない
  ——CI の postgres ジョブで初めて確認される。
- **autovacuum が実運用でこのギャップをどれだけ速く埋めるか**は調べていない
  （「開いている穴」2番）。
- **サードパーティが `@mnemora/postgres` を消費するコードでの影響**——新規 export
  `runAnalyzeMemories` との衝突は無いはずだが、外部の利用実態はこのリポジトリからは
  確認できない。
- **CI 全体の緑。** この PR を出した後、`node scripts/ci-green-check.mjs --pr <番号>`
  で確認する（下記、報告参照）。
