# ADR 0133: `compare`(北極星の物差し)に基準値ファイルを足す — 実測で揺れなかったため、他5本と異なり⭐門にする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**(ADR 0088 / ADR 0094 / ADR 0121 の体裁を踏む)。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた(CI 経由を含む。
  この作業環境には `DATABASE_URL` が無いため、`compare` 自体は CI 上で実行させ、
  その artifact をこの作業者が取得・比較した)。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 文脈

**Issue #242**: `examples/chat` のベンチのうち、`compare`(mnemora/naive の文字数比。
`docs/north-star.md` が「使う側が会話ログを全部プロンプトへ積むのをやめられたか」の
物差しとして明示している値そのもの)だけに基準値ファイルが無く、退行が機械で
検知されない。他5本(`retrieval-baseline.json`/`identifier-probe-baseline.json`/
`time-term-baseline.json`/`consolidation-baseline.json`/`archive-sweep-baseline.json`)
には既に基準値がある(直近の後続は [ADR 0121](./0121-bench-baselines-from-ci-artifacts.md))。

Issue 本文は次を明示的に着手者へ委ねている(逐語)【現物】:

> **これを「門」にするのか「報告」に留めるのかは、着手する人が決めて ADR に理由を書くこと。**
> …**まず揺れるかどうかを実測すること。**`compare` は擬似 provider(`deterministic`)で
> 走るので決定論的に見えるが、それを現物で確かめずに閾値の門にしてはいけない。

**⟹ この ADR の中心的な作業は、issue が要求する実測(再現性の検証)と、その結果に
基づく決定である。**

### 🔴 issue 自身の前提のうち1つが誤りだった(実測で判明)

issue は「`compare` は擬似 provider(`deterministic`)で走る」と書いているが、
**これは事実ではなかった**。【実測】CI で得た `compare.json` artifact の
`llmMode`/`embeddingMode` はどちらも `"recorded"` だった(`"deterministic"` ではない)。

原因を `examples/chat/src/providers.ts`/`cli.ts` で確認した【現物】:
`runCompare()` は `resolveCassetteForRun("compare")` を呼び、`decideProviderSource`
(`providers.ts`)は `MNEMORA_PROVIDER_SOURCE` が未指定のとき「`OPENAI_API_KEY` が
無ければ `recorded`(理由: `no-key`)」を返す。`example-chat` ジョブには
`examples/chat/cassettes/compare.json`(ADR 0052 の `record:compare` が記録した、
実 OpenAI API の応答)が存在するため、鍵が無くてもこのカセットが再生される
——**擬似(内容を持たない)provider ではなく、記録済みの実 API 応答の再生である。**

`.github/workflows/ci.yml` の `compare` ステップに元々あったコメント
「このジョブで唯一 `OPENAI_API_KEY` を設定していないため、擬似 provider で走る」は
この意味で不正確だった。**この ADR の一部として、そのコメントを実際の挙動に
合わせて訂正した**(該当ステップそのものを触っている PR であり、「ついでに直した」
無関係な変更ではない——この誤りは、まさにこの ADR が主張する再現性の技術的根拠に
直結する)。

---

## 決めたこと

### 決定1: `examples/chat/compare-baseline.json` を新設し、CI 実測値を基準値にする

[ADR 0121](./0121-bench-baselines-from-ci-artifacts.md) と同じ手順——この作業環境に
`DATABASE_URL` が無いため、CI の artifact をそのまま基準値の本体にする(手で数値を
書いた欄は無い)。`_readme`/`provenance`/`schemaVersion` を先頭に持ち、本体
(`llmMode`/`embeddingMode`/`rowCount`/`rows`)は `MNEMORA_COMPARE_JSON` が吐く
`CompareRunJson`(`examples/chat/src/compare-json.ts`)をそのまま複製する
——`retrieval-baseline.json` の `arms`/`time-term-baseline.json` の `probes` と同じ
規律で、`rows` は比較の主単位そのものなので落とさず残す。

### 決定2: `examples/chat/src/compare-json.ts` で `MNEMORA_COMPARE_JSON` の出力口を足す

