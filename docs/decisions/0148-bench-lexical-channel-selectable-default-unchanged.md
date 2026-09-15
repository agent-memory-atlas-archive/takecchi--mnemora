# ADR 0148: `examples/chat` の `Runtime` に `LexicalStore` を配線する — ただし既定構成は変えず、語彙チャンネルは「選べるもの」として足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0108 / ADR 0092 / ADR 0121 / ADR 0133 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — マネージャーから実測条件・判断・訂正を報告として受け取り、この ADR の
  作業者自身は再導出していない。
- **【CI 実測】** — 本物の PostgreSQL に対する歯だが、この作業環境には `DATABASE_URL` も
  docker も無いため、CI の実行結果でのみ確かめられる。PR 本文に CI の結果が追記される。

---

## 文脈

**Issue #179**（PR #178 / [ADR 0108](./0108-retrieval-bench-does-not-exercise-lexical-channel.md)
が切り出した製品の判断）。ADR 0108 が実測した通り、`examples/chat` の `retrieval` ベンチは
**語彙チャンネルを一度も通っていない**——`examples/chat/src/` に `channels` を渡す箇所・
`LexicalStore` を配線する箇所がどちらも0件で、`packages/core` の
`DEFAULT_RECALL_CHANNELS`（`["ann"]`）だけで recall している。

Issue 本文は「配線する／しない」を製品の判断として明示的に着手者へ委ねており、
**「配線すると過去の `hit@1`（`retrieval-baseline.json`: `hit1Count: 4 / probeCount: 7`、
`provenance.commit: 0a71a57`）と比較できなくなる」ことを代償として名指ししている**【現物、
issue #179 本文】。

### 🔴 issue のコメント（2026-09-13、takecchi）による訂正 — 必ず踏まえること

issue 本文は3実装(postgres / `InMemoryLexicalStore` / `FakeLexicalStore`)が日本語 probe で
0件になる理由を「postgres は非ASCIIを落とすから＝言語そのものが原因」と書いていたが、
**issue のコメントがこれを訂正した**【受】:

> 🔴 **「非 ASCII を落とす」は独立した原因ではなく、トークン境界から導かれた設計判断です。**
> …⟹ **日本語を語彙チャンネルで引くには、分かち書き（トークナイザ）の側を変える必要が
> あります**（それは別の、はるかに大きい決定です）。

この ADR の作業者は `packages/postgres/migrations/0008_memories_lexical_index.sql` を
自分で読み【現物】、コメントが実際に次のように書いていることを確認した(逐語):

> 根拠: **日本語の語は本文側でも文ごと1トークンになるため、そもそも引けない**
> （ADR 0084 §2 の実測）。⟹ クエリに残しても真陽性を1件も生まず、AND で偽陰性だけを作る。
> **落とすことで失うものが無い。**

**⟹ 非ASCII除去は、本文側のトークン境界（日本語が文ごと1トークンになる）という
先行する設計判断の帰結であり、独立した原因ではない。**
**⟹ この ADR は「クエリ側の正規表現を直せば日本語も引ける」という選択肢を勘定に入れない。**
（⚠ この ADR の作業者は ADR 0084 §2 の実測そのものは読み直していない——issue のコメントが
引いている出典を、出典として引いただけである。issue のコメント自身もその限界を明記している。）

---

## 決めたこと

### 決定1: 配線する。ただし既定の構成は `["ann"]` のまま据え置く

`examples/chat/src/runtime-factory.ts` の `createExampleRuntime()` が組み立てる `Runtime`
に、`PostgresLexicalStore`（`@mnemora/postgres`）を常に `lexicalStore` として渡す。

**これは「配線する／しない」の二択ではなく「配線するが既定は変えない」という第三の選択で
ある。**`packages/core` の `recall()` は `RecallQuery.channels` に `"lexical"` を**明示的に
含めたとき**だけ `lexicalStore` を呼ぶ——`channels` を渡さない既存の呼び出しは
`DEFAULT_RECALL_CHANNELS`（`["ann"]`）のままで、**配線そのものは既定の挙動を1バイトも
変えない**。これは `RecallQuery.channels` 自身の doc とテスト
（`packages/core/src/__tests__/recall-channels.test.ts`）が保証する契約であり、
`packages/core` は一切変更していない。

