# ADR 0114: 減衰しきった記憶をアーカイブへ掃く — `archiveDecayed`（掃引）

- **状態**: 採用 (2026-09)

- **文脈**:

  ## この ADR が埋める穴

  `docs/memory-model.md` §11 Memory lifecycle 表 行8（`:939`）:

  > 8 | active/superseded/contested → archived | `decay_floor_at < now()` を検出する
  > 低頻度の掃引、または明示的なアーカイブ操作 | 非同期（定期ジョブ。全件走査ではなく
  > `decay_floor_at` の範囲走査） | `status='archived'` | `archived`

  `Memory.decayFloorAt` は書き込み時（作成時・強化時）に計算されて列に持たれている
  （ADR 0004・ADR 0011）が、**それを読んで実際に `status='archived'` へ倒す経路が
  これまでどこにも無かった**。`docs/roadmap.md` §3 Phase 2 の表（`:138`）が
  「忘却の実処理（`decay_floor_at` を使った検索時フィルタとアーカイブ掃引）」と
  ひとまとめに書いていたものの、**掃引のほう**（`decay_floor_at` を読んで書き込みへ倒す側）
  だけを実装する。

  `docs/recall.md` §2 段0（`:64`）・§4（`:199`）は `FilteredOmission.condition = 'archived'`
  を既に定義しているが、`status='archived'` にする経路が無い限りこの分岐は一度も発火しない。
  この掃引がその唯一の書き込み口になる。

  ## 索引は既に在る（現物で確認した。伝聞ではない）

  `packages/postgres/migrations/0001_init.sql:115-117`:

  ```sql
  CREATE INDEX idx_memories_recall_gate
    ON memories (tenant_id, status, decay_floor_at)
    WHERE status IN ('active', 'contested');
  ```

  同ファイル `:114` のコメント: 「索引の3列目としては最初から持つ（Phase 2 で使い始める際に
  索引を作り直さないため）」（ADR 0011）。既存の
  `packages/postgres/src/__tests__/recall-gate-index.test.ts`（ADR 0104 の歯、末尾のテスト）が
  「`decay_floor_at` は Phase 1 では読み取りフィルタに使わない…が、索引の3列目としては持つ」
  ことを catalog（`pg_index`）から実測済みである。**⟹ 新しい索引は要らない。**
  `status = 'active'` という等値条件はこの部分索引の述語 `status IN ('active','contested')` を
  含意するため、プランナはこの索引をそのまま使える——これは推測ではなく、この PR が追加した
  `packages/postgres/src/__tests__/archive-decayed-index.test.ts` が
  `recall-gate-index.test.ts` と同じ作法（seq scan/bitmap scan を外して「選べること」を測る）
  で確認している。

  ## この ADR が決めていないこと（issue #196 へ切り分けた）

  🔴 **recall 段1に `decay_floor_at > now()` の読み取りフィルタを実装することは、
  この ADR の対象ではない。**`VectorFilter.decayFloorAtAfter`
  （`packages/core/src/interfaces/vector-store.ts`）は interface にも `PostgresVectorStore`
  実装にも既に在り、適合テストでも境界まで測られているが、
  `recall-runtime.ts` はこれを一度も埋めていない
  （`// ADR 0011: decayFloorAtAfter は Phase 1 では読み取りフィルタに使わない。`）。

  これは issue #196 として別途提起済みであり、**オーナー/設計判断待ちである**。
  理由: `@mnemora/core` は npm に公開済みであり、「今日返っていた Memory が明日返らなくなる」
  という recall の**既定の意味論の変更**は `docs/autonomy.md` §3 の
  ⛔「公開 API の破壊的変更」に触れうる。加えて issue #196 は
  「`omitted` に何を出すか」「`LexicalFilter` 側の非対称をどう揃えるか」という
  この ADR の掃引だけでは答えられない判断を残しており、**混ぜると両方の主張が読めなくなる**
  （`docs/autonomy.md` §2「ついでに直さない」）。

  **⟹ この PR は掃引（書き込み経路）だけを入れる。recall の読み取り側は1行も変えない。**

