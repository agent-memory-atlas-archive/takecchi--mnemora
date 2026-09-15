# ADR 0144: ADR 0117 分類3の4値を union から落とす — `retrievedVia`/`reason`/`axis` の破壊的変更（Issue #206）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

**4値すべてを落とした。落とせなかったものは無い。**

`@mnemora/core` の以下の4値を、TypeScript の型と zod スキーマの両方から落とした
（[ADR 0117](./0117-unreachable-union-values-inventory.md) の分類3、Issue #206）:

| 値 | 旧宣言 | 新宣言 |
|---|---|---|
| `RecalledMemory.retrievedVia` の `"tag_match"` | `"ann" \| "lexical" \| "tag_match" \| "recency" \| "mandatory_companion"` | `"ann" \| "lexical" \| "mandatory_companion"` |
| `RecalledMemory.retrievedVia` の `"recency"` | 同上 | 同上 |
| `StageSkippedOmission.reason` の `"budget_exhausted"` | `"embedding_provider_unavailable" \| "empty_query_content" \| "budget_exhausted"` | `"embedding_provider_unavailable" \| "empty_query_content"` |
| `GroupCount.axis` の `"time_window"` | `"subject" \| "taxonomy" \| "time_window"` | `"subject" \| "taxonomy"` |

**壊れる人がどれだけ居るか（本リポジトリ内で実際に数えた件数）と、「外部の利用実態は
確認できない」は別の主張であり、下の「誰が壊れうるか」で段落を分けて書く。**

**分類1（`condition: "tenant"`）・分類2（`condition`/`axis: "taxonomy"`、
`kind: "purged"`/`"events_purged"`）は対象外であり、1バイトも変えていない。**

---

## §3 の手続きについて（オーナーの決定の記録）

`docs/autonomy.md` §3 の⛔表は「公開 API の破壊的変更」を「`0.x` なので semver 上は
許されるが、提起までにする。ADR を書き、実装は別 PR にして、承認を待つ」と定めている。
本 ADR が実装する変更（上の4値を union から落とす）はこの条項に該当する
——[ADR 0117](./0117-unreachable-union-values-inventory.md) 自身が、この4値について
「実装するか、落とすかを決める必要があるが、この作業者には決める権限が無い」と明記し、
提起だけに留めていた。

**出所の連鎖を分けて書く**（マネージャー経由で受領。以下は誰が・何を問われて・何と答え・
誰がどう解釈して援用したか、を分離して書く。この形は [ADR 0140](./0140-contested-write-side-companion-required.md)・
[ADR 0142](./0142-outbox-complete-fail-compare-and-swap.md) と同じである）:

1. **オーナー本人の発言**（マネージャー経由で受領。**私自身がオーナー本人に直接
   確認したものではない**）:

   > **ほとんど使われていない(v0.X.X)の段階なので破壊的変更であっても構わず実装してください**

   この発言は ADR 0140・ADR 0142 が引いたものと一字一句同じ文言である。**⚠ これは
   「オーナーが Issue #206 について問われて答えたもの」ではない。** 発言そのものは
   **`v0.x` という段階についての一般論**であり、特定の issue を名指しして下されたもの
   ではない。
2. **クローン（マネージャーの上位）が明示した射程**（マネージャー経由で受領、逐語）:

   > 効くのは `docs/autonomy.md` §3 の「公開 API の破壊的変更は承認を待つ」条項だけです。
   > ⛔ 他の ⛔ 条項には効きません。

   ⟹ **この発言の射程は「§3 の破壊的変更条項」という条項単位であり、「特定の PR
   （#233 や #260）1本」ではない。**
3. **マネージャーが、上記2の射程指定に基づいて本 Issue（#206）へ援用した。** 本 ADR の
   著者（担い手）はこの援用を受け取って実装した——**援用の判断自体はマネージャーが
   行ったものであり、著者が独自に「#206 にも当てはまるはずだ」と拡大解釈したものでは
   ない。**

**⟹ §3 の「公開 API の破壊的変更は提起までにする」条項は、この件については解けた
——ただし「オーナーが Issue #206 を承認した」という意味ではなく、「オーナーが述べた
`v0.x` 段階についての一般論を、その条項に対する一般的な判断としてクローンが明示し、
それをマネージャーが本 issue に援用した」という意味である。** この区別を消さずに書く。
**「気にせず実装してよい」は「記録しなくてよい」ではない**——以下の「誰が壊れうるか」
「移行の道」は、その記録として書く。

