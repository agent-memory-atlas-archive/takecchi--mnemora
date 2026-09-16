# v1.0.0 リリース当日の手順書

**想定読者**: この repo を作った本人（オーナー）だが、`publish.yml` の配線の細部までは
覚えていない人。当日この1枚で詰まった箇所を解決できることを目指して書いた。

**publish（`npm publish`・GitHub Release の作成・tag 打ち）を実行するのはオーナーであって、
この文書を書いた作業者ではない。**この文書は手順の下調べであり、実行の代行ではない
（[docs/autonomy.md](./autonomy.md) §3 のとおり、これらはオーナー専権）。

## 0. ⭐ tag を切る直前の最終確認リスト（⛔ 1つでも欠けたら、そこで止まる）

**この節だけは「当日の手順」ではなく、「そもそも切ってよい状態か」の確認である。**
**上から順に見て、通過条件を満たさないものが1つでも在れば、tag を切らずにそこで止まる。**

⛔ **この節は §1〜§5 の要約ではない。**各項目には**通過条件（何を見たら通過とみなすか）**だけを
書き、理由と詳細は既存の節へ参照を張る。**同じ内容をこの文書の2箇所に持たない。**

**次節の凡例の3分類は、この節の記述にもそのまま掛かる。**

| # | 見るもの | 通過条件（これを見たら通過） |
|---|---|---|
| 0.1 | `origin/main` の CI | その sha の check run が**1本残らず** completed かつ success（**2026-09-16 時点で 13/13**） |
| 0.2 | `pnpm run pack:check` | **exit 0**・違反0件（**DB 不要**。当日その場で走らせられる） |
| 0.3 | ADR 索引 | `node scripts/generate-adr-index.mjs --check` が **exit 0** |
| 0.4 | `package.json` の `version` | 6本とも**同じ値**で `0.0.0` でない（**いまは `0.1.1`。これでよい**） |
| 0.5 | 🔴 未検証のまま残る3つ | **通過条件が無い。**⛔ 緑にできない項目である——当日の判断材料として読む |
| 0.6 | 版 | Release の tag 名が**ちょうど `v1.0.0`**、pre-release チェックを**入れない** |
| 0.7 | いま出ている版 | **通過条件は無い。**⚠ **2026-09-16 に `v0.2.0` が出ており、npm の `latest` は6パッケージとも `0.2.0` である**——当日の判断材料として読む |

### 0.1 `origin/main` の CI が緑であること

**実際に走らせるコマンド**（`gh` が認証済みであること）:

```bash
# (a) いま main の先頭がどの commit か
gh api repos/takecchi/mnemora/commits/main -q .sha

# (b) その sha の check run を1本ずつ見て判定する
node scripts/ci-green-check.mjs --sha <(a) の sha> --repo takecchi/mnemora
```

**通過条件**: (b) が **exit 0** で終わり、`status=green — N件すべてが completed かつ success`
と出ること。終了コードは `0`=green / `1`=red / `2`=pending（まだ判定できない）/
`3`=`gh` 呼び出し等の失敗（`scripts/ci-green-check.mjs:34-35`。【読んで確かめた】）。
⛔ **`2`（pending）は通過ではない。**「まだ分からない」であって「緑」ではない。

**「何本中何本が緑ならよいか」**: **通過条件は「N 件すべて」であって「13件」ではない。**
N はジョブが増減すれば変わる値であり、`ci-green-check.mjs` はその時点の check run を数えて
「すべて success か」だけを判定する。**この日の N は 13 だった**——

**【実測】2026-09-16、`origin/main` = `6a19d85`**（`6a19d853c605a643bdf0f76c6f2ac9afbe60a993`）**、
この器で上の2本を走らせた**:

- (b) は `[1st poll] status=green — 13件すべてが completed かつ success` を出して **exit 0**。
- `gh api repos/takecchi/mnemora/commits/6a19d85.../check-runs -q .total_count` も **13** を返し、
  13本とも `completed` / `success` だった。
- ⟹ **この時点の `origin/main` は 13/13 緑である。**

**⚠ `gh run list --branch main --limit 1` だけで済ませないこと。**これは
**最新の run を1本返すだけ**で、その run の head sha が いま tag を切ろうとしている commit と
同じである保証はない。sha まで見るなら:

```bash
gh run list --branch main --limit 3 --json databaseId,headSha,name,conclusion,status,createdAt
```

【実測】同日、`gh run list --branch main --limit 1` は
`completed	success	docs(release-v1): …	CI	main	push	35065937222	4m2s	2026-09-16T06:55:05Z`
を返し、`--json headSha` で引き直すと確かに `6a19d85...` だった。
**⟹ 同じだと言えるのは引き直して確かめたからであって、コマンドの形からではない。**

**⚠ run 全体の `conclusion` を見て判定しないこと。**`ci-green-check.mjs` は
run 全体の `conclusion` も `mergeStateStatus` も**判定に一度も使わない**——
Issue #228 が観測した4つの外れ方を踏まないための設計である
（`scripts/ci-green-check.mjs:3-24`。【読んで確かめた】）。

### 0.2 `pnpm run pack:check` が通ること（**DB 不要**）

```bash
pnpm run pack:check
```

**通過条件**: **exit 0**・違反0件で、6パッケージとも通って
`✔ publish 梱包の門を通りました。` で終わること。**この門の中身は §2.3 が詳しい。**

**DB は要らない。**`pack:check` は registry にもネットワークにも触れず、`spawnSync` で呼ぶのは
`pnpm pack` と `tar xzf` だけである（§2.3。【読んで確かめた】）。§2.3 の「実際に走らせた結果【実測】」は
**`DATABASE_URL` 未設定の器で exit 0** を記録している。
⟹ **DB の無い手元でも、当日その場で走らせられる。**

**⚠ この門が緑であることの上限は、§2.3 の「⚠ 何をカバーしないか」と
「⚠ この実測が言っていないこと」に書いてある。**型の互換性も registry の状態も見ていない。
⛔ **緑を「publish が通る」と読まないこと。0.5 を飛ばさないこと。**

**⚠ この節を書いた作業者は `pack:check` を走らせていない。**上の exit 0 は §2.3 が記録した
**2026-09-16・`origin/main` = `14a7c27` 時点の実測**であり、**`6a19d85` では走らせていない。**

**参考**（【読んで確かめた】、§2.3 には書かれていない配線）: `pack:check` は
`.github/workflows/ci.yml:45-62` で毎 PR の CI の `typecheck / lint / test / build` ジョブの
末尾でも走る（Issue #241）。⟹ **0.1 が緑なら、その sha については `pack:check` も一度通っている。**
**それでも手元で1回走らせる理由は、0.1 で見た sha と手元の作業ツリーが同じとは限らないからである。**

### 0.3 ADR 索引が最新であること

**検査**（書き込まない。exit code だけで判定できる）:

```bash
node scripts/generate-adr-index.mjs --check
```

**再生成**（`docs/decisions/README.md` の `<!-- ADR-INDEX:GENERATED:START -->` 区画を書き換える）:

```bash
node scripts/generate-adr-index.mjs
```

**通過条件**: `--check` が **exit 0** で `docs/decisions/README.md は最新です（ADR N 本）。` と
出ること。陳腐化していれば **exit 1** で「…と一致していません。」が出る
（`scripts/generate-adr-index.mjs:14-21,45-62`。【読んで確かめた】）。

**【実測】2026-09-16、この器の作業ツリー（ブランチ `docs/v1-release-decision`）で `--check` を走らせ、
`docs/decisions/README.md は最新です（ADR 169 本）。`・exit 0 だった。**
⚠ **走らせたのは `main` の作業ツリーではない。**

⭐ **追記（2026-09-17）— 上の「169本」はもう腐っている。**【実測】`origin/main` で
`docs/decisions/README.md` の本数を数え直すと、上の値とは既に違っている
（ADR は増え続けるので当然そうなる）。⛔ **本数の数字そのものを通過条件にしないこと**
——**見るのは `--check` の exit code だけである。**当日、この項目を確認するときは
必ずその場で `--check` を走らせて数え直すこと。⛔ **この追記でも新しい本数は書かない**
（書けば、それもまた同じ理由で腐る）。

⛔ **索引の表を手で編集しないこと**（`docs/decisions/README.md`「この表は手で編集しない。」、ADR 0137）。
再生成は、ADR を足す PR を **squash merge する直前に PR ブランチ上で**マージする側が行う
（`scripts/generate-adr-index.mjs:11-22`。【読んで確かめた】）。⚠ **「マージした直後に `main` 上で」ではない**
——そうすると陳腐化したままの squash コミットが `main` に着地し、`ci.yml` を赤くする。

**0.1 との重なり**（【読んで確かめた】）: 鮮度の歯 `scripts/__tests__/adr-index-freshness.test.mjs` は
**`main` に限って**赤くなる設計であり（`scripts/adr-index-freshness-branch-lib.mjs:1-18`）、
`main` では `ci.yml` の `typecheck / lint / test / build` ジョブの `pnpm run test` の中で走る。
⟹ **0.1 が緑なら、その sha の索引は最新である。**この項目を別に立てるのは、
**tag を切る直前に手元で1本のコマンドとして確かめられるようにするためである。**

### 0.4 `git` 上の `version` が `0.1.1` のままでよいこと（⚠ 異常ではない）

```bash
grep -n '"version"' package.json packages/*/package.json
```

**【実測】2026-09-16、この器の作業ツリーでの出力**:

| ファイル | `version` |
|---|---|
| `package.json`（ルート。`private: true`、`PUBLISH_TARGETS` 外） | `0.0.0` |
| `packages/core` / `testkit` / `openai` / `postgres` / `anthropic` / `local-embedding` | **6本とも `0.1.1`** |

**通過条件**: **publish 対象6本が同じ値で、`0.0.0` でないこと。**いまは `0.1.1` である。
⛔ **`1.0.0` になっていないことは異常ではない。止まる理由にならない。**
逆に、**6本の値がばらけていたら止まること**——`pack:check` の検査項目2（§2.3）と同じ条件である。

**なぜこれでよいか**（ADR 0070。詳細は §1.3）: **版の権威は Release の tag に置いてある。**
`package.json` の `version` は権威ではなく「最後に誰かが書いた値」であり、
tag から `scripts/apply-release-version.mjs` が runner の作業ツリー上で書き込む——
**その書き換えはコミットされず、tarball に載って消える。**⟹ **git 上の値と npm 上の最新版は
一致しなくてよい。**版を知りたければ registry に訊く（`npm view @mnemora/core version`）。

⛔ **オーナーが `package.json` の `version` を手で `1.0.0` へ書き換える必要は無い。書き換えないこと。**

