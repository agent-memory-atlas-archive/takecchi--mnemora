# ADR 0222: ⭐門 `compare` は、実測と基準値の `turnCount` 集合が一致したときだけ判定する（Issue #477）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（[ADR 0210](./0210-root-test-gate-runs-all-stages-regardless-of-failure.md) / [ADR 0215](./0215-ci-green-check-lower-bound-from-required-status-checks.md) と同じ体裁）。

- **【現物】** — この repo のコード・文書・設定を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 書き手が報告として受け取っただけで、自分では確かめていない。

---

## 問い

**⭐門 `compare`（[ADR 0133](./0133-compare-baseline-and-gate.md)）は、どういう条件で「退行が無い」と答えてよいか。**

## 🔴 破れていた形 —— 「比較していない」が「退行が0件」と同じ顔で出ていた

**【現物】** `scripts/compare-summary-lib.mjs` の `computeRegressions()` は、**実測の行ごとに**
基準値を `turnCount` で引き、引けなければ `continue` していた（逐語）:

```js
const base = baselineByTurn.get(row.turnCount);
if (!base) {
  continue;
}
```

⟹ **基準値に無い会話長は、1度も比較されないまま黙って読み飛ばされる。** 戻り値は
「退行した行の配列」だけなので、**呼び手には「比較して退行が無かった」と「そもそも
比較していない」が同じ空配列として届く。**

**【実測】陽性対照つきで撃った。** `main = dd9ec8e` を clone した作業木で、**コードを1バイトも
変えずに** lib を直接呼び、**同一の実測**に対して基準値の側だけを差し替えた（逐語の出力）:

```
実測 turnCount 集合: [2,4,6,8,10,12,22,42,82,162,322,642] (うち11行が退行)
validateMeasured.ok = true

--- 【陽性対照】基準値12行(現物)
  基準値 turnCount 集合: [2,4,6,8,10,12,22,42,82,162,322,642]
  validateBaseline.ok = true
  computeRegressions() = 11 件
  門(compare-summary.mjs の写し) = exit 1 (赤)
--- 【本題】基準値を turnCount=2 の1行だけにする
  基準値 turnCount 集合: [2]
  validateBaseline.ok = true
  computeRegressions() = 0 件
  門(compare-summary.mjs の写し) = exit 0 (緑)
--- 【本題2】基準値 rows: []
  基準値 turnCount 集合: []
  validateBaseline.ok = true
  computeRegressions() = 0 件
  門(compare-summary.mjs の写し) = exit 0 (緑)
```

⟹ ⭐ **陽性対照（11件検出＝赤）が同じ実測で出ているので、「0件」は「退行が無い」ではなく
「探り棒が母集合を取り損ねた」である。** そして `validateBaseline` は、1行の基準値も
空の基準値も `ok: true` で通す。

## ⭐ 決定

### 1. `computeRegressions()` を廃し、`computeComparison()` が「何を比較し、何を比較できなかったか」を返す

**退行の配列だけを返す関数を、意図的に残していない。** 呼び手が比較漏れを直視せざるを
得ない形にするためである。戻り値:

| 欄 | 何か |
| --- | --- |
| `comparedTurnCounts` | 両側に在って実際に突き合わせた会話長 |
| `regressions` | 退行した行（判定基準は ADR 0133 のまま。1バイトも変えていない） |
| `measuredOnlyTurnCounts` | 実測に在って基準値に無い＝**1度も比較していない** |
| `baselineOnlyTurnCounts` | 基準値に在って実測に無い＝**測る点が黙って減った** |

### 2. `evaluateCompare()` が `verdict: "pass" | "fail" | "indeterminate"` と `reason` を返す

**先例は `publish-run-coverage-lib.mjs` + `check-publish-run-coverage.mjs` に揃えた**
（[ADR 0207](./0207-dry-run-reads-existence-and-coverage-degrades-silently.md)）。**【現物】**
理由は分担が同型だからである —— `compare-summary-lib.mjs` は終了コードを
`compare-summary.mjs` に委ねる純関数の lib であり、`evaluatePublishRunCoverage` も
lib が `verdict` を返して CLI が 0/1/2 へ写す。

### 3. **判定してよいのは、2つの集合が一致したときだけ**

- 実測に在って基準値に無い `turnCount` が在る ⟹ `indeterminate`
- 基準値に在って実測に無い `turnCount` が在る ⟹ `indeterminate`（`ci-green-check` の
  「部分登録」と同じ窓。ADR 0215）
- 共通する `turnCount` が1つも無い ⟹ `indeterminate`（`publish-run-coverage-lib.mjs` の
  `groups.length === 0` と同じ形）

⚠ **集合が一致しないときは、比較できた範囲に退行が在っても `indeterminate` を先に出す**
（`reason` には退行の件数も名指しで書く）。**「何件を見ての判定か」が言えない状態で、
判定の顔をした値を出さないため**である。どちらも非0なので、門の色は変わらない。

