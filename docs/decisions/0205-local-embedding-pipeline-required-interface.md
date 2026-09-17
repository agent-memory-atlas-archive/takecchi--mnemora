# ADR 0205: `LocalEmbeddingPipeline` を必須 interface にし、ADR 0090 決定4「引き受けた負債1」を塞ぐ（Issue #137 案 (a)）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0090 / ADR 0204 と同じ体裁）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[ADR 0090](./0090-embedding-input-token-limit.md) 決定4は、`LocalEmbeddingPipeline` を
「テキストの配列を、そのままベクトルの配列にする関数」

```ts
export type LocalEmbeddingPipeline = (texts: string[]) => Promise<number[][]>;
```

のまま残し、「引き受けた負債」1番にこう書いていた（逐語）:

> 🔴 **注入された pipeline には上限の検査が無い。**
> 検査は `buildLocalEmbeddingPipeline` が組み立てた pipeline の中に在るので、
> `options.createPipeline` で別のものを注入した呼び出し側には効かない。
> ⟹ **これは 3.1 の必須 interface で構造的に消せる。⛔ 公開 API の破壊的変更なので、
> `docs/autonomy.md` §3 に従って実装せず、ここで提起する。オーナーの判断を待つ。**

これが [Issue #137](https://github.com/takecchi/mnemora/issues/137) になった。
Issue のオーナー棚卸しコメント（2026-09-16 / 2026-09-16 検算）は、
「実装は別 PR、承認を待つ」という前提そのものが
[ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)（2026-09-15、
承認 id `f6d9c3ea`）で既に外れていることを確認した——**公開 API の破壊的変更も、
ADR を書けば実装してよい。**⟹ この ADR は、その確認を受けて Issue #137 の
(a)「必須 interface にする」を実装したものである。

## 決定

`packages/local-embedding/src/pipeline.ts` の `LocalEmbeddingPipeline` を、
関数型から次の**必須 interface**に変える:

```ts
export interface LocalEmbeddingPipeline {
  readonly maxInputTokens: number;
  countTokens(texts: string[]): number[];
  embed(texts: string[]): Promise<number[][]>;
}
```

これは ADR 0090 §3.1 が示していた形と同一である。⛔ **具体的な上限の値
（8192 トークン等）はどこにも書かない**——このインターフェースが強制するのは
「上限を宣言すること」だけであり、値は pipeline を組み立てる側
（`buildLocalEmbeddingPipeline` や、独自実装する第三者）が持つ。

### なぜやるか — 北極星への当て方

[docs/north-star.md](../north-star.md) は目指す姿に
「**知らないことを、知らないと言える**——『見つからなかった』と『探していない』を、
同じ顔で返さない」を挙げている。

`LocalEmbeddingProvider` の `createPipeline` 注入点（`options.createPipeline`）は、
テストのために意図して開けてある差し替え口である（`packages/openai` の `client` と
同じ役目）。**旧来の関数型では、この口へ「上限を宣言しない」関数を渡すことが
型検査を素通りしてしまえた**——渡す側が `maxInputTokens` の存在を知らなくても、
渡す側が上限の検査を書かなくても、TypeScript は何も言わない。

その状態で長文を渡すと、`embed()` の実装（transformers.js 経由なら
`truncation: true`）が黙って後ろを切り捨て、**切られたベクトルと
切られていないベクトルが同じ形・同じ「成功」の顔で返る。**これは
「探していない」を「見つからなかった」と同じ顔で返す壊れ方そのものであり、
北極星が名指しで禁じている形である。

⟹ `maxInputTokens` / `countTokens` を**必須のプロパティ**にすることで、
`(texts) => Promise<number[][]>` という関数だけを渡す形は**型検査で弾かれる**。
**注入する側は、上限を宣言しないと `LocalEmbeddingPipeline` を作れない。**
「正常な顔をして返る」経路を、型のレベルで塞ぐのがこの変更の目的である。

### ⚠ この変更が構造的に閉じるのは「宣言を忘れる」までである

**この interface は、宣言した `maxInputTokens` を `embed()` の実装が実際に
守っているかまでは検査できない。**独自の `createPipeline` が
`maxInputTokens: 8192` と正直に宣言しつつ、`embed()` の中身では何も検査せず
黙って推論に回す、という実装は今回も型で弾けない。ADR 0090 §3.1 自身が
挙げていた利点も「宣言を忘れた pipeline が黙って検査を失う形を構造で消せる」
までであり、「宣言を裏切る pipeline」までは主張していない——本 ADR もその
射程を超えない。「引き受けた負債」1番に改めて書く。

## 検討した選択肢

### (a) 必須 interface にする — **採用**

上記のとおり。公開 API の破壊的変更だが、ADR 0156 によりオーナーの個別承認を
待たずに実装してよい（ADR を書くことは必須のまま——本 ADR がそれを満たす）。

### (b) 任意のままにする（Issue #137 の (b)）— **却下**

`maxInputTokens?` / `countTokens?` を任意プロパティとして足す案。ADR 0090 §3.2
が同じ形を「上限とトークン数え器を、任意のプロパティとして関数型に足す」として
既に検討・却下している——**任意にすると、`LocalEmbeddingProvider` は
「この pipeline に上限が無い」と「この pipeline が宣言を忘れた」を区別できない。**
[ADR 0008](./0008-absence-taxonomy.md) の判定基準（区別できない2種を1つに潰さない）
に照らして、本 ADR でも同じ理由で却下する。

Issue #137 はこの案を選んだ場合、「宣言が無い pipeline を注入した」ことを
呼び手に見える形にすべきかも一緒に決めたい、と書いていた。**(a) を採ったので、
この問いは発生しない**——宣言が無い pipeline はそもそも注入できない。

### (c) 保留（Issue #137 の (c)）— **却下**

判断を先送りする案。却下する理由は2つある。

1. **費用の非対称。**`@mnemora/local-embedding` は npm へ publish している
   6パッケージの1つである。v1.0.0 を出した後にこの変更をやると、**利用者が
   実在するかどうかに関わらず** semver 上の major bump を伴う破壊的変更になる。
   v1.0.0 前のいまなら、同じ変更がより安く着地する。
2. **決められない理由が無い。**`docs/autonomy.md` §3.1 の見分け方
   「どちらを選んでも技術的には成立するが、選び方が製品の性格を決めるなら
   `docs/roadmap.md` §5 行き」に照らすと、この判断は北極星の物差し
   （「同じ顔で返さない」）に直接当てられる。**製品の性格の分岐ではなく、
   正典への適合の話である**ため、保留にする理由が無い。

### ADR 0090 §3.2〜§3.4 で既に却下済みの案

上限を「任意のオプション」にする案（§3.3）・警告ログに留める案（§3.4）は、
ADR 0090 が既に検討・却下しており、その理由（本物のトークナイザが要る／
`embeddingStatus: 'ready'` のまま切れたベクトルが残る）は今回の変更でも
変わらない。ここで再検討はしない。

## ⭐ 利用者数について — 確認していない。判断の理由でもない

**`@mnemora/local-embedding` の実際の外部利用者数は確認していない。**npm の
ダウンロード数、GitHub 上の依存グラフのどちらも調べていない。

**そのうえで、この判断は「利用者が少ないから壊してよい」という理由では
成立させていない。**成立させているのは「正典（北極星）に反する経路を塞ぐ」
ことである。⟹ **利用者数が後で分かっても（多くても・少なくても）、
この ADR が決定に使った理由は動かない。**利用者が多いと分かった場合に
動くのはロールアウト（周知・移行猶予）の要否であって、この決定そのものではない。

## 結果（この決定が招くもの）

**良い面**

- **`createPipeline` へ「上限を宣言しない」pipeline を注入することが、型検査で
  弾かれるようになった。**ADR 0090 決定4「引き受けた負債1」で名指しされていた
  「構造的に消せる」が、実際に消えたことを下の変異試験で示す。
- 値（8192 等）はこの変更のどこにも登場しない——上限は今までどおり
  `buildLocalEmbeddingPipeline` が extractor のトークナイザから読み取るか、
  独自実装する側が持つ。
- 既存の検査（`input_too_long` / `unknown_input_limit`、境界が `>` であること、
  推論の前に落ちること）は、形を変えただけで期待値を1つも変えていない
  （`input-token-limit.test.ts` の全歯が緑のまま）。

**引き受けた負債**

1. 🔴 **型が強制するのは「宣言すること」までである。**宣言した
   `maxInputTokens` を `embed()` の実装が実際に守っている保証は無い
   （上の「なぜ〜宣言を忘れるまでである」節）。誠実でない・バグのある
   独自実装は今回も塞げない。
2. **`@mnemora/local-embedding` の外部利用者数を確認していない**（上記）。
   実在する第三者の `createPipeline` 実装がどれだけ壊れるかは見積もっていない。
3. **`observe()` の入力に上限は無いままである**（ADR 0090 決定4・
   「引き受けた負債」3番から変わらない）。本 ADR は「注入された pipeline にも
   宣言を強制する」までであり、`observe()` からの経路そのものは閉じていない。
4. **`packages/openai` 側は 1 行も触っていない**（ADR 0090 決定4・
   「引き受けた負債」4番から変わらない）。
5. **リリース（npm への publish・version bump）はこの PR に含まれない。**
   `docs/autonomy.md` §3 により publish・version 変更はオーナーだけが行う。
   ⟹ この破壊的変更が実際に利用者へ届くのは、次に publish されたときである。

## これが覆るとしたら

- **「宣言を裏切る pipeline」（上の負債1）を型以外の手段で塞ぐ必要が出たとき。**
  例えば `LocalEmbeddingProvider.embed()` 自身が `pipeline.maxInputTokens` /
  `pipeline.countTokens()` を使って検査を一元化する案が考えられるが、
  それは既存の `buildLocalEmbeddingPipeline` の検査と重複するか、
  二重に符号化する費用（ADR 0090「引き受けた負債」2番と同種）を伴う。
  本 ADR ではその案を採らず、必要になったときの検討課題として残す。
- **実在する第三者の `createPipeline` 実装が壊れたと報告が来たとき。**
  その時点で初めて「利用者数」が判断に必要な情報になりうるが、
  上述のとおり本 ADR の決定そのものは覆らない——覆るとしたら移行の進め方である。
- **`observe()` からの経路（引き受けた負債3）を塞ぐ決定が別途下ったとき。**
  ADR 0090 §3.5 / §3.6 の分割・要約の検討に戻る。

## 測ったこと

**この PR で実際にこの器から実行した検査**（`packages/local-embedding` と、
これに依存する `examples/chat`・リポジトリ全体の6つの門のうち手元で走らせられるもの）。

```
$ pnpm --filter @mnemora/local-embedding run typecheck
$ tsc -p tsconfig.json
（エラー無し）

$ pnpm --filter @mnemora/local-embedding exec vitest run
 Test Files  5 passed | 2 skipped (7)
      Tests  83 passed | 15 skipped (98)
（skip 2本は live.local-embedding.test.ts と local-embedding-provider.conformance.test.ts
  ——どちらも opt-in で、本物のモデル取得か fixtures 経由の実行を要求する既存の設計。
  本 PR はどちらのファイルも「呼び出しの形」だけを直しており、既存の skip 条件は変えていない）

$ pnpm --filter @mnemora/example-chat run typecheck
$ tsc -p tsconfig.json
（エラー無し）

$ pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/local-embedding-warmup.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ pnpm run typecheck   # 全7パッケージ
（7パッケージとも Done、エラー無し）

$ pnpm run lint        # eslint .
（出力無し＝違反0）

$ pnpm run format:check
All matched files use Prettier code style!

$ pnpm run build       # 全パッケージ
（7パッケージとも Done）

$ node scripts/check-public-api-surface.mjs --write
[@mnemora/local-embedding] snapshot を書きました
（他5パッケージは差分なし）

$ node scripts/check-publish-pack.mjs
✔ publish 梱包の門を通りました。
```

**上限の値をどこにも焼き込んでいないことの確認**:

```
$ grep -rn "8192" packages/local-embedding/src
```

一致するのは `src/__tests__/live.local-embedding.test.ts`（コメントとアサーション）・
`src/__tests__/input-token-limit.test.ts`（説明コメントのみ、アサーションには使っていない）・
`src/__tests__/fixtures/real-ruri-embeddings.json`（記録された実測値の1欄）の3箇所で、
**すべて本 PR より前から存在する**（`git diff main -- <各ファイル> | grep 8192` で、
一致した行がどれも本 PR の追加行（`+` 側）ではなく既存行であることを確認済み）。
ADR 0090 が「8192 という数字を固定するのは `live.local-embedding.test.ts` である」と
明記しているとおりの既存の実測値であり、`pipeline.ts` / `local-embedding-provider.ts`
本体、および本 PR が新規に書いたコード・アサーションには一致が無い。

### 変異試験

**変異**: [Issue #137](https://github.com/takecchi/mnemora/issues/137) が指す
壊れ方——「上限を宣言しない pipeline を注入できてしまう」状態——を、
`examples/chat/src/__tests__/local-embedding-warmup.test.ts` の1テストに
一時的に戻した（`cp` で退避してから編集。`git checkout` は使っていない）:

```ts
createPipeline: async () => async (texts: string[]) =>
  texts.map(() => new Array(256).fill(0)),
```

この状態で `pnpm --filter @mnemora/example-chat run typecheck` を実行すると、
**歯が赤くなった**:

```
src/__tests__/local-embedding-warmup.test.ts(34,7): error TS2322: Type '() => Promise<(texts: string[]) => Promise<any[][]>>' is not assignable to type 'CreateLocalEmbeddingPipeline'.
  Type 'Promise<(texts: string[]) => Promise<any[][]>>' is not assignable to type 'Promise<LocalEmbeddingPipeline>'.
    Type '(texts: string[]) => Promise<any[][]>' is not assignable to type 'LocalEmbeddingPipeline'.
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @mnemora/example-chat@0.0.0 typecheck: `tsc -p tsconfig.json`
Exit status 2
```

`cp` で退避しておいたファイルを `cp` で書き戻し、`git status --porcelain` で
差分が消えていることを確認したうえで、`pnpm --filter @mnemora/example-chat run typecheck`
を再実行すると**緑に戻った**（エラー無し、`tsc` の出力無し）。`diff` でも
退避したオリジナルと復元後のファイルが完全一致することを確認した。

## 確かめていないこと

- **`@mnemora/local-embedding` の実際の外部利用者数**（上記の節）。
- **独自の `createPipeline` 実装が、宣言した `maxInputTokens` を実際に守って
  いるかどうかの検査**——本 ADR の射程外であることは上に明記した。
- **`live.local-embedding.test.ts` / `local-embedding-provider.conformance.test.ts`
  を実行しての確認**——前者は本物のモデル取得（opt-in）、後者は fixtures 経由の
  実行を要求し、どちらもこの作業では既定で skip される設定のまま変えていない。
  変更したのはどちらのファイルも「`pipeline(...)` を `pipeline.embed(...)` に
  書き換える」という呼び出しの形だけであり、動く中身（アサーションの期待値）は
  変えていない——ただし実行しての確認はしていない。
- **CI（GitHub Actions）上での6つの門の緑**。本 ADR の「測ったこと」は
  すべて手元での実行であり、`docs/autonomy.md` §2 が定める「確かめる場所は
  CI である」はまだ満たしていない。PR 本文で CI の sha 単位の緑を別途報告する。