⚠ **【実測】2026-09-16、`npm view @mnemora/<pkg> dist-tags` は6パッケージとも `latest: 0.2.0` を返す。**
⟹ **git 上の `0.1.1` と npm 上の `0.2.0` が食い違っているが、これは上のとおり正常である。**
⛔ **この食い違いを見て `package.json` を `0.2.0` へ揃えようとしないこと。**

### 0.5 🔴 未検証のまま残るもの（⛔ この3つは、ここでは緑にできない）

**⚠ 0.1〜0.4 がすべて通っても、次の3つは何も確かめられていない。**
**当日の判断材料として読むための再掲であり、通過条件は無い。**

⚠ **2026-09-17 の実測で、3つとも当初より状況が動いた。**内容は違う形で動いている——
まとめて「全部確認できた」と読まないこと。

- **3番目（lockfile 不整合）**は「CI と同じ条件を手元で再現していなかっただけ」の不安で、
  **再現して測ったら通った**（詳細は3番目の項目と §2.3 を見ること）。
- **1・2（provenance / 信頼発行元）**は、**この場で新しく確認できるようになったわけではない**
  ——`v1.0.0` という新しい tag を実際に打つことも、npmjs.com の画面を直接見ることも、
  引き続きこの器・このタスクの範囲外である。**動いたのは「過去の本番 run と registry の
  実測データを読む」という、別の角度からの確認である**——`gh run list` と `npm view` は
  この器からでも引ける。その結果、**「一度も確かめられていない」という記述は もう正確ではない**
  ——**過去に何度も本番で通った実績がある**ことが分かった。**ただし「次の `v1.0.0` でも
  必ず通る」ことまでは保証しない**——詳細は1・2番目の項目を見ること。

1. **`npm publish --provenance` が通ること自体**（`publish.yml:227`）。
   **本番 tag を打つまで分からない。**⟹ **予行（`workflow_dispatch` / `dry_run: true`）が
   全ステップ success でも、これは何も保証しない**——`--dry-run` は書き込みの要求を投げないので、
   認証・認可・存在検査・サーバ側の検証を**構造的に**見られない（ADR 0067 逐語。**§2.2**）。
   実測の裏付けも §2.2 に在る（予行は全ステップ success、同じ commit の本番は
   `npm error 403 … OIDC permission denied for this action` で failure）。

   **⭐ 追記（2026-09-17）— 「本番 tag を打つまで分からない」はもう正しくない。**
   `v0.1.5`〜`v0.2.0` で、**すでに何度も本番 tag を打っている。**【実測】
   `gh run list --workflow=publish.yml --limit 10` を引くと、`release` 契機の本番 run が
   **6回連続 success**（`v0.1.5`・`v0.1.6`・`v0.1.7`・`v0.1.8`・`v0.1.9`・`v0.2.0`。
   `v0.1.4` だけ failure）。さらに `npm view @mnemora/<pkg>@0.2.0 --json` を6パッケージ
   すべてに対して引くと、**6本とも** `dist.attestations` に
   `"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}` が付いている——
   `publish.yml:227` が `--provenance` を必ず付ける唯一の経路である以上、**この6本は
   実際に OIDC 経由の `npm publish --provenance` を通っている。**⟹ **「一度も通ったことが
   ない」のではなく、「複数回、実際に通っている」。**
   ⚠ **ただし ADR 0067 の構造的な指摘そのものは変わらず生きている**——`--dry-run` が
   書き込みの要求を投げないので認証・認可・存在検査・サーバ側の検証を構造的に見られない
   ことは事実のままであり、**予行の green が本番を保証しないという結論は今も正しい。**
   **残る未知は「`v1.0.0` という新しい tag でもう一度同じ経路が通るか」だけである**
   ——過去に何度も通ったことは、次も通ることを保証しない（信頼発行元の設定は
   `v0.2.0` 以降に変更されているかもしれない。下の2番目の追記を見ること）。
2. **npm 側の信頼発行元（Trusted Publishing）の設定。**
   **この器から npmjs.com の画面は見られない**——**§4.2** の表（org=`takecchi` / repo=`mnemora` /
   workflow filename=`publish.yml` / 「直接 `npm publish` を許可」）を、**当日オーナーが
   6パッケージすべてについて npm の画面で確認する。**⚠ npm は保存時にこれらの値を検証しない
   （§4.2）。⚠ 特に `@mnemora/anthropic` と `@mnemora/local-embedding` は初版を手元 bootstrap で
   出した経緯があり、**現在 OIDC 経路に乗っているかの後続記録が見つかっていない**
   （末尾「現物を読んでも分からなかった点」5）。

   **⭐ 追記（2026-09-17）— 「誰も確かめていない」から「機能していることは実証されている」へ。**
   **設定の値そのものは、今回もこの器から見ていない**（§4.2 の「npm の画面で見る」の
   価値はそのまま残る——下記参照）。**だが、その設定が現に機能していることは、上の
   1番目の追記が引いた「6回連続 success ＋ 6本とも provenance あり」という実測で
   実証されている。**信頼発行元が正しく設定されていなければ、`publish.yml:227` の
   `npm publish --provenance` は §2.2 が引用した実例と同じ
   `403 ... OIDC permission denied` で落ちる——**落ちずに6回連続で通り、6本とも
   provenance が付いたという事実は、org/repo/workflow filename/直接publish許可が
   `v0.2.0`（2026-09-16）の時点で正しく機能していたことの**強い状況証拠である。
   ⟹ **残るリスクは「設定を誰も確かめていない」ではなく、「`v0.2.0` 以降に設定が
   変更されていないか」だけに縮む。**§4.2 の確認項目はこの縮小を反映して当日の
   確認を省いてよい、という意味ではない——**「保存時に値を検証しない」（§4.2）以上、
   画面上の値そのものを目で見て確認する価値は消えていない。**
   ⚠ **`@mnemora/anthropic` と `@mnemora/local-embedding` が現在 OIDC 経路に乗っているか
   という懸念も、これで実証的に解消する。**【実測】`npm view` で両パッケージの版ごとの
   `dist.attestations` を引くと、`@mnemora/anthropic` は `0.1.2` に provenance が**無く**
   `0.1.3` 以降**すべて**（`0.2.0` まで）に**在り**、`@mnemora/local-embedding` は `0.1.4` に
   provenance が**無く** `0.1.5` 以降**すべて**（`0.2.0` まで）に**在る**。⟹
   **2つとも、初版こそ bootstrap だったが、次の版から現在（`0.2.0`）まで一貫して
   OIDC 経路に乗り続けている。**詳細と時刻の突き合わせは末尾「現物を読んでも
   分からなかった点」5の追記を見ること。
3. **lockfile 不整合 → 2026-09-17、CI と同じ条件で実測済み【実測】。**
   2026-09-16 までの §2.3 の実測は **pnpm 12.4.2 ＋ 素の `pnpm install`** で走らせており、
   CI が使う **corepack ＋ `packageManager` の `pnpm@11.25.0` ＋ `pnpm install --frozen-lockfile`**
   とは条件が違ったため、「lockfile について何も見ていない」状態だった。
   2026-09-17、この器で `corepack enable` した上で `pnpm --version` が **`11.25.0`**
   （`/usr/local/bin/pnpm` が corepack のシムであり、`package.json` の `packageManager` の値
   `pnpm@11.25.0` を解決していることを確認済み）であることを確かめてから
   `pnpm install --frozen-lockfile` を実行し、**exit 0・`ERR_PNPM_OUTDATED_LOCKFILE` 等のエラー無し**
   だった（`origin/main` = `9e13ac874d36abd88d23200cd3df9d234dc0acd2`。詳細は §2.3
   「実際に走らせた結果【実測】」の2026-09-17分）。⟹ **この commit については、lockfile と
   各 `package.json` の不整合は無い。**
   ⚠ ただし**その時点の1 commit を実測しただけ**であり、「今後もう二度と壊れない」ことを
   意味しない——`pnpm-lock.yaml` や各 `package.json` に手を入れる commit が出るたびに、
   また `--frozen-lockfile` が赤くなりうる余地は残る。赤くなるとすれば §1.2 のステップ5である。
   ⚠ **0.1 の CI も `pnpm install --frozen-lockfile` で入れている**ため（`ci.yml:25` ほか。
   【読んで確かめた】）、**0.1 が緑ならその sha については lockfile も一度通っている**——
   今回の実測は、それを**この器（CI とは別の環境）でも独立に再現した**という位置づけである。

**⟹ この3つは「止まる条件」ではなく、「失敗したときに何を疑うか」を先に読んでおく項目である。**
失敗したときの兆候と回復は **§3** と **§4**、確認方法そのものが分かっていない点は
**末尾の「現物を読んでも分からなかった」点**に集めてある。

### 0.6 版は `v1.0.0`（オーナー決定）であること

**版はオーナーが決めている: `v1.0.0`**（`docs/roadmap.md` §7.12「オーナーの決定（2026-09-16）」。
【読んで確かめた】）。⛔ **この場で版を決め直さないこと。**

**通過条件**（Release の作成画面で、打つ前に目で確かめる）:

- tag 名が **ちょうど `v1.0.0`**。**先頭の `v` は必須**（§1.1）。
  `1.0.0` や `vfoo` は `versionFromTag()` が落とす（§1.3 に異常系の【実測】が在る）。
- **「Set as a pre-release」にチェックを入れない。**入れると dist-tag が `next` へ倒れる（§1.5）。
- ⟹ 上の2つを満たせば **dist-tag は `latest`**、6パッケージとも **`1.0.0`** で上がる（§1.3 / §1.5 / §1.6）。

⚠ **`docs/roadmap.md` §7.12 は「§7.2 の v1.0 の定義を文字どおりには満たさないまま、
オーナーの判断で切る」と明記している。**⛔ **このリストが全部緑になっても、
それは §7.2 の定義を満たしたという意味ではない。**このリストが見ているのは
**「出す仕掛けが壊れていないか」だけ**である。

### 0.7 ⚠ いま出ている版は `v0.2.0` である（通過条件は無い。読むだけ）

**【実測】2026-09-16、この器で確かめた事実だけを書く。**

| 引いたもの | 返ってきた値 |
|---|---|
| `gh release list --limit 10` | 最新は **`v0.2.0`**（`2026-09-16T09:06:57Z` 公開）。その次が `v0.1.9` |
| `gh release view v0.2.0 --json tagName,isPrerelease` | `v0.2.0` / `isPrerelease: false` |
| `git rev-parse v0.2.0` | `c52be478eb758dc956656b47498aa5cb4ab08c82` |
| `npm view @mnemora/<pkg> dist-tags`（6本） | **6本とも `latest: 0.2.0`** |

⟹ **いま npm の `latest` は `0.2.0` である。**⟹ **次に `v1.0.0` を切れば、
`latest` は `1.0.0` へ上がる**（dist-tag の決まり方は §1.5 / §1.6。経路は変わらない）。

