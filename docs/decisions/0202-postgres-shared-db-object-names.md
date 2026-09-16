# ADR 0202: `packages/postgres` が作るオブジェクト名の一覧を README に置き、migrations と機械的に突き合わせる（Issue #168）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0195 等の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[Issue #168](https://github.com/takecchi/mnemora/issues/168) の残存項目の1つ:

> 共有 DB で衝突しうるオブジェクト名の一覧を `packages/postgres/README.md` に置き、
> `migrations/*.sql` から機械的に導いた集合と突き合わせる歯を足す。

`packages/postgres` を「他のアプリと共有する Postgres」へ入れる採用者は、mnemora が
どんなテーブル・索引・advisory lock キーを持ち込むかを、`migrations/*.sql` を自分で
読まなくても確認できる必要がある。**README に一覧を書くだけでは、マイグレーションを
足したのに README を直し忘れる、というずれが必ず起きる**（`AGENTS.md`「正典と実装が
食い違ったら」と同じ形の問題）。

## ⭐ 着手コメントの数字は使わなかった

この issue への着手コメント（マネージャー、2026-09-17）は、素朴な `grep` で
「テーブル8・`CREATE INDEX` 文34」を数え、**自ら「34は `DROP` を考慮していないので
索引の本数として読まないこと」と断っていた** 【現物】。

実際に `packages/postgres/migrations/*.sql`（17本、2026-09-17時点）を確認すると
【現物】:

- `DROP TABLE` / `DROP INDEX` は1本も無い。
- `grep -oP 'CREATE (UNIQUE )?INDEX' migrations/*.sql` は**34件**を返すが、うち
  **14件はコメント中の言及**である（例: `0001_init.sql` 冒頭のコメントが
  `docs/memory-model.md` 原案の誤った索引定義を引用している。各移行ファイルが
  「この `CREATE INDEX` は `CONCURRENTLY` を付けない」という注記で
  `CREATE INDEX CONCURRENTLY` という文字列を散発的に含む、等）。
- コメントを剥がして実際の `CREATE TABLE` / `CREATE INDEX` 文だけを数えると、
  **テーブル8・索引20**（ユニーク索引2本を含む）。

⟹ **34 は「広い集合からの切り取り」であり、索引の本数ではなかった。**この ADR の歯は
着手コメントの数字を写さず、`packages/postgres/migrations/*.sql` の現物から
自分で導き直した（導出ロジックは `scripts/readme-postgres-objects-lib.mjs` の
`deriveMigrationObjects`）。

## 決定

### 1. `packages/postgres/README.md` に「この package が作るオブジェクト」節を足す

次の4種類を列挙する:

- **テーブル**（8）: `migrations/*.sql` の `CREATE TABLE` から導いた最終形。
- **索引**（20）: `migrations/*.sql` の `CREATE INDEX` / `CREATE UNIQUE INDEX` から
  導いた最終形。**`DROP` された索引があれば数えない**——現時点では0本だが、
  将来増えても崩れない導出方法にした（下記「歯」参照）。
- **実行時に増える系列**: `registerEmbeddingSpace` を呼ぶたびに埋め込み空間ごとに
  増える `memory_embeddings_<space>`（テーブル）と
  `idx_memory_embeddings_hnsw_<space>`（HNSW索引）。接頭辞は
  `packages/postgres/src/embedding-space-table.ts` の `TABLE_PREFIX` /
  `HNSW_INDEX_PREFIX` から読んだ 【現物】。
- **advisory lock のキー**: `runMigrations` と `registerEmbeddingSpace` それぞれの
  既定キー（`MIGRATION_LOCK_KEY` = `7190158676462701299`、
  `REGISTER_EMBEDDING_SPACE_LOCK_KEY` = `-4359922960011245935`。どちらも
  `packages/postgres/src/*.ts` から読んだ 【現物】）と、`--schema` 指定時に
  `deriveAdvisoryLockKey`（sha256）で導出するシード文字列の接頭辞。

