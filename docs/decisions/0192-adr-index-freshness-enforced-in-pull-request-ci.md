# ADR 0192: ADR 索引の鮮度を、CI の `pull_request` でも強制する — 手順が守られたかを、注意力ではなく機構で確かめる（Issue #267）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`gh`/`vitest` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

**ADR 索引（`docs/decisions/README.md` の生成部分）の鮮度が、いま人の注意力に依存している。機構へ移せるか。**

[ADR 0137](./0137-adr-index-generated-from-source.md) は次の2つを決めた:

1. **ADR を足す PR の「作成者」は索引を触らない**（並行 PR 間の行位置の衝突を構造的に消すため）
2. **「マージする側」がマージ直前に PR ブランチ上で再生成する**

⟹ **1 と 2 の間には、誰も検査していない隙間がある。**2 を飛ばしても、マージは成立してしまう。

## 🔴 その隙間が、実際に `main` を赤くした

【実測】2026-09-16、ADR 0190（PR #384）と ADR 0191（PR #385）が**マージ直前の索引再生成を経ずに** squash merge された。`main` の `f46af8c` の job `typecheck / lint / test / build` は `conclusion: failure`。ログの該当箇所（逐語）:

```
❯ scripts/__tests__/adr-index-freshness.test.mjs (2 tests | 1 failed)
  × docs/decisions/*.md から生成した表が、README.md に commit されている表と一致する
```

【実測】欠けていた行は2本: `git show origin/main:docs/decisions/README.md | grep -cE "\[019[01]\]"` → `0`。PR #392 が後追いで再生成して訂正した（`0f65c8b`）。⛔ **その赤は消えていない。**`f46af8c` の `failure` は履歴に残る。

### ⭐ 「手順を忘れた」ではない —— 前提のほうが外れた

**ADR 0137 の規律は、「PR を準備する層」と「マージする層」が同じ人であることを暗黙に前提している。**2026-09-16 に外れたのはその前提のほうである——PR を準備して再生成の手順を走らせようとしていた層と、実際にマージした層が**別だった**。【受】（経緯はマネージャーからの報告。この書き手は当事者の一方である）

⟹ **どちらも規約どおりに動いており、誰も手順を忘れていない。**⟹ **直すべきは注意力ではなく、隙間そのものである。**

## 前提を自分の手で確認した

### 【現物】判定はいま `GITHUB_REF` だけを見ている

`scripts/adr-index-freshness-branch-lib.mjs` の判定は、`GITHUB_REF` が在ればそれだけを信じ、無ければ git のブランチ名を見る。`pull_request` イベントでの `GITHUB_REF` は `refs/pull/<n>/merge` なので、`refs/heads/main` と一致せず **false**（＝スキップ）になる。

⟹ **「PR 段階ではマージ後の状態を測れない」のではない。測れる位置に居ながら、意図的にスキップしている。**

### 【現物】`pull_request` の CI は、既に「マージ後の姿」を見ている

`.github/workflows/ci.yml` は12箇所の `actions/checkout@v6` のいずれにも `ref:` を指定していない。⟹ `pull_request` イベントの既定どおり、**GitHub が計算したマージプレビュー（`refs/pull/<n>/merge`）**を checkout する。

⟹ **`pull_request` の CI は、マージ後の `main` がどうなるかを、マージする前に測れる位置に既にいる。**

### 【実測】`typecheck / lint / test / build` は required status check である

`gh api repos/takecchi/mnemora/branches/main/protection` より、`required_status_checks.contexts` に `typecheck / lint / test / build` が含まれ、`enforce_admins.enabled = true`、`required_status_checks.strict = false`。merge queue は使っていない（`gh api repos/takecchi/mnemora/rulesets` → `[]`）。【受】（この4点は調査担当が引いた出力を受け取ったもので、この書き手は再実行していない）

⟹ **この歯が赤ければ、GitHub 自身がマージを拒む位置に在る。**

### 【実測】この形が起きうる頻度

直近60本のマージ済み PR のうち **39本**が `docs/decisions/` 配下を変更していた（約22.5時間、およそ 1.7本/時）。【受】（同上）⟹ **稀な事故ではない。**

