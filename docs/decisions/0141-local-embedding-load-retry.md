# ADR 0141: `@mnemora/local-embedding` の読み込みに、種類の分かっていない失敗のリトライを足す — キャッシュが hit してもネットワークは0回にならない（Issue #261）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける。**「【実測】」は**この作業でこの器から実行して取った**もの。
「【現物】」は**この repo のコード・文書をこの作業で自分の手で読んで確かめた**もの。
「【推論】」は現物から導いた、実行していない結論。「【受領】」は Issue #261 の記述、
または `docs/decisions/0107-local-embedding-cache-warm-network-tooth.md`
（以下 ADR 0107。Issue #164 で書かれた既存の先行調査）の記述をそのまま引いたもの。

---

## 結論

**3件測った失敗のうち少なくとも1件（直近・2026-09-15）は、`actions/cache` の
ヒット/ミスとは無関係だった。**「キャッシュが外れた」のではなく、
**キャッシュがどれだけ温かくても`@huggingface/transformers` が毎回1回だけ
（`tokenizer_config.json` の存在確認のために）Hugging Face へ出る経路があり
（ADR 0107 が特定済み）、そこが一時的に失敗した。** ⟹ Issue #261 が挙げた
候補①〜③（追い出し・PR枝スコープ・保存失敗）は少なくともこの回には**当てはまらない**。

**この失敗経路はキャッシュ設定をどれだけ強くしても閉じない**（構造的に `cacheDir` の
外側にある）。⟹ **(C)（キャッシュを強くする）はこの故障モードの修正にならない。**
**(A) を採る**——`packages/local-embedding` のモデル読み込み（`createPipeline` の
呼び出し）に、種類の分かっていない失敗（ADR 0090 の `kind` が付いていない、
主にネットワーク由来）だけを対象に、指数バックオフ + jitter で既定3回まで
リトライする。`kind` の付いた失敗（`input_too_long` / `unknown_input_limit`）は
今までどおりリトライしない——入力・設定の問題であり、再試行しても結果は変わらない。

`.github/workflows/ci.yml` は変更していない。(B)（CI 側だけのリトライ）は
検討のうえ採らなかった（§3）。

---

## 1. 問い（[Issue #261](https://github.com/takecchi/mnemora/issues/261)）

**【受領】** `@mnemora/local-embedding` のモデル重み取得経路にリトライが無く、
`actions/cache` が外した回に `fetch failed` が起きると CI が赤くなる。PR #259
（Issue #258 の修正）の再走で実際に起きた——`run 34954794665` / sha `aac41f8`
（差分は `docs/decisions/README.md` の索引1行のみ）/ job `example-chat`。

issue が明示した「確かめていないこと」2点、**それを埋めるのが本 ADR の作業の半分**:

1. **頻度を数える。**「稀」は issue 本文が明記する推測であり、実測ではない。
2. **キャッシュを外した理由を特定する**（候補: ①7日間の追い出し ②PR枝スコープ
   ③保存失敗）。

4案（issue が提示、どれでも技術的に成立、選んで理由を残す）: (A) パッケージ側で
リトライ / (B) CI 側だけでリトライ / (C) キャッシュを外れにくくする / (D) 何もしない。

---

## 2. 測ったこと

### 2.1 頻度 —— 直近5日・237 run 中、少なくとも3件（うち1件は2026-09-15の対象そのもの）

**【実測】窓**: `local` embedding 導入（ADR 0085, 2026-09-10）〜本日（2026-09-15）。

```
$ gh api "repos/takecchi/mnemora/actions/workflows/350579805/runs?per_page=100&created=>=2026-09-10" \
    -q '.total_count'
237
```

**方法**: まず `status=failure`（ワークフロー全体の結論が failure）で絞ると21 run。
これに、issue 本文が挙げた 2026-09-15 の対象 run（`34954794665`。**再実行で
`success` に上書きされたため、この `status=failure` の21件には含まれない**）を
加えた **22件**の check-run を、job 単位で確認した。

```
$ gh api "repos/takecchi/mnemora/actions/workflows/350579805/runs?per_page=100&created=>=2026-09-10&status=failure" \
    --paginate -q '.workflow_runs[] | {id, head_sha, created_at, head_branch}'
# 21 件
```

