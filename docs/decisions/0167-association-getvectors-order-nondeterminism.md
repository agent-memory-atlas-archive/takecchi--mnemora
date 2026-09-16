# ADR 0167: 連想枠（段3.5）の非決定性の原因は HNSW ではなく `getVectors()` の返却順依存だった — アンカー処理順をランク順に固定して直す（Issue #316）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0111 / ADR 0158 の体裁を踏む）。

- **【実測】** — この ADR の書き手が、本物の PostgreSQL 17.11 + pgvector 0.8.0（この環境に
  `docker` は無かったため、素の `initdb`/`pg_ctl` でクラスタを立てた）と本物の
  `@mnemora/local-embedding`（ONNX、実推論）に対して自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【受】** — Issue #316 本文・コメント、ADR 0158 として引き継いだ、前任者の報告。
  書き手は個々の主張を下記のとおり自分の手で検算し直した。

---

## 結論（先に）

**Issue #316 の非決定性は、HNSW / pgvector の近似探索とは無関係だった。**
`association-probes` ベンチの規模（テナントあたり約98行）では、EXPLAIN で確認した通り
**HNSW 索引は一度も使われていない**（Seq Scan / 主キー Index Scan のみ）。

**実際の原因は `packages/core/src/recall-runtime.ts` 自身のバグである**: 段3.5（連想枠、
ADR 0151）が、`VectorStore.getVectors()` の返す**順序をそのままアンカーの処理順として
使っていた。** `getVectors()` の契約は「返す順序は `memoryIds` の順序と一致している必要は
ない」（`packages/core/src/interfaces/vector-store.ts` 自身の doc）であり、
`PostgresVectorStore.getVectors()` は実際に `ORDER BY` を持たず、実測では主キー
`(tenant_id, memory_id)` の Index Scan——**`memory_id` という ingest のたびに新しく
生成されるランダムな UUID の昇順**——で返す。複数アンカーの近傍が重なったとき
「最初に当たったアンカー」を記録する仕様（ADR 0151 負債4）の「最初」が、この
ランダムな返却順に左右されていた。

**⟹ 依頼書が指示した第一候補（`hnsw.ef_search` を上げる）は採らなかった。**
理由は「効果が無いから」ではなく、**この規模の HNSW は最初から的外れ**——
ef_search を上げても、この bench は最初から HNSW を通っていないので何も変わらない。
ADR 0011 / ADR 0111 / `hnsw-ef-search-window-ceiling.test.ts` の決定は**覆していない**
——`hnsw.ef_search` に触れる変更は本 PR に1行も無い。

修正は `packages/core/src/recall-runtime.ts` の約10行のみ。加えて、
`packages/postgres/src/vector-store.ts` の ANN 検索 `ORDER BY` に `memory_id` の
tie-break を防御的に足した（今回の主因ではないが、決定性を名乗る以上あるべき歯）。

---

## 引き継ぎ

- **Issue #316**: 「同一 commit の CI 再実行で連想枠の構成員が毎回変わる。枠の構成員が
  3回とも一致した probe は 0/12」。原因の仮説として HNSW の近似性・非決定的な
  グラフ構築を挙げ、(甲)（ingest ごとの索引差）/(乙)（同じストアでも揺れる）の
  切り分けを次の課題としていた。
- **PR #308 のフォローアップ実測【受】**: `repeatFrameIdenticalCount` が全 arm で 12/12
  ⟹ **(乙) は否定された**——同じストアに引き直しても連想枠は一致する。
  ⟹ 原因は ingest 側（索引の作られ方の違い）に局在する、という所までが分かっていた。
- **依頼書の作業指示**: 「(甲) の原因は HNSW のグラフ構築がランダムなためではないか」
  という仮説のもと、`hnsw.ef_search` を `kPrime` より十分大きく設定する案を第一候補として
  提示していた。ただし「コードを読んだ結果、違う原因・違う直し方が正しいと判断したなら
  そうしてよい」という留保付きだった。**本 ADR はその留保を使う。**
