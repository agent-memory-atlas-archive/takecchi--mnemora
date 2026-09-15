# ADR 0127: pgvector ジョブの本数固定を、絶対数ではなく不変条件で持つ — 「同じ regime を宣言しているか」だけを歯にし、「今何本あるか」は数えない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**（ADR 0105 / 0106 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[Issue #224](https://github.com/takecchi/mnemora/issues/224)。

`scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` は
`.github/workflows/ci.yml` の pgvector service の本数を絶対値で持っている
（`toHaveLength(8)` / `toHaveLength(7)`）。**2026-09-15、PR #220 と #221 が
それぞれ独立に pgvector ジョブを1本ずつ足し、どちらも「自分の分だけ」を数え直して
6→7 に更新した。実数は8だった。** ADR 番号のような排他割当と違い、**本数は
両方が着地して初めて正しい値が決まる**ため、後から着地する側が数え直さない限り
main が赤くなる構造的な罠である。

この ADR は、Issue #224 が提示した3案のうちどれを採るかを決め、実装する。

## この歯は何を守っているのか（先に言葉にする。ADR 0126 と同じ順序）

[ADR 0106](./0106-ci-declares-the-regime-it-measures.md) の主張は
**「1本（現在は `postgres` ジョブの1脚）で実測した regime が、他のジョブにも効く」**
である。これが成り立つために技術的に必要な条件は次の2つだけである。

1. **matrix 配線（実測している側）がちょうど1本であること。**
   2本以上が独立に matrix 化されると「1本の実測が他に効く」という前提の
   「1本」が崩れる。
2. **matrix 配線されていない残り全部が、matrix の UTF8 脚と同じ
   `POSTGRES_INITDB_ARGS` を宣言していること。**

**この2つの成立に、pgvector ジョブの絶対本数（8, 7 …）は要らない。** 1 は
「ちょうど1本」という条件であって「何本ある」ではなく、2 は「全部揃っている」
という条件であって「何本揃っている」ではない。

一方、絶対本数が捕まえていたのは別の主張——**「pgvector ジョブが知らないうちに
増減したこと」**である。Issue #224 はこれを歯の意図として明示している。
この ADR は、その主張を捨ててよいかどうかを次節で論じる（結論: 捨てる。
理由は「採用する案」節）。

## 検討した3案

### 案1: 本数を数える形にやめる（単純カウント化）

却下。Issue #224 自身が「単に数える形にすると、歯が守っていた主張
（知らないうちに増減したことを捕まえる）が消える」と釘を刺しており、
何が失われるかを言葉にせずに倒すのは ADR 0126 の手本（歯を黙らせない）に反する。

### 案2: 「本数」ではなく「不変条件」だけを固定し、本数の固定は別の歯へ分離する（採用）

上の「この歯は何を守っているのか」で導いた2条件（matrix 配線が1本／残り全部が
同一の宣言を持つ）だけを歯にする。**「本数の固定を別の歯へ分離する」は行わない**
——理由は下記「絶対本数を捨てた判断」を参照。

### 案3: 本数の固定は残し、更新漏れを別の形で捕まえる（PR テンプレ等）

却下。人の注意力に依存する（`AGENTS.md` 「規律ではなく注意力に依存しており、
必ず失敗する」）。加えて、今回のトラップは「更新し忘れ」ではなく
**「両者とも正しく更新したのに、結果が誤って一致した」**ことが本質であり、
注意を促す仕組みは今回の失敗モードそのものには効かない
（#220 も #221 も、自分の変更点は正しく数えていた）。

## 絶対本数を捨てた判断（案1が警告する「主張が消える」への回答）

**捨てる。** 理由は「diff を見れば増減は分かるから」ではない
（`AGENTS.md` が名指しで退けている論法であり、この ADR もそれだけでは
済ませない）。理由は次の2点。

1. **pgvector ジョブの追加は、それ自体が ci.yml 側で数十行規模の diff になる**
   （services / env / steps / needs …）。これは「同じ値を別の場所にも書いていて
   片方だけ直し忘れる」という AGENTS.md が警告する形（正文と要約の重複）とは
   **逆の性質を持つ**——本体の変更が hide できない大きさで必ず diff に現れる。
   一方で **絶対本数の歯自体（スカラー1個）は、無関係な test ファイルの中の
   数値でしかなく、本体の変更を見た人がその1行も見るとは限らない。**
   ⟹ 絶対本数の歯は「見落としを防ぐ装置」ではなく、**それ自体が
   「複製した値を人力で同期し続ける」という、AGENTS.md が退けている形**に
   なっていた。#220/#221 はまさにその同期に失敗した実例である。
