# ADR 0204: `packages/postgres` の共有オブジェクト名の歯を関数まで広げ、ADR 0202「引き受けた負債1」を解消する（Issue #168）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0195 / ADR 0202 と同じ体裁）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[ADR 0202](./0202-postgres-shared-db-object-names.md)「引き受けた負債」1番はこう書いていた:

> `CREATE FUNCTION` は検査対象外。現時点で5個
> （`mnemora_lexical_normalize` / `mnemora_lexical_query_terms` /
> `mnemora_lexical_query_tsqueries` / `mnemora_lexical_query_or` /
> `mnemora_lexical_coverage`、`0008`/`0009`）在るが、README のこの節にも
> この歯にも入っていない。将来これらの名前を変える・増やすとき、この節は
> 何も検出しない。

[Issue #168](https://github.com/takecchi/mnemora/issues/168) はこの負債を解消する項目として残っていた。**この ADR は、「検査しない」と
書き直して負債を追認するのではなく、歯を関数まで広げて負債そのものを消す。**

## ⭐ 着手コメントの数字は写さず、自分で導出し直した

この issue への着手コメント（マネージャー、2026-09-17）は、参考として
「`mnemora_lexical_coverage` / `mnemora_lexical_normalize` / `mnemora_lexical_query_or` /
`mnemora_lexical_query_terms` / `mnemora_lexical_query_tsqueries` の5個、`DROP FUNCTION` は
0本」という実測を添えていた。**この ADR の歯はその数字を写さず、
`packages/postgres/migrations/*.sql`（17本、2026-09-17時点）の現物から自分で導いた**
（`scripts/readme-postgres-objects-lib.mjs` の `deriveMigrationObjects` を拡張した実装）。

【実測】`grep -niE "CREATE (OR REPLACE )?FUNCTION|DROP FUNCTION" packages/postgres/migrations/*.sql`
で拾える `FUNCTION` への言及は5件、すべて実際の `CREATE FUNCTION` 文であり
（コメント中の言及は無い）、`DROP FUNCTION` は0本。実装した `deriveMigrationObjects` を
実際の17本のmigrationsに対して走らせた結果も同じ5個
（`mnemora_lexical_coverage` / `mnemora_lexical_normalize` / `mnemora_lexical_query_or` /
`mnemora_lexical_query_terms` / `mnemora_lexical_query_tsqueries`）で、テーブル8・索引20
（ADR 0202 と同じ数）にも変化は無い。**⟹ 着手コメントの数字と一致したが、それは
写した結果ではなく、独立に導出した結果がたまたま一致したものである。**

## 決定

### 1. `deriveMigrationObjects`（`scripts/readme-postgres-objects-lib.mjs`）の導出を関数まで広げる

- テーブル・索引と同じ作法で、`migrations/*.sql` をファイル名順に結合したテキストを
  1回走査し、`CREATE`/`DROP` を出現順に適用した最終集合を関数についても組み立てる。
- **`CREATE OR REPLACE FUNCTION` にも対応する。**素朴に `CREATE FUNCTION` だけを探すと、
  将来誰かが既存の関数を `CREATE OR REPLACE FUNCTION` で置き換えたときに取りこぼす
  ——今回書いた正規表現
  (`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?<createFunction>...)\s*\(`) は
  `OR REPLACE` を任意にして、関数名の直後に `(` が続くことを要求する
  （テーブル・索引名との混同を避けるため）。
- **SQL コメント（`--` 行コメントと `/* */` ブロックコメント）を先に剥がしてから走査する。**
  既存の `stripSqlLineComments`（`--`）に加え、新たに `stripSqlBlockComments`
  （`/* ... */`）を足した——2026-09時点の migrations にブロックコメントは無いが
  【現物】、関数定義の直前に長いブロックコメントで注記が書かれることは将来ありうる
  ため、テーブル・索引と対称に両方剥がす設計にした。
- `DROP FUNCTION` が最終集合から関数名を消す（テーブル・索引の `DROP TABLE`/`DROP INDEX`
  と同じ扱い）。

### 2. `packages/postgres/README.md` に「関数」節を足し、⚠「対象外」の断り書きを消す

「この package が作るオブジェクト」節に `### 関数（5）` を追加し、テーブル・索引と
同じ箇条書きの形（`- \`name\``）で列挙する。ADR 0202 が書いていた
「⚠ `CREATE FUNCTION` は対象外」という断り書きは、もう事実に反するため削除する
——**対象外ではなくなったのだから、断りも残さない。**

### 3. `scripts/__tests__/readme-postgres-objects.test.mjs` / `-lib.test.mjs` に検査を足す

- `-lib.test.mjs`: `stripSqlBlockComments` の単体テスト、`deriveMigrationObjects` の
  関数抽出（`CREATE FUNCTION` / `CREATE OR REPLACE FUNCTION` / `DROP FUNCTION` /
  コメント中の言及の無視）の単体テスト、`parseReadmeObjectsSection` が関数一覧・
  見出し件数も返すことを検査するテスト、および
  `packages/postgres/migrations` の現物から導くと関数5個になることを固定する
  回帰止めのテストを足した。
- `readme-postgres-objects.test.mjs`: README の関数一覧と `deriveMigrationObjects`
  が導いた集合を過不足なく突き合わせるテストと、関数見出しの件数表記の一致を
  検査するテストを足した。**「対象外であることが明記されている」という
  旧テストは削除**し、代わりに「関数一覧が空でない」という回帰止め
  （対象に含めたことそのものが消えないようにする）に置き換えた。

## 検討して採らなかった案

- **ADR 0202 の「対象外」を「引き受けた負債として維持する」のまま何もしない。**
  ⟹ **採らない。**マネージャーからの指示が「検査しないと書き直すのではなく、歯を
  広げて負債を消す」ことを明示していた。技術的にも、関数の抽出はテーブル・索引と
  同じ正規表現・行走査の作法をそのまま延長できる範囲であり、YAML/SQL パーサの
  追加のような重い判断を要しない（ADR 0202 が既に「パーサは導入しない」と決めている
  流儀に単に従うだけである）。
- **関数の引数シグネチャ（`(text)` / `(text, text)` 等）まで検査対象にする。**
  ⟹ **採らない（今回は）。**PostgreSQL は同名でシグネチャ違いの関数（オーバーロード）
  を許すため、シグネチャまで見るなら「関数名の集合」ではなく「(名前, 引数型) の集合」
  を導出する必要があり、正規表現の複雑さが一段上がる。**現時点の5関数はいずれも
  オーバーロードを持たず、シグネチャ違いで衝突するケースが実在しない**——実在しない
  ケースのために歯を複雑にする理由が無い。シグネチャまで見ないことは、下記
  「引き受けた負債」に明記する。
- **`CREATE OR REPLACE FUNCTION` を無視し、素朴な `CREATE FUNCTION` だけを拾う。**
  ⟹ **採らない。**マネージャーの指示にも明記されていた注意点であり、実際に
  PostgreSQL の関数定義は「後発の migration が `CREATE OR REPLACE FUNCTION` で
  既存の関数を置き換える」という形を取りうる。素朴な形だと、この置き換えを
  検出できないまま「関数が増えた」ことだけを検出し、「置き換えられた」ことは
  見えない——テーブル・索引の `DROP`→`CREATE` と対称な形にするため、
  `OR REPLACE` を明示的に組み込んだ。

## 引き受けた負債

1. **引数シグネチャ（`(text)` 等）までは検査していない。**PostgreSQL は同名で
   シグネチャ違いの関数（オーバーロード）を許す。**この歯は関数名の集合しか見ない**
   ——同名で異なるシグネチャの関数が2つ migrations に存在しても、この歯は
   「関数名は1つ」としか見ない（`Set` に畳まれる）。もしこれが問題になるとしたら、
   将来 mnemora が意図的にオーバーロードを使ったときである。
2. **`CREATE OR REPLACE FUNCTION` で同名を別シグネチャ・別実装に置き換えた場合、
   「何が変わったか」はこの歯からは分からない。**関数名の集合としては変化が無い
   ため、README 上も「同じ関数がある」ようにしか見えない。実装が変わったことに
   気づく手段は、この歯の外（レビュー・変更差分の確認）に委ねている。
3. **正規表現ベースの抽出は、書き方の変更に弱い**——ADR 0202「引き受けた負債」3番と
   同じ限界をそのまま関数にも引き継ぐ。`CREATE FUNCTION <name> (` の間に想定外の
   空白・改行の入り方をされると取りこぼす可能性がある（現状の5関数はすべて
   `FUNCTION <name>(` の隣接、または1つのスペースを挟む形で書かれており、
   このパターンで拾えることは実測したが、任意の書き方を網羅したわけではない）。
4. **ADR 0202「引き受けた負債」2番・4番（実行時に増える系列の切り詰め分岐・
   advisory lock キーの既定スキーマ分岐）はこの ADR の範囲外——解消していない。**
   この ADR が解消するのは負債1番（関数の対象外）だけである。

## これが覆るとしたら、何が起きたときか

- **mnemora が実際に関数のオーバーロード（同名・別シグネチャ）を使い始めたとき。**
  そのとき負債1番・2番を解消する必要が生まれる——`deriveMigrationObjects` の
  戻り値を `functions: string[]` から `functions: { name: string, signature: string }[]`
  相当へ広げる改修になる見込みだが、実装するまでは【実測】していない。
- **正規表現が拾えない書き方（負債3番）で実際に関数定義が壊れて見逃したとき。**
  そのときは `ci-yml-time-term-wiring.test.mjs` 系と同じ扱い——「一覧が変わった」の
  か「書き方が変わった」のかを見て、書き方が変わっただけなら歯の正規表現を直す
  （歯を消さない）。

## 測ったこと

- 【現物】`packages/postgres/migrations/*.sql`（17本、2026-09-17時点）を
  `grep -niE "CREATE (OR REPLACE )?FUNCTION|DROP FUNCTION"` で確認し、5件すべてが
  実際の `CREATE FUNCTION` 文（コメント中の言及は無し）、`DROP FUNCTION` は0本
  であることを確認した。
- 【実測】拡張した `deriveMigrationObjects` を実際の17本の migrations に対して
  Node の `--input-type=module` ワンライナーで走らせ、
  `{ tables: [8個], indexes: [20個], functions: [5個] }`
  （関数は `mnemora_lexical_coverage` / `mnemora_lexical_normalize` /
  `mnemora_lexical_query_or` / `mnemora_lexical_query_terms` /
  `mnemora_lexical_query_tsqueries`）を得た。ADR 0202 のテーブル8・索引20から
  変化していないことも確認した。
- 【実測】`pnpm exec vitest run scripts/__tests__/readme-postgres-objects-lib.test.mjs
scripts/__tests__/readme-postgres-objects.test.mjs` が緑（39 tests）。
- 【実測】変異試験: README の関数一覧から `mnemora_lexical_query_or` を1件消すと、
  その名前を名指しして赤になった。実在しない `mnemora_lexical_ghost_function` を
  1件足すと、その名前を名指しして赤になった。`cp` で退避したコピーから復元すると
  緑に戻り、`git status --porcelain` は狙った4ファイル
  （`packages/postgres/README.md` / `scripts/readme-postgres-objects-lib.mjs` /
  `scripts/__tests__/readme-postgres-objects.test.mjs` /
  `scripts/__tests__/readme-postgres-objects-lib.test.mjs`）だけになった。
- 【実測】ADR 番号は `node scripts/adr-renumber.mjs --next`（ADR 0179）で採った
  ——`origin/main` の ADR 192本・他のリモートブランチ17本・open な PR 5本の主張を見て
  `0204` を返した（`0198`・`0203` は他の作業者が既に主張していると見られる）。
  **確定はマージ直前の既定動作が行う。**

## 確かめていないこと

- **共有 DB での実際の関数名の衝突事例は無い。**この ADR も ADR 0202 と同じく
  予防措置であり、実際に衝突を防いだ実績は無い。
- **オーバーロード（引数シグネチャ違い）を実際に使った場合にこの歯がどう壊れるか**
  は確かめていない（引き受けた負債1番）——実装が無いため再現していない。
- **`FUNCTION <name>` の間の空白・改行の書き方を大きく変えたときに正規表現が
  壊れるかどうか**は、実際にそのような書き方の migration を書いて確認してはいない
  （引き受けた負債3番）。
