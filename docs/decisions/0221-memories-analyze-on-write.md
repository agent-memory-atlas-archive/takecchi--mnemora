# ADR 0221: `PostgresMemoryStore` の書き込み経路が閾値越えのときだけ `memories` を `ANALYZE` する — ADR 0194 と同じ設計を、JOIN の相手側にも入れる（Issue #269）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける。** 【実測】＝私がこの作業環境で自分の手で実行して確かめた。
【現物】＝このリポジトリのコードを自分で読んだ。【受】＝別の作業者（Issue #269 / #418 の
本文・コメント）が測定した内容——私自身は当時その環境を再現していない。ADR 0170/0173/0175/
0194 と同じ体裁に揃える。

---

## 結論

**ADR 0194 が `memory_embeddings_*` に入れた「書き込み経路からの自動 ANALYZE」と同じ形を、
同じ JOIN の相手側である `memories` にも入れた。**

`PostgresMemoryStore` が `memories` へ新しい行を実際に書き込むたびに、**このプロセスが
書いた行数**をテーブル単位で数える（`memories` は固定の1テーブルなので実質1エントリ）。
累計が等比の閾値（1,000 / 2,000 / 4,000 / …、`INITIAL_ANALYZE_THRESHOLD` はADR 0194 と
同じ値・同じ定数を再利用）のちょうどに達したときだけ `pg_class.reltuples` を1回読み、
それがこのプロセスの書いた行数より小さければ `ANALYZE memories` を撃つ。

- 新規ファイル `packages/postgres/src/memories-statistics.ts`（`memories` 専用の薄い
  ラッパー）。
- 新規ファイル `packages/postgres/src/analyze-threshold.ts`（ADR 0194 の
  `embedding-statistics.ts` から「カウンタ→閾値判定→reltuples guard→ANALYZE」の核を、
  対象テーブル名に依存しない形で括り出したもの——`embedding-statistics.ts` と
  `memories-statistics.ts` の両方がここに委譲する。下の「置き場所の設計判断」参照）。
- `packages/postgres/src/memory-store.ts` の `createMemory` / `createMemoryWithOutbox` の
  末尾で、実際に新しい行を書いたときだけ呼ぶ。

## ⭐ この PR が主張する1文

**ADR 0194 が `memory_embeddings_*` に入れた「書き込み経路からの自動 ANALYZE」と同じ形を、
同じ JOIN の相手側である `memories` にも入れる。** これ以外の変更は含まない
（`docs/autonomy.md` §2「ついでに直さない」）。

---

## 背景（【受】——Issue #269 / #418 の測定・棚卸し）

- Issue #360 / ADR 0194（PR #406）が `memory_embeddings_*` を `ANALYZE` する production
  経路の欠如を塞いだ。ただし ADR 0194 自身が「本 PR は『採用者が350倍遅い想起を踏まなく
  なる』ことを保証しない」と明記し、`memories` 側の統計欠如を「引き受けた負債」2番として
  残していた——`PostgresVectorStore.search()` は埋め込み表を `memories` と `JOIN` して
  テナントで絞るため、埋め込み表側の統計が正しくても `memories` 側の統計が実態からずれて
  いればプランナは HNSW を検討しない。
- **この負債は CI 自身が実測で教えた**（ADR 0194「CI が実際に教えたこと」節）: 使い捨て
  データベース（`memories` に一度も `ANALYZE` が走らない）で、埋め込み表側の統計だけを
  守る歯が `pgvector/pgvector:pg17` で赤くなった——プランナが `memories` 側の行数を
  見誤り、Nested Loop を選んだ。
- Issue #269 が本件を起票し、後に Issue #418（重複、統合済み）が独立に同じ穴を実測した。
  #418 の実測（自分専用の Postgres 17.11 + pgvector 0.8.0、`autovacuum_enabled=false` で
  `memories` の autovacuum を切った陽性対照）:

  | 行数           | `ANALYZE memories` 前                | 後                    | 差     |
  | -------------- | ------------------------------------ | --------------------- | ------ |
  | 4,000          | Nested Loop（誤選択、中央値 10.1ms） | HNSW（中央値 0.89ms） | 約11倍 |
  | 6,000〜100,000 | HNSW                                 | HNSW                  | 差なし |

  ⟹ **4,000行程度の小規模では実害があるが、100,000行（Issue #360 と同規模）では
  autovacuum を完全に切っても差が消える**——境界のある現象。