### 4. 下限は「実測側の集合」と「基準値側の集合」から取る。**件数をコードに書かない**

**⚠ 「期待する行数」を `DEFAULT_COMPARE_SEQUENCE` からは引けなかった。** **【現物】**
母集合の正体は `examples/chat/src/compare.ts` の
`export const DEFAULT_COMPARE_SEQUENCE = [0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320]`（12点、
`turnCount = 2×(fillerPairs+1)`）だが、**これは TypeScript であり `scripts/*.mjs` から素直に
import できない**（`scripts/` はビルド無しで走る素の ESM である）。⟹ **引かない。**

**⚠ 代わりに `compare-baseline.json` の `rowCount`（=12）を使う案も採らない。** **【現物】**
`examples/chat/src/compare-json.ts` は `rowCount: options.rows.length` と**同じ配列から導いて
いる**ので、基準値が空になれば `rowCount` も一緒に 0 になる —— **独立した母集合ではない。**

⟹ 下限は上の2集合の一致だけから取る。これは **ADR 0215 決定4 と同じ「下限を実測側の
集合から取る」形**である。

### 5. 終了コードは `check-publish-run-coverage.mjs` の語彙に揃える —— 新しい表現を発明しない

**【現物】** この repo には既に第3の状態の語彙が在る: `check-publish-run-coverage.mjs` が
pass=0 / fail=1 / **判定不能=2**、`ci-green-check.mjs` が green=0 / red=1 / **pending=2**。
`compare-summary.mjs` もこれに揃え、**pass→0 / fail→1 / indeterminate→2** とした。
stderr には**比較できなかった `turnCount` を名指しで**出す。

### 6. Job Summary は「比較していない」と名乗る —— ⛔ 推測で補わない

**【現物】** 差分節は、基準値の無い行をこう書いていた（逐語）:

> この会話長には基準値が無い(新しい会話長か、基準値がまだ追随していない)。

**これは推測である。** どちらなのかを、この lib は知らない。⟹ **「🔴 この会話長は比較して
いない——基準値にこの turnCount が無い。⟹ 退行したかどうかについて、この行は何も
言っていない」**へ書き換えた。「基準値にのみ存在する会話長」の節も同様に、
**「測る点が黙って減っている。この会話長について、退行したかどうかは何も言っていない」**
と名乗らせた。

### 7. 冒頭 docstring の「新しい会話長・消えた会話長」節を書き換えた

**【現物】** 旧文は「新しい会話長は退行として扱わない」「消えた会話長も退行としては
扱わない」と書いており、**新しい挙動と食い違う。** ⟹ **「退行ではないが、判定不能である」**
へ直した。**会話長の構成を変える判断が門の役目ではないことは変えていない** —— 門は
「変えたこと」を赤にするのではなく、**「変わったので比較できていない」と名乗って止まる**。
基準値を更新すれば通る。

## 検討した選択肢

### 案(あ): `validateBaseline` に空 `rows` 検査を足す（`validateMeasured` と対称にする）

⛔ **採らない。** **【実測】上の表の通り、基準値が `turnCount=2` の1行だけでも、退行11件の
実測が0件になって緑が出る。** 空 `rows` を弾いても**1行の窓は開いたままである。**
**下限を*最小値*に置くと、「測り損ねた」と「本当に1点しか無い」を区別できない**
（ADR 0215 案A を退けた理由そのもの）。

⚠ **狭めただけの対策を「塞いだ」と記録すると、次の人は塞がっていると思って乗る**
（ADR 0215 案C の逐語）。

⭐ **そして (い) は (あ) を包含している。** **【実測】**空 `rows` は、`validateBaseline` に1行も
足さないまま `indeterminate` へ落ちる（「1会話長も比較していない」）。この事実は歯として
固定してある（`compare-summary-lib.test.mjs` の
「🔴【本題2】基準値が空配列なら indeterminate（validateBaseline は通したままで落ちる）」が
`expect(validateBaseline({ rows: [] }).ok).toBe(true)` を明示的に確認している）。

### 案: 比較していない会話長が在れば exit 1（退行と同じ赤に潰す）

⛔ **採らない。** 「退行した」と「比較できていない」は**別の命題**であり、次に来る人が
取るべき手当ても違う（前者は実装を直すか意図した変更として基準値を更新する、後者は
**まず何が比較されていないかを見る**）。**【現物】** この repo は既にこの2つを分けて
名乗らせる側に倒している（`check-publish-run-coverage.mjs` の fail と判定不能）。

### 案: `ci-green-check-lib.mjs` の `pending` 語彙を使う