⛔ **この事実で 0.6（版は `v1.0.0`）を書き換えていない。**0.6 が記録しているのは
**2026-09-16 のオーナー決定**であり、当時そう決めたことは記録である
（`docs/roadmap.md` §7.12）。⚠ **その決定の後に何が起きたかは §7.12 の末尾に在る**
——**`v1.0.0` の tag はこの文書を書いた時点でまだ切られていない。**

⛔ **この項目に通過条件は無い。**「`v0.2.0` が出ている」ことは、tag を切ってよいかどうかを
判定しない——**当日、いまの `latest` が何かを知ったうえで判断するための材料である。**

---

## 凡例（この文書のすべての記述は、次のいずれかである）

- **【読んで確かめた】** — `.github/workflows/publish.yml` / `scripts/*.mjs` / ADR の現物にそう
  書いてある。ファイル名と行番号を添える。
- **【未検証・理屈上こうなるはず】** — 現物からの推論だが、この作業者は実行して確かめていない。
- **【実測】** — この器で実際にコマンドを走らせ、出力を見た。**いつ・どの commit の作業ツリーで・
  どんな環境で走らせたかを添える**（環境が違えば結果も違いうるため）。

**この3つを混ぜて書かない。**とくに「途中で失敗したらこうなる」は、実際に publish を打って
壊してみることが許されていないため、**ほぼ全部が【未検証・理屈上こうなるはず】である。**

---

## 1. リリースの流れ

### 1.1 三段階

1. **git tag を切る**（`v1.0.0` の形。先頭の `v` は必須）
2. **GitHub の Release を「published」にする**
3. **`.github/workflows/publish.yml` が走る**

**⚠ 段1と段2は同時に1つの操作でもよい。**GitHub の Release 作成 UI で新しい tag 名を
入力すると、Release の公開と同時に tag も作られる
（`.github/workflows/publish.yml:13-14` のコメントに明記。【読んで確かめた】）。

**⛔ 素の `git push origin v1.0.0`（tag の push だけ）では何も起きない。**
`publish.yml` の引き金は `on: release: types: [published]` だけであり、
`push: tags` は**意図的に持たせていない**
（`publish.yml:8-19`。理由：Release UI から tag も同時に作られるため、両方を引き金にすると
同じ版で2本走ってしまう。【読んで確かめた】）。**⟹ Release を作ることが「npm へ出してよい」の
表明であり、その表明がリリースノートと一緒に GitHub 上に残る**（`publish.yml:9-11`）。

### 1.2 段3（`publish.yml`）の各ステップと、どこを見れば成否が分かるか

**見る場所**: GitHub の Actions タブ → ワークフロー名 `Publish` → job
`npm publish（Trusted Publishing / OIDC）`（`publish.yml:38-39`。【読んで確かめた】）。

| # | ステップ名（現物） | 何をするか | 成否の見方 |
|---|---|---|---|
| 1 | Checkout | tag の指す commit を全履歴付きで取得 | 失敗はまれ。赤ならネットワーク系 |
| 2 | Setup Node.js | Node 22 をセットアップし `~/.npmrc` に `registry.npmjs.org` を設定 | 同上 |
| 3 | Update npm CLI | `npm install -g npm@latest` | §4.3 で詳述 |
| 4 | Enable corepack | `corepack enable` | まれに失敗 |
| 5 | Install dependencies | `pnpm install --frozen-lockfile` | lockfile とpackage.jsonの不一致で失敗しうる |
| 6 | Release の tag が main の履歴上に在ることを確かめる（`release` イベントのみ） | tag の commit が `origin/main` の祖先であることを検査 | 赤くなったら「main を通っていない commit から Release を作った」ことを疑う（`publish.yml:76-102`） |
| 7 | Release の tag の版を package.json へ書き込む（`release` イベントのみ） | `apply-release-version.mjs` が版を決めて書き込む（下の1.3節で詳述） | tag が semver でないと赤くなる |
| 7' | 予行のときは package.json の版をそのまま使う（`workflow_dispatch` のみ） | `packages/core/package.json` の版をそのまま読む | — |
| 8 | Typecheck / Lint / Format / Test / Build | 非DBの門を全部通す（`typecheck`/`lint`/`format:check`/`test`/`build`） | **ここで失敗すれば、まだ1パッケージも publish されていない**（§3.4 で重要） |
| 9 | publish 梱包の門 | `pnpm run pack:check`（tarball の中身を検査。§2.3） | 同上。まだ publish 段の前 |
| 10 | pnpm pack | 6パッケージを `pnpm pack` し、`--expect-version` で版のずれを検査 | tag の版と package.json の版がずれていると赤くなる（通常は7で揃えているので起きないはず） |
| 11 | 予行か本番かを決める | `decide-publish-dry-run.mjs` が `dry_run` 出力を決める（§2.1） | — |
| 12 | **npm publish（依存の向きの順に、tarball を上げる）** | 6パッケージを順に `npm publish` する。**ここが実際に registry へ書き込む唯一のステップ** | ログに `::group::npm publish <name>@<version>` が6回出るはず（`publish.yml:225`）。**各グループの中身を1つずつ見ること**（§3で詳述） |

（【読んで確かめた】`.github/workflows/publish.yml` 全文、行番号は上表内に記載）

### 1.3 版の決め方（ADR 0070）

**版の権威は Release の tag である。`packages/<pkg>/package.json` の `version` は権威ではない**
（「最後に誰かが書いた値」であって、npm 上の最新版とは限らない。
`scripts/apply-release-version.mjs:9-11`。【読んで確かめた】）。

役割分担（【読んで確かめた】）:

- **`scripts/release-version.mjs`**（判定・純関数・副作用なし）
  - `versionFromTag(tagName)`（27-45行）: tag が `"v"` で始まることと、剥がした残りが
    semver として妥当であることを検査する。`${TAG#v}` のような単純な文字列剥がしだと
    `vfoo` が `foo` として書き込まれてしまう（コメント19-22行）ため、ここで落とす。
  - `distTagFor({ version, githubPrerelease })`（62-79行）: dist-tag（`latest`/`next`）を決める。
    semver の prerelease 部（`-beta.1` 等）の有無と、GitHub Release の「pre-release」
    チェックボックスの有無を突き合わせ、**どちらか一方でも prerelease なら `next` にする**
    （食い違いは `latest` を汚さない側へ倒す。66-76行）。
- **`scripts/apply-release-version.mjs`**（書き込み・CLI）
  - 上記2関数を呼び、`PUBLISH_TARGETS`（6パッケージ）の各 `package.json` の
    **`version` の行だけ**を正規表現で差し替える（50-88行）。`JSON.parse`→
    `JSON.stringify` の往復はしない——理由は、prettier が `"files": ["dist"]` を
    1行に畳むのに対し `JSON.stringify` は必ず展開するため、書き戻すと直後の
    `pnpm run format:check` が赤くなる（実際に踏んだ。コメント50-58行）。
  - 書けたことを**読み直して**検算する（90-100行）。
  - `$GITHUB_OUTPUT` へ `version=` と `npm_tag=` を書く（109-111行。`publish.yml` の
    後続ステップが `steps.version.outputs.version` / `.npm_tag` として読む）。

**`workflow_dispatch`（予行）のときは、この書き込みは走らない。**
`packages/core/package.json` の版をそのまま読み、`npm_tag` は常に `latest` に固定される
（`publish.yml:126-135`。【読んで確かめた】）。

**この器でも実際に走らせた**【実測】2026-09-16、`origin/main` = `14a7c27`、clean な作業ツリー:

- `RELEASE_TAG=v1.0.0 GITHUB_PRERELEASE=false` で **exit 0**。
  **6パッケージとも `0.1.1` → `1.0.0`** に変わり、`git diff` は各ファイルとも
  **`version` の1行だけ**だった（`dependencies` の `workspace:^` は1文字も動かない）。
  `$GITHUB_OUTPUT` には `version=1.0.0` / `npm_tag=latest` が書かれた。
- ルートの `package.json`（`0.0.0`・`private`）と `examples/chat` は
  `PUBLISH_TARGETS` に無いので**完全に無変更**——`git diff` に現れない。
- 異常系も実測した: `RELEASE_TAG=1.0.0`（`v` 無し）と `RELEASE_TAG=vfoo` はどちらも
  **exit 1 でファイル無変更**。`RELEASE_TAG=v0.1.1`（現在と同値）は exit 0 で差分なし。
  **同じ tag で2回続けて走らせても冪等**（2回目は全パッケージ「変化なし」）。
- `RELEASE_TAG=v1.0.0-beta.1` に `GITHUB_PRERELEASE=false` を与えると（食い違い）、
  `::warning::` を出して **`npm_tag=next` へ倒れる**——`latest` を汚さない側へ倒れることを確認した。
- ⚠ **この確認は使い捨ての作業ツリーで行い、毎回 `git checkout -- .` で戻した。**
  commit も push もしていない。

### 1.4 `workspace:^` がいつ実版へ置換されるか

**タイミング**: 上表の「10. pnpm pack」ステップで、6パッケージを `pnpm pack` した瞬間
（`publish.yml:152-158`）。**「7. 版を書き込む」ステップの後**であることが前提になっている——
`pnpm pack` は「その時点で作業ツリーに書かれている版」を見て `workspace:^` を解決するため
（ADR 0070「測ったこと1」で実測: `v9.9.9` で `apply-release-version.mjs` を走らせたところ、
tarball 内の `version` が `9.9.9`、`@mnemora/core` への依存が `^9.9.9` になった。
【読んで確かめた】`docs/decisions/0070-version-comes-from-the-release-tag.md:66-78`）。

**なぜ `pnpm` でなければならないか**: `npm pack` は `workspace:*`/`workspace:^` を
置換せず、素の consumer の `npm install` が `EUNSUPPORTEDPROTOCOL` で落ちる
（実測。`docs/decisions/0060-publish-with-pnpm-four-packages-at-0-1-0.md:54-66`。
【読んで確かめた】）。だから梱包（`pack`）は pnpm、アップロード（`npm publish <tarball>`）は
npm、という分担になっている（ADR 0066 決定2。`npm publish <tarball>` は解決済みの
manifest を持つ tarball を上げるだけなので `workspace:` を見ることが無い）。

### 1.5 dist-tag の決まり方（再掲・要点）

| GitHub の pre-release チェック | semver に `-` が含まれるか | 結果 |
|---|---|---|
| なし | なし | `latest` |
| あり | あり | `next` |
| どちらか一方だけ | — | `next`（`::warning::` 付き。`latest` を汚さない側へ倒す） |

（`scripts/release-version.mjs:62-79`。【読んで確かめた】）

**v1.0.0 は通常のリリース（pre-release チェックなし・semver に `-` なし）であれば `latest` になる。**