- #269 本文は、着手する人が最初にやるべきこととして「**方向3（autovacuum に任せる）が
  成立するかを先に測ること**」を名指しし、#418 のコメントは「**autovacuum の実挙動は、
  今回も測っていない**」（#418 の陽性対照は autovacuum を無効化した状態でしか測っていない）
  と明記していた。**⟹ 本 ADR がこの空白を埋める（下の「測定」節）。**

---

## 測定（【実測】——私がこの作業環境で実行した）

### 環境

- 自分専用の PostgreSQL 17（`/usr/lib/postgresql/17/bin`）+ pgvector を `initdb` で
  作業ディレクトリ配下に構築（`AGENTS.md`「手元で Postgres を立てる」節どおり。
  ポートは自分専用の `55269`、5432 は未使用）。
- autovacuum の設定は **完全に既定値のまま**（`autovacuum=on` /
  `autovacuum_naptime=60s` / `autovacuum_analyze_threshold=50` /
  `autovacuum_analyze_scale_factor=0.1`）——`.github/workflows/ci.yml` の `postgres`
  ジョブもチューニングしていないので、比較可能な設定のはず（#418 の担当者も同じ注記を
  残している。ただし CI の Docker イメージそのもので実測してはいない——下の
  「確かめていないこと」参照）。
- 投入は**本番と同じ経路**（`PostgresMemoryStore.createMemory()` → `PostgresVectorStore.upsert()`
  を1行ずつ）で、`memories` の autovacuum は**無効化しない**（#418 が無効化していたのと
  逆——本 ADR が測りたいのはまさに「autovacuum を切らずに任せたらどうなるか」）。
- 4,000行（#418 が陽性対照を取ったのと同じ規模）を1テナントに投入し、100行ごとに
  「その時点の `pg_class.reltuples` / `pg_stat_user_tables.last_autoanalyze`」と
  「段1 ANN クエリ(埋め込み表を `memories` と `JOIN` する、`search()` と同じ形)の
  実行時間・EXPLAIN の先頭行」を記録した。

### 結果1（1回目、行単位サンプリング無し）

投入(47.1秒)完了時点で、既に `last_autoanalyze` が入っており(`reltuples=1159`)、
`search()` 相当のクエリは HNSW を選んでいた——**投入完了までに、autovacuum が
一度だけ先回りして拾っていた**。

### 結果2（2回目、100行ごとにサンプリング）

- `reltuples=0`(migrations の `ANALYZE memories`。表が空の時点のもの、ADR 0143)の
  まま、行100〜300では `search()` 相当のクエリが Nested Loop（誤選択）を選び続けた。
- **行400(投入開始から 7.3秒)で最初の autoanalyze が発火**（`reltuples` が 369 に
  更新）。ただしこの時点ではまだ `search()` 相当のクエリは HNSW を選ばず
  （行400〜600 は依然 Nested Loop）、**行700(12.9秒)でようやく HNSW に安定した**。
- 以降 4,000行まで `reltuples=369` のまま(投入中に2度目の autoanalyze は起きな
  かった)だが、HNSW は選ばれ続けた——**大きくずれた（369 対 実態4,000、約11倍の
  過小評価）統計でも、いったん「0ではない」状態になれば選択は安定する**ことを示す。
- 投入完了後、**8.1秒後**に次の autoanalyze が発火し `reltuples=4000` に正確化した。

### 結果3（3回目、100行ごとにサンプリング、同条件で再実行）

- **`reltuples=0` のまま、行100から行3800(投入開始から 58.9秒——投入完了(62.8秒)の
  直前)まで、`search()` 相当のクエリは一度も HNSW を選ばなかった。**
