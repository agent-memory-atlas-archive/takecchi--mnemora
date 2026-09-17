# ADR 0032: `OutboxStore.claimBatch` に claim のリースを足し、「見えない停止」と「先頭詰まり」を塞ぐ

- **状態**: 採用 (2026-09)

> **⚠ 2026-09-17 追記（名乗りの復元。本文は書き換えていない）。**
> 本文の「**`FOR UPDATE SKIP LOCKED` の行ロックは、この SQL 文がコミットした瞬間に解放される。**」は、
> **この repo に裏づける実測が無い。**
> **【受・未検証】** 直後に `EXPLAIN` の実測ブロックが在るが、それは2点目（部分索引の述語がプランナから
> 使えないこと）についての索引選択の検証であって、1点目（ロック解放タイミングそのもの）の実測ではない。
> conformance の歯が「再現した」のも、**ロックが解放される瞬間ではなく、その帰結として同じ行が
> 再 claim される、という観測可能な振る舞いである。**
> 🔴 **この後の「先頭詰まり」「見えない停止」の推論は、全部この前提（コミット時に解放される）に乗っている。**
> ⛔ **これは「主張が誤っている」ではない。**PostgreSQL の行ロックの一般的な性質として広く知られている。
> ⭐ **測っていない、と書くだけである。**（ADR 0219 の掃きで残ったもの）

- **文脈**:

  マネージャーが現物で確認した事実として渡された、`PostgresOutboxStore.claimBatch`
  （`packages/postgres/src/outbox-store.ts`）の次の1点を直す。

  `claimBatch` の `WHERE` は

  ```sql
  WHERE tenant_id = ... AND completed_at IS NULL AND failed_at IS NULL AND available_at <= ${opts.now}
  ```

  であり、**`claimed_at` の条件が無い**。一方 `migrations/0001_init.sql` の部分索引
  `idx_outbox_pending` は

  ```sql
  CREATE INDEX idx_outbox_pending ON outbox (tenant_id, kind, available_at)
    WHERE completed_at IS NULL AND claimed_at IS NULL;
  ```

  で張られ、直前のコメントは「ワーカーの claim クエリ: *未着手*・未完了のジョブを
  `available_at` 昇順で取得」と書いている。**索引は「未着手」を前提に張られ、クエリは
  その条件を落とした。**

  帰結は2つある。

  1. **`FOR UPDATE SKIP LOCKED` の行ロックは、この SQL 文がコミットした瞬間に解放される。**
     `claim` は `claimed_at`/`claimed_by`/`attempts` を書くだけで `available_at` を
     進めないため、claim 済み・未完了（＝処理中）の行は `available_at <= now` に
     合致し続ける。**クラッシュを要求しない、通常運用のレースとして、次の `tick()` の
     `claimBatch` が同じ行を再び claim する。**
  2. **部分索引の述語がクエリの `WHERE` から論理的に含意されないため、`idx_outbox_pending`
     はプランナから使えない。** `outbox` にはこれ以外の索引が無い。

  1点目に加えて、`ORDER BY available_at ASC LIMIT n` と組み合わさると、claim 済みで
  完了しない行が n 件あれば**先頭を占め続け、n+1件目以降に永久に到達できない**
  という懸念（先頭詰まり）がオーナーから提示された。これは推論であり、実測していない
  ——本 PR の歯（`packages/testkit/src/outbox-store-conformance.ts`）で実際に再現するかを
  確かめた（「歯について」参照。**再現した**）。

  2点目も「読んでそう推論した」段階だった。`packages/postgres/src/__tests__/
  outbox-claim-lease-index.test.ts` で `EXPLAIN` により実測した（同上）。