各 run の failed job 一覧を取り、`local` 埋め込みを使う5ジョブ
（`example-chat` / `root-gate-db-stage` / `identifier-probes` / `consolidation-cost`
の実体を含む job / `archive-sweep-cost`）に該当するものだけ、annotations を
`fetch failed` / `モデルを読み込めなかった` / `429` / `LocalEmbeddingProvider` で
grep した。

**⭐ 見つかった3件（22件中）:**

| 日時(UTC) | run | job | 症状 | cacheDir | 備考 |
|---|---|---|---|---|---|
| 2026-09-12 14:22–14:25 | `34699094705` | `root-gate-db-stage` | `Error (429) ... model_quantized.onnx` | **未指定（既定の場所）** | `ci.yml` のコメント・ADR 0107 が言及する当の事象と一致 |
| 2026-09-12 16:18–16:19 | `34704804772` | `example-chat` | `Error (429) ... model_quantized.onnx` | **未指定（既定の場所）** | 枝 `fix/local-embedding-cache-pair-tooth-164`——ADR 0107/Issue #164 の作業枝そのもの |
| 2026-09-15 09:51–09:53 | `34954794665`（**後に再実行で success**） | `example-chat` | `cause: fetch failed`（429ではない） | **`/home/runner/.../.cache/local-embedding`（cache 配線済み）** | issue 本文の対象。**§2.2 で詳述** |

**⚠ 2件が `HTTP 429`（レート制限）であることは、Issue #261 の本文を書いた時点では
想定していなかった。** issue 本文は「フェッチが1回失敗する」という一般形で
書かれており、その原因を「一時的なネットワーク断」のように読める書き方をして
いたが、**実際に見つかった3件のうち2件は 429（レート制限）、1件は 429 以外の
汎用 `fetch failed` だった。⟹ 故障モードは1つではない。**

- **本 ADR のリトライ（指数バックオフ + jitter）は、429 を特別扱いしていない**
  ——`kind` の付いていない失敗として、他のネットワーク失敗と同じ経路で
  リトライする。
- **指数バックオフ + jitter が 429 に対して十分か、それとも 429 は別の扱い
  （応答の `Retry-After` ヘッダを読んで、それに従って待つ）が要るのかは、
  本 ADR では決めていない。** `@huggingface/transformers` が 429 の応答から
  `Retry-After` を読めるようにする・読み取れるようにする改修は行っていない
  （§8「これが覆るとしたら」も見ること）。

**⭐ この repo で「CI の履歴から失敗率を数える」作業すべてに掛かる系統誤差
（この ADR 固有の話ではない）:**

1. **再実行（rerun）は、run 全体の `conclusion` を上書きする。**
2. **⟹ 履歴から数えた失敗率は、必ず下限になる**（緑に上書きされた回を取りこぼす）。
3. **⟹ 正しく数えたいなら、run ではなく個々の job の attempt を見る必要がある。**

**⚠ この3件/22件という数字は、実際の発生数の下限であり上限ではない。** 理由:
**GitHub Actions の再実行は、ワークフロー全体の `conclusion` を上書きする。**
2026-09-15 の対象 run 自身が良い証拠——`status=failure` で絞る方法ではこの回を
一度も拾えない（実際に拾えなかった。issue 本文と check-run 番号を直接指定して
初めて見つかった）。**同種の「後で緑になった」失敗が、237 run のうち他にも
埋もれている可能性がある。** それを完全に数えるには 237 run すべての
job 単位の履歴（再実行された attempt を含む）を確認する必要があり、
**この作業ではそこまでは行っていない**（API 呼び出し量が大きく、今回の
作業時間内では割に合わないと判断した）。

**⟹ この系統誤差は #261 に限らない。** 今後この repo の誰かが「この故障は稀だ」
「この test は N 回に1回落ちる」と `status=failure` や `gh run list` の結論から
数えるたびに、同じ理由で実際より低く出る。**run 単位の集計を見たら、それが
下限であることを思い出すこと。**

**⟹ 「稀」は推測のままだが、ゼロではないことは3件の現物で示された。**
2026-09-10（`local` 導入）〜2026-09-15 の5日間で3件（うち2件は同日 09-12 に
連続、1件が本 issue の対象 09-15）——**頻度として無視できる域ではない**という
心証は持てるが、分母（このパターンに晒される job-run の総数）を正確に出せて
いないため、割合としての数字は出さない。

