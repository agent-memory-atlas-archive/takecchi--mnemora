# ADR 0108: `retrieval` ベンチは語彙チャンネルを一度も通していない — ADR 0092 の効果はまだ一度も測られていない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-13

**⚠ 各主張の出所を分ける**（[ADR 0092](./0092-lexical-or-coverage.md) /
[ADR 0081](./0081-similarity-is-the-only-term-that-ranks.md) /
[ADR 0088](./0088-retrieval-quality-measured-in-ci.md) の体裁を踏む）。

- **【実測】** — この ADR の作業体が実際に走らせて測った。
- **【CI 実測】** — 本物の PostgreSQL に対する歯だが、CI の実行結果でのみ確かめられる。
  PR 本文に CI の結果が追記される。
- **【現物】** — この repo のコード・文書を読んで確かめた（`git log -L` / `git show --stat`
  を含む）。
- **【受】** — マネージャーから実測条件・結果を報告として受け取り、この ADR の作業体自身は
  再導出していない（ADR 0084/0088 の【実測・委】と同じ断り。以下の「測定A」「測定B」の
  数値そのものがこれに当たる）。

---

## 文脈

**[ADR 0092](./0092-lexical-or-coverage.md)** はクエリ語彙を OR で結び、`lexicalMatch` を
被覆率 `(0, 1]` にした。その「確かめていないこと」節は、こう書いている（逐語）:

> 🔴 **`retrieval` ベンチ（MRR / `hit@1` / `hit@10`）への影響は「測っていない」のではなく
> 「測れない」。**

理由は2段——(1) `examples/chat` の `Runtime` に `lexicalStore` が配線されていない、
(2) probe 7件がすべて日本語の自然文で、語彙チャンネルが効きうる入力が0件——であり、
**ADR 0092 は「差の出る probe を足せばよい」で閉じずに、そこを次の課題として置いていった。**

**本 ADR は、その置き土産を実測で埋め直した記録である。**やったことは実装ではなく計測——
「本当に1行も通っていないのか」「通っていないなら、日本語の入力はどこで・なぜ落ちるのか」
を、3つの独立した `LexicalStore` 実装それぞれについて、実際に確かめた。

---

## 決めたこと

1. **測定A・測定B（下記）の結果を、この ADR に記録する。**
2. **`examples/chat` の retrieval ベンチに、②「向きを反転させた歯」を1本足す**
   （`examples/chat/src/__tests__/retrieval-quality.postgres.test.ts`）。「いま赤く、
   直ったら緑」の歯ではなく、**「いま緑で、前提が黙って変わったら赤」**の歯——測る対象は
   語彙チャンネルの欠陥ではなく、**ベンチの構成そのもの**（`channels` を渡していないこと）
   である。
3. **`examples/chat` のベンチに、各 arm が実際に返した行のうち `lexicalMatch` 欄を持つ
   行数（`lexicalMatchRows`）と、返った行の総数（`recalledRows`）を数えさせ、
   `MNEMORA_RETRIEVAL_JSON` の出力に**省略可能な欄**として載せる（`retrieval-json.ts`）。
4. **`scripts/retrieval-quality-summary-lib.mjs` に、`lexicalMatchRows === 0` のとき
   非門の警告ブロックを Job Summary へ足す**（`retrieval-quality` ジョブは非門のまま。
   `.github/workflows/ci.yml` のこのジョブ自身が「基準値ファイルと相違しても exit 0
   のままである」「このスクリプトは門ではない」と明記している場に相乗りする）。
5. **`packages/core/src/strategies/scoring.ts` の `ScoringInput.lexicalMatch` の古い
   doc（「現在の実装では常に 1 である」）を、被覆率 `(0, 1]` の記述へ直す**（コメントのみ。
   後述「④ 古くなったコメントを直す」）。

### ⚠ 決めていないこと

- **probe 集合を増やすかどうか。**ADR 0092 が置いていった課題そのものであり、本 ADR も
  そこへは手を伸ばさない（マネージャーの範囲指定）。
