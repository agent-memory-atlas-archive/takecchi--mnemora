# ADR 0153: recall の段1に忘却ゲート（`decay_floor_at`）を既定で通す — opt-in ではなく opt-out、黙って減らさない

- **状態**: 採用 (2026-09)

- **文脈**:
  Issue #196 は、`docs/recall.md` §3・[ADR 0004](./0004-decay-at-query-time.md)・
  [ADR 0011](./0011-no-window-count-in-ann-stage.md) が「Phase 1 では `decayFloorAtAfter` を
  段1の読み取りフィルタに使わない」と決めた点を指摘した。**配線は最初から揃っている**——
  `Memory.decayFloorAt` は書き込み時に一度だけ計算されて列に入り（[ADR 0004](./0004-decay-at-query-time.md)）、
  `VectorFilter.decayFloorAtAfter` は interface に在り `PostgresVectorStore.search` が実装しており
  （`m.decay_floor_at > $n`）、`packages/testkit` の適合テストで境界（狭義の `>`）まで測られている。
  索引 `idx_memories_recall_gate (tenant_id, status, decay_floor_at)` もこの用途のために
  最初から3列目を持つ（ADR 0011）。**唯一欠けているのは、`recall-runtime.ts` がこの欄を
  一度も埋めていないという配線1本だった**
  （`packages/core/src/recall-runtime.ts` の段1 ANN 呼び出しの直後に
  `// ADR 0011: decayFloorAtAfter は Phase 1 では読み取りフィルタに使わない。` という
  注記が現存していた）。

  自動で着手せず issue にした理由は、**既定の `recall()` の意味論が変わる**ことにある。
  `@mnemora/core` は npm に公開済みであり、「今日返っていたものが明日返らなくなる」変更は
  `docs/autonomy.md` §3 の⛔「公開 API の破壊的変更」に当たる——**提起までにする**、
  というのがその規律である。加えて [ADR 0114](./0114-archive-sweep-for-decayed-memories.md) の掃引
  （`status='archived'`）が入ったことで、このゲートが無くても掃引後は同じ効果を持つ。
  **ただし「掃引を呼んでいない期間」だけは、減衰しきった記憶が返り続ける。**この差分に
  価値が在るかどうかが issue の本題だった。

  Issue #196 は3つの判断点を残していた: (1) 既定にするか opt-in にするか、(2) `omitted` に
  何を出すか、(3) `LexicalStore` 側との非対称をどう揃えるか。**この3点は、オーナーの回答
  （下記「出所」）を受けてマネージャーが決定し、本 ADR に記録する。**

- **北極星の5つの問いに実際に当てた結果**（`docs/north-star.md`「迷ったときの問い」。
  各問いが実際に何を落としたかを記録する——問いは書いた時点では飾りと区別が付かない、
  という同文書の戒めに従う）:

  | 問い | この判断にどう当たったか | 落ちた案 |
  |---|---|---|
  | **1**（毎回渡す量を減らす方向に働くか） | ゲートは「減衰しきった記憶」を候補から外す。返す件数は `limit` が決めるので生の量は変わらないが、**同じ予算枠を、まだ生きている記憶で埋める**方向に働く。「念のため古いものも載せる」がこの問いで落ちる。 | **opt-in 案**（下記）——既定では何も変わらないので、この問いに一歩も応えない。opt-in にする限り、mnemora を入れても呼び出し側は何も変わらないままでよく、物差し（「会話ログを全部積むのをやめられたか」）は1ミリも動かない。 |
  | **2**（これを無効にしたとき、Memory Framework として成立するか） | 既定 ON にするが、**明示的な opt-out（`RecallQuery.includeFullyDecayed`）を必ず持たせる。** | **逃げ道の無い既定 ON**——ゲートを外せない設計は、この問いに「成立しない」と答えることになる。オーナーが決めた `decay_floor_at` の意味論（=「これを過ぎたら検索対象から外れうる」という閾値）自体を疑い直したい呼び出し側や、忘却の実装を丸ごと無視したい呼び出し側の逃げ道が要る。 |
  | **3**（選ばれた理由を、後から説明できるか） | ANN の押し下げ分は原理的に数えられない（下記「決めたこと2」）が、**「ゲートが適用されたこと」自体は `explain.stages` の `detail.decayGate` に必ず出す。** | **黙って減らす案**——`decayFloorAtAfter` を配線するだけで `omitted`/`explain` に一切触れない実装は、この問いで落ちる。件数を出せないなら、少なくとも「効いたかどうか」を出さなければ説明可能性が壊れる。 |
  | **4**（AI の推論と、ユーザーが言った事実を区別しているか） | このゲートは `provenance.kind` に触れない。無関係。 | 落ちる案なし——この問いはこの判断を規定しない。 |
  | **5**（LLM を呼ばずに済ませられないか） | 述語は `Memory.decayFloorAt > now` という、既に列に載っている値どうしの純粋な比較である。 | **LLM に「この記憶はもう古いか」を判定させる案**（検討すらしなかったが、問い5に当てると明確に落ちる）——`decay_floor_at` という列と索引で解けるものを、モデルに問う理由が無い。 |

  **問い1が opt-in 案を落とし、問い2が「逃げ道の無い既定 ON」を落とし、問い3が「黙って減らす」を落とし、問い5が「LLM に減衰を判定させる」を落とした。**この4点が本 ADR の決定を形作っている。

