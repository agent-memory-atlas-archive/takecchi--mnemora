# ADR 0132: 「CI が緑」の判定手順を自律作業の手引きに足す — head sha 明示・job 単位の conclusion・mergeStateStatus 不使用・安定性の再確認（Issue #228）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**（ADR 0126 / 0127 / 0128 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `gh`/`pnpm` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[Issue #228](https://github.com/takecchi/mnemora/issues/228)。**「CI が緑である」の判定手順が
`AGENTS.md` にも `docs/autonomy.md` にも書かれていない。** `docs/autonomy.md` §2 は
止まる条件に「CI が緑」を挙げるが、判定手順そのものは無い。issue は、素朴な判定が
実際に外れた4つの形を報告している（本日、5本の PR を通す過程での観測）:

1. 同じ sha の check の本数が、時間とともに増える
2. 同じ run の中に `failure` と `success` が同居する（run 全体の `conclusion` と
   job 単位の `conclusion` は別）
3. `mergeStateStatus` は緑の判定に使えない（`BLOCKED` は draft でも走行中でも出る）
4. draft でも本物の CI が走る（他 repo の「draft では skipped」という教訓は
   ここでは当たらない）

issue 自身は文面を決めておらず、入れるべき要素の箇条書きだけを残している
（上記4点 + 「手元の門の緑は CI の緑の代わりにしない」）。**本 ADR は、その要素を
実際の文書構造・スクリプトに落とす。**

## どこに書くか

**`docs/autonomy.md` §2 に「2.1 CI が緑の判定手順」として新設する。** 理由:

- issue が名指しした4点はすべて `docs/autonomy.md` の既存の記述（§2 の止まる条件、
  §4 の踏むと痛い穴）に隣接する話であり、`AGENTS.md`（もっと一般の手引き）よりも
  この文書に置くほうが近い。
- **`docs/autonomy.md` §3（してはいけないこと）には触れない。** §3 の
  「PR のマージはオーナー専権」という記述は PR #212（Issue #203）が扱っている
  別件であり、オーナー判断で保留中——本 ADR の変更が触れるのは §2 とその新設節、
  および §4 の表への追記だけである。

## 決定

1. `docs/autonomy.md` §2 の末尾（§3 の手前）に **§2.1「CI が緑の判定手順」** を新設し、
   issue が挙げた4点それぞれに対応する具体的なコマンドと読み方を書く
   （`gh pr view --json headRefOid` → `gh api .../check-runs --paginate` → job 単位で
   `status`/`conclusion` を読む、`mergeStateStatus` を使わない、間隔を空けた再確認）。
2. §2 の止まる条件チェックリストの「CI が緑」の行に、§2.1 への参照を足す。
3. §4（踏むと痛い穴）の表に1行足し、この Issue の観測を要約して§2.1 へ誘導する。
4. **判定を機械化する道具を作る**:
   - `scripts/ci-green-check-lib.mjs` — 純関数のみ。`summarizeCheckRuns`（pending/
     nonSuccess の抽出）・`verdict`（green/red/pending の判定）・
     `compareCheckRunNameSets`（2回のポーリング間で check run の名前集合が
     動いたかを見る）。
   - `scripts/ci-green-check.mjs` — CLI。`--pr <番号>` か `--sha <sha>` を受け、
     `gh pr view`/`gh api .../check-runs` を呼んで判定する。`--recheck-after <秒>` で
     間隔を空けた再確認、`--json` で機械可読出力。終了コード
     `0`=green・`1`=red・`2`=pending・`3`=実行時エラー。
   - `scripts/__tests__/ci-green-check-lib.test.mjs` — 上記純関数の単体テスト。
   - `scripts/__tests__/ci-green-check.test.mjs` — CLI の**引数検査のみ**を子プロセスで
     検査する（`gh` を呼ぶ経路は検査しない。下記「検討して採らなかった案」参照）。
   - `package.json` に `"ci:green-check": "node scripts/ci-green-check.mjs"` を追加。

## 検討して採らなかった案

- **`mergeStateStatus` を補助シグナルとして使う**（例: `CLEAN` なら追加確認をスキップする
  高速パス）。**却下**——issue の観測3が示す通り、`CLEAN` は全 check が終端に達した
  **結果**であって、それ自体は何も追加の情報を持たない。使うと「`mergeStateStatus` を
  見た」という手順が正典に残ってしまい、次に読む人が「これも根拠の一部か」と
  誤解しうる。**判定の入力から完全に外し、CLI では参考情報としてラベル付きで
  表示するだけ**にした。
