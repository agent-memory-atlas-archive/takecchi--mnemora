# ADR 0121: `archive-sweep-cost`/`time-term` の基準値を、CI 初回実測の artifact から作る（手元では書かない）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**（ADR 0088 / ADR 0094 / ADR 0119 / ADR 0120 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。CI の実測値そのものは【受】ではなく
  「CI が実測し、この repo にログ・artifact として残っている一次情報」として扱う——
  下記「測ったこと」でどちらの経路か毎回明示する。

---

## 文脈

[ADR 0119](./0119-archive-sweep-cost-bench.md)（`archive-sweep-cost`、Issue #209 / PR #220）と
[ADR 0120](./0120-time-term-probes-in-ci.md)（`time-term`、Issue #217 / PR #221）は、
どちらも同じ理由で基準値ファイルを作らずに終わっている。逐語(ADR 0119 決定6)【現物】:

> この作業環境に `DATABASE_URL`（本物の Postgres + pgvector）が無く…
> **実測せずに数値を書けば、それは捏造である。**…**初回 CI が出す artifact
> （`archive-sweep-cost.json`）を、後続の PR で基準値としてコミットすることを
> 想定している。**

ADR 0120 §5 も同じ約束を逐語で書いている【現物】。**この ADR がその後続である。**

**この2つの bench を1本の ADR で扱う理由**: どちらも「CI でしか測れない bench の
基準値を、手元で書かずに初回 CI の実測から取る」という**同じ1つの判断**が2箇所に
当たっているだけであり、判断の中身は bench ごとに変わらない。実装（配線するファイル・
ci.yml の該当ジョブ・wiring テストの当たり方）だけが bench ごとに違う。
2本に分けると同じ理由を2度書くことになり、`AGENTS.md`「複製した瞬間から正文と要約は
ずれ始める」と同じ種類の重複を ADR 自身が抱えることになる。

### この作業環境の制約（ADR 0119/0120 と同じ）

**Postgres も docker も無く、`DATABASE_URL` を用意できない。**⟹ `archive-sweep-cost`/
`time-term` をこの作業環境で実行することはできない。この ADR が基準値に書く数字は、
**この作業者が計算した値ではなく、main の CI が実測した値をそのまま複製したもの**である
（下記「測ったこと」）。

---

## 決めたこと

### 決定1: main の初回 CI run の artifact を、そのまま基準値ファイルにする

`gh run list --branch main` で `conclusion=success` の最新 run を確認し、
**run 34911117399**（headSha `fd6ee53296f63c053fedf3706d2ba831b6d8e655`、
`archive-sweep-cost`/`time-term` を含む全 check が `completed`/`success`）の artifact
`archive-sweep-cost`/`time-term` を `gh run download` で取得した。

- `examples/chat/archive-sweep-baseline.json`
- `examples/chat/time-term-baseline.json`

**手で数値を書いた欄は無い。**両ファイルとも、ダウンロードした JSON をプログラムで
読み込み、`provenance`/`_readme` を足しただけである（下記決定3）。

### 決定2: 体裁は既存3本（`consolidation-baseline.json`/`identifier-probe-baseline.json`/
`retrieval-baseline.json`）から学び、bench の構造に応じて使い分ける

既存3本を現物で読み、次の規律を確認した【現物】。

1. **`_readme`/`provenance`/`schemaVersion` を先頭に持つ。**`provenance` には
   `commit`/`measuredAt`/`how`（再現手順）/`database`/`providers`/`repeatRuns`/`note`
   を持たせる。この形自体は3本とも共通。
2. **本体（`_readme`/`provenance` 以降）は、実測 JSON の型をほぼそのまま写す。**
   ただし **診断用の per-probe 配列で、要約スクリプトの比較に使われないもの**は
   落とす——`consolidation-baseline.json` は `rounds[].recall.*.probes` を持たず
   `mean` だけを残し、これを明示の `note` で説明している。`archive-sweep-cost-summary
   -lib.mjs` の `validateBaseline` が `before`/`after` に対して `requireProbes: false`
   を採っているのも同じ設計意図である（ADR 0119 決定4/ADR 0119 現物）。
3. **本体が「比較の主単位そのもの」を配列で持つ場合（`retrieval-baseline.json` の `arms`・
   `identifier-probe-baseline.json` の `groups`）は、その配列を残す**——落とせば
   比較そのものが成立しない。

**この2つの bench はどちらの形に当たるかが違う**:

- **`archive-sweep-cost`**は `consolidation-cost` の姉妹（ADR 0119 決定3）であり、
  `before`/`after` フェーズの `store`/`recall.unbudgeted.mean`/`recall.budgeted[].mean`
  だけを比較する（`scripts/archive-sweep-cost-summary-lib.mjs` の `STORE_DIFF_FIELDS`/
  `MEAN_DIFF_FIELDS`）。⟹ `consolidation-baseline.json` と同じ規律で、
  `recall.unbudgeted.probes`/`recall.budgeted[].probes`（診断用、probe 単位の内訳）を
  落とし、`store`/`mean`だけを残した。
- **`time-term`**は逆に、`probes[]` それ自体が比較の主単位である
  （`scripts/time-term-summary-lib.mjs` の `diffProbe` は `probeId` ごとに
  `outcome`/`totalInScope`/`omittedKinds` を突き合わせる）。⟹ `retrieval-baseline.json`
  の `arms`/`identifier-probe-baseline.json` の `groups` と同じ規律で、`probes[]` を
  丸ごと残した。**`newer`/`older`/`freshnessRatio`/`decayRatio`/`totalRatio` のような
  比較には使われない連続値も、artifact をそのまま複製した以上そのまま残す**——
  ADR 0120 §3 が「連続値は JSON にはそのまま残す（丸めない）——比較には使わないが、
  artifact を見比べたい人のために捨てはしない」と書いた規律を、基準値ファイル側にも
  そのまま適用した(丸めていない・削っていない)。

**揺れる欄（`measuredAt`/`commit`）の扱い**: 既存3本はいずれも、実測 JSON の
`measuredAt`/`commit` をトップレベルにそのまま残し、`provenance.measuredAt`/
`provenance.commit` と重複させている。この重複は意図的な二重管理ではなく
——`provenance` は基準値ファイル固有の付帯情報（`how`/`database`/`repeatRuns` 等）を
持つための欄であり、`measuredAt`/`commit` は元の実測 JSON の型（`ArchiveSweepCostRunJson`/
`TimeTermRunJson`）が最初から持つ欄をそのまま複製しているだけである。この ADR も
同じ形を踏襲し、値を書き写す手作業を増やしていない（`node` スクリプトで
`src.measuredAt`/`src.commit` をそのまま転記した。下記「測ったこと」参照）。

### 決定3: `provenance` に「この作業者は実行していない」ことを明記する

既存3本の `provenance.how` は「この ADR の作業者が自分の手で打ったコマンド」を書いている
（ADR 0088/0094/0101 は全員、実際に自分の手で bench を実行してから基準値を作った）。
**この ADR は違う**——`provenance.how` に、`gh run download` で取得したこと・
この作業者はこの bench を一度も自分の手で実行していないことを明記した。
これは `docs/autonomy.md` §5「測ったこと」「確かめていないこと」「人から受け取った
前提」を分ける規律の、基準値ファイル自身への適用である。

### 決定4: `ci.yml` の summary 段に `--baseline` を配線する

`archive-sweep-cost`/`time-term` ジョブの summary ステップに
`--baseline examples/chat/<file>.json` を足した。既存の `consolidation-cost`/
`identifier-probes` ジョブと同じ形（`scripts/*-summary.mjs` はどちらも `--baseline`
省略可能な作りのままである——変更していない。ADR 0119/0120 が意図的にそう設計した
ものを、この ADR は使うだけである）。

### 決定5: CI wiring テストを実測どおりに更新する

`scripts/__tests__/ci-yml-time-term-wiring.test.mjs` は ADR 0120 の時点で
「`--baseline` はまだ渡していない」ことを固定する歯を持っていた。この歯は
**配線を変えた今、実測と食い違う**——`--baseline` を渡すようになったので、
その歯を「`--baseline` が実在する基準値ファイルへ配線されている」ことを固定する歯へ
置き換えた（`ci-yml-identifier-probes-wiring.test.mjs` と同じ形。基準値ファイルが
実在するので、`ci-yml-consolidation-wiring.test.mjs`——基準値がまだ無い時点で書かれ、
一時ファイルへ差し替えて走らせる形——ではなく、実在する本物のファイルをそのまま読ませる
`identifier-probes` 側の形を踏襲した）。

`archive-sweep-cost` 側には対応する `ci-yml-*-wiring.test.mjs` が無い
（ADR 0119「採らなかった案4」/「引き受けた負債3」に明記のとおり、ADR 0119 の時点で
意図的に作っていない）。**この ADR はその歯を新設しない**——`AGENTS.md`
「ついでに直さない」の規律に従い、この PR の範囲（基準値の配線）に留めた。
新設するかどうかは、`archive-sweep-cost` の `ci.yml` 配線そのものを検査する歯を
足すかどうかという、この ADR とは別の判断である。