---

## 問い（Issue #206、ADR 0117 が残した分類3）

[ADR 0117](./0117-unreachable-union-values-inventory.md) は9件の「型に在って一度も
生成されない union の値」を棚卸しし、3分類した:

1. **意図的に発火しない**（`condition: "tenant"`）——残すのが正しい。
2. **後続 Phase 待ち**（`condition`/`axis: "taxonomy"` → Issue #201、
   `kind: "purged"`/`"events_purged"` → Issue #198）——この ADR では触らない。
3. **設計が消えたのに値だけ残った**（`retrievedVia: "tag_match"`/`"recency"`、
   `reason: "budget_exhausted"`、`axis: "time_window"`）——実装するか、union から
   落とすか（＝破壊的変更）を決める必要があるが、ADR 0117 の著者には決める権限が
   無かった。

**本 ADR は分類3だけを扱う。** 分類1・2 は ADR 0117 の決定のまま、1バイトも変えない。

---

## 現物で確認した — 宣言箇所（実施前）と、なぜ「実装する」ではなく「落とす」なのか

### 現物を自分で読んだ（出所: 私が実行した）

`packages/core/src/recall.ts` を自分で読み、実施前の4値の宣言箇所を確認した
（ADR 0117 の表と一致することを検算した）:

| 値 | 型宣言（実施前） | zod 宣言（実施前） |
|---|---|---|
| `retrievedVia: "tag_match"`/`"recency"` | `recall.ts:762` | `recall.ts:787` |
| `reason: "budget_exhausted"` | `recall.ts:33` | `recall.ts:247` |
| `axis: "time_window"` | `recall.ts:349` | `recall.ts:356` |

`git grep` で、これら4値がオブジェクトリテラル（`field: "value"` の形。union 型宣言を
除く）として構築されている箇所を、出荷対象パッケージ・テスト・`examples/chat` を含めた
**リポジトリ全体**で数え直した:

```
grep -rn '"tag_match"\|'"'"'tag_match'"'"'' --include=*.ts .   # → 0件（宣言・docコメントのみ）
grep -rn '"recency"\|'"'"'recency'"'"'' --include=*.ts .       # → 0件（同上）
grep -rn '"budget_exhausted"' --include=*.ts .                 # → 0件（同上）
grep -rn '"time_window"' --include=*.ts .                      # → 0件（同上）
```

**production・テスト・`examples/chat` のいずれにも、この4値をオブジェクトリテラルとして
構築している箇所は無かった。** `retrievedVia` を使う13ファイル（`recall-runtime.ts`・
各 `__tests__`・`examples/chat/src/format.ts` 等)を個別に確認したが、実際に代入されて
いるのは `"ann"`/`"lexical"`/`"mandatory_companion"` のみである
（`recall-runtime.ts` の内部型 `ScoredCandidate.retrievedVia` は、そもそも
`"ann" | "lexical" | "mandatory_companion"` というこの4値を含まない別の狭い型であり、
`"tag_match"`/`"recency"`/`"budget_exhausted"`/`"time_window"` を代入すると
元から型検査で落ちる）。

**`git log --all -S` で、リポジトリの全履歴を通してもこの4値が `recall-runtime.ts`・
`packages/postgres` に一度も書き込まれたことが無いことを確認した**（出所: 私が実行した）:

```
git log --all -S'"budget_exhausted"' --oneline -- packages/core/src/recall-runtime.ts packages/postgres/src  # → 0コミット
git log --all -S'"time_window"'      --oneline -- packages/core/src/recall-runtime.ts packages/postgres/src  # → 0コミット
git log --all -S'"tag_match"'        --oneline -- packages/core/src/recall-runtime.ts packages/postgres/src  # → 0コミット
git log --all -S'"recency"'          --oneline -- packages/core/src/recall-runtime.ts packages/postgres/src  # → 0コミット
```

**⟹ これは「いま拾えなかった」ではなく「このリポジトリの歴史上、一度も存在しなかった」
という、より強い主張である。**

### switch / 網羅性への影響（出所: 私が実行した）

