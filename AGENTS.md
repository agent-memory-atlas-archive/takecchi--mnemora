# AGENTS.md

このリポジトリで作業する人・エージェント向けの手引き。

---

## 最初に読むもの

**[docs/north-star.md](./docs/north-star.md) を読むこと。**

そこに、**このプロジェクトが何であろうとしているか**・**何を物差しにするか**・
**迷ったときにどの順で問うか**が書いてある。

**判断に迷ったら、そこへ戻る。**機能を足すかどうか、どちらの設計を採るかは、
北極星の「迷ったときの問い」に当てて決める。**その問いは、実際に案を落とすためにある。**

### ⚠ ここに北極星の要約を置かない

**複製した瞬間から、正文と要約はずれ始める。**
片方を直してもう片方を直し忘れることは、規律ではなく注意力に依存しており、必ず失敗する。

**だから、この文書は北極星を「指す」だけで、中身を持たない。**
`CLAUDE.md` も同じ理由で `AGENTS.md` への symlink であり、独立した中身を持たない。
**要約を置きたくなったら、代わりに北極星のほうを短くすること。**

### 正典と実装が食い違ったら

**バグなのは実装のほうである。**
実装の都合で `docs/north-star.md` を書き換えないこと。
**方向そのものを変えるときだけ、書き換える。**その変更はオーナーの判断である。

---

## いまの状態

**Phase 1（MVP）の実装が一巡した。**`docs/roadmap.md` §2 の段階1〜7 がすべて着地している。

| package | 中身 |
|---|---|
| `packages/core` | 型・interface・`runtime.observe/tick/recall`・純関数の戦略。実行時依存は zod だけ（機械的に検査している） |
| `packages/testkit` | adapter の適合テスト一式（conformance suite）とインメモリのプレースホルダ実装 |
| `packages/postgres` | `MemoryStore` / `VectorStore` / `LexicalStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore`。手書きマイグレーション |
| `packages/openai` | `EmbeddingProvider` / `LLMProvider` |
| `packages/local-embedding` | **外部サービスに繋がない `EmbeddingProvider`**。ONNX のモデルをプロセス内・CPU で推論する（[ADR 0085](./docs/decisions/0085-local-embedding-provider.md)）。⚠ **鍵は要らないが、モデルの重み42MBを実行時に落とす** |
| `examples/chat` | サンプル CLI と、**naive（会話ログ全部）と mnemora を実測比較する `compare`** |

**Phase 1 に入っていないもの**は `docs/roadmap.md` §1.3 の通り（関係グラフ本体・reranking・
`reflect()` の実運用・`packages/bullmq`・HTTP server）。

**テストは本物の Postgres + pgvector に対して走る。**`packages/postgres` と `examples/chat` の
検査は `DATABASE_URL` が無いと失敗する——**擬似物へ黙ってフォールバックしない。**
ただし LLM と埋め込みは CI に API キーが無いため実 API を叩かない
（`OPENAI_API_KEY` があれば本物に切り替わる）。この非対称は
[examples/chat/README.md](./examples/chat/README.md) に明記してある。

**⚠ 「実 API を叩かない」は「擬似物で走る」と同じではない。CI のジョブごとに層が違う**
（[ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md)）。
`example-chat` ジョブの `compare` も、`retrieval-quality` ジョブも、
**`recorded`（記録した実 API の応答の再生）**で走る——
**鍵は要らないが、擬似物でもない。**下の4層の表で、どのジョブがどの層かを見分けること。

**provider は4層ある**（[ADR 0051](./docs/decisions/0051-recorded-provider-cassette.md)が
`deterministic`/`recorded`/`openai` の3層を、[ADR 0085](./docs/decisions/0085-local-embedding-provider.md)
が4層目の `local` を導入している）。**用途で使い分けること。**