- **run 全体の `conclusion`（`gh api .../actions/runs/<id>`）を判定に使う**。
  **却下**——観測2で確認した通り（下記「検算した」）、run 全体が `failure` でも
  個々の job は `success` でありうる。job 単位（Checks API の `check_runs[]`）だけを
  見る設計にした。
- **`gh pr checks --watch` をそのまま判定手順として採用する**。**却下**——`--watch` は
  終了するまでブロックする対話的なコマンドであり、**終了したことが「もう本数が
  増えない」ことの証明になる保証を確認していない**（issue の「確かめていないこと」に
  同じ記載が在る）。本 ADR のツールは、終了を待つ代わりに**間隔を空けた2回のポーリング
  で名前集合を比較する**——弱い確認だが、「何を確認したか」が明示的で、
  「watch が終わったから大丈夫」という無根拠の安心感を生まない。
- **`--recheck-after` を、名前集合が安定するまで無限に繰り返す `--watch` 相当の
  モードにする**。**却下**（今回のスコープでは）——上限の無いポーリングは
  CI が本当に詰まっている場合に呼び出し元を無期限に止める。今回は「2回だけ比較する」
  という最小の道具にとどめ、繰り返しが要るなら呼び出し側（エージェント）が
  ループを書く。**引き受けた負債参照**。
- **`gh` の呼び出しを含む統合テストを CI（typecheck/lint/test/build ジョブ）に足す**。
  **却下**——そのジョブに GitHub API への到達性・認証済み `gh` が在る保証を確認して
  おらず、依存すると「歯が赤い」のか「環境に `gh` が届いていない」のかが
  区別できなくなる。CLI のテストは `gh` を呼ぶ手前の引数検査だけに絞り、
  判定ロジック本体は `gh` から独立した純関数（`ci-green-check-lib.mjs`）としてテストした。

## 理由

issue が観測した4点のうち、少なくとも2点（run と job の `conclusion` の差、
手元の門の緑が CI の緑を予測しないこと）は、**この ADR の作業中に自分の `gh` 呼び出しで
再検算できた**（下記「検算した」）。**残りは、この repo で今日確認できる形と
確認できない形に分かれる**（下記「検算していない」）。この非対称そのものを
正典に残す——「issue に書いてあったから正しい」ではなく、「これは自分で確かめた」
「これは確かめていない」を分けて書くことが、`AGENTS.md`・`docs/autonomy.md` §5 が
求めている規律である。

## 結果（この決定が招くもの）

- 以後、CI の緑・赤を判定するときに `node scripts/ci-green-check.mjs --pr <番号>` を
  使う経路ができる。使わずに素朴な判定をした場合、この ADR・§2.1 の記述と
  食い違う判断をしたことになる。
- CLI が `--json` を出すため、他のスクリプト・将来の道具から判定結果を機械的に
  拾えるようになる（今回はそこまで配線しない——単体で使えることが要件であり、
  他の道具からの呼び出しは範囲外）。

## 引き受けた負債

1. **`--recheck-after` による安定性確認は、2回の比較でしかない。**
   「もう check-runs は増えない」ことの証明にはならない——2回とも同じだった、
   という以上の主張はしない（CLI の出力・docstring にもその旨を明記した）。
   繰り返し回数を増やす・上限付きの watch モードにする、といった強化は
   今回のスコープに入れなかった。
2. **`mergeStateStatus` を判定に使わないと決めたが、CLI は参考情報として出力する。**
   ラベル（「判定には使わない」）で防いでいるだけであり、読む側がラベルを無視して
   その値を根拠にしてしまう可能性を完全には塞げていない。
3. **CLI の統合テストが `gh` を呼ぶ経路を検査していない。** 引数検査より先の
   ロジック（`gh` の呼び出し・出力の解釈）は、純関数側の単体テストと、
   本 ADR 作成時に手動で行った実行（下記「検算した」）でしか裏付けられていない。
   `gh` の出力形式が変わったときにこの CLI が壊れることを検出する自動の歯は無い。
4. **check-runs の「本数が最終的に何本か」を事前に知る方法は、依然として無い。**
   issue の「確かめていないこと」が持ち越されている。