```
grep -rn "switch (.*reason\|switch(.*reason\|switch (.*axis\|switch(.*axis\|switch (.*retrievedVia\|switch(.*retrievedVia" --include=*.ts .
```

ヒットは `examples/chat/src/providers.ts:238` の1件のみで、これは
`ProviderSourceDecision.reason`（`"key-present"`/`"no-key"`/`"forced"`）という**別の型**の
`switch` であり、本 ADR の対象と無関係であることを確認した。**`StageSkippedOmission.reason`・
`GroupCount.axis`・`RecalledMemory.retrievedVia` を網羅的に分岐する `switch` は
このリポジトリに1つも無い。**

### 永続化された `recalls` テーブルへの影響（出所: 私が実行した。`packages/postgres` を grep した）

`recalls` テーブル（`packages/postgres/src/schema.ts:108`）は `omitted`/`index_band` を
jsonb 列として持ち、`MemoryStore.createRecall`（`memory-store.ts:1080`）が書き込む。
`StageSkippedOmission`（`reason` を持つ）は `omitted` に、`GroupCount`（`axis` を持つ）は
`index_band` の中の `groups` に、理論上は乗りうる。

**ただし、このリポジトリには `recalls` を読み戻す口（`getRecall` 相当）が一つも無い**
（`grep -rn "createRecall\|getRecall\|FROM recalls" --include=*.ts .` で確認——
ヒットはすべて `createRecall`（書き込み）であり、読み戻しは0件）。**⟹ 現状、
`recalls.omitted`/`recalls.index_band` を zod でパースし直すコードパスがそもそも
存在しない**（`RecallResultSchema`/`OmissionSchema`/`GroupCountSchema` を使うのは
`recall-output-validation.ts` だけで、これは `recall()` が**その場で生成した**戻り値を
検証するのであって、DB から読み戻した過去のデータを検証するのではない）。

**`RecalledMemory`（`retrievedVia` を持つ）自体は `recalls` テーブルに一切乗らない**
——`NewRecallRecord` が持つのは `returnedMemoryIds: MemoryId[]`（uuid の配列）だけであり、
`RecalledMemory` オブジェクト全体をシリアライズしていない。

**⟹ 3つの独立した理由が重なって、既存データへの実害は無いと判断した**:

1. 該当4値を生成するコードが、このリポジトリの全履歴を通して一度も無かった
   （上の `git log -S` の結果）。⟹ この4値を含む `recalls` 行が実在した可能性は無い。
2. 仮に実在したとしても、それを読み戻して zod でパースし直すコードパスが今日
   存在しない。⟹ 実行時に例外を投げる経路が無い。
3. `retrievedVia` はそもそも永続化されていない。

**この判断は「持っている環境で実行して確かめた」ものではなく、コードを読んで導いた
論理である**——この作業環境には `DATABASE_URL` も docker も無く
（`which docker podman psql postgres initdb` は全部何も返さない）、実際の `recalls`
テーブルの中身を見て確認したわけではない（下記「確かめていないこと」）。

---

## なぜ「実装する」ではなく「落とす」なのか（4値それぞれ）

**[ADR 0084](./0084-lexical-recall-channel.md) は「実装を伴わない値をユニオンに置かない」
という方針を既に立てている**（§4.3。Issue #106 が提案した `"recent"` を、実装が無い
という理由で型にすら入れなかった）。この4値は、その方針より前に置かれた値であり、
方針に従えば落とすのが筋である。**ただし「方針に従う」だけでは各値について
「実装しない」と言ったことにならないため、以下は値ごとに個別の理由を書く。**

### `retrievedVia: "tag_match"`（候補生成チャンネルとしてのタグ一致）