- **決めたこと**:

  ## 1. 既定で有効にする（opt-in ではなく opt-out）

  **`recall()` は既定で忘却ゲートを適用する。** `RecallQuery` に
  `includeFullyDecayed?: boolean`（既定 `false`）を足す。`true` を渡すと、この PR より前の
  挙動（減衰しきった Memory も候補に残り続ける）に戻る。

  - 根拠は上の「北極星の5つの問いに当てた結果」の問い1・問い2。
  - **これは破壊的変更であることを引き受ける。** `docs/autonomy.md` §3 は⛔として
    「公開 API の破壊的変更」を挙げ、「提起までにする。ADR を書き、実装は別 PR にして、
    承認を待つ」と定めている。**オーナーが 2026-09-15 に逐語で「Aでお願いします。
    北極星を目指し貴方が進めてください。」と回答し、v0.x の破壊的変更を許諾した**
    （出所は下記「出所について」）。この回答により、`docs/autonomy.md` §3 の同項は
    v0.x のあいだ、この判断に限って解けている。
  - **「目指す姿」の「使われない記憶が、静かに遠ざかる」は、掃引だけでなく「掃引を呼んでいない
    期間」にも効くべきである。** opt-in ではこの半分が既定では起こらない。

  ## 2. 黙って減らさない。ただし件数は偽らない

  - **ANN チャンネル（段1）は `VectorFilter.decayFloorAtAfter` に「いま」を押し下げる。**
    索引 `idx_memories_recall_gate` の3列目はこの用途のために最初から在る。
    ⟹ **押し下げで落ちた分の件数は原理的に数えられない**——[ADR 0011](./0011-no-window-count-in-ann-stage.md)
    が段1の候補生成について確立したのと同じ理由（ANN はテーブル全体を走査しないので
    「返さなかった件数」という概念自体が索引の外にある）。
  - **語彙チャンネルは、core が後置フィルタで実際に落とした件数を数える。**
    こちらは正確に数えられる（下記「決めたこと3」）。
  - ⟹ `omitted` には `Omission { kind: 'filtered', condition: 'decayed', count, countKind }` を、
    **後置フィルタが実際に1件以上落としたときだけ**積む。`count` は後置フィルタが落とした
    件数、`countKind` は常に `'lower_bound'`（押し下げ分がこの数に含まれておらず、
    実際の総数はこれ以上でありうるため）。
    - **`FilteredOmission.condition` の union に新しい値 `'decayed'` を足した**
      （`packages/core/src/recall.ts`）。既存の `'archived'` に相乗りしない——`archived` は
      `status` 列によるゲート（掃引が明示的に書き換えた状態）、`decayed` は `decay_floor_at`
      列によるゲート（書き込み時に計算された時刻と「いま」の比較）であり、別の列・別の理由・
      別の次の一手（`archived` は強化すれば戻る可能性、`decayed` は強化すれば
      `decayFloorAt` 自体が先へ延びる）を持つ。
    - **ゲートが1件も落とさなかったときに、偽の `omitted` を積まない。** ANN のみの
      recall で、押し下げが候補集合から既にすべて除いていれば、後置フィルタが「追加で」
      落とす分は無く、`omitted` に `decayed` は現れない（歯: `recall-decay-gate.test.ts`
      「通常の配線……では、後置フィルタは追加で何も落とさない」）。
  - **`explain.stages` の `candidate_generation` の `detail.decayGate` に、ゲートが適用された
    ことを出す。** ANN のトレースは `"pushed_down"`（既定）/`"disabled"`
    （`includeFullyDecayed: true`）、語彙のトレースは `"post_filtered"`（既定）/`"disabled"`。
    **「ゲートが効いた」ことが呼び出し側から見えることが受け入れ条件である**（Issue #196）。

  ## 3. `LexicalFilter` に `decayFloorAtAfter` を足さない。core の後置フィルタで全チャンネルに同じ述語を適用する

  - **理由**: interface と adapter を増やさずに、効果の非対称（語彙チャンネルだけ
    減衰済みが返る）を消せる。述語は `Memory.decayFloorAt > now` という、`Memory` に既に
    載っている列どうしの純粋な比較であり、**LLM も追加クエリも要らない**（問い5）。
  - **実装**: `recall-runtime.ts` は、ANN・語彙どちらのチャンネルから来た候補も、段1の後
    （`filteredCandidates` を組む同じループ）で `decayFloorAt > now` を通す。ANN の候補は
    既に段1の押し下げでこの述語を満たしているはずなので、通常はここで何も落とさない——
    **これを実際にテストで示すことで、押し下げと後置フィルタが同じ述語であることの検算になる**
    （歯: `recall-decay-gate.test.ts` の「押し下げと後置フィルタは同じ述語であることの検算」
    describe。`DecayFloorAtAfterStrippingVectorStore` で adapter が push-down を守らない状況を
    歯の中だけで再現し、それでも core の後置フィルタが同じ述語で拾うことを多層防御として示す
    ——`recall-period-filter.test.ts` の `PeriodStrippingVectorStore`、ADR 0059 と同じ手口）。
  - **⚠ 残る非対称は「押し下げか後置か」という効率の差だけになる。** 後置なので、
    語彙チャンネルは k'（over-fetch 枠）を減衰済みの候補に食われうる——ANN と違い、
    語彙チャンネルの adapter 自身は decayFloorAtAfter を知らないので、`limit: kPrime` で
    `LexicalStore.search` に渡す段階では減衰済みの候補を除けない。**これは引き受ける負債
    である**（下記「引き受けた負債」）。

  ## ADR 0011 の明示的な上書き

  [ADR 0011](./0011-no-window-count-in-ann-stage.md)「decay_floor_at の扱いについて」の節は
  「Phase 1 の段1クエリは `decay_floor_at` を読み取りフィルタに使わない」と決定していた。
  **本 ADR はその決定を明示的に上書きする。** `recall-runtime.ts` は既定で
  `VectorFilter.decayFloorAtAfter` に「いま」を渡す。ADR 0011 が決定した仕組みそのもの
  （`decay_floor_at` を書き込み時に一度だけ計算する構造、索引の3列目として最初から
  `decay_floor_at` を持たせる設計）に変更は無い——変わるのは「いつ読み取りフィルタとして
  使い始めるか」というタイミングだけである。ADR 0011 の本文は書き換えない（履歴を
  書き換えない、`docs/decisions/README.md`「重大な設計判断は ADR に残す」の形式に従う）。
  代わりに、ADR 0011 の当該節に本 ADR を指す追記節を足した。