---

## 検討して採らなかった案

1. **⛔ 基準値をこの作業環境で「それらしい」値を計算して作る。**
   却下。`DATABASE_URL` が無くこの bench を実行できない以上、値を書けば捏造になる
   （`docs/autonomy.md` §1.1、ADR 0119 決定6・ADR 0120 §5 が既にこの案を明示的に
   却下している）。

2. **⛔ CI を複数回走らせて run 間で一致するかを確認してから基準値にする
   （既存3本の `repeatRuns: 2` に倣う）。**
   見送った（却下ではなく後置）——既存3本の `repeatRuns: 2` は**同じ作業者が同じ
   ローカル環境で2回連続して実行した**ものであり、この作業環境ではその経路自体が
   無い（`DATABASE_URL` が無い）。CI を狙って複数回走らせる（例えば空コミットを
   複数回 push する）ことは技術的には可能だが、**マネージャー指示の対象範囲
   （「main の CI が出した artifact」1件を基準値にする）を超える**——2本目の run を
   取るかどうかは、この基準値作業そのものではなく「run 間の揺れをどこまで検証するか」
   という別の判断であり、下記「引き受けた負債」に委ねた。**ただし、この PR 自体の
   CI 実行が偶然の2件目の実測点になる**——下記「測ったこと」参照。

3. **⛔ `time-term-baseline.json` の `probes[]` から `newer`/`older`/連続値を削り、
   比較に使う欄（`outcome`/`totalInScope`/`omittedKinds`）だけを残す
   （`retrieval-baseline.json`/`identifier-probe-baseline.json` の「比較に使う欄だけを
   残す」規律を厳密に適用する案）。**
   却下。ADR 0120 §3 が明示的に「連続値は artifact にはそのまま残す（丸めない）」と
   決めており、基準値ファイルはこの CI run の artifact をそのまま複製したものである
   以上、artifact 側の規律と矛盾させる理由が無い。**比較に使われない欄を持つこと自体は
   実害が無い**（`validateBaseline` は余分な欄をエラーにしない。現物で確認した）。

4. **⛔ 帰属未決の Issue #217（ADR 0120 §0）をこの ADR で決める、または Issue #217/#209
   を close する。**
   却下。マネージャー指示が明示的に禁じている（「issue を close しない」「#217 は
   close も `Closes` も書かない」）。この ADR は配線と基準値の話だけをする——
   帰属判断は ADR 0120 が開いたまま残した通り、オーナー待ちである。

---

## 引き受けた負債

1. 🔴 **基準値は1 run の実測であり、run 間の揺れ幅を測っていない。**
   この ADR が使った2本の基準値は、main の CI の**1回の run**（34911117399）が
   出した artifact をそのまま使っている——同じ commit・同じ bench を2回走らせて
   一致するかを確認する、という手順を踏んでいない。**⟹ 将来この基準値と実測が
   相違したとき、それが「意図した変更による回帰」なのか「run 間で元々揺れる値」
   なのかを、この基準値ファイル単体からは区別できない。**

   **これは既存3本（`retrieval-baseline.json`/`identifier-probe-baseline.json`/
   `consolidation-baseline.json`）と同じ状態か、現物で確認した**——3本とも
   `provenance.repeatRuns` が `2`（または `"2回実行し…"`）であり、**基準値を
   コミットする前に、同じ作業者が同じローカル環境で2回実行し、`measuredAt`/`commit`
   を除いて完全一致することを確認してから基準値にしている。**⟹ **既存3本は
   この負債を持たない。この ADR が作る2本だけが持つ、既存より弱い状態である。**

   **ただし完全に無検証ではない**——このブランチ自身の CI 実行が、
   意図せず2件目の実測点になった（下記「測ったこと」に実際の比較結果を記載する。
   PR を ready にした後、CI の結果を見てから追記した）。

2. **⚠ `archive-sweep-cost`/`time-term` の bench コードそのものは、この ADR の作業では
   1バイトも変更していない。**この ADR が変更したのは基準値ファイル・`ci.yml` の
   summary 段・1本の wiring テストだけである。bench 自体の挙動
   （`decayFloorOffsetMs`/`fillerBackdateMs` の算術、`time-term` の `outcome` 判定）が
   正しいことは ADR 0119/0120 の検証に委ねている——この ADR では再検証していない。

