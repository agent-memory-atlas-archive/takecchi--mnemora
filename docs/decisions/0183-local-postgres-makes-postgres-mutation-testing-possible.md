# ADR 0183: `packages/postgres` の変異試験を、CI のトリガを変えずに手元で成立させる — `initdb` で自分専用のインスタンスを立てる手順を `AGENTS.md` に置く

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

- **この ADR の根拠の種別**:

  - **【実測】** — この ADR の書き手が、**この器で自分の手で走らせて確かめた**。
    DB を要する測定は、`initdb` で立てた自分専用の Postgres
    （port 59894 / `PGDATA` は作業ディレクトリ下）に対して行った。
  - **【現物】** — この repo のコード・workflow・文書を、書き手が自分の手で読んで確かめた。
  - **【受】** — [Issue #247](https://github.com/takecchi/mnemora/issues/247) 本文。
    **2026-09-15 の別の器での実測であり、本 ADR の書き手は再現していない**
    （再現できない——器が違う。下記「覆るとしたら」を見ること）。

- **文脈**:

  `docs/autonomy.md` §2 は、PR を出す条件のひとつに次を挙げている（逐語）:

  > - [ ] **歯が実際に噛むことを、変異試験で示した**（壊した入力で赤く、直したら緑に戻る）

  **[Issue #247](https://github.com/takecchi/mnemora/issues/247) は、`packages/postgres` の
  実装に対してこの条件を担い手が満たせないと指摘した。**【受】2026-09-15 の器では
  docker も podman も Postgres のバイナリも無く、`DATABASE_URL` も未設定だった。

  実害も現物で挙がっている【受】: **PR #245（ADR 0134、矛盾検出の第1弾）で、
  `packages/postgres/src/memory-store.ts` の `markContestedPair` に対して変異試験が
  1本も行われないままマージされた。**⚠ #245 は「これから積み上げる土台」であり、
  土台の歯が噛むかを確かめられない状態が続くと、**その上に積むものすべてが
  同じ未検証を引き継ぐ。**

  Issue #247 は解き方を4つ並べ、**どれも採っていない**。本 ADR がそこを決める。

  ### ⭐ 本 ADR の起点は、Issue #247 の前提の1つが**この器では成り立たなかった**ことである

  **【実測】2026-09-17、この器には Postgres サーバのバイナリと pgvector が在った:**

  ```
  /usr/lib/postgresql/17/bin/{initdb,pg_ctl,postgres,createdb}  → 在る
  /usr/share/postgresql/17/extension/vector.control             → 在る
  docker / podman                                               → 無い（Issue #247 と同じ）
  ```

  ⟹ **docker が無いことと、DB を用意できないことは、同じではなかった。**
  Issue #247 は `docker-compose.yml`（ADR 0130）では解けないと正しく書いているが、
  **`initdb` で自分専用のインスタンスを立てる経路を見ていない。**

- **北極星の5つの問いに実際に当てた結果**（`docs/north-star.md`「迷ったときの問い」。
  問いは書いた時点では飾りと区別が付かない、という同文書の戒めに従い、
  **実際に何が落ちたか**を記録する）:

  | 問い | この判断にどう当たったか | 落ちた案 |
  |---|---|---|
  | **1**（毎回渡す量を減らす方向に働くか） | 該当しない（recall の経路に1バイトも触れない、手引きと検証手順の話である）。 | — |
  | **2**（無効にしても Memory Framework として成立するか） | **これが決め手になった。**`ci.yml` に手を入れる案は、どれも「検証のために CI の構えを増やす」形である。**手元で立てられるなら、CI 側に何も足さずに済む。** | **`workflow_dispatch` を足す案・`push:` を全枝へ広げる案**（下記「採らなかった案」1・2）。 |
  | **3**（選ばれた理由を後から説明できるか） | **`packages/postgres` の歯が噛むことを、初めて実際に示せるようになる。**「噛むはずだ」と「噛んだ」を分けられる。 | **「`packages/postgres` の変異試験を要求しないと規約に書く」案**（Issue #247 の方向4）。これは問い3を**逆向きに**壊す——測れないことを規約の緩和で隠す形である。 |
  | **4**（推論と事実を区別しているか） | 該当しない。 | — |
  | **5**（LLM を呼ばずに済ませられないか） | 該当しない。 | — |

- **決めたこと**:

  1. **`.github/workflows/ci.yml` を1バイトも変えない。**
     `workflow_dispatch` を足さない。`on: push:` を全枝へ広げない。
     **⟹ CI の実行時間の増分は 0分・0ジョブである。**

  2. **`AGENTS.md` に「手元で Postgres を立てる」節を置く**（新設）。中身:
     - **在るかどうかを先に見る**（`initdb` と `vector.control` の2つ。**片方でも無ければ
       この手順は使えない**と明記する）
     - ⛔ **共有資源に触らない**——既定のポート 5432 を使わない / `pg_ctlcluster` と
       システムのサービスを使わない / データディレクトリと socket を自分の
       作業ディレクトリの下に作る。**この器は他の担い手と共有されていることがある。**
     - `initdb` → `pg_ctl start` → `createdb` → 拡張3本（`vector` / `btree_gin` /
       `pgcrypto`。**`ci.yml` の `postgres` ジョブと同じ3本**）→ `migrate` → `test:db`
     - **1本に絞る打ち方**（`vitest run ... -t "<名前>"`）。`test:db` 全体は約4分かかる【実測】
     - ⛔ **変異を戻すのに `git checkout` を使わない。`cp` で往復する**
       （`docs/autonomy.md` の「穴」の表が記録している事故——未コミットの編集が
       一緒に消え、実際に3ファイル失われている）
     - **戻した後、同じ it が緑に戻ることまで実測する**こと。「赤くなった」だけでは、
       壊したのが狙った歯なのか別のものなのかが分かれていない

  3. **この手順は「どの担い手の環境でも通る」と主張しない。**
     `AGENTS.md` の節にその但し書きを明記する。**バイナリ自体が無い器では通らない**——
     その場合は Issue #247 の「考えられる方向」へ戻る。

  4. **`docs/autonomy.md` §2 の要求を緩めない。**本 ADR は §2 に1文字も触れない。

- **採らなかった案**:

  1. **`ci.yml` に `workflow_dispatch` を足す**（Issue #247 の方向3）。
     ⭕ 自動実行の回数は増えない。⭕ この器のトークンは `workflow` スコープと
     `admin: true` を持っており【実測】、Issue #247 が挙げた「権限が要る」という留保は
     少なくともこの器では解消されている。
     ❌ **しかし、手元で立てられるなら要らない。**
     ❌ **そして、いま払う費用が高い。**[Issue #267](https://github.com/takecchi/mnemora/issues/267)
     が既に「ADR を持つ PR は索引再生成で CI がもう1周する」を費用として問題にしている。
     1周は **13ジョブ・壁時計 4〜9分**【実測】（⚠ Issue #267 本文の「11ジョブ」は
     2026-09-15 時点の値である。`association-probes` / `validity` が後から入り、
     2026-09-17 に数え直すと **13** だった）。
     ⟹ **CI へ足すのは、手元で解けないと分かってからでよい。**
     **この案は捨てていない**——バイナリの無い器が現れたら、ここへ戻る。

  2. **`on: push:` を全枝（または `mutation/**`）へ広げる**（Issue #247 の方向2）。
     ❌ 案1と同じ理由に加え、**接頭辞を決める必要があり、決めた接頭辞を知らない担い手が
     踏めない。**⟹ 手引きを書く手間は案1と変わらず、CI の回数だけ増える。

  3. **変異試験専用の workflow ファイル（`mutation-check.yml`）を別に作る。**
     ⭕ 自動実行ゼロ、起動時も1ジョブで済む。
     ❌ **`ci.yml` の DB service の設定を複製することになる。**
     `AGENTS.md` 自身が「**複製した瞬間から、正文と要約はずれ始める。
     片方を直してもう片方を直し忘れることは、規律ではなく注意力に依存しており、
     必ず失敗する**」と書いている。**同じ理由でこの案を落とす。**

  4. **`packages/postgres` の変異試験を要求しないと規約に書く**（Issue #247 の方向4。
     issue 自身が「非推奨」と書いている）。
     ❌ **測れないことを規約の緩和で隠す形である。**上の問い3で落ちる。

  5. **`markContestedPair` 以外にも変異試験を広げる。**
     ❌ **1 PR は1つの ADR とその実装**（`docs/autonomy.md` §2）。
     Issue #247 が名指しした1箇所に絞る。

- **測ったこと**:

  ### (a) 「変異試験が CI のどのジョブで走っているか」への答え 🔴【現物】

  **1つも走っていない。**

  - `rg -n -i "stryker|mutation|変異"` が返すのは、(i) ADR の「測ったこと」節が
    **手作業で行った変異試験を記録している**もの、(ii) ファイル名に `mutation` を含む
    通常の vitest テスト（例: `packages/core/src/__tests__/stage3-mandatory-companion-mutation.test.ts`
    ——これは「変異が起きても回帰しない」ことを見る**固定テスト**であり、
    mutation-testing フレームワークではない）だけである。
  - ルート `package.json` の `scripts` に該当するものは無い。
  - `.github/workflows/ci.yml` の**全13ジョブ**のどれにも、コードを意図的に壊して
    赤/緑を見る段は無い。`postgres` ジョブが走らせるのは
    `pnpm --filter @mnemora/postgres run test:db`（正常系の適合テスト）だけである。

  ⟹ **`docs/autonomy.md` §2 の「変異試験」は、自動の門ではなく手作業の規律である。**
  ⟹ **Issue #284 の数え方の規律**（本番コードから呼ぶ経路が無ければ「在る」と数えない）
  **に当てると、変異試験は「CI に在る歯」として数えてはいけない。**

  ### (b) CI の構え【現物】2026-09-17、`main` = `d2f5e40`

  | 項目 | 値 |
  |---|---|
  | ジョブ数 | **13**（⚠ Issue #267 本文の「11」は 2026-09-15 の値。`association-probes` / `validity` が後から入った） |
  | トリガ | `on: push: branches: [main]` と `pull_request:` **のみ**。`workflow_dispatch` は**無い** |
  | DB を立てるジョブ | `postgres`（matrix 2本）/ `example-chat` / `root-gate-db-stage` / ベンチ系 |
  | `packages/postgres` を走らせるジョブ | `postgres`（UTF8 / SQL_ASCII）と `root-gate-db-stage` の2つ。**いずれも正常系** |
  | 1周の壁時計 | push run `35083999344`（`main`）**約4分** / pull_request run `35076230852` **約9分13秒**。どちらも `root-gate-db-stage` が最長 |

  ### (c) ⭐ 構造的に一度も走らない歯【現物】**4ファイル・28 it**

  **数え方**: 「CI のいまの構成では、どんな入力でも通過しない `it`」を **it 単位**で数えた。

  | ファイル | 必要な env | it |
  |---|---|---|
  | `packages/anthropic/src/__tests__/live.anthropic.test.ts` | `ANTHROPIC_API_KEY` **かつ** `MNEMORA_LIVE_ANTHROPIC` | 2 |
  | `packages/openai/src/__tests__/live.openai.test.ts` | `OPENAI_API_KEY` **かつ** `MNEMORA_LIVE_OPENAI` | 11（適合テスト9本を含む） |
  | `packages/local-embedding/src/__tests__/live.local-embedding.test.ts` | `MNEMORA_LIVE_LOCAL_EMBEDDING` | 14（適合テスト9本を含む） |
  | `packages/local-embedding/src/__tests__/live.cache-warm-network-behaviour.test.ts` | `MNEMORA_LIVE_LOCAL_EMBEDDING` | 1 |
  | **合計** | | **28** |

  `.github/workflows/ci.yml` にこの4つの env は**設定値として1つも無い**
  （`grep` で出るのはコメント中の言及のみ）。

  **⚠ この28本と「`packages/postgres` の変異試験」を合算した1つの数字は出さない。**
  前者は**課金事故を避けるための二重 opt-in**（ADR 0019 §5c。意図された設計であり、
  鍵を持つ人が手元で走らせる経路が用意されている）、後者は**テストファイルとして
  存在すらしない一回性の検証行為**である。**性質が違うものを1つの数字に潰さない。**

  ### (d) この器で DB を立て、`packages/postgres` を通した【実測】2026-09-17

  ```
  PostgreSQL 17.11 (Debian 17.11-0+deb13u1)
  vector 0.8.0 / btree_gin 1.3 / pgcrypto 1.3
  migrate: 0001_init.sql 〜 0015_decay_activity_clock.sql（15本）適用
  test:db: Test Files 48 passed (48) / Tests 546 passed (546) / Duration 238.55s
  ```

  ⚠ **`/dev/shm` はこの器で 62MB しか無い**【実測】。HNSW の**並列**索引構築が落ちうる
  ため `max_parallel_maintenance_workers = 0` を候補として用意したが、
  **546 it を通しても変異試験7回を回しても、shm 由来のクラッシュは一度も起きなかった。**
  ⟹ **この設定は適用していない**（既定値 2 のまま測った）。**より重い検査
  （`bench:scale` 等）で崩れたら、そのとき候補になる。**

  ### (e) 🔴 本番 — Issue #247 が「1本も行われていない」と名指しした変異試験を、実際に行った【実測】

  対象: `packages/postgres/src/memory-store.ts` の `markContestedPair`。
  歯の本体は `packages/testkit/src/memory-store-conformance.ts:3211-3437`
  （`supportsMarkContestedPair` ブロック）で、`packages/postgres/src/__tests__/conformance.postgres.test.ts`
  経由で本物の Postgres に当たる。**ベースライン: `-t "markContestedPair"` で 8 it 全緑。**

  | # | 何を壊したか | 結果 | 落ちた it / 症状 |
  |---|---|---|---|
  | 1 | 対向の片側の INSERT を落とす（`second.event` を一切 INSERT しない） | **赤** 1 failed / 7 passed | 「両側に1件ずつイベントを積む」——`eventsBKinds` が `["updated"]` 期待に対し `[]` |
  | 2 | 同一 ID ガード（`first.id === second.id` → `RangeError`）を丸ごと削除 | **赤** 1 failed / 7 passed | 期待 `RangeError` に対し実際は `MemoryStatusConflictError`（同じ行を2回 CAS して弾かれる別経路） |
  | 3 | second 側の CAS 条件を反転（`!== "active"` → `=== "active"`） | **赤** 1 failed / 7 passed | 正常系なのに `MemoryStatusConflictError: expected status "active" ... but observed "active"` |

  **3本とも、`cp` で退避コピーから戻すと 8 it 全緑に戻ることを毎回実測した。**
  **`git status --porcelain` と `git diff --stat` が空であることも実測した。**

  ### ⭐ 「歯が噛んでいなかった変異」は**出なかった**。それも結論である

  **3本とも、狙った経路で確実に赤くなった。**⟹ **`markContestedPair` の歯は効いていた。
  欠けていたのは実行経路だけだった。**

  ⚠ **これは「失敗」ではない。**Issue #247 は「`packages/postgres` が検証されていない」とは
  言っておらず、「**歯を壊したら赤くなるか**の側だけが見えていない」と言っている。
  本 ADR の測定は、**その側が実際に見えるようになり、見たら噛んでいた**、と報告している。

  ⚠ **変異3で、`it.each` の status-conflict 系4本は緑のままだった。**
  これは歯が噛んでいないのではなく、**多重防御**である——事前チェックを迂回しても
  実 SQL の `UPDATE ... WHERE status = 'active'` が独立に CAS で弾き、
  TOCTOU の読み直し経路が同じ `MemoryStatusConflictError` を投げ直す。
  **⛔ 何か出るまで変異を探し続けることはしなかった。**3本で「赤くなる／戻る」を
  実測できた時点で打ち切っている。

  ### (f) 分類器に止められたもの【実測】

  **DB を触る操作は一度も止められていない。**`initdb` / `pg_ctl start` / `createdb` /
  `psql` / `pnpm install` / `vitest run` は、**専用ポート・専用データディレクトリで
  すべて通った。**

  止められたのは1件だけで、**待ち方の作法**に対するものだった——
  **対象プロセスの生死を条件にした自前のループで、眠りながら終了を待つ書き方**である。
  拒否の理由（逐語）: 「条件が反転するまで待ち続ける形で、相手が先に死ねば
  二度と反転しない（無限待ちの形）」。示された代替のうち
  **「待ちに上限が要るなら `timeout` で自分から終わらせる」**を採って通した。

  ⚠ **本 ADR を書く過程でも、同じ分類器に1回止められた。**
  上の拒否されたコマンドを **ADR 本文に逐語で引用しようとしたところ、
  引用そのものが同じ規則に当たって止められた。**⟹ **本節はコマンドを逐語で載せず、
  何をしようとしたかの記述に留めている。**

  ⚠ **別種の制約も1つ踏んだ**（分類器ではない）: `test:db` 全体を前景で走らせたとき、
  **ツール既定の 120 秒の前景待ち時間**を超えて自動的に背景へ回された。
  **呼び出し自体に上限時間を明示すれば前景を保てる。**
  ⟹ **「背景へ回さない」を守るには、長い検査に明示の上限を付ける必要がある。**

  ⟹ **この器で `packages/postgres` の検証を塞いでいたのは、分類器でも DB の不在でもなく、
  「立てる手順が書かれていなかったこと」だった。**本 ADR はそこを埋める。


  ### (g) ⭐ 副産物 — `scripts/initdb-args-lib.mjs` の「確かめていないこと」を検算した【実測】

  **本 ADR の手順は `initdb --encoding=UTF8 --locale=C` を使う。**
  ところが `scripts/initdb-args-lib.mjs` は、**その組合せを「自己矛盾」と判定する表**を
  持っている（`KNOWN_LOCALE_IMPLIED_ENCODING = { C: "SQL_ASCII" }`）。
  ⟹ **手順を書く前に、どちらが正しいのかを確かめる必要があった。**

  同ファイルの docstring は、その表の根拠についてこう書いている（逐語）:

  > **下の `KNOWN_LOCALE_IMPLIED_ENCODING` 表は、実際に `initdb` を実行して確かめた
  > ものではない。**この器には docker/podman/initdb が無く(`DATABASE_URL` も未設定)、
  > ここで実行して検算することはできなかった。

  **⟹ これは Issue #247 と同じ形の穴である**——「確かめられないから確かめていない」。
  **この器には `initdb` が在るので、検算した。**

  **【実測】2026-09-17、PostgreSQL 17.11 (Debian 17.11-0+deb13u1):**

  | 実行した `initdb` の引数 | 終了コード |
  |---|---|
  | `--encoding=UTF8 --locale=C` | **0（成功）** |
  | `--encoding=SQL_ASCII --locale=C` | **0（成功）** |
  | `--encoding=EUC_JP --locale=C` | **0（成功）** |

  ⟹ 🔴 **`--locale=C` のとき、`initdb` は encoding を選ばない。**
  3つとも通った。**`C: "SQL_ASCII"` という表の行は、`initdb` が要求していることの
  記述としては正しくない。**（PostgreSQL の `C` / `POSIX` ロケールは、
  すべての encoding と両立する。）

  ⟹ **同ファイルの前提（「initdb は選んだ encoding とロケールが含意する encoding の
  整合を検査する——食い違うとコンテナの起動ごと落ちる」）は、`--locale=C` については
  成り立たない。**

  **⚠ ただし、これは `ci.yml` を壊していない。**同ファイル自身が
  「**未知のロケールは挙げる（赤）**」「誤って緑になる向きの取りこぼしではない」と
  書いているとおり、この表の誤りは**安全側（誤って赤）**に倒れる。いまの matrix
  （UTF8 は `--locale=` 無し / SQL_ASCII は `--locale=C`）は両方とも表を通るので、
  **今日の CI は1つも落ちない。**

  **⚠ そして、既定ロケールの行は、この器では検算できない。**
  `DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8"` の根拠は「CI のコンテナの既定ロケールが
  `en_US.utf8`」である。**この器の既定ロケールは `POSIX` である**【実測: `LC_CTYPE="POSIX"`】。
  ⟹ **ここで `--locale=` 無しを測っても、CI のコンテナについて何も言っていない。**
  **確かめていない。**

  **⛔ 本 PR では `scripts/initdb-args-lib.mjs` を1バイトも変えない。**
  **1つの PR は1つの ADR とその実装**（`docs/autonomy.md` §2）であり、
  **「ついでに直す」をしない**という同節の戒めに従う。**別の issue に切る。**

  **⟹ 本 ADR の手順が `--locale=C` を使うのは、実測に基づく選択である**
  （3つの encoding すべてで通り、その上で `test:db` の 546 it が緑になった）。
- **引き受けた負債**:

  1. **この手順は、Postgres のバイナリと pgvector が在る器でしか通らない。**
     **Issue #247 が実測した 2026-09-15 の器では通らない**（バイナリ自体が無かった）。
     ⟹ **Issue #247 を閉じない。**本 ADR は「この器では解けた」を記録するものであり、
     「どの器でも解ける」を主張しない。

  2. **SQL_ASCII の leg（CI matrix のもう1本、ADR 0106）を手元で確認していない。**
     測ったのは UTF8 / locale C のみである。⟹ **手元の緑を CI の緑の代わりにしない**
     という `docs/autonomy.md` §2.1-5 の戒めは、本 ADR の後も生きている。

  3. **`markContestedPair` 以外への変異試験は行っていない。**
     `resolveContestedPair` 等は今回のスコープ外である。

  4. **(c) の28本は塞いでいない。**本 ADR は**数えただけ**である。
     openai / anthropic / local-embedding の live は
     [Issue #142](https://github.com/takecchi/mnemora/issues/142) の領分であり、
     そちらで別に扱う。

  5. **`test:db` を1回しか走らせていない。**フレークの有無は見ていない。

  6. **`scripts/initdb-args-lib.mjs` の表が誤っていることを測ったが、直していない**
     （上の (g)）。**別の issue に切る。**⚠ この誤りは安全側（誤って赤）に倒れ、
     いまの `ci.yml` の matrix は両脚とも通るため、**今日の CI は1つも落ちない。**

- **これが覆るとしたら**:

  - **担い手の器から Postgres のバイナリか pgvector が消えたとき。**
    そのときは「採らなかった案」1（`workflow_dispatch`）へ戻る。
    **この案は費用の理由で退けたのであって、成立しないから退けたのではない**
    ——トークンの `workflow` スコープと `admin: true` は実測済みである。
  - **CI の1周の費用が下がったとき**（Issue #267 の方向1〜3 のどれかが入る等）。
    そのときは案1を足す費用が相対的に軽くなる。
  - **手元の緑と CI の緑がずれる事例が出たとき。**
    本 ADR は「手元で変異試験ができる」ことだけを主張しており、
    **手元の緑を CI の緑の代わりにしてよい**とは一言も言っていない。
    ずれが出たら、その但し書きを強める。

- **確かめていないこと**:

  - **他の担い手の器にバイナリが在るかどうかを確かめていない。**見たのはこの器だけである。
  - **この器の制約が恒久的か一時的かを確かめていない**（Issue #247 の「確かめていないこと」と同じ）。
  - **`max_parallel_maintenance_workers = 0` を適用した場合の挙動差を測っていない**
    （適用不要だったため）。
  - **GitHub Actions の課金換算（ジョブ×分）を見積もっていない。**上の数字は壁時計のみである
    （Issue #267 の「確かめていないこと」と同じ限界）。
  - **変異1〜3以外の壊し方を試していない**（`contested_with_id` を書かない、
    両側の UPDATE を落とす等）。
  - **この器の分類器の他の拒否パターンを網羅していない。**踏んだのは1種類だけである。
  - **alteroid が同じ問題をどう扱っているかを調べていない**（Issue #247 の
    「確かめていないこと」と同じ）。
  - **`initdb-args-lib.mjs` の `DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8"` を検算していない。**
    この器の既定ロケールは `POSIX` であり、CI のコンテナ（`en_US.utf8`）と違う【実測】。
    ⟹ **ここで測っても CI について何も言えない。**

- **歯**（`docs/autonomy.md` §2「歯が実際に噛むことを変異試験で示した」）:

  **本 ADR の変更は `AGENTS.md` の1節のみであり、実行されるコードを1行も足していない。**
  ⟹ **この ADR 自身に対する変異試験は存在しない。**

  **代わりに、本 ADR が可能にした変異試験そのものを上の (e) に記録した。**
  ⟹ **手順が本物かどうかは、その手順で実際に Issue #247 の実害を測ったことで示している。**

- **出所について**:

  - **【受】の部分**（2026-09-15 の器に DB の経路が無かったこと、PR #245 の実害）は
    Issue #247 本文からの引用であり、**書き手は再現していない。**
  - **【実測】の部分**（この器のバイナリ・`test:db` の結果・変異試験3本・分類器の拒否）は
    すべて書き手がこの器で走らせた結果である。
  - **【現物】の部分**（CI の13ジョブ・28 it・変異試験が自動化されていないこと）は
    `main` = `d2f5e40` のコードと workflow を読んで数えた。