- **基準値ファイル（`examples/chat/retrieval-baseline.json`）を取り直すかどうか。**
  本 ADR は「取り直されていない」ことを指摘するだけで、取り直しは実施しない
  （下記「引き受けた負債」）。

---

## 測定A: 本物の PostgreSQL + カセット再生 — 210行すべてで `lexicalMatch` 欄が存在しない

**【受】**

```
env -u OPENAI_API_KEY MNEMORA_PROVIDER_SOURCE=recorded \
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5544/mnemora_ci \
  pnpm --filter @mnemora/example-chat run retrieval
```

| 何 | 値 |
|---|---|
| DB | PostgreSQL **17.11** + pgvector **0.8.6**（`server_encoding=UTF8`） |
| provider | `recorded`（記録した実 API 応答の再生。鍵は使っていない） |
| arm 数 × probe 数 × limit | **3 arm × 7 probe × 10行 = 210行** |

**結果**: **210行すべてで `score.lexicalMatch` は欄そのものが存在しない（`undefined`）。**
🔴 **「値が0」ではない。**そもそも `ScoreBreakdown` に `lexicalMatch` キーが無い
——語彙チャンネルが**一度も通っていない**ことの直接証拠である。

**arm B**（擬似LLM+本物の埋め込み）は `MRR=0.714 / hit@1=4/7 / hit@10=6/7` であり、
`examples/chat/retrieval-baseline.json` の基準値に**完全一致した**。

### 【現物】原因

- `packages/core/src/recall.ts` の `DEFAULT_RECALL_CHANNELS = ["ann"]`
  （`export const DEFAULT_RECALL_CHANNELS: readonly RecallChannel[] = ["ann"];`）。
- `examples/chat/src/` に `channels` を渡している箇所は **0件**。
- `examples/chat/src` 全体を `grep -rn "lexicalStore\|LexicalStore"` した結果は **0件**
  ——`examples/chat` の `Runtime` に `LexicalStore` を配線している箇所が無い。

**⟹ 語彙チャンネルは、このベンチの構成では一度も通っていない。**

---

## 測定B: DB不要、`channels:["lexical"]` を直接渡す — 欄自体は生きている

**【受】**

`lexicalMatch` の欄そのものは死んでいない——`packages/core`/`packages/testkit` の
recall pipeline に `channels: ["lexical"]` を直接渡すと値が付く。

| クエリ | 値 |
|---|---|
| `TypeScript`（単一の識別子） | `1.0` |
| `what did we say about TypeScript`（英語の自然文） | `1/6 = 1.66666666666666657e-1` |
| probe 7件（日本語の自然文、`examples/chat/src/probe-set.ts` そのまま） | **すべて段1で候補0件** |

### ⭐ 3実装で0件になる理由が別である【現物】

**日本語 probe が0件になる、という結論は3実装で共通だが、その内訳は3通りに分かれる。
「日本語だから引けない」という一枚岩の理由ではない。**

1. **postgres 実装**: `mnemora_lexical_query_terms` が
   `regexp_replace($1, '[^[:ascii:]]+', ' ', 'g')`
   （`packages/postgres/migrations/0008_memories_lexical_index.sql` 63〜64行目）で
   **非ASCIIを問答無用で落とす。** ⟹ 日本語単語1つ（例: `猫`）だけのクエリでも、
   語彙化した時点で空になり、必ず0件になる。**言語そのものが原因。**
2. **`InMemoryLexicalStore`**（`packages/testkit/src/__fixtures__/in-memory-lexical-store.ts`
   45〜48行目、`tokenize()`）: `split(/[^\p{L}\p{N}]+/u)` であり、非ASCIIは**落とさない**。
   しかし**日本語に分かち書き（単語間の空白）が無い**ため、本文もクエリも文が丸ごと
   1トークンになりやすく、`猫` という短い語は本文側のトークンと一致しない
   ⟹ 0件。**トークン境界の設計が原因**であり、非ASCIIを落とす実装ではない。
