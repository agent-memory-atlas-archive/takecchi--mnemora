# ADR 0017: `runMigrations()` を advisory lock でプロセス間排他する

- **状態**: 採用 (2026-09)

> **⚠ 2026-09-17 追記（名乗りの復元。本文は書き換えていない）。**
> 本文の「**advisory lock のキー空間はデータベースクラスタ全体で共有される**」は、
> **この repo に裏づける実測が無い。**
> **【受・未検証】** PostgreSQL のドキュメントを引いた形跡もコマンドを打った形跡も無い。
> ⚠ **同じ段落の隣の主張（`lock_timeout` が advisory lock の待機にも効くこと）は
> 「手元の psql で確認した」と実測を名乗っているのに、これだけ名乗りが無い。**
> ⛔ **これは「主張が誤っている」ではない。**PostgreSQL のドキュメントに載っている一般的な性質である
> 可能性が高い。⭐ **測っていない、と書くだけである。**（ADR 0219 の掃きで残ったもの）

- **文脈**:

  `packages/postgres/src/migrate.ts` の `runMigrations(pool, migrationsDir)` は、
  台帳の引き継ぎ（`handOverLegacyMigrationsTable`）→台帳テーブルの用意
  （`ensureMigrationsTable`）→未適用の `migrations/*.sql` を名前順に適用、という
  手順を一切の排他無しで行っていた。オーナーの疑いは「まっさらな DB に対して
  2つ以上の別プロセスが同時に `runMigrations()` を呼ぶと失敗するはずだ」というもの。

  **段階1（この ADR より前に実施）で実測した。** 本物の PostgreSQL 18.6 + pgvector
  0.8.6（micromamba + conda-forge で root 無しに構築）に対して、まっさらな DB を
  試行ごとに作り捨て、子プロセスを N 本 `readline` で同期させて（GO 信号送信から
  `runMigrations` 呼び出し開始までの遅延は実測 5〜8 マイクロ秒）同時に撃った。

  **結果は決定的だった。**

  | 実験                              | 試行 | 結果                                  |
  | --------------------------------- | ---- | ------------------------------------- |
  | 対照（N=1）                       | 6    | 6/6 成功                              |
  | race（自然な形、N=2）             | 12   | 12/12、ちょうど1本成功・残りは失敗    |
  | race（自然な形、N=4）             | 12   | 12/12、ちょうど1本成功・残り3本は失敗 |
  | ensureMigrationsTable 単体（N=2） | 10   | 10/10、ちょうど1本成功                |
  | ensureMigrationsTable 単体（N=4） | 10   | 10/10、ちょうど1本成功・残り3本は失敗 |

  **重要な切り分け**: 自然な形（`race`）で失敗するプロセスのエラーメッセージは
  `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
  （`name: "error"`、pg の生の `DatabaseError`）であり、`migrate.ts` の
  per-file try/catch が付けるはずの `"migration 0001_init.sql failed: ..."` という
  接頭辞が**付いていなかった**。これは `runMigrations` の中で唯一 try/catch に
  包まれていない `ensureMigrationsTable(pool)`（`CREATE TABLE IF NOT EXISTS
_mnemora_migrations`）で衝突していることを意味する。**つまり最初に噛むのは
  オーナーが疑っていた `CREATE TABLE observations`（無印）ではなかった。**

  台帳テーブルを先に直列で作ってから race させると（`race-preseeded`）、
  衝突点は `0001_init.sql` 冒頭の `CREATE EXTENSION IF NOT EXISTS vector/btree_gin/
pgcrypto` へ移った（`migration 0001_init.sql failed: duplicate key value
violates unique constraint "pg_extension_name_index"`、12/12 決定的）。
  台帳と拡張の両方を先に直列で済ませてようやく（`race-preseeded2`、12+5試行）、
  オーナーが疑っていた層——無印 `CREATE TABLE`（`observations` 等）の衝突
  （`migration 0001_init.sql failed: duplicate key value violates unique