### 1.6 publish するパッケージと順序

`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` 配列がこの repo で唯一の定義であり、
**この順に publish される**（【読んで確かめた】）:

1. `@mnemora/core`
2. `@mnemora/testkit`
3. `@mnemora/openai`
4. `@mnemora/postgres`
5. `@mnemora/anthropic`
6. `@mnemora/local-embedding`

順序は依存の向き（自分が依存するパッケージが自分より前）で決まっており、
`scripts/__tests__/publish-targets.test.mjs` が package.json の現物から機械的に検査する
（`publish-targets.mjs:1-18`のコメント）。**⚠ 新しい7つ目のパッケージが増えたら、この配列に
手で足す必要がある——見落としを機械的に検知する仕組みは無い**（同コメント14-17行）。

⭐ **追記（2026-09-17）— 上の一覧は手で書いた記録であり、権威ではない。**
**権威は `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` そのものである。**
当日、この一覧が最新か不安なら、手で数えず次のコマンドで機械的に数え直すこと
【実測。このコマンドを実際に打って、下の出力を得た】:

```bash
node -e 'import("./scripts/publish-targets.mjs").then(m=>{for(const t of m.PUBLISH_TARGETS)console.log(t.name)})'
```

出力（2026-09-17、`origin/main` = `806f23f`）:

```
@mnemora/core
@mnemora/testkit
@mnemora/openai
@mnemora/postgres
@mnemora/anthropic
@mnemora/local-embedding
```

⭐ **当日はこのコマンドで数え直すこと。上の一覧・下の §3.1 と §5.1 の `for` ループの
名前列は、いずれも書いた時点の記録である。**7つ目が増えても、この3箇所は黙って
見落とす（手書きの名前列挙のままなら）。

---

## 2. 事前にできること・できないこと

### 2.1 `workflow_dispatch`（予行、`dry_run: true`）で検証できること

Actions → `Publish` → `Run workflow` → `dry_run` を `true`（既定）のまま実行すると、
上表の1〜11のステップは本番と同じものが走る。**唯一の違いは12番目のステップで
`npm publish` に `--dry-run` が付くことだけ**（`publish.yml:217-221`。【読んで確かめた】）。

これで検証できるもの（【読んで確かめた】）:
- typecheck / lint / format / test / build が通ること
- `pack:check`（tarball の中身の9項目、下の2.3節）
- 6パッケージの梱包（`pnpm pack`）が成功し、`workspace:` が解決されること
- OIDC のトークン取得・payload の組み立てまで（`--dry-run` は「梱包・認証トークンの取得・
  payload の組み立ては行うが、実際の書き込み `PUT` は行わない」という npm 自身の設計。
  ADR 0067、124-130行。【読んで確かめた】）

⭐ **追記（2026-09-17）— `dry_run: false` での `workflow_dispatch` は、この repo で
一度も実行されたことがない。**【実測】`gh run list --workflow=publish.yml --limit 30` を
引くと、`workflow_dispatch` 契機の run は **`34262743432`・`34248494960` の2件だけ**
（どちらも2026-09-08）で、両方のログを見ると両方とも
`予行（--dry-run）です。registry へは何も上がりません。` と出ており、**どちらも
`dry_run: true`（予行）だった。** `dry_run: false` で起動した `workflow_dispatch` の
run はログ上に1本も見当たらない。
⚠ **当日この経路（`workflow_dispatch` を `dry_run: false` で起動すること）を使わないこと。**
本番の入り口は Release を作る経路（§1.1）であり、`workflow_dispatch` はあくまで
予行専用として使われてきた、という実績しかない。

### 2.2 🔴 何が本番 tag まで分からないか（ADR 0067、逐語）

**ADR 0067 の核心をそのまま引く**（`docs/decisions/0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md:118-134`）:

> 「本番と同じ経路を、副作用だけ止めて走らせる」形の検査は、副作用の直前で判定される
> 条件を検出できない。
>
> - 認証・認可（トークン / OIDC の信頼関係 / 権限）
> - 存在検査（宛先が実在するか、既に在るか）
> - サーバ側の検証全般
>
> これらは**サーバへ実際に要求を投げて初めて判定される。**`--dry-run` はその要求を
> （少なくとも書き込みを伴う形では）投げないので、**構造的に**見えない。（中略）
>
> ⟹ **`--dry-run` が緑であることは「梱包と手元の配線が正しい」以上のことを
> 言っていない。**サーバ側の権限・存在・検証の状態については、緑からも赤からも
> 何も読み取れない。

**実測での裏付け**: 信頼発行元（Trusted Publisher）が未設定のまま `workflow_dispatch`
の予行を走らせたところ**全ステップ success**で終わったが、同じ commit・同じ workflow の
`release` 契機（本番）は同じ `npm publish` 段で
`npm error 403 ... OIDC permission denied for this action` により failure になった
（run `34262743432` と `34254090760`。ADR 0067、82-114行。【読んで確かめた（ADR 0067の作業者による実測の記録）】）。

**⟹ 予行が緑でも、次のことは何も保証されていない**:
- npm 側で信頼発行元（org / repo / workflow ファイル名）が正しく設定されていること
- その信頼発行元に「直接 `npm publish`」の権限が与えられていること（§4.2 参照）
- パッケージ名がまだ空いている／既に自分の org の所有になっていること

### 2.3 手元で事前に走らせられる検査（`pnpm run pack:check`）

**何をカバーするか**（`scripts/check-publish-pack.mjs:109-131` のバナーそのまま。
【読んで確かめた】。6パッケージそれぞれに対して実際に `pnpm pack` し、tarball を展開して検査する）:

1. `workspace:` プロトコルが依存に残っていないこと
2. `version` が `0.0.0` でなく、6パッケージとも同じ版であること
3. `main`/`types`/`bin`/`exports` の指すファイルが tarball 内に実在すること
4. `README.md` が tarball に入っていること
5. `publishConfig.access` が `"public"` であること
6. 宙に浮いた source map が無いこと
7. `license` が `"MIT"` であり `LICENSE` ファイルが tarball に入っていること
8. `private` が立っていないこと
9. 実行時 `dependencies` が完全固定でなく範囲指定であること（除外分を除く）

**⚠ 何をカバーしないか**（すべて【読んで確かめた】——`check-publish-pack.mjs` /
`publish-pack-checks.mjs` を通読したが、ネットワーク呼び出しは1つも無い。
`spawnSync` で呼んでいるのは `pnpm pack` と `tar xzf` のみ）:

- **型の互換性。**「`main`/`types`/`bin`/`exports` の指す先が tarball 内に実在するか」までで、
  **`import` して実際に動くか・型が consumer 側で正しく解決されるかは見ていない**
  （ADR 0060「引き受けた負債」に明記: 「その門は『main/types/binの指す先が在るか』までで、
  importして動くかは見ていない」。`docs/decisions/0060-....md:140`）。
- **registry の状態。**信頼発行元の設定・パッケージの存在・直接 publish の許可の有無・
  version の衝突——これらは registry に問い合わせて初めて分かるが、`pack:check` は
  一切 registry に触れない（現物にネットワーク呼び出しが無いことを確認した）。

#### 実際に走らせた結果【実測】

**2026-09-16、`origin/main` = `14a7c27` の作業ツリーで実際に走らせた。**
この節はそれまで全部【読んで確かめた】だった——**バナーを読んだだけで、走らせていなかった。**

走らせた環境（**CI と同じではない。**下の「この実測が言っていないこと」を必ず読むこと）:

| | 値 |
|---|---|
| OS | Linux 6.12.12+bpo-cloud-amd64 |
| Node | v22.23.2（`engines` は `>=22`） |
| pnpm | **12.4.2** ⚠ `package.json` の `packageManager` は `pnpm@11.25.0` である |
| `DATABASE_URL` | 未設定（この器に DB は無い） |

結果:

- **`pnpm install` — exit 0**（`Packages: +207`）。
  `packages/postgres/dist/bin/migrate.js` が未ビルドで bin リンクを張れない `WARN` が出るが、
  `prepack` のビルドより前なので想定内であり、`pack:check` の後は解消する。
- **`pnpm run pack:check` — exit 0、違反0件。**6パッケージとも通り、
  `✔ publish 梱包の門を通りました。` で終わった。**独立に2回走らせ、2回とも exit 0。**

**⚠ `DATABASE_URL` が無くてもこの門は通る。**`pack:check` は DB を一切必要としない
（上の「`spawnSync` で呼んでいるのは `pnpm pack` と `tar xzf` のみ」と整合する）。
⟹ **DB の無い手元でも、当日より前にこの門は走らせられる。**

**6パッケージの tarball を1本ずつ展開して突き合わせた結果**（版は作業ツリーの `0.1.1`）:

| package | 圧縮サイズ | ファイル数 | `dist/` | README+LICENSE | 不要物 | `workspace:` |
|---|---|---|---|---|---|---|
| `@mnemora/core` | 238,844 B | 79 | ✔ 76 | ✔ | 0 | 0 |
| `@mnemora/testkit` | 129,272 B | 49 | ✔ 46 | ✔ | 0 | 0 |
| `@mnemora/openai` | 10,351 B | 13 | ✔ 10 | ✔ | 0 | 0 |
| `@mnemora/postgres` | 133,286 B | 56 | ✔ 38 | ✔ | 0 | 0 |
| `@mnemora/anthropic` | 11,337 B | 11 | ✔ 8 | ✔ | 0 | 0 |
| `@mnemora/local-embedding` | 24,765 B | 11 | ✔ 8 | ✔ | 0 | 0 |

- 「不要物」は `package/src/`・`__tests__`・`*.test.*`・`.env`・`tsconfig.tsbuildinfo`・`*.map`
  を tarball の**目録に対して**数えた件数である。**6本とも0件。**
  各パッケージに `.npmignore` は無く、`files` だけで絞れている。
- 各パッケージに `prepack: "pnpm run build"` が在り、**`pnpm pack` が自動でビルドする。**
  ⟹ 事前に手で `pnpm run build` を走らせる必要は無い（自動で発火することを実測した）。
- `@mnemora/postgres` は `dist/bin/migrate.js` が実行属性（`rwxr-xr-x`）付きで入り、
  `migrations/*.sql` 15本も同梱される。
- `publishConfig.access` は6本とも `"public"`、`license` は6本とも `"MIT"`、
  `private` は6本とも立っていない。

**`workspace:^` の置換も、この器で実測した。**tarball 内の `package.json` に
`workspace:` は**6本とも0件**で、`@mnemora/core` への依存は5本とも `^0.1.1` へ解決されていた。
⟹ §1.4 の記述を、ADR 0060 の記録とは**独立に**この器で再現したことになる。

**publish 順と依存の向き**——実行時 `dependencies` は次の通りだった:

| package | 実行時 `dependencies` |
|---|---|
| `@mnemora/core` | `zod` |
| `@mnemora/testkit` | `@mnemora/core` |
| `@mnemora/openai` | `@mnemora/core`, `openai`, `zod` |
| `@mnemora/postgres` | `@mnemora/core`, `pg`, `drizzle-orm`, `@types/pg` |
| `@mnemora/anthropic` | `@mnemora/core`, `@anthropic-ai/sdk`, `zod` |
| `@mnemora/local-embedding` | `@mnemora/core`, `@huggingface/transformers` |

**⟹ `@mnemora/core` が先頭に在りさえすれば、残り5本の順序は実行時依存の上ではどれでもよい。**
これは「いまの並びを支えているのは依存の向きだけ（＝当時の未公開の経緯はもう効いていない）」という
`scripts/publish-targets.mjs` のコメントと整合する。

#### 追記【実測】（2026-09-17、CI と同じ条件で）

**上の実測（2026-09-16）は、pnpm の版とインストール方法が CI と違っていた。**
今回はその差を埋めて測り直した。`origin/main` = `9e13ac874d36abd88d23200cd3df9d234dc0acd2`
の、clean な作業ツリーで実行した。

環境（前回との違いだけ記す。それ以外は前回と同じ）:

| | 値 |
|---|---|
| `corepack enable` | 実行済み（exit 0） |
| `pnpm --version` | **`11.25.0`**（実出力そのまま）。`/usr/local/bin/pnpm` が `../lib/node_modules/corepack/dist/pnpm.js` へのシムであることを `ls -la` で確認し、`package.json` の `"packageManager": "pnpm@11.25.0"`（10行目）と一致することを確かめた |
| インストール | `pnpm install --frozen-lockfile`（前回はただの `pnpm install`） |

結果:

- **`pnpm install --frozen-lockfile` — exit 0。**
  `ERR_PNPM_OUTDATED_LOCKFILE` 等のエラーは出なかった。出力は
  `Lockfile passes supply-chain policies` → `Lockfile is up to date, resolution step is skipped`
  → `Packages: +207` で、前回の素の `pnpm install` と同じ207件。
  `packages/postgres/dist/bin/migrate.js` 未ビルドによる bin リンクの `WARN` が3本出るが、
  これは前回（pnpm 12.4.2・素の `pnpm install`）でも出ていたのと同種のもので、
  `prepack` 前の想定内の warning であり lockfile とは無関係。
  ⟹ **`9e13ac874d36abd88d23200cd3df9d234dc0acd2` の時点で、lockfile と各 `package.json` の
  不整合は無い。CI と同じ条件（corepack ＋ `packageManager` の `pnpm@11.25.0` ＋
  `--frozen-lockfile`）で、この器でも独立に確認した。**
- **`pnpm run pack:check`（同じ pnpm 11.25.0 の環境）— exit 0、違反0件。**
  前回（pnpm 12.4.2）と同じく `✔ publish 梱包の門を通りました。`。
- **`apply-release-version.mjs` を `RELEASE_TAG=v1.0.0 GITHUB_PRERELEASE=false` で実行 —
  exit 0。**6パッケージとも `0.1.1` → `1.0.0` に変わり、`git diff` は各ファイルとも
  `version` の1行だけだった（§1.3 の2026-09-16実測と同じ挙動を pnpm 11.25.0 環境で再確認）。
  `$GITHUB_OUTPUT` には `version=1.0.0` / `npm_tag=latest` が書かれた。
- **§2.3「この実測が言っていないこと」が指摘していた穴の1つを埋めた**: 版を `1.0.0` に
  書き換えたその状態のまま `pnpm run pack:check` を実行し、**exit 0、
  `✔ publish 梱包の門を通りました。`** だった（違反0件、6パッケージとも通過）。
  ⟹ **`v1.0.0` へ版を書き換えた後の状態でも `pack:check` は通る**ことを、この器で確認した。
- 確認後、`git checkout -- .` で作業ツリーを戻し、`git status` が
  `nothing to commit, working tree clean` であることを確認した。commit・push はしていない。

**⚠ この追記実測が言っていないこと**:

- **今回測ったのは `9e13ac874d36abd88d23200cd3df9d234dc0acd2` という1つの commit についてだけである。**
  以後 `pnpm-lock.yaml` や各 `package.json` に手を入れる commit が出れば、また
  `--frozen-lockfile` が赤くなりうる。「一度通った」は「今後も通り続ける」を意味しない。
  当日、tag を切る直前の `origin/main` の sha で §0.1 の CI が緑であることを見ることに変わりはない。
- `typecheck` / `lint` / `format:check` / `test` / `build` は今回も走らせていない
  （オーナー方針により `pnpm run test` の全体実行はしない。CI に任せる）。
- **§2.3 の「何をカバーしないか」は今回も1つも解消していない。**型の互換性と registry の状態
  （信頼発行元の設定・パッケージの存在・直接 publish の許可）は【未検証】のままである。
  **この門が緑でも、publish が通ることは何も保証されない。**§0.5 の項目1・2は、
  この追記でも変わらず未検証のままである。

---

## 3. 🔴 途中で失敗したときの確認手順と回復手順

### 3.0 🔴 戻せない操作は、どこから始まるか

⭐ **追記（2026-09-17）— この節は §3 の他の項目より先に読むこと。**以下は
すべて **【実測】2026-09-17**（tag `v0.2.0`、run `35077566069` を対象にした実測。
コマンドはすべて読み取りのみで、書き込みは行っていない）。

**承認ゲートは無い。**

```bash
gh api repos/takecchi/mnemora/environments
```

は `{"total_count":0,"environments":[]}` を返す。⟹ **Release を published にした
瞬間に `publish.yml` の job が走り出す。途中で人が承認する段は1つも無い。**

**時間軸の実測**（`gh release view v0.2.0 --json publishedAt` と
`gh api repos/takecchi/mnemora/actions/runs/35077566069/jobs` から）:

| 出来事 | 時刻（UTC） | Release 公開からの経過 |
|---|---|---|
| Release を published にした | `09:06:57Z` | — |
| workflow が起動した | `09:06:59Z` | **2秒** |
| step 10（typecheck〜build）開始 | `09:07:22Z` | 25秒 |
| step 14（`npm publish`）**開始 ＝ ここから戻せない** | `09:10:01Z` | **約3分** |
| 6本の publish 完了 | `09:10:34Z` | 約3分37秒 |

⭐ **step 13 までは registry へ1文字も書かない。**⟹ **Release を公開してからおおむね
3分の間なら、Actions で run をキャンセルすれば1本も上がらない。**

⚠ **この「3分」は毎回同じではない。**【実測】直近の本番 run3本（`35018364786` /
`34928369051` / `34586212543`）でも `npm publish` の step はいずれも run 開始から
**2分半〜3分後**に始まり、**28〜33秒**で終わっている——`v0.2.0` の実測と近いが、
同じではない。**当日は自分で Actions の画面を見て、この run の step 14 がいつ
始まるかを確認すること。数字を当てにしないこと。**

🔴 **戻せなくなる瞬間は、step 14 のログに最初の `✔ @mnemora/... を publish した`
が出たときである。**そこから先は、その版のそのパッケージは registry に永久に残る
（§3.5）。

**`npm unpublish` は「戻す」手段にならない**（【読んで確かめた】。
出典: https://docs.npmjs.com/policies/unpublish ）:

- publish から **72時間以内**かつ **他のパッケージが依存していない**なら
  unpublish できる。
- 72時間を超えると「依存が無い・直近1週間の DL が300未満・メンテナが1人」の
  3条件をすべて満たす場合のみ。
- 🔴 **そして最も重要な点: 一度使った `package@version` は、unpublish しても
  二度と使えない。**「消してから同じ版を出し直す」はできない。
- **npm 自身の推奨は unpublish ではなく `npm deprecate <pkg>@<version> "<理由>"`**
  である（消さずに警告を出す）。

⚠ **これらはいずれも npm 側の操作であり、`docs/autonomy.md` §3 によりオーナー専権
である。**この節は「何が起きるか」を書いているだけで、この文書の作業者がこれらを
実行することはない。

### 3.1 6パッケージのうちどこまで上がったかを調べる

```bash
for p in core testkit openai postgres anthropic local-embedding; do
  echo "=== @mnemora/$p ==="
  npm view "@mnemora/$p" versions --json
done
```

⭐ **追記（2026-09-17）— 上の `for p in core testkit ...` は手書きの名前列挙であり、
7つ目のパッケージが増えても黙って見落とす（§1.6 の追記と同じ理由）。**§1.6 が引いた
権威コマンドから名前を得る形に直すと、次のようになる【実測。実際に打って、下の
出力を得た】:

```bash
for p in $(node -e 'import("./scripts/publish-targets.mjs").then(m=>{for(const t of m.PUBLISH_TARGETS)console.log(t.name)})'); do
  echo "=== $p ==="
  npm view "$p" versions --json
done
```

出力（2026-09-17、`origin/main` = `806f23f`。各パッケージの `versions` 配列の
先頭と末尾だけ示す——全文は6本とも `0.1.x`〜`0.2.0` の連番で長いため）:

```
=== @mnemora/core === ["0.1.0", …, "0.1.9", "0.2.0"]
=== @mnemora/testkit === ["0.1.0", …, "0.1.9", "0.2.0"]
=== @mnemora/openai === ["0.1.0", …, "0.1.9", "0.2.0"]
=== @mnemora/postgres === ["0.1.0", …, "0.1.9", "0.2.0"]
=== @mnemora/anthropic === ["0.1.2", …, "0.1.9", "0.2.0"]
=== @mnemora/local-embedding === ["0.1.4", …, "0.1.9", "0.2.0"]
```

（`anthropic` が `0.1.2` から、`local-embedding` が `0.1.4` からなのは §3.4 の
追記が挙げる「初版が新設で後から加わった」経緯そのものであり、異常ではない。）

⭐ **当日はこの形（権威コマンドから名前を得る）で走らせること。**上の手書きの
`for` ループは既存の記録として残す。

**⚠ 直後は遅れる。時間を置いて引き直すこと。**
`docs/autonomy.md` §4 はこう戒めている（`docs/autonomy.md:232`。【読んで確かめた】、逐語）:

> **`npm view` で publish の成否を判断する** | registry の読み取り側は書き込みに数分遅れ、
> **CDN を迂回する `?write=true` でも 404 を返す**（ADR 0066 測ったこと8） |
> `npm publish` の出力で判断する

**実測の具体例**（【読んで確かめた（他セッションでの実測記録）】）:
- ADR 0066 測ったこと8: `@mnemora/core` の publish 成功直後、`npm view`・
  `npm view --prefer-online`・CDN 迂回の `curl ...?write=true` の**すべてが 404**
  だった。もう一度 `npm publish` すると `E403 cannot publish over the previously
  published versions` が返り、そこで初めて「実は成功していた」と分かった。