3. **⚠ `archive-sweep-cost` 側に `ci.yml` の配線自体を検査する歯（`ci-yml-*-wiring
   .test.mjs` 相当）が無いままである。**ADR 0119 が「引き受けた負債3」として
   明記した穴であり、この ADR も塞いでいない（決定5）。誰かが `archive-sweep-cost`
   ジョブの summary 段から `--measured`/`--baseline` を取り違えても、
   `archive-sweep-cost-summary.test.mjs`/`-lib.test.mjs`（入力を自分で作る歯）は
   気づかない。

4. **⚠ `archive-sweep-baseline.json` の `before`/`after` フェーズの `store`/`mean` が、
   run を跨いで厳密に安定しているかどうかは実測していない。**`time-term` の `outcome`
   と違い、`archive-sweep-cost` の比較対象は連続値の平均（`usageChars`/
   `recalledActiveShare` 等）である。`deterministic` LLM + `local` embedding + 固定
   probe/haystack という構成上、run 間で揺れる理由は無いはずだが（`decay`/`freshness`
   のような時刻依存の項は比較対象に含まれていない。ADR 0119 決定4/`MEAN_DIFF_FIELDS`
   参照）、**この推論は式の構造からの類推であり、実際に2回の CI run を比較して
   確認したわけではない**（負債1と同根。下記「測ったこと」の追記を見ること）。

---

## これが覆るとしたら

- **基準値と実測が実際に相違し、それが「回帰」か「揺れ」か分からずに困る場面が
  実際に起きたとき。**そのとき負債1が実害になる——CI を複数回走らせて揺れ幅を
  実測し、許容誤差なり「揺れやすい欄」の一覧なりを basline の `provenance` に足す
  判断が要る。
- **`archive-sweep-cost` 側に `ci.yml` の配線を検査する歯を足す PR が出たとき。**
  そのとき負債3は塞がる。
- **Issue #217 の帰属判断（ADR 0120 §0）が下ったとき。**この ADR 自身は無関係だが、
  `time-term-baseline.json` の存在自体が「#217（または #109）の受け入れ条件を
  満たしている」という主張の材料になりうる——その判断はオーナーが行う。
- **`archive-sweep-cost`/`time-term` の bench コードが変わり、基準値が意図して
  更新されたとき。**そのとき、この ADR が確立した「CI の artifact をそのまま
  基準値にする」手順を再実行すればよい——専用スクリプトは無いが、この ADR の
  「測ったこと」に書いた手順がそのまま再現手順である。

---

## 測ったこと

**【実測】main の CI run を確認した:**

```
gh run list --branch main --limit 8 --json databaseId,headSha,conclusion,status,createdAt,name
```

最新の `conclusion=success` は `databaseId=34911117399`、
`headSha=fd6ee53296f63c053fedf3706d2ba831b6d8e655`。

**【実測】この run の全 check が成功していることを確認した:**

```
gh api repos/takecchi/mnemora/commits/fd6ee53296f63c053fedf3706d2ba831b6d8e655/check-runs \
  --jq '.check_runs[] | "\(.name): \(.status)/\(.conclusion)"'
```

`archive-sweep-cost`/`time-term` を含む11個の check がすべて `completed`/`success`。

**【実測】artifact を取得した:**

```
gh run download 34911117399 -n archive-sweep-cost -D /tmp/art
gh run download 34911117399 -n time-term -D /tmp/art
```

取得した2ファイルを目で読んだ。`archive-sweep-cost.json` は `sweep.archivedCount: 60`
（対象60件すべてを掃引済み）・`after.recall.unbudgeted.mean.omittedArchivedCount: 60`
（掃引前は0）——**掃引が実際に発火し、受け入れ条件の1つ（omittedの0→正の遷移）が
実測で満たされていることを確認した。**`time-term.json` は8 probe すべてが揃っており、
`commit` フィールドは両ファイルとも `fd6ee53296f63c053fedf3706d2ba831b6d8e655`
（headSha と一致）。

**【実測】基準値ファイルを組み立て、要約スクリプトで検証した:**

`node` の小スクリプトで、ダウンロードした JSON を読み込み、`archive-sweep-cost.json`
は `before`/`after` の `recall.*.probes` を落として `mean` だけ残し、`time-term.json`
は `probes[]` をそのまま複製し、それぞれに `_readme`/`provenance` を足して
`examples/chat/archive-sweep-baseline.json`/`examples/chat/time-term-baseline.json`
として書き出した(手で数値を打った箇所は無い)。`pnpm exec prettier --write` で
既存ファイルと同じ整形にした。