3. **`FakeLexicalStore`**（`packages/core/src/__tests__/runtime-fakes.ts` 966行目、
   `memory.content.includes(t)`）: **部分文字列一致**なので、本文に `猫` という文字列が
   含まれてさえいれば `coverage=1.0` で**引ける**。しかし probe のクエリは自然文の
   言い換え（「わたしの好きな色を覚えていますか」等）であり、gold の本文と語彙を
   一切共有しないため0件になる。**敗因は「日本語」ではなく「言い換え」であり、
   この実装に限れば ASCII の自然文で同じクエリを投げても同じ理由で0件になる。**

**⟹ 「日本語が引けない」という結論だけを見て3実装を同じ根で語ると、直す場所を間違える。**
postgres 実装を直す変更（非ASCII を落とさない）は、②③の負債には無関係である。

---

## 🔴 ADR 0092 の変更は、この計測系では `hit@1` に一切影響しえない

**測定Aが示した通り、`examples/chat` の retrieval ベンチは `channels` に `"lexical"` を
一度も渡していない。**`lexicalMatch` が候補の `score` に現れない以上、
`affinity = max(similarity, lexicalMatch)` の `max` は常に `similarity ?? 1` に退化する
（`packages/core/src/strategies/scoring.ts` の `scoreWithDefaultStrategy`）。
**⟹ ADR 0092 が変えたのは `lexicalMatch` の値の作り方（AND→OR、二値→被覆率）であり、
その値がベンチの `total` に一度も参加していない以上、`hit@1`/`hit@10`/MRR のいずれも
1ビットも動かしようがない。**

**⟹ 逆に言えば、ADR 0092 の効果はまだ一度も測られていない。**
ADR 0092 自身の「確かめていないこと」節が「測れない」と書いた通りであり、
本 ADR はそれを覆していない——**「測れない」という結論そのものを実測で裏付けた**、
というのがここでの立ち位置である。

### ⛔ これは「ADR 0092 が無意味だった」という意味ではない

**計測系が使っていないだけであり、本番の構成（呼び出し側が `channels` に `"lexical"` を
含め、`LexicalStore` を配線した構成）では効きうる。** 測定Bが実測した通り、
ASCII のクエリでは `lexicalMatch` は実際に値を取る（`TypeScript` → `1.0`、
`what did we say about TypeScript` → `1/6`）。**「効く条件で使われていない」ことと
「効かない」ことは別の主張であり、本 ADR は前者だけを述べる。**

---

## `retrieval-baseline.json` の基準値は #124（ADR 0092）より前のものである

**【現物】**`examples/chat/retrieval-baseline.json` の `provenance.commit` は

```
0a71a572d57049384d771c2fb6507f5b5046790b
```

であり、これは `git log --oneline -- packages/core/src/strategies/scoring.ts` で
確認できる通り **PR #115（ADR 0084、「recall に語彙候補生成チャンネルを足す」）** の
マージコミットである。

**一方 ADR 0092 は PR #124（`251e4d7`）で着地しており、`git show --stat 251e4d7` で
確認すると `packages/core/src/recall.ts` を37行変更しているが、`scoring.ts` はもちろん、
基準値ファイルにも触れていない。**

**⟹ `retrieval-baseline.json` は、#124（ADR 0092）より前の値のまま、一度も取り直されて
いない。** 上記の通り ADR 0092 はこの計測系の `hit@1` に構造上影響しえないため、
この事実自体は「基準値が古くて危険」という意味ではないが、**「ADR 0092 の後に基準値を
検証した」と読むのは誤りである**、という点だけは記録しておく。

---

## 🔴 `scoring.ts` の `lexicalMatch` doc が「常に1」のまま古くなっていたこと

**【現物】**`packages/core/src/strategies/scoring.ts` の `ScoringInput.lexicalMatch` の
doc は、この ADR 以前はこう書かれていた（逐語）:

```
   * 語彙チャンネルが引き当てた場合のみ渡す（ADR 0084）。
   * **現在の実装では常に 1 である**——理由と、それが順位に何を意味するかは
   * `ScoreBreakdown.lexicalMatch`（`recall.ts`）の doc に書いてある。
```