- **検討した代替案（落とした案）**:

  1. **opt-in にする（既定 OFF、明示的に `includeDecayedGate: true` のような欄で有効化する）。**
     破壊的変更にならない代わりに、**既定では何も変わらない**——「北極星の5つの問いに
     当てた結果」の問い1で落ちる。物差し（「使う側が会話ログを全部積むのをやめられたか」）は
     1ミリも動かない。issue 本文自身がこの点を指摘している。
  2. **`LexicalFilter` にも `decayFloorAtAfter` を足し、両チャンネルとも段1へ押し下げる。**
     効率は良い（語彙チャンネルの over-fetch 窓が減衰済み候補に食われない）が、
     `LexicalFilter` interface・`PostgresLexicalStore`/`InMemoryLexicalStore` の両 adapter・
     `packages/testkit` の `lexical-store-conformance.ts`（境界値の適合テストを ANN 側と
     同じ形で追加する必要がある）へ波及し、**1 PR の射程を超える。** 上記「決めたこと3」の
     効率の負債（語彙チャンネルの over-fetch 窓が減衰済み候補に食われうる）を実測で無視
     できないと分かった場合、**将来採りうる案として残す。**

- **`restoreArchived` と忘却ゲートの相互作用（マネージャー決定。ゲートを既定 ON にしたこと
  自体が作った穴を、同じ ADR が引き受ける）**:

  **本 ADR の PR のレビューで見つかった設計上の穴**: `Runtime.sweepArchive` が
  `archived` にする選定条件は `decayFloorAt <= now` である
  （[ADR 0114](./0114-archive-sweep-for-decayed-memories.md)）。一方
  `Runtime.restoreArchived`（[ADR 0122](./0122-restore-archived-memory.md)）は
  `status` を `archived → active` へ戻すだけで、`decayFloorAt` には一切触れない
  （ADR 0122 決定4「`decay_floor_at` は動かさない」）。**⟹ `restoreArchived` の対象は、
  定義上すべて本 ADR の忘却ゲートが除く側（`decayFloorAt <= now`）に居る。**
  ⟹ **既定では、復帰させた Memory は `status=active` に戻っても recall に二度と
  現れない。**呼び出し側から見ると `restoreArchived` が `"restored"` と言うのに
  `recall()` が何も返さない、という形になる。**これは `docs/north-star.md`「目指す姿」の
  逐語「必要な場合だけ過去の記憶を再び呼び戻せる」と正面から食い違う**
  （`AGENTS.md`「正典と実装が食い違ったら、バグなのは実装のほう」）。
  **⟹ この穴を残したまま忘却ゲートを既定 ON で出すことはできない。**

  **決定**: `restoreArchived` は、`status` の復帰に成功した対象へ続けて
  `MemoryStore.reinforce(ctx, id, now)` を呼ぶ（`packages/core/src/runtime.ts` の
  `restoreArchived`）。**新しい interface・adapter は増やさない**——`reinforce` は
  既に契約された口である（`docs/memory-model.md` §7、[ADR 0041](./0041-reinforce-does-not-change-strength.md)・
  [ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md)。
  `packages/postgres/src/memory-store.ts` は `defaultDecayStrategy.floorAt({ recordedAt,
  lastReinforcedAt: at, strength, halfLifeHours })` で `decay_floor_at` を計算し直す）。

  **意味づけ**: 復帰させるという行為そのものが「この記憶がいま必要だ」という明示の信号
  であり、北極星が言う「**必要な場合だけ過去の記憶を再び呼び戻せる**」の「必要な場合」に
  当たる。⟹ そのときに減衰の起点を引き直すのは、新しい減衰戦略の発明ではなく、
  **既存の戦略（`defaultDecayStrategy`、`reinforce` が既に呼んでいるもの）を復帰の瞬間に
  適用するだけ**である。

  **ADR 0122 が「復帰は強化を兼ねるべきだ」を却下していたことの上書き**: ADR 0122
  決定4は、この設計（`restoreArchived` 自身が `reinforce` を代行する）を検討したうえで
  却下していた。理由は「復帰と強化は呼び出し側にとって別の意思決定である」
  「`reinforce?: boolean` のような分岐を将来足したくなる圧力を生む」の2点。**本 ADR は
  この判断を上書きする**——却下の前提（`decay_floor_at` を動かさなくても recall の既定
  挙動には影響しない）が、本 ADR 自身の決定（忘却ゲートを既定 ON にする）によって崩れた
  ため。ADR 0122 の本文は書き換えず、追記節でこの上書きを指す
  （[ADR 0122](./0122-restore-archived-memory.md) 追記節）。

  **⚠ ADR 0122 決定4 の却下理由は2つあったが、上書きしたのは片方だけである。**
  もう一方（「`decay_floor_at` の再計算式が2箇所に住むことになる。[ADR 0038](./0038-vector-hit-distance-is-cosine.md)
  が測った『実装が2つあると食い違う』穴を自分から作りにいくことになる」）は、
  **本 ADR の実装には当たらない**——`restoreArchived` は式を複製せず、
  **`MemoryStore.reinforce(ctx, id, at)` を呼ぶ**（`decay_floor_at` の再計算を持つ唯一の口。
  [ADR 0041](./0041-reinforce-does-not-change-strength.md) /
  [ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md)）。
  ⟹ 式は今も1箇所にしか住んでいない。**上書きしたのは「復帰と強化は別の意思決定である」
  という原則のほうだけであり、それは本 ADR がその前提を壊したからである。**

  **⭐ この上書きで何を落としたか**: **「強化せずに復帰させる」ことが、公開 API から
  表現できなくなった。**ADR 0122 の世界では、呼び出し側は `restoreArchived` だけを呼んで
  「status は戻すが、減衰の起点は動かさない」を選べた（続けて `reinforce` を呼ぶかどうかは
  呼び出し側の裁量だった）。**本 ADR の後は、復帰は常に強化を伴う。**この自由度を落とした
  理由は、忘却ゲートを既定 ON にした結果、その選択肢が
  **「復帰したと返るのに recall には二度と現れない」という黙った no-op にしかならなくなった**
  からである——選べる意味を失った選択肢を残すより、落とすほうが正直だと判断した。
  ⟹ **この自由度が再び必要になったとき（`RestoreArchivedOptions` に `reinforce?: boolean` を
  足したくなったとき）が、この決定が覆るときである。**⚠ ADR 0122 決定4 が
  「その分岐を足したくなる圧力を生む」と警告していたのは、まさにこの形である。

  **reinforce が失敗したときの扱い**: `status` の復帰は `reinforce` の前に既に成功して
  いるため、**`reinforce` が例外を投げても、その成功を握り潰さない**——
  `RestoreArchivedOutcome` の `kind` は `"restored"` のままとし、失敗は追加欄
  `reinforceError?: string` に運ぶ（additive。既存欄の意味は変えない）。**この repo の
  既存の作法（`setEmbeddingStatus` の `failed → ready` 巻き戻し防止、ADR 0048 の
  `reinforce` 自体の設計）に倣い、「元の成功を握り潰す新しい例外にすり替えない」**
  という原則を適用した——`restoreArchived` 自身の「競合以外の例外は打ち切って
  `not_attempted` にする」という既存の分岐（ADR 0122 決定）とは意図的に別の経路にした:
  あちらは「書き込みそのものが起きなかった」場合の安全弁だが、`reinforce` の失敗は
  「主たる書き込み（status の復帰）は成功したあとの、副次的な強化の失敗」であり、
  呼び出し側にとっての意味が違う（前者は「何も変わっていない」、後者は「復帰はしたが、
  忘却ゲートに再び阻まれるかもしれない」）。`reinforceError` を無視する呼び出し側は
  この PR 以前と同じ挙動になるだけであり、握り潰しではなく「見なくてもよい追加情報」
  として設計した。

  **歯**: `packages/core/src/__tests__/restore-archived.test.ts`。
  - 往復の歯を新しい挙動に合わせて書き換えた——ADR 0122 当時は「同じ `now` で
    `sweepArchive` を再度呼ぶと即座に再び `archived` になる」ことを固定していたが、
    今は逆（**再び `archived` にならない**）を固定する。
  - **⭐ 本 ADR が塞いだ穴そのものを検査する歯**: 復帰**前**は `includeFullyDecayed:
    true` が無いと recall に現れないが、復帰**後**は明示的な opt-out 無しで現れる。
    **この非対称そのものが、修正が効いていることの証拠になる**（マネージャー指示）。
  - `reinforce` が失敗しても `outcomes` の `kind` が `"restored"` のままで
    `reinforceError` にメッセージが入ること、後続の対象の処理が打ち切られないこと
    （「打ち切り」節の分岐とは別の規律であること）を専用の describe で固定した。
  - **変異試験**: `restoreArchived` 内の `reinforce` 呼び出しを取り除く変異を当てると、
    上記「塞いだ穴」の歯と「往復」の歯（2件）が赤くなることを確認し、退避コピー
    （`git checkout` は使わず、`cp` で取った一時コピー）から戻して緑に復帰することを
    確認した。