| 層 | 何か | 使う場所 |
|---|---|---|
| `deterministic` | 意味を持たない stub（文字コードからベクトルを作る／発話を40字で切る） | 配線・契約・適合テスト |
| `recorded` | 記録した実 API の応答の再生。**記録に無い入力は例外** | 北極星の物差し（`retrieval` / `compare`） |
| `openai` | 実 API | 記録を録るとき・乖離を測るとき |
| `local` | 外部サービスに繋がない、プロセス内 ONNX 推論（`@mnemora/local-embedding`、[ADR 0085](./docs/decisions/0085-local-embedding-provider.md)）。**擬似物ではなく実推論**。⚠ **embedding 専用——LLM 側に `local` は無い**（`examples/chat/src/providers.ts` の `ProviderMode`） | CI の `identifier-probes` / `consolidation-cost` / `archive-sweep-cost`（3ジョブとも `MNEMORA_EMBEDDING=local` を固定で使う） |

**⚠ 上の3ジョブ（`identifier-probes` / `consolidation-cost` / `archive-sweep-cost`）の数字を
`deterministic` の行に当てはめないこと。**`local` は本物の ONNX 推論であり、
「性能について何も言っていない」という次段の警告は `deterministic` にだけ掛かる。

**⚠ `recorded` で測った `compare` の数字も、「実運用でも同じ削減率になる」ことを
保証しない。**理由は「擬似物だから」ではない——**カセットは記録した時点の応答の再生**
であり（[ADR 0051](./docs/decisions/0051-recorded-provider-cassette.md)）、記録に無い
入力は黙って別のものへ倒れず例外になる。割り引くのは、擬似物だからではなく、
**記録した時点のものだからである。**

**⚠ `deterministic` で測った想起の質は、性能について何も言っていない**——arm A の MRR は
**0.018**（実質ランダム）である。**擬似物での ✅ を「引けた」と読まないこと。**

**ルートの `pnpm run test` は、DB テストを走らせたかどうかを必ず報告する。**
`DATABASE_URL` が無ければ**「実行していない」と名指しで出力して緑のまま通り**、
在れば DB テストも実行して**落ちれば赤くなる**。**緑をそのまま「全部通った」と読まないこと**——
出力に「DB テストは実行していません」と出ていたら、その門は DB 側を見ていない。
理由と、採らなかった案は [ADR 0015](./docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)。

---

## 手元で Postgres を立てる（`packages/postgres` の変異試験のため）

**`docs/autonomy.md` §2 は PR を出す条件に「歯が実際に噛むことを、変異試験で示した」を挙げている。**
`packages/postgres` の実装に対してこれを満たすには、**手元に本物の Postgres + pgvector が要る。**