- ADR 0096 測ったこと8: `local-embedding@0.1.4` の publish 成功時刻（`+`が出た時刻・
  registry の `time` フィールドとも一致）から**約4分間**、読み取り側は404を返し続けた。

**⟹ この手順書での運用**: publish 実行中・実行直後に `npm view` で「まだ上がっていない」
と出ても、それだけでは失敗と判断しない。**判断材料は常に Actions のログに出る
`npm publish` 自身の出力（12番ステップの `::group::` の中身）を優先する。**
`npm view` は**数分待ってから**、Actions のログと**併せて**確認する用途に留める。

### 3.2 既に上がっている版が飛ばされる仕組み（冪等性）

`publish.yml` の12番ステップ、`npm publish` の呼び出し部分（217-239行。【読んで確かめた】）:

```bash
OUT=$(npm publish "${tarball}" --access public --provenance \
  --tag "${NPM_TAG}" ${DRY} 2>&1)
STATUS=$?
...
if [ "${STATUS}" -eq 0 ]; then
  echo "✔ ${spec} を publish した"
elif echo "${OUT}" | grep -q "cannot publish over the previously published"; then
  echo "✔ ${spec} は既に registry に在る（飛ばした）"
else
  echo "✗ ${spec} の publish が失敗した（exit ${STATUS}）" >&2
  exit "${STATUS}"
fi
```

**この設計により、同じ Release（同じ tag）の workflow を Actions の「Re-run failed jobs」
で再実行すると、既に上がっている版は `E403` を「上がっていた」として飲み込み、
まだ上がっていないパッケージから続行できる**（コメント193-197行に明記の意図。
【読んで確かめた】）。

**⚠ ただし `exit "${STATUS}"` に注意——それ以外の失敗は、そこでループが止まる。**
`while IFS= read -r tarball; do ... done < publish-order.txt` という形なので、
**失敗した1本より後ろのパッケージは、その回では一切 `npm publish` が呼ばれない**
（`publish.yml:222-241`のループ構造から読める。【読んで確かめた】）。

### 3.3 同じ tag での re-run で回復できるケースの条件

**re-run が有効なのは、「同じ commit・同じ版で、もう一度叩けば通る」種類の失敗に限られる。**

- 上表1〜11のステップ（typecheck/lint/format/test/build/pack:check/pnpm pack）は
  **6パッケージすべてに対してまとめて実行される**——1パッケージでもここで落ちれば、
  **その回では12番目の `npm publish` ステップに1回も到達しない**（`publish.yml`の
  ステップ順序を通読して確認。【読んで確かめた】）。**⟹ ここでの失敗は「6本のうち何本かだけ
  publish された」という版ずれを生まない**（そもそも1本も publish されていないため）。
- 版ずれが生まれうるのは、**12番目のステップ（`npm publish` の連続実行）の途中で
  E403 以外の理由で1本が失敗したとき**だけである。
  - **原因が「一時的なもの」**（ネットワーク瞬断、npm 側の一時的な障害、信頼発行元の
    権限設定をオーナーが Actions 実行の合間に直した、等）であれば、**同じ tag・同じ
    Release で workflow を Re-run すれば、既に上がった分は E403 で飛ばされ、
    残りだけが同じ版で publish されて揃う**（【未検証・理屈上こうなるはず】——
    このロジック自体は3.2節で読んだとおりだが、実際に「途中で1本失敗させて re-run で
    揃う」ところまでをこの器で再現してはいない）。

### 3.4 🔴 版ずれが残ったまま回復不能になる条件について

**依頼されたオーナーの理解**: 「一時的な失敗は re-run で回復するが、コード起因の失敗は
新しい版での再 Release を要求するため（ADR 0070 により版は tag が権威）、
『前半は新版・後半は旧版』が registry に恒久的に残りうる」。

**この器で現物から確認できたこと（【読んで確かめた】）**:

1. **「コードの問題」で6パッケージすべてが一括して弾かれる経路が存在する。**
   typecheck/lint/format/test/build と `pack:check` は**6パッケージ一括の1ステップ**として
   実行され、`npm publish` ループより**前**にある。ここで検出できる種類の欠陥
   （型エラー・lint 違反・tarball の構造欠陥など）は、**1本も publish されないまま
   workflow 全体が落ちる。**⟹ この種類の失敗では版ずれは生まれない
   （そもそも0本しか上がっていないので、揃っていないという状態自体が存在しない）。
2. **`npm publish` ループの途中で1本が「再実行しても直らない」形で失敗した場合**
   （たとえば、そのパッケージ固有の内容が npm 側の検証に引っかかる・
   `pack:check` の9項目では検出できない何かがある等）、**修正には新しい commit が要る。**
   ADR 0070 により版の権威は tag なので、**同じ tag をそのまま re-run しても
   commit の中身は変わらない**——修正を反映するには**新しい tag（＝新しい版）**を
   切るほかない。
3. **新しい tag を切ったときの挙動**: `apply-release-version.mjs` は**6パッケージ全部の
   `package.json` に同じ新しい版を無条件で書き込む**（`apply-release-version.mjs:64-88`）。
   `publish-targets.mjs` の6件も無条件に対象になる。**⟹ 新しい tag（例: `v1.0.1`）を
   切ると、前回すでに `v1.0.0` で publish 済みだったパッケージも含めて、6本**全部**が
   新しい版（`1.0.1`）への publish を試みる**（既に `1.0.1` を持っていない限り、
   E403 では飛ばされない＝実際に publish される）。

**この3点から、この作業者が導いた結論（【未検証・理屈上こうなるはず】——実際に
このシナリオを再現してはいない）**:

- **「版ずれ」自体は実在しうる状態である**——たとえば `v1.0.0` の Release で
  `core`〜`postgres` の4本が publish に成功し、`anthropic` がコード起因で失敗して
  ループが止まれば、`local-embedding` も含めて未 publish のまま止まる。この時点で
  「4本は `1.0.0`、残り2本は publish 前の旧版のまま」という**一時的な版ずれ**が生まれる。
- **しかし、この版ずれが「回復不能」であるとは、この器では確認できなかった。**
  むしろ現物（上記3点）から読める設計は逆で、**新しい版（例 `v1.0.1`）を切れば、
  4本も残り2本も同じ `1.0.1` へ揃って publish される**（6本全部が対象になるため）。
  ⟹ **版ずれは「同じ版のままでは解消できない」のは正しいが、「新しい版を切れば
  必ず揃う」という設計になっている**——ADR 0060/0066/0070 が実際に辿った
  `0.1.0`（4本のみ・欠陥あり）→`0.1.1`（4本を版ごと出し直して解消）という前例が、
  まさにこの形である（`docs/decisions/0070-....md:139-142`。【読んで確かめた（過去の実例）】）。
- **オーナーの理解のうち「一時的な失敗は re-run で回復し、コード起因の失敗は
  新しい版を要求する」の部分は現物と一致する。**「恒久的に残りうる」の部分は、
  **「次のリリースを出すまでは残る」という意味であれば正しいが、「出しても直らない」
  という意味であれば、この作業者が読んだ設計とは異なる**——新しい版は常に6本全部を
  対象にするので、**版ずれを解消するのに追加の分岐や特別な手順は要らない
  （もう一度 Release を作るだけでよい）**、というのがこの作業者の読みである。
  **⚠ これは実際に途中で1本を落としてから新しい tag で揃うことを再現した結果ではなく、
  コードを読んだ上での推論に留まる。**

#### ⭐ 追記（マネージャーによる検算、2026-09-16）— **上の訂正を受け入れる。ただし残る穴が1つある**

**「恒久的に残りうる」と報告したのはマネージャーである。上の指摘のとおり、その言い方は強すぎた。**
`apply-release-version.mjs` が `PUBLISH_TARGETS` の**6本全部へ無条件に同じ版を書き込む**
ことを現物で確認した（`scripts/apply-release-version.mjs:64-88` のループに、
「この版は既に上がっているか」を見る分岐は1つも無い）。
⟹ **次の Release を出せば `latest` は必ず揃う。訂正を受け入れる。**

**⚠ しかし「揃う」のは `latest` であって、版の並びではない。**

`v1.0.0` の publish が `postgres` で落ちた場合を考える:

- `@mnemora/core@1.0.0` は registry に**永久に残る。**
- `@mnemora/postgres@1.0.0` は**永久に生まれない。**
  同じ `v1.0.0` の Release を re-run しても、失敗の原因がコードなら同じ commit を
  checkout するので同じ結果になる。原因を直す＝新しい commit＝新しい tag＝ `v1.0.1` である。
- ⟹ `latest` は `v1.0.1` で揃うが、**`npm i @mnemora/core@1.0.0 @mnemora/postgres@1.0.0`
  は永久に解決できない。**

**⭐ これは仮定の話ではない。いま registry に実在する** 【実測】2026-09-16、
`npm view <pkg> versions --json` を6本すべてに対して実行した:

| パッケージ | registry に在る版 |
|---|---|
| `@mnemora/core` / `testkit` / `openai` / `postgres` | `0.1.0` 〜 `0.1.9` |
| `@mnemora/anthropic` | **`0.1.2`** 〜 `0.1.9`（`0.1.0`・`0.1.1` が無い） |
| `@mnemora/local-embedding` | **`0.1.4`** 〜 `0.1.9`（`0.1.0`〜`0.1.3` が無い） |

⟹ **「6パッケージは常に同じ版で揃っている」は、今日の `latest` については真だが、
版の履歴については偽である。** 上の2本は後から仲間に入ったため（失敗ではなく新設が理由）
だが、**穴の形はまったく同じ**である——`@mnemora/core@0.1.0` と
`@mnemora/anthropic@0.1.0` を同時に入れることは、今日も、この先も、できない。

**⟹ 当日の判断としては、こう読むこと:**

- **慌てて新しい tag を切る必要は無い。**`latest` は次の Release で必ず揃う。
- ⚠ **ただし「失敗した版番号は、揃わないまま registry に残る」**ことは受け入れることになる。
  `v1.0.0` という節目の版でこれが起きると、**「1.0.0 では一部のパッケージが入手できない」**
  という形で後から参照されうる。**それが許容できないなら、失敗した版は飛ばして
  `v1.0.1` を「最初の v1」として扱う、という選択もある**（これは製品の判断であり、
  この手順書は決めない）。
- **【未検証】** 上の段落のうち、**実際に途中で1本落としてから次の tag で揃うことを
  再現した結果は無い。**版の並びに穴が残ることは registry の実測（上の表）で確かめたが、
  **それは「publish の失敗によって開いた穴」ではない**（新設が理由である）。
  **失敗によって同じ形の穴が開くこと自体は、コードを読んだ上での推論に留まる。**

