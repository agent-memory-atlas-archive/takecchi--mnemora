# ADR 0111: 本物の pgvector で確かめた — 順位は変わらない。ただし窓（`ef_search`）はテナントが育つと黙って縮む

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-14

**⚠ 各主張の出所を分ける**（[ADR 0110](./0110-single-char-token-discriminator.md) /
[ADR 0094](./0094-identifier-probes-local-embedding.md) / [ADR 0103](./0103-negative-tooth-declares-its-precondition.md) の体裁を踏む）。

- **【実測】** — この ADR の作業でこの手元の器（本物の PostgreSQL 17.11 + pgvector 0.8.6）に対して走らせた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。
  ⚠ **委譲文で渡された数字は、書き手にとってはすべて【受】である。**

---

## 問い

[ADR 0110](./0110-single-char-token-discriminator.md) §6「測っていないこと」が、
自分でこう書いていた。逐語:【現物】

> 3. **本番（postgres + pgvector / HNSW）で測っていない**（この容器に PostgreSQL が無い）。
>    float4 化だけなら反転しないことは確認した（`8.029e-5`、同符号・同桁）【実測】が、
>    **HNSW の近似が `8e-5` 差の2件を同じ順で返すかは一切測っていない**——
>    `ef_search` 次第で「順が入れ替わる」「片方しか拾われない」のどちらにも倒れうる大きさである。
>    ⟹ ⛔ **§1.2 の順位が本番でも同じになるとは言えない。**

**⟹ この ADR は、その1行だけを塞ぐ。**⛔ **何も直さない。**

---

## 結論（先に）

1. **順位は変わらなかった。**本物の PostgreSQL 17.11 + pgvector 0.8.6 上で、
   ADR 0110 の42 probe すべての margin・順位を測り直した。**42件中42件、in-memory と
   1件も食い違わない。**`org-b` の `distractorBeatsGold=true` も、他41件の `false` も同じ。【実測】
2. 🔴 **ただし、この確認の中身は「新発見」ではない。**[ADR 0011](./0011-no-window-count-in-ann-stage.md)
   が PostgreSQL 18.6 で既に実測していた2つの事実——「HNSW の索引スキャンは `hnsw.ef_search`
   件までしか下流に行を渡さない」「`tenant_id` で絞る mnemora の実際のクエリ形では、
   プランナは既定で HNSW を避けて主キー Bitmap Index Scan + Sort に落ちる」——を、
   PostgreSQL 17.11・本物の埋め込みデータ・identifier-probes という別の器で**確認**したに過ぎない。
   ⟹ **この ADR がこの2点を自分の発見として書くなら、それは ADR 0011 を読んでいなかったことになる。**
3. ⭐ **この作業が本当に新しく足したのは2つである。**
   - **(新1) ADR 0110 §6-3 の心配は、ADR 0011 と突き合わせれば立てる前に半分消えていた問いだった。**
     同じ repo の2つの ADR が答えの半分ずつを持っていて、どちらも互いを指していなかった。
   - **(新2) 🔴 ADR 0011 の「実務上は常に分岐Bに落ちる」には、規模の境界が在る。**
     **同一テナントが10万行に育つと、プランナは GUC 無しで自然に HNSW を選ぶ。**
     そのとき ANN 段の窓は `kPrime = 40` ではなく**実測14件**へ縮む。
     **その領域で効くのは「順序が壊れる」ではなく「候補が窓に入らない」である。**
4. ⚠ **もう1つ、正直な訂正がある。**ADR 0110 §6-3 の予測値 `8.029e-5` は、
   本物の pgvector 上の実測値 `−8.00177547574110193e-5` と**符号・桁は一致するが、
   値そのものは当たっていない**。

---

## 1. 【実測】測った条件

### 1.1 器