### 2.2 キャッシュを外した理由 —— 少なくとも2026-09-15の回は「外れて」いない

**【実測】対象 job のログ**（`gh api repos/takecchi/mnemora/actions/jobs/104334134266/logs`）:

```
2026-09-15T09:52:05Z ##[group]Run actions/cache@v6
2026-09-15T09:52:05Z   path: .../.cache/local-embedding
2026-09-15T09:52:05Z   fail-on-cache-miss: false
2026-09-15T09:52:05Z Cache hit for: local-embedding-ruri-v3-30m-q8-v1
2026-09-15T09:52:06Z Cache Size: ~27 MB (28767668 B)
2026-09-15T09:52:06Z Cache restored successfully
2026-09-15T09:52:06Z Cache restored from key: local-embedding-ruri-v3-30m-q8-v1
...
2026-09-15T09:53:31Z AssertionError: 重みを取得できなかったので、値は測っていない:
  LocalEmbeddingProvider: モデルを読み込めなかった（repo=sirasagi62/ruri-v3-30m-ONNX /
  dtype=q8 / cacheDir=/home/runner/work/mnemora/mnemora/.cache/local-embedding）。
  ... cause: fetch failed: expected false to be true
```

**⟹ この回は cache hit・restore 成功の直後に落ちている。** issue が挙げた
①（7日追い出し）②（PR枝スコープ）③（保存失敗）はどれも「directory 単位で
cache が当たらない」ことを前提にした候補だが、**directory 単位では当たっている
ことがログで確認できる。** ⟹ **この回に限れば、①②③のどれでもない。**
（`gh api .../actions/caches` でこの key の cache entry が `main` 上に実在し
`last_accessed_at` が2026-09-15当日まで更新されていることも確認した——
scope・存在そのものは問題ない。）

**では何が起きたか。【現物】ADR 0107（Issue #164、2026-09-13）が、まさにこの
状況を実測・特定していた:**

> **「warm なら `env.fetch` が0回」は成立しなかった。** …**`tokenizer_config.json`**
> …**毎回ちょうど1回**（`GET` + `Range: bytes=0-0`）。
>
> `AutoTokenizer.from_pretrained` はどのトークナイザファイルが存在するかを
> `get_tokenizer_files.js` の `get_file_metadata(modelId, 'tokenizer_config.json', {})`
> で判定する。**この呼び出しは空の `options` を渡しており、私たちが指定した
> `cache_dir` を運んでいない。** ⟹ `getCache(options?.cache_dir)` は
> `options.cache_dir === undefined` を受け取り、**transformers.js 既定の
> キャッシュディレクトリ**（`actions/cache` が温めている `cacheDir` とは
> **別の場所**）を見に行く。**cache_dir の温かさに関係なく、毎回のプロセス
> 起動で必ず1回**、Hugging Face への Range リクエストが発生する。

ADR 0107 自身がこの節の最後で予告していた:

> 次に 429 が再発したら、この経路（`tokenizer_config.json` への Range リクエスト）
> も容疑者に加えること。

**【推論】** 2026-09-15 の回は 429 ではなく汎用の `fetch failed` だが、
仕組みは同じ——**directory 単位で cache が hit しても閉じない、この1本の
Range リクエストが、何らかの一時的なネットワーク不調（DNS・TCP・タイムアウト等、
`fetch failed` は undici がこの種の低レベル失敗をまとめて表す文言である）に
当たった。**

**【実測】この作業env（ネットワーク到達可能）から、cold load が実際に何本の
HTTP 要求になるかを直接確認した**（`@huggingface/transformers` を素で呼び、
`cache_dir` に空の一時ディレクトリを指定）:

```
config.json / onnx/model_quantized.onnx / tokenizer.json / tokenizer_config.json
```

4本のファイルに分かれており、ADR 0107 が言う「重み本体・config・tokenizer.json は
warm なら0回、tokenizer_config.json だけ毎回1回」という切り分けと矛盾しない。