- **決定**:

  1. **`claimed_at IS NULL` を単独で足すのではなく、リースにする。**
     `claimBatch` は「一度も claim されていない」か「`claimed_at` が `leaseMs` 以上前」
     の行を claim する:

     ```sql
     AND (claimed_at IS NULL OR claimed_at <= ${opts.now - opts.leaseMs})
     ```

     境界は `available_at <= opts.now` と同じ `<=`（両端含む）に揃える。

  2. **`ClaimOutboxJobsOptions`（`packages/core/src/interfaces/outbox-store.ts`）に
     `leaseMs: number` を追加する。必須・既定値なし。** 既存フィールド（`now`/`limit`/
     `kinds`/`claimedBy`）と揃えた命名にした。

  3. **`runtime.tick` の `TickOptions`（`packages/core/src/runtime.ts`）にも
     `leaseMs: number` を必須で足す。** `Runtime.tick` のシグネチャを
     `tick(ctx: Ctx, opts?: TickOptions)` から `tick(ctx: Ctx, opts: TickOptions)` へ変える
     ——**`tick(ctx)` を引数無しで呼べなくなる、意図した破壊的変更。** リース長は
     「ワーカーが止まったとみなすまでの時間」という運用方針であり、`packages/core` が
     決めてよい値ではなく呼び出し側が決める。

  4. **呼び出し側**（`examples/chat/src/embed-drain.ts`、唯一の非テスト呼び出し側）:
     `leaseMs = 30分`（`1_800_000`ms）。根拠——`packages/openai` の `EmbeddingProvider`/
     `LLMProvider` はどちらも `new OpenAI({ apiKey })` をオプション無しで作っており、
     インストール済みの `openai` SDK（このリポジトリの `node_modules/openai`、v7.10.0で
     確認）の既定値がそのまま効く: 既定の `timeout` は1リクエストあたり10分、既定の
     `maxRetries` は2（`node_modules/.pnpm/openai@7.10.0.../openai/client.d.ts` の doc
     コメントに明記）。つまり1回の embed/extract ジョブは、SDK が自動リトライする分も
     含めると最大 (1 + 2) × 10分 = 30分は「正常に処理中」でありうる。リースがこれより
     短いと、まだ生きているワーカーのジョブを「止まった」と誤判定して奪ってしまう。
     **この harness は単一プロセス・単一ワーカーのバッチ処理で、`tick()` は claim した分を
     同じ呼び出しの中で必ず complete/fail させてから返る**ため、通常運転ではリース満了は
     発生しない——満了が意味を持つのは、このプロセス自体がクラッシュして再実行された
     ときの回収だけである。「それっぽい数字」を発明しないため、実際にこのコードベースが
     依存している SDK の実測可能な既定値から導いた。

  5. **索引は追加のみ。既存の `idx_outbox_pending` は DROP しない。**
     `packages/postgres/migrations/0002_outbox_claim_lease_index.sql` を新設:

     ```sql
     CREATE INDEX idx_outbox_claimable
       ON outbox (tenant_id, available_at)
       WHERE completed_at IS NULL AND failed_at IS NULL;
     ```

     この述語（`completed_at IS NULL AND failed_at IS NULL`）は、新しい `claimBatch` の
     `WHERE` が持つ AND 節の**部分集合**であり、`leaseMs`/`now` の実引数に関わらず常に
     成立する——`claimed_at` を述語に含めていないため、リースの実引数から独立している
     （部分索引の述語は作成時に固定される定数式でなければならず、`claimed_at` を
     使ったリース条件は `leaseMs` というクエリ実行時の引数に依存するため、索引の述語には
     できない）。

     🔴 **列順 `(tenant_id, available_at)` は CI の実測で判明した修正であり、
     当初の案から変えた（「1回目の CI 実測」参照）。** 当初は `idx_outbox_pending`
     を踏襲して `(tenant_id, kind, available_at)` としていたが、`claimBatch` は
     `kind = ANY(ARRAY['extract','embed'])` のように複数の kind を指定する
     （`runtime.tick` の既定 `kinds` が2値の配列）。索引の列順に `kind` を挟むと、
     `kind` を単一の値に絞らない限り索引の並びは `available_at` の全体順序を
     供給できず（`tenant_id` を固定しても、`kind` の値ごとに `available_at` が
     別々にソートされた区間になるだけ）、プランナは必ず `Sort` を挟む。`ORDER BY
     available_at ASC LIMIT n` の早期打ち切りはこの `Sort` によって失われる。
     **これは `idx_outbox_pending` から受け継いだ欠陥であり、`idx_outbox_pending`
     も述語さえ揃っていればこのクエリを供給できた、という話ではなかった**——
     元の索引の列順自体に同じ欠陥があった。`kind` を索引から外し
     `(tenant_id, available_at)` にすることで、`tenant_id` の等値だけで
     `available_at` 昇順の並びをそのまま使えるようにした。`kind` は残った行への
     `Filter` 条件として効けば足りる（claim 可能な行の母数はもともと小さいことが
     前提——「歯について」の seed 分布参照）。

  6. **`packages/testkit/src/__fixtures__/in-memory-outbox-store.ts`
     （`InMemoryOutboxStore`）と `packages/core/src/__tests__/runtime-fakes.ts`
     （`FakeOutboxStore`）に同じリース意味論を実装する。** 前者は
     `describeOutboxStoreConformance`（後述）が Postgres 実装と共通で走らせる相手であり、
     ここで食い違うと歯が嘘をつく。後者は `packages/core` 自身のテストが使う独立した
     fake（`core` は `testkit` に依存しない、docs/architecture.md §4）であり、こちらだけ
     古い意味論のままだと `runtime.test.ts` が「直った後の姿」を「今日の姿」のつもりで
     検査してしまう。

