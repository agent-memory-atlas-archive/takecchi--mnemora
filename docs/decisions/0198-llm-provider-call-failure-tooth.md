# ADR 0198: `LLMProvider` が逐語で約束していて一度も測られていなかった1行に、歯を置く — 適合 suite の設計判断には踏み込まない（Issue #389）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 / 0192 / 0196 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `grep`/`vitest` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

**`packages/core/src/interfaces/llm-provider.ts` は、契約を逐語でこう書いている**【現物】:

> 契約:
>
> - `completeStructured` はベンダー固有の Structured Output 機構へ翻訳する義務を negate
>   できない。core・呼び出し側に OpenAI/Anthropic SDK の型を漏らしてはならない。
> - **タイムアウト・レート制限・失敗時は例外を投げる。`LLMProvider` 自体はリトライを
>   内蔵しない**（責務の混在を避ける）。

**2行目に当たる歯は、1本もあるか。**

## 🔴 無かった

【実測】2026-09-17、`main` = `855286a`:

```
$ grep -rn "mockRejected" packages/anthropic/src/__tests__/ packages/openai/src/__tests__/ --include=*.ts | grep -vi embedding
（0件）
$ grep -rni "timeout|rate.limit|429" 同上
packages/openai/src/__tests__/live.openai.test.ts:119:      timeout: 60_000,   ← vitest の timeout オプション
```

⟹ **SDK 呼び出しが reject する側を仕込んだテストが1本も無い。**

**既存の歯が測っていた「例外を投げる」は、すべて「応答が返った _後_ の異常」である**——
JSON 構文エラー・`ZodError`・`no_content`・`refusal`・`truncated`。
**⟹ 「タイムアウト・レート制限・呼び出し自体の失敗」と「リトライを内蔵しない」の2つは、
契約として書かれているだけで、一度も測られていなかった。**

### なぜ放置できないか

**v1.0.0 は「公開 API が安定した」と名乗る版である。**⟹ **interface が逐語で約束していて
一度も測られていない挙動が在るのは、その名乗りの内側の穴である。**

⚠ **これは「いま壊れている」という主張ではない。**【現物】どちらの実装も `await` の周りに
`try`/`catch` を持たないので、**今日は素通しで伝播する。**⟹ **これは「起きた」ではなく
「守るものが無い」issue である**——誰かがリトライやフォールバックを足した日に、静かに破れる。

## 決定

1. **各 adapter の既存テスト群に `call-failure.test.ts` を1本ずつ置く**
   （`packages/anthropic/src/__tests__/` と `packages/openai/src/__tests__/`）。測るのは4つ:
   - `complete` / `completeStructured` が、**reject された例外を同一性のまま伝播する**
   - **リトライを内蔵しない**（`create` の呼び出し回数がちょうど1）
   - **例外の種類を問わない**（レート制限・タイムアウトを模した例外でも同じ）
   - ⭐ **陰性対照**: 成功する呼び出しでも `create` はちょうど1回
2. **同一性（`rejects.toBe(sentinel)`）で見る。**⛔ `toThrow(/boom/)` にしない——
   **wrapper が別の `Error` へ包み直しても、メッセージさえ同じなら通ってしまう。**
   加えて `rejects.not.toBeInstanceOf(<Package>LLMProviderError)` を置き、
   **転送の失敗が `no_content` へ化けない**ことを名指しで固定する
   （このリポジトリの固定点「『無い』の種類を潰さない」の、この層への適用）。
3. ⛔ **`packages/testkit` に `describeLLMProviderConformance` を作らない。**
4. ⛔ **公開 API を1バイトも変えない。**実装コードは `docs/architecture.md` を除いて無変更である。
5. **`docs/architecture.md` §3.8 の署名から `ctx` が落ちていたのを直す**（下記）。

### 5 について: §3.8 が現物とずれていた

【現物】`main` = `855286a`:

| 場所                                                   | 署名                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `docs/architecture.md:230`（§3.8）                     | `complete(req: PromptSpec): Promise<LLMResponse>;`           |
| `docs/architecture.md:597`（§5.4）                     | `complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;` |
| `packages/core/src/interfaces/llm-provider.ts`（現物） | `complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;` |

