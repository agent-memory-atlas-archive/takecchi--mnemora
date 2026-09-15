# ADR 0130: 手元の Postgres 認証方式を CI（scram）に揃える —— `docker-compose.yml` と、揃っていることを測る歯

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #232](https://github.com/takecchi/mnemora/issues/232) が、
  [ADR 0017](./0017-runmigrations-advisory-lock.md) 自身が「確かめていないこと」節で
  名指しした残債を指している:

  > 手元の門は、既定では CI と同じ認証方式を測っていない。手元の PostgreSQL は
  > root 無しで構築する都合上 `initdb -A trust` で立てており、パスワードを一切
  > 検査しない。……今後も手元の門は「認証方式に依存する壊れ方」を素通りしうる。

  ADR 0017 は実際にこの非対称を1度踏んでいる: 手元では `trust` 認証のため
  パスワード無しで `CREATE ROLE ... LOGIN` した制限ロールへの接続が通ってしまい、
  歯4（`MigrationLockUnavailableError` を検査する歯）は「ロック機構が使えなかった」
  ではなく「そもそも繋がらなかった」を測っていたことに気づけないまま CI
  （`POSTGRES_PASSWORD` 付き = scram-sha-256 認証）で初めて赤くなった。

  **着手前に、issue 本文の伝聞ではなく現物を確認した**（AGENTS.md/自律作業の
  手引きの指示どおり）:

  - `docker-compose*.yml` はこの repo のどこにも存在しない
    （`find . -iname "docker-compose*"` で0件）。
  - `scripts/` にも、手元用に Postgres を起動する手順・スクリプトは無い。
  - `.github/workflows/ci.yml` の service container は、`postgres`
    ジョブ（`server_encoding` の matrix、[ADR 0105](./0105-postgres-regime-matrix.md)/
    [ADR 0106](./0106-ci-declares-the-regime-it-measures.md)）を除く7ジョブ
    （`example-chat` / `root-gate-db-stage` / `retrieval-quality` /
    `identifier-probes` / `consolidation-cost` / `archive-sweep-cost` /
    `time-term`）すべてで、`image: pgvector/pgvector:pg17` /
    `POSTGRES_USER: postgres` / `POSTGRES_PASSWORD: postgres` /
    `POSTGRES_DB: mnemora_ci` / `POSTGRES_INITDB_ARGS: "--encoding=UTF8"`
    という同一の値を、ジョブごとに複製して書いている（YAML アンカーや
    composite action には切り出していない——この repo の既存の書き方）。
  - `packages/postgres/README.md` / 各 ADR に、認証方式の非対称を閉じた記述は
    見つからなかった（0093/0096/0066 は拡張の "trusted" flag の話で別件）。

  ⟹ **issue 本文が受け取った報告（「ローカル向けに scram を既定にする設定・
  スクリプトは `scripts/` に見当たらず」）は、現物確認の結果と一致した。**

