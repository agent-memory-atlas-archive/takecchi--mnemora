# ADR 0126: マイグレーションの説明 comment に語を書いても歯が反応しないよう、歯の側で comment を剥がしてから検査する

- **状態**: 採用 (2026-09)

- **文脈**:

  `packages/postgres/src/__tests__/migrate-default-path-unchanged.test.ts` は、既定経路
  （`schema` 未指定）で `runMigrations` が発行する SQL 列に、専用スキーマ（ADR 0057）
  向けの SQL（`CREATE SCHEMA` / `SET LOCAL search_path`）が一切現れないことを、
  各エントリへの正規表現 `expect(entry).not.toMatch(/SET LOCAL search_path/)` で検査する。

  一方 `packages/postgres/src/migrate.ts` は `migrations/*.sql` の生テキストを
  **comment ごと** `client.query()` へ渡す（`runMigrations` の該当箇所、
  `await client.query(sql)`）。これ自体は正しい——PostgreSQL 自身が comment を無視して
  実行するので、comment を残したまま送っても実行結果は変わらない。

  ⟹ **マイグレーションの説明 comment に `SET LOCAL search_path` という字面を書くと、
  SQL の挙動が正しくてもこの歯が落ちる。**歯が見ているのは「実行される文」ではなく
  「発行したテキストの字面」だった。

  これは PR #226（Issue #195 / ADR 0122）で実際に踏まれた。
  `migrations/0011_memory_events_kind_restored.sql` の説明 comment に
  「`` `SET LOCAL search_path TO <schema>[,<extensionSchema>]` の直後に実行する ``」と
  書いたところ、この歯が落ちた:

  ```
  FAIL src/__tests__/migrate-default-path-unchanged.test.ts
    > migrate.ts CLI の既定経路: options 省略と1バイトも変わらない
  AssertionError: expected 'client.query: -- 0011_memory_events_k…' not to match /SET LOCAL search_path/
  ```

  当時の担い手はコメントを言い換えて（`SET LOCAL` と `search_path` の間に語を挟んで）
  歯を通したが、これは**歯を黙らせただけ**であり、Issue #227 が名指しした通り
  「制約がどこにも書かれていない」「コメントを消す／言い換えるという直し方が最も
  手軽で最も悪い」という2つの問題を残していた。

  同じ族の問題として Issue #224（`ci.yml` の pgvector ジョブ本数を固定値で持つ歯）が
  既に在る——歯が「実体」ではなく「字面」を見ているために、実体が正しくても落ちる、
  という形が2件目である。

- **検討した選択肢**（Issue #227 が挙げた4案）:

  1. **検査の前に、SQL から comment を剥がす（採用）。**
     歯の主張（「既定経路は `SET LOCAL search_path` を**実行**しない」）を、より正確に
     表現する——主張しているのは**実行される文**についてであって、comment についてでは
     ない。

     ⚠ Issue #227 自身が「剥がし方を自前で書くと、そこが新しいバグの置き場になる」と
     警告している（`--` 行・`/* */` ブロック・文字列リテラル中の `--`）。この懸念には、
     専用の字句解析（state machine）を書き、それ自体を単体テストで裏取りすることで
     応える（下記「実装」節）。

  2. **発行テキストではなく、実際に実行された文を記録して検査する。**
     **落とす。** 現在の偽 `Pool`/`client`（`createFakePool`）は「`query()` に渡された
     引数をそのまま記録する」だけの薄いモックであり、「実行された文」という概念を
     持たせるには、パーサでテキストをステートメント単位に分割する層を新設する必要が
     ある——これは選択肢1の剥がし方より複雑で（コメント除去に加えて、`$$ ... $$` を
     跨ぐ `;` を無視しつつ文を分割する必要がある）、かつ2本目の it
     （空振り防止: `log.some((entry) => entry.includes(sql))`、生の migration 本文が
     そのまま流れていることを見る）の前提を壊す。歯の複雑さに見合う追加の保証が
     選択肢1に対して無い。

  3. **制約を明文化して、字面のままにする**
     （`migrations/` の先頭か `AGENTS.md` に「マイグレーションの comment にこの語を
     書かない」と書く）。
     **落とす。** `AGENTS.md` は「ここに北極星の要約を置かない」の節で
     「複製した瞬間から、正文と要約はずれ始める。片方を直してもう片方を直し忘れることは、
     **規律ではなく注意力に依存しており、必ず失敗する**」と名指しで述べている。
     この案が要求するもの（「次にこの語を書きたくなった人が、書く前にこの禁止事項を
     思い出して避ける」）は、まさにその「規律ではなく注意力への依存」そのものであり、
     `AGENTS.md` が既に退けた形と矛盾する。**採らない。**

  4. **歯の正規表現を、実行される文の位置に限定する**（行頭アンカー・comment 行の除外）。
     **落とす。** 選択肢1の簡易版であり、同じ種類の「自前の剥がし方」を、テストより
     浅い形（行頭アンカーだけでは `/* */` ブロック comment や、comment 行の直後に
     続く行が実は文字列リテラルの続きである場合を区別できない）で持ち込むだけになる。
     選択肢1と実装コストがほぼ同じで、正確さは劣るため、選択肢1を上位互換として採る。