- **PR #327（Issue #317）が本 ADR の作業前に main へマージ済み**（`161eb3e`）。
  本 ADR の実測はすべて、この commit を取り込んだブランチの上で行った。

---

## 1. 【実測】まず、他人の報告を鵜呑みにせず自分の手で再現した

**環境**: この容器には `docker`/`docker-compose` は無かったが、
`postgresql-17` と `postgresql-17-pgvector` の Debian パッケージは入っていた。
`initdb`/`pg_ctl` で非特権ユーザのまま独立したクラスタを立て（`/home/worker/pgdata`、
port 5433）、`CREATE EXTENSION vector` した。`hnsw.ef_search` の既定値を確認:

```
$ psql -c "LOAD 'vector'; SHOW hnsw.ef_search;"
 hnsw.ef_search
----------------
 40
```

ADR 0011/0111 の実測（既定40）と一致する。

**`association-probes` を本物の Postgres + 本物の `local` embedding に対して実行し、
DB を毎回まっさらに作り直して3回走らせた**（`gh run rerun` の代わりに、ローカルで
`DROP DATABASE` → `CREATE DATABASE` → `migrate` → `association-probes` を3回繰り返す
スクリプトを書いた）。結果:

```
RUN1: off=0/12  on3=7/12  on5=10/12 on10=11/12
RUN2: off=0/12  on3=9/12  on5=10/12 on10=11/12
RUN3: off=0/12  on3=8/12  on5=10/12 on10=10/12
```

`off` arm は3回とも 0/12（PR #327 が条件②を直したことの裏取り）。`on` arm は件数からして
ばらつく——**Issue #316 がこの容器でも再現した。**構成員（`associationFrame` の
externalId 列）を突き合わせると、`on3`/`on5`/`on10` の全 arm・ほぼ全 probe で不一致
だった（`off` arm は0件の不一致）。

---

## 2. 【実測】HNSW は最初から使われていなかった

`association-probes` の1テナントの実データ（98行）に対して、`PostgresVectorStore.search`
と同じ形のクエリを EXPLAIN した:

```
Limit
  ->  Sort (top-N heapsort)
        ->  Hash Join
              ->  Seq Scan on memory_embeddings_... (Filter: tenant_id = '...')
              ->  Hash
                    ->  Seq Scan on memories (Filter: status = ANY(...) AND tenant_id = '...')
```

**HNSW 索引 (`idx_memory_embeddings_hnsw_...`) は計画のどこにも現れない。**
これは ADR 0011 が「`tenant_id` で絞る mnemora の実際のクエリ形では、実務上は常に
分岐B（索引を使わない Seq Scan/Bitmap）に落ちる」と書いたこと、ADR 0111 が
「本番規模（数百行）では既定のプランナが Seq Scan を選ぶ」と実測したことと**完全に
整合する**——この bench はまさにその「本番規模では HNSW を通らない」領域にいる。

**⟹ `hnsw.ef_search` を上げても、この bench の非決定性には何の影響も無い**
（HNSW 経路を一度も通っていないので、その経路のパラメータを変えても効かない）。

---

## 3. 【実測】埋め込み・content は ingest のたびに一字一句・一bit も変わらない

「(甲) ingest ごとに索引の作られ方が違う」という仮説を検算するため、**同じ内容を
2回別々に ingest**（DB を作り直して）し、`tenant_id` でスコープした
`(external_id, content, embedding::text)` の全行を diff した:

```
$ diff dumpA.tsv dumpB.tsv
(差分なし。diff exit code 0)
```

`@mnemora/local-embedding`（ONNX、q8、intraOpNumThreads=4）を**別プロセスで3回**
同じ文字列を埋め込んでも bit-for-bit 同一だった（`embed1.json` / `embed2.json` /
`embed3.json` の diff がすべて空）。

**⟹ 「埋め込みが ingest のたびに微妙に変わる」という仮説も、この bench では成立しない。**
content・embedding は完全に決定的である。段1の再スコア（`withinLimit` の上位10件・
アンカーの選出とその順位）も、別々の2回の ingest 間で **0件の不一致**だった
（externalId のセット・rank 1〜3 の順序とも完全一致、96/96 一致）。

