# ADR 0155: `recalls` にスコア内訳を永続化し、`MemoryStore.getRecall` で読み戻す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

- **文脈**:

  ## この ADR が決めていないこと

  🔴 **この ADR は、マネージャーが既に下した決定を実装へ落とすものである。**
  下の「決定」で述べる4点（何を残すか・列を足すのではなく置き換えるか・`getRecall` を
  必須にするか・`RecallResult` を太らせないか）は、[Issue #298](https://github.com/takecchi/mnemora/issues/298)
  の起票段階でマネージャーが既に下しており、この ADR はその根拠を明文化し、実装へ落とす。

  ## 出所（【受】Issue #298 本文、この作業者が現物で裏取りした）

  [Issue #298](https://github.com/takecchi/mnemora/issues/298) は、`docs/north-star.md`
  「目指す姿」の「なぜそれを思い出したのかを、後から説明できる。」（`docs/north-star.md:30`）の
  **「後から」**のほうが成立していないことを指摘している。#284（「目指す姿」7項目の棚卸し）が
  「半分」と判定した3項目のうちの1つの昇格である。

  **【現物で確認した】** `recall()` の戻り値 `RecallResult.memories: RecalledMemory[]`
  （`packages/core/src/recall.ts`）は1件ごとに `score: ScoreBreakdown` / `retrievedVia` /
  `companionOf?` / `associationOf?` / `provenanceKind` を持っている——実際に
  `scoreWithDefaultStrategy`（`packages/core/src/strategies/scoring.ts`）が各項を計算している。
  しかし段6（記録、`recall-runtime.ts` の `createRecall` 呼び出し）は
  `finalMemories.map((m) => m.memoryId)` で **UUID だけ**を取り出し、内訳を捨てていた。
  `NewRecallRecord`（旧 `packages/core/src/recall.ts`）も `returnedMemoryIds: MemoryId[]` しか
  持たず、型の側にも運ぶ欄が無かった。

  さらに **読む口も無かった**——`MemoryStore` interface が `recalls` について持つのは
  `createRecall(ctx, record): Promise<RecallId>` の1本だけで、`getRecall` /
  `listRecalls` に相当するものは `packages/` 全体に0件だった（Issue #298 が
  grep で確認済み）。⟹ `recalls` 行は write-only であり、`RecallId` を持ち帰った呼び出し側が
  後から引く正規の口が無かった。

  ## 北極星の問いに当てた——⭐ 問い1で落ちない理由

  一見この機能は問い1（毎回渡す量を減らす方向に働くか）で落ちるように読める——監査ログは
  想起を良くしないし、ストレージも増える。**しかし落ちない。** `docs/north-star.md:114-120`
  が、問い1の文面を書き直した理由として次を逐語で記録している:

  > **問い1については、最初の草案から書き直している。**
  > 草案は「記憶を『思い出しやすく』するのか『保存しやすく』するのか」という形だった。
  > これを実際に当てたところ、**監査ログと provenance が落ちてしまった**——
  > どちらも単独では想起を良くしないが、両方とも必要なものである。
  > **落としすぎる問いは、落とせない問いと同じくらい役に立たない。**
  > そこで「毎回渡す量」を軸に置き直した。この形なら、
  > **プロンプトに載らない監査ログは通り**、「念のため全部載せる」は落ちる。

  問い1はこれを意図して通している——`recalls` はプロンプトに1バイトも載らない。
  **ただし「問い1で落ちないこと」は「全部保存してよい」を意味しない。** 問い1が落とさない
  なら、別の刃が要る。それが下の「決定1」である。

- **決定**:

  ## 決定1: 保存するのは「後から再現できないもの」だけ

  **刃: 後から再現できるか。** `MemoryStore.get()` を引けば得られるものを `recalls` に写すと、
  同じことを言う道が2つ在って独立にずれる——このリポジトリが繰り返し踏んできた欠陥
  （`TICK_SUPPORTED_JOB_KINDS` の JSDoc が名指ししている族）。

  | 欄 | 後から再現できるか | 判定 |
  |---|---|---|
  | `score`（`ScoreBreakdown` 全項: `similarity?`/`lexicalMatch?`/`decay`/`tagMatch`/`freshness`/`strength`/`total`） | できない — クエリ時点の索引・時刻・強化状態に依存する | **残す** |
  | `retrievedVia` | できない — `embeddingStatus` が変われば経路が変わる | **残す** |
  | `companionOf` / `associationOf` | できない — 矛盾関係は `markContested`/`resolveContested`（ADR 0134/0150）で後から動く。「スコアが低いのになぜ居るのか」に答えるのはこの欄だけ | **残す** |
  | `provenanceKind` | できる — `memories.provenance.kind` から引ける | **残さない** |
  | `digest` | できる — `memories` から引ける | **残さない** |

  `provenanceKind` を落とす判断は ADR 0035 が既に引いた線と同じ向きである——
  「`model`/`promptVersion`/`basis`/`confidence` が要るなら `MemoryStore.get()` を引く。
  そちらは『1件を詳しく見る』問いである」（`packages/core/src/recall.ts` の
  `RecalledMemory.provenanceKind` doc コメント）。

  実装: `packages/core/src/recall.ts` に `RecallRecordMemory`
  （`{ memoryId, score, retrievedVia, companionOf?, associationOf? }`）を新設し、
  `NewRecallRecord.returnedMemories: RecallRecordMemory[]` へ差し替えた。
  `packages/core/src/recall-runtime.ts` の段6は `finalMemories.map((m) => m.memoryId)` を
  やめ、`finalMemories.map((m) => ({ memoryId: m.memoryId, score: m.score, retrievedVia:
  m.retrievedVia, ...companionOf/associationOf }))` に変えた。

  ## 決定2: `recalls.returned_memory_ids uuid[]` を jsonb 1列へ*置き換える*（列を足さない）

  列を足すと「この recall が何を返したか」を言う道が2つ在ることになり、独立にずれうる
  ——このリポジトリが繰り返し踏んだ族（`ForgetResult` の JSDoc が同族を名指ししている）。
  `returned_memory_ids` を削除し、`returned_memories`（jsonb、`{ breakdownCaptured, memories }`）
  の1列だけを出所にする。

  マイグレーション（`packages/postgres/migrations/0013_recall_returned_memories_jsonb.sql`）は
  4手順: (1) 新列を NULL 許可で足す (2) 既存行の `returned_memory_ids` から
  `{ breakdownCaptured: false, memories: [{memoryId}] }` を組み立てて埋める
  （`unnest` が空配列を返す行は `COALESCE` で `'[]'::jsonb` に倒す） (3) `NOT NULL` を付ける
  (4) 旧列を削除する。**破壊的変更だが、0.x ではオーナーが許容している**
  （`docs/autonomy.md` §3）。

  **`breakdownCaptured` で「無い」と「空」を区別する**（ADR 0008「無い」の分類の族、
  Issue #298 受け入れ条件5）。マイグレーション以前の行は内訳を一度も持ったことが無い
  ——`breakdownCaptured: false` になり `memories` は `{memoryId}` だけの配列。
  マイグレーション後に書かれた行は常に `breakdownCaptured: true` になり
  （`PostgresMemoryStore.createRecall` が固定でこの値を書く——`recall-runtime.ts` が
  `finalMemories` から内訳を毎回計算するため「内訳を持たない新規行」は存在しない）、
  `memories: []` は「その recall が実際に0件しか返さなかった」ことを表す。
  ⟹ 移行元が空配列だった行（`{breakdownCaptured: false, memories: []}`）と、新しい
  「0件だった」行（`{breakdownCaptured: true, memories: []}`）は、どちらも `memories: []`
  という同じ顔にならない。

  ### `returned_memories` に `DEFAULT` を置かない（意図的。CI の DB ジョブが実際に踏んだ）

  🔴 **`returned_memories jsonb NOT NULL` に `DEFAULT` を足す誘惑がある**——実際、CI の
  DB 系ジョブ（`conformance.postgres.test.ts`・`ingest-roundtrip.postgres.test.ts`）が、
  `recalls` へ最小列だけを渡して直接 `INSERT`（`recall_usages` の外部キーの相手を
  用意するだけの目的のテストフィクスチャ）する箇所で `23502`（NOT NULL 違反）に落ちた。
  旧 `returned_memory_ids uuid[] NOT NULL DEFAULT '{}'` は列を省略できていたため、
  この種のフィクスチャが気付かず依存していた。

  **⟹ それでも `DEFAULT` は足さない。** `DEFAULT` を置くと、**内訳を記録し忘れた新しい行が
  黙って成功し、しかも移行前の旧行と同じ顔になる。** それは Issue #298 が塞ごうとしている
  穴そのもの（「無い」と「空」を同じ顔で返さない、ADR 0008 の族）を、スキーマの側で
  新しく開けることになる。移行前の行が `breakdownCaptured: false` なのは「この機能より
  前に書かれた」という事実だからであって、**今日書かれた行が内訳を持たないことはバグ**
  であり、同じ表現を与えてはいけない。⟹ `NOT NULL`・`DEFAULT` 無しを維持し、`recalls` へ
  書く者に「何を返したか」を必ず言わせる——テストフィクスチャ側を直す
  （`INSERT INTO recalls (...)` に `returned_memories` を明示的に渡すよう更新した）。

  ## 決定3: `getRecall(ctx, recallId)` を `MemoryStore` の必須メソッドとして足す

  [ADR 0122](./0122-restore-archived-memory.md) の規律
  （「既存の必須メソッドの呼び方を1つ固定するだけで済むなら、新しい任意メソッドを足さない」）
  を先に問うた。`recalls` を読む形は `MemoryStore` のどの既存メソッドにも収まらない
  ——`get`/`getMany`/`getObservation`/`listBySourceObservation` はそれぞれ `memories`/
  `observations` 専用であり `recalls` を読まない。`restoreArchived`（ADR 0122）が
  `updateStatusWithEvent` にそのまま収まったのとは違い、ここには収まる先が無い。
  **⟹ 新しいメソッドを足さずに済む形ではない。**

  そのうえで**必須**（任意ではない）にした理由: `getRecall` は `get`/`getMany`/
  `getObservation`/`listBySourceObservation` と同じ「単純な1行読み出し」の族に属する。
  `archiveDecayed?`/`purgeMemory?`/`markContestedPair?` のような「adapter に新しい書き込み
  形状を要求する」族（未実装でも既定の recall の振る舞いを壊さない）とは違い、
  `getRecall` を実装しない adapter は Issue #298 が問う「後から」を一切満たせない
  ——**「後から説明できる」を任意機能にすると、それは「後から説明できない」と同じである。**

  契約（`get`/`getObservation` と同じ規律）:
  - 対象の行が存在しない、または `tenant_id` が `ctx.tenantId` と一致しない場合は
    `null` を返す（例外にしない）。`id` が adapter の期待する形式でない場合も同じく `null`
    （`packages/postgres/src/mapping.ts` の `isUuidLike`）。
  - 戻り値 `RecallRecord` は `recalls` 行1件ぶん全部（`recallId`/`tenantId`/`subjectId`/
    `query`/`budget`/`omitted`/`usage`/`indexBand`/`explain`/`returnedMemories`/`createdAt`）。

  実装した3箇所:
  - `packages/postgres/src/memory-store.ts`: `getRecall` を追加、`createRecall` を
    新しい jsonb 列（`{ breakdownCaptured: true, memories: record.returnedMemories }`）へ
    書き込むよう更新。読み出しは `packages/postgres/src/mapping.ts` の
    `rowToRecallRecord`/`RecallRow` を新設して1箇所に集めた。
  - `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`
    （`InMemoryMemoryStore`）: `recalls` マップに `createdAt` を足し、`getRecall` を追加。
    この実装が保持する行は常に `createRecall` 経由の新規行なので `breakdownCaptured: true`
    で固定してよい——マイグレーション以前の行を模す必要は無い（それは postgres 側の
    適合スイートの検査で見る）。
  - `packages/core/src/__tests__/runtime-fakes.ts`（`FakeMemoryStore`）: `MemoryStore` を
    実装するテスト用フェイクであり、同じ理由で同じ形の `getRecall` を足した。

  ## 決定4: `RecallResult`（プロンプトへ向かう側）は1バイトも太らせない

  内訳は既に `RecallResult.memories[].score`/`retrievedVia`/`companionOf`/`associationOf`
  に在る。この作業は**それを段6で捨てずに `recalls` へ書き込むだけ**であり、
  `recall()` の戻り値の形は変更していない（`git diff` で確認: `RecallResultSchema`/
  `RecalledMemory` は0行変更）。北極星の問い1が意図して通す形をそのまま守っている。

  ## 適合スイートの歯（`packages/testkit/src/memory-store-conformance.ts`）

  `createRecall`/`getRecall` の節に4本足した:
  1. `createRecall` が書いた行を `getRecall` が内訳つきで読み戻す（score/retrievedVia/
     companionOf を含む2件で検証）。
  2. 存在しない `recallId` に対して `null`（例外にしない）。
  3. 別テナントの `recallId` に対して `null`（tenant scoping、ADR 0007）。
  4. 0件しか返さなかった recall を `{ breakdownCaptured: true, memories: [] }` として
     読み戻す（決定2の「無い」と「空」の区別——ただし新規行の側。旧データからの移行側
     [`{breakdownCaptured: false, ...}`] は本物の Postgres が無いと実行できないマイグレーション
     の検査であり、この適合スイートの範囲外——下の「確かめていないこと」参照）。

  両 adapter（`PostgresMemoryStore`・`InMemoryMemoryStore`）に同じ契約が掛かっている
  （Issue #298 受け入れ条件4）。

- **検討して採らなかった案**:

  1. **`recalls.returned_memory_ids` はそのまま残し、内訳は別列（またはテーブル）に足す。**
     却下。「この recall が何を返したか」を言う道が2つ在ることになる——`returned_memory_ids`
     と新しい内訳列が独立に更新され得る（片方だけ更新するバグが構造的に起こる）。
     決定2の理由と同じ。

  2. **正規化テーブル `recall_results`（`recall_id, memory_id, score, retrieved_via, ...`
     の行を1レコードにつき1行持つ）を新設する。**
     却下（ただし将来覆りうる、下記参照）。Issue #298 が指摘した通り、これは
     マイグレーション + 書き込み経路 + 読み出し口の3点セットが要る点で jsonb 案と
     同等の作業だが、**SQL から内訳で直接クエリできる**という利点と引き換えに、
     `recalls` の書き込みが単一の `INSERT` から `INSERT` + 複数行の `INSERT`（トランザクション
     必須）に変わる——`createObservationWithOutbox` と同じ「同一トランザクションでなければ
     ならない」制約が新しく生まれる。Issue #298 の受け入れ条件が求めるのは
     「recallId から内訳を引けること」であって「内訳で横断検索できること」ではないため、
     複雑さに見合う要求が今は無い。jsonb 1列なら既存の単一 `INSERT` のまま増築できる。

  3. **`provenanceKind`/`digest` も一緒に `returned_memories` へ持たせる**
     （Issue #298 が挙げた「念のため全部載せる」案）。
     却下。決定1の刃（後から再現できるか）で落ちる——`MemoryStore.get(ctx, memoryId)` を
     引けば同じ値が得られるものを複製すると、`memories` の `provenance` が更新された後で
     `recalls` 側が古い値を持ち続ける「独立にずれる」を新しく作る。

  4. **`getRecall` を任意メソッド（`getRecall?`）にする。**
     却下。「文脈」節・決定3で述べた通り、`getRecall` を実装しない adapter は
     Issue #298 が問う「後から」を一切満たせない——ADR 0122 の規律が想定する
     「未実装でも既定の振る舞いを壊さない」任意メソッドの族とは違う。

  5. **既存行の移行時に `breakdownCaptured` を持たせず、`memories: []` とだけ書いて
     済ませる（「無い」と「空」を区別しない）。**
     却下。ADR 0008「無い」の分類の族に反する——呼び出し側が「内訳を記録しそこねた」と
     「記録したが0件だった」を区別できなくなる。受け入れ条件5が明示的にこれを禁じている。

  6. **`returned_memories jsonb` に `DEFAULT '{"breakdownCaptured":true,"memories":[]}'`
     等を足し、`recalls` へ最小列だけ書く既存のテストフィクスチャを温存する。**
     却下（CI の DB 系ジョブが実際にこれで落ちたのを見て検討した案）。「決定2」の
     「`DEFAULT` を置かない」節で述べた通り、`DEFAULT` は「内訳を記録し忘れた新しい行」
     を黙って成功させ、しかも移行前の旧行（`breakdownCaptured: false`）とは別の、
     しかし同じくらい嘘くさい顔（`breakdownCaptured: true` だが実際には何も計算していない）
     を持たせてしまう。Issue #298 が塞ごうとしている穴を、スキーマの便宜のために
     再び開けることになるため却下——**フィクスチャ側（`conformance.postgres.test.ts`
     の `prepareRecallId`・`ingest-roundtrip.postgres.test.ts` の使用報告テスト）を
     `returned_memories` を明示的に渡す形に直した。**

- **引き受けた負債・覆えていない範囲**:

  1. 🔴 **書き込み容量が増えるが実測していない。** ADR 0035 は `provenanceKind` について
     「1件あたり +26文字」を実測しているが、本 ADR は `ScoreBreakdown`（number 7項目）+
     `retrievedVia` + 任意の `companionOf`/`associationOf` を1件ごとに追加する容量増を
     測っていない。`explain`（段トレース）や `usage` と同じ jsonb 列に相乗りするわけでは
     ないため、`recalls` テーブル全体としての行サイズ増加は本番相当のデータで確認する
     必要がある。

  2. **マイグレーション以前の recall は永久に説明できない。** `breakdownCaptured: false`
     の行は `memories: [{memoryId}]` しか持たず、その recall が実際にどのスコアで
     その記憶を選んだかは失われている（元から記録されていなかったため復元不能）。
     決定2はこれを「無い」と明示するところまでしかできず、埋め合わせはできない。

  3. **jsonb なので SQL から内訳で直接クエリできない。** 「`retrievedVia = 'association'`
     の recall を横断して集計する」といった問いには、`returned_memories` を
     アプリケーション側で読んで `jsonb` を展開するか、決定2で却下した正規化テーブル案
     （検討して採らなかった案2）が要る。今回はその要求が無いため対応していない。

  4. **本物の Postgres に対してマイグレーション・`getRecall`・`createRecall` を実行して
     いない。** この作業環境には `DATABASE_URL` も docker も無く（下記「確かめていない
     こと」参照）、マイグレーション SQL は構文・意味をレビューしたのみで、実行結果
     （特に `jsonb_agg` + `COALESCE` が空配列側で `'[]'::jsonb` になること）は検算していない。

- **これが覆るとしたら**:

  - **「`retrievedVia` ごとの内訳を SQL で横断集計したい」という要求が実際に出たとき。**
    検討して採らなかった案2（正規化テーブル `recall_results`）を再検討する材料になる。
  - **`ScoreBreakdown` に項目が増えたとき。** `RecallRecordMemory.score` はその項目を
    そのまま運ぶため、`ScoreBreakdown` を変更する人は `recalls` の保存容量が伴って増える
    ことを意識する必要がある（負債1と結合）。
  - **書き込み容量の実測（負債1）が行われ、許容できない増加だと分かったとき。**
    `similarity`/`lexicalMatch` のような低ビット精度で十分な項目を丸めて保存する、
    といった圧縮の余地を検討することになる。
  - **`examples/chat` が `recallId` から内訳を引いて表示する口を持ったとき**
    （Issue #298 「何が要るか」5番、この PR の範囲外）。そのとき `getRecall` の
    戻り値の形が実際に使われて、過不足が分かる可能性がある。

- **確かめていないこと**:

  - 🔴 **DB テストを実行していない。** この作業環境には `DATABASE_URL` が未設定で、
    かつ `docker`/`docker-compose`（`docker-compose.yml` が指す手段）も、システムへの
    パッケージインストール権限（`sudo`/`apt-get` に必要な root）も無い
    （`whoami` は `worker`、`sudo -n true` は失敗、`docker` コマンド自体が存在しない）。
    ⟹ `pnpm run test` はルートの門が「DB テストは実行していません（ADR 0015）」と
    名指しして緑になる状態のままであり、**`packages/postgres`（`getRecall`/`createRecall`
    の実装・マイグレーション0013）を本物の Postgres + pgvector に対して一度も走らせて
    いない。** 特に本 PR はマイグレーションを追加しているため、この未検証は重い
    ——マイグレーション本体は構文レビューのみで、実行結果を検算していない。
  - **書き込み容量の実測（負債1）。**
  - **`examples/chat` の配線（Issue #298「何が要るか」5番）。** この PR の範囲に含めて
    いない——範囲判断は要求されておらず、`format.ts` は変更していない。