`retrieval-json.ts`(ADR 0088)/`time-term-json.ts`(Issue #217)と同じ分担・同じ規約
——純関数 `buildCompareJson` が `ComparisonRow[]`(`compare.ts`)から JSON を組み立て、
`cli.ts` の `runCompare()` が `MNEMORA_COMPARE_JSON` が設定されているときだけ書き出す
(未設定なら1バイトも挙動を変えない)。

### 決定3: ⭐ 他5本と異なり、これを門にする

**再現性を実測した**(下記「測ったこと」)——同一 commit で CI の `example-chat`
ジョブを2回実行し(1回目・rerun)、出力 JSON が `measuredAt` を除いて完全一致した
(12行すべて、`over_limit` による絞り込みが起きている大きい会話長の行も含む)。

⟹ 他5本を非ゲートにした ADR 0088/0094 の理由(decay/freshness が壁時計時間で揺れる
[ADR 0088 §2]、標本が小さく統計的な主張ができない [ADR 0033 §3])のうち、**前者は
この bench では実測上再現しなかった**。後者(標本の小ささ)は当てはまるが、ここで
問題になるのは「想起の質についての統計的な主張ができるか」であり、`compare` が
問うのは「この12点で、決定的な入力に対し機械的に同じ値が出るか」という**再現性**
であって、標本の小ささはこの問いを曖昧にしない。

**判定基準**(`scripts/compare-summary-lib.mjs` の `computeRegressions`):
基準値にある `turnCount` の行について、

1. `mnemoraShareOfNaiveChars` が基準値より**増加**(北極星の物差しの悪化)、または
2. `factStatementSurvived` が `true` → `false` に退行

のどちらかが起きたら退行とみなし、`scripts/compare-summary.mjs` は非0で終わる
(`.github/workflows/ci.yml` の `example-chat` ジョブが赤くなる)。それ以外の相違
(`naiveChars` の変化・新しい/消えた会話長など)は Job Summary に報告するのみで
exit 0 のままである。

### 決定4: `.github/workflows/ci.yml` の `example-chat` ジョブに配線する

`MNEMORA_COMPARE_JSON` を compare のステップに足し、summary ステップで
`compare-summary.mjs --measured … --baseline examples/chat/compare-baseline.json`
を実行、artifact をアップロードする。既存5本の作法(`--measured`/`--baseline`/
`if: always()`/`actions/upload-artifact@v6`)にそのまま揃える。**唯一の違いは
summary ステップの exit code の意味**(このステップだけ非0がジョブを実際に赤くする)。

---

## 却下した案

1. **⛔ issue の前提(`deterministic`)を鵜呑みにし、実測せず非ゲートにする。**
   却下——issue 自身が「実測せずに閾値の門にしてはいけない」と明示しており、
   実測なしで「揺れるはず」と決めるのは、確かめていないことを事実の顔で書く
   ことになる(`AGENTS.md`)。実際に実測したところ前提自体が誤りだった。

2. **⛔ 全欄(`naiveChars`/`totalInScope`/`omitted` 等)の厳密一致を門にする。**
   却下——`naiveChars` はシナリオ生成(`scenario.ts`)側の変更でも動きうるが、
   それ自体は北極星の物差しの悪化ではない。全欄一致を門にすると、北極星と
   無関係な変更のたびに CI が赤くなり、`docs/autonomy.md` §1.2 の「これを入れると
   何の数字が動くか」を判定基準から外れた理由で赤くする門になる。判定を
   `mnemoraShareOfNaiveChars`(北極星そのもの)と `factStatementSurvived`(削減の
   安全弁。README「削減率だけでは意味を持たない」節)の2つに絞った。

3. **⛔ 許容誤差(トレランス)を設けた閾値判定にする**
   (例: `mnemoraShareOfNaiveChars` が基準値の1.05倍を超えたら退行、等)。
   却下(今回は)——実測で2回の run が**完全一致**(誤差0)だったため、いま許容誤差を
   設ける根拠がない。将来 run 間で微小な揺れが実際に観測されたら、そのときに
   実測値をもとに許容誤差を導入する判断ができる(下記「これが覆るとしたら」)。
   いま推測で幅を決めると、それ自体が「確かめていないことを事実の顔で書く」
   ことになる。

4. **⛔ 新しい会話長(基準値に無い `turnCount`)・消えた会話長(基準値にあり実測に
   無い `turnCount`)も退行として扱う。**
   却下——`DEFAULT_COMPARE_SEQUENCE`(`compare.ts`)の変更は北極星の物差し自体の
   悪化ではなく、測る点の構成を変える別の判断である。会話長の構成を変える PR が
   自動的に赤くなる門は、`docs/autonomy.md` §3.1 が言う「製品の性格を決める判断」を
   機械的に強制することになり、この ADR の範囲を超える。

5. **⛔ ci.yml の `compare` ステップの「擬似 provider で走る」というコメントの
   誤りを直さず放置する。**
   却下——この ADR の技術的な主張(「一見 deterministic に見えるが実際は recorded」)
   の裏付けとなる箇所であり、直さずに残すと、この ADR 自身が読む人に誤った前提を
   撒くことになる。`AGENTS.md` の「ついでに直す」禁止は無関係な変更の混入を防ぐ
   ためのものであり、この訂正はこの ADR の主張と不可分である。

---

## 引き受けた負債

1. 🔴 **再現性の実測は2 run だけである。**同一 commit の CI を2回(1回目・rerun)
   実行して一致を確認したが、これは ADR 0088 §2 が `retrieval-quality` について
   行った「2回一致は決定的であることの証明ではない」という注意書きがここにも
   当てはまる。特に、`recall()` の既定の上限(`DEFAULT_RECALL_LIMIT`。
   `packages/core/src/recall.ts`)による絞り込みは `score.total`
   (`similarity × decay × tagMatch × freshness × strength`、
   `packages/core/src/recall-runtime.ts` の `scored.sort(...)`)の順位で行われ、
   `decay`/`freshness` は `deps.clock.now()`(実行時の壁時計時刻)を読む
   ——ADR 0088 §2 は `retrieval-quality` でこの項が実行ごとに(6桁目のオーダーで)
   動くことを実測している。`compare` の2 run が一致したのは、この揺れが
   ランキングの境界(上位10件に入るかどうか)を動かすほど大きくならなかった
   ためだと推測するが、**3回目以降の run でも同じ結果になる保証はない。**

2. ⚠ **カセット(`examples/chat/cassettes/compare.json`)の内容自体は、この ADR の
   作業では検証していない。**再現性は「同じカセット・同じコードに対して同じ値が
   出るか」を確認したものであり、カセットが再記録されたとき(`record:compare`)に
   同じ再現性が保たれるかは別途確認が要る。

3. ⚠ **退行の判定基準(`mnemoraShareOfNaiveChars` の悪化 / `factStatementSurvived`
   の退行)は、この2つで十分かを長期的に検証していない。**たとえば
   `totalInScope`/`annCandidateCount` が大きく変化しても `mnemoraShareOfNaiveChars`
   だけが偶然安定する、というケースをこの門は見逃す(Job Summary の報告には出る)。

4. ⚠ **ci.yml の compare ステップのコメント訂正は、この ADR が見つけた1箇所だけを
   直したものである。**他のジョブ・文書に同種の「実は recorded なのに deterministic
   と書いている」誤りが残っていないかは、この ADR の範囲では確認していない。

---

## これが覆るとしたら

- **3回目以降の CI run で `compare-baseline.json` と相違が実際に生じ、それが
  `docs/autonomy.md` の「揺れの範囲内」に見えたとき。**そのとき負債1が実害になる
  ——比較対象から `mnemoraShareOfNaiveChars`/`factStatementSurvived` を外す、
  許容誤差を導入する、あるいは非ゲートへ戻す、のいずれかの判断が要る。
- **`examples/chat/cassettes/compare.json` が再記録され、再現性が崩れたとき。**
  そのとき負債2が実害になる——基準値を更新する前に、再度2回以上の run で一致を
  確認する規律を明文化する必要が出る。
- **DB を用意できる環境が手に入り、この作業者自身が `compare` を複数回実行して
  再現性をより厳密に検証できるようになったとき。**そのとき負債1の確度が上がる。

---

## 測ったこと

**【実測】ブランチ・PR**: `issue-242-compare-baseline`(PR #244)。

**【実測】1回目の CI run**(`example-chat` ジョブ、commit
`d6a0092e8cdc31f821c0d89770080b5bd7d154d2`、run `34934113298`):

```
gh run download 34934113298 -n compare -D /tmp/compare-art-run1
```

`compare.json` の `llmMode`/`embeddingMode` はどちらも `"recorded"`。12行の `rows`
(`turnCount` 2/4/6/8/10/12/22/42/82/162/322/642)を得た。`turnCount=2` の
`mnemoraShareOfNaiveChars` は `4.183673469387755`(≒418.4%)、`turnCount=22` は
`0.5344202898550725`(≒53.4%)——issue 本文が引用した CI ログの数字と一致した。

**【実測】同一 commit の2回目の CI run**(同じ run 34934113298 の該当ジョブを
`gh run rerun 34934113298 --job 104268257172` で rerun。GitHub Actions 側の挙動として
これは run 全体を attempt 2 として作り直したため、実際には11ジョブすべてが
再実行された):

```
gh run download 34934113298 -n compare -D /tmp/compare-art-run2b
diff /tmp/compare-art-run1/compare.json /tmp/compare-art-run2b/compare.json
```

差分は次の1行だけだった:

```
3c3
<   "measuredAt": "2026-09-15T05:49:03.698Z",
---
>   "measuredAt": "2026-09-15T05:53:48.178Z",
```

**⟹ `measuredAt`(実行時刻そのもの)を除き、12行すべて・全欄が完全一致した。**
`over_limit` による絞り込みが起きている `turnCount` 42/82/162/322/642 の行
(`mnemoraChars`/`returnedCount`/`annCandidateCount`/`omitted` を含む)も一致した。

**【実測】基準値ファイルの組み立てと検証**:

1回目の artifact をそのまま `examples/chat/compare-baseline.json` の本体にし、
`_readme`/`provenance` を足した(手で数値を書いた欄は無い)。

```
node scripts/compare-summary.mjs \
  --measured /tmp/compare-art-run1/compare.json \
  --baseline examples/chat/compare-baseline.json
# => ✅ 一致(差分なし)。exit 0
```

**【実測】6つの門**(この作業環境で):

- `pnpm run typecheck` → 緑
- `pnpm run lint` → 緑
- `pnpm run format:check` → 緑
- `pnpm run test` → 緑。ただし「DB テストは実行していません」と明示して通っている
  (`docs/autonomy.md`/ADR 0015 の仕様どおり。**DB 側は判定不能**)。
- `pnpm run build` → 緑
- `pnpm run pack:check`(`rm -rf packages/*/dist && pnpm run build` 後)→ 緑

**【実測】変異試験**(`docs/autonomy.md` §2「歯が実際に噛むことを、変異試験で示した」)。
変異前に `/tmp/mutation-backup-0133/` へ `cp` で退避コピーを取り、変異・実行・
コピーからの復元・再実行の順で確認した(`git checkout` は使っていない)。

1. `examples/chat/compare-baseline.json` の `turnCount=2` の行の
   `mnemoraShareOfNaiveChars` を `4.183673469387755` から `0.1`(実測より小さい値=
   基準値から見て改善)に変異 → `node scripts/compare-summary.mjs --measured
/tmp/compare-art-run1/compare.json --baseline
examples/chat/compare-baseline.json` は「⚠ 相違した会話長が1件ある」を出しつつ
   **exit 0** のまま(改善は退行ではない)。復元後、「✅ 一致」に戻った。
2. 同じ行の `mnemoraShareOfNaiveChars` を `4.183673469387755` から `10`(実測より
   大きい値=悪化)に変異 → 同コマンドが `⭐ 北極星の物差しが1会話長で退行した` を
   stderr に出し、**exit 1** になった。復元後、exit 0 に戻った。
3. 同じ行の `factStatementSurvived` を `true` から `false` に変異 → 実測側は
   `true` のままなので基準値からは「false→true」であり退行ではない、
   exit 0 のまま(想定どおり)。逆に実測側の `factStatementSurvived` を `false` に
   変異させて再検査すると、`factStatementSurvived が true → false に退行` を
   出して **exit 1** になった。両方とも復元後、exit 0 に戻った。
4. `scripts/__tests__/ci-yml-compare-wiring.test.mjs` が新設した歯について、
   `.github/workflows/ci.yml` の `example-chat` ジョブの summary 段の `--baseline`
   を存在しないパス(`compare-WRONG.json`)へ変異 → 該当テストが赤くなった
   (`summaryStepBaselinePath()` が期待するパスと食い違う)。復元後、緑に戻った。

**【実測】root の `npx vitest run`**(scripts 配下含む全体): 全件緑
(`compare-summary-lib.test.mjs`(30)・`compare-summary.test.mjs`(17)・
`ci-yml-compare-wiring.test.mjs`(15)を含む)。

**【実測】`pnpm run test`**(ルート、`DATABASE_URL` 無し): 緑。「DB テストは
実行していません」と明示。`examples/chat` の純関数テスト
(`compare-json.test.ts` 含む)は DB 無しでも実行され、緑だった
(`examples/chat` の `test:db` スクリプトを直接叩いて確認。DB 依存テストのみ
`DATABASE_URL が設定されていません` で失敗し、それ以外は通った)。

## 確かめていないこと

- **`compare` を3回以上実行して、再現性がさらに安定しているかどうか**(負債1)。
- **`examples/chat/cassettes/compare.json` を再記録したときも同じ再現性が
  保たれるか**(負債2)。
- **`mnemoraShareOfNaiveChars`/`factStatementSurvived` 以外の欄が動くのに
  この2つだけが安定する、という退行のすり抜けが実際に起きるか**(負債3)。
- **他のジョブ・文書に同種の「実は recorded なのに deterministic と書いている」
  誤りが残っていないか**(負債4)。
- **この PR の CI が実際に緑で終わること。**`gh pr checks`/`ci-green-check.mjs`
  で別途確認する(`docs/autonomy.md` §2.1)。

## 人から受け取った前提(出所付き)

- Issue #242 の本文——`gh issue view 242` で直接読んだ【現物】。
- ADR 0088 / ADR 0094 / ADR 0121 の内容——`docs/decisions/` から直接読んだ【現物】。
- マネージャーからの作業指示(本 PR の背景・作業場所・報告様式)——委譲文として
  受け取った。技術的な決定(門にするかどうか・判定基準)はこの ADR が実測に基づき
  自分で決めたものであり、指示そのものではない。
