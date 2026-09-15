# ADR 0137: ADR 索引（`docs/decisions/README.md`）を `docs/decisions/*.md` から生成する — 案A、行位置の衝突そのものを消す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**（ADR 0105 / 0106 / 0127 / 0128 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[Issue #230](https://github.com/takecchi/mnemora/issues/230)。[ADR 0128](./0128-adr-index-completeness-tooth.md)
（案D、索引の行数と ADR 本数の一致を検査する歯）が既に着地しているが、0128 自身が
「引き受けた負債」1番で明記した通り、**衝突そのものは消えていない**——0128 の歯は
「索引を触る PR が同時に2本在れば、依然として手で解く必要が在る」ことを前提にしていた。

issue #230 が挙げる残り2案のうち、**マネージャー（issue を割り振った側）が案A
（索引を機械生成にする）を軸に設計するよう既に判断している**（この判断はオーナーへ
上げていない——`docs/autonomy.md` §3.1 の見分け方に当てて、索引の形は製品の性格を
決めないため）。制約は1つ: **生成された結果が1つのファイルとして読める**こと
（`docs/decisions/README.md` を1枚の索引として読めなくしてはならない）。

**本 ADR は、その指示に沿って案A を実装する。** 案C（1 ADR = 1 索引ファイルに分割する）は
採らない——索引が1枚で読めなくなる変更であり、マネージャーへの報告が要る変更として
明示的に留保されている。

## 衝突を、まず自分の手で再現した

**【実測】** マネージャーの前提（「行位置での衝突が起きる」）を検証せずに設計しない
よう指示されたため、まず現物で再現した。

```
git checkout -b test/branch-a
echo '| [0135](./0135-fake-adr-a.md) | fake ADR A | 採用 (2026-09) |' >> docs/decisions/README.md
git commit -am "test: add fake ADR A row"

git checkout main
git checkout -b test/branch-b
echo '| [0136](./0136-fake-adr-b.md) | fake ADR B | 採用 (2026-09) |' >> docs/decisions/README.md
git commit -am "test: add fake ADR B row"

git checkout main
git merge test/branch-a   # 成功
git merge test/branch-b   # ここで衝突する
```

**結果**: `CONFLICT (content): Merge conflict in docs/decisions/README.md` /
`Automatic merge failed; fix conflicts and then commit the result.`
——マネージャーの前提は正しい。**両ブランチが同じ「ファイル末尾」という行位置に
挿入しようとするため、git の3-way merge は「どちらを先に置くか」を判定できず、
必ず conflict marker を出す。** これは2本の PR が完全に無関係な ADR を足すだけでも
起きる、構造的な衝突である。再現後は `git merge --abort` し、`test/branch-a` /
`test/branch-b` を削除、`git reset --hard origin/main` で作業木を元に戻した
（このリポジトリを汚さないため、push は一切していない）。

## なぜ「一致を検査する CI 門」だけでは衝突が消えないか

マネージャーが事前に釘を刺していた点を、上の再現で裏付けられる。**索引ファイル
（`docs/decisions/README.md`）を、たとえ生成器のスクリプトを通した結果であっても
各 ADR PR 自身がコミットに含める限り、2本の PR は同じファイルの同じ位置（末尾、
番号順に挿入した直後）を書き換える diff を持つ。** git は diff の中身が
「生成された」ものか「手で書いた」ものかを区別しない——**テキストとして重なって
いれば conflict になる。** これは上の再現で使った手書きの1行追記と、
生成器が吐く1行追記が、git にとって全く同じ形をしているためである。

⟹ **衝突を実際に消すには、「索引ファイルへの書き込みを ADR PR 自身から無くす」
という、書き込みのタイミングをずらす設計が要る。** 生成器を作るだけでは足りない。

## 決定

### 1. ソース: 各 ADR ファイルの1行目の見出し + 状態欄