- **引き受けた負債**:

  1. **語彙チャンネルの over-fetch 窓（k'）が、減衰済みの候補に食われうる。**
     `LexicalStore.search` は decayFloorAtAfter を知らないまま `limit: kPrime` で呼ばれるため、
     減衰済みの候補が窓の一部を占め、まだ生きている候補が `lexical_truncated` で押し出される
     可能性がある。上記「検討した代替案」2番目が、この負債を消す将来の道である。
  2. **ANN の押し下げで落ちた分の件数は、この PR の後も原理的に分からないままである。**
     `omitted.filtered(condition:'decayed').countKind` は常に `'lower_bound'`——実際の
     除外件数はこれ以上でありうる。ADR 0011 が段1の候補生成一般について確立した限界の
     延長であり、この PR 固有の負債ではないが、明示しておく。
  3. **既存の呼び出し側の recall 結果が変わる。** 減衰しきった Memory が既定で候補から
     外れるため、これまでその Memory に依存していた呼び出し側は、明示的に
     `includeFullyDecayed: true` を渡さない限り挙動が変わる。破壊的変更として受け入れる
     （上記「決めたこと1」）。

- **これが覆るとしたら**:
  - **掃引（`status='archived'`）が常時走る運用が既定になったとき。** その場合、
    「掃引を呼んでいない期間」という本 ADR の存在理由そのものが縮む——ゲートを
    既定 OFF（opt-in）へ戻す、あるいはゲート自体を廃止して掃引だけに委ねる判断があり得る。
  - **語彙チャンネルが既定になったとき。** 現在は ANN 1本が既定であり
    （`DEFAULT_RECALL_CHANNELS`、[ADR 0084](./0084-lexical-recall-channel.md)）、
    上記「引き受けた負債」1番の効率の負債は既定挙動には現れない。語彙チャンネルが既定に
    昇格する将来、この負債が無視できない規模になっていたら、「検討した代替案」2番
    （`LexicalFilter` へ `decayFloorAtAfter` を足す）を実施する判断があり得る。