⛔ **採らない。** **【現物】** `pending` は「check-runs がまだ登録されていない可能性がある」
——**後でもう一度見れば解決しうる**という再試行含みの意味を持つ。基準値の取りこぼしは
**再試行では直らない**（基準値を更新するか、実測側を戻すかの判断が要る）。⟹ 意味の
合う `indeterminate` を採った。

### 案: `check-cjs-transpile-parse.mjs` に倣って CLI 側で exit 1 にする

⛔ **採らない。** **【現物】** あれは lib と CLI が分かれていない単体のスクリプトの形であり、
**判定を lib の純関数に置いているこの場所には写せない。**

## 結果（この決定が招くもの）

- **【実測】いまの `main` の CI は赤くならない。** 現物の `examples/chat/compare-baseline.json` は
  12行で `turnCount` = 2,4,6,8,10,12,22,42,82,162,322,642 であり、`DEFAULT_COMPARE_SEQUENCE`
  （12点、`turnCount = 2×(fillerPairs+1)`）とぴったり一致する ⟹ 集合は一致し、`pass` が出る。
- **`DEFAULT_COMPARE_SEQUENCE` を変える PR は、基準値の更新を同じ PR で要求されるようになる。**
  これは負担の増加だが、**「測る点を減らして緑にする」経路を塞ぐ**ことと同じものである。
- **`compare` の門は、`turnCount` の集合について “何件を見ての判定か” を必ず名乗る。**

## ⚠ 引き受けた負債

- 🔴 **実運用で `compare-baseline.json` が空 `rows` / 部分 `rows` になる経路が在るかは、
  追っていない。** **【受】** Issue #477 の本文も、採否を確定したクローンのコメントも、
  「追っていない」と明記している。⟹ **これは「いま踏んでいる」という記録ではなく、
  「踏めば黙って緑になる」を塞いだという記録である。**
- **この決定は `turnCount` の集合しか見ない。** 同じ `turnCount` の行が**中身として**正しい
  基準値かどうか（たとえば ADR 0168 / ADR 0170 が直したような陳腐化）は、いまも見ていない。
  ⚠ 欄の中身の鮮度は Issue #403 の領域であり、この ADR は**そこに何も足していない。**
- **`computeRegressions` という旧名が、既存 ADR（0133 / 0151 / 0172 / 0188 / 0193 / 0215）・
  `docs/roadmap.md`・`examples/chat/compare-baseline.json` の `_readme` に残っている。**
  **⛔ 既存 ADR の本文は書き換えない規約**であり、他も「ついでに直す」をしないため、
  **この PR では触っていない。** ⟹ 旧名を追う人は、この ADR の決定1へ辿り着くこと。

## これが覆るとしたら

- **`scripts/` から母集合（期待する会話長の集合そのもの）を無理なく引ける在りかができたとき。**
  たとえば `DEFAULT_COMPARE_SEQUENCE` が JSON など言語非依存の形で置かれたなら、下限は
  2集合の一致ではなく**その母集合との一致**から取るほうが強い（「両側が同じ1行だけ」でも
  いまは `pass` になる —— これは下限に件数を焼き込まないことの裏返しである）。
- **`compare` の会話長の構成を頻繁に変える運用になったとき。** 判定不能が常態化するなら、
  「基準値の更新を同じ PR で要求する」の負担のほうが大きくなる。

## 確かめたこと・確かめていないこと

**【実測】確かめたこと**（`main = dd9ec8e` から切った木で、書き手が走らせた）:

- 直す前の逐語（上の表）と、直した後の逐語（同じ探り棒を当て直し、
  【本題】＝ `indeterminate`（exit 2）、【本題2】＝ `indeterminate`（exit 2）、
  【陽性対照】＝ `fail`（exit 1）、【通したい側】＝ `pass`（exit 0）、
  【測る点が減った側】＝ `indeterminate`（exit 2））。
- `pnpm exec vitest run scripts/__tests__/compare-summary-lib.test.mjs
  scripts/__tests__/compare-summary.test.mjs scripts/__tests__/ci-yml-compare-wiring.test.mjs`
  ⟹ **3 files / 74 tests passed**。
- `pnpm exec vitest run scripts/__tests__/ci-yml-*.test.mjs scripts/__tests__/workflow-*.test.mjs`
  ⟹ **15 files / 221 tests passed**（`ci.yml` のコメントを足したため、配線の歯を全部当てた）。

**⚠ 確かめていないこと**:

- **CI 上の `compare` ジョブを実際に走らせて、この判定不能を出させたわけではない**
  （手元に `DATABASE_URL` が無く、`example-chat` ジョブの前段を再現していない）。
  測ったのは lib への直接呼び出しと、`ci.yml` のコマンド行をそのまま起動する歯
  （`ci-yml-compare-wiring.test.mjs`）までである。
- **`scripts/` 配下の検査を全部は走らせていない**（上に挙げた範囲だけである）。