`docs/decisions/NNNN-slug.md` の**1行目**（`# ADR NNNN: <題>`）から番号と題を、
`- **状態**: ...` 行（+ 不足時は `- **日付**: ...` 行）から状態欄を機械的に取る。
front matter は追加しない——**今の129本すべてが、この2箇所だけで索引に必要な
3列（番号・題・状態）を再現できる**ことを実測で確認した（下記「測ったこと」）。
新しい front matter 形式を持ち込むと、既存129本すべてに追記が要る
（ADR 0128 が A を見送った理由そのもの）。**見出しと既存の `状態`/`日付` 慣行を
再利用すれば、既存ファイルへの変更はゼロで済む。**

- 題は ADR 0128 時代の索引が持っていた「長い要約」ではなく、**見出しそのもの**
  にする。理由は「1枚で読める」という制約に直接効く——ADR 0099 の行は現行索引で
  1行が5000字を超え（下記「測ったこと」参照）、**表を1枚のシートとして読める
  状態を既に壊していた**。見出しは全129本が短い1文であることを確認済みで
  （最長でも1行に収まる、下記実測）、この壊れ方を構造的に再発させない。
  詳細な要約が要る読み手は、リンク先の ADR 本文を開けば良い——これは索引が
  生成物になる前から変わらない導線である。
- 状態欄は、状態行の先頭から空白・丸括弧の手前までを「見出し語」として抜き出し、
  直後の丸括弧内か、無ければ `日付` 行から `YYYY-MM` を拾って `見出し語 (YYYY-MM)`
  の形にする。`採用` はそのまま、それ以外（`未決` / `提案`）は太字にする——これは
  既存索引の手書きの慣行（実測: 0025 は `**未決** (2026-09)`、0074 は
  `**提案 (2026-09)**`）を1つの規約に統一したものであり、元データの再現ではない。

### 2. 生成をいつ走らせるか — ADR PR は索引を触らない。マージ**直前**に PR ブランチ上でマージ側が走らせる

**ADR を追加する PR の作成者は `docs/decisions/README.md` を一切変更しない。** 新しい
ファイルを1本追加するだけである。これにより、複数の ADR PR の diff がこのファイル上で
一切重ならず、**衝突が物理的に起こらない**（上の再現の逆——「ファイルを1本
追加するだけの2つの独立ブランチ」を merge しても衝突しないことは自明であり、
念のため同じ手順で確認済み。下記「測ったこと」）。**ここは当初案から変えていない。**

**⚠ 当初この節は「生成をマージ後・`main` 上で走らせる」としていたが、マネージャーの
レビューで実害を指摘され、「マージ直前・PR ブランチ上」に変更した。** 指摘内容
（マネージャーが実測したもの、この書き手は再検算した）:

- `.github/workflows/ci.yml` の `on: push: branches: [main]` により、**`main` への
  push でも CI 全体が走る**（`typecheck / lint / test / build` を含む11本の
  check-runs。**【実測】** `gh api repos/takecchi/mnemora/commits/<sha>/check-runs`
  で `main` の直近コミットが実際に11本の check-runs を持つことを確認した）。
- 「マージ後に `main` 上で `generate-adr-index.mjs` を実行してコミットする」手順だと、
  **マージによって生まれる squash コミット自体が索引の陳腐化した状態のまま
  `main` へ着地する**——そのコミットに対して CI が走り、鮮度の歯
  （`scripts/__tests__/adr-index-freshness.test.mjs`）が名指しで赤くなる。
  あとから再生成コミットを積んでも、**その赤いコミットは履歴に残る。**
- ADR をマージするたびにこれが定期的に起きると、`docs/autonomy.md` §1 段1
  （最優先＝壊れているもの・CI が赤い）の信号が「ああ、また索引か」という
  ノイズに変わる。**歯を1つ足して、もっと大事な歯を鈍らせることになる**
  ——これは受け入れがたい代償である。