- この間、クエリの実測時間(クライアント側の往復時間)は行を追うごとに悪化した:

  | 行数 | 経過(投入開始から) | クエリ時間                                     | EXPLAIN 先頭行(要旨)          |
  | ---- | ------------------ | ---------------------------------------------- | ----------------------------- |
  | 100  | 1.7秒              | 4.89ms                                         | `rows=1`(誤推定)、Nested Loop |
  | 300  | 5.4秒              | 33.35ms                                        | 同上                          |
  | 600  | 11.9秒             | **137.30ms**（`actual time=134.420..134.425`） | 同上                          |
  | 3800 | 59.9秒             | 13.63ms                                        | 同上(誤推定のまま)            |
  | 3900 | 61.3秒             | 2.29ms                                         | **HNSW に切り替わった直後**   |
  | 4000 | 62.8秒             | 2.45ms                                         | HNSW                          |

  **⟹ 壊れている間、クエリは健全時（2〜4ms 前後）の約30〜60倍まで遅くなった**
  （行600の137.30ms、実測の中では最悪値）。これは #418 が autovacuum を完全に
  無効化した陽性対照で測った「約11〜30倍」と同じ桁か、それを上回る。

- **最初の autoanalyze は行3900(投入開始から61.3秒)まで発火しなかった**
  ——2回目の実測(7.3秒)と 3回目の実測(61.3秒)の差は、**同一の既定設定・同一の
  投入パターンでも、8倍以上開いた**。
- 投入完了後、177秒(約3分)ポーリングしても追加の autoanalyze は発火しなかった
  ——ただし `reltuples=3865` は実態4,000に対して約3.4%のずれに留まっており、
  autovacuum 自身の判定（`50 + 0.1 * reltuples` を超える変更が無ければ再analyze
  しない）では「十分」と判断された結果であり、プラン自体は既に HNSW で安定して
  いた。

### この測定が言っていること

- 🔴 **壊れる側（症状が出る）と直る側（ANALYZE 後は HNSW）の両方を実測した**
  （結果3が壊れる側、結果2・3の autoanalyze 後がいずれも直る側）。
- **autovacuum を既定のまま有効にしておいても、初回の大量投入直後の窓は消えない。**
  窓の長さは**同一設定・同一投入パターンでも 7秒から 61秒まで大きくばらついた**
  （3回中、1回目は投入完了までに拾われ実害が見えず、2回目は7.3秒で拾われ実害が
  小さく、3回目は投入のほぼ全体（59秒）で壊れたままだった）。
- **この変動は「autovacuum が遅い」ではなく「autovacuum の周期は書き込みバーストと
  無関係に回っている」ことに由来すると考えられる**（推論。autovacuum launcher は
  `autovacuum_naptime` ごとに全データベースを巡回する設計であり、たまたま巡回が
  投入開始の直後に来るか直前を過ぎたばかりかで、初回発火までの待ち時間が
  `[0, naptime]` の範囲でほぼ一様にばらつく、という説明と整合する——ソースコードで
  検証してはいない）。
- ⟹ **「窓が残る」と判断した。** #269 の判断基準（4節）に従い、実装（方向2）へ進む。

### この測定の裏取り（対照実験の質）

- 「壊れる」条件(結果3)と「直る」条件(結果2・3のANALYZE後、および下の「変異試験」)を
  **同じスクリプト・同じ手法**で連続して測った——症状が出ないことを何度積んでも
  証明にならない、という指摘（#269 本文）どおり、**実際に壊れる実行を再現できたこと**
  が根拠になっている。
- 3回とも独立した使い捨てデータベース（`dropdb`/`createdb` からやり直し）で測った
  ——前の実行の統計・autovacuum の巡回位相を引き継いでいない。

---

## 現物を読んだ（出所: 私がこの環境で読んだ）

- `packages/postgres/src/vector-store.ts` の `search()`: 埋め込み表を `memories`
  （エイリアス `m`）と `JOIN` してテナント・status 等で絞る。`ORDER BY` は距離演算子を
  そのまま置く規約（docs/memory-model.md §10）。
- `packages/postgres/src/embedding-statistics.ts`（ADR 0194、本 PR 前）: 「カウンタ→
  閾値判定→reltuples guard→ANALYZE」の実装。`maybeAnalyzeAfterUpsert(db, space)` が
  `PostgresVectorStore.upsert` の末尾から呼ばれる。