constraint "pg_type_typname_nsp_index"`）が姿を現した。

  **つまり衝突点は1箇所ではなく3層に積み重なっている**:

  1. `ensureMigrationsTable` の `CREATE TABLE IF NOT EXISTS`
  2. `0001_init.sql` 冒頭の `CREATE EXTENSION IF NOT EXISTS` ×3
  3. 同ファイルの無印 `CREATE TABLE`（`observations` 等7テーブル）

  **`CREATE TABLE IF NOT EXISTS` 自体が並行では安全でない**（存在チェックと作成が
  アトミックでない、PostgreSQL の既知の挙動）ことを、層1を単体で取り出した実験
  （`ensureMigrationsTable` 相当だけを N 本並行実行）でも独立に確認した——
  「`IF NOT EXISTS` を付ければ直る」という結論は誤りで、それを全DDLに積み増しても
  「並行に呼んでよい」という保証にはならず、症状が別の名前へ移るだけである。

  **失敗後の DB 状態は、観測した全試行（3層×計70試行超）で常に完全に一貫していた**
  （`observations` 等8テーブルが揃い、`_mnemora_migrations` の行はちょうど1行）。
  中途半端な状態や台帳行の重複は一度も観測しなかった——各マイグレーションファイルが
  1トランザクションに包まれているため、負けたプロセスの変更はきれいに ROLLBACK
  される。**再実行での回復も全件で確認した**（失敗直後に単独プロセスでもう一度
  `runMigrations()` を呼ぶと、全件 `{ applied: [] }` で成功——「既に適用済み」と
  正しく判定される）。

  段階1の実験ハーネス（`/home/worker/mgr-e7fdf9e4/experiments/`）はリポジトリ外に
  ある。生データ（各試行の子プロセス結果・タイミング・DB状態）は
  `experiments/results/*.jsonl` に残っている。

- **検討した選択肢**:

  1. **個々の DDL に `IF NOT EXISTS` を積み増す**
     （`CREATE TABLE IF NOT EXISTS observations` 等）。
     段階1の実測が示す通り、**これは層3を層1・層2と同じ形の問題に変えるだけ**——
     `CREATE TABLE IF NOT EXISTS` 自体が並行では非アトミックなので、
     衝突が消えるのではなく「別の名前へ移る」だけで終わる。しかも3層すべてに
     手当てしても、「同じトランザクション内で2つ以上のプロセスが同時に
     `CREATE TABLE IF NOT EXISTS` を撃つと非アトミックに失敗しうる」という
     性質そのものは残るため、将来マイグレーションファイルが増えたときに
     同じ形の衝突が第4層・第5層として出現する可能性を消せない。**採らない。**

  2. **`SELECT ... FOR UPDATE` や行ロックなど、テーブルベースの排他。**
     排他したい対象（台帳テーブル）自体がまだ存在しない状態（層1）を
     排他しなければならないため、ロック対象のテーブルが要る時点で
     循環する。**採らない。**

  3. **PostgreSQL の advisory lock（`pg_advisory_lock`）で `runMigrations()` の
     入り口を包む（採用）。** テーブルの存在に依存しない、DB 全体に対する
     プロセス間の協調ロック。`handOverLegacyMigrationsTable` の前から
     最後のマイグレーションの COMMIT まで、全体を1つのロックで包める。

- **決定**:

  `runMigrations(pool, migrationsDir, options)` の本体全体を
  `pg_advisory_lock(MIGRATION_LOCK_KEY)` で包む。

  - **ロックキー**: `MIGRATION_LOCK_KEY = 7190158676462701299n`
    （固定文字列 `"mnemora:runMigrations:advisory-lock"` の SHA-256 先頭8バイトを
    符号付き64bit整数として解釈した値。`packages/postgres/src/migrate.ts` に
    再計算コマンド付きでコメントしてある）。
    **advisory lock のキー空間はデータベースクラスタ全体で共有される**——
    アプリケーションが別の用途で同じ整数をキーに使えば、検出されないまま
    無関係な処理同士が互いをブロックする。値そのものに意味は無く、
    衝突回避のためだけに固定してある。**値を変えると新旧プロセスが別々の
    キーでロックを取り、排他が効かなくなる**（ローリングデプロイ中の互換性が
    壊れる）ため、変える理由が生まれたら ADR を書くこと。
  - **専用コネクション**: advisory lock はセッション単位のため、`pool.query()`
    ではなく `pool.connect()` で借り切った1本のコネクション上で
    `pg_advisory_lock` / `pg_advisory_unlock` を対にして呼ぶ。
  - **待ち方とタイムアウト**: ロック取得前に `set_config('lock_timeout', ...,
false)`（セッションスコープ）を設定してから `pg_advisory_lock` を呼ぶ。
    `lock_timeout` は PostgreSQL の advisory lock 待機にも効くことを実測で
    確認済み（`SET lock_timeout='500ms'` の別セッションが約500msで
    `ERROR: canceling statement due to lock timeout`（SQLSTATE `55P03`）に
    なることを手元の psql で確認した）。既定値は
    `DEFAULT_LOCK_TIMEOUT_MS = 30_000`（30秒）。呼び出し側は
    `options.lockTimeoutMs` で上書きできる（テストは短くする）。
    コネクションを pool へ返す前に必ず `lock_timeout` を `'0'`（無効）へ戻す
    ——プールされたコネクションが後で無関係な用途に再利用されたときに、
    セッション設定が漏れ残らないようにするため。
  - **3状態の区別**（オーナーが引いた線1）:
    - 待って取れた → 通常どおり完了。戻り値 `{ applied, lock: { waitedMs } }`
      の `waitedMs` に実際に待った時間（ミリ秒）が乗る。
    - 待ったが時間切れ → `MigrationLockTimeoutError` を投げる
      （SQLSTATE `55P03` を判別）。黙って続行しない。
    - ロック取得の操作自体が失敗（権限不足・接続不可等） →
      `MigrationLockUnavailableError` を投げる。`55P03` 以外のエラーは
      すべてこちらに分類する——「混んでいるだけ」との誤診を防ぐため。
  - **呼び出し側の互換性**（オーナーが引いた線2）: `runMigrations(pool)` は
    今まで通りの呼び方のまま安全になる。新しい第3引数 `options` は省略可能で、
    省略時は上記の既定値（30秒タイムアウト・固定キー）で動く。戻り値に
    `lock` フィールドを追加したが、既存の `applied` は残したままなので
    後方互換（`packages/postgres/src/__tests__/migrate-ledger-handover.test.ts`
    の既存の `toEqual({ applied: [...] })` は `lock: { waitedMs:
expect.any(Number) }` を足すだけで通った——型の破壊的変更は無い）。

- **理由**:

  段階1の実測が示した通り、衝突点は1箇所ではなく3層に散らばっており、
  かつ「テーブルが無い」状態（層1）そのものを排他しなければならない。
  advisory lock はテーブルの存在に依存しないため、この制約に合う。
  個々の DDL への `IF NOT EXISTS` の積み増しは、実測で「別の層に症状が
  移るだけ」と分かっているため採らない。

- **`0001_init.sql` の `CREATE TABLE observations` に `IF NOT EXISTS` を
  付けるかどうか**:

  **付けない。** 段階1の実測が示した通り、advisory lock で入り口を塞げば
  `runMigrations()` を経由する限り3層とも到達しない。`IF NOT EXISTS` を
  ここだけに付けても、層1・層2が先に落ちるため排他の代替にはならず、
  逆に「一部のテーブルだけ `IF NOT EXISTS` が付いている」という非対称な
  スキーマ定義を持ち込むだけになる。**排他の代替として `IF NOT EXISTS` を
  採らない、という判断であり、`IF NOT EXISTS` を付けること自体を将来にわたって
  禁じるものではない。**

- **歯（この決定を測る歯）**:

  `packages/postgres/src/__tests__/migrate-concurrency.test.ts` を新設した。
  4本:

  1. まっさらな DB へ4本相当（別々の `Pool`）を同時に `runMigrations` →
     全員成功し、実際に適用したのはちょうど1本。DB は8テーブル・台帳1行の
     完全な状態に落ち着く。
  2. 別セッションが advisory lock を握り、1.5秒後に手放す →
     `runMigrations` は待ってから成功し、`lock.waitedMs` に待った時間が乗る。
  3. 別セッションが advisory lock を握ったまま手放さない →
     300ms のタイムアウトで `MigrationLockTimeoutError` を投げる
     （黙って続行して成功しない）。時間切れ後、DB には何も作られていないことも
     確認する。
  4. `pg_advisory_lock(bigint)` の EXECUTE 権限を PUBLIC から剥奪した
     データベースで、非 superuser の制限ロールから呼ぶ →
     `MigrationLockUnavailableError` を投げる（歯3の時間切れとは別のエラー）。
     本物の PostgreSQL 上で、`CREATE ROLE` + `REVOKE EXECUTE ON FUNCTION
pg_advisory_lock(bigint) FROM PUBLIC` で作った（superuser は権限検査を
     迂回するため、テスト全体の管理接続とは別の非 superuser ロールを都度作る）。
     擬似物は使っていない。

  **変異試験**: 実装後、`runMigrations` からロックの取得・解放を外す変異
  （`acquireMigrationLock` / `releaseMigrationLock` の呼び出しを削り、
  `waitedMs` を固定で `0` にするだけ）を当てたところ、**4本とも赤くなった**:

  ```diff
  --- (排他あり・修正後)
  +++ (排他を外した変異)
  @@ -239,9 +239,12 @@
   ): Promise<RunMigrationsResult> {
     const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
     const lockKey = options.lockKey ?? MIGRATION_LOCK_KEY;
  +  void lockTimeoutMs;
  +  void lockKey;

  -  const { client: lockClient, waitedMs } = await acquireMigrationLock(pool, lockKey, lockTimeoutMs);
  -  try {
  +  // MUTATION: 排他を外す。
  +  const waitedMs = 0;
  +  {
       await handOverLegacyMigrationsTable(pool);
       await ensureMigrationsTable(pool);
  @@ -269,7 +272,5 @@
         }
       }
       return { applied, lock: { waitedMs } };
  -  } finally {
  -    await releaseMigrationLock(lockClient, lockKey);
     }
   }
  ```

  変異を当てた状態での出力（4本とも失敗、SKIP は無い）:

  ```
  ❯ src/__tests__/migrate-concurrency.test.ts (4 tests | 4 failed)
    × まっさらな DB へ4プロセス相当が同時に migrate しても、成功しかつ適用は1本だけ
      error: duplicate key value violates unique constraint "pg_type_typname_nsp_index"
        at ensureMigrationsTable src/migrate.ts:189:3
    × 先客が手放すまで待ってから migrate が進み、待った時間が戻り値に出る
      AssertionError: expected 49 to be greater than or equal to 750
    × 先客が手放さないと、短いタイムアウトで MigrationLockTimeoutError を投げる（黙って続行しない）
      AssertionError: promise resolved "{ applied: [ '0001_init.sql' ], …(1) }" instead of rejecting
    × advisory lock を取る権限が無いロールで呼ぶと、MigrationLockUnavailableError を投げる（時間切れと区別できる）
      AssertionError: expected error: permission denied for schema public { …(15) } to be an instance of MigrationLockUnavailableError

   Test Files  1 failed (1)
        Tests  4 failed (4)
  ```

  歯1が変異で赤くなったエラー（`pg_type_typname_nsp_index`）は、段階1の実測で
  自然な形の race が決定的に踏んでいたのと**同じ衝突点**（層1）である——歯が
  実際に段階1で実測した壊れ方を再現して検知していることの裏付けになっている。

  変異を戻すと4本とも緑に戻ることを確認した（この PR に含まれるコードは
  排他ありの状態であり、変異は一時的に当てただけで残していない）。

- **CI で歯4が落ちた経緯（認証方式への依存を見落としていた）**:

  最初に push した版では、歯4の制限ロール `mnemora_lock_denied_role` を
  **パスワード無しで** `CREATE ROLE` していた。手元の PostgreSQL は
  `initdb -A trust` で構築しており、`trust` 認証はパスワードを一切検査しない
  ため、この抜けは手元では顕在化しなかった。CI の service container は
  `POSTGRES_PASSWORD` 付き（scram 認証）で、`CREATE ROLE ... LOGIN`
  （パスワード無し）で作ったロールへパスワード無しで繋ごうとすると、
  接続そのものが `FATAL: password authentication failed for user
"mnemora_lock_denied_role"` で落ちる。

  さらに、接続文字列を組む `connectionStringFor(database, user)` が
  `url.username` だけを差し替えて `url.password` を管理ロール（`postgres`）の
  ものへ残していたため、**制限ロールへ管理ロールのパスワードを流用してしまう**
  という2つ目の欠陥もあった。

  結果として **歯4は「ロック機構が使えなかった」ではなく「そもそも繋がらな
  かった」を測っていた**——`MigrationLockUnavailableError` ではなく生の
  `password authentication failed` を受け取り、CI で
  `packages/postgres` ジョブと `root-gate-db-stage` ジョブの両方がこの
  1本だけで赤くなった（他93本は緑のまま）。

  **直した内容**: `mnemora_lock_denied_role` を固定パスワード付きで
  `CREATE ROLE ... LOGIN PASSWORD '...'`（既存なら `ALTER ROLE ...
PASSWORD '...'`）で作り、`connectionStringFor` は `user` と `password` を
  常に対で受け取るように変更した（`credentials?: { user, password }`）。
  `trust` 認証の手元ではパスワードは単に無視されるため、両方の環境で
  同じ経路を通る。

  **修正の検証**: 手元の PostgreSQL の `pg_hba.conf` の `host` 行を一時的に
  `trust` から `scram-sha-256` へ変更し、`pg_superuser` にもパスワードを設定して
  `pg_reload_conf()` した上で、**修正前のコード（このブランチの直前のコミット）
  に戻して歯4を走らせたところ、実際に CI と同じ
  `password authentication failed for user "mnemora_lock_denied_role"` で
  赤くなることを手元でも再現した。** 修正後のコードに戻すと緑に戻ることも
  確認した。検証後、`pg_hba.conf` は `trust` へ戻してある。

  **修正後、歯4にもう一度ロック除去の変異を当て直した**（接続経路を変えたため、
  歯4がまだ噛んでいる保証が要る）。scram-sha-256 環境下で変異を当てたところ、
  4本とも再び赤くなった。歯4はパスワードが正しく通るようになった分、
  `MigrationLockUnavailableError` の代わりに `permission denied for schema
public`（advisory lock を経ずに `CREATE TABLE` へ進んでしまい、その段で
  ロール自身の権限不足に当たった）で失敗した——`trust` 環境で当てた変異と
  同じ形（権限剥奪では止まらず、別のエラーで失敗する）であり、歯4が
  変異を引き続き検知できることを確認した。

- **結果（この決定が招くもの）**:

  - `runMigrations()` は、他プロセスが同時にマイグレーションしていない通常時でも
    advisory lock の取得・解放のために追加で2往復（`pg_advisory_lock` /
    `pg_advisory_unlock`）の通信を要する。実測した所要時間の増分は PR 本文を参照。
  - `runMigrations()` の戻り値の型が `{ applied: string[] }` から
    `{ applied: string[], lock: { waitedMs: number } }` に変わった
    （フィールド追加のみ、既存フィールドは変えていない）。
  - `examples/chat/src/runtime-factory.ts` のコメントを実態に合わせて修正した
    （旧コメントは「`runMigrations`/`registerEmbeddingSpace` はどちらも
    `IF NOT EXISTS` 系なので安全」と書いていたが、段階1の実測が示す通り
    `runMigrations` 側の実態は異なっていた。事実に反する記述だったため直した）。

- **これが覆るとしたら**:

  - advisory lock のキー空間をアプリケーションの別の場所で使い始めたとき
    （同じキー値が衝突すると、無関係な処理同士が検出されないままブロックし合う）。
    そのときはキーの一元管理（レジストリ）を導入する必要がある。
  - マイグレーションの実行主体が単一の DB クラスタを跨ぐようになったとき
    （advisory lock はクラスタ内でしか効かない。マルチクラスタでの排他は
    別の仕組みが要る）。
  - `runMigrations()` の外側でも `_mnemora_migrations` や `migrations/*.sql` の
    ファイルへ直接触る経路が増えたとき（advisory lock は `runMigrations()` を
    経由する呼び出し同士でしか効かない）。

- **確かめていないこと（段階1・段階2を通じて）**:

  - **手元の門は、既定では CI と同じ認証方式を測っていない。** 手元の
    PostgreSQL は root 無しで構築する都合上 `initdb -A trust` で立てており、
    パスワードを一切検査しない。歯4は「権限が無いロールで接続する」ことを
    検査しているが、認証そのもの（パスワードが正しいか）は `trust` の下では
    常に無条件で通ってしまう。実際、この非対称のために歯4のパスワード関連の
    欠陥（前述の CI 落ちの経緯）は**手元の門を何度全部通しても検出できず、
    CI（scram 認証）で初めて顕在化した。** 今回は `pg_hba.conf` を一時的に
    `scram-sha-256` へ切り替えて個別に検証したが、これは通常の門の実行経路には
    含まれていない一回限りの手動確認であり、**この非対称自体は解消していない**
    ——今後も手元の門は「認証方式に依存する壊れ方」を素通りしうる。
  - **マイグレーションファイルが2本以上に増え、衝突点がファイル内の途中へ
    移ったときに部分適用が残るかは実測していない、外挿である。** 現在の
    `packages/postgres/migrations/` は `0001_init.sql` 1本のみで、1ファイル
    全体が1トランザクションに包まれているため、今回観測した衝突（層1〜3）は
    いずれもファイルの冒頭〜前半で起き、ROLLBACK が全体をきれいに戻すところまで
    しか実測できていない。将来2本目のマイグレーションが増え、片方のプロセスが
    1本目を適用完了した直後、もう片方が同じ1本目の適用中に衝突する、といった
    ファイル境界をまたぐ競合のパターンは実測していない。ただし advisory lock は
    ファイルの内容に依存せず `runMigrations()` の入り口全体を排他するため、
    **この対策自体はファイル数に依存せず有効なはず**——「はず」であり、
    実測してはいない。
  - ~~**`registerEmbeddingSpace`（`packages/postgres/src/vector-space.ts`）は
    この ADR の排他の対象外のまま残した。** `CREATE TABLE IF NOT EXISTS` と
    `CREATE INDEX IF NOT EXISTS` を使っており、段階1で実証した「`CREATE TABLE
IF NOT EXISTS` は並行では非アトミック」という性質がそのまま当てはまる
    可能性が高い（**実測はしていない**）。`examples/chat/src/runtime-factory.ts`
    は `runMigrations()` の直後にこれを呼んでおり、複数レプリカが同時に
    起動する経路では、この呼び出しが次の衝突点として残っている。
    優先順位（段階2の本体である advisory lock の実装・歯・変異試験 > この
    ADR・門を通すこと > `registerEmbeddingSpace` の同種対応）に従い、
    時間の制約でこの PR には含めなかった。**~~
    **【解決済み・ADR 0018 参照】** `registerEmbeddingSpace` についても段階1の
    実測を別途行い（まっさらな DB へ N=2/4 で同時呼び出し）、`CREATE TABLE
IF NOT EXISTS` 側（`pg_type_typname_nsp_index`）・`CREATE INDEX IF NOT
EXISTS` 側（`pg_class_relname_nsp_index`）の**両方**が決定的に衝突することを
    確認した。この ADR と同じ advisory lock の機構（`./advisory-lock.ts` へ
    共有部品として切り出したもの）で `registerEmbeddingSpace` の呼び出し全体を
    包み、塞いだ。詳細・実測値・変異試験は
    [ADR 0018](./0018-register-embedding-space-advisory-lock.md) を参照。
    上の取り消し線の部分は、当時（この ADR 採用時点）に「残った課題」として
    書いた記録そのものであり、書き換えずに残してある。
  - **advisory lock を取得する専用コネクションが、pool の他の接続と比べて
    極端に不健全な状態（TCP レベルで応答不能など）に陥ったときの挙動**は
    実測していない（`pg_advisory_unlock` が呼べないまま `client.release()`
    されるケース。pg-pool は release 時にコネクションの健全性を検査しないため、
    理論上は不健全なコネクションが再利用され続ける可能性があるが、これは
    advisory lock 固有の問題ではなく `pool.connect()` 全般に共通する話であり、
    この ADR の範囲では検証していない）。
