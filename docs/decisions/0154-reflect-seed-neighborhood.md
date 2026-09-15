# ADR 0154: `ReflectTarget` に `{ seedMemoryId }` を足す — `consolidate` と対称の土台選定、ただし帯は逆向き

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

- **文脈**:

  ## この ADR が決めていないこと

  🔴 **この ADR は、マネージャーが既に下した決定を実装へ落とすものである。再検討はしていない。**
  [Issue #204](https://github.com/takecchi/mnemora/issues/204)（`tick()` が `reflect()`/
  `consolidate()` を駆動する）に着手した前の担い手が、[ADR 0152](./0152-consolidate-seed-neighborhood.md)
  （`ConsolidateTarget` に `{ seedMemoryId }` を足した ADR）を着地させた直後、
  Issue #204 に「引き継ぎ」コメントを残している。その §3.2 に、**マネージャー経由でオーナーの
  許可（「Aでお願いします。北極星を目指し貴方が進めてください。」）の範囲内**として、
  この ADR が実装する形が既に逐語で書かれている——出所は「人から受け取った前提」であり、
  この担い手が現物で検証したものではない（`docs/autonomy.md` §5 の作法どおり、出所を明示する）。
  **⟹ この ADR は Issue #204 引き継ぎコメント §3.2 の決定を実装する。**

  ## なぜ ADR 0152 は `reflect()` を1行も触らなかったか

  ADR 0152 は `ConsolidateTarget` に `{ seedMemoryId }` を足したが、`ReflectTarget` は
  意図的に1行も変更しなかった（同 ADR 決定5・「検討して採らなかった案」5）。
  **`consolidate` と `reflect` が対象選定の自動化を拒んでいた理由は、そもそも別物だった:**

  - **ADR 0089 却下案7（`consolidate`）の理由**: 「組の割り方（クラスタリング）が
    正典のどこにも書かれていない」——**「似ている」の定義が無かった。**
  - **ADR 0091 却下案1（`reflect`）の理由**: 「対象の選び方そのものが、Phase 1 の範囲外である
    Background Cognition の*実運用*の決定に当たる」——`target` を必須にすることが `reflect`
    と Phase 3 の接続点そのものだった（ADR 0091 決定3）。

  ADR 0152 は前者だけを解いた（`recall()` の `affinity` を流用することで「似ている」の定義を
  新しく発明せずに済ませた）。**後者は `reflect` 自身の問いであり、ADR 0152 は
  `docs/autonomy.md` §2「1つの PR は1つの ADR とその実装」「ついでに直さない」に従って
  触れなかった。**この ADR がその宿題を引き取る。

  ## `{ seedMemoryId }` は ADR 0091 決定3（`target` 必須）に反しない

  ADR 0091 決定3 が `target` を必須にした理由は「`reflect` 自身が『何を見るか』を決めると、
  それは Background Cognition の実運用（Phase 3、Scheduler が自動で内省を起動すること）の
  決定になってしまう」ことだった。**`{ seedMemoryId }` もこの制約を破っていない**——
  **起点（`seedMemoryId`）は必ず呼び手が渡す。** `reflect` 自身が「いつ・何を対象に内省を
  起動するか」を決めているわけではなく、`reflect` が決めるのは「渡された起点に似ている
  ものをどう集めるか」だけである。これは ADR 0152 が `consolidate` について使ったのと
  **同じ逃げ道**である（ADR 0152 決定2「(a) 起点の選定は実装しない・(b) 近傍探索だけ採る」の
  reflect 版）。

- **決定**:

  ## 決定1: `ReflectTarget` に3つ目の形 `{ seedMemoryId }` を足す

  ```ts
  export type ReflectTarget =
    | { memoryIds: MemoryId[] }
    | { query: RecallQuery; maxCandidates?: number }
    | { seedMemoryId: MemoryId; maxCandidates?: number; minAffinity?: number };
  ```

  `packages/core/src/runtime.ts` の `ReflectTarget` の doc コメント・`Runtime.reflect` の
  doc コメント・`reflect()` 実装（手順1、対象の正規化）にこの分岐を足した。

  ## 決定2: 近傍探索は `consolidate` の `{ seedMemoryId }` 経路をそのまま雛形にする——新しい「似ている」は発明しない

  実装（`runtime.ts` の `reflect()` 内、`consolidate()` の同型分岐と横に並ぶ形）:

  1. `deps.memoryStore.get(ctx, target.seedMemoryId)` で種の Memory を読む。
  2. **見つからなければ `recall()` を呼ばない。** 対象は `[seedMemoryId]` の1件のみとなり、
     後続の（既存の）`getMany` による分類がそのまま `not_found` に落とす——
     **新しい `nothingReason`/`ReflectBasisOutcome` は発明しない**（決定5）。
  3. 見つかれば、種の `digest` を `RecallQuery.text` にして `recall(ctx, { text })` を
     **1回だけ**呼ぶ——`{ query, maxCandidates }` 形と**まったく同じ経路**（同じ `recall()`
     関数）を通す。`recall()` 自身は1行も変更していない。
  4. `recall()` が返した候補（種自身を除く）のうち、`RecalledMemory.score` から
     `computeAffinity`（`max(similarity ?? -Infinity, lexicalMatch ?? -Infinity)`、
     `packages/core/src/strategies/consolidate.ts`。**新設しない、`consolidate` のものを
     そのまま import して再利用する**）が `minAffinity` 未満のものを落とす。
  5. **種そのものは、この判定を受けず、必ず先頭に置く。** 種の embedding がまだ無いと
     ANN 段に載らず `recall()` の結果に現れない窓があるため（`embeddingStatus: 'pending'`、
     ADR 0152 が `consolidate` について引いたのと同じ理由）、「種は候補に無条件で含める」
     という規律にしないと、抽出直後の記憶が自分自身を起点にした内省から漏れる。
  6. `maxCandidates` は `[seedMemoryId, ...近傍]` の配列全体を先頭から切る（種は常に先頭に
     いるため、`maxCandidates >= 1` である限り必ず残る）。
  7. **その後の分類（手順2以降）は既存の `reflect()` のロジックをそのまま通す。**
     種を含む全 id が既存の `getMany` による4分類（`not_found` /
     `status_not_active` / `basis_is_reflected` / `eligible`）を受ける——**種であることを
     理由にこの分類を免除しない。**種が `provenance.kind === 'reflected'` な Memory を指して
     いた場合（あり得る誤用）も、他の候補と同じく `basis_is_reflected` に落ちる。
     `{ seedMemoryId }` が変更するのは「手順1（対象の集め方）」だけであり、「手順2以降
     （集めた対象をどう分類し、どう書き込むか）」には一切触れていない。

  🔑 **これは `consolidate` の `{ seedMemoryId }`（ADR 0152 決定3）と構造的に同一である。**
  相違点は次の決定3・決定4の2点に限る。

  ## 決定3: 🔑 既定値は `DEFAULT_CONSOLIDATE_MIN_AFFINITY` と別の定数にする——`DEFAULT_REFLECT_MIN_AFFINITY = 0.4`

  **この PR でいちばん重い判断はここである。**

  🔑 **`consolidate` と `reflect` は同じ道具（`affinity`）に逆向きの帯を要求する。**

  - **`consolidate` が欲しいのは「同じ事実の言い換え」** ⟹ **近いほどよい。**統合先は
    元の複数の記憶を1件に畳むものであり、遠い記憶を混ぜると畳んだ結果が意味を失う。
  - **`reflect` が欲しいのは「関連するが同じではない複数の事実」** ⟹ **近すぎると、
    導けるものが無い。**同じ事実の写しを5枚並べて内省させても、新しい知識は出てこない
    ——一般化・気づきは、複数の異なる事実の間の**パターン**から生まれる。

  この向きの違いだけで「別の定数にする」ことは正当化できるが、**低い閾値でよい**
  もう1つの独立した根拠もある: **`reflect()` は既存行の `status` を1つも動かさない**
  （ADR 0091 決定4——`updateStatus`/`updateStatusWithEvent` を1度も呼ばない）。
  ⟹ **取り違えたときの damage が `consolidate`（統合元が `superseded` へ動く、
  ADR 0089 決定1）より小さい** ⟹ **保守側（対象を絞る側）へ倒す理由が `consolidate` ほど
  強くない。**

  🔴 **`0.4` という数字は実測していない。** `DEFAULT_CONSOLIDATE_MIN_AFFINITY`（0.8）の
  JSDoc が「この値は実測していない」と明記しているのと同じ規律を踏む——
  **根拠は向きの議論だけであり、数字の根拠ではない。** `consolidate` の 0.8 より低くする
  ことの妥当性（向き）は上で述べた通りだが、「なぜ 0.4 という具体的な数字なのか」は
  実測に基づいていない。緩める/締めるのは、`reflect` 側の実測
  （`examples/chat` の `consolidation-cost` に相当する reflect 側の計測）が入ってから
  判断する（この ADR の範囲外）。

  `packages/core/src/runtime.ts` に `DEFAULT_CONSOLIDATE_MIN_AFFINITY` と並べて定数として
  置き、`index.ts` の `export * from "./runtime.js"` 経由でパッケージ外に公開される。

  ## 決定4: ⛔ 上限（近すぎるものを除く帯）は入れない

  **入れたくなるが、入れない。**「`reflect` が近すぎる候補も見たいはず」という直感から
  上限（`maxAffinity` のような欄）を足したくなるが、**入れると `reflect` が「何が重複か」を
  判断することになり、それは `consolidate` の仕事である**——責務が二重化する
  （[Issue #103](https://github.com/takecchi/mnemora/issues/103) が訴えたのと同じ形。
  ADR 0089・ADR 0152 が「似ている」の定義を1つに保つために踏んだのと同じ線）。

  代わりに、**「`consolidate` が先に走っていれば重複は既に畳まれている」という前提に乗る。**
  **この前提は負債である**（下記「引き受ける負債」1）——`consolidate` を一度も呼んでいない
  テナントでは、`reflect` の土台が同じ事実の写しで埋まりうる。この ADR はその負債を
  解消しない。上限を足す形は「検討して採らなかった案」2 で扱う。

  ## 決定5: 新しい `ReflectNothingReason`/`ReflectBasisOutcome` は足さない

  `{ seedMemoryId }` で対象が種1件だけになる経路は2種類ある——①種そのものが見つからない、
  ②種は見つかるが `minAffinity` を満たす近傍を1件も持たない。どちらも、既存の
  （手順2以降の）分類・eligible 集計を経由して既存の `ReflectNothingReason`/
  `ReflectBasisOutcome` にそのまま落ちる（ADR 0152 決定6 の reflect 版）:

  - 種が見つからない ⟹ `ids = [seedMemoryId]` ⟹ `getMany` が `not_found` に分類
    ⟹ eligible 0件 ⟹ `nothing_to_reflect`/`no_eligible_basis`。
  - 種は見つかるが近傍が0件（または全部 `minAffinity` 未満） ⟹ `ids = [seedMemoryId]`
    （近傍が無いだけ） ⟹ 種が `eligible` 分類（`active` かつ `provenance.kind !== 'reflected'`）
    なら eligible 1件 ⟹ `reflect` は `consolidate` と違い eligible 1件でも打ち切らない
    （ADR 0091 決定12「eligible 1件でも LLM を呼ぶ」）ため LLM を1回呼び、断れば
    `nothing_to_reflect`/`llm_declined`。種が `eligible` でなければ eligible 0件
    ⟹ `no_eligible_basis`。

  **⟹ 新しい `nothingReason`/`ReflectBasisOutcome` を発明する必要が無い。**

  ## 決定6: `computeAffinity` は新設せず、`strategies/consolidate.ts` のものを import して再利用する

  `computeAffinity` は「近傍探索の物差し」という一般的な関数であり、`consolidate` 固有の
  ロジックではない（`recall()` の `affinity` をそのまま流用しているだけ——ADR 0152 決定7の
  実装がすでに純関数として切り出してある）。`runtime.ts` は既に `consolidate()` の実装で
  この関数を import しており、`reflect()` の実装も同じ import をそのまま使う。
  **新しいファイル（`strategies/reflect.ts` に複製する等）は作っていない**——
  `docs/autonomy.md`「共通化できる部分は共通化する」の適用であり、同時に
  「`consolidate()` の挙動を1文字も変えない」（`strategies/consolidate.ts` は無変更）も
  満たしている。

  ## 変異試験で分かったこと

  歯を `packages/core/src/__tests__/reflect.test.ts` に7本足した（既存24本 + 新規7本 = 31本）。
  そのあと実装を意図的に壊して**どの歯が赤くなるかを目で見た**。4つの変異を打ち、
  復元は退避コピー（`cp`）からの `diff`/`md5sum` によるバイト比較で行った
  （⛔ `git checkout` は使っていない——`docs/autonomy.md` §4「未コミットの編集も
  一緒に消える」を踏まない）。

  | 変異 | 壊した内容 | 結果 |
  |---|---|---|
  | M1 | `minAffinity` の判定を `>= -Infinity` に緩めて実質無効化 | 🔴 1本が赤（既定閾値の歯——low 近傍が混入） |
  | M2 | 種を候補へ足す行 (`[target.seedMemoryId, ...neighborIds]`) を `[...neighborIds]` に変える（種を落とす） | 🔴 5本が赤（既定閾値・minAffinity上書き・embedding無しの歯・maxCandidatesの歯・dryRunの歯） |
  | M3 | `maxCandidates` によるスライスを削除 | 🔴 1本が赤（maxCandidates の歯） |
  | M4 | 種の `not null` 判定を反転（`seed === null` → `seed !== null`） | 🔴 6本が赤（`{ seedMemoryId }` 系すべて。うち1本は `seed.digest` の TypeError で落ちた） |

  最後に `md5sum` で退避コピーと復元後の `runtime.ts` が byte 単位で一致することを確認した
  （`87b735f86a9185f269e2c55136551150`）。

- **検討して採らなかった案**:

  1. **`DEFAULT_CONSOLIDATE_MIN_AFFINITY` を両者で共用する。**
     却下。北極星の問い1（「毎回渡す量を減らす方向に働くか」）に当てると、`consolidate` の
     0.8 のまま `reflect` にも使うと、`reflect` の土台候補が実質「ほぼ同一の言い換え」しか
     拾わなくなり、`reflect` が生み出す一般化・気づきが「近い記憶の言い換え」に矮小化する
     ——`reflect` が増やす記憶の質が下がり、想起の量を減らす方向に効かなくなる。
     逆に `reflect` の 0.4 を `consolidate` にも流用すると、`consolidate` が遠い記憶まで
     拾って畳んでしまい、**統合元を `superseded` へ動かす**（ADR 0089 決定1）誤りの
     damage が大きくなる。**同じ道具に逆向きの帯を要求する**（決定3）以上、共用すると
     どちらかの安全側が破れる。

  2. **`minAffinity` に上限（近すぎるものを除く帯）を入れる。**
     却下（決定4で詳述）。北極星の問い2（「これを無効にしたとき、Memory Framework として
     成立するか」）には影響しないが、**責務の二重化**という別の理由で落ちる——
     「何が重複か」の判断は `consolidate` の仕事であり、`reflect` に同じ判断を持たせると
     mnemora の中に「似ている」の定義とは別に「重複している」の定義が2つ目立つ場所に
     生まれる。[Issue #103](https://github.com/takecchi/mnemora/issues/103) が訴えた
     「統合の主体が二重化する」問題の再燃であり、ADR 0089・ADR 0152 が一貫して拒んできた形。

  3. **`reflect` に「対象を自分で列挙して選ばせる」形**（Issue #104 提案 `reflect(ctx, {
     maxCandidates?, dryRun? })`、ADR 0091 却下案1 の再燃）。
     却下。ADR 0091 決定3 が `target` を必須にした理由（対象選定が Background Cognition の
     *実運用*の決定になる）は、この ADR の範囲でも一切変わっていない。`{ seedMemoryId }`
     は**種を選ばない**——`MemoryStore` に「active な記憶を列挙する」メソッドは足していない。
     呼び出し側（将来の Issue #204、または人間の呼び出し）が種を渡す。この点は
     `docs/roadmap.md` §5.8 が `consolidate` の (a)（起点の選定）について残した宿題と
     同型であり、**この ADR も同じ宿題を `reflect` 側に残したまま、解いていない**
     （下記「引き受ける負債」2）。

  4. **`reflect` 独自の「似ている」を定義する**（例えば「近すぎない」ことを積極的に測る
     新しい指標、同一 `subjectId` を除外する、等）。
     却下。`recall()` が既に使っている `affinity` と別の定義を持つと、recall が近いと
     言うものと `reflect` が近いと言うものが食い違う——ADR 0152 が `consolidate` について
     拒んだのと同じ理由。加えて新しい指標を発明する案は北極星の問い5（「これは、LLM を
     呼ばずに済ませられないか」）以前に、**新しいクラスタリング/フィルタリングの設計判断を
     この ADR が黙って決めることになる**ため、ADR 0152 の規律（「似ている」は発明しない）を
     そのまま踏襲した。

- **引き受ける負債・覆えていない範囲**:

  1. 🔴 **「`consolidate` が先に走っていれば重複は既に畳まれている」という前提に乗っている
     （決定4）。** `consolidate` を一度も呼んでいないテナントでは、`reflect` の
     `{ seedMemoryId }` が集める近傍が同じ事実の写しで埋まりうる——上限が無いため、
     低い `minAffinity`（0.4）はそうした写しも拾ってしまう。この ADR はこの前提が
     破れているかどうかを検査する仕組みを持たない。

  2. **起点の選定（`reflect` を何をきっかけに・どの種で起動するか）は未解決のまま。**
     `docs/roadmap.md` §5.8 が `consolidate` の (a) について残した宿題と同型のものが、
     `reflect` 側にも生まれている。この ADR は `roadmap.md` を更新していない
     （`docs/autonomy.md` §2「ついでに直さない」——§5.8 は `consolidate` の文脈で書かれて
     おり、`reflect` 版の宿題を同じ節に混ぜると読み手が混乱する。**新設するかどうかは
     この ADR の範囲外とし、次の担い手・マネージャーの判断に委ねる。**）

  3. 🔴 **`minAffinity` の既定値（0.4）は実測していない**（決定3）。
     `examples/chat` に reflect 側の計測器（`consolidation-cost` に相当するもの）が
     無いため、実測してから判断することができない。

  4. **reflect の質が `recall()` の `affinity` の定義に結合する。**（ADR 0152「引き受ける
     負債」3 と同一の負債——`consolidate` と `reflect` の両方が同じ結合を持つ。）
     `affinity` の式（`strategies/scoring.ts`）が変わると、`{ seedMemoryId }` が集める
     近傍の集合が両方の動詞で同時に変わる。

  5. **1回の `{ seedMemoryId }` reflect につき embedding 呼び出しが1回増える。**
     （ADR 0152「引き受ける負債」1 と同一の理由——`VectorStore` に id 指定でベクトルを
     取り出す口が無いため、種の digest を `recall()` に渡すたびに
     `embeddingProvider.embed()` が呼ばれる。）

  6. **冪等性は元々買っていない（ADR 0091 決定11）——`{ seedMemoryId }` はこれを悪化させうる。**
     `reflect` は同じ target で2回呼ぶと内容が同じ `reflected` Memory が2件できる
     （既存の負債）。`{ seedMemoryId }` はこれを直接は変えないが、事象駆動で同じ種が
     繰り返し渡される運用（Issue #204 が想定する形）だと、同じ種+同じ近傍の組み合わせで
     何度も内省が起き、重複した `reflected` Memory が積み上がりうる。この境界は歯で
     固定していない。

  7. **本物の Postgres に対して `{ seedMemoryId }` を通していない。** この作業環境に
     `DATABASE_URL` が無く、DB テストは実行していない。ただし変更は `packages/core`
     （＋ `packages/core/src/__tests__/runtime-fakes.ts` は変更していない）だけであり、
     `MemoryStore.get`/`recall()` の Postgres 実装は既存の適合テストで測られている。

- **これが覆るとしたら**:

  - **`minAffinity` の既定値（0.4）を実際に測ったとき**（`examples/chat` の
    `consolidation-cost` に相当する reflect 側の計測が入ったとき）。measured 値が
    0.4 と大きくずれていれば、決定3 の数字そのものを差し替える。
  - **「`consolidate` が先に走っていれば重複は畳まれている」という前提（決定4）が
    破れたとき。** `consolidate` を呼ばない運用が実際に多いと分かれば、上限を足す案
    （「検討して採らなかった案」2）を再検討する必要が生まれる。
  - **[Issue #204](https://github.com/takecchi/mnemora/issues/204)（`tick()` が
    `reflect()`/`consolidate()` を駆動する）が入ったとき。** ジョブの payload が
    `seedMemoryId` を運ぶ形が実際に決まり、`TICK_SUPPORTED_JOB_KINDS` に `'reflect'` が
    足される（ADR 0091 決定1 の時限式の歯が実際に赤くなる）。そのとき起点の選定
    （「引き受ける負債」2）が再燃しうる。
  - **`recall()` の `affinity` の定義（`max(similarity, lexicalMatch)`）が変わったとき。**
    `computeAffinity` を `reflect` も import して使っているため、`scoring.ts` 側の式が
    変わればここにも影響する（ADR 0152「これが覆るとしたら」と同一）。
  - **`VectorStore` に id 指定でベクトルを取り出す口が追加されたとき**（負債5）。
    そのとき種の再埋め込みを避ける最適化を検討できる。

- **確かめていないこと**:

  - **本物の Postgres で `{ seedMemoryId }` を走らせていない**（負債7）。
  - **`minAffinity = 0.4` が実運用で妥当かを測っていない**（負債3）。「向きが逆」という
    議論は現物（ADR 0089 決定1・ADR 0091 決定4）から導けるが、**具体的な数字の妥当性は
    未検証**。
  - **LLM が実際に良い内省を作るかは、この ADR の範囲でも測っていない**——ADR 0091 が
    既に「配線と契約であって内省の質ではない」と明記した限界がそのまま続く。
    `{ seedMemoryId }` は候補の集め方を変えるだけで、LLM 呼び出し（手順5以降）は
    ADR 0091 の実装を一切変更していない。
  - **`examples/chat` に `{ seedMemoryId }` を配線していない。** 北極星の物差し
    （「使う側が、会話ログを全部プロンプトへ積むのをやめられたか」）に対して、この形が
    実際に効くかどうかをこの PR は測っていない。
  - **「`consolidate` が先に走っていれば重複は畳まれている」という前提（決定4・負債1）が
    実運用で成り立つかどうかを検証していない。**
  - **事象駆動の反復呼び出しで重複した `reflected` Memory がどれだけ積み上がるか
    （負債6）を測っていない。**