#### ⭐ 追記（2026-09-17）— これは実例が在る。そして実際に採られた回復は、re-run でも新しい tag でもなかった

**すべて【実測】2026-09-17。**

**`gh run view 34452890407 --log`**（tag `v0.1.4`、2026-09-10）の逐語:

```
✔ @mnemora/core@0.1.4 を publish した
✔ @mnemora/testkit@0.1.4 を publish した
✔ @mnemora/openai@0.1.4 を publish した
✔ @mnemora/postgres@0.1.4 を publish した
✔ @mnemora/anthropic@0.1.4 を publish した
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@mnemora%2flocal-embedding - Not found
✗ @mnemora/local-embedding@0.1.4 の publish が失敗した（exit 1）
```

⟹ **6本中5本が上がり、6本目で止まった。**§3.2 が読んだループ構造のとおりに動いている。

**その run は re-run されていない**（`gh api repos/takecchi/mnemora/actions/runs/34452890407/attempts/2` が404）。**新しい tag も切られていない**（次の tag は `v0.1.5` で、これは別の内容）。

🔴 **実際に採られた回復は、人手で同じ版を publish することだった。**【実測】
`npm view @mnemora/local-embedding@0.1.4 --json`:

- `_npmUser` が **`takecchi <takecchi.kobayashi@gmail.com>`**（人間。OIDC 経路なら
  `GitHub Actions` / `trustedPublisher.id: "github"` になる）
- **`dist.attestations` が無い**（＝ provenance が付いていない）
- 公開時刻 `2026-09-10T08:05:57.603Z` ＝ **run の step 14 が落ちた `08:03:42Z` の
  2分15秒後**
- 対照: 同じパッケージの `0.1.5` は `_npmUser` が `GitHub Actions` /
  `trustedPublisher.id: "github"` で
  `dist.attestations.provenance.predicateType == "https://slsa.dev/provenance/v1"`
  が在る。

⟹ **§3 が挙げていなかった第3の回復手段が在る: 落ちた1本だけを、同じ版で人手で
publish する。**

- ⭕ **利点**: 版の並びに穴が開かない（§3.4 が指摘する「`core@1.0.0` は在るのに
  `postgres@1.0.0` は永久に生まれない」を避けられる）。
- 🔴 **代償**: **その1本だけ provenance が付かない。**実例がそれである——
  `@mnemora/local-embedding@0.1.4` は、そのパッケージで唯一 attestation を持たない
  版として今も registry に残っている。
- ⚠ **さらに 2FA の壁が在る**: ADR 0066「測ったこと8」が、`npm login` だけでは
  `EOTP` で落ちたこと（2FA が書き込みにも掛かる）と、automation token を作って
  回避し publish 後に失効させたことを記録している（【読んで確かめた】）。
- ⚠ **これはオーナー専権の操作である**（`docs/autonomy.md` §3）。

⚠ **ただし v0.1.4 の失敗の原因は「そのパッケージが registry にまだ存在せず、OIDC
では初版を作れない」という bootstrap 固有のもの**（`scripts/publish-targets.mjs`
のコメントが npm/cli#8544 を挙げている。【読んで確かめた】）。**v1.0.0 の時点では
6本とも registry に既に在るので、この原因そのものは再発しない。**⟹ **再発しうる
のは「原因」ではなく「形」**——ループが途中で止まり、後ろが上がらない、という
形である。

### 3.5 publish 済みの版は上書きできない

**実例（【読んで確かめた】）**: `@mnemora/core` を含む4パッケージの `0.1.0` は、
中身に不備（`postgres@0.1.0` に migration `0004`/`0005` が欠けていた等）があると
分かった後も、**上書きできず、そのまま残っている**（`docs/decisions/0066-....md:11,
241-267`）。解消は `0.1.1` を新しく publish することで行われた——`0.1.0` 自体は
今も欠陥入りのまま registry に存在する。

**⟹ v1.0.0 で何か問題が見つかっても、「直して `v1.0.0` を出し直す」ことはできない。
やり直しは常に「次の版」（`v1.0.1` 等）になる。**これは3.4節の結論とも整合する——
版ずれの解消も、欠陥の修正も、**同じ手段（新しい tag を切ること）に帰着する。**

---

## 4. Trusted Publishing / OIDC / provenance が初回で失敗したときの兆候

### 4.1 どのステップで・どんなエラーが出るか（`publish.yml` から読めるものだけ）

**OIDC のトークン自体が発行されない場合**（`id-token: write` 権限の欠落など）:
この repo では `publish.yml:44-46` に `permissions: id-token: write` が明示されているため、
**通常は起きないはず**（【未検証・理屈上こうなるはず】——欠落時にどんなメッセージが出るかは、
この repo でその状態を作って試していない）。

**npm CLI が古い場合**: `npm install -g npm@latest` を飛ばすと、OIDC の交換を知らない
npm 10.x が「長期トークンが無い」という顔で **401** を返す
（`publish.yml:63-65` のコメント。【読んで確かめた】。ただしこの repo は既にこのステップを
組み込んでいるので、**削除しない限り再現しない**）。

**信頼発行元が未設定、または権限が不足している場合**（実際に観測された、この repo での
過去の失敗）:

```
npm error 403 Forbidden - PUT https://registry.npmjs.org/@mnemora%2fcore
          - OIDC permission denied for this action
```

（`docs/decisions/0070-....md:113-116`。【読んで確かめた（過去の実測ログ）】）。
このエラーは `npm publish` を呼ぶステップ（12番）で、該当パッケージの `::group::` の
中に出る。

**過去に実際に起きた原因は2種類あった**（いずれも【読んで確かめた（過去の実例）】）:

1. **信頼発行元そのものが未設定**（ADR 0067測ったこと。予行では検出できない。§2.2）。
2. **信頼発行元は設定済みだが「直接 `npm publish`」の権限が不許可のまま**
   （npm の既定。2026-09-03以降に作成した信頼発行元は「npm publish で直接publishできる」を
   既定で不許可にする。ADR 0070「測ったこと3」、`docs/decisions/0070-....md:122-131`）。
   このときのエラー文言も同じ `OIDC permission denied for this action` だった
   （**この作業者はこの2つを、エラー文言だけからは区別できないと明記されている点に注意**
   ——ADR 0067自身が「repo名・workflowファイル名の食い違いなど、設定は在るが誤っている
   場合でも同じ `OIDC permission denied` が返る可能性を排除できていない」と書いている。
   `docs/decisions/0067-....md:100-103`）。

**リポジトリ名やworkflowファイル名が信頼発行元の設定と食い違う場合**:
**この器では確認できなかった**——ADR 0070測ったこと3は「不一致なら npm は404を返す。
今回は403（PUTまで到達）だったので不一致ではないと判断した」という**消去法の記録**であり、
実際に不一致を起こしてエラーを観測したものではない（`docs/decisions/0070-....md:118-121`）。
**⟹ 404が返ったら「repo名かworkflowファイル名の不一致」を疑う、という以上のことは
この文書からは言えない。**

### 4.2 npm 側で確認すべきこと（🔴 この環境からは npm の画面を見られない）

**この作業者はこのセッションで npmjs.com の設定画面を直接見ていない。**
以下は ADR 0066・0070 が過去に記録した「実際に見て・設定した」内容の要約であり、
**当日オーナーが npmjs.com 上で確認すべき項目のリスト**として引いたものである
（【読んで確かめた（過去の設定記録）】）。

各パッケージ（6つ）について `https://www.npmjs.com/package/@mnemora/<名前>/access` で:

| 項目 | 設定すべき値 |
|---|---|
| Organization / user | `takecchi` |
| Repository | `mnemora` |
| **Workflow filename** | **`publish.yml`**（一致必須。改名すると403で止まる。`publish.yml:3-6` にも明記） |
| 「直接 `npm publish` を許可」 | **許可する**（既定は不許可。ADR 0070測ったこと3で実際にこれが原因で403になった） |

**⚠ npm は保存時にこれらの値を検証しない**（ADR 0066、391行に明記。誤っていても保存でき、
publish を打った瞬間に初めて分かる）。

**6パッケージすべてで確認すること。**特に `@mnemora/anthropic` と `@mnemora/local-embedding`
は初版を OIDC で出せなかった過去がある（新規パッケージは信頼発行元をパッケージ作成前には
設定できないため、ADR 0072/0096 で個別に手元 bootstrap を行っている）——
**この2つは他の4つと設定のタイミングが違っていた可能性があるので、当日改めて全部見ること
を勧める（【未検証・理屈上こうなるはず】——今回この作業者は npm 側の現在の設定状態を
確認していないので、実際に6つとも設定済みかどうかは分からない）。**

### 4.3 `npm install -g npm@latest` がなぜ要るか

`publish.yml:63-68`（【読んで確かめた】、逐語）:

```yaml
- name: Update npm CLI（Trusted Publishing は npm >= 11.5.1 が必要）
  # Node 22 に同梱の npm は 10.x で、OIDC の交換を実装していない。
  # ここを飛ばすと publish は「トークンが無い」の顔をして 401 で落ちる。
  run: |
    npm install -g npm@latest
    npm --version
```

**理由**: GitHub Actions の `actions/setup-node@v6` が入れる Node 22 には npm 10.x系が
同梱されており、Trusted Publishing（OIDC）の交換ロジックを実装していない
（ADR 0066決定3の表、`docs/decisions/0066-....md:131`。【読んで確かめた】）。
これを飛ばすと、npm は「認証トークンが見つからない」という**別の理由の顔をした401**を
返す——**OIDCが機能していないことを名指しでは教えてくれない**、という点が実務上の罠である。

---

## 5. リリース後の確認

### 5.1 6パッケージが同じ版で上がったか

```bash
for p in core testkit openai postgres anthropic local-embedding; do
  echo "=== @mnemora/$p ==="
  npm view "@mnemora/$p" version
done
```

⭐ **追記（2026-09-17）— 上の `for p in core testkit ...` も§1.6・§3.1と同じ理由で
権威から数え直せない。**権威コマンドから名前を得る形に直すと【実測。実際に打って、
下の出力を得た】:

```bash
for p in $(node -e 'import("./scripts/publish-targets.mjs").then(m=>{for(const t of m.PUBLISH_TARGETS)console.log(t.name)})'); do
  echo "=== $p ==="
  npm view "$p" version
done
```

出力（2026-09-17、`origin/main` = `806f23f`。**測ったのは `v1.0.0` がまだ無い時点なので、
値は `0.2.0` である**——`1.0.0` になっているかどうかの判定は当日行うこと）:

```
=== @mnemora/core ===
0.2.0
=== @mnemora/testkit ===
0.2.0
=== @mnemora/openai ===
0.2.0
=== @mnemora/postgres ===
0.2.0
=== @mnemora/anthropic ===
0.2.0
=== @mnemora/local-embedding ===
0.2.0
```