`git log -L` で確認すると、この行を書いたのは **PR #115（ADR 0084）** であり、
**PR #124（ADR 0092）は `scoring.ts` を1バイトも触っていない**
（`git show --stat 251e4d7` に `scoring.ts` が現れない）。一方 `recall.ts` 側の
`ScoreBreakdown.lexicalMatch` の doc は #124 で被覆率の記述に更新済みである。

**⟹ 「常に1」は古く、かつ「理由は `recall.ts` に書いてある」という相互参照先が
被覆率の話をしているのに、参照元は二値のままだった**——事実上、参照元と参照先が
矛盾した状態のまま残っていた。本 ADR の作業の一部として、**コメントだけ**を
`(0, 1]` の被覆率を取る旨に直した（`scoring.ts` の実装コードは1バイトも変えていない。
`git diff` で確認済み）。

---

## ① 非門ジョブへの可視化 — `lexicalMatchRows` / `recalledRows`

`.github/workflows/ci.yml` の `retrieval-quality` ジョブは、ジョブ自身のコメントが
「🔴 基準値ファイルと相違しても exit 0 のままである」「このスクリプトは門ではない」と
明記した非門の場である（[ADR 0088](./0088-retrieval-quality-measured-in-ci.md)）。
**そこに可視化を足す。⛔ 門にはしない（exit 0 を保つ）。**

1. `examples/chat` のベンチ（`runRetrievalQualityArm`、`examples/chat/src/retrieval-quality.ts`）
   が、probe ごとに `result.memories.length`（`recalledRows`）と
   `result.memories.filter((m) => m.score.lexicalMatch !== undefined).length`
   （`lexicalMatchRows`）を実測し、`armHeadline()` が arm 単位の総和として集計する。
2. `examples/chat/src/retrieval-json.ts` の `RetrievalQualityArmJson` に
   `lexicalMatchRows?: number` / `recalledRows?: number` を**省略可能欄**として足す。
3. `scripts/retrieval-quality-summary-lib.mjs` に `buildLexicalChannelWarningSection()`
   を足し、`lexicalMatchRows === 0` の arm があれば Job Summary に警告ブロックを出す。
   欄自体が無い（この PR 以前の古い実測 JSON）ときは何も警告しない
   ——「測っていない」を「0だった」と偽らない（`docs/architecture.md` 等が繰り返す
   「無いには種類がある」の適用）。**exit code には一切触れない。**

### なぜ省略可能欄にしたか（`schemaVersion` を上げない判断）

`RetrievalQualityRunJson.schemaVersion` は `1` のリテラル型であり、doc に
「この形が変わったら上げる」と明記されている。**今回の変更は既存の欄の意味・型を
一切変えず、新しい欄を足すだけの後方互換な追加**であり、`validateMeasured`/
`validateBaseline`（`retrieval-quality-summary-lib.mjs`）は `REQUIRED_ARM_*_FIELDS`
に列挙された欄だけを見る（列挙されていない欄が増えても減っても検査に影響しない）。
**⟹ 既存の `examples/chat/retrieval-baseline.json`（この欄を持たない）は、今回の
変更後もそのまま `--baseline` として通る**（`diffArm` の `DIFF_FIELDS` にも
新欄を含めていないため、比較対象にもならない）。この2点を歯で固定した
（`retrieval-quality-summary-lib.test.mjs` の追加分）。**⟹ `schemaVersion` を
上げる理由が無い。**

---

## ② 向きを反転させた歯

「いま赤く、直ったら緑」ではなく **「いま緑で、前提が黙って変わったら赤」**。
測る対象は欠陥ではなく**ベンチの構成そのもの**——「`examples/chat` のベンチは `channels`
を渡しておらず既定 `["ann"]` のみで recall しており、`LexicalStore` は配線されていない」
という事実である。