- **検討した選択肢**:

  1. **CI に scram の脚をもう1本立てる（issue の案1、`postgres` job の
     matrix を広げる）。** ⛔ **採らない。** 現物確認の結果、**CI は既に
     全7非-matrix ジョブで `POSTGRES_PASSWORD` を設定しており、これは
     公式 postgres イメージ（`pgvector/pgvector:pg17` の土台）の host 認証を
     既定で `scram-sha-256` にする——ADR 0017 が実際にその認証で落ちたことで
     この事実を確認済みである。**⟹ CI に「scram の脚」を新設する提案は
     前提が成り立たない（もう在る）。`postgres` job の matrix は
     `server_encoding` の regime を測るためのものであり
     （[ADR 0105](./0105-postgres-regime-matrix.md)）、認証方式とは無関係な
     関心事を巻き込むだけになる。しかも [Issue #224](https://github.com/takecchi/mnemora/issues/224)
     ([ADR 0127](./0127-pgvector-job-count-tooth-drops-absolute-total.md)) が
     「pgvector ジョブの本数を固定値で持つ歯」を可変にした直後であり、
     ここへさらに matrix を広げると同じ罠（本数を歯にする誘惑）を招く。
     何より——**この案は CI 側だけを厚くする。手元と CI の非対称という
     issue の核心には触れない。**

  2. **手元の門の側を scram 既定にする（issue の案2、採用）。**
     ⚠ issue 本文は「開発者の手元の環境に手を入れることになる。採るなら、
     既存の手順との整合を示すこと」と留保していたが、**現物確認の結果、
     「既存の手順」はそもそも存在しなかった**（上の文脈節）。⟹ 整合を
     示すべき対象が無く、新設するだけで足りる。`docker-compose.yml` を
     repo ルートに新設し、CI の7ジョブが使っている値と**意図的に一致させた**。

  3. **認証方式を「宣言して測る」形にする（issue の案3、
     [ADR 0106](./0106-ci-declares-the-regime-it-measures.md) の規律の横展開）。**
     ⚠ **単独では採らない。** ADR 0106 の規律（測る前に宣言しない）は
     価値があるが、**ADR 0017 が実際に踏んだ壊れ方は「宣言」では検知できず
     「実際に scram で繋いでみる」ことでしか検知できなかった**——歯4の欠陥は
     パスワードの有無というコードパスの問題であり、CI が「scram で測っている」
     と宣言するだけでは、手元でその同じコードパスを踏めない限り再発を防げない。
     ⟹ **案3の「宣言と実測の食い違いを歯にする」という発想だけを、案2の実装に
     持ち込んだ**（下の「歯」節）——`docker-compose.yml` と `ci.yml` の値が
     一致しているかどうかを機械的に検査する歯を足し、これは実質的に
     「手元と CI、両方が同じ認証方式を宣言しているか」を測る、ADR 0106 と
     同じ形の規律である。

- **決定**:

  - **`docker-compose.yml` を repo ルートに新設した。** `postgres` サービス
    1本のみを持ち、`image` / `POSTGRES_USER` / `POSTGRES_PASSWORD` /
    `POSTGRES_DB` / `POSTGRES_INITDB_ARGS` を、CI の非-matrix 7ジョブと
    同じ値にした。使うかどうかは開発者の任意——`docker compose up -d` してから
    `DATABASE_URL` を渡して `pnpm --filter @mnemora/postgres run migrate` /
    `pnpm run test` を実行する（ファイル冒頭のコメントに使い方を書いた）。
    **既定の `pnpm run test`（`DATABASE_URL` 無し）の挙動は1バイトも変えていない**
    ——[ADR 0015](./0015-root-test-gate-reports-skipped-db-tests.md) の
    「DB テストは実行していません」という緑の意味はそのまま残る。
  - **`scripts/postgres-auth-parity-lib.mjs`（純関数）+
    `scripts/__tests__/postgres-auth-parity.test.mjs`（歯）を新設した。**
    `ci.yml` の7ジョブそれぞれの `services.postgres` と `docker-compose.yml`
    の `services.postgres` を、依存を足さず（YAML パーサ無し。既存の
    `initdb-args-lib.mjs` 等と同じ、正規表現とインデント幅による切り出し）
    比較する。検査するのは次の3種:
    1. **`docker-compose.yml` ↔ CI の各ジョブ**: `image` /
       `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` /
       `POSTGRES_INITDB_ARGS` の食い違い（`mismatches`）。
    2. **CI の7ジョブ同士**: 1本を基準に、残り6本が同じ値を宣言しているか
       （`crossJobMismatches`）——`docker-compose.yml` が正しくても、
       CI 側のどれか1本だけがこっそり値を変えたら、それも非対称の再発である。
    3. **対象ジョブの実在**: 7ジョブのどれかが消えた・名前が変わったら
       `missingJobs` で名指しする。
  - **`postgres`（`server_encoding` matrix）ジョブは比較対象から除外した。**
    `POSTGRES_INITDB_ARGS` が `${{ matrix.initdbArgs }}` という式であり、
    脚によって値が変わるため、他ジョブと単純比較すると認証方式とは無関係な
    理由（encoding regime の違い）で誤って赤くなる。この歯の関心は
    「認証方式」であって「encoding regime」ではない
    （[ADR 0105](./0105-postgres-regime-matrix.md)/
    [ADR 0106](./0106-ci-declares-the-regime-it-measures.md) の関心と重ねない）。

- **理由**:

  この非対称を閉じる方法のうち、**実際に ADR 0017 が踏んだ壊れ方
  （パスワードが検査されない `trust` の下で書かれた、パスワードに依存する
  コード）を手元でも再現できる**のは、手元で実際に `POSTGRES_PASSWORD` 付きの
  Postgres を動かせるようにする案2だけである。案1は前提（CI がまだ scram
  でないという誤認）が崩れており、案3は「宣言」だけでは実際のコードパスを
  踏めない。**歯（案3の発想を流用した parity テスト）は、案2で新設した
  `docker-compose.yml` が CI から乖離しないことを担保するために足した**——
  「非対称を閉じる新しい経路を作った」だけでは、その経路自体が CI の変更に
  追随せず腐ることを防げないため。

- **歯（この決定を測る歯）**:

  `scripts/__tests__/postgres-auth-parity.test.mjs`。15本。

  - 実物の `docker-compose.yml` / `.github/workflows/ci.yml` に対して、
    上の3種（`mismatches` / `crossJobMismatches` / `missingJobs`）が
    すべて空であることを固定する4本。
  - `POSTGRES_PASSWORD` が空文字列やキー欠落になっていないこと
    （設定されていなければ scram ではなく `trust` に落ちる、という
    この ADR の前提そのもの）を直接検査する1本。
  - `postgres-auth-parity-lib.mjs` の純関数を合成入力で検査する10本
    （`extractJob` / `extractCiPostgresService` / `extractComposePostgresService` /
    `findPostgresAuthAsymmetry` の正常系・異常系・引用符の剥がし・
    env ブロック中のコメント行を読み飛ばす経路 [後述] を含む）。

  **変異試験（実ファイルに対して、退避コピーから戻す形で実施——
  `docs/autonomy.md` §4 が名指しした「`git checkout` で戻すと未コミットの
  編集も消える」の穴を踏まないため、`cp` で取った退避コピーから戻した）**:

  1. **`docker-compose.yml` の `POSTGRES_PASSWORD` を `postgres` から
     `changeme` へ変える**（手元だけが変わった体）→
     「docker-compose.yml と ci.yml の値が全ジョブで一致する」の歯が、
     7ジョブすべてについて `POSTGRES_PASSWORD` の食い違い
     （`ciValue: "postgres"`, `composeValue: "changeme"`）を挙げて**赤くなった**。
     `cp` で退避コピーから戻すと、15本とも**緑に戻った**。
  2. **`ci.yml` の `retrieval-quality` ジョブだけ `POSTGRES_PASSWORD` を
     `postgres-mutated` へ変える**（CI 側の1ジョブだけがこっそり変わった体）→
     「docker-compose.yml と ci.yml の値が全ジョブで一致する」（compose との
     食い違い）と「ci.yml の非 matrix な7ジョブが、互いに同じ値を宣言している」
     （CI 内の相互不一致、`retrieval-quality` を名指し・基準は
     `root-gate-db-stage`）の**両方**が**赤くなった**。`cp` で退避コピーから
     戻すと、15本とも**緑に戻った**。

  **開発の途中で見つけた実物の欠陥（歯が実際に踏んだ壊れ方）**: 初版の
  `extractCiPostgresService` は env ブロック内で最初にキーの形へマッチしない
  行（実物の `ci.yml` ではコメント行）に当たった時点で走査を打ち切っていた
  ため、実物の7ジョブすべてで `POSTGRES_INITDB_ARGS`（各ジョブで直前に
  説明コメントを挟んでいる）を取りこぼし、`mismatches` に7件の偽陽性
  （`ciValue: undefined`）を出した。**この repo の実物データで検算して
  初めて見つかった**——合成入力のテストだけでは気づけなかった欠陥であり、
  コメント行・空行を読み飛ばす分岐を足して直した（上の「歯」節・合成入力の
  回帰テストとして固定済み）。

- **結果（この決定が招くもの）**:

  - repo ルートに `docker-compose.yml` が増えた。`pack:check`
    （`scripts/check-publish-pack.mjs`）は `packages/*` の配布物だけを見るため、
    このファイルは対象外——実際に `pnpm run pack:check` を緑のまま通した。
  - `README.md` に、手元で `docker compose up -d` してから CI と同じ認証方式で
    テストする手順を1節足した。
  - `pnpm run test`（`DATABASE_URL` 無し）の既定挙動・出力は変えていない。

- **引き受けた負債**:

  この決定で明示的に引き受けたものを、ここに括る（詳細はそれぞれ下記の節が持っており、
  ここでは重複させず、どこに詳細が在るかだけを指す）。

  1. **正規表現ベースの YAML 抽出は壊れやすい。** `extractJob` / `extractCiPostgresService` /
     `extractComposePostgresService` は YAML パーサを持たず、`ci-yml-*-wiring` 系と同じ
     テキストベースの切り出しである。開発中に実際に「env ブロック中のコメント行で
     走査を打ち切り、7ジョブ全てで `POSTGRES_INITDB_ARGS` を取りこぼす」という偽陽性を
     踏んでおり（上の「歯」節）、`services.postgres` が composite action /
     reusable workflow へ切り出された場合は追随できない（下の「これが覆るとしたら」
     1点目）。
  2. **`postgres`（`server_encoding` matrix）ジョブは比較対象から外れている。**
     この歯は、そのジョブの認証設定（`image` / `POSTGRES_USER` / `POSTGRES_PASSWORD` /
     `POSTGRES_DB`）が他7ジョブと食い違っても気づかない（下の「確かめていないこと」
     3点目）。
  3. **Docker を実際に起動しての検証をしていない。** `docker compose up` して
     「手元でも本当に scram-sha-256 認証が要求されるか」を実測しておらず、
     状況証拠（ADR 0017 の実測記録・postgres イメージの既定仕様）からの推測に
     留まる（下の「確かめていないこと」1点目）。

- **これが覆るとしたら**:

  - CI が `.github/workflows/ci.yml` の重複した `services.postgres` ブロックを
    composite action や reusable workflow へ切り出したとき——このテキストベースの
    抽出（`extractJob` / `extractCiPostgresService`）は `jobs:` 直下の
    フラットな `key: value` 形を前提にしており、切り出し後の間接参照までは
    追わない。そのときは、参照先の composite action / reusable workflow の
    ファイルも読む形にこの歯を拡張する必要がある（上の「引き受けた負債」1点目）。
  - `postgres` イメージ側（docker-library の postgres イメージ）が
    `POSTGRES_PASSWORD` 設定時の既定 host 認証方式を `scram-sha-256` から
    変えたとき——この ADR も ADR 0017 も、その既定を repo の外側の事実として
    前提にしている（下の「確かめていないこと」参照）。
  - この repo が「手元でも既定で DB テストを走らせる」方向（ADR 0015 の
    見直し）へ進んだとき——そのときは `docker-compose.yml` を任意の経路のまま
    残すか、`pnpm run test` 自体に組み込むかを再検討する必要がある。

- **確かめていないこと**:

  - **この作業環境に Docker が無く（`which docker` が空)、`docker compose up`
    を実際に実行して「手元でも本当に scram-sha-256 で認証が要求されるか」を
    実測していない。** 根拠は (1) ADR 0017 が CI の同一設定（`POSTGRES_PASSWORD`
    付きの `pgvector/pgvector:pg17`）で実際に `password authentication failed`
    を踏んだ実測記録、(2) docker-library の postgres イメージが
    `POSTGRES_PASSWORD` 設定時に host 認証を `scram-sha-256` にする既定仕様、の
    2つの状況証拠であり、**この PR の作業者自身が `docker-compose.yml` を
    upして繋いで確認した一次情報ではない。**（上の「引き受けた負債」3点目）
  - **`docker-compose.yml` を使わずに独自の方法（conda-forge の Postgres 等）で
    手元 Postgres を用意している開発者**には、この決定は何も強制しない——
    使うかどうかは任意なので、その開発者の手元は今までどおり `trust` の
    ままでも動く。この ADR は「経路を作った」のであって「全開発者の手元を
    scram に強制した」のではない。
  - **CI 側で `postgres`（`server_encoding` matrix）ジョブは、この parity 歯の
    比較対象に含めていない。** `image` / `POSTGRES_USER` / `POSTGRES_PASSWORD` /
    `POSTGRES_DB` は目視では他7ジョブと同じに見えるが、この歯はそれを
    機械的には検査していない——このジョブだけがこっそり変わっても、この歯は
    気づかない（上の「引き受けた負債」2点目）。
  - **CI そのもの（本 PR の CI 実行）でこの歯が緑になることは、この ADR を
    書いた時点ではまだ確認できていない。** 手元の `vitest run` では緑だが、
    「編集した」ことと「CI で効いた」ことは別であり、PR の CI 実行で確認する
    （`docs/autonomy.md` の要求どおり）。
