# ADR 0229: 全文経路と記憶経路の最終回答を、正解集合を持つ器で比較する（品質の主張はまだしない、Issue #506 / 親 #498）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0146 / ADR 0210 と同じ体裁）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — 書き手が自分の手で走らせて確かめた。
- **【受】** — 報告・判断として受け取り、自分では再導出していない。

---

## 文脈

`examples/chat` には既に2つの器がある——`compare.ts`（全文経路と記憶経路が**焼く量**を
測る）と `retrieval-quality.ts`（**想起の順位**を、正解集合を持つ probe set で測る）。
どちらも「**最終的な回答文そのもの**を、全文経路と記憶経路で並べて比較する」ことはしない
——`compare.ts` が見るのは冒頭の事実が `recall().memories` に残っているかという1点
（`factStatementSurvived`）であり、`retrieval-quality.ts` が見るのは `recall()` の順位
であって、**LLM が実際に何と答えたか**ではない。

Issue #506（親 #498）は、「同じ会話・同じ質問・同じ回答モデル・同じ採点基準で、
naive（全文経路）と mnemora（記憶経路）の**最終回答**を対で出す」器を求めている。
本 ADR はその器（`answer` サブコマンド、`examples/chat/src/answer-*.ts`）の設計判断を
記録する。

## ⭐ これは何であって、何でないか

⭕ **である**: 同じ会話・同じ質問・同じ回答モデル・同じ採点基準で、全文経路と記憶経路の
最終回答と入力量を対で出す器を足す。

⛔ **ではない**: **回答品質の測定。** 本 PR が着地しても回答品質は未評価のままである。

## 決めたこと

### 1. 線は provider の層には引かない。測定器が正解集合を持つかどうかに引く

**逐語**【現物】—— [ADR 0146](./0146-compare-quality-claim-reason-replaced.md)
決定1:

> **線は provider の層（`deterministic`/`recorded`/`openai`/`local`）には引かない。
> 測定器（bench）が正解集合を持つかどうかに引く。**

`answer` ベンチは `answer-case.ts`/`answer-case-set.*.ts` に**明示的な正解集合**
（`AnswerCase.expected`/`AnswerCase.grounds`）を持つ——`compare.ts` とは違う種類の器で
ある。⟹ **だからこの器は明示的な正解集合を持つ**。`AnswerGrounds` は「実装の出力から
正解を作る経路」を型の上で塞ぐ（`turnIndex`/`rationale` は会話の文面に対する説明であって、
実装の挙動の説明ではない）。

### 2. 初弾は門にせず観測口にする——偽陽性率に上限を置けると実測していない