- **決定**:

  ## 決定1: `MemoryStore.archiveDecayed` を任意メソッドにする

  ```ts
  archiveDecayed?(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult>;
  ```

  🔴 **必須にしない。**必須にすると `MemoryStore` を実装する第三者の adapter を壊す
  破壊的変更になる（`@mnemora/core` は npm 公開済み。ADR 0100 決定1と同じ理由）。
  この口を実装しない adapter では `Runtime.sweepArchive` が
  `{ supported: false, archived: [], reachedLimit: false }` を返すことで
  「対応していない」と正しく名乗る——黙って0件を返さない（ADR 0082の哲学）。

  ## 決定2: 対象は `status = 'active'` のみ。`superseded`/`contested` はこの口では触らない

  lifecycle 表行8は起点として `active/superseded/contested` の3つを挙げているが、
  この掃引が対象にするのは `active` だけである。理由は「検討して採らなかった案」参照。

  契約:
  - `tenant_id = ctx.tenantId` かつ `status = 'active'` かつ `decay_floor_at <= opts.now`
    （**`<=`、境界を含む**）。
  - ⚠ **`VectorFilter.decayFloorAtAfter` は狭義の `>`（境界を含まない）であり、
    この非対称は意図である**——`decayFloorAtAfter` は recall 側の下限境界（これより後の
    ものだけを候補にする）、こちらは掃引側の上限境界（これ以前に閾値を割ったものを掃く）で、
    2つの異なる関心が同じ演算子を共有する理由が無い。
  - `decay_floor_at` 昇順（最も古く遠ざかったものから）で `opts.limit` 件まで。
  - 選ばれた各行について `status='archived'` への更新と `memory_events` への
    `kind='archived'` の追記を**同一トランザクション**で行う（ADR 0031 の
    `updateStatusWithEvent` が確立した「更新とイベントは同値」の不変条件をここにも適用）。
  - 対象が0件なら `{ archived: [], reachedLimit: false }` を返す（例外を投げない）。
  - 一度 `archived` になった行は `status = 'active'` の条件に合わなくなるため、
    同じ範囲を繰り返し掃引しても同じ行が二度 archived になることはない
    （呼び出し自体が特別にべき等性を持つのではなく、対象条件が書き込みの結果として
    自然に外れることによる）。

  `ArchiveDecayedOptions.limit` に既定値は置かない（`ClaimOutboxJobsOptions.leaseMs`
  （ADR 0032）・`RequeueEmbedJobsOptions.limit`（ADR 0079）と同じ理由——1回の掃引で
  いくつ処理するかは運用方針であり、`packages/core` が発明してよい値ではない）。
  `now` も呼び出し側が渡す（ADR 0037 の「時刻は呼び出し側が渡す」規律）。

  `ArchiveDecayedResult.reachedLimit` は `archived.length === opts.limit` のときに `true`——
  「`limit` 件ちょうど返した＝まだ在るかもしれない」を意味する。**「残り何件か」は返さない**
  （数えるには対象全体を数える別クエリが要り、「範囲走査のみで安価に済ませる」という
  設計と衝突する）。「もう無い」（`false`）と「分からない」（`true`）を区別するところまでが
  この口の契約であり、`ann_truncated`/`ann_unreached`（`docs/recall.md` §4）が守っている
  規律と同じ形である。

  ## 決定3: `Runtime.sweepArchive` は `archiveDecayed` へそのまま素通しする。自動では走らない

  `reembed`（ADR 0079）と同じ形。`Runtime.tick`/`Runtime.observe` に相乗りさせない——
  呼び出し側が明示的に `sweepArchive` を呼んだときだけ走る保守操作である。

  ```ts
  export interface SweepArchiveResult {
    supported: boolean;
    archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }>;
    reachedLimit: boolean;
  }
  ```

  `supported` は省略可能にしない（`WriteAtomicity`（ADR 0100）と同じ理由——`undefined` は
  「口が無かった」と「この欄が増える前の版の戻り値」の両方を意味してしまう）。

  ⚠ `reextract`/`consolidate`（ADR 0100）と違い、フォールバック経路を持たない——
  `decay_floor_at` を読んで `archived` にする経路はこの口以外に無いため、
  「対応していない」を返すだけで、それ以上の代替を試みない。

  ## 決定4: postgres 実装は既存索引を使い、更新とイベント追記を単一の SQL 文にまとめる

  `requeueEmbedJobs`（ADR 0079）と同じ理由——単一の `WITH … UPDATE … INSERT … SELECT` 文に
  まとめてあるので、明示的な `BEGIN`/`COMMIT` を書かなくても両方が同じトランザクションに入る
  （「片方だけ起きる」を構造的に作れない）。`digest_snapshot` には archived にする直前の
  `digest` を入れる（`forget` が `updateStatusWithEvent` に渡す規約と同じ）。

  対象選択の `SELECT`（`buildArchiveDecayedTargetSelect`）は本体と索引適用可能性の歯とで
  共有する——`buildRequeueEmbedTargetSelect`（ADR 0079）と同じ理由。テスト側に述語を
  書き写すと、本体の述語を直したときに歯だけが古い述語を測り続ける。