## これが覆るとしたら

- GitHub の Checks API が job 単位と run 単位の `conclusion` を統合する、あるいは
  「まだ登録されていない check がある」ことを構造的に示すフィールドを追加した場合、
  §2.1 の手順・`ci-green-check-lib.mjs` の設計はその新しい情報源に合わせて
  作り直せる。
- `gh pr checks --watch` が「これで本数が確定する」ことを保証すると
  GitHub 公式ドキュメントか実測で確認できた場合、`--recheck-after` の
  素朴な2回比較よりそちらを優先する判断がありうる。
- この repo で `mergeStateStatus` が実際に緑・赤の先行指標として使える条件
  （例: 全 check 完了後の一瞬だけ `CLEAN` を経由する、等）が実測で確認された場合、
  §2.1 に補助的な使い方として書き足す余地はある——ただし本 ADR の時点では
  そのような条件を確認していない。

## 検算した（このセッションで自分の `gh` 呼び出しにより再現・検算したもの）

- **【実測】観測2（run 全体と job の `conclusion` が別）**: PR #220 のマージ後、
  issue が名指しした run `34909106996` を直接引いた。

  ```
  gh api repos/takecchi/mnemora/actions/runs/34909106996 -q '{status,conclusion,head_sha,event}'
  → {"conclusion":"failure","event":"pull_request","head_sha":"1e05f748...","status":"completed"}

  gh api repos/takecchi/mnemora/actions/runs/34909106996/jobs -q '.jobs[] | {name, status, conclusion}'
  → 10 jobs。9件が success、"typecheck / lint / test / build" のみ failure。
    「掃引(Runtime.sweepArchive)が「載る量」/hit@k に効くかを実測し、値を残す」
    （issue の言う archive-sweep-cost 相当）は success。
  ```

  ⟹ **issue の観測2を、この repo の実データで確認した。** run 全体の `conclusion`
  （`failure`）と、その中の1 job の `conclusion`（`success`）が異なることを、
  自分の `gh` 呼び出しで見た。

- **【実測】観測5 の具体例（手元相当のジョブが緑でも DB 側だけ赤くなる）**:
  PR #226 のコミット `565be6783a1e4e073c598b5e6285dfedf6aa8ee5` の check-runs を引いた。

  ```
  gh api repos/takecchi/mnemora/commits/565be6783a1e4e073c598b5e6285dfedf6aa8ee5/check-runs \
    -q '.check_runs[] | {name, conclusion}'
  ```

  結果: 11 job のうち **3件だけ** `failure`
  （`packages/postgres (UTF8)` / `packages/postgres (SQL_ASCII)` /
  「ルートの test 門の DB 段」）。**`typecheck / lint / test / build`
  （手元の6つの門に相当するジョブ）は `success`。**

  ⟹ **手元相当のジョブが緑でも、DB を要する3ジョブだけが赤くなる、という
  issue の主張の構造を、この repo の実データで確認した。**
  ⚠ **確かめていないこと**: issue 本文が挙げた具体的な原因
  （「マイグレーションがスキーマ横断で CHECK 制約の候補を2件拾い、
  `RAISE EXCEPTION` が発火した」）そのものは、このセッションでは検証していない
  ——コード変更の履歴を読めば追えるはずだが、今回は「赤くなった3ジョブの内訳」
  という構造だけを検算し、根本原因のコードは読んでいない。