## 決定

### 1. 鮮度の歯を、CI の `pull_request` でも有効にする

判定に「`GITHUB_REF` が `refs/pull/<n>/merge` の形なら有効」を足す。⟹ 索引が陳腐化したまま PR が緑になることが無くなり、**`main` に入る前に落ちる。**

### 2. ⛔ 手元は従来どおりスキップする

`GITHUB_REF` が無い環境では、これまでどおり「git のブランチ名が `main` か」だけで判定する。⟹ **ADR PR の作成者が手元で `pnpm run test` を走らせても赤くならない。**

⭐ **これが ADR 0137 の懸念への答えである。**ADR 0137 は「PR ブランチでも走らせると、将来のすべての ADR PR で `pnpm run test` が赤くなり、設計そのものと矛盾する」として PR 段階での検査を退けた。**その懸念は「作者の手元の6つの門」に向いていた。**本 ADR はそこを赤くしない——赤くするのは「マージできる状態か」を問う CI だけである。

### 3. 🔴 落ちたときのメッセージを、そのまま手順として読める形にする

失敗時に、**打つべきコマンドごと**出す:

```
これは ADR PR では想定された過渡状態であることがある
マージする側が、マージ直前に PR ブランチ上で次を実行してコミット・push すれば緑になる:
  node scripts/generate-adr-index.mjs
```

⛔ **そして「作成者は自分で直さないこと」を明記する。**【実測】並行する2本がどちらも索引を再生成すると衝突する（負債2）⟹ **作成者が触らないことが、その衝突を消している唯一の仕組みである。**

⭐ **これが効き目の半分である。**赤の意味が2種類（壊れている / 索引がまだ）になる以上、**読んだ人がその場で見分けられなければ、ADR 0137 が恐れた「信号のノイズ化」がそのまま起きる。**

### 4. 関数名を `isMain` から `shouldEnforceAdrIndexFreshness` へ変える

ADR 0137 の時点では「`main` か」と「この歯を有効にするか」が同じ問いだったので `isMain` でよかった。本 ADR で両者は別の問いになる——**`pull_request` は `main` ではないが、有効にしたい。**⟹ `isMain` のまま分岐を足すと、名前と中身が食い違う関数になる。

### 5. `scripts/ci-green-check.mjs` に診断のヒントを相乗りさせる

赤判定が出たとき、手元の作業木の索引が陳腐化していないかを**その場で**見て、該当すればヒントを出す。⚠ **CI の判定を置き換えない**——赤かどうかは従来どおり `gh` 経由で CI に聞く。**手元の索引が新鮮に見えても「CI も緑になる」とは言えない**（コミット・push のし忘れの余地が残る）。あくまで一往復を省く診断である。

## 検討して採らなかった案

### (a) 索引をコミットしない（生成物として扱い、読むときに生成する）

⭕ **唯一、「陳腐化する対象そのもの」が消える案である。**抜け道も無い。

⛔ **それでも採らない。**ADR 0137 が「問い」節で置いた制約を正面から破るからである（逐語）:

> 制約は1つ：生成された結果が1つのファイルとして読めること（`docs/decisions/README.md` を1枚の索引として読めなくしてはならない）

**これは実装の判断ではなく、読み手の体験を変える製品の判断である。**⟹ オーナー／クローンの領分であり、この ADR では決めない。**airtight を望むならこの案が正解である**、という事実だけ残す。

### (c) `gh pr merge` を包むスクリプトで手順を強制する

🔴 **抜け道が塞がらない。**【現物】`scripts/ci-green-check.mjs` は `gh pr merge` を**実行しない**——緑判定時に `gh pr merge <N> --squash --match-head-commit <sha>` という**文字列を印字するだけの助言ツール**である。⟹ **素の `gh pr merge` を打てば、何の技術的障壁も無く通る。**

⛔ **2026-09-16 に起きたのがまさにこれである。**ADR 0137 / 0179 / `docs/autonomy.md` §4 の手順は「規約」として存在していたが、マージした層がそれを経由しなかった。⟹ **規約をもう1段積んでも、同じ形で外れる。注意力から外せていない。**

### (d) merge queue を有効にし、`merge_group` イベントでのみ検査する