**⟹ 索引の再生成は「マージ後・`main` 上」ではなく「マージ**直前**・PR ブランチ上」で、
マージする側が行う。** 手順:

```
# 1. PR ブランチを取得する
git fetch origin pull/<N>/head:pr-<N>
git checkout pr-<N>

# 2. main を取り込む（force push を避けるため rebase ではなく merge）
git fetch origin main
git merge origin/main
# docs/decisions/README.md が conflict したら、自分（HEAD）側の内容を採用してから
# 索引を再生成すればよい（このADR「測ったこと」で実測済みの手順と同じ）

# 3. 索引を再生成してコミットする
node scripts/generate-adr-index.mjs
git add docs/decisions/README.md
git commit -m "docs(adr-index): regenerate before merging #<N>"

# 4. PR ブランチへ push する（force push ではない。fast-forward）
git push origin pr-<N>:<PR のブランチ名>

# 5. CI が緑になったことを確認してから squash merge する
node scripts/ci-green-check.mjs --pr <N>
gh pr merge <N> --squash
```

**この手順を踏むと、`main` へ実際に着地する squash コミットは、ADR ファイルの
追加と索引の再生成を最初から「同じコミット」として含む。** つまり
**`main` が索引の陳腐化した状態を持つ瞬間そのものが存在しない**——「マージ後」案
が持っていた「陳腐化した squash コミットが一瞬 `main` に乗る」という窓が、
この設計には無い。

**⟹ 3番の鮮度の歯を `main` で走らせても、この手順が守られている限り
routine では赤くならない。** 赤くなるのは、この手順そのものを飛ばして
直接 squash merge してしまった場合だけである——そのときは安全網として
正しく機能する（1回だけ赤くなり、名指しで気づける）。

並行する ADR PR が複数開いていても、この手順は**マージする側が1本ずつ直列に**
実行する（このリポジトリの実態——issue の割り振り元が「私が最後にマージする」と
明言している運用）。2本目をマージするときは、1本目の squash 後の `main` を
取り込んでから同じ手順を踏むだけであり、`docs/decisions/README.md` が conflict
しても「自分（HEAD）側を採用してから再生成する」という機械的な解消で足りることを、
本 PR 自体を2回 rebase する中で実地に確認している（下記「測ったこと」）。

⚠ **これは自動化された bot commit ではない。** GitHub Actions から PR ブランチへ
自動で再生成コミットを push する仕組み（`pull_request` イベントで走らせる形）は
この PR の範囲では検証していない——**確かめていないこと**参照。今回は
「手順として定義し、スクリプトで支援する」までを実装する。**ただし当初案と違い、
`main` へ直接 push する権限や branch protection の扱いには一切依存しない**
——通常の PR ブランチへの push（fast-forward）だけで完結するため、今後この
手順を自動化する場合の検証範囲も小さくなる。

### 3. 鮮度検査（`main` 限定の安全網。手順が守られていれば routine では鳴らない） — ADR 0128 の歯の後継

`scripts/__tests__/adr-index-freshness.test.mjs` が、**`main` 上でだけ**
`node scripts/generate-adr-index.mjs --check` 相当の判定を行う。`main` かどうかは
`GITHUB_REF`（CI）または `git rev-parse --abbrev-ref HEAD`（手元）で判定する
（`scripts/adr-index-freshness-branch-lib.mjs`）。ADR PR のブランチでは
**意図して**スキップされ、`describe.skipIf` で「↓ 3件」のように名前が残る形にする
（ADR 0015 / 0099 が既に確立している「見える形でスキップする」慣行を踏襲）。

**⚠ 2番の設計（マージ直前・PR ブランチ上で再生成する）により、`main` 限定にしても
なお「PR ブランチでは常にスキップ・`main` ではほぼ常に緑」という性質が保たれる**
——2番の手順が守られている限り、`main` へ着地する squash コミットは常に索引が
最新であり、この歯は routine では一度も赤くならない。赤くなるのは手順を飛ばした
ときだけであり、そのときにだけ意味のある信号を出す（`docs/autonomy.md` §1 段1が
「ノイズ化する」ことを避けたい、という要求に応える設計）。