2. **絶対本数が唯一追加で捕まえるのは「宣言は完全に正しいまま、本数だけが
   変わった」ケースである。** これは ADR 0106 の技術的主張（1本の実測が
   他に効く）にとって**何も破れていない**——正しく宣言された pgvector ジョブが
   1本増えることは、regime の観点では無害である。絶対本数はこのケースを
   「気づかれるべき変化」として扱っていたが、それは技術的正しさの話ではなく
   **監査・認知のための信号**だった。監査目的なら、独立した test の中の
   マジックナンバーより、ci.yml の diff そのもの・PR 説明・レビューの方が
   一次情報として優れており、二重管理する理由が無い。

⟹ **本数の固定は、別の歯へ分離もしない。** 分離しても「本数を独立に数え直す
複数箇所」という構造は変わらず、#220/#221 の罠がその新しい歯の上でも
再現しうる。捨てるのが一貫した結論である。

## 決定

`scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` の
`describe("ci.yml の8本の pgvector ジョブが regime を宣言していること…")` を
`describe("ci.yml の pgvector ジョブが regime を宣言していること…")`
(本数への言及を外した名前)に変え、中身を次のように変える（詳細・実装は本 PR の diff、測ったことは下記「測ったこと」節）。

1. **削除**: `serviceBlocks` の `toHaveLength(8)`。
2. **削除**: `fixedValues` の `toHaveLength(7)`。
3. **維持**: `matrixWired` の `toHaveLength(1)`
   （matrix 配線がちょうど1本、という構造的な条件——上の「この歯は何を守っているのか」
   の条件1そのもの。この「1」は #220/#221 型の罠を受けない。理由は「なぜ matrixWired=1
   は同じ罠を受けないか」節）。
4. **維持・強化**: `distinctFixed.size === 1` と UTF8 脚との一致
   （条件2そのもの）。加えて `fixedValues.length` が 0 でないこと・
   `serviceBlocks.length` が 0 でないことを明示の陰性対照として残す
   （空集合が偶然 `size===1` 相当の判定をすり抜けないようにする——実際には
   `distinctFixed.size` は空なら `0` になり `toBe(1)` に落ちるため技術的には
   冗長だが、意図を読める形で残す）。
5. describe / it の docstring を、この ADR の言葉（何を守っているか・
   何を捨てたか）に合わせて書き直す。

### なぜ `matrixWired === 1` は同じ罠を受けないか

#220/#221 の罠は「複数の独立な PR が、同じ方向（+1 ジョブ）の変更を、
互いの存在を知らないまま行う」ことが日常的に起きる場所（新しい pgvector ジョブを
足す）で発生した。**matrix 化はそれとは性質が違う**——ADR 0105 が明示する通り
「まず1本で機序を確かめる」という**単発の設計判断**であり、他のジョブを matrix
化するかどうかはそれ自体が新しい ADR を要する意思決定である（ADR 0106
「これが覆るとしたら」節）。日常的に複数 PR が並行して「もう1本 matrix 化しよう」と
思いつく状況は、日常的に「もう1本 pgvector ジョブを足そう」と思いつく状況とは
頻度も性質も異なる。⟹ この「1」は #224 の罠の対象にならない
（このリスクが顕在化したら、この ADR の「これが覆るとしたら」節へ戻る）。

## 検討して採らなかった案（実装の細部）

### 「1本以上」の下限すら置かない（何も数えない） — 却下

`serviceBlocks.length` が 0（pgvector ジョブが全部消えた）でも、絶対数を
一切見ない実装なら green のまま通ってしまう。それは「不変条件」ですらなく
「何も測っていない」に近い。**「1本以上」という最小の陰性対照は残す**——
これは #220/#221 の罠（両方が正しく数えているのに結果が食い違う）を
再導入しない範囲での下限であり、絶対数の固定とは性質が違う
（0 か 0 でないか、の二値であって、両者が独立に更新する対象ではない）。

