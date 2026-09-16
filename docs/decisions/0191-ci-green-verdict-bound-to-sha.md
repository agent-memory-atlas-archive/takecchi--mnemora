# ADR 0191: 「CI が緑」の判定を sha に縛る——`gh pr merge --match-head-commit` を道具側で強制する（Issue #294）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0179 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`gh`/`vitest` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[Issue #294](https://github.com/takecchi/mnemora/issues/294)。**「CI が緑である」は
_sha に紐づく事実_ であって、_PR に紐づく事実_ ではない。** [ADR 0132](./0132-ci-green-verdict-procedure.md)
と `docs/autonomy.md` §2.1 は「どう引くか」（head sha を明示する・check-runs だけを見る・
`mergeStateStatus` を使わない・名前集合の再確認）を定めているが、「いつ引き直すか」を
定めていなかった。

2026-09-16、PR #283 で【受】（issue 本文からの報告。このセッションでは再導出していない）:
`ci-green-check.mjs --pr 283 --recheck-after 30` で green・stable を確認した直後に
ADR の文章を1コミット push したところ、その新しい sha は実際に赤くなった
（一過性の corepack `ECONNRESET` で、再実行すれば緑に戻る性質のものではあったが、
**「緑を確認済み」という記憶のままマージし得た**）。

## 決定

### 1. `docs/autonomy.md` §2.1 に「§2.1.1 いつ引き直すか」を新設した

現行の1〜6の手順に続けて、次を明示した:

- マージの直前に、そのときの HEAD に対して取り直す。「前に緑だった」は根拠にならない。
- ADR を含む PR では、`adr-renumber.mjs`（ADR 0179）と索引の再生成（ADR 0137）のコミット
  自体が sha を変える。⟹ それらを push した後に取り直す、という順序になる。
- 判定した sha を `gh pr merge --match-head-commit <sha>` に渡すこと。
- 報告・PR 本文に緑を書くときは、どの sha で見たかを必ず添える。

§2 の止まる条件チェックリスト・§4 の表にも、同じ観点（緑は sha に紐づく＝時間とともに
腐る）への参照を足した。

### 2. `gh pr merge --match-head-commit <sha>` で、道具側に「見た sha 以外はマージさせない」を強制させる

**【実測】** `gh pr merge --help`（`gh 2.101.0`）で `--match-head-commit SHA` フラグの
存在を確認した:

```
--match-head-commit SHA   Commit SHA that the pull request head must match to allow merge
```

`scripts/ci-green-check.mjs` を改修し、`--pr` を渡して green と判定したとき、
判定した sha を明示した上でそのまま貼れる `gh pr merge` コマンドを印字するようにした:

```
この判定は sha 309303a に対するものである。この sha 以外をマージしないこと:
  gh pr merge 365 --squash --delete-branch --match-head-commit 309303ab4ee5d0a07f7a094782cd80b6a7840dbe
```

この文字列の組み立ては純関数 `formatMatchHeadCommitHint(prNumber, sha)`
（`scripts/ci-green-check-lib.mjs`）に切り出し、`scripts/__tests__/ci-green-check-lib.test.mjs`
で単体テストした。**フルの40桁 sha をそのまま `--match-head-commit` に渡す**——
短縮 sha を渡すと、実行時の head（フル40桁で比較される）と一致しなくなる可能性がある
ため、意図的にフルを使う（下記「測ったこと」の変異試験参照）。

`--json` の出力（`{ repo, sha, verdict, stability }`）には元から `sha` がトップレベルに
入っていることを確認した——変更不要だった。

### 3. ADR 0132 に「2026-09-17 追記」を足した（本文の値は書き換えない）

ADR 0132 の1〜6の手順は今も正しい。足りなかったのは「いつ引き直すか」の1点だけであり、
`docs/memory-model.md` の「2026-09 訂正」「2026-09 追記」と同じ形で、末尾に追記の節を足した
（本文は書き換えていない）。