---

## 4. 【実測】決定的な入力から、決定的でない出力が出る現場を捕まえた

デバッグログを一時的に足し（`recall-runtime.ts` の `associationHits.sort` 直後に
`console.error`）、同じ内容を2回 ingest した DB（dbg6 / dbg7）で、同じ probe の連想枠
生成を比較した。**アンカーの選出・順位は dbg6/dbg7 で完全一致**（`[distractor-ascii-project,
distractor-name-meeting, anchor-ascii-project]`）。だが `associationHits`（連想候補の
生カウント）は食い違った:

```
dbg6: assoc-gold-ascii-project は anchor=assoc-distractor-ascii-project から
      similarity=0.8246 で「発見」された（rank 5 相当）
dbg7: assoc-gold-ascii-project は anchor=assoc-anchor-ascii-project から
      similarity=0.8765 で「発見」された（rank 1 相当）
```

`assoc-gold-ascii-project` は **`assoc-anchor-ascii-project` にも `assoc-distractor-
ascii-project` にも近い**（多義的な近傍）。**`assoc-anchor-ascii-project` の
ベクトル自体は dbg6/dbg7 で bit-for-bit 同一**（`md5sum` が両方とも
`2bca265b765d88293e50b703d268e878` で一致）。手で同じ SQL を両 DB に直接投げても
**同一・決定的な top-15** が返る（`assoc-gold-ascii-project` は distance=0.1235=
similarity 0.8765 で常に2位）。

**⟹ SQL の検索自体は完全に決定的。差は「どのアンカーが先に処理されて、この候補を
`seen` として先取りしたか」にあった。**

`getVectors()` を EXPLAIN すると:

```
Index Scan using memory_embeddings_..._pkey on memory_embeddings_...
  Index Cond: (tenant_id = '...' AND memory_id = ANY ('{8d497faa...,ee169bae...,998830fc...}'))
```

**主キー `(tenant_id, memory_id)` の Index Scan——`memory_id`（UUID）の昇順で返る。**
返却順は `8d497faa...`（distractor-ascii-project）→`998830fc...`
（anchor-ascii-project）→`ee169bae...`（distractor-name-meeting）——**スコア順位
（distractor-ascii-project, distractor-name-meeting, anchor-ascii-project）とは
無関係な、UUID の辞書順。** dbg6 と dbg7 で `memory_id` が別々にランダム生成されるため、
この辞書順は ingest のたびに変わる。

`packages/core/src/recall-runtime.ts`（修正前）は:

```ts
const anchorVectors = await getVectors(ctx, deps.embeddingProvider.space, anchorIds);
...
for (const anchor of anchorVectors) {   // ← getVectors() の返却順そのまま
  ...
  for (const hit of hits) {
    if (excludeIds.has(hit.memoryId) || seen.has(hit.memoryId)) continue;
    ...
    seen.add(hit.memoryId);            // ← 「最初に当たった」の判定がこの順序に依存
```

`packages/core/src/interfaces/vector-store.ts` の `getVectors` の doc は**明示的に**
こう書いている（【現物】）:

> 返す順序は `memoryIds` の順序と一致している必要はない——呼び出し側
> （`recall-runtime.ts`）は `memoryId` をキーに引き直す。

**`recall-runtime.ts` は、まさにこの doc が要求する「キーに引き直す」を怠っていた。**
これは HNSW / pgvector の非決定性ではなく、**`VectorStore` インターフェースの
契約を自分自身が破っていた、`recall-runtime.ts` 側の実装バグ**である。

`@mnemora/testkit` の `InMemoryVectorStore.getVectors()` と、`packages/core` 自身の
`FakeVectorStore.getVectors()` は、どちらも `memoryIds` を単純に for-of して結果を積むため
**常に入力順を保って返す**——契約上は許されているが、この2つの fake が偶然「順序を
保つ」実装だったために、既存のテストではこのバグが一度も表面化しなかった
（`packages/postgres` 側だけが「契約どおり順序を保証しない」実装であり、そちらでだけ
症状が出た）。