- **測ったこと（`examples/chat` のベンチへの影響）**:

  マネージャーの明示的な要求により、既定の想起挙動が変わるなら retrieval / compare の
  ベンチに影響が出るはずかどうかを検討した。

  **予想どおり、影響は出ない可能性が高いと判断した。** `retrieval-baseline.json` /
  `compare-baseline.json` が使うベンチの器（`examples/chat` のシードデータ、`cassettes/`
  の記録済み応答）は、直前に投入した新しい Memory を引く設計である。デフォルトの
  `halfLifeHours`（720h=30日、`buildNewMemoryFixture` の既定値。`packages/testkit/src/test-data.ts`）
  のもとでは、`decayFloorAt` は「作成時刻 + 約129日」に計算される
  （`defaultDecayStrategy.floorAt`: `strength=1`・`threshold=0.05` のとき
  `halfLifeHours × log2(1/0.05) ≈ halfLifeHours × 4.32`）。ベンチのシードとクエリの時刻差は
  それよりずっと短いと考えられるため、**この PR のゲートは1件も落とさず、ベンチの数字は
  動かない可能性が高い。**

  **【現物・追加確認】`retrieval.ts` / `compare.ts` は、時刻を過去へ動かす
  `MutableClock`（`examples/chat/src/mutable-clock.ts`）を一度も参照しない**
  （`grep -n "createMutableClock\|clock" examples/chat/src/retrieval*.ts examples/chat/src/compare.ts`
  が0件）。`MutableClock` を使い `recordedAt`/`decayFloorAt` の起点を意図的に過去へ振っているのは
  `time-term-arm.ts`（decay を freshness から分離して測る別のベンチ）と
  `archive-sweep-cost.ts`（掃引そのものを測る別のベンチ）であり、**どちらも
  `retrieval-baseline.json`/`compare-baseline.json` とは別の JSON・別の CI ジョブである。**
  ⟹ `retrieval`/`compare` は既定の壁時計（`systemClock`）でシードとクエリを同じ実行内に
  作るため、上の「予想」を裏付ける構造的な根拠がある。

  **⚠ この予想は、DB を要するベンチ（`retrieval` / `compare`）をこの環境
  （`DATABASE_URL` が無い）で実際に走らせて確かめたものではない。** 「確かめていないこと」
  節に明記する。**もし CI でベンチを回して数字が動いたことが分かったら、「効いていない」と
  結論せず、まず「この器には減衰しきった Memory が1件も無いため、この器ではゲートの効果を
  測れない」という前提が正しいかどうかを実測で確認すること。** 動いた場合は、その理由を
  書いたうえで基準値の扱いをマネージャーへ報告し、**基準値を担い手の裁量で更新しないこと。**

  **ゲートが実際に噛むことは、単体テスト（減衰しきった Memory を明示的に1件置いた状態）で
  示した**（`packages/core/src/__tests__/recall-decay-gate.test.ts`）。これが
  `docs/autonomy.md` §2 の「歯が実際に噛むことを変異試験で示した」の中身である——
  ゲートの述語（`memory.decayFloorAt > now` の押し下げ側・後置フィルタ側の両方）を
  個別に壊す変異を当て、両方とも関連する歯が赤くなり、戻すと緑に戻ることを確認した。