`docs/recall.md` §2 はタグ一致を ANN・語彙と並ぶ**独立した候補生成チャンネル**の
一般形として触れているが、実装するには [ADR 0084](./0084-lexical-recall-channel.md)
が語彙チャンネルに対して行ったのと同じ水準の独立した設計・実測（§1〜§3・§9。
実際に `retrieval` ベンチで再現率・精度を測り、代替案を比較検討した）が要る。
加えて、タグは既に段2の再スコアで `tagMatch` として加点要素に参加しており
（[ADR 0081](./0081-similarity-is-the-only-term-that-ranks.md) が
`tagMatch` は候補集合の上で**厳密に1値**しか取らないことを実測済み)、候補生成側に
タグ一致チャンネルを足すと「スコアリングのタグ一致」と「候補生成のタグ一致」が
どう住み分けるかという設計判断が新たに生まれる。**これは
`docs/autonomy.md` §1.2 が要求する「何の数字が動くか・どう測るか・動かなかったら
どうするか」に、この PR の場で答えられる材料が無い**——答えるには独立した ADR と
実測が要り、1 PR = 1 ADR の原則を超える。**`docs/roadmap.md` の Phase 2/3/4 の
どの表にも、タグ一致チャンネルの実装は載っていない**——`taxonomy`（labels、
Issue #201）や `purged`（Issue #198）と違い、この値には対応する roadmap 項目も
issue も無い。

### `retrievedVia: "recency"`（候補生成チャンネルとしての直近取得）

同上の理由に加え、直近取得は既存の `decay`/`freshness`（[ADR 0004](./0004-decay-at-query-time.md)・
[ADR 0036](./0036-clamp-freshness-at-one.md)）と概念的に重なる——「直近のものを優先する」
機構は既にスコアリング側に存在する。独立した候補生成チャンネルとして足す意味
（スコアリングの重み調整では届かない候補を拾えるのか）を測るには、やはり
`retrieval` ベンチでの独立した実測が要る。**`docs/roadmap.md` に対応する項目は無い。**

### `reason: "budget_exhausted"`（`stage_skipped` の予算超過理由）

現在、予算超過の実際の落とし方は `BudgetDroppedOmission`（`kind: "budget_dropped"`。
候補が生成された**後**に予算で削る）であり、`stage_skipped`（段そのものを**走らせない**）
に予算超過の理由を足すには、「どの時点で残り予算を見て段全体をスキップするか」という、
今日どこにも実装されていないパイプライン制御の設計判断が要る。これは
`budget_dropped` との境界（いつ「段を走らせない」に倒し、いつ「走らせてから削る」に
倒すか）を新たに決める仕事であり、既存の `RecallBudget` の意味論を変えうる。
**`docs/roadmap.md` に対応する項目は無い。**

### `axis: "time_window"`（時間軸の群カウント）

`docs/roadmap.md` §3「Phase 1 で入れた土台が、後続フェーズをどう安くしているか」の
表は、`taxonomy`（labels・Phase 2・Issue #201）・`purged`（Phase 2/3）・
`valid_from`/`valid_until`（Phase 2）を名指ししているが、**`time_window` 軸は
Phase 2/3/4 のどの表にも一度も現れない。** つまり `taxonomy` 軸とは違い、
`time_window` には「いつ実装されるか」を指す roadmap 上の受け皿が無い。実装するには、
時間の窓の境界規則（[ADR 0039](./0039-period-boundary-conformance.md) が `period` に
ついて行ったのと同じ水準のタイムゾーン・境界の設計）を新たに決める必要があり、
これも独立した ADR の仕事である。

### ⟹ 4値とも「答えられない」ので、落とす

4値とも、**「なぜ実装しないか」に対する答え**は「今すぐ実装するには、この PR の範囲を
超える独立した設計・実測が要り、かつ roadmap 上の受け皿も無いから」で揃っている。
**答えに窮したものは無かった**——4値のうち一部だけを保留する理由も見つからなかった
ため、4値とも同じ扱い（落とす）にした。

---

## 誰が壊れうるか

### 本リポジトリ内で実際に数えた件数（私が実行した）

上の「現物で確認した」節のとおり:

- **production コード（`packages/*/src`、`__tests__` を除く）**: この4値を
  オブジェクトリテラルとして構築している箇所は **0件**。
- **テストコード（`__tests__`・`packages/testkit`・`examples/chat`）**: 同じく **0件**。
- **宣言箇所**（型 union・zod enum。構築ではない）: 4値 × 2箇所（型・zod）= 8箇所。
  すべて `packages/core/src/recall.ts` 内にあり、本 PR で更新済み。
- **doc コメントでの言及**（コード内、`unreachable-union-values.test.ts`
  のテーブル行）: 本 PR で該当箇所をすべて「落とした」ことを示す記述に更新済み
  （下記「決定」参照）。