---

## 決定

1. **`recall-runtime.ts` の段3.5を修正する。** `getVectors()` の結果を `memoryId` を
   キーにした `Map` へ引き直し、**`anchorIds`（スコア降順、既に確定した順序）の順で
   アンカーを処理する。** adapter が返す生の配列順には二度と依存しない。
   `anchorVectorById.get(anchorId)` が `undefined`（adapter が返さなかった——存在しない/
   削除された等）のときはスキップする（`MemoryStore.getMany` の「静かに落とす」契約と
   同じ扱い）。

2. **`ORDER BY` の tie-break を `packages/postgres/src/vector-store.ts` の `search()` に
   足す**（`ORDER BY e.embedding <=> ... , e.memory_id`）。⚠ **これは今回の主因では
   ない**（この bench には距離の完全一致は無かった）——だが「決定性を名乗る」以上、
   完全一致した距離の順序が未定義のまま残るのは別種の欠陥であり、依頼書もこれを
   指摘していた。**単独で効かない理由**: 今回の非決定性は `search()` の結果の順序では
   なく `getVectors()` の結果の順序に起因していたため。

3. **`hnsw.ef_search` には触れない。** `packages/postgres/src/__tests__/
   hnsw-ef-search-window-ceiling.test.ts` の決定（ADR 0011 / ADR 0111）は
   **そのまま維持する**——この bench の規模では HNSW を経由しないため、上げても
   下げても bench の決定性に影響しない。ADR を書き換える理由が無い。

4. **決定性を検査する歯を `packages/core` に足す**（下記「置いた歯」）。

---

## なぜ第一候補（`hnsw.ef_search` を上げる）を採らなかったか

依頼書は「HNSW のグラフ構築がランダムなため、`ef_search` を上げて近似探索を
実質的に厳密な top-k に近づける」という案を第一候補としていた。**実測の結果、
この bench では HNSW が一度も使われていないため、この案は的外れだった**
（§2）。仮に実装しても:

- **効果**: ゼロ（Seq Scan/Index Scan には `ef_search` は関与しない）。
- **代償**: ADR 0111 が指摘した「クエリごとのレイテンシ増」という副作用だけを、
  何の見返りも無く引き受けることになる。
- **ADR 0011/0111 が意図して固定した決定を、理由なく揺らす**——
  `hnsw-ef-search-window-ceiling.test.ts` の「これが覆るとしたら」に該当する
  変更を、覆す理由（実測結果）が無いまま行うことになる。

**⟹ 第一候補は「原因ではないものに対する対症療法」であり、採らなかった。**

---

## 置いた歯

### `packages/core/src/__tests__/recall-association.test.ts`

新しい describe ブロック「複数アンカーが同じ候補を連想したときの決定性
（Issue #316 / ADR 0167）」。

- **`packages/core/src/__tests__/runtime-fakes.ts` に `withReversedGetVectorsOrder()`
  を追加**——`FakeVectorStore.getVectors()` の結果を**逆順**にして返す wrapper。
  `FakeVectorStore`/`InMemoryVectorStore` は入力順を保存するため、この wrapper が無いと
  「adapter が契約通り順序を保証しない」状況を作れず、バグを検出できない。
- **歯**: Q に対して A（rank1）・B（rank2）の2アンカーが立ち、両方の近傍に候補 C が
  重なる（C は B のほうが幾何的に近いが、A のほうがランク上位）シナリオを作る。
  `getVectors()` が入力順（forward）で返っても逆順（reversed）で返っても、
  **`associationOf` は常に A（ランク上位のアンカー）になる**ことを assert する。

**変異試験（退避コピーから戻す。`git checkout` は使わない）**: 修正後のコード
（`anchorVectorById` に引き直して `anchorIds` の順で処理する版）を、修正前の形
（`anchorVectorList` を直接 for-of する版）へ一時的に戻したところ、この歯は
次のように**期待通り赤くなった**:

```
AssertionError: expected 'mem-24' to be 'mem-23'
  reversed.cEntry?.associationOf  // mem-24 (= B) だった。期待は mem-23 (= A)
```

退避コピー（`/tmp/recall-runtime.ts.fixed.bak`）から復元して修正版に戻し、
再度8/8件すべて緑になることを確認した。

---

## 3回の再実行（同一 commit・別々の fresh ingest）での突き合わせ — 修正後

**同一コードに対して、DB をまっさらに作り直して3回 `association-probes` を実行**し
（CI の `gh run rerun` の代わりに、ローカルで同じことを行う専用スクリプトを用意した）、
`arms[].probes[].associationFrame` の externalId 列を突き合わせた。

- **`goldReturnedCount`**: `off`=0/12・`on3`=9/12・`on5`=10/12・`on10`=12/12 — **3回とも
  ビット単位で同一の数字**（Issue #316 が「件数の一致は証拠にならない」と警告している
  通り、これ単独は証拠にしない）。
- **`associationFrame` の構成員**（externalId の列そのもの）: **4 arm × 12 probe ×
  3回のすべての組で完全一致**（比較スクリプトが `MISMATCH` を1件も報告しなかった、
  `RESULT: ALL MATCH`）。

**⟹ 構成員そのものが一致することを確認した。**

---

## 誰が壊れうるか / 引き受けた負債

1. **`getVectors()` の返却順に依存する別のコードが、将来 `recall-runtime.ts` の外に
   書かれる可能性**——`packages/core` 内でこのメソッドを呼ぶのは段3.5だけだが
   （`grep -rn getVectors` で確認済み、テスト・型定義以外の呼び出し箇所は1つ）、
   将来別の呼び出しが増えたときに同じ誤りを繰り返さない保証は、doc コメントと
   本 ADR・上記の歯以上のものは無い。
2. **`vector-store.ts` の tie-break（`memory_id` 追加）は、本 ADR の主因の修正では
   ない**——今回は距離の完全一致が実際には起きていなかったため、この変更単体の
   効果を実データで検証してはいない（合成データでの検証もしていない）。
3. **HNSW が実際に選ばれる規模**（ADR 0111 の「テナントが10万行に育つと自然に
   HNSW が選ばれる」領域）で、今回と**同種の `getVectors()` 順序依存バグ**が、
   HNSW 自体の近似性と**複合する**かどうかは測っていない——今回の修正
   （アンカー処理順をランク順に固定する）は HNSW の有無に関係なく効くはずだが、
   その規模での実測はしていない。

## これが覆るとしたら

1. **`packages/core` 内で `getVectors()` を呼ぶ箇所が増え、同じ「返却順を暗黙に
   意味のある順序として使う」誤りが別の場所で再発したとき**——同じ形の歯
   （`withReversedGetVectorsOrder` を使った回帰試験）をその箇所にも足すこと。
2. **`association-probes` が10万行規模のテナントで測られるようになったとき**
   （ADR 0111 の「窓が縮む」領域に入ったとき）——本 ADR の修正がその規模でも
   決定性を保つかどうかを実測し直すこと。今回の推論（アンカー処理順を固定すれば
   HNSW の有無に関係なく決定的になる）はコードの構造から導いたものであり、
   その規模での直接実測ではない。

## 確かめていないこと

- **`vector-store.ts` に足した `memory_id` tie-break が、実際に重複距離が起きる
  データで機能するか**——実データでは重複が無かったため、直接の実測が無い。
- **10万行規模のテナント（ADR 0111 の領域）での本修正の効果**——測っていない
  （上記「これが覆るとしたら」2番）。
- **CI（GitHub Actions の Postgres service container）が、この容器で使った
  PostgreSQL 17.11 + pgvector 0.8.0 と厳密に同じバージョンかどうか**——
  `docker-compose.yml` は `pgvector/pgvector:pg17` を指定しており、メジャーバージョンは
  揃っているはずだが、pgvector のマイナーバージョンまでは確認していない。

Refs #316