**確かめていないこと**: 2026-09-15 の actions/cache の tar の中身そのもの
（GitHub の cache API はメタデータしか返さず、内容を取得する経路が無い）。
⟹ 「directory の中身が実は不完全だった」という別の可能性を、この作業では
**積極的には排除していない**——ただし、ADR 0107 が特定した「warm でも1本だけ
必ず外へ出る」という既知の恒常的な経路だけで、観測（cache hit ログ＋その直後の
fetch failed）を過不足なく説明できるため、それ以上には踏み込んでいない。

**⟹ §3(2)への回答**: issue の3候補はどれも、少なくとも2026-09-15の回には
当てはまらない。実体は「候補④」——**キャッシュ設定の外側にある、
transformers.js 自身の実装に起因する、必ず起きる1本のネットワーク呼び出し**
であり、これは ADR 0107 の時点で既に発見・記録されていた（本 ADR はそれを
再発見したのではなく、実際の障害でそれが現実化した実例を確認した）。

---

## 3. 決定と、採らなかった案

### 採った案: (A) パッケージ側でリトライする

**§2.2 の結論から、(C)（キャッシュを外れにくくする）はこの故障モードの修正に
ならない**——キャッシュがどれだけ強くても、閉じない経路で起きた失敗だからである。
残るのは「その1本の失敗を吸収する」ことであり、吸収できる場所は
**その呼び出しを行っている場所（`createLocalEmbeddingPipeline` の内部、
つまり `LocalEmbeddingProvider#startLoad`）**だけである。

### 検討して採らなかった案: (B) CI 側だけでリトライする

- **粒度が粗い。** CI 側のリトライ（`nick-fields/retry` や warm-up ステップ
  + `continue-on-error`）は、失敗した**ステップ全体**（`test:db` 一式など）を
  やり直すことになる。実際に落ちているのは「1本の軽い Range リクエスト」
  であり、そのために DB を含む重いステップ全体を再実行するのは費用が不釣り合いに大きい。
- **5ジョブぶん、同じ配線を複製する必要がある。** `example-chat` /
  `root-gate-db-stage` / `identifier-probes` / `consolidation-cost` /
  `archive-sweep-cost` の5箇所に同じリトライロジックを置く・保守することになる。
- **npm で公開される側の消費者を救わない。** `@mnemora/local-embedding` は
  npm に公開されており（`packages/local-embedding/package.json`）、CI の外
  （オンプレ・別の CI・ローカル実行）で同じ経路を使う消費者は、CI 側の
  リトライの恩恵を一切受けない。**この故障モードは CI 固有ではない**
  （ADR 0107 が特定した経路は、CI かどうかに関係なく毎回起きる）。
- ⟹ **(A) のほうが同じ問題をより狭い場所で、より広い対象に対して直す。**

### `docs/roadmap.md` §5 へ送らなかった理由（`docs/autonomy.md` §3.1）

**これは技術的に決められる判断である。** 製品・事業・安全性の判断ではなく、
「ネットワーク越しに1回だけ取得する処理が、一時的な失敗を呼び出し側へ
そのまま投げるべきか、吸収してから投げるべきか」という設計判断であり、
**ネットワーク経由でリソースを取得するライブラリとして、リトライを持つことは
特に珍しい振る舞いではない**（`packages/openai` の HTTP クライアントが使う
SDK 自体、多くの場合リトライを持つ）。

**⚠ マネージャーの懸念（「CI の都合をライブラリの振る舞いに入れることになりうる」）
への回答**: 既定のリトライ回数・待ち時間は CI の事情（5ジョブ・cache key・429 の
挙動）を一切参照していない汎用の値（3回・指数バックオフ + jitter、200ms〜4000ms）
であり、コード上も CI を名指ししていない。README にも「CI の都合で足した
振る舞いではない」と明記した。**根拠は「CIで頻発するから」ではなく
「ネットワーク越しの取得が一時的に失敗するのは、CIの有無によらず起きうるから」
である。**