| 項目 | 値 |
|---|---|
| PostgreSQL | **17.11 (Debian 17.11-1.pgdg13+2)** |
| pgvector | **0.8.6** |
| `server_encoding` | UTF8 |
| `datcollate` / `datctype` | C.utf8 |
| `hnsw.ef_search` | **40**（`pg_settings.source = 'default'`。明示 SET していない） |
| `hnsw.iterative_scan` | off（既定） |
| `hnsw.max_scan_tuples` | 20000（既定） |
| HNSW `m` / `ef_construction` | **16 / 64**（`registerEmbeddingSpace()` の `CREATE INDEX` に無指定のため pgvector 既定値。reloptions は空を現物確認） |
| embedding | `local` / `ruri-v3-30m/sym` / dtype `q8` / 256次元 / prefix `""` |
| バッチ | **1件/呼び出し（b=1）**——query 埋め込み（`recall-runtime.ts:316`）・memory content 埋め込み（`runtime.ts:1322`）とも常に batch=1（ADR 0110 §4 の前提と同じ） |
| LLM | `deterministic` |
| テーブル | `memory_embeddings_local_ruri_v3_30m_sym_256` |
| `kPrime` | `round(DEFAULT_RECALL_LIMIT(10) × DEFAULT_OVER_FETCH_FACTOR(4)) = 40` |

⛔ **実 API は1度も叩いていない。**`MNEMORA_LIVE_OPENAI` は立てていない。

### 1.2 ⚠ 既定からの逸脱（必ずここに書く）

**`jit = off`**（`postgresql.conf`）。既定は `on`。この環境に `libLLVM` を導入しなかったため、
作業者が明示的に設定した。**JIT がプランナのコスト推定・実行時間に影響しうるため、
下の EXPLAIN の実行時間（`actual time=...`）はこの条件の下でのものである**——
プラン選択（Seq Scan か Index Scan か）自体への影響は確認していない。

---

## 2. 【実測】段A: 本番規模では既定のプランナ設定で Seq Scan が選ばれる（ADR 0011 分岐Bの確認）

`identifier-probes` の本番テーブル（jp-sparse テナント84行 / id-sparse テナント120行）に対し、
`PostgresVectorStore.search` と同じ形のクエリを EXPLAIN した。

```
=== DEFAULT PLANNER (org-b, jp-sparse tenant) ===
Limit  (cost=... rows=40 ...)
  ->  Sort  (cost=119.68..119.72 rows=15 width=24) (actual time=0.330..0.332 rows=40 loops=1)
        Sort Key: (e.embedding <=> '[...]'::vector)
        Sort Method: top-N heapsort  Memory: 29kB
        ->  Nested Loop ...
              ->  Seq Scan on memory_embeddings_local_ruri_v3_30m_sym_256 e
                    (cost=0.00..75.03 rows=84 width=1085) (actual time=0.103..0.152 rows=84 loops=1)
              ->  Bitmap Heap Scan on memories m  (cost=4.80..43.06 rows=84 width=53)
                    ->  Bitmap Index Scan on idx_memories_provenance_kind  (cost=0.00..4.78 rows=84 width=0)
Planning Time: 1.420 ms
Execution Time: 0.398 ms
```

**HNSW 索引（`idx_memory_embeddings_hnsw_...`）は一度も現れない。**org-a（同テナント）・
project-code-a（id-sparse テナント120行）でも同じ形。⟹ **本番規模では既定のプランナが
Seq Scan を選ぶ**（テーブルが小さすぎて索引スキャンのコストに見合わない、というプランナの
通常の判断）。