**⟹ このリポジトリの中だけを見れば、本 PR は誰も壊さない**——壊す対象となる
呼び出し側コードが、production にもテストにも一つも存在しなかったため。

### 外部の利用実態（別段落・未検証であることを明記する）

**上の件数は、あくまで本リポジトリの中で私が数えたものである。** `@mnemora/core`
は npm に公開済みであり（`docs/autonomy.md`「いまの状態」）、この4値を含む
`RecalledMemory`/`StageSkippedOmission`/`GroupCount` 型を参照する外部のコードが、
たとえば次のような形で影響を受ける可能性を、本リポジトリから確認する手段は無い:

- `switch (m.retrievedVia)` で `"tag_match"`/`"recency"` を明示的に分岐している
  （型上は「網羅性の圧力を受け続けるだけで実際には来ない値」だったため、
  実装している可能性は低いと考えるが、確認はできない）。
- `RecalledMemory["retrievedVia"]` のような型演算で4値を含む union を
  他の型定義に取り込んでいる（TypeScript の型としては直ちにコンパイルエラーになる)。
- 独自の `.test.ts`/mock で、この4値をプレースホルダとして使ったフィクスチャを
  組んでいる（TypeScript の型としてコンパイルエラーになる、または
  `RecalledMemorySchema.parse()`/`OmissionSchema.parse()`/`GroupCountSchema.parse()`
  を呼んでいれば実行時にも失敗する)。

**「見つからなかった」は「居ない」の証拠ではない**——この点は測定ではなく、
確認できないことの明記である。

---

## 移行の道

呼び出し側が壊れうる経路は、実質的に2つに絞られる:

1. **型レベル**（コンパイル時）: この4値を明示的に参照する型演算・`switch` の
   `case` 節・`Record<..., X>` のようなマップ型を持つコードは、`@mnemora/core` を
   更新すると TypeScript のコンパイルが失敗する。**移行**: 該当する `case`/型演算を
   削除する。値そのものが「来ない」ことは ADR 0117 の時点で doc コメントに明記して
   あったため、これらの分岐は元から到達不能なデッドコードだったはずである。
2. **実行時**（zod）: `RecalledMemorySchema`/`StageSkippedOmissionSchema`/
   `GroupCountSchema`（いずれも export はしていないが `RecallResultSchema` 経由で
   間接的に使われる）に、この4値を含むデータを渡して `.parse()`/`.safeParse()` を
   呼んでいるコードは、今後この4値については失敗するようになる。**移行**: 上の
   「誰が壊れうるか」で述べたとおり、**このリポジトリ自身が生成するデータには
   この4値が一度も含まれない**（全履歴で確認済み）。⟹ **mnemora 自身が書き込んだ
   `recalls` テーブルの既存データが、この変更でパース不能になることは無い。**
   外部で独自に構築したテストフィクスチャがこの4値を使っていた場合のみ、
   そのフィクスチャ側を更新する必要がある。

**v0.x は永遠には続かず、`1.0` が近づいたとき「どこを壊してきたか」の記録が
移行の資料になる。** 記録が無ければ、そのとき誰も追えない。上の「誰が壊れうるか」
「移行の道」は、その記録として書いた。

---

## 決定

### 1. `packages/core/src/recall.ts` の型と zod スキーマを狭める

上の「結論」の表のとおり。`satisfies z.ZodType<T>` が型とスキーマの対応を
コンパイル時に強制しているため、**型とスキーマの両方を同時に狭める必要があった**
（片方だけ狭めると `satisfies` が失敗する。下記「測ったこと」の変異試験で実際に
確認した）。

### 2. 各値の宣言直上の doc コメントを、「オーナー判断待ち」から「落とした」に更新した

ADR 0117 が足した「実装するか、`@mnemora/core` の公開 API 破壊的変更として落とすかは
オーナー判断待ち」という doc コメントを、「2026-09-16 に落とした（本 ADR で実施）」
という記述に置き換えた。

### 3. `unreachable-union-values.test.ts` から該当4エントリを外した