**置き場**: `examples/chat/src/__tests__/retrieval-quality.postgres.test.ts`
（既存の `runRetrievalQualityArm` を実際に走らせている歯に相乗りする——grep 的な
静的検査ではなく、実際の DB・実際の `recall()` に対する挙動を測る）。

**歯の中身**: `runRetrievalQualityArm` を実行し、全 probe の `recalledRows` の総和が
0より大きい（＝この歯自体は何かを測れている）ことを確かめたうえで、
`lexicalMatchRows` の総和が **0 であること**を assert する。

**失敗メッセージ**（読む人がコードを読まずに赤の意味が分かるように、逐語でこう書いた）:

> この歯が赤いのは、欠陥が入ったからではない。ベンチマークが語彙チャンネルを使う構成に
> 変わった、という意味である（examples/chat の Runtime に LexicalStore が配線された、
> または runRetrievalQualityArm が recall() へ channels:['ann','lexical'] 等を渡すように
> なった）。⟹ 意図した変更なら、この歯を更新したうえで hit@1 を測り直すこと（それが
> この歯の目的である。ADR 0108）。⛔ 歯を消すだけにしないこと。

---

## ④ 古くなったコメントを直す（コメントのみ）

上述の通り、`packages/core/src/strategies/scoring.ts` の `ScoringInput.lexicalMatch` の
doc を「常に1」から `(0, 1]` の被覆率を取る旨に直した。**実装コードは1バイトも
変えていない**（`git diff -- packages/core/src/strategies/scoring.ts` はコメント行の
差分のみであることを確認済み）。

---

## 検討した代替案

- **probe 集合に ASCII の識別子・自然文を足し、語彙チャンネルの効果を測れるようにする。**
  **この ADR では採らない。**新しい `observe()` の入力を足すことになり、その埋め込みは
  `examples/chat/cassettes/retrieval.json` の記録に無い——記録に無い入力は例外になる
  （[ADR 0051](./0051-recorded-provider-cassette.md)）。実 API 鍵での録り直しが要り、
  この ADR の作業体は鍵を持っていない。ADR 0092 が置いていった課題であり、
  マネージャーの指示の範囲外でもある。
- **`examples/chat` の `Runtime` に `LexicalStore` を配線し、`channels` を
  `["ann", "lexical"]` にする。** **この ADR では採らない。**配線自体は数行で足せるが
  （ADR 0092 自身がそう指摘している）、probe が日本語の自然文である限り、測定Bが示した
  通り3実装いずれでも段1で0件のままであり、`hit@1` は動かない。**配線だけを先に入れると、
  「対応した」という誤った印象を作る**——本 ADR は「まだ何も変えていない」ことを
  正確に伝える非門の警告と、構成が変わったことを検知する歯を先に置く。
- **`retrieval-quality` ジョブを門にし、`lexicalMatchRows === 0` で落とす。**
  **採らない。**[ADR 0088](./0088-retrieval-quality-measured-in-ci.md) がこのジョブを
  非門にした理由（`decay`/`freshness` の実行間の揺れ、probe 7件という標本の小ささ）は
  本 ADR の変更とは独立に成り立っており、この1点だけを理由に門を作る根拠にはならない。
  **かわりに②の歯（`examples/chat` の DB 歯）を「構成が変わったら赤くなる」形にした**
  ——ジョブとしては非門のまま、歯としては赤くなる、という分担にした。
- **`retrieval-baseline.json` をこの PR で取り直す。** **採らない。**基準値ファイルの
  `_readme` が「CI のジョブがこのファイルを更新することはない（意図的な手作業のみ）」と
  明記しており、この PR は ADR 0092 の効果を実際に有効化する変更を含んでいないため、
  取り直しても数字は動かない（動かないことを確認するだけの実行になる）。

---

## 引き受けた負債

- **`retrieval-baseline.json` は #124（ADR 0092）より前の値のままである。**本 ADR は
  その事実を記録するだけで、取り直していない。**⟹ 語彙チャンネルを実際に配線し、
  probe を足す変更が入ったときには、必ず基準値を取り直すこと**（②の歯がその引き金になる
  ——歯が赤くなったら、それが合図である）。