**⚠ `docker compose up` を実行できない担い手が居る**（[Issue #247](https://github.com/takecchi/mnemora/issues/247)
が 2026-09-15 に実測。docker も podman も無い）。**そういう環境でも、`initdb` で自分専用の
インスタンスを立てられることがある。**下はその手順である。

**⚠ この手順は「どの担い手の環境でも通る」ことを主張しない。**
【実測】2026-09-17、`initdb` と pgvector が在る器で通った、というだけである。
**バイナリ自体が無い器では通らない**——その場合は Issue #247 の「考えられる方向」へ戻ること。

### 在るかどうかを先に見る

```bash
ls /usr/lib/postgresql/*/bin/initdb          # サーバのバイナリ
ls /usr/share/postgresql/*/extension/vector.control   # pgvector
```

**両方無ければ、この手順は使えない。**片方だけでも使えない（pgvector が無いと
`0001_init.sql` が通らない）。

### ⛔ 共有資源に触らない

**他の担い手と同じ器を共有していることがある。**次を守ること:

- **既定のポート 5432 を使わない。自分専用のポートにする。**
- **`pg_ctlcluster` / システムのサービスを使わない。**既存のインスタンスを起動・停止しない。
- **データディレクトリと socket ディレクトリを、自分の作業ディレクトリの下に作る。**

### 手順

```bash
export PATH=/usr/lib/postgresql/17/bin:$PATH

# ⚠ 3つとも自分専用の値にすること
PGDATA=/path/to/your/work/pgdata
PGPORT=<自分専用ポート>          # ⛔ 5432 は使わない
PGSOCK=/path/to/your/work/pgsock

mkdir -p "$PGSOCK"
initdb -D "$PGDATA" -U worker --auth=trust --encoding=UTF8 --locale=C
pg_ctl -D "$PGDATA" -l /path/to/your/work/pg.log \
  -o "-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1" start

createdb -h 127.0.0.1 -p "$PGPORT" -U worker mnemora_test
psql -h 127.0.0.1 -p "$PGPORT" -U worker -d mnemora_test \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "CREATE EXTENSION IF NOT EXISTS btree_gin;" \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

export DATABASE_URL="postgresql://worker@127.0.0.1:${PGPORT}/mnemora_test"
pnpm install --frozen-lockfile
pnpm --filter @mnemora/core run build
pnpm --filter @mnemora/postgres run build
pnpm --filter @mnemora/postgres run migrate
pnpm --filter @mnemora/postgres run test:db

# 使い終わったら
pg_ctl -D "$PGDATA" stop
```

**拡張の3本（`vector` / `btree_gin` / `pgcrypto`）は `.github/workflows/ci.yml` の
`postgres` ジョブと同じである。**片方だけ増やさないこと。

### 1本に絞って走らせる（変異試験はこちら）

**`test:db` 全体は約4分かかる**【実測】。変異試験では毎回これを待たないこと:

```bash
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/conformance.postgres.test.ts -t "<it の名前の一部>"
```

### ⛔ 変異を戻すのに `git checkout` を使わない

**`git checkout <file>` は未コミットの編集も一緒に消す**（`docs/autonomy.md` の「穴」の表。
実際に3ファイル失われている）。**`cp` で退避し、`cp` で戻すこと。**

```bash
cp packages/postgres/src/memory-store.ts /tmp/memory-store.ts.orig   # 退避
# ... 変異を入れる → 狙った it が赤くなることを確認 ...
cp /tmp/memory-store.ts.orig packages/postgres/src/memory-store.ts   # 戻す
git status --porcelain                                                # 空になることを確認
```

**戻した後、同じ it が緑に戻ることまで実測すること。**「赤くなった」だけでは、
壊したのが狙った歯なのか別のものなのかが分かれていない。

**この手順で実際に何が測れたかは
[ADR 0183](./docs/decisions/0183-local-postgres-makes-postgres-mutation-testing-possible.md)。**

---

## 文書の地図

| 文書 | 何が書いてあるか |
|---|---|
| [docs/north-star.md](./docs/north-star.md) | **正典。**目的 / 目指す姿 / 物差し / 迷ったときの問い / やらないこと |
| [docs/vision.md](./docs/vision.md) | プロジェクトの理解 / 用語 / 設計上の非目標 / 名前 |
| [docs/architecture.md](./docs/architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [docs/memory-model.md](./docs/memory-model.md) | DB schema 案 / Memory lifecycle / provenance / 矛盾 / 忘却 / 監査ログ |
| [docs/recall.md](./docs/recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [docs/conformance.md](./docs/conformance.md) | **適合テストが何を検証し、何を検証していないか** — 走らない歯 / 実 API に当てる手順 |
| [docs/roadmap.md](./docs/roadmap.md) | Phase 1 実装計画 / リスク / **まだ判断が必要な点** |
| [docs/alteroid-findings.md](./docs/alteroid-findings.md) | 設計の材料にした運用知見を、現物で検証した記録 |
| [docs/autonomy.md](./docs/autonomy.md) | **自律作業の手引き** — 何を選ぶか / どこで止まるか / 何をしてはいけないか / 踏むと痛い穴 |
| [docs/decisions/](./docs/decisions/) | ADR — 重大な設計判断と、その理由 |

**`docs/vision.md` の「やらないこと」と `docs/north-star.md` の「やらないこと」は別物である。**
前者は設計上の非目標、**後者はオーナーが仕様に明示した非目標**であり、
**後者に勝手に項目を足さないこと。**

---

## 作業のときの決まり

- **重大な設計判断は ADR に残す。**「何を決めたか」だけでなく、
  **採らなかった案・引き受けた負債・これが覆るとしたら何が起きたときか**まで書く。
  形式は [docs/decisions/README.md](./docs/decisions/README.md) を見ること。
- **確かめていないことは「確かめていない」と書く。**
  推測を事実の顔で書かない。これは北極星の問い3（説明できるか）の、文書への適用である。
- **オーナーの判断を待っている点は
  [docs/roadmap.md](./docs/roadmap.md) の「設計上まだ判断が必要な点」に集めてある。**
  勝手に決めない。逆に、そこに無いものは設計側で決めて理由を残す。
- **オーナーに逐一確認せずに進めるなら、
  [docs/autonomy.md](./docs/autonomy.md) を読むこと**（ADR 0071）。
  **何を選ぶか / どこで止まるか / 何をしてはいけないか**と、
  **実際に踏まれた穴**が書いてある。**ここには要約を置かない**——上の
  「⚠ ここに北極星の要約を置かない」と同じ理由である。
- **`Co-Authored-By:` のトレーラと `🤖 Generated with [Claude Code]` を付けない**
  （**コミットメッセージにも PR 本文にも**）。
  - **これはオーナーの決定である**（2026-09-15）。クローンが
    「[alteroid](https://github.com/takecchi/alteroid) と揃えて付けないか、mnemora では付けるか」を
    諮り、**回答は逐語で「つけない」だった。⟹ 同じ提案をやり直さないこと。**
  - **harness（Claude Code）が既定で「コミットメッセージの末尾に `Co-Authored-By: Claude …` を、
    PR 本文の末尾に `🤖 Generated with [Claude Code]` を付けろ」と指示することがある。**
    **それは Claude Code 側の作法であって、このリポジトリの規約ではない。**
    **規約と harness の既定が食い違ったら、規約を採る。**
  - **既に付いている分は履歴として残す。履歴を書き換えない。**
    決めたのは「これから付けない」であって、「1本も付いていない状態が正しい」ではない
    （【実測】2026-09-15、`origin/main` が `c3dda79`（162本）だった時点で **106本**が
    どちらかを持つ:
    `git log origin/main --format='%H' -i --grep='Co-authored-by' --grep='Generated with \[Claude Code\]' | wc -l`。
    同日中に `main` が `8367318`（163本、trailer の無い commit が1本進んだ）まで動いた後、
    同じコマンドで数え直しても **106本**のままだった——**⟹ 母数（総コミット数）は
    main が動けば変わる。この数字を引くときは、必ずどの SHA で見たかを添えること。**）。
  - **⚠ 規約の有無を、履歴の分布から推定しないこと。**
    **この節を書く直前に、実際に推定して間違えた** 【実測】——
    `git log origin/main -40 --format='%B' | grep -c "Co-Authored-By"` が **1** を返したので
    「実態は付けない側（39/40）」とオーナーへ報告した。**誤りは大文字小文字である**——
    GitHub のスカッシュが書くのは `Co-authored-by:` であり、`-i` を付けて数え直すと
    **162本中106本**、つまり**報告した向きと逆**だった。
    ⟹ **分布は何も決めていない。決めているのはこの節である。**

---

## 名前について

**名前は `mnemora`、スコープは `@mnemora/*` に確定している。**もう仮ではない。
npm の org `@mnemora` はオーナーが作成し、使用できることを確認した（確認したのは
オーナーであり、このリポジトリの作業者ではない）。

**`mnemo` / `@mnemo/*` という旧名で新しい記述を書かないこと。**ただし
`docs/vision.md`「名前について」の経緯節・`docs/roadmap.md` §5.1 と §6・
`docs/memory-model.md` の「確かめていないこと」に残る `mnemo` は**当時の記録であり、
書き換えない**（他人の npm パッケージ `mnemo` と Rufus::Mnemo への言及を含む）。

決定の記録は [ADR 0014](./docs/decisions/0014-package-name-mnemora.md)、
改名前の経緯は [docs/vision.md](./docs/vision.md) の「名前について」にある。