- **確かめていないこと**:
  - **DB を要する検査**（`packages/postgres` の `recall.postgres.test.ts` を含む DB テスト・
    `examples/chat` の `retrieval` / `compare` ベンチ）は、この環境に `DATABASE_URL` が無く
    docker も使えないため、**この PR の作業中には実行していない。** CI（service container を
    持つジョブ）で見届ける運用とする（`docs/autonomy.md` §1.1「測れないものは『測れなかった』
    と書く」）。
  - **`recall.postgres.test.ts` の EXPLAIN 検査**（「段1の ANN クエリは EXPLAIN で HNSW 索引を
    使う」）が、`decayFloorAtAfter` の条件が段1のクエリに常時加わった後も同じプランを選ぶかは、
    実測していない。`status = ANY(...)` は既にこの検査の対象クエリに含まれており
    （`recall-runtime.ts` は既定で常に `status: ["active","contested"]` を渡す）、
    `decay_floor_at > $n` も同じ形（等値/範囲比較を `JOIN ... WHERE` に足すだけ）の条件なので
    プランへの影響は同種だと考えられるが、**CI の実測でしか確認できない。**
  - **語彙チャンネルの over-fetch 窓が減衰済み候補にどの程度食われるか**の定量的な実測
    （上記「引き受けた負債」1番）は行っていない。語彙チャンネルは既定 OFF
    （`DEFAULT_RECALL_CHANNELS` は ANN のみ）なので、既定挙動には現れない負債である。

- **出所について**:
  オーナーが 2026-09-15 に、`docs/autonomy.md` §3 の⛔「公開 API の破壊的変更」の運用として
  提起された選択肢（複数案。うち「A」は「既定で有効にし、破壊的変更として引き受ける」という
  趣旨の案だった）に対し、逐語で次のように回答した:

  > **「Aでお願いします。北極星を目指し貴方が進めてください。」**

  本 ADR の「決めたこと1」（既定 opt-out・破壊的変更を引き受ける）は、この回答を根拠にしている。
  「決めたこと2」（件数を偽らない、`explain` に効いたことを出す）・「決めたこと3」
  （`LexicalFilter` を増やさず core の後置フィルタで揃える）は、オーナーの回答が示した方向
  （「北極星を目指し貴方が進めてください」）を受けて、マネージャーが `docs/north-star.md`
  「迷ったときの問い」に当てて設計側で決定したものである——上記「北極星の5つの問いに実際に
  当てた結果」の表がその適用の記録である。