- **決定**:

  - `packages/postgres/src/__tests__/sql-comments.ts` に、歯専用のユーティリティ
    `stripSqlComments(sql: string): string` を新設する。
    - `--` 行 comment（行末まで除去、改行は残す）
    - `/* ... */` ブロック comment（PostgreSQL は入れ子を許すため、深さを数えて対応する
      閉じまで除去。除去した跡には token が隣接して繋がらないよう空白を1つ残す）
    - を、次のいずれの中にもいないときだけ剥がす（＝これらの中では `--` も `/*` も
      一切特別扱いしない）:
      - `'...'`（単一引用符の文字列。`''` はその中の引用符自身のエスケープ）
      - `"..."`（二重引用符の識別子。`""` は同様のエスケープ）
      - `$tag$...$tag$` / `$$...$$`（dollar-quoting。`migrations/0008` `0009` `0011` が
        実際に使う。dollar-quoted 文字列の**中身は opaque な文字列として丸ごとコピー
        するだけ**——PostgreSQL の最外層のパーサ自身が dollar-quoted を1個の文字列
        リテラルとしてしか見ないことに合わせた。中の comment は剥がさない）
  - `migrate-default-path-unchanged.test.ts` の1本目の it（既定経路の SQL 列の検査）を、
    各エントリに `stripSqlComments` を通してから `.not.toMatch(...)` にかけるよう変更した。
    2本目の it（空振り防止、生の migration 本文が流れていることを見る）は**変えない**
    ——そちらは生テキスト（comment 込み）が流れていることそのものを見る歯であり、
    comment を剥がすと壊れる。
  - `packages/postgres/src/migrate.ts` は**一切変えない**。DB へ実際に送る文字列は
    今まで通り comment 込みの生テキストのままである——comment を剥がして送る意味も
    権限も無い（PostgreSQL 自身が comment を無視する）。`stripSqlComments` は
    `../migrate.ts` から一切参照されない、歯専用のユーティリティである。
  - `stripSqlComments` 自身の単体テストを
    `packages/postgres/src/__tests__/sql-comments.test.ts` に新設した（Issue #227 が
    名指しした3ケース——行 comment・ブロック comment・文字列リテラル中の `--`——を
    直接検査したうえで、`migrations/*.sql` の実物すべてに対しても壊れずに通ることを
    確かめる。17本）。
  - `migrations/0011_memory_events_kind_restored.sql` の説明 comment を、PR #226 で
    言い換えて回避した表現から、自然な表現（`` `SET LOCAL search_path TO
    <schema>[,<extensionSchema>]` の直後に実行する ``）へ戻した。**これは「ついでに
    直す」ではなく、この PR の主張（歯が字面ではなく実行される文に反応するように
    なった）の実証である**——直っていなければこの行を戻した瞬間に歯が落ちる。

- **理由**:

  歯が守りたい主張は「既定経路は `SET LOCAL search_path` を実行しない」であって、
  「発行するテキストにその字面が一切現れない」ではない。両者は今まで区別されておらず、
  後者のほうが厳しいために誤検知していた。`stripSqlComments` は、検査対象を
  前者（実行される文）に近づける、最小の変更である。

  Issue #227 の警告（「自前の剥がし方を歯無しで入れないこと」）には、`stripSqlComments`
  自身の単体テストで応える。特に「文字列リテラルの中に現れる `--`」というケース
  （警告が名指ししたもの）は、単一引用符・二重引用符・dollar-quoting のいずれについても
  直接のテストケースを持つ。