- `packages/postgres/src/memory-store.ts`: `createMemory` は単発の `INSERT ... ON
CONFLICT ... DO NOTHING RETURNING *`。`createMemoryWithOutbox` は同じ INSERT を
  `this.db.transaction(...)` の中で行い、`outbox` へジョブ行も書く。**`packages/core`
  の `runtime.ts` は `createMemoryWithOutbox` だけを呼ぶ**（`extract`/`consolidate`/
  `reflect` いずれも）——`createMemory` を直接呼ぶのはテスト・フィクスチャのみ
  （`grep -rn "memoryStore\.createMemory(" packages/core/src/runtime.ts` はヒット0件）。
  ⟹ 実運用の書き込みは `createMemoryWithOutbox` 経由だが、`MemoryStore` インターフェース
  を直接使う採用者（`packages/core` を経由しない使い方）のために `createMemory` にも
  同じ仕組みを入れた。
- `packages/postgres/migrations/0005_analyze_memories.sql` / `0015_decay_activity_clock.sql`:
  いずれも `memories` が空の時点で走る `ANALYZE`（ADR 0143 の構造的理由）——新規
  インストールでは効かない。`--analyze-memories`（ADR 0143）は opt-in。

---

## 置き場所の設計判断（`analyze-threshold.ts` を新設した理由）

`embedding-statistics.ts`（ADR 0194）が持っていた「カウンタ→閾値判定→reltuples guard→
ANALYZE」のロジックは、**対象テーブル名を知らなくても成立する**（テーブル名は呼び出し側が
渡す文字列でしかなく、ロジック自体はテーブルの中身に依存しない）。この核を
`packages/postgres/src/analyze-threshold.ts` に括り出し、`embedding-statistics.ts` と
新規の `memories-statistics.ts` の両方がそこへ委譲する形にした。

**検討した代替案**:

1. **`embedding-statistics.ts` の `maybeAnalyzeAfterUpsert` にテーブル名を渡せる
   オーバーロードを足す。** 却下: この関数は `EmbeddingSpaceId` からテーブル名を導出する
   ことが前提になっており（`assertSafeIdentifier(embeddingSpaceTableName(space))`）、
   `memories` のような固定テーブル名を渡すには結局この関数の外側でテーブル名解決を
   分岐させる必要がある——本質的には核だけを括り出すのと同じ作業量になり、
   `embedding-statistics.ts` というファイル名の意味（「埋め込み表の統計」）が
   `memories` の話まで抱えることになって読みにくくなる。
2. **`memories-statistics.ts` に、`embedding-statistics.ts` の実装をコピーしてテーブル名
   だけ書き換える（同形の薄いモジュールを足す）。** 却下: `isGeometricAnalyzeThreshold` /
   `readReltuples` / ANALYZE 実行の3つのロジックが完全に重複する。閾値の仕組みを
   将来変えるとき（「これが覆るとしたら」参照）、2箇所を同時に直す規律に依存することになる
   ——`AGENTS.md` が名指しで退けている形（「規律ではなく注意力に依存しており、必ず
   失敗する」）そのもの。
3. **採用: 核を `analyze-threshold.ts` に括り出し、両ファイルは「テーブル名をどう
   決めるか」と「カウンタをどこに persist するか」だけを持つ薄いラッパーにする。**
   `embedding-statistics.ts` の既存公開 API（`INITIAL_ANALYZE_THRESHOLD` /
   `isGeometricAnalyzeThreshold` / `maybeAnalyzeAfterUpsert` /
   `resetEmbeddingUpsertCountersForTesting` / `MaybeAnalyzeAfterUpsertResult`）は
   1つも変えていない——**この PR が ADR 0194 の振る舞いを変えていないことは、
   `embedding-statistics.test.ts`（単体、12本）と `embedding-statistics.postgres.test.ts`
   （DB、2本）が本 PR のコミット後も無修正のまま全緑であることで確認した。**

---

## 呼び出し元にした場所（`memory-store.ts`）