**誰の振る舞いが変わるか**: 公開 API の形は変えていない（`retry`/`sleep` は
既定値を持つ追加の任意オプションであり、破壊的変更ではない）が、**`retry` を
指定していないすべての呼び出し側**（この5つの CI ジョブを含む、`npm i` で
このパッケージを使う既存の全消費者）は、**読み込みが1回失敗しただけでは
`embed()`/`warmup()` が reject しなくなる**（既定で最大3回、合計で
数百ms〜数秒よけいに待ってから成功するか、それでも失敗すれば今までどおり
reject する）。旧来の「1回失敗したら即座に呼び出し側へ返す」挙動が欲しい
場合は `retry: { attempts: 1 }` で明示的に無効化できる。

### (D) 何もしない —— 採らなかった

Issue #258 が明記した理由がそのまま当てはまる: 間欠的な赤は
`docs/autonomy.md` §1 段1（最優先＝CI が赤い）の信号を鈍らせる。§2.1 で
3件の現物を示した以上、「稀だから受け入れる」を選ぶ根拠が弱い。

### 検討して採らなかった案（発展形）

- **transformers.js 自身を直す**（`get_tokenizer_files()` に `cache_dir` を運ばせる）:
  ADR 0107 が既に「この作業の範囲外」としている——サードパーティ依存の内部実装を
  fork/patch する話であり、保守コストがリトライよりはるかに大きい。リトライは
  この1つのバグに限らず、**その他の未知の一時的失敗にも効く**という利点もある。
- **4〜5ジョブの cache key 競合を `needs:` で直列化する**（ADR 0107「引き受けた負債」1）:
  これは**別の問題**（cold cache 時の同時取得レース）であり、本 ADR が対象とする
  「warm でも残る1本の Range リクエスト」とは独立している。**Issue #261 の範囲外**
  として触れていない（ADR 0107 が既にオーナー承認待ちの負債として記録済み）。

---

## 4. 実装

`packages/local-embedding/src/local-embedding-provider.ts`:

- `LocalEmbeddingRetryOptions { attempts?, delayMs? }` を追加。
- `DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS = 3`（合計試行回数、初回を含む）。
- `defaultLocalEmbeddingRetryDelayMs(attempt)`: 200ms 基準の指数バックオフ、
  4000ms で頭打ち、`Math.random()` による full jitter（同時に失敗した複数ジョブが
  揃って同じ瞬間に再試行し、また渋滞するのを避ける）。
- `LocalEmbeddingProviderOptions` に `retry?` と `sleep?`（待ちを実際に行う関数。
  `createPipeline` と同じ「テスト用の注入点」）を追加。
- `#startLoad()` を for ループにし、`createPipeline` が
  **`kind` の付いていない**失敗を返すたびに `sleep(delayMs(attempt))` を挟んで
  最大 `attempts` 回まで試す。**`kind` の付いた失敗（`isLocalEmbeddingProviderError`）は
  即座に再スロー**（今までどおり。ADR 0090 の判断を変えていない）。
  リトライを使い切って最後まで失敗したら、**最後の試行のエラー**を `cause` に
  乗せて `describeLoadFailure` で包む。
- `describeLoadFailure` は `attempts > 1` のとき「`N` 回試したが取得できなかった。」
  を文面に足す（`attempts === 1` のときは何も足さない——リトライを無効化した
  呼び出し側・既存のテストの文面と揃える）。

`packages/local-embedding/README.md`: オプション表に `retry` / `sleep` を追加し、
「読み込みは、種類の分かっていない失敗を既定で3回まで試す」節を新設して、
ADR 0107 の機序（キャッシュが効いていても閉じない1本のネットワーク呼び出し）を
要約し、「CI の都合ではない」ことを明記。

**`.github/workflows/ci.yml` は変更していない**（§3「採らなかった案」参照。
この故障モードに対して変更の必要が無いと判断した）。

---

## 5. 変異試験（`docs/autonomy.md` §2 の止まる条件）

**【実測】この器から実行。**

`packages/local-embedding/src/__tests__/local-embedding-provider.test.ts` に
`describe("読み込みの再試行 (Issue #261 / ADR 0141)")` を新設:

- **歯が実際に噛むことの直接証明**:「種類の分かっていない失敗は、既定の設定でも
  同じ `embed()` 呼び出しの中で吸収される」——`createPipeline` を1回目だけ
  失敗するよう注入し、**`retry` オプションを一切指定しない**（＝本番の既定値の
  まま）状態で、`embed()` が単独の呼び出しの中で成功することを確認した。
  「CIが何も指定しなくても直る」ことを直接示す歯である。