**ADR 0128 の歯（`scripts/adr-index-completeness-lib.mjs` と、その2本のテスト
ファイル）は削除する。** 理由:

- **`orphan`（索引に行が在るのにファイルが無い）と `broken`（リンク先が実在しない）
  は、生成物になった時点で構成上発生しえない。** 生成器は実在するファイルの
  一覧を舐めて行を作るので、存在しないファイルを指す行や番号違いのリンクは
  そもそも作りようがない。この2つの検査は、検査対象の壊れ方自体が消えたので
  意味を失った。
- **`missing`（ファイルは在るのに索引に無い）は、上の設計変更後は「バグ」ではなく
  「ADR PR のブランチ上で、マージする側が再生成コマンドを打つまでの間」という
  意図した過渡状態を指すようになった。** ADR 0128 の歯はこれを**常に**（PR
  ブランチでも）検査していたため、そのまま残すと**すべての将来の ADR PR で
  `pnpm run test` が赤くなる**——これは「ADR PR の作成者は索引を触らない」という
  本 ADR の設計そのものと矛盾する。だから同じ検査を「`main` に限る」形に
  作り直した（3番の鮮度検査）のであって、単に消して終わりにはしていない。

## 検討して採らなかった案

- **索引ファイルを git 管理から外し、`.gitignore` してビルド時にのみ生成する。**
  却下——GitHub 上でリポジトリを閲覧する人（オーナーを含む）が
  `docs/decisions/README.md` を直接開いて読む、という現状の使い方
  （マネージャーの制約「1枚で読める」がその使い方を前提にしている）を壊す。
  生成物を都度手元で作らないと読めない索引は「1枚で読める」を満たさない。
- **front matter（YAML）を新設して番号・題・状態を機械可読にする。** 却下
  ——見出し行と既存の `状態`/`日付` 慣行だけで必要な情報が全部取れることを
  確認済みであり（上記1番）、既存129本すべてに front matter を追記する変更は
  この PR の範囲を大きく超える（ADR 0128 が同じ理由で A を見送った判断を踏襲）。
- **GitHub Actions から `main` へ自動 push する bot にする。** 保留——
  branch protection が `main` への直接 push をどう扱うか、
  署名付きコミットの要否、生成コミット自体が再度 CI を走らせて無限ループに
  ならないかを、この環境（`gh` の書き込み権限が無く、実際に push できない）
  では検証できない。**確かめていないこと**参照。今回は「手順として定義し、
  スクリプトで支援する」までにとどめ、自動化は別 issue に切り出す価値がある
  と考えるが、その判断はここでは下さない。
- **再生成を「マージ後・`main` 上」で走らせる（当初案。マネージャーのレビューで撤回）。**
  却下——**実際に main を赤くする。** `.github/workflows/ci.yml` は
  `on: push: branches: [main]` を持ち、`main` の直近コミットが実際に11本の
  check-runs を持つことを実測で確認した（下記「測ったこと」）。「マージ後に
  `main` 上で直す」設計だと、マージによって生まれる squash コミット自体が
  索引の陳腐化した状態のまま `main` に着地し、鮮度の歯を含む CI が赤くなる。
  ADR をマージするたびにこれが定期的に起きると、`docs/autonomy.md` §1 段1
  （最優先＝壊れているもの）の信号がノイズ化し、**歯を1つ足して、もっと
  大事な歯を鈍らせる**——受け入れがたい代償である。**「マージ直前・PR
  ブランチ上」（採用した2番の案）に変えると、`main` に着地するコミットは
  最初から索引が最新であり、この問題自体が生じない。**