- `createMemory`: `INSERT ... RETURNING *` が実際に行を返した（`inserted.rows.length > 0`）
  ときだけ `maybeAnalyzeMemoriesAfterWrite` を呼ぶ。ON CONFLICT で既存行を返しただけの
  呼び出し（新しい行を書いていない）はカウントしない——`vector-store.ts` の `upsert`
  （呼ばれれば常に書き込む）とはこの点で異なる。
- `createMemoryWithOutbox`: `this.db.transaction(...)` の**外側**で、`result.created`
  が真のときだけ呼ぶ。トランザクションの中で呼ばない理由: `ANALYZE`（`VACUUM` と違い）は
  トランザクションブロックの中でも実行できるが、そのままだとトランザクションが保持する
  行ロックと `ANALYZE` の `ShareUpdateExclusiveLock`（ADR 0143 決定3）を無用に長く
  重ねることになる——トランザクションが commit するまで `ANALYZE` の効果も他接続からは
  見えないので、トランザクションの外側で呼んでも正しさは変わらない。

---

## 増やす費用（正直に書く。ADR 0194 と同じ構造）

- 閾値を跨いだときだけ `pg_class` を1回読む（プロセスあたり高々 log₂(n) 回）。
  それ以外の書き込みはカウンタの加算だけ。
- 統計が本当に遅れているときだけ `ANALYZE` が走る。その費用は**本 PR では測っていない**
  （ADR 0194 も同様の注記——Issue #360 の実測を借りているだけで自分では測り直して
  いない、というのと同じ立場）。
- `ANALYZE` は `ShareUpdateExclusiveLock` を取る——通常の読み書きとは競合しないが、
  同じ表への `ANALYZE` 同士は直列化する。
- プロセスが再起動するとカウンタが0に戻る／複数プロセスが並行して書くとそれぞれが
  自分のカウンタで判定する——ADR 0194 と同じ取引（「増やす費用」節、そのまま踏襲）。
- **`ANALYZE` の失敗は書き込みの失敗になりうる。** `maybeAnalyzeMemoriesAfterWrite` は
  例外を握り潰していない。ADR 0194 の「引き受けた負債」5番と同じ判断・同じ理由
  （実行時のロールが表の所有者でない場合は PostgreSQL が WARNING に留める、という
  文書上の挙動があるが、本 PR ではその経路を実際に走らせて確かめていない）。

---

## 採らなかった案

### 案A: 何もしない（autovacuum に任せる、#269 本文の方向3）

**却下。** 上の「測定」節のとおり、既定設定の autovacuum は窓を閉じない——同一条件で
7秒から61秒まで発火タイミングがばらつき、悪い場合は投入のほぼ全体（59秒）にわたって
段1 ANN が健全時の約30〜60倍遅いままだった。**「症状が出ないことがある」（1回目・2回目の
軽微なケース）は「原因が無い」ことを証明しない**——3回目で実際に壊れる実行を再現できた
ことが、この却下の根拠である。

### 案B: `runAnalyzeMemories`/`--analyze-memories` を新規インストール手順に強く位置づける

（opt-in のまま）

**落とさない。が、本 PR ではやらない。** ADR 0194 が案②として同じ理由で落としたのと同じ
——opt-in は「採用者が呼ぶことを覚えている」ことに依存し、`AGENTS.md` が名指しで退けている
形そのもの。⚠ **`PostgresMemoryStore.createMemory`/`createMemoryWithOutbox` を経由しない
書き込み**（mnemora の外で直接 SQL を投入する採用者）には本 PR は届かない——この場合は
`--analyze-memories` しか効かない。「これが覆るとしたら」に明記する。

### 案C: `packages/core` 側（`runtime.tick()` 等）で閾値を見て撃つ

**却下。** #269 本文の「方向1」に相当し、本文自身が「core が `MemoryStore` の実装詳細
（Postgres の統計）に手を伸ばす形になりうる」と懸念していたとおり——層の設計を壊す。
ADR 0194 が同じ理由（案③）で `packages/core` に触れることを避けたのと同じ判断。
**本 PR は `packages/core` に一切触れていない**（`git diff --stat` で確認できる）。