**得るもの**: [ADR 0092](./0092-lexical-or-coverage.md)（クエリ語彙を OR で結び
`lexicalMatch` を被覆率にする）の効果が、**このベンチで初めて測れる経路**が生まれる。
ADR 0108 が実測した通り、いまは 210行すべてで `score.lexicalMatch` の欄そのものが存在せず、
**一度も測られていない。**

**失わないもの**: **既定の構成が変わらないので、`retrieval-baseline.json` との比較可能性は
保たれる。**issue 本文が代償として名指しした「配線すると過去の `hit@1` と比較できなく
なる」を、既定を動かさないことで払わずに済ませる。

### 決定2: 語彙構成を「選べるもの」として足す — `MNEMORA_BENCH_CHANNELS`

`runRetrievalQualityArm`（`examples/chat/src/retrieval-quality.ts`）の
`RunRetrievalQualityArmOptions` に、省略可能な `channels?: readonly RecallChannel[]` を
足した。省略時は `recall()` に `channels` を渡さず、`packages/core` 自身の既定に委ねる
——既存の呼び出し（`cli.ts` の `runRetrieval()`／`recordRetrieval()`）はこの欄を渡さない
限り1バイトも挙動が変わらない。

`cli.ts` の `runRetrieval()`（`pnpm --filter @mnemora/example-chat run retrieval` の実体）に、
環境変数 `MNEMORA_BENCH_CHANNELS`（カンマ区切り。例: `MNEMORA_BENCH_CHANNELS=ann,lexical`）を
読むパース関数 `parseBenchChannels`（`retrieval-quality.ts`、純関数）を配線した。
未指定・空文字なら `undefined`（既定構成）、`RECALL_CHANNELS`（`packages/core` の唯一の
出所）に無い値が混ざっていれば例外にする——`providers.ts` の `parseModeOverride` と同じ
「黙って無視しない」作法。

`ArmReport`/`RetrievalQualityArmJson`（機械可読出力、省略可能欄として追加。
`schemaVersion` は上げていない——ADR 0108 が確立した「既存欄の意味を変えない追加は
`schemaVersion` を上げない」規律をそのまま踏襲する）に、その arm が実際に使った
`channels` を運ばせる——ADR 0088 §4「数字を条件から離さない」の適用。

### 決定3: 語彙構成で測った数字を、既定の基準値ファイルに混ぜない

`retrieval-baseline.json` は**書き換えていない**。語彙構成（`MNEMORA_BENCH_CHANNELS`）で
測った数字は、コンソール出力・機械可読 JSON の `channels` 欄という**報告**に留め、
**門にしない**。

**門にするかどうかを「まず揺れるかどうかを実測してから」決めるのがこの repo の作法**
（[ADR 0133](./0133-compare-baseline-and-gate.md)）。この ADR はその実測ができていない
——`retrieval` ベンチは `DATABASE_URL`（本物の Postgres + pgvector）を要求し、この作業環境
には無い（下記「確かめていないこと」）。**揺れを実測できないまま門にする案は採らない**
——ADR 0133 が issue #242 の前提（`compare` は decay/freshness が揺れるはず）を鵜呑みにせず
実測してから決めた、その裏返しの適用である。実測せずに「揺れないはず」と決めて門にすれば、
確かめていないことを事実の顔で書くことになる。

### 決定4: CI に語彙構成の非門ジョブは足さない — follow-up として明記する

CI で `MNEMORA_BENCH_CHANNELS=ann,lexical` を走らせるジョブを足すかは、マネージャーの指示で
作業者の裁量に委ねられている。**この ADR では足さない。**

理由: (a) 現行の probe 7件（`examples/chat/src/probe-set.ts`）はすべて日本語の自然文であり、
ADR 0108 の測定B・本 ADR の測定（下記）が示す通り、語彙構成で走らせても
`lexicalMatchRows` は 0 のままで、**新しいジョブを足しても何も測れない**（空の非門警告を
毎回出すだけになる）。(b) probe を ASCII の識別子・自然文へ拡張するには実 API 鍵での
カセット録り直しが要り、この ADR の範囲外（ADR 0092/0108 が置いていった課題そのもの）。
**⟹ 迷ったら足さず follow-up に書く、という指示に従った。**follow-up は下記
「これが覆るとしたら」と「引き受けた負債」に明記する。