- 既定回数（3）を使い切ると失敗として返り、`createPipeline` の呼び出し回数が
  ちょうど3であること。
- `retry.attempts` で回数を変えられること（5を指定して5回であることを確認）。
- `retry.delayMs(attempt)` で指定した通りの時間だけ `sleep` を呼ぶこと
  （最後の失敗の後には待たないことも含む）。
- 最終的な失敗の `cause` が最後の試行のエラーであること。
- メッセージに試行回数が入ること（`attempts: 1` のときは入らないこと）。
- **`kind` の付いたエラー（`unknown_input_limit`）はリトライされず、
  `createPipeline` の呼び出しが1回だけであること**（ADR 0090 の決定を壊していないことの歯）。
- `defaultLocalEmbeddingRetryDelayMs` の境界（`attempt` が増えるほど上限が
  指数的に伸びる・4000ms で頭打ちになる）を、jitter があるため「範囲」として
  複数回試行で固定。

既存テスト4本（「読み込みに失敗しても、次の呼び出しで再試行できる」
「createPipeline が同期に throw しても…」「同時に来た8本が全部失敗しても…」
「包んでも、次の呼び出しで再試行できる」）は、**新しい既定のリトライが
テストの意図（#ready の畳み方・包み方であって、1回の読み込みの中の
リトライではない）を壊さないよう、`retry: { attempts: 1 }` を明示して
リトライを無効化した**（コメントで理由を明記）。

```
$ pnpm --filter @mnemora/local-embedding run test
 Test Files  5 passed | 2 skipped (7)
      Tests  83 passed | 15 skipped (98)
```

（skip の15件は `MNEMORA_LIVE_LOCAL_EMBEDDING` opt-in の live テストであり、
この作業でも有効化していない——本物の重みを毎回落とさない既存の規律のまま。）

**⛔ `.github/workflows/ci.yml` に変更は無い。** そのため
「CI 側の変更は手元で変異させて赤を見ることができない」という §6 の注意点は、
**この PR には適用対象そのものが無い**（差分が無い）。

**⚠ この作業env に DB は無い**（`docker`/`psql`/`postgres` 無し、`DATABASE_URL`
未設定）。`examples/chat` の DB テスト（`test:db`）・`root-gate-db-stage` は
この env で1回も実行していない。今回の変更は `packages/local-embedding` の
純粋なロジック（`createPipeline` の注入・リトライ）に閉じており DB を要しないため、
影響は無いと判断しているが、**実際に DB 込みの経路を走らせて確認してはいない**。

---

## 6. 確かめたこと

- Issue #261 本文・コメント全文（`gh issue view 261 --comments`）。
- `docs/autonomy.md` §2 / §2.1 / §3 / §3.1 / §4 / §5。
- ADR 0085（`local` 導入）・ADR 0107（Issue #164、cache warm でも1本残る
  ネットワーク呼び出しの実測）・`packages/local-embedding/README.md`。
- `packages/local-embedding/src/{local-embedding-provider,pipeline,errors}.ts` の全文。
- `node_modules/@huggingface/transformers` の `src/utils/hub.js` /
  `cache/FileCache.js` を読み、`FileCache.match()` が純粋なファイルシステム
  チェック（ネットワークを一切呼ばない）であることを確認した——
  ⟹ directory 単位の cache hit の後にネットワークが呼ばれるとしたら、
  それは「その個別のファイルが cache に無い」ときだけである。
- この作業env から、cold load が実際に4本のファイル取得
  （`config.json` / `onnx/model_quantized.onnx` / `tokenizer.json` /
  `tokenizer_config.json`）に分かれることを直接確認した（§2.2）。
- `gh api .../actions/caches` で、対象 cache key の entry が `main` 上に実在し
  `last_accessed_at` が当日まで更新されていることを確認した。
- 2026-09-15 の対象 job のログ全文を取得し、`Cache hit` → `Cache restored
  successfully` → その後の `fetch failed` の順序を確認した。
- 21件の `status=failure` run + 対象 run 計22件の job/annotations を確認し、
  3件の一致を見つけた（§2.1）。