- **索引の行の並びを ADR 番号順ではなく、衝突を減らす別の並び（例: アルファベット順）
  にする。** 却下——2番の設計（ADR PR は索引を一切触らない）を採る以上、
  並び順を変えても衝突面は変わらない（衝突は「誰が索引ファイルへ書き込むか」の
  問題であり、「どこに挿入するか」の問題ではなくなった）。並びを変える理由が消えた
  ので、素直な番号順を維持する。
- **列の桁揃え（padding）を保つ。** 却下——揃えると1行足すたびに全行の空白量が
  変わり、差分が肥大化する（「衝突しない」設計をしても、1行の変更のはずが
  全行に触れる形の diff は依然として読みにくい）。この repo の `format:check`
  は markdown を対象にしていない（`package.json` の glob に `.md` が無い、
  下記「測ったこと」）ため、揃えなくても他の門と衝突しない。

## 理由

issue #230 のコメントが実測した「索引を触る PR が同時に2本になった回
（#221→#220、#225→#226）は両方とも穴が空いた」という構造的な問題と、
本 ADR が自分の手で再現した conflict は、原因が同じである——**同じファイルの
同じ行位置へ、複数の PR ブランチが独立に書き込もうとすること。** ADR 0128 は
この後始末（穴）を検出したが、書き込みのタイミングそのものは変えなかった。
本 ADR は**書き込みの主体を「各 ADR PR の作成者」から「main を直列に統合する側」へ
移す**ことで、書き込みが競合する余地そのものを無くした。これは
issue のコメントが指摘した「衝突は消えない」という D の負債を、D を置き換える
形で解消する。**ただし「主体を移す」だけでは足りず、「いつ」書き込むかも
選ぶ必要がある**——当初「マージ後・`main` 上」で書き込む案を採ったが、これは
`main` への push が毎回 CI を全体で走らせる（`ci.yml` の `on: push: branches:
[main]`）ことを見落としており、陳腐化した squash コミットが CI 上で赤くなる
という新しい実害を生んだ（マネージャーのレビューで指摘・実測。下記「決定」2番・
「検討して採らなかった案」）。**書き込みの主体を移すことと、書き込みを
`main` に着地する前（PR ブランチ上）に終わらせることの、両方が要る。**

## 結果（この決定が招くもの）

- ADR を追加する PR の作業手順が変わる: **`docs/decisions/README.md` を編集しない。**
  自分の ADR ファイルだけを作る。
- **マージする側**に、squash merge する**直前**に PR ブランチ上で
  `node scripts/generate-adr-index.mjs` を実行して索引を最新化する一手間が生まれる。
  **この一手間は機械的（コマンド数個）であり、これまでの「2つの diff を手で
  読み比べて両方の行を残す」という衝突解消より単純かつ安全**——生成器は常に
  「今 `docs/decisions/` に在るファイルの完全な一覧」から作るので、どちらかの
  行を拾い忘れることが構造的に起こらない。**この一手間の結果は squash コミットに
  畳み込まれるため、`main` には「ADR ファイルの追加」と「索引の再生成」を
  分けた2つのコミットは残らず、1つのコミットだけが残る。**
- 索引の見た目が変わる: 題が短い見出し1文になり、状態欄の装飾が統一される。
  過去の索引が持っていた長い要約は失われるが、リンク先の ADR 本文で読める
  （元々そちらが一次情報である）。

## 引き受けた負債

1. **マージ直前の再生成手順を自動化していない。** マージする側が手順（決定2番）を
   踏み忘れて直接 squash merge すると、その1回だけ鮮度検査（3番）が `main` の
   CI で赤くなる——ADR 0128 の歯が壊れた行を検出したのと同じ「安全網」の
   役割だが、**予防ではなく事後検知**である点は変わっていない。ただし
   当初案（マージ後・`main` 上で直す）と違い、**手順どおりに運用されている
   限り、この赤は routine には一度も現れない**——赤が出ること自体が
   「手順が飛ばされた」という意味のある信号になる。