### `distinctFixed.size` の非空チェックを省く（`toBe(1)` だけに任せる） — 採らなかったが実質等価

`fixedValues` が空でも `new Set([]).size` は `0` であり `toBe(1)` は
既に落ちる。**技術的には `fixedValues.length > 0` の明示チェックは冗長**
だが、意図（「matrix 化していないジョブが1本も無い状態」を陰性対照として
考えた）を読める形にするため、明示のまま残した（ADR 0126 の「陰性対照」の
考え方を踏襲——冗長でも意図を歯に残す）。

## 引き受けた負債

1. **「pgvector ジョブが知らないうちに増減したこと」を機械的に捕まえる手段は、
   もう無い。** この ADR の判断（絶対本数が捕まえていたのは技術的正しさではなく
   監査・認知の信号であり、かつジョブ追加自体は diff で十分に大きい変更として
   現れる）を採ったことの直接の結果である。もしこれが誤りだと分かったら
   （例えば、pgvector ジョブの追加が実際に見落とされる事例が起きたら）、
   「これが覆るとしたら」節へ戻ること。
2. **この PR の作業環境には本物の Postgres が無く、`test:db` を一度も
   走らせていない。** `ci.yml` の YAML としての妥当性・この歯自体の単体テストは
   手元で確認したが、実際に GitHub Actions 上で `postgres` / `postgres-regime-coverage`
   ジョブが従来どおり動くかは、この PR の CI が確認する（このADRはci.ymlの本文を
   変更していないため、regime 関連の挙動は変わらないはずだが、実測ではない）。
3. **`docs/decisions/0105-postgres-regime-matrix.md` / `0106-...md` 本文の
   数字（6本・8本という記述）はそのまま残した。** これらは当時の記録であり、
   書き換えない（`AGENTS.md` の「当時の記録は書き換えない」方針。ADR 0106 の
   決定4は、この ADR が変える歯の実装の**理由の記述**として引き続き参照される）。

## これが覆るとしたら

- **2本目の matrix 化が実際に提案されたとき。** そのときは
  「なぜ `matrixWired === 1` は同じ罠を受けないか」の前提が変わる
  ——「単発の設計判断」ではなく「日常的に増える対象」になるなら、この ADR の
  結論（絶対数の固定は不要）を、matrix 化された本数についても再検討する必要がある。
- **「知らないうちに増減したこと」を検知する価値が、別の理由で必要になったとき**
  （例えば `required status checks` や課金上限の管理のため）。そのときは
  この ADR の「絶対本数を捨てた判断」を読み直し、目的に応じた別の検知手段
  （ci.yml の diff を要約する等、レビュー支援の形）を検討する——**同じ形の
  絶対数の歯を復活させない**（同じ罠を再導入することになる）。

## 測ったこと

- **【現物】** `git grep -n "image: pgvector/pgvector" .github/workflows/ci.yml` で
  services ブロックが8本あることを確認した(`postgres` / `postgres` の重複ではなく
  各ジョブ1本ずつ、`postgres` / `example-chat` / `root-gate-db-stage` /
  `retrieval-quality` / `identifier-probes` / `consolidation-cost` /
  `archive-sweep-cost` / `time-term`)。
- **【実測】** `npx vitest run scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs`
  が変更前後とも緑(34 tests, 34 passed)であることを確認した。
- **【実測】変異試験・両側**(`.github/workflows/ci.yml` を一時的に書き換え、
  歯を実行してから `cp` で退避しておいた原本へ戻した。`md5sum` で復元一致を確認済み):
  1. **正当な追加(不変条件を壊さない): green のまま**——`POSTGRES_INITDB_ARGS:
     "--encoding=UTF8"` を宣言する新しい pgvector サービスを ci.yml 末尾に追記
     (matrix 配線ではない、通常のジョブとして)。結果: **34 tests, 34 passed**
     (歯を1行も書き換えていない)。
  2. **不変条件を壊す(a): 他と異なる `POSTGRES_INITDB_ARGS`("--encoding=LATIN1")
     を宣言する pgvector ジョブを追加 → red**。結果:
     `(b) …matrix 化していない残り全部の POSTGRES_INITDB_ARGS は…一致する` が
     `expected 2 to be 1` で失敗(distinctFixed.size)。
  3. **不変条件を壊す(b): `POSTGRES_INITDB_ARGS` を宣言しない pgvector ジョブを
     追加 → red**。結果: `(a)` の `toBeDefined()` と `(b)` の一致検査の
     **2 tests が失敗**。
  4. **不変条件を壊す(c): 2本目のジョブを `POSTGRES_INITDB_ARGS:
     ${{ matrix.initdbArgs }}` で matrix 配線する → red**。結果:
     `matrixWired` が `toHaveLength(1)` で失敗(2件)、および
     `(c')` の `--expect-encoding` 整合検査も連鎖して失敗(**2 tests 失敗**)。
  - 4パターンすべて実行後、`.github/workflows/ci.yml` を `/tmp/ci.yml.orig`
    (`cp` で退避)から復元し、変更前の `md5sum`(`c052ab40eb365cc28c4b4e34f5e3fe3e`)
    と一致することを確認した。