- **【実測】観測1 の構造的な裏付け（本数が増える仕組み）**: PR #220 の head
  `7d05672` の check-runs は**現時点で11件、全件 `success`**（`gh api
  .../commits/7d05672.../check-runs --paginate` で確認）。`.github/workflows/ci.yml`
  を読むと、11件のうちの1つ
  「両方の server_encoding regime が実際に走ったことを測る (Issue #155)」に対応する
  job（`postgres-regime-coverage`）は `needs: postgres` を持ち、`postgres` は
  UTF8/SQL_ASCII の2 regime を matrix で走らせるジョブである
  （`.github/workflows/ci.yml` 177〜182行目）。

  ⟹ **「依存ジョブが後から登録・完了する」という機序そのものは、この repo の
  workflow 定義から確認した。** ⚠ **確かめていないこと**: issue が報告した
  「最初は10件、後で11件になった」という**時系列そのもの**は、両方の時点の
  check-runs が既にこのセッション開始時点で確定済み（PR #220 はマージ済み）だった
  ため、**このセッションでは再現できていない**——確認できたのは「そうなる
  仕組みが実在する」ことだけである。この PR 自身（本 ADR を運ぶ
  `docs/228-ci-green-criteria` ブランチ）の CI を観測することで、本数が
  途中で変わるかどうかをリアルタイムで見る機会があり、その結果は
  下記「本 PR 自身の CI を見て確認したこと」に追記する。

## 検算していない（出所: Issue #228。このセッションでは再導出していない）

**下の「本 PR 自身の CI を見て確認したこと」により、観測1（機序＋部分的な時系列）・
観測3（`BLOCKED`）・観測4（draft でも実 CI）は、このセッションで実際に検算できた。**
それでも検算できていない部分は次の通り:

- **観測1の秒単位の時系列**（「10件だったものが、まさに11件に変わった瞬間」）。
  「10件で始まり、11件目の条件（`postgres` matrix 完了）がまだ揃っていない」ところまでは
  自分の PR で確認できたが、**11件へ実際に増える瞬間をこのセッションで見届けたかは、
  本 ADR 末尾の追記時点で確定する**（下記参照）。
- **`mergeStateStatus` が `CLEAN` に変わる瞬間**——全 check が終端に達した直後に
  `CLEAN` を経由するかどうかは、本 PR の CI が全部終わった時点で追加確認する
  （下記参照）。issue が対象にした PR（#220 等）は本 ADR 作成時点で既にマージ済みで
  `mergeStateStatus` が `UNKNOWN` に変わっており、過去の値を遡って見る手段が無い。
- **`skipped` がこの repo で出る条件**。issue 本文と同じく、今回も測っていない
  （今回の10〜11件も全件 `success` か `in_progress` であり、`skipped` は出ていない）。
- **「本数が最終的に何本か」を事前に知る方法**。§2.1・`--recheck-after` は
  弱い確認（2回一致）を提供するだけで、確定的な判定手順ではない。
- **issue 本文の根本原因の記述**（マイグレーションが CHECK 制約の候補を2件拾い
  `RAISE EXCEPTION` が発火した、という具体的なコード上の原因）はコードを読んで
  いない——検算したのは「赤くなった3ジョブの内訳」という構造だけである。

## 本 PR 自身の CI を見て確認したこと

`docs/228-ci-green-criteria` ブランチを **draft PR #239** として実際に出し（head sha
`6908fa4fb65274c555cfe59028d313b082c651ab`）、その CI をこのセッションでリアルタイムに
観測した。

- **【実測】観測4（draft でも本物の CI が走る）**: PR #239 は `isDraft: true` のまま、
  push 直後に `gh api repos/takecchi/mnemora/commits/<sha>/check-runs` で
  **10件の check-runs が `status: "in_progress"` として登録された**（`conclusion` は
  すべて `null`）。**`skipped` は1本も無かった。** ⟹ issue の観測4を、この repo の
  今回の PR で直接再現・確認した。
- **【実測】観測3（`mergeStateStatus` は draft/走行中に `BLOCKED` を返す）**:
  push 直後、`gh pr view 239 --json mergeStateStatus` は **`"BLOCKED"`** を返した
  （このとき `isDraft: true` かつ check-runs は全件 `in_progress`）。⟹ issue の観測3
  （`BLOCKED` は draft のときにも check 走行中にも出る）の少なくとも一方
  （draft かつ走行中）を、この PR 自身で確認した。
- **【実測】観測1（check の本数が後から増える機序）**: push 直後の10件の内訳を見ると、
  `.github/workflows/ci.yml` の `postgres-regime-coverage`（`needs: postgres`、
  「両方の server_encoding regime が実際に走ったことを測る」ジョブ）は
  **最初の10件に含まれていなかった**——`postgres` matrix（UTF8/SQL_ASCII の2脚）が
  ある前提のジョブであり、GitHub Actions は `needs:` を持つジョブの check-run を、
  依存先が終わるまで一覧に出さない（少なくともこの回はそう振る舞った）。
  ⟹ **issue の「10件→11件」という観測を、この PR 自身でほぼそのまま再現できた**
  （厳密には「10件で始まり、11件目が要る条件のジョブがまだ無い」ところまでを
  確認した時点の記録であり、実際に11件へ増えた瞬間を秒単位で見届けたわけではない
  ——増えたことの確認は、この ADR の更新後に本 PR が完了した時点の
  check-runs 総数で裏付ける）。

（このセクションは CI 完了後にさらに追記する。）

## 2026-09-17 追記（Issue #294）——「いつ引き直すか」が欠けていた

**⚠ 本節は訂正ではなく追記である。**上の1〜6が定めた「どう引くか」の手順は今も正しい。
足りなかったのは、**その手順をいつ実行するか**——判定と `gh pr merge` の間に push が
1本でも挟まれば、判定は古い sha のものになる、という一点だけである。

**問い**: [Issue #294](https://github.com/takecchi/mnemora/issues/294)。2026-09-16、
PR #283 で【実測】として次を踏んだ: `adc837cd` に対して
`node scripts/ci-green-check.mjs --pr 283 --recheck-after 30` を実行し、
`status=green — 11件すべてが completed かつ success`・`stable=true` を得た。
そのあと ADR の文章を1コミット足して push（`f69e4f24`）したところ、
**その sha は実際に赤くなった**（一過性の corepack `ECONNRESET` で、再実行すれば
緑に戻る性質のものではあったが、**「緑を確認済み」という記憶のままマージし得た**——
もし push がコードを本当に壊していたら、その赤に気づかないままマージする経路が
成立していた）。`ci-green-check.mjs` 自身は `--pr` のたびに `headRefOid` を
取り直すため正しく振る舞っている——**道具の欠陥ではなく、手順の欠落**である。

**決定**: `docs/autonomy.md` §2.1 に「§2.1.1 いつ引き直すか」を新設し、次を明示した。

1. ⭐ マージの直前に、そのときの HEAD に対して取り直す。「前に緑だった」は根拠にならない。
2. ADR を含む PR では、`adr-renumber.mjs`（ADR 0179）・索引再生成（ADR 0137）のコミット
   自体が sha を変えるため、**それらを push した後に**取り直す順序になる。
3. ⭐ **判定した sha を `gh pr merge --match-head-commit <sha>` に渡す。**
   `gh pr merge --help`（`gh 2.101.0`）で `--match-head-commit SHA` フラグの存在を確認した——
   渡した sha と実行時の PR head が一致しないとマージが失敗する。これにより、
   「緑を見た sha」と「実際にマージされる sha」の一致を**道具が機械的に強制する**。
4. 報告・PR 本文に緑を書くときは、どの sha で見たかを必ず添える。

**なぜ ADR 本文の値を書き換えないか**: 上の1〜6の手順・検算・引き受けた負債は、
2026-09-15 時点の事実として今も正しい。変わったのは「その手順をいつ実行するか」という、
1〜6が扱っていなかった軸が1本増えたことだけである。`AGENTS.md` が実装とドキュメントの
不一致を「実装のバグ」として扱う原則と同型で、この repo の ADR は確定した記録を書き換えず
追記で訂正・補足する慣行を取る（`docs/memory-model.md` の「2026-09 訂正」「2026-09 追記」の
各節が同じ形を踏んでいる）。

**採らなかった案**（この後に続く新しい ADR「検討して採らなかった案」に詳細）:
文書に「引き直せ」と書くだけで道具を変えない案は、`AGENTS.md` が「規律ではなく注意力に
依存しており、必ず失敗する」と明記する形そのものであるため却下した。
`ci-green-check.mjs` にマージまでやらせる案は、`docs/autonomy.md` §4.1 の
「副作用のある手を、判定と同じ呼び出しに繋がない」に正面から反するため却下した。
判定と副作用（マージ）は分けたまま、`--match-head-commit` で sha を縛る形を採った。

**引き受けた負債**: `--match-head-commit` を実際に渡し、head が変わった状態で
`gh pr merge` を実行して意図通り失敗することそのものは、この Issue #294 の作業では
実地に再現していない（`gh pr merge --help` の説明文とフラグの存在は確認済みだが、
実際の失敗挙動は未検証のまま運用に入る）。詳細・測ったこと・確かめていないことの全体は
この後に続く新しい ADR（番号はマージ直前に確定する。ADR 0179）に切り出した——本節は ADR 0132 側からその ADR への導線として、
「1〜6は変わらず正しい」「7番目の軸（いつ）が要る」という結論だけを記す。