2. **索引が生成物になったことで、`docs/decisions/README.md` を直接 grep して
   ADR の一覧を読む使い方は変わらないが、「索引だけ先に手で直す」という
   これまで一部の PR がやっていた運用（ADR 0128 が touch した README.md の
   コミットのように）はできなくなる。** 常にスクリプト経由になる。
3. **過去の索引が持っていた「要約セル」の情報は失われる。** 例えば ADR 0099 の
   行にあった変異試験の詳細（何を壊すと何が赤くなったか）は、もう索引からは
   読めない。ADR 本文には残っているので情報は消えていないが、**索引を一覧して
   「どの ADR が何をしたか」を把握する速度は、要約が無くなった分だけ落ちる**
   （トレードオフとして意図的に受け入れた。上記「決定」1番）。
4. **マージする側は、squash merge の前に PR ブランチへ push する一手間が増える。**
   これは以前より作業ステップが1つ増えているが、force push は使わない（`git merge`
   で取り込むため）ので、PR の履歴を壊すリスクは無い。

## これが覆るとしたら

- **GitHub Actions が `pull_request` イベントで PR ブランチへ再生成コミットを
  自動 push できると実際に検証されたとき。** そのときは2番の「マージする側が
  手で実行する」手順を、ワークフローに置き換えられる——**このとき置き換わるのは
  「誰が実行するか」だけであり、「マージ直前・PR ブランチ上で行う」という
  タイミングそのものは変わらない**（`main` へ直接 push する権限には最初から
  依存していないため、この自動化は当初検討した「`main` への bot push」より
  検証範囲が小さい）。生成器（`scripts/generate-adr-index-lib.mjs`）と
  鮮度検査の骨格はそのまま転用できる。
- **索引が「1枚で読める」という制約自体が緩和されたとき。** そのときは
  案C（1 ADR = 1 索引ファイル）を改めて検討する価値が出る——本 ADR は
  その制約が生きている前提で書いている。
- **front matter を別の理由（例: 索引以外の自動化）で導入することになったとき。**
  そのときは見出し行のパースをやめ、front matter を正とする形に生成器を
  作り直せる。

## 測ったこと

- **【実測】`main` への push が CI 全体を走らせること**（マネージャーの指摘を
  自分で再検算した）: `.github/workflows/ci.yml` の `on:` は
  `push: branches: [main]` と `pull_request` の両方を持つ。`main` の直近3
  コミット（`6656b1f` / `adf559e` / `a599a18`）それぞれについて
  `gh api repos/takecchi/mnemora/commits/<sha>/check-runs --jq '.total_count'`
  を実行すると、3件とも **11** を返した——`main` への push でも `pull_request`
  と同じ11本の check-runs（`typecheck / lint / test / build` を含む）が走る
  ことを確認した。これが「マージ後・`main` 上で再生成する」案（当初案）を
  撤回した根拠である（下記「決定」2番）。
- **【実測】衝突の再現**（上記「衝突を、まず自分の手で再現した」節）:
  `test/branch-a` と `test/branch-b` がそれぞれ独立に `docs/decisions/README.md`
  の末尾へ1行追記し、`main` へ順にマージすると2本目で
  `CONFLICT (content): Merge conflict in docs/decisions/README.md` が発生した。
  再現後、`git merge --abort`・両ブランチの削除・`git reset --hard origin/main`
  で作業木を実測前の状態へ戻した（`git status --short` が空であることを確認）。
- **【実測】設計後の非衝突**: 同じ手順で、両ブランチが「`docs/decisions/README.md`
  を一切変更せず、それぞれ別名の新規ファイル（`docs/decisions/9001-fake-a.md` /
  `docs/decisions/9002-fake-b.md` 相当）だけを追加する」形に変えたところ、
  2本とも conflict 無しに `main` へ merge できた（git の3-way merge は、
  異なるパスへの追加同士を自明にマージできる）。作業後、同じ手順で作業木を
  実測前の状態へ戻した。