- `git fetch origin main` 後、`gh pr list --state open` で他の並行 PR
  （#260 / #212）と本作業が重ならないことを確認した。
- `pnpm --filter @mnemora/local-embedding run typecheck` / `run test`、
  ルートの `pnpm run lint` / `run format:check` が緑であることを確認した
  （§7 の6つの門も参照）。

## 7. 確かめていないこと

- **正確な発生頻度（分母つきの割合）。** §2.1 の通り、再実行がワークフロー全体の
  `conclusion` を上書きするため、`status=failure` に頼る数え方は下限しか
  出せない。237 run すべての job 単位・全 attempt の履歴を確認していない。
- **2026-09-15 の cache tar の中身そのもの。** GitHub のキャッシュ API は
  メタデータしか返さず、中身を直接検査する経路が無い。「ADR 0107 の
  Range リクエスト経路だけで説明が付く」という結論は、それ以外の可能性
  （directory 自体が一部欠けていた等）を積極的に排除した上のものではない。
- **Hugging Face 側のレート制限の規則**（IP単位か runner 全体で共有か）。
  ADR 0107 から引き継いだ未確認事項であり、本 ADR でも埋めていない。
- **この変更を実際の CI に載せたときに、3件のような故障が本当に減るか。**
  この PR の CI 実測（§8）は1回の判定であり、それ自体が「以後も減った」
  ことの証明にはならない。
- **DB を要する経路**（`examples/chat` の `test:db`・`root-gate-db-stage`）。
  この作業env に Postgres が無く、走らせられない。
- **`sleep` を実時間で使う既定の待ち（`setTimeout`）が、実際の CI runner 上で
  意図通りに動くか。** ユニットテストではすべて `sleep` を注入して即時化しており、
  本物の `setTimeout` 経路そのものは（型で守られているだけで）実行時間込みで
  測っていない。

## 8. これが覆るとしたら

- **transformers.js が `get_tokenizer_files()` に `cache_dir` を運ぶよう修正されたら**
  （ADR 0107 が「これが覆るとしたら」で既に予告している）、warm 時のネットワーク
  呼び出しは0回になる。**そのときもリトライ自体は無駄にはならない**
  （cold load 時・その他未知の一時的失敗にも効く）が、「なぜ要るか」の主要な
  動機（§2.2）は薄れる——README の説明を合わせて見直すこと。
- **§2.1 の頻度を、237 run 全件の job 単位で数え直した結果、3件よりずっと多い
  （または実質ゼロに近い）ことが分かったら**、既定の `attempts`（3）・
  バックオフの強さ（200ms〜4000ms）を見直す材料にすること。
- **429 が再発し、かつリトライを使い切ってもなお失敗するようなら**、
  ADR 0107「引き受けた負債」1（4〜5ジョブの cache key 競合）を、
  `needs:` による直列化とあわせてオーナーに諮ること——本 ADR はそこへは
  踏み込んでいない。
- **429 が指数バックオフ + jitter だけでは繰り返し失敗するようなら**
  （§2.1 で見つかった2件はどちらも1回きりで、リトライを使い切る前に
  再発したかどうかまでは確かめていない）、**`Retry-After` ヘッダを読んで
  それに従って待つ扱いへ切り替えることを検討すること。**本 ADR は
  「429 を他の `kind` の付いていない失敗と同じ経路でリトライしてよいか」を
  決めておらず、**単に区別せずに同じ経路に乗せただけ**である——429 が
  ボトルネックとして再発したら、ここが最初に見直す場所になる。
- **`@mnemora/local-embedding` の消費者（CI 外）から「リトライが要らない・
  害になる」という報告が来たら**、`retry: { attempts: 1 }` で無効化できることを
  案内しつつ、既定値そのものを見直すこと。

## 9. 関連

Issue #261 / Issue #258（同族の1件目、PR #259）/ Issue #164（ADR 0107 の元issue）/
ADR 0085（`local` embedding provider の導入）/ ADR 0090（8192トークンの壁・
`kind` の付いたエラーを包まない判断）/
ADR 0107（cache が効いていることを実ふるまいで固定する — warm でも
`tokenizer_config.json` への Range リクエストは残る）/
ADR 0139（Issue #258 の実装、間欠タイムアウトの修正——同じ「間欠的な赤」の族）