**`CREATE FUNCTION`（`mnemora_lexical_normalize` 等、`0008`/`0009` が作る5個）は
対象外にする。**Issue #168 のこの残存項目が名指ししたのは上の4種類であり、関数は
そこに無い。関数名も理屈のうえでは共有 DB で衝突しうるが、この節・この歯は
それを検査しない——README にもその限定を明記する（下記「引き受けた負債」参照）。

### 2. 突き合わせの歯を `scripts/__tests__/` に足す

`scripts/readme-postgres-objects-lib.mjs`（純関数）と、それを検査する
`scripts/__tests__/readme-postgres-objects-lib.test.mjs`、および
`packages/postgres/migrations/*.sql` / `packages/postgres/src/*.ts` /
`packages/postgres/README.md` を実際に読んで突き合わせる
`scripts/__tests__/readme-postgres-objects.test.mjs` を新設する。

- **DB は要らない**——`.sql` / `.ts` / `.md` のテキストを読むだけ。
- **YAML/SQL パーサの依存は足していない**——既存の `*-wiring.test.mjs` 系
  （`ci-yml-time-term-wiring.test.mjs` 等）や `postgres-auth-parity-lib.mjs` と同じく、
  正規表現と行走査だけで読む。依存追加はオーナー専権
  （`docs/autonomy.md` / ADR 0014・0061）。
- **`DROP` を考慮した最終形を導く**: 全 migration ファイルをファイル名順に結合した
  テキストを1回走査し、`CREATE`/`DROP` を出現順に適用して集合を組み立てる
  （`deriveMigrationObjects`）。コメント中の `CREATE INDEX` 等の言及は、走査の前に
  `--` 行コメントを剥がすことで除外する。
- ルートの `vitest run`（`scripts/**/*.test.mjs`、`vitest.config.mts`）が拾う既存の
  場所に置いた——新しい CI ジョブは足していない。

### 3. 見出しに件数（`（8）`/`（20）`）を書き、歯がそれも検査する

一覧の項目数と見出しの数字がずれる事故（人手で1件足したのに見出しを直し忘れる）も
拾えるようにするため、見出しの `（N）` を件数として検査対象にした。

## 検討して採らなかった案

- **`CREATE FUNCTION` も対象に含める。**
  ⟹ **採らない。**Issue #168 のこの項目が名指しした4種類の外であり、対象を広げると
  この PR が何を主張しているかが読みにくくなる（`docs/autonomy.md`「ついでに直す
  をしない」）。関数名の衝突リスクは、引き受けた負債として明記する。
- **YAML/markdown パーサ（remark 等）を導入して README を構造的に解析する。**
  ⟹ **採らない。**この repo の wiring 系の歯は一貫して正規表現・行走査で済ませており
  （依存追加はオーナー専権）、この歯もその流儀に揃えた。**書き方（見出しの文言・
  箇条書きの記法）が変わると歯が壊れる**——それは許容する代償である。
- **`memory_embeddings_<space>` / `idx_memory_embeddings_hnsw_<space>` について、
  実際に `registerEmbeddingSpace` を実行して作られた名前を確認する。**
  ⟹ **採らない（採れない）。**この歯は DB を要求しない設計にしており、実行時に
  作られる名前は `(provider, model, dimensions)` の実際の値に依存する——
  静的な検査の範囲外である。下記「引き受けた負債」に明記する。

## 引き受けた負債

1. **`CREATE FUNCTION` は検査対象外。**現時点で5個
   （`mnemora_lexical_normalize` / `mnemora_lexical_query_terms` /
   `mnemora_lexical_query_tsqueries` / `mnemora_lexical_query_or` /
   `mnemora_lexical_coverage`、`0008`/`0009`）在るが、README のこの節にも
   この歯にも入っていない。将来これらの名前を変える・増やすとき、この節は
   何も検出しない。
2. **⭐ 実行時に増える系列は、命名規則しか検査していない。実際に作られた名前
   そのものは見ていない。** `embeddingSpaceTableName` / `embeddingSpaceIndexName`
   （`embedding-space-table.ts`）は63バイト超のときスラグを切り詰めてハッシュ片を
   足す分岐を持つが、この歯はその分岐を通していない——`TABLE_PREFIX` /
   `HNSW_INDEX_PREFIX` という接頭辞の一致しか見ない。**もしこの覆るとしたら**、
   誰かが実際に長い `(provider, model, dimensions)` の組で登録したときに、
   README の説明文だけでは名前を予測できないと気づいたときである。そのときは
   README に切り詰め規則も書き、歯を関数呼び出しレベルまで広げる必要がある。