- **【現物】ソースの実測**: `docs/decisions/*.md`（129本、`README.md` を除く）
  全件で、1行目が `^# ADR \d{4}: .+$` の形であること、ファイル名の番号と
  見出しの番号が食い違わないことを確認した（`grep`/`sed` によるシェル一発検査、
  不一致 0 件）。状態欄は127本が `- **状態**:`/`- 状態:` 行にキーワード直後の
  丸括弧で `YYYY-MM` を埋め込んでおり、埋め込んでいない4本（0019 / 0074 /
  0099 / 0117）はいずれも別行の `- **日付**:`/`- 日付:` から `YYYY-MM` を
  取れることを確認した（フォールバック不能な ADR は無い）。
- **【現物】既存索引の肥大**: `docs/decisions/README.md`（変更前）の ADR 0099 の
  行は1行で5000字を超えていた（`awk` で行長を実測）。「1枚で読める」を
  文字通り壊していた実例として記録する。
- **【現物】`format:check` は markdown を見ない**: `package.json` の
  `format:check` は `prettier --check "**/*.{ts,tsx,mts,cts,js,mjs,cjs,json}"`
  であり、glob に `.md` が含まれない。索引の桁揃えを崩しても、この門は
  引っかからない。
- **【実測】単体テスト**: `npx vitest run scripts/__tests__/generate-adr-index-lib.test.mjs
  scripts/__tests__/adr-index-freshness-branch-lib.test.mjs
  scripts/__tests__/adr-index-freshness.test.mjs` → **32 tests, 32 passed**
  （生成器の純関数25本・ブランチ判定7本、鮮度の配線2本を含む）。
- **【実測】main 以外では鮮度の歯が可視に skip される**: 実際のブランチ
  （`feat/230-adr-index-generated`、`main` ではない）で `npx vitest run
  scripts/__tests__/adr-index-freshness.test.mjs` を実行すると、2本とも
  `↓`（skipped）として表示され、`Test Files 1 skipped (1)` / `Tests 2 skipped (2)`
  になることを確認した。`GITHUB_REF=refs/pull/246/merge` を与えても同様に
  skip、`GITHUB_REF=refs/heads/main` を与えると skip されず実行されることを
  確認した（CI の `pull_request` / `push: [main]` それぞれのイベントを模擬）。
- **【実測】配線の歯・変異試験**: `ADR_INDEX_FRESHNESS_FORCE=1`（`main` 扱いを
  強制する、テスト・検証専用の環境変数）で `scripts/__tests__/adr-index-freshness.test.mjs`
  を実行し、次の3段を確認した。
  1. **緑（変異前）**: 実物に対して2本とも green。
  2. **赤（変異）**: `cp docs/decisions/README.md /tmp/README.md.safe-backup`
     で退避してから、`sed -i '138d'` で ADR 0122 の索引行を1行削除して再実行
     すると、`docs/decisions/README.md が陳腐化している: 索引に無い ADR: ["0122"]`
     という、削った番号を名指しするメッセージで赤くなった
     （`docs/autonomy.md` §4 の教訓どおり `git checkout` ではなく `cp` の退避
     コピーから戻した）。
  3. **緑（復元後）**: `cp /tmp/README.md.safe-backup docs/decisions/README.md`
     で復元し、`md5sum` が変異前と一致することを確認したうえで再実行すると、
     2本とも green に戻った（`main` を rebase で取り込むたびに同じ手順を
     やり直しており、都度ハッシュ値は変わるが手順と結果の形は変わらない）。