⟹ **同じ文書の中で §3.8 だけが `ctx` を落としていた。**

**「ついでに直す」ではない**（`docs/autonomy.md` §2 の戒め）。
**Issue #389 の本体（適合 suite）は、本文が「§3.8 の記述と2実装の現物の差を突き合わせてから
契約を決めること」と指示している。⟹ その突き合わせの起点が、現物とずれていた。**
**次に suite を書く人がそのずれを引き継ぐ**ので、この ADR の射程の内側にある。

あわせて **§3.8 と §5.4 が同じ1つの interface であること**と、**契約の本体は §5.4 にしか
無いこと**を §3.8 に明記した（複製が2つ在ることそのものは消していない。下の負債 (b)）。

## 採らなかった案

- **案A: `packages/testkit` に `describeLLMProviderConformance` を新設し、そこへ置く。**
  ⛔ 採らない。**それが Issue #389 の本体であり、本文が「⛔ 先に決めるべきこと（実装の前に）」
  として3つの未決を挙げている**——契約の粒度・`refusal`/`truncated`/`no_content` を core の
  契約へ格上げするか・`complete()` が空応答に空文字を返すことを契約として要求するか。
  ⟹ **この ADR はそこへ踏み込まない。**`docs/autonomy.md` §2「1つの PR は1つの ADR と
  その実装」に従い、**判断を待たずに書ける範囲だけを取る。**
  ⚠ **代償**: suite ができた日に、この2ファイルは**引っ越しの対象**になる。
  ⟹ **両ファイルの doc コメントに、対になるファイルのパスを相互に書いてある**
  （「片方だけ直さないこと」）。
- **案B: SDK の本物のエラークラス（`Anthropic.APIConnectionTimeoutError` 等）を投げさせる。**
  ⛔ 採らない。**コンストラクタの署名は SDK の内部事情であり、SDK を上げた日に歯が壊れる。**
  そして**この wrapper は例外の種類で分岐していない**【現物: `catch` が無い】ので、
  **本物のクラスでなければ測れないことが無い。**⟹ 名前だけ模した `Error` の派生で足りる。
  ⚠ **その代わり「SDK の本物のエラーでも同じ」は主張していない**（下の「確かめていないこと」）。
- **案C: `complete()` が空応答に空文字を返す件（ADR 0072 負債2）を、ここで直す。**
  ⛔ 採らない。**両 provider 同時の公開 API の破壊的変更**であり、Issue #389 が名指しする
  設計判断そのものである。⟹ **この ADR の射程の外。**
- **案D: 何もしない（v1.0.0 後に suite ごとやる）。**
  ⛔ 採らない。**歯が無い期間が伸びるだけで、得るものが無い。**この4本は suite ができても
  そのまま引っ越せる形にしてある。

## 引き受けた負債

### (a) 測っているのは wrapper であって、production の経路ではない

**両テストとも `client` を注入している。**⟹ **`new Anthropic({ apiKey })` / `new OpenAI({ apiKey })`
が既定で持つ SDK 内部のリトライは、この歯を通らない。**

⟹ **「`LLMProvider` 自体はリトライを内蔵しない」という契約は、`LLMProvider` の実装層について
測れた。「mnemora の production の経路が1回しか叩かない」は測れていない。**
⚠ **むしろ SDK 既定のリトライが在るなら、production では複数回叩かれている可能性がある。
この ADR はそれを確かめていない**（下記）。**⟹ そこは別の住所である。**

### (b) §3.8 と §5.4 に interface の複製が2つ在ることは消していない

`AGENTS.md` は「⚠ ここに北極星の要約を置かない——複製した瞬間から、正文と要約はずれ始める」
と書いている。**§3.8 と §5.4 の関係はまさにそれであり、実際にずれた。**

**この ADR は片方を消していない**——§3.8 は「ベンダー型が core に漏れない」という別の主張の
ために署名を見せており、消すと文脈が壊れる。**代わりに「同じ1つの interface である・契約の
本体は §5.4 にしかない」と §3.8 側へ書いた。**⟹ **注意力への依存が減っただけで、消えてはいない。**
⚠ **機械的に検査していない。**同じずれはまた起こりうる。

