# ADR 0152: `ConsolidateTarget` に `{ seedMemoryId }` を足す — 「似ている」は recall の `affinity` を流用し、対象の列挙はしない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

- **文脈**:

  ## この ADR が決めていないこと

  🔴 **この ADR は、マネージャーが既に下した決定を実装へ落とすものである。再検討はしていない。**
  `docs/roadmap.md` §5.7（[Issue #135](https://github.com/takecchi/mnemora/issues/135)）は
  「`consolidate()` に『まとめる対象を自分で見つける』呼び方を持たせるか」の3択
  （①要らない ②要る ③保留）を**オーナーの判断待ち**として記録していた。
  **その判断はマネージャー経由で伝達されている**——出所は「人から受け取った前提」であり、
  この担い手が現物で検証したものではない（`docs/autonomy.md` §5 の作法）:

  > オーナーの 2026-09-15 の回答（逐語: 「Aでお願いします。北極星を目指し貴方が進めてください。」）

  **⟹ この ADR は「②要る」を実装する。ただし範囲を絞る**——下の「決定」で述べる通り、
  §5.7 が挙げた「要る」がそのまま Issue #103 提案の `{ maxCandidates }` 単独ではない。

  ## §5.7 が「要る」を保留していた理由——2つの決定が束ねられていた

  §5.7・[ADR 0089](./0089-runtime-consolidate-shape.md) 却下案7 が拒んだのは、
  `{ maxCandidates }` という**1つの引数**が、実は独立した**2つの決定**を束ねていたことによる:

  - **(a) どの記憶を起点にするか**——`MemoryStore` から「active な記憶を列挙する」処理を行い、
    **どれから畳むか**という優先順位（＝新しい製品判断）を発明すること。
  - **(b) 起点に「似ている」ものをどう集めるか**——類似度による近傍探索そのもの。

  ADR 0089 却下案7 はこの2つを分けずに丸ごと却下した。**この ADR は分ける。**

  - **(b) は採る。** 「何が似ているか」を呼び手に決めさせると、呼び手は mnemora の外で
    近傍検索を再実装することになる。[Issue #103](https://github.com/takecchi/mnemora/issues/103)
    が訴えた「統合の主体が二重化する」への逆戻りであり、
    [north-star.md](../north-star.md) の物差し（「使う側が、会話ログを全部プロンプトへ
    積むのをやめられたか」）——正確には、mnemora が想起の道具としての一貫性を失う方向——
    から遠ざかる。
  - **(a) は採らない。** `MemoryStore` に「active な記憶を列挙する」汎用メソッドは無く、
    足すと「どれから畳むか」という製品判断（新しい「似ている」の定義ではなく、
    **新しい優先順位の定義**）を発明することになる。**ADR 0089 却下案7 が拒んだのは
    正確にこれである**（下の「決定」で逐語を引く）。
    ⟹ **(a) は [Issue #204](https://github.com/takecchi/mnemora/issues/204)（駆動）の
    問いへ移す。** `tick()` が回す consolidate ジョブの payload が `seedMemoryId` を運べば、
    種は「いま `extract` で生まれた記憶」として事象駆動で自然に決まり、
    **列挙も走査も要らなくなる。** この ADR はその土台（`{ seedMemoryId }` という形）だけを
    先に作る——Issue #204 自身が「#135 → この issue → #136 の順に依存している」と
    自らの本文で書いている（`docs/roadmap.md` §5.7 に引用済み）。

  ## 「似ている」の定義をどこから持ってくるか

  グループ化の方針（「どの記憶が同じ事実の言い換えか」）を新しく発明すれば、
  ADR 0089 却下案7 が拒んだのと同じ理由で「この ADR が決めていない設計を黙って決めること」
  になる。**⟹ 新しく発明しない。** `recall()` が既に使っている物差しをそのまま使う——
  `packages/core/src/strategies/scoring.ts` の `affinity = max(similarity, lexicalMatch)`
  （埋め込みの近さと語彙の被覆率のうち強い方、[ADR 0084](./0084-lexical-recall-channel.md) §5）。
  製品が既に立っている「似ている」の定義を consolidate も使うことで、
  recall が近いと言うものと consolidate が近いと言うものが食い違う事態を避ける。

  ## reflect() は触らない

  [ADR 0091](./0091-runtime-reflect-shape.md) 却下案1は `reflect()` に
  `{ maxCandidates }` だけを渡す形（Issue #104 の提案どおり）を却下しているが、
  **理由は本 ADR とは別物である**——0091 却下案1 の理由は「土台の選び方そのものが、
  Phase 1 の範囲外である Background Cognition の*実運用*の決定に当たる」こと
  （`target` を必須にすることが `reflect` と Phase 3 の接続点そのものだった、0091 決定3）。
  本 ADR が (a) を退けた理由（`MemoryStore` に列挙の口が無く、優先順位という製品判断を
  発明することになる）とは異なる筋である。**⟹ `reflect` の土台選定の判断はここでは
  再燃していない。** `reflect()` の対象・実装（`ReflectTarget`・`reflect()` 関数）は
  この ADR で一切変更しない——`reflect` の土台選定は別の問いであり、
  `docs/autonomy.md` §2「1つの PR は『1つの ADR とその実装』」「ついでに直さない」に従う。

- **決定**:

  ## 決定1: `ConsolidateTarget` に3つ目の形 `{ seedMemoryId }` を足す

  ```ts
  export type ConsolidateTarget =
    | { memoryIds: MemoryId[] }
    | { query: RecallQuery; maxCandidates?: number }
    | { seedMemoryId: MemoryId; maxCandidates?: number; minAffinity?: number };
  ```

  意味は「**この記憶に似ているものを mnemora 自身が集めて、1つに畳め**」。
  `packages/core/src/runtime.ts` の `ConsolidateTarget`・`consolidate()` の doc コメント・
  実装（`consolidate()` 内の target 正規化、手順1）にこの分岐を足した。

  ## 決定2: 起点の対象選定（(a)）は実装しない——種は必ず呼び手が渡す

  `{ seedMemoryId }` は**種を選ばない。**「active な記憶を列挙してどれから畳むか決める」
  処理は、この ADR の範囲に**一切含まれない。**⟹ `MemoryStore` に列挙用のメソッドを
  足していない。呼び出し側（将来の Issue #204、または人間の呼び出し）が種を渡す。

  ## 決定3: 近傍探索（(b)）は `recall()` を1回呼ぶだけで済ませる——新しい索引・新しい経路を作らない

  実装（`runtime.ts` の `consolidate()` 内）:

  1. `deps.memoryStore.get(ctx, target.seedMemoryId)` で種の Memory を読む。
  2. **見つからなければ `recall()` を呼ばない。** 対象は `[seedMemoryId]` の1件のみとなり、
     後続の（既存の）`getMany` による分類がそのまま `not_found` に落とす——
     **新しい `nothingReason` を発明しない**（決定6）。
  3. 見つかれば、種の `digest` を `RecallQuery.text` にして `recall(ctx, { text })` を
     **1回だけ**呼ぶ——`{ query, maxCandidates }` 形と**まったく同じ経路**
     （同じ `recall()` 関数）を通す。`recall()` 自身は1行も変更していない。
  4. `recall()` が返した候補（種自身を除く）のうち、`RecalledMemory.score` から
     `computeAffinity`（`max(similarity ?? -Infinity, lexicalMatch ?? -Infinity)`、
     `packages/core/src/strategies/consolidate.ts` に新設した純関数）が `minAffinity`
     未満のものを落とす。
     ⚠ **`similarity` も `lexicalMatch` も無い候補（`mandatory_companion` 経由など）は、
     `computeAffinity` が `-Infinity` を返すことで自動的に落ちる**——「似ているかどうか
     分からない」を明示的な特別扱いなしに「似ていない」側へ倒す形にした。
  5. **種そのものは、この判定を受けず、必ず先頭に置く。** 種の embedding がまだ無いと
     ANN 段に載らず `recall()` の結果に現れない（`consolidate` 自身が作る統合先の産物が
     持つのと同じ窓——ADR 0089「引き受ける負債」4「統合先の埋め込みは非同期である」）ため、
     「種は候補に無条件で含める」という規律にしないと、抽出直後の記憶（Issue #204 が
     想定する種）が自分自身を起点にした統合から漏れる。
  6. `maxCandidates` は `[seedMemoryId, ...近傍]` の配列全体を先頭から切る
     （`{ query, maxCandidates }` 形と同じ意味）。種は常に先頭にいるため、
     `maxCandidates >= 1` である限り必ず残る。

  ## 決定4: `minAffinity` の既定値 `DEFAULT_CONSOLIDATE_MIN_AFFINITY = 0.8`

  🔴 **この値は実測していない。** 保守側（畳まない側）に倒した理由——
  統合元は `status: 'superseded'` へ動く（ADR 0089 決定1）ため、**取り違えて畳んだときの
  damage は「畳まなかった」より大きい。** 緩めるのは `examples/chat` の
  `consolidation-cost`（Issue #136、着地済み）で実際に測ってから判断する。
  `ConsolidateOptions.dryRun`（ADR 0089 決定4、この ADR では変更していない）が既に在るので、
  呼び手は本番へ入れる前に何が畳まれるはずかを見られる。

  `packages/core/src/runtime.ts` に定数として置き、`index.ts` の `export * from "./runtime.js"`
  経由でパッケージ外に公開されている。

  ## 決定5: `reflect()` は一切変更しない

  `ReflectTarget`・`reflect()` の実装・doc コメントのどこも触っていない
  （`git diff` で確認: `strategies/reflect.ts` / `reflect` 関連の変更は0行）。
  理由は「文脈」節の「reflect() は触らない」に書いた通りで、ADR 0091 却下案1 とは
  別の理由に基づく——**両者を混同しないこと。**

  ## 決定6: 新しい `ConsolidateNothingReason` は足さない

  `{ seedMemoryId }` で候補が種1件だけになる経路は2つある——
  ①種が `minAffinity` を満たす近傍を1件も持たない、②種そのものが見つからない。
  どちらも、後続の（既存の）`getMany` による分類・eligible 集計を経由して、
  既存の `ConsolidateNothingReason` にそのまま落ちる:

  - 種が見つからない ⟹ `ids = [seedMemoryId]` ⟹ `getMany` が `not_found` に分類
    ⟹ eligible 0件 ⟹ `nothing_to_consolidate` / `no_eligible_sources`。
  - 種は見つかるが近傍が0件（または全部 `minAffinity` 未満） ⟹
    `ids = [seedMemoryId]`（近傍が無いだけ） ⟹ 種が `active` なら eligible 1件
    ⟹ `nothing_to_consolidate` / `single_eligible_source`。種が `active` でなければ
    eligible 0件 ⟹ `no_eligible_sources`。

  **⟹ 新しい `nothingReason` を発明する必要が無い。** `ConsolidateNothingReason` の union が
  唯一の出所であるという規律（ADR 0089 決定2）を保った。仕様（本 ADR の実装範囲を決めた
  マネージャーの指示）は「新しい `nothingReason` を足す必要があるかは実装者が判断してよい」
  としていたが、**足す理由が見当たらなかったので足していない。**

  ## 決定7: `computeAffinity` は `packages/core/src/strategies/consolidate.ts` の純関数にする

  `buildConsolidatedMemory` と同じファイルに置いた——「統合まわりの純関数はここに集める」
  という既存の置き場所の慣行に従う。`runtime.ts` からは import して使うだけであり、
  ロジック自体はテスト可能な純関数として独立させた（ADR 0089「変異試験で分かったこと」が
  示した通り、純関数は直接テストできると変異試験の的が絞りやすい）。

  ## 変異試験で分かったこと

  歯を `packages/core/src/__tests__/consolidate.test.ts` に9本足した（`{ seedMemoryId }` 用5本 +
  `computeAffinity` 純関数用4本。既存24本 + 新規9本 = 33本）。そのあと
  実装を意図的に壊して**どの歯が赤くなるかを目で見た**。6つの変異を打ち、
  1つの等価変異（赤くなってはいけないもの）を混ぜた。

  | 変異 | 壊した内容 | 結果 |
  |---|---|---|
  | M1 | `minAffinity` の判定を `>= -Infinity` に緩めて実質無効化 | 🔴 1本が赤（既定閾値の歯——low 近傍が混入） |
  | M2 | 種を候補へ足す行 (`[target.seedMemoryId, ...neighborIds]`) を `[...neighborIds]` に変える（種を落とす） | 🔴 4本が赤（既定閾値・minAffinity上書き・embedding無しの歯・maxCandidatesの歯） |
  | M3 | `maxCandidates` によるスライスを削除 | 🔴 1本が赤（maxCandidates の歯） |
  | M4 | 種の `not null` 判定を反転（`seed === null` → `seed !== null`） | 🔴 5本が赤（`{ seedMemoryId }` 系すべて。うち1本は `seed.digest` の TypeError で落ちた） |
  | M5 | `computeAffinity` の `Math.max` を `Math.min` に変える | 🔴 7本が赤（`computeAffinity` 純関数の歯4本 + 統合系の歯3本） |
  | M6 | 種を除外する `.filter((m) => m.memoryId !== target.seedMemoryId)` を削除（種が近傍にも重複して残る） | 🔴 3本が赤（種が2回現れて配列が一致しなくなる歯） |
  | E1 | 2つの `.filter()` の呼び出し順序を入れ替える（等価変異——`minAffinity` の判定と種の除外は独立な述語なので、順序を変えても最終集合は変わらない） | ✅ **緑のまま**（33/33） |

  ⚠ **変異を戻すのに `git checkout` を使っていない**（`docs/autonomy.md` §4「未コミットの
  編集も一緒に消える」を踏まない）。各変異の前に `cp packages/core/src/runtime.ts
  /tmp/mutation-backup/runtime.ts.orig`（`strategies/consolidate.ts` も同様）で退避し、
  変異のたびに `cp /tmp/mutation-backup/*.orig <元の場所>` で復元した。**最後に `diff` で
  退避コピーと復元後のファイルが byte 単位で一致することを確認した**
  （`md5sum` も一致: `runtime.ts` = `e447ae53131af499cc5ad2a47f610ccf`、
  `strategies/consolidate.ts` = `017651a86f9439ac12fb5c5154a7c961`）。

- **検討して採らなかった案**:

  1. **選択肢1「要らない」——呼び手が対象を選ぶのが正しいとして、正典にそう書いて
     Issue #135 を閉じる。**
     却下。`docs/roadmap.md` §5.7・マネージャー経由のオーナー回答（「Aでお願いします」）が
     「②要る」を明示的に選んでいる。この担い手が選び直す判断ではない。

  2. **選択肢3「保留」——保留であることを記録するだけに留める。**
     却下。理由は1と同じ——オーナーの回答が「②要る」である以上、保留を選び直す余地は無い。

  3. **`{ maxCandidates }` 単独（＝ (a) も採る）——起点の選定（active な記憶の列挙・
     優先順位付け）も同じ PR で実装する。**
     却下。「文脈」節で述べた通り、これは ADR 0089 却下案7 が拒んだものと同じ形の判断
     （`MemoryStore` に列挙の口が無く、足すと「どれから畳むか」という新しい製品判断を
     発明することになる）である。ADR 0089 却下案7 を逐語で引く:

     > 7. **`{ maxCandidates }` だけを渡して「統合すべき組を mnemora が自分で見つける」形。**
     >    却下。Issue #103 の提案にはこの形が在るが、**「どの記憶が同じ事実の言い換えか」を
     >    決める方針（クラスタリング）は正典のどこにも書かれていない。**
     >    `docs/architecture.md:244` が定義しているのは「複数 Memory → **1 Memory**」という
     >    N→1 の操作であって、「N を複数の組に割る」ではない。
     >    組の割り方を発明すると、それは**この ADR が決めていない設計を黙って決めること**
     >    になる。
     >    ⟹ `{ memoryIds }`（明示）と `{ query, maxCandidates }`（`recall` で引いた集合を
     >    N→1）の2つだけを実装した。**`maxCandidates` は「1回の統合に入れる上限」として
     >    残っている。**
     >    🔴 **これは Issue の提案の一部を満たしていない。**下の負債に記録し、
     >    PR 本文にも書いた。

     **⟹ この ADR は ADR 0089 却下案7 の一部を覆す——ただし全部ではない。**
     却下案7 が拒んだ「mnemora が対象を*自分で見つける*」ことのうち、
     **(b)（似ているものを集める）だけを採用し、(a)（列挙して優先順位を決める）は
     依然として拒んだまま**である。`{ maxCandidates }` を種無しで単独に渡す形
     （＝ Issue #103 が提案した元の形そのもの）は、この ADR でも実装していない。

  4. **「似ている」を新しく定義する**（同一 `subjectId`・`occurredAt` の時間的近接・
     LLM に判定させる、等）。
     却下。`recall()` が既に使っている `affinity` と別の定義を持つと、recall が近いと
     言うものと consolidate が近いと言うものが食い違う。加えて LLM に判定させる案は
     北極星の問い5（「これは、LLM を呼ばずに済ませられないか」）で落ちる——
     近傍探索は列と索引（ANN・語彙索引）で解ける問いであり、モデルに問う必要が無い。

  5. **`reflect()` にも同時に `{ seedMemoryId }` 相当を足す。**
     却下。Issue #135 は `consolidate()` だけを対象にしている。`reflect()` の土台選定は
     ADR 0091 決定3 が Phase 3（Background Cognition の実運用）との接続点として意図的に
     `target` 必須のまま残した設計であり、**この ADR が触れる理由が無い**
     （「文脈」節「reflect() は触らない」参照）。`docs/autonomy.md` §2
     「ついでに直さない」の適用でもある。

  6. **種の embedding を `VectorStore` から直接取り出して、再埋め込み（`recall()` が
     `embeddingProvider.embed()` を呼ぶこと）を避ける。**
     却下——最適化としては筋が良いが、**`VectorStore` interface に「id を指定して
     埋め込みベクトルを取り出す」口が無い**（`packages/core/src/interfaces/vector-store.ts`
     を読んで確認した。`upsert` / `search` / `delete` の3つのみ）。足すと `MemoryStore` と
     同種の「差し替え可能な公開 interface に必須メソッドを足す」問題になり、
     第三者の adapter 実装を壊しうる（ADR 0089 却下案5・`docs/autonomy.md` §3 と同じ線）。
     ⟹ 今回はしない。**種の digest を使って `recall()` に埋め込みをもう一度取らせる
     （1回の consolidate につき embedding 呼び出しが1回増える）**——下の負債1。

- **引き受ける負債・覆えていない範囲**:

  1. **1回の `{ seedMemoryId }` consolidate につき embedding 呼び出しが1回増える**
     （却下案6）。種の digest を `recall()` に渡すたびに `embeddingProvider.embed()` が
     呼ばれる——`VectorStore` に取り出し口が無いための代償。

  2. 🔴 **`minAffinity` の既定値（0.8）は実測していない**（決定4）。
     `examples/chat` の `consolidation-cost`（Issue #136）で実際に測って
     初めて根拠が付く。

  3. **consolidate の質が recall の `affinity` の定義に結合する。** `affinity` の式
     （`strategies/scoring.ts`）が変わると、`{ seedMemoryId }` が集める近傍の集合も
     変わる——意図的な結合（「新しく発明しない」決定3の帰結）だが、
     `affinity` を触る人はこの結合を意識する必要がある。

  4. **起点の選定（(a)）は未解決のまま。** `docs/roadmap.md` §5.8（本 PR で新設）に
     引き継いだ——「active な記憶を列挙して、どれから畳むかを決める」設計判断は、
     この ADR の範囲に一切入っていない。

  5. **冪等性: 同じ種で `{ seedMemoryId }` を2回呼ぶと2回畳む可能性がある。**
     ADR 0089 決定3 の冪等性（「読んで status で弾く」）は `{ memoryIds }` /
     `{ query }` と同じ形でここにも効く——1回目で種と近傍が `superseded` へ動けば、
     2回目は同じ `seedMemoryId` に対して `deps.memoryStore.get` が
     `status: 'superseded'` の Memory を返す。この場合 `recall()` は呼ばれる
     （`seed !== null` なので）が、`ids = [seedMemoryId, ...近傍]` の中で種自身は
     `status_not_active` に分類され、近傍もほとんどが既に統合先へ吸収されて
     `recall()` に現れなくなっているはずである。**ただし「ほとんど」であって
     「必ず」ではない**——1回目で `minAffinity` 未満として落ちた近傍が2回目には
     別の理由で拾われる、といった非決定的な再統合が理論上ありうる。
     この境界は歯で固定していない。

  6. **本物の Postgres に対して `{ seedMemoryId }` を通していない。** この作業環境に
     `DATABASE_URL` が無く、DB テストは実行していない。ただし変更は `packages/core`
     （＋ `packages/core/src/__tests__/runtime-fakes.ts` は変更していない）だけであり、
     `MemoryStore.get` / `recall()` の Postgres 実装は既存の適合テストで測られている。

- **これが覆るとしたら**:

  - **[Issue #204](https://github.com/takecchi/mnemora/issues/204)（`tick()` が
    `consolidate()` を駆動する）が入ったとき。** ジョブの payload が `seedMemoryId` を
    運ぶ形が実際に決まり、`TICK_SUPPORTED_JOB_KINDS` に `'consolidate'` が足される
    （ADR 0089 決定7 の時限式の歯が実際に赤くなる）。そのとき「決めるべきものとして
    残っている」(a)（起点の選定）が再燃しうる——ただしそれは `tick` 側の駆動の設計であり、
    この ADR が決めた `{ seedMemoryId }` の形そのものは変わらない可能性が高い
    （種を1件渡すだけの形は、駆動側がどう種を選んでも合成できる）。
  - **`minAffinity` を `examples/chat` の `consolidation-cost` で実測し、既定値
    （0.8）が動いたとき。**
  - **`recall()` の `affinity` の定義（`max(similarity, lexicalMatch)`）が変わったとき。**
    `computeAffinity` はこの式をそのまま複製しているのではなく、`RecalledMemory.score`
    から同じ式を計算し直しているだけであり、`scoring.ts` 側の式が変われば
    `computeAffinity` も追従して変える必要がある（今は複製ではなく再計算だが、
    式そのものは2箇所——`scoring.ts` の `total` 計算内と `computeAffinity`——に
    同じロジックが存在する。**負債として明記しておく**——次に `affinity` の式を
    変える人は `computeAffinity` も同時に見ること）。
  - **`VectorStore` に id 指定でベクトルを取り出す口が追加されたとき**（却下案6）。
    そのとき種の再埋め込みを避ける最適化を検討できる。

- **確かめていないこと**:

  - **本物の Postgres で `{ seedMemoryId }` を走らせていない**（負債6）。
  - **`minAffinity = 0.8` が実運用で妥当かを測っていない**（負債2）。
  - **LLM が実際に良い統合を作るかは、この ADR の範囲でも測っていない**——
    ADR 0089 が既に「配線と契約であって統合の質ではない」と明記した限界がそのまま続く。
    `{ seedMemoryId }` は候補の集め方を変えるだけで、LLM 呼び出し（手順5以降）は
    ADR 0089 の実装を一切変更していない。
  - **`examples/chat` に `{ seedMemoryId }` を配線していない。** 北極星の物差し
    （「使う側が、会話ログを全部プロンプトへ積むのをやめられたか」）に対して、
    この形が実際に効くかどうかをこの PR は測っていない。
  - **冪等性の境界（負債5）を歯で固定していない。** 「1回目で落ちた近傍が2回目には
    拾われる」という非決定的な再統合が実際に起きるかどうかは検証していない。