3. **正規表現ベースの抽出は、書き方の変更に弱い。**`ci-yml-time-term-wiring.test.mjs`
   と同じ限界——README の見出し文言や箇条書きの記法（`- \`name\`` の形）を変えると、
   歯は「見出しが見つからない」「一致しない」という形で壊れる。壊れたときは
   「一覧が変わった」のか「書き方が変わった」のかを見て、書き方が変わっただけなら
   歯の正規表現のほうを直すこと（歯を消さないこと）。
4. **advisory lock キーの「既定スキーマ」の分岐（`schema === undefined ||
   schema === "public"`）は README に文章で説明するのみで、歯はその分岐の
   条件式そのものは検査していない。**`migrationLockKeyFor` / 
   `registerEmbeddingSpaceLockKeyFor` の実装がこの分岐を変えても、
   歯は定数値とシード接頭辞の一致しか見ないため気づかない。

## これが覆るとしたら、何が起きたときか

- **`migrations/*.sql` に実際に `DROP TABLE` / `DROP INDEX` を含む移行が追加されたとき。**
  `deriveMigrationObjects` は出現順に `CREATE`/`DROP` を適用する設計なので、
  そのまま動くと見込んでいるが、実際に踏むまでは【実測】していない
  （現時点でこの分岐を通す移行が1本も無いため）。
- **`CREATE FUNCTION` の名前が、実際に共有 DB で衝突する報告が来たとき。**
  そのとき負債1番を解消する（対象に含める）ADR が要る。
- **埋め込み空間の識別子が63バイトの切り詰め分岐に実際に当たったとき。**
  負債2番を解消する必要が生まれる。

## 測ったこと

- 【現物】`packages/postgres/migrations/*.sql`（17本）を読み、コメントを剥がした
  実際の `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` を数えた
  （テーブル8・索引20）。`DROP TABLE` / `DROP INDEX` が0本であることも確認した。
- 【現物】`packages/postgres/src/embedding-space-table.ts` の `TABLE_PREFIX` /
  `HNSW_INDEX_PREFIX`、`packages/postgres/src/migrate.ts` の `MIGRATION_LOCK_KEY` /
  `migrationLockKeyFor`、`packages/postgres/src/vector-space.ts` の
  `REGISTER_EMBEDDING_SPACE_LOCK_KEY` / `registerEmbeddingSpaceLockKeyFor` を
  それぞれ読んだ。
- 【実測】`pnpm exec vitest run scripts/__tests__/readme-postgres-objects-lib.test.mjs`
  が緑（16 tests）。
- 【実測】`pnpm exec vitest run scripts/__tests__/readme-postgres-objects.test.mjs`
  が緑。
- 【実測】変異試験: README のテーブル一覧から1件消すと、欠けた名前を名指しして赤に
  なる。実在しない名前を1件足すと、その名前を名指しして赤になる。両方戻すと緑に
  戻り、`git status --porcelain` が空になる。（詳細な出力は PR 本文。）
- 【実測】ADR 番号は `node scripts/adr-renumber.mjs --next`（ADR 0179）で採った
  ——`origin/main` の ADR 188本・他のリモートブランチ18本・open な PR 5本の主張を見て
  `0200` を返した。**確定はマージ直前の既定動作が行う。**

## 確かめていないこと

- **共有 DB での実際の衝突事例は無い。**この ADR は「事前に確認できるようにする」
  という予防措置であり、実際に衝突を防いだ実績は無い。
- **`CREATE FUNCTION` の名前が衝突しうるかどうかの実害**は確かめていない
  （引き受けた負債1番）。
- **切り詰め・ハッシュ付与の分岐を実際に通した場合の名前**は確かめていない
  （引き受けた負債2番）。