## 歯が噛むことを示した（変異試験）

【実測】2026-09-17。無変異で **anthropic 4 tests / openai 4 tests がすべて緑**。
**変異は `cp` で退避・`cp` で戻した**（`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」）。

| 変異                                                                   | 結果                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| M1（anthropic）: `complete` に「失敗したらもう1回」のリトライを仕込む  | **3 tests 赤**                                                                             |
| M2（anthropic）: `complete` が例外を飲んで `{ content: "" }` を返す    | **2 tests 赤**                                                                             |
| M3（anthropic）: `completeStructured` が例外を `no_content` へ包み直す | **2 tests 赤**                                                                             |
| M4（openai）: `complete` が例外を飲んで `{ content: "" }` を返す       | **2 tests 赤**                                                                             |
| 4つとも `cp` で戻す                                                    | **両パッケージとも 4 tests 緑に戻る**、`git status --porcelain` に変異が残らないことを確認 |

⭐ **M2 / M4 が一番効く。**両実装の `complete` は応答が空でも例外にせず `?? ""` を返す形
（ADR 0072 負債2）なので、**転送の失敗が黙って `{ content: "" }` に倒れる変異は、
この歯が無いと外から見分けがつかない。**

## これが覆るとしたら、何が起きたとき

- **Issue #389 の適合 suite ができたとき。**この4本 × 2ファイルは**引っ越しの対象**になる。
  ⟹ **そのとき歯を減らさないこと**——suite に同じ主張が在ることを確かめてから消す。
- **`LLMProvider` が「リトライを内蔵しない」をやめたとき**（呼び出し側ではなく provider が
  リトライ方針を持つ設計へ変えたとき）。⟹ **決定1の3番目の主張が逆になる。**
  そのときは core の interface の doc と `docs/architecture.md` §5.4 も同時に変わるはずである。
- **`complete()` の空応答の扱いを変えたとき**（案C）。⟹ M2 / M4 の意味が変わる。

## 確かめていないこと

- **SDK の本物のエラークラスでは測っていない**（案B）。⟹ **「`Anthropic.RateLimitError` でも
  同じ」は主張していない。**測ったのは「例外の種類を問わず素通しする」ことだけである。
- 🔴 **`new Anthropic()` / `new OpenAI()` が既定で何回リトライするかを確かめていない**（負債 (a)）。
  ⟹ **production の経路が1回しか叩かないとは言っていない。**
- **`docs/architecture.md` §3.8 と §5.4 のずれを、機械的に検査する歯は置いていない**（負債 (b)）。
- **Issue #389 の本体（`LLMProvider` の適合 suite）は塞がっていない。**この ADR が触ったのは、
  本文が挙げた契約のうち**1行だけ**である。
- **既存の75本（`llm-provider` / `provider-parity` / `json-schema` / `refusal`）が
  実際に何を保証しているかは、当方で変異試験をしていない。**【受: Issue #389 へのコメントに
  記した下読みの報告】
- **`examples/chat` や `runtime.observe()` 側が、この例外をどう扱うかは測っていない。**
  `packages/openai/src/__tests__/observe-refusal-reaches-result.test.ts` が `refusal` について
  同型の配線を測っているが、**転送の失敗についての対応物は無い。**

## 参照

- [Issue #389](https://github.com/takecchi/mnemora/issues/389) — この ADR の出所。**本体は塞がっていない**
- [ADR 0184](./0184-conformance-scope-documented-not-closed.md) — 「塞ぐ前に名乗る」判断。#389 を別に切ると決めた理由
- [ADR 0072](./0072-anthropic-llm-provider.md) — `@mnemora/anthropic` を足した判断。**負債1が適合 suite の欠落・負債2が `complete()` の空文字**
- [ADR 0095](./0095-embedding-provider-conformance.md) — `EmbeddingProvider` 側の suite（suite を作るなら倣う先）
- [docs/conformance.md](../conformance.md) — 適合テストが何を検証し、何を検証していないか