- **CI の実測（1回目、列順を直す前）**:

  **「使われるはず」ではなく、実際に CI が出した `EXPLAIN` の逐語。** 当初の
  `idx_outbox_claimable`（列順 `(tenant_id, kind, available_at)`）と、当初の seed
  （claim 可能な行が全体の約50%）に対する結果——`packages/postgres/src/__tests__/
  outbox-claim-lease-index.test.ts` の assert が実際にこれを検出して落ちた。

  **前**（`claimed_at` に触れない今日の述語）:
  ```
  Update on outbox o  (cost=302.29..449.66 rows=50 width=90)
    CTE claimable
      ->  Limit  (cost=300.04..300.66 rows=50 width=30)
            ->  LockRows  (cost=300.04..350.66 rows=4050 width=30)
                  ->  Sort  (cost=300.04..310.16 rows=4050 width=30)
                        Sort Key: outbox.available_at
                        ->  Seq Scan on outbox  (cost=0.00..165.50 rows=4050 width=30)
  ```

  **後**（リース条件付き、修正前の索引）:
  ```
      ->  Limit  (cost=262.08..262.70 rows=50 width=30)
            ->  LockRows  (cost=262.08..293.72 rows=2531 width=30)
                  ->  Sort  (cost=262.08..268.41 rows=2531 width=30)
                        Sort Key: outbox.available_at
                        ->  Seq Scan on outbox  (cost=0.00..178.00 rows=2531 width=30)
  ```

  **どちらも `Seq Scan` + `Sort` であり、`idx_outbox_claimable` は選ばれていなかった。**
  原因は2つ重なっていたと判断した（マネージャーの読み、この2点は実測した事実として
  ここに記録する。推論ではない）:

  1. **列順の欠陥（実測した事実）**: `claimBatch` は `kind = ANY(ARRAY['extract',
     'embed'])` のように複数の kind を指定する。索引が `(tenant_id, kind,
     available_at)` だと、`kind` を単一の値に絞らない限り索引の並びは
     `available_at` の全体順序を提供できない——`tenant_id` を固定しても `kind` の
     値ごとに `available_at` が別々にソートされた区間になるだけであり、プランナは
     必ず `Sort` を挟む（上の `Sort Key: outbox.available_at` がまさにこれ）。
     **これは `idx_outbox_pending` から受け継いだ欠陥であり、`idx_outbox_pending`
     も述語さえ揃っていればこのクエリを供給できた、という話ではなかった**——
     この事実は「確かめていないこと」ではなく、CI の実測で確定した。
  2. **seed データが非現実的だった（実測した事実）**: `rows=2531 / 20000`
     （旧 seed では `rows=2531 / 5000`）——述語が全体の約50%に当たっていた。
     全体の半分を指す部分索引は Seq Scan に勝てない。本物の outbox は逆に、
     大半が `completed_at` 済みで claim 可能な行はごく一部という定常状態であり、
     seed をそれに合わせて直した（後述「歯について」）。

  この2点を受けて、決定5の索引を `(tenant_id, available_at)` に列順変更し、
  `packages/postgres/src/__tests__/outbox-claim-lease-index.test.ts` の seed を
  95%が終端済み・5%が未終端という分布に直した。**「前」のテストも、`idx_outbox_claimable`
  が既に存在する DB で測っていたため、新索引の述語が「前」のクエリからも含意されて
  しまい前後の比較になっていなかった**——テストの中で `DROP INDEX
  idx_outbox_claimable` してから測り、`finally` で作り直す形に直した。「後」の
  assert も `not.toMatch(/Seq Scan on outbox/)`（外側の `UPDATE ... FROM
  claimable c` にも Seq Scan が出うるため測りたいものを測れていなかった）から
  `not.toContain("Sort Key: outbox.available_at")`（CTE 側で全体ソートが
  要らなくなったことそのものを測る）へ直した。**修正後の EXPLAIN は、この作業を
  行った環境に `DATABASE_URL` が無いため未実測——次の CI 実行で初めて確認される
  （「確かめていないこと」参照）。**