**逐語**【現物】—— [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定3:

> **門（落とす検査）にしてよいのは、偽陽性率に上限を置けると実測できたものだけである。
> 置けないなら門にしない。**

`gradeAnswer`（一次判定、文字列の包含判定）の偽陽性・偽陰性率は測っていない。
⟹ **だから初弾は門にせず観測口にした**——`answer` サブコマンドは CI の必須ジョブに
接続していない（`.github/workflows/ci.yml` は変更していない。CI 接続は Issue #497 の
範囲）。`process.exitCode` を左右する assertion も持たない。

### 3. `deterministic` での実行に品質を主張させない機械的な仕掛けを置く

`answerQualityClaimable(llmMode)`（`answer-case.ts`）が `llmMode === "deterministic"` の
ときだけ `false` を返す。`false` のとき:

- `answer-format.ts` の Markdown 表は正誤の列を `—` にし、脚注で理由を書く。
- `answer-json.ts` の `buildAnswerJson` は `qualityClaimable: false` を入れ、
  `summary`（何件中何件 pass の集計）を出力に含めない。
- `cli.ts` の `runAnswer()` は stdout の先頭で
  「⛔⛔⛔ これは配線の検査であり、回答品質は測っていない（llmMode=deterministic）⛔⛔⛔」
  を出す。

この分岐は単体試験（`__tests__/answer-case.test.ts` の `answerQualityClaimable`）と
配線検査（`__tests__/answer-bench.postgres.test.ts` の最後の it）の両方で固定してある。
**実際に `answerQualityClaimable` の判定を壊すと赤くなることを実測した**（`return true` へ
書き換えて両方の歯が赤くなることを確認し、`cp` で退避したファイルへ戻して緑に戻ることも
確認した——詳細は本 PR の報告を参照）。

### 4. 採点は文字列の包含判定であり、`digest` への文字列一致（ADR 0052 決定4）を復活させていない

**逐語**【現物】—— [ADR 0052](./0052-compare-cassette-and-provenance-survival.md)
「決めたこと」4:

> **事実の生存判定は系譜の追跡のみ**（文字列一致の経路は削除した。「予約」として残さない
> ——ADR 0024 と同じ線）。

ADR 0052 決定4 が削除したのは、`compare.ts` の `factStatementSurvived` が擬似 LLM の
digest（自由な要約）に対して行っていた文字列一致である——digest は要約・言い換えされる
ため、本物の LLM では成立しない判定だった。

`answer-case.ts` の `gradeAnswer` はそれとは**別の対象**に対する文字列一致である
——比較するのは「digest」ではなく「**答えが短く閉じる質問への最終回答**」であり、
言い換えの自由度が構造的に小さい。⟹ **評価ケースは「答えが短く閉じる質問」だけで
構成する、という制約とセットでのみ成立する**（`AnswerExpectation.kind` を
`"closed-value" | "must-abstain"` に絞っているのはそのため）。ADR 0052 決定4 が
削除した経路を、対象を変えて復活させたわけではない。

### 5. `unknown` 類の `grounds.turnIndex` は、空配列を `unknown` のときだけ許す

`AnswerGrounds.turnIndex` は「空配列を許さない検査」（`assertGroundsPresent`）を持つが、
**`category === "unknown"` のときだけ例外的に空配列を許す**——「会話のどこにも根拠が無い」
ことそのものが根拠であり、根拠となるターンを名指しできないことが構造的に正しいため。
この例外は型では表現していない（`turnIndex: number[]` のまま）——`assertGroundsPresent`
という実行時の検査と docstring に寄せてある。ケース集合（`answer-case-set.dev.ts`/
`answer-case-set.eval.ts`）の `unknown` ケースは実際に `turnIndex: []` を使っている。

### 6. `buildMnemoraPrompt()`（`mnemora-path.ts`）を再利用する

naive/mnemora 両経路の `PromptSpec` は system 文・質問文の組み立て方を完全に同一にする
（§2.2 決定2）。mnemora 側の「記憶の列」は、新しく書かず `mnemora-path.ts` の
`buildMnemoraPrompt()` をそのまま再利用した——`ingestConversation()` も同様に再利用する。
問題なく再利用できた（詳細は本 PR の報告を参照）。

## 採らなかった案

- **`compare.ts`/`provenance-trace.ts` を変更して、事実の生存判定と回答の正誤判定を
  1つの器にまとめる。** 却下——Issue #496 が同じファイルの是正を別途進めており、
  範囲が重なる変更を同時に行わない。**【実測】本 PR の作業中に #496 は着地した**
  （`origin/main` = `35d9206` の時点で PR #504 / [ADR 0226](./0226-compare-provenance-reached-vs-information-retained.md)
  がマージ済み）。ADR 0226 は欄名 `factStatementSurvived` を⭐門の契約として据え置き、
  「出典到達だけを証明する。情報保持・最終回答の正誤は証明しない」を docstring・表示・
  文書で明示する側を選んでいる。⟹ **本 ADR はその先を埋める**——0226 が「測っていない」と
  名乗った層2・層3 を、別の器（`answer`）として足す。⛔ **0226 の決定を上書きしない。**
- **`runtime-factory.ts` の `createExampleRuntime` を改変し、`ExampleRuntimeHandle` に
  `llmProvider` を追加公開する。** 却下——本 PR の既存ファイルの改変範囲は
  `cli.ts`/`package.json`/README に限られる（設計コメントの指示）。呼び出し回数を数える
  decorator（`CountingLLMProvider`/`CountingEmbeddingProvider`、`answer-bench.ts`）は
  `createRuntime()` へ渡す**前**の provider インスタンスを包む必要があり、
  `createExampleRuntime` はその口を持たないため、`answer-bench.ts` に
  `createAnswerBenchRuntime()` という独立した組み立て関数を置いた。
- **`usage-meter.ts` を再利用して追加費用を数える。** 却下——`usage-meter.ts` は
  実 OpenAI の `client` を横取りする専用の実装であり、`deterministic`/`recorded` では
  使えない。自前の薄い decorator を新設した。
- **`gradeAnswer` の判定を CI の必須ゲートにする。** 却下（今回は）——偽陽性率に上限を
  置けると実測していないため（決定2）。
- **`answer` 用のカセットをこの PR で記録する。** 却下——実 API を叩く・鍵を設定する・
  カセットを記録することは、いずれもこの作業の禁止事項であり、記録は鍵と課金が要る
  オーナーの判断である（下記「引き受けた負債」参照）。

## 引き受けた負債・確かめていないこと

- 🔴 **回答品質は未評価である。** `recorded` は記録に無い入力で例外を投げ、カセットの鍵は
  入力のハッシュなので、`answer-case-set.*.ts` の新しいケースは1件も既存カセット
  （`examples/chat/cassettes/*.json`）に無い。⟹ **実 API で1回記録するまで `recorded` で
  回らない。** 記録は鍵と課金が要り、オーナーの判断である
  （[ADR 0184](./0184-conformance-scope-documented-not-closed.md)「決めたこと」4
  「⛔ CI で実 API を叩かない。鍵の管理と課金の判断はオーナーのものである」/
  [docs/conformance.md](../conformance.md) §7「実 API に当てる手順（鍵を持つ人向け）」）。
- 🔴 **PR #386（draft）が `examples/chat/src/mnemora-path.ts` の `RecallQuery.association`
  の既定を変える。** ⟹ この器が将来出す数字には「`association` 既定 off の下での値」
  という条件が付く。
- **一次判定（`accept`/`reject` の包含）の偽陽性・偽陰性率は測っていない。** ⟹ 門にしない
  理由そのもの（決定2）。
- **`eval` 側（`answer-case-set.eval.ts`）を「見て調整しない」を機械で強制する手段が無い。**
  ファイル冒頭にその旨のコメントを置いてあるが、規律に残る（`docs/autonomy.md` §2.2 決定5）。
- **ケース数は12件（各ファイル6件、6類×1件）と小さい。** 母集合としての代表性は主張しない
  ——本 ADR も本 PR も、ケース集合の質・量についての判断はここでは行っていない。
- **`answer` サブコマンドは CI に接続していない。** `.github/workflows/ci.yml` は変更して
  いない——CI への接続は Issue #497 の範囲である。

## これが覆るとしたら

- **`answer` のカセットが記録され、`recorded`/`openai` で実際に走らせて偽陽性・偽陰性率を
  実測できたとき。** そのとき初めて、この器を門にするかどうかの判断ができる
  （決定2 と同じ基準——ADR 0223 決定3）。
- **PR #386 が `association` の既定を変えたとき。** この器が出す数字の前提が変わる
  （引き受けた負債を参照）。
- **ケース集合を大きく増やし、母集合としての代表性を主張できる規模になったとき。**
  そのときは `docs/roadmap.md` 等、より上位の文書へこの器の位置づけを書き足す判断が
  別途要る。

## 確かめたこと・確かめていないこと

**【実測】確かめたこと**（本 PR の作業者が実際に走らせた。日時・コマンド・出力は
本 PR の報告に記載する）:

- `pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/answer-case.test.ts`
  ⟹ 24 tests passed（DB 不要）。
- 本物の Postgres 17 + pgvector（`initdb` で自分専用に構築）に対して
  `pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/answer-bench.postgres.test.ts`
  ⟹ 3 tests passed。
- `MNEMORA_LLM=deterministic MNEMORA_EMBEDDING=deterministic pnpm --filter @mnemora/example-chat run answer`
  を実行し、stdout 全文を得た（正誤の列が `—`、`summary` が JSON に出ないことを含む）。
- `answerQualityClaimable` を `return true` へ書き換える変異試験——単体試験・配線検査の
  両方が赤くなることを確認し、`cp` で退避したファイルへ戻して緑に戻ることを確認した。
- **ADR 215本の母集合に対する「LLM 採点 / LLM-as-judge」の grep を当て直した**
  （`grep -rniE "LLM.?(採点|judge|as-judge|as judge)" docs/decisions/`）——**0件**。
  母集合は本 PR 開始時点の `docs/decisions/*.md`（README を除く）215本
  （本 ADR 自身を含めない数）。#498 設計時の実測（受け取った事実）と一致した。

**⚠ 確かめていないこと**:

- **`answer` を `recorded`/`openai` で実際に走らせたことは無い**（本作業の禁止事項の
  ため、意図的に確かめていない）。
- **ケース集合12件が、6類それぞれの難度をどれだけ代表しているか。** 手書きの1〜2件ずつ
  であり、代表性は主張していない。
- **`gradeAnswer` の偽陽性・偽陰性率。** 上述の通り、これが門にしない理由そのものである。
- 🔴 **`gradeAnswer` の `reject` は、短い語を置くと脆い。**具体例: `answer-case-set.eval.ts` の
  `unknown-favorite-number` は `reject: ["7", "3", "8"]` を持つ。⟹ 正しく棄権した回答でも、
  文中にその1文字が現れれば `fail` に倒れる。**この脆さは把握した上で、held-out 側のケースを
  実測前に書き換えていない**——書き換えれば「見て調整したケース」になり、以後 `development`
  として扱う必要が生じるためである（`docs/autonomy.md` §2.2 決定5）。⟹ **最初の記録付きの
  実行で実際に現れたら、§2.2 決定4 の手順（旧基準と新基準、変更理由、失う保証を分けて示し、
  実装とは別のレビュー対象にする）で直す。**⛔ 本 PR では直さない。