### 案D: `registerEmbeddingSpace` 相当の、`memories` テーブル単位の

`autovacuum_analyze_scale_factor`/`threshold` のチューニング

**検討していない。** ADR 0194 の案⑤がほぼ同じ発想（埋め込み表側）を検討して却下して
おり（初回の窓は `autovacuum_naptime` が下限になるため縮まらない、統計のずれとプラン
選択は別問題）、`memories` 側で条件が変わる理由が無いため、同じ結論になると判断し
時間を使わなかった。**これは検討して却下したのではなく、類推で省略した**——もし
`memories` 固有の事情でこの前提が崩れるなら、別途検証が要る。

---

## 変異試験（【実測】。すべて `cp` で退避・復元し、`git checkout` は使っていない）

**核のロジックは `analyze-threshold.ts` に在る**（上の「置き場所の設計判断」参照。
`embedding-statistics.ts` と共有）ので、変異はそこに入れた。

**退避**: `cp packages/postgres/src/analyze-threshold.ts /tmp/mnemora-mut-269/analyze-threshold.ts.orig`

**変異A**（`ANALYZE` を撃つ行をコメントアウトし、`analyzed: true` を返すだけのダミーに
する——`maybeAnalyzeTableAfterWrite` 末尾の `await db.execute(sql\`ANALYZE ...\`)` を消す）:

```
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/memories-statistics.postgres.test.ts -t "甲"
```

→ **1 failed | 1 skipped**(`AssertionError: expected 'Limit (cost=115.94..115.97
rows=10 w…' to match /Index Scan.*using idx_memory_embeddin…/` —— HNSW が選ばれず、
`Bitmap Heap Scan on memories`(誤推定 `rows=10`)経由の Nested Loop のままだった)。
(甲)が実際に赤くなることを実測した。

`cp /tmp/mnemora-mut-269/analyze-threshold.ts.orig packages/postgres/src/analyze-threshold.ts`
で復元 → `diff` で元の内容と1バイトも違わないことを確認 → 同じコマンドで
**1 passed | 1 skipped** に戻ることを実測した。

**変異B**（`reltuples !== undefined && reltuples >= count` の guard をコメントアウトし、
常に `ANALYZE` を撃つ）:

```
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/memories-statistics.postgres.test.ts -t "乙"
```

→ **1 failed | 1 skipped**(`AssertionError: expected 2026-09-17T08:25:44.324Z to
deeply equal 2026-09-17T08:25:37.552Z` —— guard が無いため `createMemory` を
1,000回呼んだだけで `last_analyze` が動いてしまった)。(乙)が実際に赤くなることを
実測した。

`cp` で復元 → `diff` で1バイトも違わないことを確認 → 同じコマンドで
**1 passed | 1 skipped** に戻ることを実測した。

**2本の変異それぞれについて `git status --porcelain` が空になることを確認した。**

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**無関係。** 統計情報の更新タイミングであり、recall が毎回渡す量には影響しない。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `maybeAnalyzeMemoriesAfterWrite` が一度も `ANALYZE` を撃たなくても
（閾値に一度も達しない小規模な運用）、`createMemory`/`createMemoryWithOutbox` は
変わらず動く——遅いだけで `omitted`/エラーにはならない。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** ANN の統計情報はプランナの内部状態であり、recall の trace には現れない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。**

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** `ANALYZE` は SQL 1文であり、LLM を一切呼ばない。閾値判定も純粋な算術。

---

## 引き受けた負債

1. **mnemora の外で直接 SQL で `memories` へ大量投入する採用者には、この対処は届かない。**
   カウンタは `PostgresMemoryStore.createMemory`/`createMemoryWithOutbox` を通った行しか
   数えない。ADR 0194「引き受けた負債」1番と同じ形の負債——`runAnalyzeMemories`/
   `--analyze-memories`（ADR 0143）が引き続きその採用者の唯一の手段になる。