- **採らなかった案**:

  - **`claimed_at IS NULL` を単独で足す**（オーナーの却下案）。これは「重複」を
    「見えない停止」に交換する変更である。足すと、claim 後にワーカーが死んだジョブは
    `completed_at` も `failed_at` も付かないまま**二度と claim されず、どこからも
    見えなくなる**。今日は（二重処理という代償を払って）自己回復している。この repo は
    既にこの族（「無い」の種類を潰す変更）を ADR 0011・0025・0027・0028 で4回破っており、
    それを直す本 PR で5回目を作ることになる。オーナーの芯（「無い」の種類を潰さない）に
    照らすと、後者（見えない停止）のほうが悪い。

  - **リース長を実装側の定数にする**（例: `DEFAULT_LEASE_MS = 5 * 60_000` を
    `packages/core` に置く）。却下。リース長は「何をもって処理が止まったとみなすか」と
    いう運用方針であり、`packages/core` が決めてよい値ではない。呼び出し側ごとに
    処理時間の性格が違う（`examples/chat` は OpenAI SDK 呼び出しを含み最大30分かかりうる、
    別の呼び出し側は数秒で終わる軽量ジョブしか扱わないかもしれない）——単一の既定値は
    どちらに合わせても片方を壊す。省略可能にすると「方針を決めた呼び出し側」と
    「決めていない呼び出し側」が同じ顔になる、という理由も ADR 0030 の
    `expectedStatus`（省略時は今日と一字も変えない設計）とは対照的にここでは効かない
    ——`expectedStatus` は「省略時は今日通り」という後方互換な既定を持てたが、
    `leaseMs` の「今日」は「リース無し」であり、それを既定にすることは
    「`claimed_at IS NULL` を単独で足す」を裏から実装するのと同じ結果になる
    （リースが常に0扱いになり、claim 済みの行は事実上二度と claim されない）。
    だから既定値そのものを持たせられない。

  - **既存索引 `idx_outbox_pending` を張り替える（述語を変える、または DROP して
    作り直す）**。マネージャーの指示により、破壊的な変更（DROP・列の削除・型変更）を
    避け、追加のみのマイグレーションに留めた。`idx_outbox_pending` は今後プランナから
    選ばれなくなる見込みだが、存在すること自体の害は無い。