## 検討して採らなかった案

- **文書に「引き直せ」と書くだけで、道具は変えない。** **却下**——`AGENTS.md` が
  「複製した瞬間から、正文と要約はずれ始める」「規律ではなく注意力に依存しており、
  必ず失敗する」と明記している形そのものである。実際、ADR 0132 自身は「どう引くか」を
  正しく文書化していたが、「いつ」が抜けていたことに誰も気づかないまま PR #283 で
  実際に踏まれた——文書だけでは同じ抜けが再び起きる。
- **`ci-green-check.mjs` にマージまでやらせる**（判定したらそのまま `gh pr merge` を打つ）。
  **却下**——`docs/autonomy.md` §4.1 が⭐で「副作用のある手を、判定と同じ呼び出しに
  繋がない」と明示しており、正面から反する。判定（読み取り）と副作用（マージ）を
  同じプロセス・同じ呼び出しに混ぜると、判定ロジックのバグがそのままマージという
  取り消しにくい操作に直結する。**判定と副作用は分けたまま、`--match-head-commit` という
  `gh` 自身の機構で sha を縛るほうが、リスクの小さい強制のかけ方である。**
- **GitHub の branch protection・merge queue に任せる。** **却下**（この PR の範囲としては）
  ——repo 設定の変更はオーナーの領分であり（`docs/autonomy.md` §3 には無いが、
  `package.json` version・publish 等と同種の「取り消しにくい・製品側の判断」に近い）、
  エージェントが行う対象ではない。**この手が存在すること自体は ADR に書いて残す**——
  将来 branch protection が「head sha が変わったら PR を自動的にブロックする」設定を
  持てば、`--match-head-commit` の役割の一部・全部をそちらに移せる可能性がある
  （下記「これが覆るとしたら」）。

## 引き受けた負債

1. **`--match-head-commit` を実際に渡し、head が変わった状態で `gh pr merge` を実行して
   意図通り失敗することそのものは、この Issue #294 の作業では実地に再現していない。**
   `gh pr merge --help` の説明文とフラグの存在は確認したが、「渡した sha と食い違う head で
   実行したら本当に exit 非0 で落ちるか」は検証していない——下記「確かめていないこと」。
2. **`formatMatchHeadCommitHint` はマージコマンドを印字するだけで、実行はしない。**
   読む側がその出力をコピーせず、素の `gh pr merge <N> --squash` を別途手で打てば、
   この歯は何も強制しない。「印字された」ことと「実際にそのコマンドが使われた」ことの
   間にはまだ人間・エージェントの規律が要る——完全な機械強制ではない。
3. **`--sha` 直指定のときはこのヒントを出さない**（PR 番号が無いため）。この経路を使う
   運用（sha を直接指定してマージする）では、この ADR の対策は届かない。

## これが覆るとしたら

- `--match-head-commit` を実際に渡して検証したとき、期待通りに失敗しない・
  あるいは別の条件（例: フル sha でなく短縮 sha でも許容する／許容しない）が
  判明した場合、`formatMatchHeadCommitHint` の実装・この ADR の主張を修正する必要がある。
- GitHub の branch protection・merge queue が「head sha が変わったら自動的にマージを
  ブロックする」設定を持ち、かつオーナーがそれを有効化すると判断した場合、
  `--match-head-commit` を毎回手で渡す運用の一部は不要になりうる。
- `gh` の将来のバージョンで `--match-head-commit` の仕様・フラグ名が変わった場合、
  この ADR の実装・ヒント文字列を追随させる必要がある。

## 測ったこと

- 【実測】2026-09-17、本 ADR の番号として当初マネージャーから口頭で `0180` を払い出されたが、
  `node scripts/adr-renumber.mjs --next`（ADR 0179）を走らせたところ `0187` を返した——
  `origin/main` の ADR 171 本に加え、他のリモートブランチ14本と open な PR 5本の ADR 主張を
  見た結果である。⟹ **口頭の払い出しは、払い出した時点から既に陳腐化していた。**これは
  ADR 0179 が解こうとした問題そのものの実例であり、`--next` の最初の実地使用でもある。
