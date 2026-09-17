# ADR 0107: cache が効いていることを実ふるまいで固定する — warm でも tokenizer_config.json への Range リクエストは残る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-13

## 🔴 訂正の追記（2026-09-17）

**下記「検討して採らなかった案」の案Aに書いた「36MBのダウンロード」は、名詞の取り違えである。**

> 36MB のダウンロードと peak RSS 362MB の推論が `pnpm run test` 一発で走ることを避けるため

**実行時にダウンロードされるのは重み本体（`model_quantized.onnx`、36MB）だけではなく、
tokenizer.json / tokenizer_config.json / config.json を含めた4ファイル計 42MB である**
——[ADR 0085](./0085-local-embedding-provider.md) 決定7が個別に書いている実測値
（`model_quantized.onnx` 37,142,404 B / `tokenizer.json` 6,724,873 B /
`tokenizer_config.json` 3,779 B / `config.json` 1,341 B）を足すと 43,872,397 B ≒ 42MB
になる（この合計値自体は ADR 0085 の本文に文字列としては無く、個別の実測値から
導かれる）。⟹ ここで言いたかった量（ダウンロードの重さ）そのものは正しいが、
数字は 36MB ではなく 42MB のほうが正確である。

**⚠ 本文は書き換えていない。**同種の取り違えは `AGENTS.md` にも在り、
[PR #452](https://github.com/takecchi/mnemora/pull/452) で直っている
（#452 の commit message が、この ADR の上記箇所を「直していない残存箇所」として列挙している）。

---

**⚠ 各主張の出所を分ける。**「【実測】」と書いたものは**この作業でこの器から実行して取った**ものである。「【受領】」は前任からそのまま渡され、この作業で裏を取ったもの。

---

## 問い

Issue #164 は 2026-09-12 の 429（`root-gate-db-stage` ジョブが Hugging Face からの重み取得で落ち、無関係な PR #161 を待たせた）から始まった。PR #165（cache を持たない残り2ジョブに `actions/cache` を足す）と PR #167（呼び出し側の env 配線を走査する歯）はマージ済みである。**残っていたのは次の2点だった**（依頼者が承認したコメントより逐語に近い形）:

1. 「cacheDir に重みが在れば `env.fetch` が0回」を**実ふるまいで**固定する歯。**既存の歯は全部テキスト走査**（`ci.yml` の `path:`/env の対、`createExampleRuntime` の呼び出しソース）で、`@huggingface/transformers` を版上げして revalidation 等の挙動が変わっても、文字列が同じである限り緑のまま通ってしまう。
2. その決定と実測を残す ADR。

**この ADR を書く前に `docs/decisions/` を自分で走査した**（`grep -rl "#164" docs/decisions/`）。**該当なし。**⟹ 前任の主張「Issue #164 に触れた ADR は0本」は現物で裏が取れた。この Issue に関する決定は `.github/workflows/ci.yml` のコメントとテストの docstring にしか残っていない。

---

## ⭐ 残す決定: 「取りに行く頻度は下げたが、倒れ方は変えていない」

`ci.yml` に、PR #165 が足した以下のコメントが実在する（`example-chat` ジョブ 306〜309行目、`root-gate-db-stage` ジョブ 423〜426行目、逐語）:

> 🔴 ⛔ これは「取りに行く頻度」を下げる変更であって、「取れなかったときの
> 倒れ方」は変えていない。リトライ・フォールバック・既定値・skip は
> 入れていない——重みがキャッシュにも Hugging Face にも無ければ、
> 次の test:db ステップは従来どおり赤くなる。

**これが、この一連の作業（#164 全体）で守られている唯一の不変条件である。** リトライも、フォールバックも、既定値への読み替えも、足していない。「測れなかった」を「0」へ倒さない、というこの repo の既存の規律（Issue #164 本文が引く「🔴 重みを取得できなかったので、値は測っていない」）と同じ形を、cache 配線の変更後も保っている。

---

## 決定

**`packages/local-embedding/src/__tests__/live.cache-warm-network-behaviour.test.ts` を追加した。** 既存の `MNEMORA_LIVE_LOCAL_EMBEDDING`（`live.local-embedding.test.ts` に既に実在する opt-in ゲート）に相乗りする。

歯の形:

1. `createLocalEmbeddingPipeline`（本パッケージの公開関数）で、一時ディレクトリを `cacheDir` として本物のモデル一式を落とす（cold）。
2. **まっさらな別の Node プロセス**（`fixtures/measure-fetch-calls-in-fresh-node-process.mjs`）を spawn し、同じ `cacheDir` から読み込む（warm のつもり）。このプロセスは `@huggingface/transformers` の `env.fetch` を差し替えて、実際に呼ばれた回数と URL・メソッド・Range ヘッダを記録し、JSON で標準出力へ返す。
3. 親プロセス側でその JSON を検査する。

**別プロセスに分けた理由**: 同じプロセス内で cold → warm を両方行うと、`@huggingface/transformers` 内部の `memoizePromise`（`utils/model_registry/get_file_metadata.js`）が2回目の呼び出しをプロセス内メモ化でヒットさせてしまい、「cacheDir が温かいから0回」なのか「同一プロセス内だから0回」なのかを区別できない。CI の実際の形（`actions/cache` でディスクを復元 → 新しい `vitest` プロセスが1回だけモデルを読み込む）に合わせるには、**「温める」と「測る」を別プロセスに分ける必要がある。**

---

## 🔴 実測（この器から、2026-09-13。3回再現、揺れなし）

**「warm なら `env.fetch` が0回」は成立しなかった。**

| 対象 | warm での再取得 |
|---|---|
| `onnx/model_quantized.onnx`（36MB の重み本体） | ⛔ 無し（0回） |
| `config.json` | ⛔ 無し（0回） |
| `tokenizer.json` | ⛔ 無し（0回） |
| **`tokenizer_config.json`** | ✅ **毎回ちょうど1回**（`GET` + `Range: bytes=0-0`） |

**実測ログ（そのまま）**:
```json
{"fetchCount":1,"calls":[{"url":"https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX/resolve/main/tokenizer_config.json","method":"GET","range":"bytes=0-0"}]}
```

warm での読み込み所要時間は約 730ms（cold の約 3.9秒に対して短い——重みの再ダウンロードはしていないことの傍証でもある）。

### 原因（`@huggingface/transformers@4.2.0` の現物を読んで特定・裏取り済み）

`pipeline("feature-extraction", repo, { cache_dir, ... })` は内部で `AutoTokenizer.from_pretrained(model, pretrainedOptions)` を呼ぶ（`src/pipelines.js`）。`pretrainedOptions` には呼び出し側が渡した `cache_dir` が乗っている。**しかし**、トークナイザにどのファイルが実在するかを判定する `src/utils/model_registry/get_tokenizer_files.js` は次の形をしている（逐語）:

```js
export async function get_tokenizer_files(modelId) {
    const metadata = await get_file_metadata(modelId, 'tokenizer_config.json', {});
    ...
}
```

**`get_file_metadata` に空の `{}` を渡しており、呼び出し側の `cache_dir` を運んでいない。** `get_file_metadata`（`utils/model_registry/get_file_metadata.js`）内部の `getCache(options?.cache_dir)` は `options.cache_dir === undefined` を受け取り、**transformers.js の既定キャッシュディレクトリ（`env.cacheDir`。パッケージの `dist` 相対の `.cache/`）** を見に行く。これは私たちが CI で `actions/cache` によって温めている `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` とは**別の場所**である。⟹ そこには何も無いので `checkCachedResource` は外れ、ローカルファイルチェックも外れ（`env.localModelPath` 配下も見ない）、最後に `fetch_file_head()`（Range リクエスト）で確定させに行く。**これは `cache_dir` の温かさに関係なく、毎回のプロセス起動で必ず1回起こる。**

### ⟹ 429 の機序についての1段深い事実

**cache が完全に効いていても（重みは一切再取得されなくても）、このモデルを読み込むたびに Hugging Face への軽量な Range リクエストが最低1回残る。** PR #165/#167 が塞いだのは「42MB を毎回取りに行く」経路であり、この1回の Range リクエストの経路は**塞がれていない**——そもそも `cache_dir` を渡していないので、塞ぎようがない（この作業でも塞いでいない。塞ぐには `env.cacheDir` を明示的に合わせるか、transformers.js 側の修正が要る。**この ADR ではそこまで踏み込まない**——歯は現状を固定するだけであり、直しではない）。

軽い Range リクエスト1件のほうが、42MB のフルダウンロード4本が同時に飛ぶより 429 になりにくいとは期待できるが、**保証はしていない。** 次に 429 が再発したら、この経路（`tokenizer_config.json` への Range リクエスト）も容疑者に加えること。

---

## 検討して採らなかった案

**候補は2つだった**（Issue #164 のコメントで前任が挙げ、依頼者が「どちらでもよい、理由を書け」とした）:

### 案A: cache が温まっている CI ジョブの後段に測定を差し込む

**却下した。** 理由:

1. **CI の安定性を損なう。** この一連の作業（#164）の目的は、CI が Hugging Face への不要なネットワーク呼び出しに依存して落ちる頻度を下げることである。歯そのものが「本物のネットワーク呼び出しを毎 CI run で行う」形になると、目的と手段が矛盾する——歯自体が新しい 429 の発生源になりうる。
2. **4ジョブ（`example-chat` / `root-gate-db-stage` / `identifier-probes` / `consolidation-cost`）のどれか1本の後段に置いても、その1ジョブの環境（cache キー・runner の状態）だけを代表する。** 他の3ジョブの挙動を保証しない。
3. **既存の規律と整合しない。** `live.local-embedding.test.ts` の docstring は「CI では走らない」ことを明示的な設計としている（36MB のダウンロードと peak RSS 362MB の推論が `pnpm run test` 一発で走ることを避けるため）。今回追加する歯も同種の「本物のモデルに実際に触れる」処理であり、**既存の境界（opt-in ゲート）の外に新しい「本物に触れる CI 経路」を増やさない**ほうが一貫している。

### 採った案: 既存の opt-in ゲート `MNEMORA_LIVE_LOCAL_EMBEDDING` への相乗り

- CI では常に `skipped`（設定していないため）——確認済み（下記「確かめたこと」参照）。
- 手元またはこの器のような委譲環境で、明示的に opt-in したときだけ実行される。**課金は発生しない**（`live.local-embedding.test.ts` の docstring と同じ理由——このパッケージは Hugging Face の重み配布にしか繋がらない）。
- 新しいゲートを作らずに済み、既存の規律（「本物に触れるテストは1つの opt-in 変数に集約する」）を壊さない。

---

## 引き受けた負債

1. **⛔ 実装していない: cold cache の同時取得。** 4ジョブ（`example-chat`: 227行目 / `root-gate-db-stage`: 331行目 / `identifier-probes`: 566行目 / `consolidation-cost`: 692行目）が**まったく同じ cache key** `local-embedding-ruri-v3-30m-q8-v1`（`ci.yml` 313 / 430 / 650 / 776行目、この作業で確認済み）を共有している。**cache が cold な run では、この4本が同時に Hugging Face から重み一式を取りに行く可能性がある**——2026-09-12 の 429 の機序がまさにこれかもしれない。塞ぐなら `needs:` で1本だけ先に温めるなどの手があるが、**CI を直列化する代償がある。この判断は依頼者が承認していないため、今回は触っていない。** 次に 429 が出たとき、この同時実行が最初の容疑者になる。
2. **`tokenizer_config.json` への Range リクエストは、cache 配線をどれだけ直しても消えない。** 上述の通り、`get_tokenizer_files()` が `cache_dir` を運んでいないという transformers.js 側の実装に起因する。直すなら `env.cacheDir` を私たちの `cacheDir` に明示的に合わせるという手があるが、**それは `LocalEmbeddingProvider` の呼び出し規約を変える話であり、この作業の範囲外**（今回は「実測して固定する」だけに留めた）。
3. **この歯は `@huggingface/transformers@4.2.0` の内部実装の詳細に依存している。** バージョンが上がれば `fetchCount` が 0（前進）にも、2以上（新しい退行）にも動きうる。**歯が落ちたら、まずどちらの向きかを確認すること**——0 になっていたら歓迎して ADR とテストを更新し、増えていたら新しい 429 源として調べること。

---

## 確かめたこと

- **CI では `MNEMORA_LIVE_LOCAL_EMBEDDING` を設定していない**ことをこの作業で確認した（`grep -rn "MNEMORA_LIVE_LOCAL_EMBEDDING" .github/workflows/ci.yml` は0件——この歯を含む `live.*.test.ts` は CI で常に `skipped` と表示される）。
- 4ジョブの cache key が完全一致すること（`ci.yml` 313/430/650/776行目、逐語 `local-embedding-ruri-v3-30m-q8-v1`）。
- `docs/decisions/` に #164 へ言及する既存 ADR が無いこと。

## 確かめていないこと

- **GitHub Actions の runner 上で同じ実測が再現するか。** この実測はこの器（委譲環境）のネットワークから行った。runner のネットワーク経路や DNS・プロキシの違いで挙動が変わる可能性はゼロではない。
- **`config.json` / `tokenizer.json` についても、将来のバージョンで同種の `cache_dir` 漏れが起きないか。** 現バージョン（4.2.0）では両者とも warm なら0回であることを実測で確認済みだが、それ以上の保証はしていない。
- **Hugging Face 側のレート制限の規則**（IP 単位か、GitHub Actions の runner 全体で共有か）は本 Issue の当初からの範囲外のままである。
- **cold cache の同時取得が実際に 429 を起こすかどうか**は測っていない（上の「引き受けた負債」参照。依頼者の承認が要る変更のため、実装も測定もしていない）。

## これが覆るとしたら

- `@huggingface/transformers` の版が上がり、`get_tokenizer_files()` が `cache_dir` を正しく運ぶよう修正されたら、`fetchCount` は 0 になり、この歯は失敗する——**その時点でこの ADR と歯を一緒に更新すること**（退行ではなく前進として扱う）。
- 逆に `memoizePromise` の挙動が変わり、同一プロセス内でも複数回リクエストするようになったら、warm 側の呼び出しで `fetchCount` が2以上に増え、この歯は失敗する——**新しい 429 源の候補として調べること。**
- cold cache の同時取得（引き受けた負債1）が実際に 429 を再発させたら、`needs:` による直列化などの案を、CI の直列化コストとあわせて改めて依頼者に諮ること。

## 関連

Issue #164 / PR #161 / PR #165 / PR #167 / ADR 0085（local embedding provider）/ ADR 0090（8192トークンの壁・同じ live テストファイルの隣接する歯）