```
node scripts/archive-sweep-cost-summary.mjs \
  --measured /tmp/art/archive-sweep-cost.json \
  --baseline examples/chat/archive-sweep-baseline.json
# => ✅ 一致(差分なし)

node scripts/time-term-summary.mjs \
  --measured /tmp/art/time-term.json \
  --baseline examples/chat/time-term-baseline.json
# => ✅ 一致(差分なし)。全 probe で outcome / totalInScope / omittedKinds が
#    examples/chat/time-term-baseline.json と同じだった。
```

**同じ artifact を基準値と実測の両方に使っているので、この一致は「基準値が
artifactを正しく複製できているか」の検算であり、「run 間で値が安定しているか」の
検証ではない**（負債1参照）。

**【実測】6つの門**（この作業環境で）:

- `pnpm run typecheck` → 緑
- `pnpm run lint` → 緑
- `pnpm run format:check` → 緑
- `pnpm run test` → 緑。ただし「DB テストは実行していません」と明示して通っている
  （`docs/autonomy.md`/ADR 0015 の仕様どおり。**DB 側は判定不能**）。
- `pnpm run build` → 緑
- `pnpm run pack:check`（`rm -rf packages/*/dist && pnpm run build` 後）→ 緑

**【実測】変異試験**（`docs/autonomy.md` §2「歯が実際に噛むことを、変異試験で示した」）。
変異前に `/tmp/mutation-backup-0121/` へ `cp` で退避コピーを取り、変異・実行・
コピーからの復元・再実行の順で確認した（`git checkout` は使っていない）。

1. `examples/chat/archive-sweep-baseline.json` の `before.store.activeCount` を
   `74` から `1` に変異 → `node scripts/archive-sweep-cost-summary.mjs --measured
   /tmp/art/archive-sweep-cost.json --baseline examples/chat/archive-sweep-baseline.json`
   の出力が「✅ 一致」から「⚠ 相違した...」＋`store.activeCount` の行へ変わった
   （exit code は0のまま——門ではない設計どおり）。復元後、「✅ 一致」に戻った。
2. `examples/chat/time-term-baseline.json` の `probes[0]`（`half-life`）の `outcome`
   を `"newer-ranked-higher"` から `"tied"` に変異 → `node scripts/time-term-summary.mjs
   --measured /tmp/art/time-term.json --baseline examples/chat/time-term-baseline.json`
   の出力が「✅ 一致」から「⚠ 基準値と相違した probe が 1 件ある」＋`### half-life`
   セクションへ変わった。復元後、「✅ 一致」に戻った。
3. `scripts/__tests__/ci-yml-time-term-wiring.test.mjs` が新設した3本の歯
   （`--baseline` の配線・`validateBaseline`・`validateMeasured`）について、
   `.github/workflows/ci.yml` の `time-term` ジョブの summary 段の `--baseline` を
   存在しないパス（`time-term-WRONG.json`）へ変異 → 該当テストが赤くなった
   （`summaryStepBaselinePath()` が期待するパスと食い違う）。復元後、緑に戻った。

**【実測】root の `npx vitest run`**（scripts 配下含む全体）: 810件すべて緑
（`ci-yml-time-term-wiring.test.mjs` の更新後14件を含む）。

## 確かめていないこと

- **`archive-sweep-cost`/`time-term` を、この作業者自身が本物の Postgres に対して
  実行したこと。**この作業環境に `DATABASE_URL` が無いため、一度もできていない。
  基準値の数字はすべて main の CI（run 34911117399）が実測したものであり、この ADR の
  作業者が計算した値ではない。
- **基準値と実測の run 間の揺れ幅**（負債1・負債4）。
- **このブランチの CI が実際に green で終わること。**PR を ready にした後、
  CI の結果を別途確認する。
- **`archive-sweep-cost` の `ci.yml` 配線自体を検査する歯を新設するかどうかの判断**
  （負債3）——この ADR の範囲外として意図的に見送った。

## 人から受け取った前提（出所付き）

- ADR 0119 / ADR 0120 の内容——この repo の `docs/decisions/` から直接読んだ【現物】。
- Issue #209 の受け入れ条件・Issue #217 の帰属未決——ADR 0119/0120 が引用したものを
  further に又引きせず、`docs/decisions/` の該当ファイルから直接読んだ【現物】。