- 【実測】上記の直後、マネージャーの指示に従い `git fetch origin main && git merge
  origin/main` を実行した（`origin/main` が `53d5ac5` → `4cfedd0` へ、PR #378「ADR 0183」・
  PR #376 を含む2本ぶん進んでいた）。マージ後に `node scripts/adr-renumber.mjs --next` を
  **再度**実行したところ、今度は `0191`（`origin/main` の ADR 173本、他のリモートブランチ17本、
  open な PR 4本を見た結果）を返した——**わずか数分の間に `0187` も既に陳腐化していた**
  ことになる。⟹ 最終的にこの ADR は `0191` として作成した。「`--next` が返した番号は、
  それを見た瞬間から次の並行 PR によって陳腐化しうる」という ADR 0179 の前提を、
  この PR 自身の作業過程で二重に実地確認した形になる。
- 【実測】`gh pr merge --help`（`gh version 2.101.0`）が `--match-head-commit SHA` を
  含むことを確認した。
- 【実測】`scripts/__tests__/ci-green-check-lib.test.mjs` に
  `formatMatchHeadCommitHint` の単体テストを2件追加し、`npx vitest run
  scripts/__tests__/ci-green-check-lib.test.mjs scripts/__tests__/ci-green-check.test.mjs`
  で **13 tests 全て green**（既存11 + 新規2）であることを確認した。
- 【実測】変異試験: `formatMatchHeadCommitHint` 内の `--match-head-commit ${sha}` を
  `--match-head-commit ${shortSha}`（短縮 sha）に意図的に書き換えたところ、
  新規追加した2 test がどちらも赤くなった（「フル sha を含む」「短縮 sha を含まない」の
  両方の assertion が失敗）。退避コピー（`cp`、`git checkout` は使わず）から復元し、
  13 test 全て green に戻ることを確認した。
- 【実測】`npx prettier --check "**/*.{ts,tsx,mts,cts,js,mjs,cjs,json}"` が
  「All matched files use Prettier code style!」を返す（この PR が触った
  `scripts/ci-green-check.mjs`・`scripts/ci-green-check-lib.mjs`・
  `scripts/__tests__/ci-green-check-lib.test.mjs` を含む）。
- 【実測】`npx eslint scripts/ci-green-check.mjs scripts/ci-green-check-lib.mjs
  scripts/__tests__/ci-green-check-lib.test.mjs scripts/__tests__/ci-green-check.test.mjs`
  が警告・エラー無しで終了。
- 【実測】`pnpm run typecheck` が全ワークスペースで green（この PR は `.mjs`/`.md`
  のみを変更しており、直接の対象ではないが、既存の型検査に影響していないことを確認した）。

## 確かめていないこと

- **`--match-head-commit` に食い違う sha を渡して実際に `gh pr merge` を実行し、
  意図通り失敗する（exit 非0・PR が未マージのまま残る）ことを、この repo の実 PR に
  対して再現していない。** `gh pr merge --help` の説明文以上の実地検証はしていない。
- **PR #283 で実際に赤くなった経緯**（`f69e4f24` が corepack の `ECONNRESET` で落ちた、
  という記述）は issue 本文からの【受】であり、このセッションでは自分の `gh` 呼び出しで
  再導出していない。
- **`--match-head-commit` が、`gh` 側で PR の head が「force-push で書き換わった」場合と
  「新しい commit が積まれた」場合を区別するか**は確認していない——このセッションで
  重要なのは「一致しない場合に落ちるか」であり、「どう一致しないか」の内訳までは
  掘っていない。
- **GitHub の branch protection・merge queue の設定状況**（この repo で現在有効かどうか）は
  確認していない——確認自体が repo 設定の閲覧であり、この PR の範囲外とした。