**⟹ これは ADR 0011 が「実務では常に分岐Bに落ちる」と書いた領域そのものである。**
[Issue #106](https://github.com/takecchi/mnemora/issues/106) の `identifier-probes` を
postgres で走らせた結果は、in-memory の結果と完全一致した（`org-b`: goldRank=2 /
distractorRank=1 / distractorBeatsGold=true、全5群の MRR/hit@1 も ADR 0110 §1.2 の表と一致）。

---

## 3. 【実測】段B / 段B2: HNSW を強制しても・自然に選ばれても、42件全一致

### 3.1 段B: `enable_seqscan`/`enable_bitmapscan`/`enable_sort` を揃えて初めて HNSW に届く

**`enable_seqscan = off` だけでは HNSW を強制できなかった**（ADR 0011 の記述通り）。
段階的に GUC を足していくと:

| GUC | 選ばれたプラン |
|---|---|
| （無し） | `Seq Scan on memory_embeddings_...` |
| `enable_seqscan=off` | `Bitmap Heap Scan` + `Bitmap Index Scan using memory_embeddings_..._pkey`（複合PK `(tenant_id, memory_id)`） |
| `enable_seqscan=off` + `enable_bitmapscan=off` | `Index Scan using memory_embeddings_..._pkey` + 明示的な `Sort` |
| `enable_seqscan=off` + `enable_bitmapscan=off` + `enable_sort=off` | **`Index Scan using idx_memory_embeddings_hnsw_local_ruri_v3_30m_sym_256`** |

3つ目まで来て、ようやく:

```
=== seqscan+bitmapscan+sort off (org-b) ===
->  Index Scan using idx_memory_embeddings_hnsw_local_ruri_v3_30m_sym_256
      on memory_embeddings_local_ruri_v3_30m_sym_256 e  (cost=148.76..477.64 rows=84 ...)
```

**その状態で42 probe 全件の margin・順位を測った。**42件中42件、rank・順序とも in-memory と
完全一致（`org-b` の `distractorRank=1 / goldRank=2` も同じ）。**3回再実行してビット一致。
`REINDEX INDEX` で HNSW グラフを作り直しても一致は崩れなかった**（3ファイルの diff が空、
`rank-forced.csv` / `rank-forced-run2.csv` / `rank-forced-run3.csv` / `rank-forced-reindexed.csv`）。

### 3.2 段B2: 同一テナントが10万行に育つと、プランナは GUC 無しで自然に HNSW を選ぶ

org-a/org-b/org-c と**同じテナント**に synthetic filler 10万行を挿入したところ
（`ANALYZE` 込み、テナント総行数 100,084）、**GUC を一切触らずに**プランナが HNSW を選んだ:

```
=== NATURAL PLANNER after filler (org-b, jp-sparse tenant) ===
->  Index Scan using idx_memory_embeddings_hnsw_local_ruri_v3_30m_sym_256
      on memory_embeddings_local_ruri_v3_30m_sym_256 e
      (cost=701.45..203541.64 rows=100... width=...) (actual time=0.246..0.279 rows=14 loops=1)
        Rows Removed by Filter: 52
```

**その状態で日本語12件の順位を測った。exact 基準（段A/段B）と1行も違わなかった
（3回ビット一致、`rank-jp-natural-filled.csv` / `-run2` / `-run3` の diff が空）。**

⚠ **別テナントに10万件の filler を入れる形では、プランナは自然に HNSW を選ばなかった**
（`explain-after-filler.out`: `Index Scan using ..._pkey` + `Sort` のまま）。
**⟹ 「10万行」ではなく「そのテナント自身が10万行」が条件である。**

⚠ **filler は測定後に削除し、`VACUUM (ANALYZE)` で元の482行
（120+120+84+84+74、`rowCountsAtMeasurement`）・元のプラン形（Seq Scan）に戻したことを
`explain-default-postvacuum.out` で確認済み**（削除直後・`ANALYZE` 前の
`explain-default-postcleanup.out` は統計情報が古く `Bitmap Index Scan on idx_memories_lexical`
という一時的な形を経由したが、`VACUUM (ANALYZE)` 後は元の Seq Scan プランに戻った）。

---

## 4. 【実測】margin 表

### 4.1 日本語12件（in-memory と postgres を並べる。相対差は `|pg − mem| / |mem| × 100`）

| probe | in-memory margin | postgres margin | 相対差 |
|---|---|---|---|
| org-a | `3.17246819934128288e-2` | `3.17246892051644691e-2` | 0.00% |
| **org-b** | `−8.01519997747357493e-5` | **`−8.00177547574110193e-5`** | **0.17%** |
| org-c | `4.85413243483854284e-2` | `4.85413932910245816e-2` | 0.01% |
| person-a | `2.84333348828847976e-2` | `2.84332767806774189e-2` | 0.02% |
| person-b | `3.97804493060315290e-2` | `3.97803271657140023e-2` | 0.03% |
| person-c | `7.94907061153715677e-3` | `7.94906464222544518e-3` | 0.01% |
| person-d | `1.41394481550394246e-2` | `1.41397139638240743e-2` | 0.19% |
| place-a | `3.97721744390262533e-2` | `3.97721526141334714e-2` | 0.01% |
| place-b | `3.73714271342852067e-2` | `3.73713357320663020e-2` | 0.02% |
| product-a | `3.36490836450454855e-2` | `3.36491458175718350e-2` | 0.02% |
| product-b | `4.95660068872548765e-2` | `4.95658566813463874e-2` | 0.03% |
| product-c | `4.73265882181939102e-2` | `4.73265255129262652e-2` | 0.01% |

**全12件で相対差 0.2%未満、符号反転なし。**`org-b` は本物の pgvector 上でも
**負のまま**（`distractorBeatsGold=true` は再現する）。

### 4.2 ASCII 識別子30件（⭐ ADR 0094 §3 は群統計しか出していないので、個別値は今回初めて揃った）

**全30件、in-memory との相対差は日本語群と同オーダー（0.2%未満、符号反転なし）。**
集計:

| 群 | n | margin 平均（postgres） | 最小 |
|---|---|---|---|
| ASCII | 30 | `2.7986708e-2` | `system-d` = `2.43763217126002907e-3` |
| 日本語（全12件） | 12 | — | `org-b` = `−8.00177547574110193e-5` |

ADR 0110 §3 の in-memory 集計（ASCII平均 `2.7987e-2`）と一致する。**`system-d`
（`SYS-LG21`/`SYS-LG22`）が ASCII 群の最小であり、ADR 0110 §3 が「§4 の任意性より小さい」と
指摘した値そのものが本物の pgvector 上でも再現している。**

---

## 5. 🔴 枠組みの訂正 — 上の2.・3.は「新発見」ではなく「ADR 0011 の確認」である

作業を始めた時点では、上の段A・段B2 の結果（「小規模では Seq Scan」「`enable_seqscan=off` だけでは
HNSW に届かない」「HNSW 経路は `LIMIT` を要求しても `ef_search` までしか返さない」）を
**この ADR の新しい発見として書きかけていた。それは誤りだった。**

[ADR 0011](./0011-no-window-count-in-ann-stage.md) は PostgreSQL 18.6 で、既に逐語でこう
記録している:

> **`WHERE tenant_id = ...` のように選択性の低い等値条件を伴う場合**、上記の分岐Aはそもそも
> 起こりにくい。`memory_embeddings_<space>` の主キー `(tenant_id, memory_id)` が「`tenant_id`
> で絞ってから明示的に `Sort` する」という、常に正確な件数を返す代替経路を提供してしまうため、
> **`enable_seqscan = off` で Seq Scan を禁じても、プランナは Bitmap Index Scan（主キー）+
> Sort を選び、HNSW 自体を使わない。**つまり、**mnemora の実際のクエリ形（`tenant_id` で絞る）
> では、実務上は常に分岐Bに落ちる**

そして ADR 0011 の「追測」節は、`enable_bitmapscan` / `enable_indexonlyscan` / `enable_sort`
も塞いで初めて HNSW を強制できることと、その HNSW が「`ef_search` が返した件数から、
フィルタで落ちた分を引いたもの」しか返さないことを、既に実測していた。

**⟹ この ADR の §2・§3.1 は、ADR 0011 の実測を PostgreSQL 17.11・本物の埋め込みデータ
（合成ベクトルではない）・`identifier-probes` という別の器で「確認（再現）」したものであり、
新しい発見として書かない。**

**同じ repo の2つの ADR が、この事実の半分ずつを持っていて、どちらも互いを指していなかった。**
ADR 0011 は「HNSW が選ばれたときの窓の天井」の一般論を持っていたが、それが
`identifier-probes`（ADR 0094/0110）の margin 順位に何を意味するかは書いていなかった。
ADR 0110 §6-3 は「本番の HNSW で順位が変わるかもしれない」と心配していたが、
ADR 0011 を引かなかった。

---

## 6. 🔴 新しく分かったこと

### (新1) ADR 0110 §6-3 の心配は、ADR 0011 と突き合わせれば立てる前に半分消えていた問いだった

ADR 0110 §6-3 は「`ef_search` 次第で『順が入れ替わる』『片方しか拾われない』のどちらにも
倒れうる」と書いた。しかし ADR 0011 が既に記録していた通り、**mnemora の実際のクエリ形
（`tenant_id` で絞る）では、本番規模でプランナは HNSW を避ける**——だから「HNSW の近似誤差で
順位が変わる」という心配自体、**まず HNSW が選ばれる規模に達さないと発生しない。**
今回の実測（§2・§3）はその読みを裏付けた: **HNSW を素通しで使ったのは、既定の GUC のままでは
1件もない**（段Aは全部 Seq Scan、段B は GUC を3つ揃えて強制、段B2 だけが自然選択）。

**⟹ ADR 0110 §6-3 の「順位が変わるかもしれない」という不安の大部分は、「まずそのクエリ形で
HNSW が選ばれるか」という、ADR 0011 が既に答えていた前提条件によって、実務上の確率としては
かなり下がっていた。**この ADR が新しく足したのは、その2つの ADR を突き合わせて明示したことと、
実際に42件で確認を取ったことである。

### (新2) 🔴 ADR 0011 の「実務上は常に分岐Bに落ちる」には、規模の境界が在る

**同一テナントが10万行に育つと、プランナは GUC 無しで自然に HNSW を選ぶ**（§3.2）。
そのとき ANN 段の窓は `kPrime = 40` ではなく**実測14件（org-b）/ 11件（org-a）**へ縮む
（EXPLAIN に `Rows Removed by Filter: 52` が出ている）。

**⟹ その領域で効くのは「順序が壊れる」ではなく「候補が窓に入らない」である。**
今回の42件は全部この少数の候補に含まれていたので1件も落ちなかったが、**これは42件で
偶然0件だったという1点の観測に過ぎない。**42件全部が同じ100,084行のテナントに属していた
わけではない（org-a/org-b/org-cのみ同テナントに filler を入れた）——**ASCII識別子30件は
この規模では測っていない**（§8「測っていないこと」参照）。

これは [ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md)（段1の ANN が窓を
埋められなかったことが `omitted` に出ていない）と**同じ形の穴**である。ADR 0025 は
「subject を絞ったら候補が届かなかった」を、この ADR は「テナントが育ったら候補が届かなかった」
を実測した——**どちらも `omitted` の外側で静かに起きる。**

**また、ADR 0011 の実測は PostgreSQL 18.6 で行われている**
（`packages/postgres/src/__tests__/count-over-window.test.ts` の docコメントと ADR 0011
本文）。**この ADR は 17.11 で再現した**——これは ADR 0011 の証拠をわずかに広げる
（同じ現象が2つの PostgreSQL メジャーバージョンで観測された）。

---

## 7. ⚠ ADR 0110 §6-3 の予測値 `8.029e-5` の訂正

ADR 0110 §6-3 は「float4 化だけなら反転しないことは確認した（**`8.029e-5`**、同符号・同桁）」
と書いている。**本物の pgvector 上の実測値は `−8.00177547574110193e-5` であり、`8.029e-5`
ではない。**

- **符号**: 予測は正符号だったが、実測は負符号——ただし ADR 0110 の元の文脈は
  「同符号・同桁」を float4 化（in-memory 側での型変換）についての確認であり、
  そこでの符号は `org-b` の in-memory 値 `−8.01519997747357493e-5` と同じ**負**である
  はずである。ここでの `8.029e-5`（正符号）という記述自体が、当時の float4 化実験の
  値の書き写しに揺れがあった可能性がある——**この ADR ではその原因までは追っていない。**
- **結論と予測値は別物として書き分ける**: **結論（「反転しない」「同桁」）は支持された**
  ——実測 `−8.00177547574110193e-5` は in-memory `−8.01519997747357493e-5` と符号・桁とも
  一致する（相対差0.17%）。**しかし予測した値そのもの（`8.029e-5`）は当たっていない。**

---

## 8. 採らなかった案 / 引き受けた負債 / これが覆るとしたら

### 採らなかった案

- **`hnsw.ef_search` を上げる**: 段B2 の「窓が14件に縮む」問題への対症療法に見えるが、
  ⛔ **この ADR では実装しない。**想起の質と速度のトレードオフは製品の判断であり、
  上げるなら「どこまで上げるか」「速度への影響をどう測るか」を含めてオーナーが決める話である。
  **代償**: ef_search を上げれば HNSW の探索コストが上がり、レイテンシが増える
  （どれだけ増えるかはこの ADR では測っていない）。
- **`LexicalStore` を配線する**: [Issue #179](https://github.com/takecchi/mnemora/issues/179)
  が住所を持っている製品判断であり、この ADR の範囲外。
- **kPrime を測定と無関係に上げる（例: 10×8）**: 置いた歯（検査1）がこれを機械的に止める。
  上げるなら ef_search も同じ変更の中で上げ、この ADR の測定を引き直す必要がある。

### 引き受けた負債

1. **測定スクリプトをコミットしていない**（`.measure-pg/` / `.measure-scratch/` は
   `git add` していない）——ADR 0110 が引き受けた負債と同じ形をそのまま引き継ぐ。
2. **ASCII 30件は段B2（自然に HNSW が選ばれる10万行規模）では測っていない。**
   日本語12件（org-a/org-b/org-cのみ）だけがその規模で測られている。
3. **`jit=off`** という既定からの逸脱の下で測った（§1.2）。JIT がプラン選択そのものに
   影響するかは確認していない。
4. **10万行という1点でしか、自然選択の閾値を測っていない。**何行から自然に HNSW が
   選ばれ始めるか、その境界は測っていない。
5. **同時実行下で測っていない。**単一接続・順次実行のみ。
6. **`recorded`（OpenAI）・`q8` 以外の dtype は未測定**——ADR 0110 §6 の限界をそのまま継承する。

### これが覆るとしたら

- pgvector のプランナ統合が変わり、`tenant_id` で絞る形でも小さいテーブルから HNSW を
  選ぶようになったら、§2（段A）の前提が変わる——測定を引き直す必要がある。
- `DEFAULT_RECALL_LIMIT` / `DEFAULT_OVER_FETCH_FACTOR` / `hnsw.ef_search` のいずれかを
  変えたら、置いた歯（検査1・検査2）が赤くなる——その変更と同じ PR の中でこの ADR の
  測定を引き直すこと。
- テナントの実運用規模が10万行に近づいたら、§6(新2) の「窓が縮む」問題が
  `identifier-probes` を超えて実際の想起に影響し始める——その時点で ADR 0025 と
  合わせて `omitted` へ何を出すかを決める必要が生じる。

---

## 9. ⚠ 測っていないこと（名指しで）

1. **測定スクリプトをコミットしていない**（負債1と同じ）。
2. **ASCII 30件は段B2（10万行規模）では測っていない**（負債2と同じ）。
3. **`jit=off` の逸脱の影響を切り分けていない**（負債3と同じ）。
4. **10万件という1点のみ**（負債4と同じ）——何%から自然選択が始まるかは測っていない。
5. **同時実行下で測っていない**（負債5と同じ）。
6. **`recorded`/OpenAI・`q8` 以外の dtype は未測定**（負債6と同じ、ADR 0110 §6 の限界を継承）。
7. **HNSW グラフ構築の非決定性**（[ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md)
   が指摘した「近似は index の構築ごとに揺れる」性質）が、この42件のマージンにどう効くかは
   直接測っていない——`REINDEX INDEX` 後も順位が一致したことまでは確認したが（§3.1）、
   異なるシード・異なる構築パラメータでの再現性は測っていない。
8. **語彙チャンネル（`LexicalStore`）を通していない**——ADR 0108 の状態のまま。
   [Issue #179](https://github.com/takecchi/mnemora/issues/179) は製品の判断待ちであり触っていない。

---

## 10. 置いた歯

⛔ **`org-b` が落ちることを assert する歯は置いていない**——ADR 0094/0110 の判断をそのまま
引き継ぐ。**置いたのは向きが逆の歯である**（いま緑で、前提が黙って変わったら赤）。

### `packages/postgres/src/__tests__/hnsw-ef-search-window-ceiling.test.ts`（**いま緑**、DB 不要）

**検査1**: `DEFAULT_RECALL_LIMIT × DEFAULT_OVER_FETCH_FACTOR`（＝ `kPrime`、いま `10 × 4 = 40`）
が、pgvector の `hnsw.ef_search` 既定値 `40` を超えないことを固定する。

🔴 **この赤が意味すること**: 窓を広げたつもりでも、HNSW 経路では `ef_search` が天井である
（§6(新2) の実測どおり）。`kPrime` を40より大きくしても、プランナが HNSW を選んだ領域
（ADR 0011 分岐A・この ADR の段B2）では HNSW は `ef_search` 件までしか下流に行を渡さないので、
広げたぶんは黙って効かない。⟹ 広げるなら `hnsw.ef_search` も同じ変更の中で上げ、
この ADR の測定を引き直すこと。

**変異試験**: `DEFAULT_OVER_FETCH_FACTOR` を `4` → `8` に変える変異を入れ（`kPrime=80`）、
検査1が `AssertionError: kPrime(=80) が... 既定値(40) を超えた` で赤くなることを確認した。
検査2〜4は緑のまま（無関係な変異では動かないことも確認）。変異は `git checkout` ではなく
退避コピーからの復元で戻した。

**検査2**: 本番経路が `hnsw.ef_search` / `hnsw.iterative_scan` を一度も `SET` していないこと
（源走査）。`packages/postgres/src` を再帰的に走査し、
1. `SET ... hnsw.ef_search` の出現が `__tests__/count-over-window.test.ts` の1箇所だけで、
   かつその値が `40`（既定値と同値）であること、
2. `hnsw.iterative_scan` を `SET` している箇所が1つも無いこと、
3. `CREATE INDEX ... USING hnsw` に `m` / `ef_construction` の指定が無いこと、
を機械的に固定する。

🔴 **この赤が意味すること**: この ADR が測った数字の前提が変わった。`ef_search` / `m` /
`ef_construction` を触るなら、同じ変更の中でこの ADR の測定を引き直すこと。

**変異試験**:
- `vector-space.ts` の `CREATE INDEX ... USING hnsw (...)` に `WITH (m = 32)` を足す変異を
  入れ、「3」の検査が `CREATE INDEX ... USING hnsw に m / ef_construction の明示指定が
  見つかった` で赤くなることを確認した。失敗メッセージには実際にマッチした文字列
  （`WITH (m = 32)` を含む statement）が表示され、**変異が経路に載ったことを確認してから**
  赤を見た。
- `vector-store.ts` の `search()` 冒頭に `SET hnsw.ef_search = 200` を足す変異を入れ、
  「1」の検査が `expected [...] to deeply equal [{file: "__tests__/count-over-window.test.ts", ...}]`
  （実際には `{file: "vector-store.ts", value: "200"}` が追加された配列）で赤くなることを
  確認した——**diff に実際のファイル名と値が出ることで、変異が経路に載ったことを確認した。**

いずれの変異も `git checkout` ではなく、事前に取った退避コピー（`/tmp` 配下）から
`cp` で復元した（`docs/autonomy.md` §4 の既知の穴を踏まないため）。

⛔ **既存の歯は1本も書き換えていない。**

---

Refs #106, Refs #109