2. **カウンタはプロセスローカルである。** プロセスが再起動すると0に戻り、閾値の確認が
   一巡だけ余計に走る（`reltuples` の guard が在るので `ANALYZE` 自体は撃たれない）。
   複数プロセスが並行して書くと、それぞれが自分のカウンタで判定するため `ANALYZE` が
   重複して撃たれうる（害は無い——直列化されるだけという**推論**。ADR 0194 と同じ
   立場で、確かめてはいない）。
3. **`memories` は `createMemory`/`createMemoryWithOutbox` 以外からも更新される**
   （`updateStatus`/`reinforce`/`archiveDecayed` 等、行数を増やさない UPDATE 系の操作）。
   本 PR はこれらを一切数えない——`memories` の**行数**が増えたときだけを対象にした
   設計であり、既存行の更新頻度が高いテナントで統計が古びる別の経路（decay や
   status 遷移が row estimate に影響するほど分布を変える場合）は、本 PR の範囲外の
   ままである。
4. **ANALYZE の費用を本 PR では測っていない。** ADR 0194 が Issue #360 の実測
   （100,000行 388ms）を借用したのと同じ立場を踏襲しているが、`memories` は
   埋め込み表よりカラム数が多く幅も広いため、同じ数字が当てはまるとは限らない。

---

## これが覆るとしたら

1. **`ANALYZE` のロックが実運用の書き込みスループットで問題になったとき。** そのときは
   閾値を上げるか、`ANALYZE` を別の接続・別のタイミングへ逃がす設計に作り直す。閾値は
   `analyze-threshold.ts` の `INITIAL_ANALYZE_THRESHOLD` 1箇所に集めてあり、
   `embedding-statistics.ts` / `memories-statistics.ts` の両方がそこから読む——
   変えるのは1箇所でよい。
2. **`memories` の UPDATE 系操作（decay・status遷移）が row estimate を大きく動かすと
   分かったとき。** そのときは「行数」ではなく「変更行数」（INSERT+UPDATE+DELETE）を
   数える設計に作り直す必要がある——PostgreSQL 自身が `pg_stat_user_tables.n_mod_since_analyze`
   として持っている値に近い設計変更になる。
3. **複数プロセスの重複 `ANALYZE` が実運用で問題になると分かったとき。** プロセス間協調
   （advisory lock 等）を足す必要が出る——ADR 0194 が意図的に見送ったのと同じ判断を、
   本 PR も踏襲しているだけであり、再検討の余地は残る。

---

## 確かめていないこと

- **CI の Docker イメージ（`pgvector/pgvector:pg17`）そのもので autovacuum のタイミングを
  測ってはいない。** 手元の apt 版 PostgreSQL 17 + `initdb` でのみ測った。設定値
  （`SHOW autovacuum_naptime` 等）は既定値どうしで一致することを確認したが、**Docker
  コンテナの CPU・I/O 特性（CI ランナーの負荷変動）が実際のタイミングにどう効くかは
  分からない**。
- **本番相当の負荷**（多数のテーブル・テナント・データベースが同じ autovacuum launcher の
  対象になっている状態）での窓の長さは測っていない——今回はこのインスタンスに
  `mnemora_test` 1つしか存在せず、autovacuum は他に何も世話をしていない、**最も有利な
  条件**だった。それでも窓が最大61秒（3回目）まで開いたことは、本番でこの窓がさらに
  長くなりうる可能性を排除しない。
- **なぜ2回目(7.3秒)と3回目(61.3秒)でこれほど差が出たかの正確な機序**（autovacuum
  launcher の巡回位相という推論は述べたが、PostgreSQL のソースコードで検証していない）。
- **`ANALYZE memories` 自体の費用**（実行時間・取るロックが他クエリを実際にどれだけ
  待たせるか）は、`memories` に対しては測っていない（上の「増やす費用」参照）。
- **`createMemoryWithOutbox` のトランザクション外で `ANALYZE` を呼ぶことが、実際に
  ロック競合を減らすこと**は理屈でしか説明していない——トランザクション内で呼んだ場合と
  比較する実測はしていない。
- **複数プロセスが同時に `memories` へ書き込む場合の重複 `ANALYZE`**（ADR 0194 と同じ
  未確認事項。「引き受けた負債」2番参照）。