- **結果（この決定が招くもの）**:

  - `migrate-default-path-unchanged.test.ts` は、今後マイグレーションの説明 comment に
    `SET LOCAL search_path` という字面を書いても落ちない。**同じ理由で、
    説明 comment に `CREATE SCHEMA` と書いても落ちない**（同じ検査ループが両方の
    正規表現を見ているため、恩恵は自動的に両方に及ぶ）。
  - `stripSqlComments` は歯専用（`src/__tests__/` 配下）であり、`@mnemora/postgres` の
    公開 API には一切現れない。パッケージの外部からは見えない。
  - **引き受けた負債**: `stripSqlComments` は PostgreSQL の完全な字句解析器ではない。
    次の2点は明示的に対象外である（doc コメント・下の「確かめていないこと」参照）:
    - `E'...'`（バックスラッシュエスケープ文字列）は単一引用符の文字列と同じ規則
      （`''` エスケープのみ）で扱い、バックスラッシュ escape は解釈しない。
    - 違うタグ同士が入れ子になった dollar-quoting（例: `$a$ ... $b$ ... $b$ ... $a$`）。
    - dollar-quoted 文字列（関数本体）の中身にある comment は剥がされない
      （opaque な文字列として扱うため）。
    現状の `migrations/*.sql` はどれも使っていない（grep で確認済み。下記「測ったこと」）。
    将来これらを使うマイグレーションが増えたら、`stripSqlComments` を先に拡張すること
    ——さもなくば、この歯がまた「字面」に反応する側へ戻る可能性がある。

- **測ったこと**:

  - `sql-comments.test.ts`（17 tests）: `stripSqlComments` の単体テスト。
    `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/sql-comments.test.ts`
    で緑。
  - `migrate-default-path-unchanged.test.ts`（3 tests）: 修正後、緑。
  - **変異試験・両側**（詳細は PR 本文）:
    1. `migrate.ts` の既定経路にも `SET LOCAL search_path` を発行する変異を
       一時的に入れたところ、この歯は**赤くなった**（`stripSqlComments` を経由しても、
       comment ではなく実際に発行された文の中の字面には反応する——歯を黙らせただけでは
       ないことの実証）。
    2. `migrations/0011...sql` の説明 comment に `SET LOCAL search_path` という字面が
       実際に存在する状態（自然な表現へ戻した後の状態そのもの）で、この歯は**緑のまま**
       だった。
  - `git grep -n "SET LOCAL search_path" packages/postgres/migrations` で、
    dollar-quoted 本体（`0008` `0009` `0011`）のいずれもこの字面を含まないことを確認
    （2026-09）。
  - `packages/postgres` の非 DB テスト6本
    （`cli-options.test.ts` / `extension-mode.test.ts` / `migrate-cli-process.test.ts` /
    `schema-namespace.test.ts` / `sql-comments.test.ts` /
    `migrate-default-path-unchanged.test.ts`、計87 tests）が緑であることを確認。

- **確かめていないこと**:

  - **この作業環境に `DATABASE_URL` が無く、`packages/postgres` の DB 付きの歯
    （`*.postgres.test.ts` 等)は一切実行できていない。**`0011_memory_events_kind_restored.sql`
    の comment を戻したことが実際のマイグレーション適用（`dedicated-schema.postgres.test.ts`
    等）に影響しないことは、CI の DB 付きジョブが実測の場になる
    （comment のみの変更なので実行結果は変わらないはずだが、これは推論であり実測ではない）。
  - `stripSqlComments` を、`migrations/*.sql` 以外の任意の SQL 文字列
    （たとえば `migrate.ts` が組み立てる `INSERT ... VALUES ($1)` のような
    パラメータ化クエリ全般）に対して網羅的にファズテストしたわけではない。
    今回のテストは「Issue #227 が名指ししたケース」と「実物の `migrations/*.sql`」に
    絞ってある。

- **これが覆るとしたら**:

  - `migrations/*.sql` が `E'...'` やタグ違いの入れ子 dollar-quoting を使うようになったとき
    ——`stripSqlComments` を先に拡張する必要がある（上の「引き受けた負債」参照）。
  - 歯の粒度そのものを見直すとき（選択肢2「実際に実行された文を記録する」）——
    複数のマイグレーションが増え、コメント除去だけでは「実行される文」の主張を
    正確に表現できなくなった場合（たとえば、1つのマイグレーションファイル内で
    条件分岐して一部の文だけが実行される、といった機能が入った場合）。
    いまの `migrations/*.sql` はどれも「ファイル全体を1つの `client.query()` 呼び出しで
    流す」という単純な形なので、そこまでの複雑さは要らない。