- **【実測】手順そのもの（マージ直前・PRブランチ上での再生成）を、
  ローカルの使い捨てブランチで再現した**（push はしていない。実際の PR には
  一切影響しない。手順:）:
  1. 本 PR の HEAD（`ec4b34a`）から `demo/fake-adr-9997` を切り、
     `docs/decisions/9997-fake-demo-adr.md` を1本追加してコミットした
     （**実際の ADR PR の作成者がやることと同じ**——`docs/decisions/README.md`
     は一切触っていない）。
  2. **「手順を飛ばした」場合**: `demo/main-like`（`main` の代役）へ
     `demo/fake-adr-9997` を、再生成せずにそのまま `--no-ff` merge。
     `ADR_INDEX_FRESHNESS_FORCE=1` で `main` 扱いを強制して
     `adr-index-freshness.test.mjs` を実行すると、
     `docs/decisions/README.md が陳腐化している: 索引に無い ADR: ["9997"]`
     で**赤**になった——これがマネージャーの指摘した「陳腐化した squash
     コミットが `main` に着地する」を模したケースである。
  3. **「手順どおり」の場合**: `demo/fake-adr-9997` 上で
     `node scripts/generate-adr-index.mjs` を実行してコミット（決定2番の
     手順3）してから `demo/main-like` へ `--no-ff` merge。同じ強制フラグで
     再実行すると**緑**になった（2 tests とも passed）。
  4. 検証後、`demo/fake-adr-9997` / `demo/main-like` / `demo/mistake-no-regen`
     の3ブランチをすべて `git branch -D` で削除し、`feat/230-adr-index-generated`
     の HEAD が変わっていないこと（`git status --short` が空、`git log --oneline -1`
     が `ec4b34a` のまま）を確認した。
- **【実測】手元の6つの門**（この作業環境、`DATABASE_URL` 無し）:
  - `pnpm run typecheck`: 緑（7 workspace projects）
  - `pnpm run lint`: 緑（`eslint .` エラー無し）
  - `pnpm run format:check`: 緑（`All matched files use Prettier code style!`。
    新設した `.mjs` を `prettier --write` で一度整形してから通した）
  - `pnpm run test`: 緑（ルート `vitest run` 50 files passed / 1 file skipped
    ＝鮮度の歯、941 tests passed / 2 skipped。各パッケージも全緑。**DB テストは
    実行していません**と告知されて緑——ADR 0015 の仕様どおり、「全部通った」
    ではない）
  - `pnpm run build`: 緑（`rm -rf packages/*/dist` してから実行。7 workspace
    projects）
  - `pnpm run pack:check`: 緑（6パッケージとも publish 梱包の門を通過）
  - 参考（6つの門には含まれないが ci.yml の `build` ジョブが実行する）:
    `pnpm run check:cjs-parse` も緑（92 個の配布物）。

## 確かめていないこと

- **GitHub Actions が `pull_request` イベントで PR ブランチへ自動 push する経路の
  実現可能性**（この設計はもう `main` への直接 push には依存しないが、
  「マージ側が手で行っている手順」を自動化するならこちらの経路になる。
  branch protection が feature ブランチへの bot push をどう扱うか、
  無限ループ防止などは、この環境では `gh` の書き込み権限が無く実験できない）。
  「これが覆るとしたら」1番に切り出した。
- **`main` の実際の CI 上で、鮮度検査が今回の設計どおり routine では
  発火しないこと。** 本 PR 自体が `main` に着地する squash コミットで
  この歯がどう振る舞うかは、CI 側で確認する（本 ADR の「測ったこと」は
  ローカルの使い捨てブランチでの再現であり、本物の GitHub Actions 上の
  `push: [main]` イベントでの確認ではない）。
- **マージする側（マネージャー）が実際にこの手順（PR ブランチ上での
  `git merge origin/main` → `generate-adr-index.mjs` の実行 → commit →
  push → squash merge）を毎回実行し続けられるか**——運用が定着するかどうかは
  今回の実装時点では検証しようがない。手順が本 ADR の想定より煩雑だと感じたら、
  簡略化（例: 上の bot 自動化）を別途検討する価値がある。