---

## 北極星の5つの問いに当てた結果

- **問い1（毎回渡す量を減らす方向か）**: 語彙チャンネルは埋め込みを増やさずに候補を作る
  経路であり（ADR 0084 §3.4／ADR 0092 の設計そのもの）、**測れるようにすること自体は
  量を増やさない**。既定構成が変わらないため、既定利用者が渡す量も1バイトも変わらない。
- **問い2（無効にしても Memory Framework として成立するか）**: 既定が `["ann"]` のまま
  ——**語彙チャンネルを無効にした構成が既定であり続ける＝成立する。**`RuntimeDeps.lexicalStore`
  自体が省略可能な欄であり続けている（`packages/core` は変更していない）ことも同じ主張を
  補強する。
- **問い3（選ばれた理由を後から説明できるか）**: `score.lexicalMatch` の欄が(選んだ構成
  でのみ)出ることで、**語彙チャンネルが引き当てたかどうかが初めて説明可能になる**——
  ADR 0108 以前は、この欄が一度も現れない以上、語彙チャンネルの寄与を「無かった」とすら
  言えなかった(測っていないから)。
- **問い5（LLM を呼ばずに済ませられないか）**: 語彙チャンネルはまさにその答えである
  ——列と索引（`tsvector`/GIN）で候補を作る経路であり、モデルを呼ばない。

（問い4は本 ADR の変更に当たらない——AI の推論とユーザーの事実の区別に触れる変更を
含まない。）

---

## 測定 — この ADR の作業者が自分の手で確かめたこと

**⚠ `retrieval` ベンチ自体はこの作業環境で実行できない**（`DATABASE_URL` も docker も無い。
下記「確かめていないこと」）。**以下は、その制約の中で実際に走らせられたものだけである。**

### 【実測】pure 関数群（`parseBenchChannels`／`ArmReport.channels`／JSON への
`channels` 転記）は、手元の非 DB テスト(`pnpm run test`。`vitest run` の枝)で緑
——941件、DB を要さない範囲全件。

### 【実測】変異試験 — 足した歯が実際に噛むことを、手元で実行できる範囲で示した

- `parseBenchChannels` の検証(`RECALL_CHANNELS` に無い値を拒む分岐)を無効化する変異を
  入れたところ、`examples/chat/src/__tests__/parse-bench-channels.test.ts` の
  「RECALL_CHANNELS に無い値が混ざっていたら例外」が実際に赤くなった。退避コピーから
  復元し、緑に戻ったことを確認した。
- `buildRetrievalQualityJson` の `channels: report.channels` を `channels: undefined` に
  差し替える変異を入れたところ、`examples/chat/src/__tests__/retrieval-json.test.ts` の
  「arm が実際に使った channels を運ぶ」が実際に赤くなった。同様に復元して緑に戻ったことを
  確認した。
- **⚠ `runtime-factory.ts` の `lexicalStore` 配線・`examples/chat/src/__tests__
  /retrieval-quality.postgres.test.ts` に足した3本の歯（下記）は、DB を要求するため
  この作業環境では変異試験を実行できていない。**CI の実行結果でのみ確かめられる
  （【CI 実測】、下記「確かめていないこと」）。

### 【現物】足した3本の DB 歯(`retrieval-quality.postgres.test.ts`)の設計根拠

PR #178（ADR 0108）が入れた**向きを反転させた歯**（「既定構成では `score.lexicalMatch`
欄が1行も現れない」ことを固定する歯）は、**消さず・緩めず、そのまま残した**。射程を
「既定構成では語彙チャンネルを通らない」に限定して残す、という指示どおりである。

その上で、語彙構成では通ることを示す歯を2本、伝播を示す歯を1本、新たに足した:

1. **`channels:["ann","lexical"]` を明示し、ASCII クエリ(`"TypeScript"`、ADR 0108
   測定Bと同種の入力)を投げると `score.lexicalMatch` 欄が現れる**——`examples/chat` の
   `Runtime` に `LexicalStore` が実際に配線されていることを、既存の日本語 probe を経由
   せずに直接示す。**日本語 probe を使わない理由**: 上記「issue のコメントによる訂正」の
   通り、日本語の自然文クエリは語彙構成でも段1で0件のままであり(トークン境界が原因)、
   これは配線の欠陥ではない。ASCII クエリを使うことで、配線そのものの検査と
   probe/トークナイザの限界を混同しない。