`UNREACHABLE_VALUES` から4値のエントリを削除し、`classification` 型からも
使われなくなった `"3: 設計が消えた（オーナー判断待ち）"` の選択肢を外した。
残り4件（分類1の `condition: "tenant"`、分類2の `condition`/`axis: "taxonomy"`・
`kind: "events_purged"`）は1バイトも変えていない。**歯を丸ごとは消していない**
——分類1・2の値はまだ union に残っているため、歯自体は引き続き必要である。
冒頭の doc コメントに、ADR 0124（`"purged"` を外した前例）と同じ形で
「2026-09-16 追記」を足した。

### 4. `docs/recall.md` の埋め込み型スニペットを3箇所更新した

`docs/recall.md` は `Omission`/`GroupCount`/`RecalledMemory` の TypeScript 型を
prose の中に ```ts スニペットとして複製している(§4「Omission.kind の一覧」・
§5「型」・§7「スコア内訳と説明」)。**これは「ついでに直した」のではなく、本 PR が
変更した型そのものの複製である**——変更後もそのまま残すと、複製が実装より広い
union を示したまま古びる。3箇所とも4値を外し、それぞれに「2026-09-16 追記」の
注記と本 ADR への参照を足した。

**副産物**: §7 の `RecalledMemory` スニペットは、この追記の前から `'lexical'`
（[ADR 0084](./0084-lexical-recall-channel.md) で実装済み）を欠いたまま放置
されていた——本 PR がこの箇所を触るついでに直した。これは本 ADR の主題
（4値を落とす）とは別の、既存のドキュメント欠落の修正である。

`docs/recall.md` §3「Phase 1 の範囲」の「`time_window` 軸は型として持つが Phase 1 で
既定にはしない」という一文も、「当時型として持っていたが…型からも落とした」という
過去形に直した(歴史的な記述そのものは書き換えず、その場に注記を足す形——
ADR 0072/0064 の追記の慣行に倣う)。

### 5. ADR 0117 に追記した

ADR 0117 の「これが覆るとしたら」節が「分類3についてオーナーが『落とす』と決めた
とき——別 PR で union を縮め、この ADR に『承認日・実施 PR』を追記する」と
予告していたとおり、本文は書き換えず、冒頭に「⚠ 追記（2026-09-16、Issue #206
分類3の決着）」を足した(ADR 0072 の「初版に穴が1つ在った」節・ADR 0064 の
「約2.5倍」の訂正と同じ、既存 ADR への追記という慣行——[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)
が「採用済みの結論を訂正する場面では、状態欄を変えず本文に追記節を足すのが慣行」
と明記している)。**状態欄は変更した**——ADR 0117 の状態欄はもともと「分類3は
オーナー判断待ち」という**未決着**を明示していたため、決着後もそのままにすると
実態と食い違う。ADR 0088 が言う「訂正」（本文の記述の誤りを直す）とは違い、
ADR 0117 の状態欄は最初から「この ADR が完結していない」ことを示す運用上の
欄だったため、決着を反映させた。

**新 ADR から指すだけにせず、ADR 0117 側にも追記した理由**: ADR 0117 自身が
「これが覆るとしたら」で自分自身への追記を予告していたため、その予告に従うのが
最も驚きが少ない。ADR 0117 だけを読む将来の読者が、分類3の決着を見つけられなく
なることも避けられる。

---

## 開いている穴（塞げなかった・塞がなかった入口を明記する）

1. **サードパーティの実装・フィクスチャには、型システム上の強制力はあるが
   実測はできていない。** `@mnemora/core` を消費する外部のコードがこの4値を
   使っていた場合、型チェックまたは zod パースで初めて気づくことになる
   （上の「移行の道」参照）。ADR 0140/0142 が挙げた同じ限界。
2. **`satisfies z.ZodType<T>` による型とスキーマの対応チェックは非対称である。**
   変異試験で確認した(下記「測ったこと」)——**zod スキーマだけを元の広い union に
   戻すと `satisfies` がコンパイルエラーで検知する**が、**逆に TypeScript の型
   union だけを元の広い形に戻す(zod は狭いまま)と、`satisfies` を含むどの門も
   検知しない。** 後者の回帰は `unreachable-union-values.test.ts` の対象からも
   外れている(あの歯は「値のオブジェクトリテラル構築」だけを見ており、型宣言
   そのものの広さは見ていない——これは新しい欠陥ではなく、あの歯が元から
   持っていた設計上の限界である)。
3. **この4値が再び必要になったとき、同じ文字列で「実装が先にあって型を足す」形に
   戻すのか、別の名前にするのかは決めていない。** ADR 0084 の決定(「新しく足す値を、
   同じ形にしないこと」)に従うなら、実装を伴わせて足す限り同じ名前で構わないはず
   だが、この判断は実装 PR 側で行うべきであり、本 ADR は再追加の設計を決めない。

---

## 検討した代替案

### 4値とも実装する

**採らない。** 上の「なぜ『実装する』ではなく『落とす』なのか」で値ごとに理由を
書いた——4値とも、独立した設計・実測(`docs/autonomy.md` §1.2 の3問に答えられる
材料)が無く、roadmap 上の受け皿も無い。1 PR = 1 ADR の原則を超える。

### ADR 0117 のまま(doc コメントのみで型は変えない)を維持する

**採らない。** ADR 0117 が「オーナー判断待ち」としていた分類3の決着そのものが
本 ADR の主題であり、オーナーの判断(§3参照)が既に出ている以上、「決めない」を
維持する理由が無い。

### 4値のうち一部だけを落とす

**採らない。** 「なぜ『実装する』ではなく『落とす』なのか」で4値とも同じ形の
理由(独立した設計・実測が要る、roadmap 上の受け皿が無い)で揃ったため、
一部だけを残す技術的な根拠が無かった。

### `RecalledMemorySchema`/`OmissionSchema`/`GroupCountSchema` を非 export のまま
### `RecallResultSchema` から分離する

**検討したが採らない。** 現状の構造(内部の各 Schema は非 export、
`RecallResultSchema` だけが export される)は本 ADR の変更と無関係であり、
1 PR = 1 ADR の原則から外れる。

---

## これが覆るとしたら

- **オーナーが `"tag_match"`/`"recency"`(タグ一致・直近取得チャンネル)を
  実装すると決めたとき**——[ADR 0084](./0084-lexical-recall-channel.md) が
  語彙チャンネルに対して行ったのと同じ水準の独立した ADR・実測が要る。
  同じ文字列を復活させるか別名にするかは、その ADR が決める。
- **オーナーが `"budget_exhausted"`(予算超過による段スキップ)を実装すると
  決めたとき**——`budget_dropped` との境界を決める独立した設計が要る。
- **オーナーが `"time_window"`(時間軸の群カウント)を実装すると決めたとき**——
  `docs/roadmap.md` の Phase 2/3/4 のいずれかに項目として載ってから着手するのが
  筋である(今は載っていない)。
- **サードパーティの実装者から、この破壊的変更で壊れたという報告が実際に
  来たとき**——移行ガイドの追記や、次のマイナー版での注記が要るかもしれない。
- **`satisfies z.ZodType<T>` の非対称性(開いている穴2)が、型 union だけを
  広げる別の回帰を見逃したとき**——`unreachable-union-values.test.ts` の
  検出範囲を「型宣言の広さ」まで広げる設計が要るかもしれない。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**無関係。** 本 ADR は型定義の整理であり、recall が毎回渡す量には影響しない。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** この4値を生成するコードは元から無かったため、正しく動いている
呼び出し側には一切影響しない。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** `retrievedVia`/`reason`/`axis` の可能な値が狭まるだけで、
実際に返る値・trace の中身は1バイトも変わらない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。**

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** 型定義とスキーマの変更だけで完結する。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。**

- `pnpm --filter @mnemora/core run typecheck` → 緑。ルートの `pnpm run typecheck`
  (全7 workspace projects: core/testkit/openai/postgres/anthropic/local-embedding/
  examples-chat)も緑。
- `pnpm run lint`(eslint、リポジトリ全体) → 緑。
- `pnpm run format:check`(prettier、リポジトリ全体) → 緑。
- `rm -rf packages/*/dist && pnpm run build` → 全7 projects 緑。
- `pnpm run pack:check` → 緑(6パッケージとも publish 梱包の検査を通過)。
- `pnpm run test`(ルート) → root 941 passed + 2 skipped(943)/ `@mnemora/core`
  44 files・624 tests 緑(`unreachable-union-values.test.ts` は 8→4 tests に減った)/
  `@mnemora/testkit` 260 緑 / `@mnemora/openai` 43 passed + 11 skipped /
  `@mnemora/anthropic` 49 passed + 2 skipped / `@mnemora/local-embedding`
  83 passed + 15 skipped。**`packages/postgres` と `examples/chat` の DB テストは
  実行していない**(`DATABASE_URL` 未設定。「DB テストは実行していません」と
  明示的に告知されることを確認した。ADR 0015 の通り、これは「DB 側を見ていない」
  であって「全部通った」ではない)。

### 変異試験(`packages/core` は DB を要さないため、実際に実行した)

**手順**: 変異の前に `packages/core/src/recall.ts`・
`packages/core/src/__tests__/unreachable-union-values.test.ts` を
`/tmp/mnemora-backup-206/` へ退避コピーしてから、その場でコードを直接書き換えて
赤を確認し、退避コピーから `cp` で戻して緑を確認した(`git checkout` は
使っていない——`docs/autonomy.md` §4 が指摘する「未コミットの編集も消える」穴を
踏まないため)。

- **M1(zod だけを元の広い union に戻す)**: `StageSkippedOmissionSchema.reason` の
  `z.enum([...])` に `"budget_exhausted"` を書き戻し、TS の型は狭いままにした →
  `pnpm --filter @mnemora/core run typecheck` が **赤くなった**
  (`TS1360: ... does not satisfy the expected type 'ZodType<StageSkippedOmission, ...>'`。
  `recall.ts:248` の `StageSkippedOmissionSchema` と `recall.ts:1072` の
  `RecallResultSchema` の2箇所で検出)。`cp` で復元後、緑に戻ることを確認した。
  同じ変異を `GroupCountSchema.axis` に `"time_window"` を書き戻す形でも実行し、
  同じ形(`recall.ts:441`・`recall.ts:1072`)で赤くなることを確認した。
- **M2(型 union だけを元の広い形に戻す。zod は狭いまま)**: `RecalledMemory.retrievedVia`
  の型に `"tag_match"` を書き戻し、zod は狭いままにした →
  **`pnpm --filter @mnemora/core run typecheck`・ルートの `pnpm run typecheck`・
  `unreachable-union-values.test.ts`(4 tests)のいずれも赤くならなかった。**
  これは新しい欠陥ではなく、`satisfies z.ZodType<T>` という検査機構と
  `unreachable-union-values.test.ts` という歯の両方が、元から「型宣言だけが
  広がる」方向の回帰を検出する設計になっていないことを示す(上記「開いている穴」
  2番に記録)。`cp` で復元後、緑に戻ることを確認した。

いずれの変異も、`git diff --stat`/`git status --short` で変異が実際に入ったこと・
`cp` での復元後に差分が変異前の状態(この PR がコミットしたい変更のみ)に戻って
いることを確認したうえで、該当パッケージのテストスイート・typecheck が
元通りの結果になることを確認した。

---

## 確かめていないこと

- **`packages/postgres` の DB を伴うテスト全体。** この作業環境には `DATABASE_URL`
  も docker も無い(`which docker podman psql postgres initdb` は全部何も返さない、
  実測)。Issue #247 / alteroid #965 / alteroid #1015 の族として既知の構造的な穴。
  本 ADR は `packages/postgres` のコード自体を変更していない(`recall.ts` は
  `packages/core` のみ)ため、影響は無いはずだと判断しているが、この判断自体を
  DB の実行結果で裏取りしてはいない。
- **`recalls` テーブルの実際の中身。** 「移行の道」節の判断(この4値を含む行は
  実在しない)は、コードを読んで導いた論理(全履歴での `git log -S`・読み戻し口の
  不在)であり、実際の本番 DB の中身を見て確認したものではない——そもそも
  この作業環境にそのような DB は無い。
- **外部実装者への実際の影響。** 提起した通り、本リポジトリからは確認できない。
- **CI 全体の緑。** この PR を出した後、`node scripts/ci-green-check.mjs --pr <番号>`
  で確認する(下記、報告参照)。
- **`retrieval` ベンチへの影響。** 本 ADR は候補生成・スコアリングのロジックを
  一切変えていない(型定義のみ)ため、影響は無いはずだが、`retrieval` ベンチを
  回して確認してはいない。