- **検討して採らなかった案**:

  1. **`superseded`/`contested` も掃引の対象にする（lifecycle 表行8の3起点をそのまま実装する）。**
     却下。`contested` は相互に `contestedWithId` を指す一対一の機構（`docs/memory-model.md`
     §5）を持ち、片側だけ `archived` にすると対向の一対一が破れる（ADR 0087が `forget` で
     引き受けた負債1と同じ形の穴）。`contested` を解決する規則自体が Phase 1 に無いため、
     解決せずに掃引の対象にだけ加えると、**対向不整合を新しく作る側になる。**
     `superseded` は既に `superseded_by_id` で置き換え先が追え、recall 候補生成のゲートで
     既に弾かれている（`recall-gate-index.test.ts` の述語 `status IN ('active','contested')`
     に `superseded` は入らない）ため、これを archived にする追加の価値が薄い一方、
     `superseded` → `archived` の遷移を新設すると `docs/memory-model.md` §11 の表にもう1行
     必要になる。**スコープを最小に保ち、`active` のみを対象にした。**
     `superseded`/`contested` を掃く必要が実際に出てきたら、対向不整合の扱いを決めたうえで
     別の ADR にする。

  2. **recall 段1に `decay_floor_at > now()` の読み取りフィルタを同じ PR で実装する。**
     却下。issue #196 として切り出し済み。既定の recall 意味論を変える破壊的変更の判断は
     オーナー/設計判断であり、この ADR の範囲ではない（「この ADR が決めていないこと」参照）。

  3. **新しい索引を足す（`(tenant_id, status, decay_floor_at) WHERE status = 'active'` 専用）。**
     却下。既存の `idx_memories_recall_gate` の述語 `status IN ('active','contested')` は
     `status = 'active'` を含意するため、プランナはそのまま使える。新しい索引は書き込みの
     コストを増やすだけで、読み取り側に利得が無い。

  4. **`limit` に既定値を置く。**
     却下。ADR 0032（`leaseMs`）・ADR 0079（`RequeueEmbedJobsOptions.limit`）と同じ理由——
     1回の掃引でいくつ処理するかは運用方針であり、`packages/core` が発明してよい値ではない。

  5. **`Runtime.tick`/`Runtime.observe` から自動的に掃引を走らせる。**
     却下。北極星の問い2「これを無効にしたとき、Memory Framework として成立するか」に
     照らすと、掃引を呼ばない運用でも observe/recall は成立しなければならない。掃引を
     `tick` に相乗りさせると「掃引を止める」ための独立した操作が無くなり、Phase 1 が既に
     確立した「`InlineScheduler` が既定だが `extract: 'sync'` も残す」という「無効にしても
     成立する」設計と矛盾する。

  6. **`reachedLimit` の代わりに「残り件数」を返す。**
     却下。数えるには対象全体を数える別のクエリが要り、この掃引を「範囲走査のみで安価に
     済ませる」という設計そのものと衝突する。`ann_truncated`/`ann_unreached` と同じ規律
     （「もう無い」と「分からない」の区別だけを持ち、推定値を実測値の顔で出さない）に揃えた。