⛔ **CI がもう1周増える。**`merge_group` は `ci.yml` 全体（DB を要するジョブ群を含む）を走らせる。[Issue #267](https://github.com/takecchi/mnemora/issues/267) が既に実測している「ADR PR は索引再生成の push で2周する」に**3周目**が乗る。

⚠ 加えて、branch protection 側で「Require merge queue」まで設定しない限り**直接 squash merge は依然可能**であり、(c) と同じ抜け道が残る。

### (e) `main` への push 時に自動で再生成してコミットする

⛔ **`main` が一度は陳腐化した状態を通る**——本 ADR が塞ごうとしている当のものである。加えて `enforce_admins: true` の保護ブランチへ bot が push する設計が要る（[Issue #267](https://github.com/takecchi/mnemora/issues/267) が「`main` への書き込み権限の設計が要る」と指摘済み）。

## 引き受けた負債

### 1. 🔴 ADR PR は、マージする側が再生成するまで required check が赤いままになる

⟹ **赤の意味が2種類になる。**[ADR 0118](./0118-pr-merge-delegated-when-ci-green.md)「CI が緑なら積極的にマージしてよい」の読み方に影響する——**ADR PR は「緑になったらマージ」ではなく「再生成して緑にしてからマージ」になる。**

**決定3（メッセージを手順として書く）が、この負債への唯一の手当てである。**⚠ **手当てが効いているかは測っていない**——実際に読んだ人が誤読しないかは、運用してみないと分からない。

### 2. 🔴 並行 ADR PR が両方再生成すると、索引は**衝突する**

⛔ **本 ADR の草稿では「両者は1行ずつ追加するだけなので 3-way マージの結果は和集合＝正しい索引になる」と書いていた。【実測】その読みは誤りだった。**

【実測】`origin/main` から2本の枝を切り、それぞれに使い捨ての ADR（`0900` / `0901`）を足して**どちらも索引を再生成**し、3-way マージを撃った:

```
$ git merge scratch/parallel-adr-probe
Auto-merging docs/decisions/README.md
CONFLICT (content): Merge conflict in docs/decisions/README.md
```

衝突の中身は、**表の末尾の同じ位置へ1行ずつ足した**ことによるものだった:

```
<<<<<<< HEAD
| [0901](./0901-probe-beta.md) | … |
=======
| [0900](./0900-probe-alpha.md) | … |
>>>>>>> scratch/parallel-adr-probe
```

⟹ **[Issue #230](https://github.com/takecchi/mnemora/issues/230) が報告した「末尾追記の衝突」は、いまも同じ形で起きる。**

### 2.1 ⭕ ただし通常の流れでは起きない —— それも撃った

【実測】**作成者が索引を触らない**枝（ADR `0902` を足すだけ）に、索引を再生成済みの枝を取り込むと、**衝突しない**:

```
 docs/decisions/0900-probe-alpha.md | 6 ++++++
 docs/decisions/README.md           | 1 +
```

取り込んだ後に `node scripts/generate-adr-index.mjs` を走らせると、索引は `0900` と `0902` の**両方**を含んだ（`grep -cE "\[090[02]\]"` → `2`）。

⟹ 🔴 **衝突を消しているのは「和集合になるから」ではない。[ADR 0137](./0137-adr-index-generated-from-source.md)「決定」1番——作成者が索引を触らないこと——そのものである。**

### 2.2 ⚠ だから本 ADR は、新しいリスクを1つ持ち込む

**本 ADR は ADR PR の CI を赤くする。⟹ 赤を見た「作成者」が、自分で索引を再生成して緑にしたくなる。**⛔ **それをやると ADR 0137 決定1 が崩れ、上の衝突が戻ってくる。**

⟹ **決定3（メッセージ）に「⛔ 作成者は自分で直さないこと」を明記し、上の実測を根拠として添えた。**⚠ **メッセージが実際に踏みとどまらせるかは測っていない。**

### 3. `required_status_checks.strict = false` である

⟹ PR は `main` の最新と同期していなくてもマージできる。負債2 の推論はこの設定の上に乗っている。**`strict` を変える判断は本 ADR の範囲外である。**

## これが覆るとしたら

- **案 (a)（索引をコミットしない）が採られたとき。**そのとき本 ADR の歯は不要になる——検査すべき生成物が無くなるからである。
- **branch protection の `required_status_checks.contexts` から `typecheck / lint / test / build` が外れたとき。**本 ADR の強制力はこの1点に全面的に乗っている。⟹ **外れると、本 ADR は「赤く光るだけで止めない歯」に退化する。**
- **負債1 の手当てが効かないと分かったとき**——ADR PR の赤が実際にノイズとして扱われ始めたら、ADR 0137 の懸念が正しかったことになる。そのときは (a) へ進むか、赤の出し方を変える。

## 測ったこと

**すべてこの作業木（`origin/main` から切った worktree）で、この書き手が走らせた。**

### 【実測】変異試験 —— 5条件

索引は `cp` で `/tmp/mut-backup/` へ退避してから壊し、`cp` で戻した（⛔ `git checkout <file>` を使わない。`docs/autonomy.md` §4）。変異は「索引から `0186` の行を1行削る」。

| # | 条件 | 期待 | 結果 |
|---|---|---|---|
| ① | `GITHUB_REF=refs/pull/999/merge`・索引は最新 | 有効・緑 | ⭕ `Tests 2 passed (2)` |
| ② | `GITHUB_REF=refs/pull/999/merge`・**索引を壊した** | **有効・赤** | ⭕ `Tests 1 failed \| 1 passed (2)`。メッセージに `node scripts/generate-adr-index.mjs` が出た |
| ③ | `GITHUB_REF` 無し・ブランチは `main` 以外・**索引を壊したまま** | **スキップ**（手元を赤くしない） | ⭕ `Tests 2 skipped (2)` |
| ④ | `GITHUB_REF=refs/heads/main`・索引を壊したまま | 従来どおり赤 | ⭕ `Tests 1 failed \| 1 passed (2)` |
| ⑤ | `ADR_INDEX_FRESHNESS_FORCE=1`・索引を壊したまま | 従来どおり強制 | ⭕ `Tests 1 failed \| 1 passed (2)` |

**復元後**: `git diff --stat docs/decisions/README.md` が空。`GITHUB_REF=refs/pull/999/merge` で `Tests 2 passed (2)` に戻った。

⭐ **③ が決定2 の証拠である**——索引が壊れていても、手元では鳴らない。

### 【実測】この ADR を足す PR 自身で、仕掛けが効いた

**索引を再生成せずに push したところ、この PR の `typecheck / lint / test / build` が `conclusion: failure` になった**（PR #398、sha `b415590`）。GitHub の check-run の注釈（逐語）:

```
AssertionError: docs/decisions/README.md が陳腐化している: 索引に無い ADR: ["0192"]

これは ADR PR では想定された過渡状態であることがある
（ADR PR の作成者は索引を意図的に触らない設計——ADR 0137「決定」2番）。
…
  node scripts/generate-adr-index.mjs
```

⟹ ⭐ **仕掛けが自分自身に効き、かつ手順のメッセージが GitHub の UI にそのまま出た。**

## 確かめていないこと

- 🔴 **「required check が赤いとき `gh pr merge` が実際に拒まれる」ことを、この repo で実地検証していない。**`enforce_admins: true` と required status checks の一般的な意味から読んでいるだけである。⟹ **本 ADR の強制力の根拠は、ここが未検証のまま乗っている。**⚠ **確かめたら、この節に追記すること。**
- **負債1 の手当て（メッセージ）が実際に誤読を防ぐか。**測っていない。
- **負債2（並行 ADR PR）を実際に2本並行させて撃っていない。**
- **`pnpm run test` の全体実行はしていない**（この器の規律）。名指しで走らせたのは `scripts/__tests__/adr-index-freshness.test.mjs` と `scripts/__tests__/adr-index-freshness-branch-lib.test.mjs` のみ。**他の歯がこの改名で壊れていないことは CI が初めて確かめる。**
- **branch protection・merge queue・ADR PR の頻度の4点は【受】である**——調査担当が引いた出力を受け取ったもので、この書き手は再実行していない。