- **測定Bの具体的な数値（`TypeScript` → `1.0`、`what did we say about TypeScript` →
  `1/6`）は、この ADR の作業体が再導出していない。**マネージャーから受け取った実測を
  そのまま記録した（【受】)。**この ADR が独自に確かめたのは、3実装のコード（正規表現・
  トークン化関数・部分文字列一致）が、マネージャーの主張と字句どおり一致することだけ**
  である（上記「【現物】原因」節）。
- **日本語の分かち書きの欠如（`InMemoryLexicalStore`）、非ASCII除去（postgres）という
  2つの負債は、本 ADR では直さない。**ADR 0092 自身が「マネージャーの指示により、
  この PR には混ぜない」と明記した線を、本 ADR も踏襲する。
- **`FakeLexicalStore` の「言い換えでは引けない」という負債は、`packages/core` の
  単体テスト用フェイクの性質であり、本番の語彙チャンネルの性能を代表しない。**
  postgres 実装（`websearch_to_tsquery` 経由）は部分文字列一致ではなく tsvector の
  語彙一致であり、性質が異なる。混同しないこと。

---

## これが覆るとしたら

- **`examples/chat` の `Runtime` に `LexicalStore` が配線され、`channels` に
  `"lexical"` が足されたとき。** ②の歯が赤くなる——それが「対応が必要になった」の合図
  であり、そのとき `hit@1` を測り直し、`retrieval-baseline.json` を取り直す。
- **probe 集合に ASCII の識別子・自然文が足されたとき。**測定Bの「段1で0件」という
  結論は、現行の probe 7件（すべて日本語の自然文）に対するものであり、probe が変われば
  再測定が要る。
- **postgres 実装の非ASCII除去、または `InMemoryLexicalStore` の分かち書き対応が
  入ったとき。**測定Bの「3実装で理由が別」という切り分けの前提が変わる。

---

## 確かめていないこと

- **測定A・測定Bの生の実行ログは、この ADR の作業体の手元に無い。**マネージャーから
  条件と結果を受け取った（【受】）。この ADR が独自に確かめたのは、その主張と現在の
  コード（`recall.ts`/`scoring.ts`/`0008_memories_lexical_index.sql`/
  `in-memory-lexical-store.ts`/`runtime-fakes.ts`/`retrieval-baseline.json`/git 履歴）
  との整合であり、再実行ではない。
- **本 ADR が足した②の歯自体を、実際に CI（本物の PostgreSQL）で緑にできるかは
  【CI 実測】でしか確かめられない。** PR の CI 結果を参照すること。

---

## 追記 (2026-09-16): Issue #179 が「配線するかどうか」を決め、[ADR 0148](./0148-bench-lexical-channel-selectable-default-unchanged.md) に着地した

**⚠ 状態欄は書き換えていない。**この repo に「採用済みの ADR を覆った」と示す書式が無い
ため（ADR 0022 §追記／ADR 0088 §5 と同じ扱い）。**本 ADR の決定そのものは今も有効である**
——「②の歯」（既定構成では `score.lexicalMatch` 欄が1行も現れない）はそのまま残っている。
**変わったのは「④ 検討した代替案」の一部である。**

上の「④ 検討した代替案」は「`examples/chat` の `Runtime` に `LexicalStore` を配線し、
`channels` を `["ann","lexical"]` にする」を**この ADR では採らない**と書いていたが、
これは「配線するかどうか」自体を先送りした表現であり、[Issue #179](https://github.com/takecchi/mnemora/issues/179)
がその製品の判断を引き取った。**結論は「配線する。ただし既定の構成は変えず、語彙チャンネル
は選べるものとして足す」**（ADR 0148）——「配線しない」でも「既定を語彙込みに切り替える」
でもない第三の道である。**⟹ ②の歯（既定構成の主張）は覆らない。ADR 0148 はむしろこの歯を
「既定構成でも語彙構成でも、どちらも主張を持つ」形へ2本足して補強している。**