- **【実測】6つの門**(この作業環境、`DATABASE_URL` 無し):
  - `pnpm run typecheck`: 緑(7 workspace projects)
  - `pnpm run lint`: 緑(`eslint .` エラー無し)
  - `pnpm run format:check`: 緑(`All matched files use Prettier code style!`)
  - `pnpm run test`: 非DB段はすべて緑(ルート 42 files/827 tests、各パッケージも
    全緑)。**DB テストは実行していません**と告知されて緑(ADR 0015 の仕様どおり
    ——「全部通った」ではない)。
  - `pnpm run build`: 緑(7 workspace projects)
  - `pnpm run pack:check`: 緑(6パッケージとも publish 梱包の門を通過)
- **【現物】** 波及先の確認:
  - `git grep -rn "toHaveLength(8)\|toHaveLength(7)" scripts/ .github/` で、
    この歯以外に絶対本数を固定している箇所が無いことを確認した。
  - `scripts/__tests__/ci-yml-postgres-regime-coverage-wiring.test.mjs` は
    `postgres` ジョブの **matrix の脚**(`UTF8`/`SQL_ASCII`、2本)を固定している
    ものであり、pgvector ジョブの総数(8本)とは無関係——この ADR の変更は
    その歯に影響しない(該当ファイルを読み、`EXPECTED_SERVER_ENCODINGS` が
    脚の集合であって総数ではないことを確認)。
  - `gh api repos/takecchi/mnemora/branches/main/protection` で
    branch protection の required status checks を実際に取得した。6件の
    contexts はすべてジョブの表示名(`packages/postgres (…, server_encoding=UTF8)`
    等)であり、pgvector ジョブの総数を参照するものは無い——この ADR は
    ジョブ名を1つも変えていないため、required checks への影響は無い。
  - artifact 名(`lexical-regime-${{ matrix.serverEncoding }}`)も
    `matrix.serverEncoding`(2脚)にのみ依存しており、pgvector ジョブの総数には
    依存していないことをテストの docstring とアサーションから確認した。
  - `scripts/__tests__/db-server-description.test.mjs` /
    `ci-yml-consolidation-wiring.test.mjs` に `pgvector` への言及はあるが、
    どちらも本数を固定していない(`grep` で確認)。

## 確かめていないこと

- **本物の Postgres + pgvector に対する実行は一度もしていない**
  (この作業環境に `DATABASE_URL` が無い)。この ADR は `ci.yml` の本文
  (services / steps / matrix)を1バイトも変えていない——変えたのは歯
  (`scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs`)だけであり、
  歯は `ci.yml` を実行せず文字列として読むだけなので、DB 側の挙動に対する
  影響は理論上無いはずだが、これは推論であり実測ではない。CI の DB 付き
  ジョブ(`postgres` / `postgres-regime-coverage` 等)が実測の場になる。
- **「pgvector ジョブが本当に見落とされにくいか」は、この ADR の中心的な
  argument だが、定量的な実測ではない**(過去の #220/#221 という1件の事例と、
  diff の行数という定性的な観察に基づく判断であり、統計的な主張ではない)。
- **GitHub Actions の branch protection の required status checks は、
  この PR からは変更していない**(このリポジトリのファイルではないため
  変更できない、ADR 0105 引き受けた負債6 と同じ理由)。上の「測ったこと」で
  現状を確認しただけである。