- **引き受けた負債・覆えていない範囲**:

  1. 🔴 **`superseded`/`contested` な Memory は `decay_floor_at` を過ぎても掃かれない。**
     「採らなかった案」1参照。`contested` の対向不整合を解決する仕組みが Phase 1 に無い限り、
     この負債は残る。

  2. **recall 段1は `decay_floor_at` を一度も読まない（issue #196 が未解決のまま）。**
     この掃引が `status='archived'` を実際に書けるようになったことで、
     「掃引を呼んだ後」は `status` ゲートが実質的に `decay_floor_at` ゲートと同じ効果を持つが、
     **「掃引を呼んでいない期間」だけは減衰しきった記憶が返り続ける。**この差分に価値が
     在るかどうかは issue #196 の本題であり、この PR では判断していない。

  3. **`archived` から `active` へ戻す口を開けていない。**`docs/memory-model.md` §11 の
     lifecycle 表は `archived` からの遷移を書いていないため、復元 API は今回のスコープ外。

  4. **本物の Postgres に対してこの掃引を通していない。**この作業環境に `DATABASE_URL` が
     無く、DB テストは実行していない（`docs/autonomy.md` §1.1「DB を用意できない環境では
     段2・段4は『判定不能』」）。CI の DB 付きジョブが実測の場になる。

  5. **`docs/recall.md` §4 の `Omission` 列挙・`docs/memory-model.md` §11 の表は
     この PR では書き換えていない。**`condition: 'archived'` は既に定義済みであり
     （§2 段0・§4）、この PR はその分岐を初めて発火させる書き込み経路を足しただけである。

- **これが覆るとしたら**:

  - **issue #196（recall 段1のゲート）が「既定にする」で決着したら**、この掃引と
    `decay_floor_at` ゲートの二重化（両方が同じ Memory を隠す）が起きうる。そのときは
    「掃引済みなら status ゲートで十分」「掃引前でもゲートで隠す」の両方が同時に真になるので
    矛盾はしないが、`omitted` の `condition` をどちらの理由で出すかは issue #196 側で
    決める必要がある。
  - **`contested` の解決規則が Phase 2 で入ったら**、負債1を埋める形でこの掃引を
    `superseded`/`contested` へ広げる判断が要る。今は決めない——解決規則を決めずに
    掃引の対象だけ広げると、対向不整合を新しく作る側になる。
  - **`archived` からの復元が要求されたら**、負債3が課題になる。そのとき
    `docs/memory-model.md` §11 の表を先に直す必要がある（実装の都合で lifecycle を
    黙って広げない）。

- **確かめていないこと**:

  - **本物の Postgres でこの掃引を走らせていない**（負債4）。この環境に DB が無い。
    `packages/postgres/src/__tests__/archive-decayed-index.test.ts`・
    `archive-decayed-atomicity.postgres.test.ts` は歯として置いたが、CI の DB 付きジョブが
    実測の場になる。
  - **索引 `idx_memories_recall_gate` が「選べる」ことは歯で確認したが、
    「選ばれる」ことは強制なしでは確認していない**（`archive-decayed-index.test.ts` の
    doc コメント参照。`recall-gate-index.test.ts` と同じ限界を引き継ぐ）。
  - **「索引 `idx_memories_recall_gate` の3列目が先置きされているのでマイグレーションは
    不要」という前任からの伝聞は、この ADR を書く際に現物（`migrations/0001_init.sql:115-117`
    とそのコメント `:114`、および既存の `recall-gate-index.test.ts` 末尾のテスト）で検算し、
    真であることを確認した。** 出所: 前任の作業引き継ぎメモ（未検証のまま渡された）。