2. **`runRetrievalQualityArm` に `channels:["lexical"]`(`"ann"` を含めない)を渡すと、
   日本語 probe 7件はどれも候補0件になる**——`options.channels` が実際に `recall()` まで
   届いていることの間接証拠。ANN チャンネルを落とした状態で候補が0件になることは、
   `channels` オプションが握り潰されずに転送されている場合にのみ起きる(握り潰されて
   既定 `["ann"]` のまま recall していれば、候補は普通に返ってしまう)。

これで、既定構成・語彙構成のどちらにも主張を持つ歯が揃った——ADR 0108 の歯が「既定では
通らない」を、新設の2本が「明示すれば通る・オプションが実際に届く」を、それぞれ固定する。

---

## 検討した代替案

- **配線しない(issue が示したもう一方の選択肢)。** **採らない。**ADR 0092 の効果を
  測る経路が永久に生まれない。マネージャーの判断として、比較可能性の連続性を保ちながら
  経路だけを開く「第三の道」を採った。
- **既定を語彙込み(`["ann","lexical"]`)に切り替え、基準値を取り直す。** **採らない。**
  取り直せば語彙を既定で測れるが、`0a71a57` 以降の `retrieval-baseline.json` の連続性を
  失う。基準値ファイルは北極星の物差しの継続計測の土台であり、ここを一度切ると過去の
  全数字が比較不能になる——**基準値の連続性のほうが、いま語彙の退行を捕まえることより
  価値が高いと判断した。**
- **probe 集合に ASCII の識別子・自然文を足し、語彙チャンネルの効果を実際に測れるように
  する。** **この ADR では採らない。**新しい `observe()` の入力を足すことになり、その
  埋め込みは `examples/chat/cassettes/retrieval.json` の記録に無い——記録に無い入力は
  例外になる([ADR 0051](./0051-recorded-provider-cassette.md))。実 API 鍵での録り直しが
  要り、この ADR の作業者は鍵を持っていない。ADR 0092/0108 が置いていった課題であり、
  マネージャーの指示の範囲外でもある(follow-up として残す)。
- **クエリ側の正規表現(`mnemora_lexical_query_terms`)を直し、非ASCIIを落とさないようにする。**
  **採らない。**issue のコメントが訂正した通り、非ASCII除去は独立した原因ではなく
  本文側のトークン境界(日本語が文ごと1トークンになる)の帰結であり、**この手は何も
  生まない**(migration 自身が「落とすことで失うものが無い」と実測で書いている)。日本語を
  語彙チャンネルで引くには分かち書き(トークナイザ)の側を変える必要があり、それは
  はるかに大きい別の決定である。
- **`retrieval-quality` ジョブ(またはそれに準ずる新ジョブ)を、語彙構成の数字で門にする。**
  **採らない。**ADR 0133 の作法(まず揺れるかどうかを実測してから決める)に従い、
  この ADR は揺れを実測できていない(DB が無い)。実測せずに「揺れないはず」で門を作れば、
  確かめていないことを事実の顔で書くことになる。
- **CI に語彙構成を走らせる非門ジョブを足す。** **この ADR では採らない**(決定4)。
  現行 probe が全件日本語である以上、足しても `lexicalMatchRows=0` の空の警告を出すだけで、
  何も新しく測れない。probe が ASCII を含むようになってから足すほうが意味を持つ
  ——follow-up として残す。

---

## 引き受けた負債

- **🔴 既定のベンチ(`retrieval-baseline.json` と比較される既定実行)は、配線後も語彙
  チャンネルを通らないままである。**⟹ **語彙チャンネルの退行は、既定の歯では捕まらない。**
  「配線したのに既定では測っていない」状態を、意図して引き受ける。理由は決定1の通り
  ——基準値の連続性のほうが、いま語彙の退行を捕まえることより価値が高いと判断したため。