- **歯について**:

  最初の基準線（`main`=`a475593`、マネージャー実測値と一致することを確認済み）:
  root **7** / `packages/core` **203** / `packages/testkit` **68** /
  `packages/openai` **20**。本 PR の1回目のコミット後: root 7（変わらず）/
  `packages/core` 203（変わらず——`FakeOutboxStore` のリース意味論は直したが新規の
  `it()` は足していない）/ `packages/testkit` **70**（+2、
  `outbox-store-conformance.ts` に新設した2本）/ `packages/openai` 20（変わらず）。

  **その後、`fix/outbox-claim-lease` は PR #30（ADR 0031、+4）マージ後の
  `origin/main`（`2007234`）へマネージャーが rebase 済み。** 新しい基準線は
  root 7 / `packages/core` 203 / `packages/testkit` **74**（70 + #30 の4）/
  `packages/openai` 20——マネージャーが実測しレビューコメントに明記した値と、
  本ラウンドの作業後に手元で実測した値が一致することを確認した（下記）。

  **本ラウンド（CI 発見1・2の対応）の変更は `packages/core`/`packages/testkit`
  の `it()` を増減させていない**（`packages/postgres` の既存6本のテスト内容を
  「ハードコードした期待値」から「導出した期待値」へ書き換えた・EXPLAIN テスト
  2本の中身を直した・`packages/postgres/src/migrate.ts` に1関数を export
  追加しただけで、いずれも `packages/postgres` 側の変更であり `DATABASE_URL`
  が無いこの環境では実行できない）。本ラウンド後の手元の実測: root 7 /
  `packages/core` 203 / `packages/testkit` 74 / `packages/openai` 20——**基準線と
  完全に一致し、何も壊していないことを確認した。**`packages/postgres` は
  `DATABASE_URL` が無いこの環境では実行できない（後述「確かめていないこと」）。

  新設した2本（`packages/testkit/src/outbox-store-conformance.ts`、
  `InMemoryOutboxStore`/`PostgresOutboxStore` 両方に対して走る）:

  - 「リース内で claim 済みの行は再 claim されず、後続の未処理行に到達できる
    （先頭詰まりの検査、オーナーの仮説）」——**オーナーの「先頭詰まり」仮説を
    実際に再現する歯。** `limit: 1` で先に available になった行を claim したまま
    完了させず、リースが切れる前に次の `claimBatch` を呼ぶと、正しい実装では
    後続の行に到達できることを確認する。
  - 「リースが切れた claim 済みの行は再び claim される（見えない停止にしない。
    `claimed_at IS NULL` 単独案を却下した理由そのもの）」——リース満了の前後
    （`leaseMs - 1` と `leaseMs` ちょうど）で reclaim の可否が切り替わることを
    境界まで検査する。

  変異を4本撃った（手元で走る `InMemoryOutboxStore` に対して。`git diff --stat` が
  空でないこと・`git checkout --` での復元・`git status --short` が空になることを
  毎回確認した）。**すべて新設した歯だけが固有に赤くなり、既存68本は無傷のまま**
  （テストファイル数・テスト総数は常に70のまま——数が変わっていない＝変異以外の
  何かが起きていないことも確認済み）:

  - **M1**（リース条件を丸ごと落とす＝今日の姿に戻す）: 2本が赤くなる
    （先頭詰まりの歯・リース失効の歯の両方——リース条件が無いと「beforeExpiry」も
    「secondClaim」も両方とも今日の壊れ方をそのまま再現するため）。
    先頭詰まりの歯の失敗メッセージ（逐語）:
    `AssertionError: expected [ 'job-114' ] to deeply equal [ 'job-116' ]`
    （`later.id` を期待したのに `stuck.id` が返り続けた——先頭詰まりが実際に起きた）。
  - **M2**（却下案: `claimed_at IS NULL` 単独にする）: 1本が赤くなる
    （リース失効の歯のみ——先頭詰まりの歯は「リース内は再 claim しない」という点では
    却下案と正しい実装が同じ挙動をするため通ってしまう。これは想定通りで、
    却下案固有の欠陥＝「リースが永遠に切れない」を専用の歯だけが捕まえる）。
    失敗メッセージ（逐語）: `AssertionError: expected [] to include 'job-118'`
    （`afterExpiry` が空——リースが切れた後も永久に再 claim されなかった）。
  - **M3**（境界を `<=` から `<` に取り違える）: 1本が赤くなる（リース失効の歯のみ、
    `afterExpiry` を `now = base + leaseMs` ちょうどに固定してあるため、境界の
    取り違えを一意に検出する）。失敗メッセージ（逐語、M2 と同一文字列だが
    原因は異なる——ちょうど境界の取りこぼし）:
    `AssertionError: expected [] to include 'job-118'`。
  - **M4**（符号を取り違える: `now - leaseMs` を `now + leaseMs` にする）: 2本が
    赤くなる。`leaseExpiresBefore` が未来側にずれるため、実質的に「claim 済みの行が
    ほぼ即座に再 claim 可能になる」という M1 と同じ壊れ方になり、同じ2本・同じ
    失敗メッセージ（逐語）が再現した:
    `AssertionError: expected [ 'job-114' ] to deeply equal [ 'job-116' ]` および
    `AssertionError: expected [ 'job-118' ] to not include 'job-118'`。

  fixture の非対称性: 先頭詰まりの歯は `stuck`（先に available、claim される）と
  `later`（後から available、claim されない）という2つの異なる行を使い、「壊れて
  いないほうが通る」ことも同じ歯の中で押さえている（`later` に到達できることを
  assert している時点で、`stuck` だけが特別扱いされていないことも同時に検査される）。
  リース失効の歯は `beforeExpiry`/`afterExpiry` という2つの異なる時刻を1つの job に
  対して順に検査し、「リース内では奪わない」と「リース失効後は奪う」の両方を
  1本の中で対にして押さえている。

  **M5**（本ラウンドで新たに撃った変異、マイグレーションの歯の直しに対して）:
  `packages/postgres/src/__tests__/migrate-concurrency.test.ts` /
  `migrate-ledger-handover.test.ts` の期待値の導出（`ALL_MIGRATION_FILES`/
  `NON_LEGACY_FILES`）を、再びハードコードした `["0001_init.sql"]` に戻す変異。
  **⚠ これは DB が必要な `packages/postgres` の歯であり、テスト自体が実際に
  赤くなることはこの環境では確認できていない**（「確かめていないこと」参照）。

  手元で実際に確認できたのはこの2つ:
  - `git diff --stat` が空でないこと・変異後 `git checkout --` で復元し
    `git status --short` が空になることを確認した。
  - **`pnpm run typecheck` は通ったが、`eslint`（lint 門）は実際に落ちた。**
    ハードコードに戻すと `listMigrationFiles`/`DEFAULT_MIGRATIONS_DIR` の import が
    未使用になり、`@typescript-eslint/no-unused-vars` が2ファイルで計3件の
    エラーを出した（逐語）:
    ```
    packages/postgres/src/__tests__/migrate-concurrency.test.ts
      4:3  error  'DEFAULT_MIGRATIONS_DIR' is defined but never used. ...
      7:3  error  'listMigrationFiles' is defined but never used. ...
    packages/postgres/src/__tests__/migrate-ledger-handover.test.ts
      5:34  error  'listMigrationFiles' is defined but never used. ...
    ```
    **これは意図した検査（マイグレーションの歯が赤くなること）ではなく、
    「導出をやめると import が要らなくなる」という副作用が lint 門にたまたま
    引っかかっただけである。** 本命の検査（テスト自体が期待値の食い違いで赤くなる
    こと）は DB が要るため、CI の postgres ジョブで初めて実測される。**この lint
    エラーが出たことをもって「歯が効いている」と主張しない**——lint はテストの
    赤ではないため、区別する。期待される結果
  （実測ではなく設計上の予想であることを明示する）: `migrate-concurrency.test.ts`
  の「まっさらな DB へ4プロセス相当が同時に migrate」の歯（`ALL_MIGRATION_FILES.length`
  への `toBe` が `2`（0001+0002）ではなく `1` を期待するようになり、実際の適用数
  `2` と食い違って落ちるはず）、および `migrate-ledger-handover.test.ts` の
  「旧名の台帳が在る DB へ migrate しても 0001_init.sql は再実行されない」の歯
  （`NON_LEGACY_FILES` が `["0001_init.sql"]` になり、実際に適用される
  `["0002_outbox_claim_lease_index.sql"]` と食い違って落ちるはず）。

