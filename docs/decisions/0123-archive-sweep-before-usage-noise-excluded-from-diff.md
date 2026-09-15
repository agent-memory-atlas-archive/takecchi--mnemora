# ADR 0123: `archive-sweep-cost` の `before` 段 `usage*` を、基準値との厳密等価の比較から外す(比較には数えない・表示は残す)

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**(ADR 0088 / ADR 0119 / ADR 0121 の体裁を踏む)。

- **【実測】** — この ADR の作業者が自分の手で確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — [Issue #223](https://github.com/takecchi/mnemora/issues/223) の本文・コメント(オーナー本人が既存 CI artifact を実測して投稿したもの)として受け取った。この作業者が再導出した数値ではない。

---

## この summary は何を捕まえるためのものか

[ADR 0119](./0119-archive-sweep-cost-bench.md) の `archive-sweep-cost` bench が測ろうとしているのは、[Issue #209](https://github.com/takecchi/mnemora/issues/209) の受け入れ条件——掃引(`Runtime.sweepArchive`)が実際に北極星の物差しへ効くかどうかである。具体的には次の2つ:

1. **掃引が「載る量」を減らすようになったこと。**`recall().usage.chars` が掃引前後で減っているか。
2. **掃引で想起の質が落ちるようになっていないこと。**`goldRank` が悪化していないか。

**この2つはどちらも大きな効果として現れる【実測】**(基準値ファイル `examples/chat/archive-sweep-baseline.json` / Issue #223 コメントで確認できる数字):

- `usageChars`(unbudgeted): `before` **4303.857142857143** → `after` **665**(基準値ファイル `examples/chat/archive-sweep-baseline.json` 実測。約84.5%減)。
- `goldRank`(unbudgeted): `before` **1.2857142857142858** → `after` **1.2857142857142858**(不変)。

`archive-sweep-cost-summary.mjs` の Job Summary は、この2つの効果を基準値と突き合わせて「今回も同じか」を人に見せるための道具である(ADR 0119 決定5「門にしない」——標本が probe 7件であり、`retrieval-quality`/`consolidation-cost` と同じ理由で CI を落とす閾値には使わない)。

---

## 文脈: Issue #223 が報告した揺れ

[Issue #223](https://github.com/takecchi/mnemora/issues/223) は、`archive-sweep-cost` の基準値(`examples/chat/archive-sweep-baseline.json`、[ADR 0121](./0121-bench-baselines-from-ci-artifacts.md) が main の CI run `34911117399` の artifact から作成)を、別の CI run `34912729977`(PR #222 head)の artifact と突き合わせたところ、`before` 段の `usageChars`/`usageEstimatedTokens`/`usageIndexChars` だけが厳密には一致せず、Job Summary が「⚠ 基準値と相違した箇所がある」を出すことを報告した。

Issue #223 のコメントは、この観測を **7 run**(main の push 2件 + PR #220/#222 の途中経過を含む pull_request 5件)へ広げて再検算しており【受】、次を確認している:

- **動いた欄**: `before` phase の `usageChars`/`usageEstimatedTokens`/`usageIndexChars` のみ(`mean` レベル30欄・`probes[]` レベル7 probe とも)。
- **動かなかった欄**: `after` phase の全欄(1バイトも動かず)、`before.store.*`、トップレベル全欄、`sweep.*`、`goldRank`/`goldRankExcludedCount`/`carriedCount`/`carriedDigestTokens`/`totalInScope`/`recalledActiveShare`/`omittedArchivedCount`(前後とも)。
- **揺れ幅**: `before.recall.*.mean` の30欄で、相対差(絶対差/基準値)は **0.2648%〜1.2671%**。絶対差は 9.14〜41.0。

⟹ **捕まえたい効果(約85%減、不変の goldRank)と、この揺れ(0.26%〜1.27%)は2桁違う。**

---

## 決めたこと

### 決定1: `before` 段の `usageChars`/`usageEstimatedTokens`/`usageIndexChars` を、基準値との厳密等価の比較(mismatch のカウント)から外す

この揺れは、捕まえたいものと同じ桁では動かない。厳密等価でそこに⚠を出し続ける機械は、捕まえたいものを捕まえず、読み飛ばしを育てるだけである——「毎回⚠が出るが、どうせ揺れだ」という状態は、本物の回帰が来ても同じ見た目で出る(Issue #223 が明示的に警告している通り)。

**実装は `time-term-summary-lib.mjs` と同じ層に置く。** `time-term-summary-lib.mjs` は `freshnessRatio`/`decayRatio`/`totalRatio` を「壁時計時間にわずかに依存する連続値であり、厳密等価で比べると常に『相違あり』になる」として、**比較対象の欄リスト(`DIFF_FIELDS`)そのものから外している**(`diffProbe` はこのリストしか読まない)——比較関数を分岐させたり、差分を無視するフラグを足したりはしていない。この ADR も同じ形にする: `archive-sweep-cost-summary-lib.mjs` の `diffPhase` が実際に比較する mean の欄リストを、`label`(`"before"`/`"after"`)に応じて `meanDiffFieldsForLabel(label)` で選び、`before` のときだけ `usageChars`/`usageEstimatedTokens`/`usageIndexChars` を除いたリストを使う。

**除外の範囲は `before` 段だけである。** `after` 段の `usage*` は除外しない——7 run で不動という前提が崩れたら、まずここで検知できるようにする(「これが覆るとしたら」参照)。

### 決定2: ただし「捨てる」のではない。値は summary にも表示する(`time-term` とはここだけ違う形にする)

`time-term-summary-lib.mjs` は `freshnessRatio`/`decayRatio`/`totalRatio` を比較からもJob Summary の表からも外している(`buildProbeRow` は `outcome`/`totalInScope`/`omittedKinds` しか印字しない)——これらは artifact(機械可読 JSON)には残るが、summary を読むだけの人からは見えない。

**`archive-sweep-cost` の `before.usageChars` はこの脇役の値と同じではない。** Issue #209 の受け入れ条件1(「掃引で載る量が減ったか」)そのものに使われる中心的な値であり、`freshnessRatio` のように「artifact にだけ残せばよい」とは言えない。⟹ この3欄は**比較(mismatch のカウント)からは外すが、Job Summary には基準値と実測を並べた表として残す**(`buildBeforeUsageInfoSection`、`collectBeforeUsageInfoRows`)。回帰が実際に起きても、人が表の数字を読めば気づける形にする——「引き受けた負債」参照。

### 決定3: 基準値ファイル(`examples/chat/archive-sweep-baseline.json`)の `before.usage*` は削らず残す

`time-term-baseline.json` の先例を現物で確認した【現物】(ADR 0121 決定2 逐語): 「`newer`/`older`/`freshnessRatio`/`decayRatio`/`totalRatio` のような比較には使われない連続値も、artifact をそのまま複製した以上そのまま残す」。この基準値ファイルは CI が実測した artifact をそのまま複製したものであり、比較に使わない欄を削る理由が無い(`validateBaseline` は余分な欄をエラーにしない——`time-term` 側で既に現物確認済みの規律を、この bench にもそのまま適用する)。

⟹ `archive-sweep-baseline.json` の `before.recall.*.usageChars`/`usageEstimatedTokens`/`usageIndexChars` は**そのまま残す**。`_readme`/`provenance.note` に、この3欄が ADR 0123 により比較から除外されている旨を追記した(値自体は変更していない)。

---

## 検討して採らなかった案

Issue #223 が提示した4案のうち、マネージャーが採らなかった3案と、その理由(次に同じ検討をする人がやり直さずに済むように、全部書く)。

1. **⛔ 案2: 許容幅を持たせる(例: 相対0.5%以内なら一致とみなす)。**
   却下。幅の根拠が無い——7件の標本から幅を決めるのは [ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §3(「標本7件からは失敗率も成功率も統計的に主張しない」)が禁じている形そのものである。しかも 0.5% では既に足りない——Issue #223 の実測では、7件の標本だけで相対差が0.5%を超える欄が複数ある(`budgeted[8].usageEstimatedTokens`=1.228%、`budgeted[256/512].usageEstimatedTokens`=1.267% など、最大は **1.267%**)。

2. **⛔ 案3: 前後の差だけを比較する(`after - before`)。**
   却下。**実測が否定した。** `after` 段が7 run すべてで不動なので、`before - after` の揺れ幅は `before` 単独の揺れ幅と数式的に一致する——Issue #223 は `unbudgeted.usageChars` で実際に検算しており、`before` の絶対差 **11.429** に対し `before - after` の絶対差も **11.429** で一致することを確認している。「差なら相殺するだろう」という直感は、この標本では成り立たない。

3. **⛔ 案4: 複数 run から基準値を作る(既存3本の `provenance.repeatRuns: 2` に揃える)。**
   却下。厳密等価の問題を解かない——何 run から基準値を作っても、次の run はまた違う値を出す(この bench の `usage*` は run ごとに異なる連続値であり、有限個の run から作った基準値と「一致する」ことを期待できる性質のものではない)。既存3本の `repeatRuns: 2` は「同じ作業者が同じ環境で2回実行し、完全一致することを確認してから基準値にする」という**規律**であり、これは「一致することを確かめる」ためのものであって、**そもそも run ごとに一致しない量**に対しては成立しない。加えて、この案を実行するには CI を余分に走らせる費用も生む。

---

## 引き受けた負債

1. 🔴 **`before.usage*` の回帰は、機械では捕まらなくなる。人が summary の表を読んで気づくしかない。**
   `diffPhase` はこの3欄を before 段では比較しないため、意図しない劣化(例: 掃引前の recall ロジックの変更で `usageChars` が大きく増える等)が起きても、Job Summary の「基準値との差分」節は ✅ のまま黙る。**ただし** この summary はもともと門ではなく人が読むもの(ADR 0088 §2 / ADR 0119 決定5)であり、桁違いの変化なら `buildBeforeUsageInfoSection` の表に出た数字で見える——「捕まえたい効果と同じ桁の変化」は、この表を見れば人の目に留まる設計である。**桁が近い(1桁未満の)劣化は、この設計では捕まらない。**

2. **⚠ 「揺れが実際に0.2648%〜1.2671%である」という根拠は、この作業者自身が実行して確かめたものではない【受】。**
   Issue #223 のコメントに書かれた測定(既存 CI artifact 7件の突き合わせ)をそのまま引いている。この ADR の作業者は新しく CI を走らせていない(マネージャー指示により禁止されている)。既存 artifact 2件(`34911117399`/`34912729977`)を使った検算は別途行った(下記「測ったこと」)。

3. **⚠ `before` 段の他の欄(`carriedCount`・`goldRank` 等)や `after` 段が今後揺れ始めた場合、この ADR の除外範囲では捕まえられない。**
   これは意図した設計である(「これが覆るとしたら」参照)が、負債として明記する——除外は `before.usage*` の3欄に限定されており、それ以外の欄が新たに揺れ始めても、この PR の変更は何もしない。

---

## これが覆るとしたら

- **`after` 段・`sweep.*`・`store.*`・`goldRank` も揺れ始めたとき**(「安定している」という前提そのものが崩れたとき)。そのときは `before` だけを特別扱いする理由が失われ、除外の設計全体を見直す必要がある。
- **`before.usage*` の揺れ幅が、捕まえたい効果(約85%減・goldRank不変)と同じ桁まで大きくなったとき。**そのときは除外ではなく、bench 自体(母集合サイズ・decay の算術)を見直す必要がある。
- **8件目以降の run で、除外していない欄(`goldRank` 等)が実際に動いたとき。**その時点で「動くのは `usage*` だけ」という前提を再検証する必要がある。

---

## 測ったこと

**【現物】** `scripts/time-term-summary-lib.mjs` を読み、`freshnessRatio`/`decayRatio`/`totalRatio` の除外が `DIFF_FIELDS`(比較対象の欄リスト)そのものから外す、という層で実装されていることを確認した(`diffProbe` は `DIFF_FIELDS` しか読まない)。`archive-sweep-cost-summary-lib.mjs` の `diffPhase` も同じ層(比較対象の欄リストを選ぶ関数 `meanDiffFieldsForLabel`)で実装した。

**【現物】** `docs/decisions/0121-bench-baselines-from-ci-artifacts.md` 決定2を読み、`time-term-baseline.json` が比較に使わない連続値(`freshnessRatio` 等)を削らずそのまま残していることを確認した。`archive-sweep-baseline.json` の `before.usage*` も同じ規律で残した(値は変更していない。`_readme`/`provenance.note` にのみ追記した)。

**【実測】既存 artifact 2件との突き合わせ**(⛔ 新しく CI は走らせていない。`gh run download`/既存ファイルのみ使用):

```
gh run download 34911117399 -n archive-sweep-cost -D /tmp/s1   # 基準値の出所
gh run download 34912729977 -n archive-sweep-cost -D /tmp/s2   # Issue #223 が使った別 run
node scripts/archive-sweep-cost-summary.mjs --measured /tmp/s2/archive-sweep-cost.json \
  --baseline examples/chat/archive-sweep-baseline.json
```

結果と、この PR を当てる前後の比較は PR 本文に記載する。

**【実測】変異試験**(`docs/autonomy.md` §2「歯が実際に噛むことを、変異試験で示した」)。変異前に `cp` で退避コピーを取り(`git checkout` による消失を避けるため)、以下を確認した。詳細と実際のコマンド・出力は PR 本文に記載する。

1. **除外したはずの欄(`before.usageChars` 等)で、基準値と実測をわざと違えても ✅ のまま黙ること。**
2. **除外していない欄(`after.usageChars`・`before.carriedCount`・`before.goldRank` 等)で、基準値と実測を違えると今も ⚠ が出ること。**

**【実測】6つの門**(この作業環境で、`DATABASE_URL` 無し。DB 側は判定不能——CI が実測の場になる)。結果は PR 本文に記載する。

---

## 確かめていないこと

- **本物の Postgres に対してこの bench を実行し、`before.usage*` が実際に0.2648%〜1.2671%の幅で揺れることを、この作業者自身が再現したこと。**この作業環境に `DATABASE_URL` が無く、Issue #223 が報告した数字をそのまま引いている(【受】)。
- **8件目以降の run を足したときに、この揺れ幅がどこまで広がるか。**Issue #223 自身も「7件の標本でこうだった」以上を主張していない(ADR 0033 §3 の規律)。
- **`before` だけが動く理由の因果**(母集合サイズが大きいほど順位境界の記憶が入れ替わる、という Issue #223 の推測)。この ADR は Issue #223 の観測(何が動き何が動かないか)だけを引いており、因果の検証はしていない。

## 人から受け取った前提(出所付き)

- Issue #223 の本文・コメント(7 run の実測・揺れ幅の数字)——この repo の Issue から直接読んだ【現物】。数値そのものはオーナーが実行した測定であり、この作業者は再導出していない【受】。
- ADR 0119 / ADR 0121 / ADR 0088 / ADR 0033 の内容——`docs/decisions/` から直接読んだ【現物】。