- **🔴 「配線する」と「差の出る probe を持つ」は別の問題であり、この ADR は後者を解かない
  (issue #179 本文の逐語通り)。** probe 集合(`examples/chat/src/probe-set.ts`)は
  依然として全件日本語の自然文であり、語彙構成を選んでも `hit@1`/MRR は動かない
  ——これは配線の欠陥ではなく、ASCII probe が無いことの反映である。probe を足すには
  実 API 鍵でのカセット録り直しが要る。**⟹ follow-up issue が必要**(下記)。
- **postgres 実装・`InMemoryLexicalStore` のどちらも、日本語をトークン境界の理由で
  引けないままである。** issue のコメントが訂正した通り、これは正規表現の修正では
  直らず、分かち書き(トークナイザ)を変える、はるかに大きい別の決定が要る
  ——本 ADR の範囲外。
- **CI に語彙構成を走らせるジョブを足していない**(決定4)。probe が ASCII を含むように
  なるまでは、足しても新しい情報を生まないと判断した。
- **`MNEMORA_BENCH_CHANNELS` を CI から使う配線(`.github/workflows/ci.yml`)は無い。**
  手動実行(`MNEMORA_BENCH_CHANNELS=ann,lexical pnpm --filter @mnemora/example-chat run
  retrieval`)でのみ選べる。CI 配線は決定4と同じ理由で見送った。

### follow-up として残すこと(次に拾う人へ)

1. **probe 集合に ASCII の識別子・自然文を足す**(実 API 鍵が要る)。これができて
   初めて、語彙構成での `hit@1`/MRR が意味のある数字になる。
2. **1 が着地したら、`MNEMORA_BENCH_CHANNELS=ann,lexical` を走らせる非門ジョブを CI に
   足すかどうかを再検討する。**
3. **日本語の分かち書き対応**(postgres 実装・`InMemoryLexicalStore` の両方)。
   ADR 0084 §11 / ADR 0092「これが覆るとしたら」が既に同じ条件を挙げている——
   本 ADR はそれを繰り返すだけで、新しい着手はしない。

---

## これが覆るとしたら

- **probe 集合に ASCII の識別子・自然文が足されたとき。** 語彙構成での `hit@1`/MRR が
  初めて意味を持つ数字になり、`MNEMORA_BENCH_CHANNELS` を CI の非門ジョブに配線する
  判断を再検討できる。
- **日本語の分かち書き対応が入ったとき。** 既定構成を語彙込みに切り替える判断——
  ひいては基準値を取り直す判断——を再検討する材料になる。
- **語彙チャンネルの退行が実運用で実害を出したとき。** 「既定では測っていない」ことの
  代償が顕在化する——この ADR の決定1の前提(基準値の連続性のほうが価値が高い)を
  問い直す材料になる。

---

## 確かめていないこと

- 🔴 **`retrieval` ベンチそのものは、この作業環境で一度も実行していない。**
  `DATABASE_URL`(本物の Postgres + pgvector)も docker も無く、`retrieval` は起動時に
  例外になる(`docs/autonomy.md` §1.1 が明記する既知の制約)。**⟹ 新設した3本の DB 歯
  (`retrieval-quality.postgres.test.ts`)が実際に CI で緑になるかは、【CI 実測】でしか
  確かめられない。** PR の CI 結果を参照すること。
- **`MNEMORA_BENCH_CHANNELS=ann,lexical` で `retrieval` を実際に走らせた出力(コンソール・
  JSON とも)は、一度も見ていない。** 配線のコード(`runtime-factory.ts`/`cli.ts`/
  `retrieval-quality.ts`)を読んで正しいと判断したものであり、実行結果ではない。
- **語彙構成で `hit@1`/MRR が実際にどう動くかは測っていない**(そもそも probe が全件
  日本語である以上、動かないと予想しているが、それも実測ではなく ADR 0108 測定Bからの
  推論である)。
- **issue のコメントが指摘した「非ASCII除去はトークン境界の帰結」という主張の根拠
  (ADR 0084 §2 の実測)そのものは、この ADR の作業者は読み直していない。** issue の
  コメントが引いている出典を出典として引いただけである(【受】)。この ADR の作業者が
  独自に確かめたのは、`packages/postgres/migrations/0008_memories_lexical_index.sql` の
  コメントが issue のコメントの主張と字句どおり一致することだけである(【現物】)。
- **CI に語彙構成の非門ジョブを足すかどうかの判断(決定4)は、probe 集合が変わったときに
  再度問い直す前提の、暫定の判断である。**