- **引き受ける負債**:

  - **`tick(ctx)` を引数無しで呼べなくなった。** `leaseMs` を必須にした意図した
    破壊的変更であり、`examples/chat` を含むすべての呼び出し側の変更が要る
    （本 PR で `examples/chat/src/embed-drain.ts` を更新済み。他に非テストの
    呼び出し側は無いことを確認済み——`grep -rn "\.tick(\|claimBatch("` で全件確認）。

  - **リースが切れた行は再び claim されるので、処理は at-least-once であり重複しうる。**
    `packages/core/src/interfaces/outbox-store.ts` の契約 doc にこれを明記した。
    これは既存の契約文「Phase 1 では失敗したジョブの自動リトライを行わない（`fail` は
    終端状態）」とは**別の話**である——あちらは `fail()` で終端状態になった（＝処理を
    試みて失敗が確定した）ジョブの話、リースによる再 claim は**終端状態に至らないまま
    止まったジョブ**の回収である。「失敗した仕事の再試行」ではなく
    「終わらなかった仕事の回収」であり、混同しないこと。

  - **使われていない `idx_outbox_pending` が残る。** DROP しない決定の裏返し。

  - **リース長は運用側の判断に委ねられ、この PR は `examples/chat` 以外の
    「本番相当の」呼び出し側を持たない。** 将来、実際のワーカー・スケジューラ実装が
    現れたとき、そこでも同じように「発明せず、実測可能な根拠から導く」ことが要る
    ——本 ADR の決定4がその手本になる。

  - **`packages/core` 自身のテスト用 fake（`FakeOutboxStore`）と `packages/testkit` の
    `InMemoryOutboxStore` という、意味的に重複する2つの in-memory 実装が存在する
    ことは本 PR が作った負債ではない**（既存の構造、docs/architecture.md §4 の
    「core は testkit に依存しない」という制約から来る）が、リース意味論を両方に
    手で複製した以上、今後この2つが再び食い違う可能性は本 PR でも解消していない。

  - **既存のマイグレーションの歯6本（`migrate-concurrency.test.ts` 3本・
    `migrate-ledger-handover.test.ts` 3本）が、実質的に「マイグレーションファイルは
    `0001_init.sql` の1本だけ」というこのリポジトリの歴史的事実に結びついていた。**
    `0002_outbox_claim_lease_index.sql` を足した1回目の CI で、この6本が
    一斉に転んだ（`["0001_init.sql"]` 等のハードコードした期待値と実際の適用結果が
    食い違った）。**このリポジトリは今回まで2本目のマイグレーションを足したことが
    無かった。** 期待値を `packages/postgres/src/migrate.ts` から新たに export した
    `listMigrationFiles(DEFAULT_MIGRATIONS_DIR)` から導出する形に直した
    （書き換えたのはハードコードした配列の中身ではなく、導出の仕方そのもの——
    3本目が増えたときにまた同じ転び方をしないため）。この直し自体は本 PR の
    主題（claim のリース）とは独立した既存不備の発覚であり、本 PR がその1本目を
    足した張本人として直した。