⭐ **当日はこの形で走らせること。**

**全部 `1.0.0` になっていることを確認する。**1本でも古い版のままなら、§3の手順で
「どこで止まったか」を Actions のログから確認すること。

### 5.2 provenance が付いているかの確かめ方

**過去の実例**では、OIDC 経由で publish された版に2件の attestation
（`https://github.com/npm/attestation/tree/main/specs/publish/v0.1` と
`https://slsa.dev/provenance/v1`）が付いたと記録されている
（`docs/decisions/0070-....md:138`。【読んで確かめた（過去の記録）】）。

**⚠ この記録は「付いた」という結果を書いているだけで、当時どのコマンド・どの画面で
確認したかをこの作業者は現物から特定できなかった。**⟹ 一般的な npm CLI の機能として
知られている次の2つを候補として挙げるが、**この repo・この作業者はどちらも実行して
確かめていない**（【未検証・理屈上こうなるはず】）:

- `npm view @mnemora/core@1.0.0 --json` を見て `dist` の中に attestation / signature
  関連のフィールドが出るか
- npmjs.com のパッケージページに「Provenance」のバッジ・リンクが表示されるか

**これは、この手順書を書いていて「現物を読んでも分からなかった」点の1つである
（下記「オーナーしか知らないこと」にも再掲する）。**

⭐ **追記（2026-09-17）— 実際に両方とも打って確かめた。**

**1つ目のコマンドを打った**【実測。ただし測ったのは `0.2.0` に対してである——
`1.0.0` はまだ存在しない。`npm view @mnemora/core@1.0.0 --json` は
`E404 No match found for version 1.0.0` を返す（当然——まだ切られていない）】:

```bash
npm view @mnemora/core@0.2.0 --json
```

**両方が出ていれば provenance 付きで成功している**——実際に出た（抜粋）:

```json
"dist": {
  "attestations": {
    "url": "https://registry.npmjs.org/-/npm/v1/attestations/@mnemora%2fcore@0.2.0",
    "provenance": { "predicateType": "https://slsa.dev/provenance/v1" }
  }
},
"_npmUser": {
  "name": "GitHub Actions",
  "email": "npm-oidc-no-reply@github.com",
  "trustedPublisher": { "id": "github", "oidcConfigId": "oidc:fec1bcbc-..." }
}
```

- `dist.attestations.provenance.predicateType` が `"https://slsa.dev/provenance/v1"` ✔
- `_npmUser.trustedPublisher.id` が `"github"`（かつ `_npmUser.name` が
  `"GitHub Actions"`）✔
- ⚠ **逆に `_npmUser` が人間の名前の文字列で、`dist.attestations` が無ければ、
  それは OIDC 経路を通っていない**（＝ 人手 publish）。§3.4 の追記の実例
  （`@mnemora/local-embedding@0.1.4`）がそれである。

**2つ目のやり方も打った**【実測】:

```bash
mkdir /tmp/f6-audit-test && cd /tmp/f6-audit-test
npm install @mnemora/core@0.2.0 --no-save
npm audit signatures
```

出力:

```
1 package has a verified registry signature

1 package has a verified attestation
```

⟹ **`verified attestation` が出れば成功。**⚠ **先に `npm install` していない
空のディレクトリで `npm audit signatures` だけ打つと** 【実測】
`npm error found no installed dependencies to audit` になる——**先に install が要る。**

⚠ **§5.3 の遅延に注意**: publish 直後は `npm view` が404を返しうる。**数分待って
から引くこと**（このコマンド自体は `0.2.0` という既に安定した版に対して打ったので、
遅延の影響は受けていない）。

### 5.3 `npm view` の遅延について（再掲）

§3.1と同じ注意がここでも当てはまる。publish 直後の数分は `npm view` が404を返しうる
（実測で約4分、というのが唯一この repo にある具体的な数字だが、それが毎回同じ長さである
保証はない。【未検証・理屈上こうなるはず】——「4分」はADR 0096の1回の観測であり、
一般化できる値だとは書かれていない）。**焦らず、Actions のログの `npm publish` の
出力を先に確認すること。**

---

## この手順書を書いていて「現物を読んでも分からなかった」点（当日の穴になりうるもの）

1. **provenance の確認方法の具体的なコマンド・画面**（§5.2）。過去の ADR は
   「付いた」という結果だけを記録しており、確認手順そのものは記録されていない。
2. **信頼発行元（Trusted Publisher）の現在の設定状態。**この作業者は npmjs.com の
   画面を一度も見ていない。6パッケージ全部で「org/repo/workflow filename/直接publish許可」
   が正しく設定されているかは、**オーナーが当日 npm の画面で確認する必要がある**
   （§4.2）。
3. **`npm publish --tag ""`（NPM_TAG が空文字列）の挙動。**`publish.yml` はこれを
   手前で検査して落とすようになっているが（213-216行）、それは「確かめていないことを
   通さない」という設計であって「確かめた」わけではない、と ADR 0070 自身が明記している
   （`docs/decisions/0070-....md:174-175`）。
4. **`npm publish` ループの途中で1本だけが「再実行しても直らない」形で失敗する
   具体的な原因の実例。**この repo の ADR には、そのような失敗が実際に起きた記録が無い
   （起きたのは「信頼発行元の権限不足」という**全パッケージに一様に効く**種類の失敗だけで、
   1本だけが特異的に失敗した実例は見当たらなかった）。§3.4 の分析は、コードの構造から
   導いた推論であり、実例に基づくものではない。

   **⭐ 追記（2026-09-17）— 訂正。ADR には無いが、Actions の run のログには在った。**
   run `34452890407`（tag `v0.1.4`）で `@mnemora/local-embedding` だけが特異的に
   失敗し、re-run も新しい tag も使わず人手 publish で回復した実例が実在する。
   詳細は §3.4 の追記「⭐ 追記（2026-09-17）— これは実例が在る。そして実際に
   採られた回復は、re-run でも新しい tag でもなかった」を見ること。⚠ ただし
   その原因（そのパッケージの初版を OIDC で作れない bootstrap 固有の事情）は
   `v1.0.0` の時点では再発しない——§3.4 の追記が指摘するとおり、**再発しうるのは
   「原因」ではなく「ループが途中で止まる」という形そのものである。**
5. **`@mnemora/anthropic` と `@mnemora/local-embedding` が、現時点で本当に6本とも
   通常の OIDC 経路（信頼発行元設定済み・直接publish許可済み）に乗っているか。**
   ADR 0072・0096 の時点では2つとも「手元からの bootstrap」を経ており、その後
   信頼発行元が正しく設定されたかどうかの後続記録をこの作業者は見つけられなかった。

   **⭐ 追記（2026-09-17）— 実測で埋まった。**【実測】各パッケージの`dist.attestations`
   （`npm view <spec>@<version> --json`）と公開時刻（`npm view <pkg> time --json`）を、
   最初の数版について引いた:

   | パッケージ＠版 | provenance | npm 上の公開時刻 |
   |---|---|---|
   | `@mnemora/core@0.1.0` | **無し** | 2026-09-08T08:58:42Z |
   | `@mnemora/anthropic@0.1.2` | **無し** | 2026-09-09T07:26:52Z |
   | `@mnemora/anthropic@0.1.3` | **在り** | 2026-09-09T07:52:59Z |
   | `@mnemora/local-embedding@0.1.4` | **無し** | 2026-09-10T08:05:57Z |
   | `@mnemora/local-embedding@0.1.5` | **在り** | 2026-09-11T09:53:15Z |

   `publish.yml:227` は `--provenance` を必ず付ける唯一の publish 経路なので、
   **provenance の有無が「publish.yml（OIDC 経路）を通ったか」の指紋になっている**
   【実測から読める事実】。この指紋を `gh run list --workflow=publish.yml` の run 履歴と
   突き合わせると（`gh run list --workflow=publish.yml --limit 30` で確認）:

   - `v0.1.2` の `release` run（`34307628422`、2026-09-09T03:34:10Z 開始、success）は
     `@mnemora/anthropic@0.1.2` の公開時刻（07:26:52Z）より**後ではない**——run の開始が
     03:34、公開が07:26で、この run の対象ではありえない。実際、`gh run list` を遡ると
     `@mnemora/anthropic` を含む6パッケージ構成になったのは `v0.1.3` の run
     （`34325940046`、2026-09-09T07:50:45Z 開始、2m17s で終了 ≈ 07:53:02Z、success）が
     最初であり、終了予想時刻は公開時刻 07:52:59Z とほぼ同時（数秒差）だった。
     それより前の run には `anthropic` が含まれていない
     （【未検証・理屈上こうなるはず】——run 内で実際にどのパッケージが対象だったかは
     ログを1本ずつ開いて確認したわけではなく、公開時刻と run の開始・終了時刻の近さから
     推論している）。
   - `@mnemora/local-embedding@0.1.4` の公開（08:05:57Z）は、`v0.1.4` の `release` run
     （`34452890407`、2026-09-10T08:00:53Z 開始、**failure**、2m52sで終了 ≈ 08:03:45Z）が
     **落ちた後**に起きている。ADR 0096 が記す「OIDC で出せず手元から出した」という記述と、
     この時刻の並びは**矛盾しない**（【実測】は時刻の並びのみ。**誰が・どうやって
     手元から出したかは、この器からは見えない**——ここは【未検証・理屈上こうなるはず】）。

   ⟹ **provenance の有無で見る限り、両パッケージとも「初版だけ bootstrap、次の版
   （`anthropic` は `0.1.3`、`local-embedding` は `0.1.5`）から OIDC 経路」という
   `@mnemora/core` 等と同型の経緯を辿っており、その状態が現在の最新版（`0.2.0`。
   §0.5 項目1・2の追記で確認した6パッケージとも provenance あり、に含まれる）まで
   途切れず続いている。**⟹ **§0.5 項目2 が挙げていた「現在 OIDC 経路に乗っているか」
   という懸念は、これで実証的に解消する。**
   ⚠ **ただし「誰が・どのコマンドで手元 bootstrap を行ったか」の記録は、依然として
   見つかっていない。**ここは解けていない——上の表は「いつ・provenance の有無」までしか
   語らない。
6. **今この repo の6パッケージの `package.json` の `version` が `0.1.1` であること**
   （この作業者がこの器で確認した実測）と、**npm registry 上の実際の最新版が
   何であるか**の関係。ADR 0070・0096 を読む限り、少なくとも一時点では registry 側が
   `0.1.4` まで進んでいた記録があるが、**この作業者は今回 `npm view` を実行していない
   ため、現時点の registry の実際の値は確認していない。**v1.0.0 を出す前に、
   まず `npm view @mnemora/core version` 等で「今どこから上げることになるか」を
   確認することを勧める。
