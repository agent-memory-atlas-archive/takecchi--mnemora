# ADR 0211: PR タイトル/本文が付け替え後の古い ADR 番号を名指ししていないかを CI が検査する — 本文は誰も警告していなかった

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17
- **🔴 訂正の追記（2026-09-17、Issue #471）— 「偽陽性が構造的に出ない」は誤りだった。実装が壊れていた。**

  ⛔ **本文は書き換えていない**（この repo の作法）。**崩れたのは「構造的に出ない」という
  主張であって、決定そのもの（PR タイトル/本文の食い違いを CI で赤くする）は崩れていない。**

  **何が壊れていたか**: この ADR は見る対象を「**このブランチが自分で名乗って、自分で捨てた
  番号**」だと書いた。⛔ **だが実装では「名乗った」が「触った」になっていた**
  （`check-pr-adr-reference.mjs` の `loadClaimedNumbers()` が `git log --name-only` を
  `--diff-filter` 無しで使っていた）。⟹ **既存の ADR に訂正の追記を入れるだけの PR**
  ——**この repo が規律として推奨している、いちばん普通の形**——でも、その ADR の番号が
  「名乗った」に入り、何も追加していないので「捨てた」に落ちて、**PR 本文がその ADR を
  正しく名指ししているだけで赤くなっていた。**

  ⚠ **言葉の側だけが正しかった。**⟹ ⭐ **「構造的に出ない」と書いたなら、その構造を
  *実装が守っているか*を見ること。**

  **【実測】**（2026-09-17）PR [#472](https://github.com/takecchi/mnemora/pull/472)
  （ADR 0213 に34行の追記を入れるだけ・0削除）で再現した。`main` から切ったまっさらな
  ブランチで既存 ADR に1行足すだけでも `exit 1` になる。

  **どう直したか**: 付け替え（`git mv`）と既存 ADR の編集を分ける識別子は
  **「そのパスが削除されたか」**である——**付け替えは旧パスを消す。編集は何も消さない。**
  ⟹ `git log --diff-filter=D --no-renames --name-only` で**削除されたパスだけ**を見る形に
  変えた（`--no-renames` が要る。既定では git が rename を1件に畳み、旧パスが出てこない）。

  🔴 **⛔ 採らなかった直し方——「`origin/main` に実在する番号は、このブランチが捨てたもの
  ではありえない」。**別の担い手からこの識別子の提案を受けたが、**これを実装すると、
  この歯が捕まえるべき唯一の形を素通りさせる。**⭐ **番号を付け替えるのは、まさにその番号が
  他の PR に取られて `main` に着地したからである**——⟹ 捨てた番号は**定義上ほぼ常に
  `origin/main` に実在する。**【実測】この形を fixture にして歯を1本置き、その識別子を
  実装する変異を当てると、**その歯だけが赤くなる**ことを確かめた
  （`scripts/__tests__/check-pr-adr-reference.test.mjs` の
  「🔴 付け替えは、旧番号が origin/main に実在していても捕まえる」）。

  🔴 **なぜ変異試験4種が、この穴を見逃したか**（次に歯を置く人へ）:
  **変異試験は「正しいものを壊したら赤くなるか」を測る。**⛔ **「普通に使ったら緑か」は、
  変異ではないので測られない。**この ADR の歯の fixture は、**新しい番号を足して rename する
  ブランチしか作っておらず、既存の ADR を一度も触らなかった**——⟹ 通していたのは
  「**触っていない** ADR に言及する」であって、「**変更した** ADR に言及する」ではなかった。
  ⟹ ⭐ **歯を置くときは、変異とは別に「いちばん普通の使い方」を1本、必ず通すこと。**
  （回帰として `buildEditOnlyFixtureRepo()` を足し、歯を3本置いた。）

  ⚠ **この訂正で見えなくなったものは無い。**削除を見る形は、付け替え
  （`git mv` = 旧パスの削除）を漏らさない。⛔ **ただし元からの穴は残る**——
  「1つのコミットに ADR の追加と付け替えを圧縮した場合」は、旧パスが削除として履歴に
  現れないので検出できない（下の「確かめていないこと」に既に書いてある。**この訂正は
  その穴を広げも狭めもしない**）。

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 / 0200 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`gh`/`vitest` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

`scripts/adr-renumber.mjs`（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）は、マージ直前に
ADR の番号衝突を解消し、ファイル名・見出し・このブランチが追加した行の中の参照を機械的に
書き換える。**しかし追随しない場所が2つあり、どちらも `main` の履歴に永久に残る**:

1. **PR タイトル** — 既知。[ADR 0200](./0200-adr-renumber-warns-when-titles-need-fixing.md)
   （[Issue #405](https://github.com/takecchi/mnemora/issues/405)）が
   `renumberedTitleWarning()`（本 ADR で `renumberedReferenceWarning()` に改名）で警告を出し、
   人が `gh pr edit --title` で直す運用にした。
2. 🔴 **PR 本文** — **誰も警告していなかった。**

【現物】この repo は次の設定を持つ（`gh api repos/takecchi/mnemora -q
'{squash_merge_commit_title, squash_merge_commit_message}'` で確認済み）:

```json
{ "squash_merge_commit_title": "PR_TITLE", "squash_merge_commit_message": "PR_BODY" }
```

⟹ **PR タイトルだけでなく PR 本文も、そのまま squash commit の本文として `main` の履歴に
永久に残る。** ADR 0200 は「タイトルを直せ」としか警告していなかった——本文についての
機械的な検査も、人への警告も、どちらも存在していなかった。

## 【実測】数えた結果

`origin/main`（`cdb59a70457fcaad4f4ea60892f8bde2c7e432a2`）で ADR を追加した commit
190件を、それぞれの本文（`git log -1 --format=%b <sha>`）が「自分が足した ADR」を
どの番号で名指ししているかについて走査した。**本文が「足した」と言う番号と、実際に
追加したファイルの番号が食い違っている commit が2件**見つかった:

| commit（先頭7桁） | 実際に足した ADR | 本文が「足した」と言う番号 |
| --- | --- | --- |
| [`0e287eb`](https://github.com/takecchi/mnemora/commit/0e287eb442f03b032cd8bb901cace1545428d0fe) | **0210** | **0209** |
| [`aacb982e`](https://github.com/takecchi/mnemora/commit/aacb982ea499399c83d0c17bccc596d5ec6cecdd) | **0200** | **0199** |

【実測】どちらも `git show --diff-filter=A --name-only <sha> -- docs/decisions/` で
実際に追加されたファイルを確認した:

```
$ git show --diff-filter=A --name-only aacb982e -- docs/decisions/
docs/decisions/0200-adr-renumber-warns-when-titles-need-fixing.md

$ git show --diff-filter=A --name-only 0e287eb -- docs/decisions/
docs/decisions/0210-root-test-gate-runs-all-stages-regardless-of-failure.md
```

### ⭐ `aacb982e` は、まさに ADR 0200（PR タイトルの警告）を実装した、その PR である

`aacb982e`（PR #436）の PR 本文（squash commit の本文としてそのまま `main` に残っている）を
読むと、タイトルは正しく `ADR 0200` に直っているが、**本文中に `ADR 0199` が6箇所そのまま
残っている**（「1. **案2**: ... 純関数 `renumberedTitleWarning(renames)` を足した」の直後の
説明、「3. ADR 0199 を追加した」、Test plan の各行、末尾の「## ADR」セクションの
「Issue 405（ADR 0199）」等）。**「PR タイトルを直せ」という警告を実装した当の PR 自身が、
その警告が対象にしていなかった本文の直し忘れを実例として残した。** これは注意力では
止まらないことの、この repo における最良の実例である——警告を書いた本人が、警告の対象外
だった箇所で同じ事故を踏んでいる。

### さらに、その PR の本文自身が過去の紛れを2件記録している

`aacb982e` の本文は ADR 0200 の検算作業の一部として、過去の紛れ2件を報告している
（【受】ADR 0200 本文からの引用。この ADR ではこの2件を再検算していない）:

- `e47952e`（[full sha](https://github.com/takecchi/mnemora/commit/e47952e2b7958fe48c8b8eceef607069f9315caf)）
  — 実体は `0193` なのに `0192` を名乗る
- `2840492`（[full sha](https://github.com/takecchi/mnemora/commit/28404923748ec5bd44919a747b775dad53b9bb1a)）
  — 実体は `0163` なのに `0161` を名乗る

⟹ **この時点で、実測で確認できた「タイトルまたは本文が誤った番号を名乗った」事例は
少なくとも4件**（`0e287eb` / `aacb982e` に加え、`aacb982e` が記録した `e47952e` /
`2840492`）。

### ⚠ この間違いは「壊れた参照」ではない

【現物】付け替え前の番号は、たいてい別の ADR として実在する（例: `0209` は
[Issue #462](https://github.com/takecchi/mnemora/pull/462) の ADR）。⟹ **リンクは繋がり、
黙って別の文書を指す。** 壊れたリンク検査では捕まえられない——読み手は正しい番号の
ADR に着地したと信じたまま、実際には無関係な別の決定を読むことになる。

## 決定

### 1. 判定の純関数 — `scripts/check-pr-adr-reference-lib.mjs`

判定の芯:

- **`abandonedNumbers(claimedNumbers, addedNumbers)`** = 「このブランチが
  `docs/decisions/` 配下で一度でも名乗った ADR 番号」から「**いま**このブランチが
  `origin/main` に対して追加している ADR 番号」を引いたもの。
- PR の**タイトル**または**本文**が `abandonedNumbers` のいずれかを `ADR <番号>` か
  `<番号>-<slug>`（ファイル名・URL の形）で含んでいたら**違反**
  （`findAbandonedReferences` / `decidePrAdrReferenceCheck`）。

**⚠ この規則は偽陽性を出さない。** [ADR 0200](./0200-adr-renumber-warns-when-titles-need-fixing.md)
「検討して採らなかった案」の案5は、まさに素朴な「PR タイトルに `ADR NNNN` が出現するか」を
`main` の全281 commit に対して検査し、**偽陽性率≈87%**（15件中13件が既存 ADR への
正当な参照）という数字を出して却下していた。この lib はその轍を踏まない——見るのは
「**このブランチが自分で名乗って、自分で捨てた**番号」だけであり、他の ADR
（このブランチが一度も名乗ったことのない番号）への言及は、それがどれだけ本文中に
出現しても `abandonedNumbers` に入らないので一切引っかからない。この対象範囲の
絞り方そのものが、既存 ADR への正当な参照を誤検出しない根拠である。詳細な理由は
lib 自身の docstring に書いた。

### 2. CLI 入口 — `scripts/check-pr-adr-reference.mjs`

- `PR_TITLE` / `PR_BODY` を env から読む（`${{ }}` の直接展開ではなく `env:` 経由——
  `scripts/decide-publish-dry-run.mjs` / `publish.yml` の `dry_run` と同じ理由。利用者が
  書く自由記述の文字列を shell へ直接展開させないことで注入面を減らす）。`PR_BODY` が
  空・未定義でも `?? ""` で吸収し、落ちない。
- ブランチが名乗った番号は `git log --name-only --format= origin/main..HEAD --
  docs/decisions/` で集める。いま追加している番号は `git diff --diff-filter=A
  --name-only origin/main -- docs/decisions/`（`adr-renumber.mjs` の
  `loadAddedAdrFiles()` と同じ取り方）。パスから4桁番号への分解は
  `generate-adr-index-lib.mjs` の `isAdrFilename` と `adr-renumber-lib.mjs` の
  `parseAdrFilename` を再利用する（重複実装を避ける）。
- 違反があれば、見つかった番号・いまこのブランチが追加している番号・
  `gh pr edit <PR番号> --title ... --body ...` は**最後の push の前**に打つべきこと、を
  名指しして exit 1。違反が無ければ何を見て通したか（名乗った数・追加している番号・
  捨てた番号）を1行出して exit 0。

### 3. `.github/workflows/ci.yml` — `typecheck / lint / test / build` ジョブへの追記

- 新しいジョブは作らない——このジョブ名は branch protection の required check
  文字列そのものであり（`gh api repos/takecchi/mnemora/branches/main/protection` で
  ADR 0138 が確認済み）、増やすとオーナー権限が要る。
- `if: github.event_name == 'pull_request'`。`env:` 経由で
  `PR_TITLE: ${{ github.event.pull_request.title }}` /
  `PR_BODY: ${{ github.event.pull_request.body }}` を渡す。
- `actions/checkout` に `fetch-depth: 0` を足した（既定の shallow checkout では
  `origin/main..HEAD` が引けない）。**このジョブの他の全ステップ
  （typecheck/lint/format:check/test/build/api:check/check:cjs-parse/pack:check）を
  読み、`git` の履歴の深さに依存する処理が無いことを確認した**——影響は無い。
- `git fetch origin main` をステップの中で明示的に打つ——`.github/workflows/publish.yml`
  の「Release の tag が main の履歴上に在ることを確かめる」ステップが同じ形を取っている
  （`fetch-depth: 0` だけでは `origin/main` という ref 名が確実に解決できるとは限らない
  ため念のため明示、という同じ理由）。**`publish.yml` は読んだだけで、一切変更していない。**

### 4. なぜ `adr-renumber.mjs` に `gh pr edit` を打たせないか

⛔ **これは依頼者が既に決めた方針であり、この ADR で変えていない。** `adr-renumber.mjs`
は開発者の手元で走り、PR 番号をブランチ名から推測するしかない（複数の open な PR が
同じブランチ名を共有することは無いはずだが、PR 番号自体をこの道具は知らない——
呼び出し側が渡す必要がある。ADR 0200「これが覆るとしたら」も同じ設計上の制約を
挙げている）。**自動の書き込みは外れたときに外向きの事故になる**（誤った PR へ
書き込む、権限が無くて例外を出す、等）。一方、**赤い検査は外れても「止まるだけ」**
であり、人が見て正しい対処をする余地が残る。⟹ **安全側は赤。** この非対称性が、
「機械が直接 `gh pr edit` を打つ」案（ADR 0200 の案3、依頼者が明示的に却下）ではなく
「CI が検査して止める」案を選ぶ理由である。

### 5. `adr-renumber-lib.mjs` の警告を本文にも広げる

`renumberedTitleWarning()` を `renumberedReferenceWarning()` に改名し（呼び出し元
`scripts/adr-renumber.mjs` とその歯も追随させた）、文言を「PR タイトルと squash commit の
タイトルは機械が直せない」から「PR タイトルと**本文**——squash commit のタイトルと
**本文**の両方——は機械が直せない」へ広げ、`gh pr edit` の例に `--body` を足した。
`docs/autonomy.md` §4（マージ手順の一手）も同じ形に更新した。

## 検討して採らなかった案

- **`pull_request` の trigger に `edited` を足し、タイトル・本文の編集のたびに
  この検査を再実行する**: **却下。** `edited` を足すと、**PR の説明を1文字直すだけで
  `typecheck / lint / test / build` を含む13ジョブ全部が再実行される**（`ci.yml` の
  `pull_request:` は現在 types を指定しておらず、既定の `opened` / `synchronize` /
  `reopened` で動いている——`edited` を足すことは全ジョブへの影響であり、この検査
  だけを狙って足すことができない）。コストが割に合わない。
- **`adr-renumber.mjs` 自身が `gh pr edit` を叩く（ADR 0200 の案3）**: **却下（依頼者の
  既定方針、上記「4.」参照）。**
- **素朴に「PR タイトル/本文に `ADR NNNN` が出現するか」を repo 全体・全履歴に対して
  検査する（ADR 0200 の案5そのもの）**: **却下。** ADR 0200 が実測した偽陽性率≈87%が
  そのまま当てはまる。この ADR が採った `abandonedNumbers` による絞り込みは、その
  素朴な案とは別物である（対象を「このブランチ自身が捨てた番号」だけに絞ることで
  偽陽性を構造的に消している）。

## 引き受けた負債・🔴 残る穴

**最後の緑の push の「後」に PR タイトル・本文を編集すると、この検査は効かない。**
`ci.yml` の `pull_request` トリガーは既定の types（`opened` / `synchronize` /
`reopened`）のままであり、`edited` を足すと「本文を編集するたびに13ジョブが回り直す」
ため採らなかった（上記「検討して採らなかった案」）。⟹ **「タイトル／本文を直してから
push し、緑を引き直してからマージする」という儀式の順序に依拠している。これは検査
ではなく依拠である。** 本 ADR が足した CI の検査は、あくまで「最後の push 時点の
タイトル・本文」しか見ない——ADR 0200 が引き受けた負債1番（「警告は出力されるだけで
あり、読み飛ばされうる」）と同じ族の限界が、この機械検査にも形を変えて残っている
（「機械検査を通した後に、その検査が見ていない場所を直す」という新しい踏み方が
理論上ありうる）。

さらに、CLI の docstring に書いた通り、**同じ番号の追加とリネームが1コミットに
圧縮された場合**（例えば著者がローカルで `git commit --amend` や squash rebase を
した場合）、旧番号は `origin/main..HEAD` のどのコミットの diff にも現れず、
`abandonedNumbers` はそれを検出できない。実際に踏んだ2件（`0e287eb` / `aacb982e`）は
`adr-renumber.mjs` の儀式通り「追加コミット」と「renumber コミット」が別コミットとして
残る形だったため、この検査で検出できる（`scripts/__tests__/check-pr-adr-reference.test.mjs`
がこの形を実際の git 履歴で再現して確認している）。だが、この形が常に保たれる保証は
無い。

## これが覆るとしたら

- **`edited` トリガーを却下した判断が覆るとしたら** — 13ジョブ再実行のコストを
  下げる手段（例えばこの検査だけを独立した軽量ジョブとして `edited` にだけ反応させる。
  ただし新しいジョブは required check の文字列を増やすため、その時点で
  branch protection の更新も必要になる）が見つかったときである。
- **`gh pr edit` を機械に打たせない判断が覆るとしたら** — ADR 0200 の「これが覆る
  としたら」と同じ条件（警告の見落としが繰り返し発生し、「道具が repo 内で完結する」
  利益より「見落とし事故を無くす」利益が明確に上回ると判断されたとき）である。

## 測ったこと

- 【実測】`gh api repos/takecchi/mnemora -q
  '{squash_merge_commit_title, squash_merge_commit_message, allow_squash_merge}'` →
  `{"allow_squash_merge":true,"squash_merge_commit_message":"PR_BODY","squash_merge_commit_title":"PR_TITLE"}`。
- 【実測】`0e287eb` / `aacb982e` の2件について、`git show --diff-filter=A --name-only
  <sha> -- docs/decisions/` で実際に追加された ADR ファイルと、`git log -1
  --format='%s%n%n%b' <sha>` で見えるタイトル・本文が名乗る番号の食い違いを確認した
  （上表）。
- 【実測】`scripts/__tests__/check-pr-adr-reference-lib.test.mjs`（19 tests）と
  `scripts/__tests__/check-pr-adr-reference.test.mjs`（7 tests、本物の一時 git
  リポジトリを作って本物の CLI を子プロセスとして起動する）を新設。
  `scripts/__tests__/adr-renumber-lib.test.mjs` は31 tests（既存 + `本文` を
  検査する1件を追加）。
- 【実測】変異試験（`cp` で退避 → 変異を当てる → 赤くなることを確認 → `cp` で戻す →
  緑に戻ることと `git status --porcelain` が意図したファイルだけであることを確認。
  `git checkout` は使っていない）:
  1. `scripts/check-pr-adr-reference-lib.mjs` の `abandonedNumbers` から
     `if (added.has(n)) continue;` を落とす → `check-pr-adr-reference-lib.test.mjs`
     の4 tests が赤 → 復元して19 tests 全て緑。
  2. 同ファイルの `findAbandonedReferences` から stem マッチのブロックを丸ごと落とす
     → 2 tests が赤 → 復元して19 tests 全て緑。
  3. `scripts/check-pr-adr-reference.mjs` の違反時の `process.exit(1)` を
     `process.exit(0)` に変える → `check-pr-adr-reference.test.mjs` の2 tests が赤 →
     復元して7 tests 全て緑。
  4. `scripts/adr-renumber-lib.mjs` の `renumberedReferenceWarning` の返り値を
     旧文言（タイトルのみ言及）に戻す → `adr-renumber-lib.test.mjs` の2 tests が赤 →
     復元して31 tests 全て緑。
- 【実測】`pnpm exec vitest run scripts/__tests__/`（scripts 配下全体。ルートの
  `pnpm run test` は実行していない）→ 67 test files / 1221 tests 全て green。
- 【実測】`pnpm exec eslint scripts/` → エラー無し。
- 【実測】`pnpm exec prettier --check` 変更した `.mjs` ファイル全てに対して実行し、
  問題無し（1回 `--write` で直した）。
- 【実測】`git fetch origin` → `node scripts/adr-renumber.mjs --next` → `0211`
  （2026-09-17 12:30 JST。`origin/main` の ADR 数201、他のリモートブランチ13本、
  open な PR 3本の ADR 主張を見た上での楽観的な次の番号）。

## 確かめていないこと

- **`0e287eb` / `aacb982e` 以外に、本文が誤った番号を名乗っている commit が
  `main` の全履歴に他に無いかは、網羅的には数え直していない**——本 ADR の「数えた結果」
  節は、ADR 追加 commit（190件）の本文と実際に追加したファイルの番号を突き合わせた
  結果であり、素朴な「本文に `ADR NNNN` が出現するか」の全数検査（ADR 0200 の案5と
  同型で偽陽性率が高くなる）は行っていない。「実際に追加した ADR の番号」との
  一致・不一致だけを見ているため、ADR 0200 が却下した素朴な案とは異なる（偽陽性の
  出にくい）測り方である。
- **同じ番号の追加とリネームが1コミットに圧縮された場合にこの検査が検出できないこと**
  （上記「🔴 残る穴」）は、実際にそのような形の commit がこの repo の履歴に存在するか
  どうかまでは調べていない——設計上の限界として指摘するに留めた。
- **`scripts/check-pr-adr-reference.mjs` を実際の GitHub Actions 実行環境
  （`ubuntu-latest`、`actions/checkout@v6` の `fetch-depth: 0`）で走らせた実測は
  無い**——CI 上での実行結果は、本 PR 自身の CI 実行（この PR 自身も `abandonedNumbers`
  の対象になりうる。「自分の PR の本文に自分が取った番号を書くなら、付け替えが
  起きたときに直すこと」という自己適用の条件を、依頼者から指示されている）を見て
  確認すること。
- **`docs/autonomy.md` §4 の手順文書を本文の直し忘れも含む形に更新したが、
  実際にこの手順に従ってマージする側が本文まで直すかどうかは、運用（人の注意力）に
  依存する部分であり、道具の側では検証できない**（ADR 0200「引き受けた負債」1番と
  同じ限界）。