- **確かめていないこと**:

  - **列順を `(tenant_id, available_at)` に直した後の `EXPLAIN`（`idx_outbox_claimable`
    が実際に使われ、`Sort Key: outbox.available_at` が消えること）は、この作業環境
    では未実測。** 1回目の CI 実測（上記「CI の実測」）で列順とseed分布の欠陥を
    検出し、その場で列順・seed・assert を直したが、**直した後のバージョンをCIで
    走らせた結果はまだ無い**——次の CI 実行が唯一の実測経路である。この環境には
    Docker/PostgreSQL/`DATABASE_URL` が無く、`requireDatabaseUrl()` が未設定を
    検知してテストランナー自体が起動しない。
  - **マイグレーションの歯（`migrate-concurrency.test.ts`・
    `migrate-ledger-handover.test.ts`）を `listMigrationFiles` から導出する形に
    直した後、実際に本物の Postgres に対して通ることも同じ理由で未実測。** 手元では
    型検査（`tsc`）が通ることのみ確認した——導出ロジック自体の正しさ（例えば
    `NON_LEGACY_FILES` の計算、`carriedRows` の絞り込み）は、コードレビューでの
    確認に留まる。
  - **`describeOutboxStoreConformance` に足した2本（先頭詰まり・リース失効後の
    再 claim）の postgres 版**も同じ理由でこの環境では実行していない。手元では
    `InMemoryOutboxStore` に対してのみ実行し、通ることを確認した（「歯について」参照）。
  - **本物の並行**（複数プロセスが実際に同時にネットワーク越しで `claimBatch` を
    撃つときのタイミング）で `FOR UPDATE SKIP LOCKED` とリースの組み合わせが
    どう振る舞うかは、単一プロセス内の逐次呼び出ししか検査していない
    （docs/architecture.md の既存の「確かめていないこと」がそのまま引き続く）。
  - **`examples/chat` の30分という値が実運用で適切かどうか**は、実際に OpenAI の
    API を長時間叩き続ける状況で検証していない。SDK のドキュメント上の既定値から
    導いた理論値であり、実測ではない。
  - **M5**（マイグレーション期待値の導出を再びハードコードへ戻す変異）が
    **実際にテストを赤くすること自体**は、DB が必要なためこの環境では確認できて
    いない。手元で確認できたのは、ハードコードに戻すと未使用 import が生まれ
    `eslint`（lint 門）が落ちることのみ（「歯について」参照）——これは意図した
    検査ではなく副作用であり、「歯が効いている」ことの証明として使っていない。
    **この変異がマイグレーションのテストを赤くすることは、CI の postgres ジョブで
    初めて実測される。**

- **これが覆るとしたら**:

  - `examples/chat` 以外の「本番相当の」呼び出し側（実際のワーカー・スケジューラ）が
    実装されたとき、そこでのリース長の根拠は本 ADR の決定4をそのまま流用できない
    可能性がある（処理内容が変われば「正常に処理中でありうる時間」の上限も変わる）。
  - CI の `EXPLAIN` 実測で `idx_outbox_claimable` が選ばれなかった場合、索引の列順・
    述語を見直す必要がある。
  - オーナーの「先頭詰まり」仮説が歯で再現しなかった場合（本 PR では再現したが）、
    リースだけでは解決しない別の設計が要ることになる。
  - `fail()` の自動リトライ・`attempts` の活用・`complete`/`fail` の CAS 化は、本 PR の
    範囲外として名前だけ残した（PR 本文「範囲外」参照）。これらが実装されるとき、
    リースとの相互作用（例: リース切れの再 claim と自動リトライのバックオフが
    二重に効かないか）を再検討する必要がある。
