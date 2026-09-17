# ADR 0225: `supersedeWithNewMemories` にも ADR 0221 の書き込み時 `ANALYZE` フックを足す — 残っていた3本目の経路（Issue #269）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0221 / ADR 0222 と同じ体裁）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — 書き手が自分の手で走らせて確かめた。
- **【受】** — 別の作業者の記録として受け取っただけで、自分では確かめていない。

---

## 結論

**ADR 0221（Issue #269、PR #492）が `memories` に入れた「書き込み経路の末尾から、統計が
実態から遅れているときだけ `ANALYZE memories` を撃つ」フックを、`PostgresMemoryStore` の
3本目の書き込み経路 `supersedeWithNewMemories` にも足した。**

**新しい方向を決めていない。** ADR 0221 が既に決めた方向2（等比閾値 + `reltuples` guard、
`packages/postgres/src/analyze-threshold.ts` / `memories-statistics.ts`）を、当時
`createMemory` / `createMemoryWithOutbox` の2箇所にしか適用していなかったのを、
残っていた3本目の `INSERT` 経路に**同じ形で**適用しただけである。

---

## 背景

**【受】** Issue #269 の 2026-09-17T09:11:04Z コメント（マージした側の記録、逐語）:

> `PostgresMemoryStore.supersedeWithNewMemories` は `memories` へ `INSERT` するが、**この
> フックを呼んでいない**（`main = e7b47b0` の `packages/postgres/src/memory-store.ts` で、
> `maybeAnalyzeMemoriesAfterWrite` の呼び出しは `createMemory` と `createMemoryWithOutbox`
> の2箇所だけである）。⚠ **ADR 0221 の「確かめていないこと」にも、この経路は挙がって
> いない。**
> - ⛔ **今回の PR では直さない**——1本の PR は1つの主張であり、「ついでに直す」を
>   しないため。

本 ADR は、その「今回の PR では直さない」と明記されていた分を実装する。

**【現物】** 実際に `main = d5630dc`（本 PR の分岐元）の `packages/postgres/src/
memory-store.ts` を読んで確認した: `maybeAnalyzeMemoriesAfterWrite` の呼び出しは
`createMemory`（`if (inserted.rows.length > 0) { ... }` の内側）と `createMemoryWithOutbox`
（`if (result.created) { ... }` の内側、`this.db.transaction(...)` の外側）の2箇所のみで
あり、`supersedeWithNewMemories` の中に呼び出しは無かった——Issue #269 の記述と一致する。

---

## 実装

`packages/postgres/src/memory-store.ts` の `supersedeWithNewMemories`:

- `this.db.transaction(async (tx) => { ... })` の**戻り値を `result` として受けてから**、
  **トランザクションの外側で** `maybeAnalyzeMemoriesAfterWrite(this.db)` を呼ぶ。
  `createMemoryWithOutbox` が既にこの形で、理由も同じ場所にコメントしている——
  `ANALYZE` はトランザクション内でも実行できるが、そのトランザクションが保持する行ロックと
  `ANALYZE` の `ShareUpdateExclusiveLock`（ADR 0143 決定3）を無用に重ねないため。
- **`result.created` のどれか1件でも `created: true`（実際に新しい行を書いた）のときだけ**
  呼ぶ。`news` は複数件渡せる口なので、`ON CONFLICT ... DO NOTHING` で既存行を返しただけの
  要素（`created: false`）しか無い呼び出しでは呼ばない——`createMemory` の判定
  （`inserted.rows.length > 0` のときだけ数える）と同じ理由を、配列全体に対して
  `Array.prototype.some` で適用しただけである。
- **公開 API の戻り値の形は変えていない**（`{ created, superseded, conflicted }`）。
  `this.db.transaction(...)` の結果を一度ローカル変数 `result` に受けるようになった以外、
  型・キー・意味は1バイトも変えていない。

---

## 歯

`packages/postgres/src/__tests__/memories-statistics.postgres.test.ts` に3本目の `it`
「(丙)」を、既存の (甲)/(乙) と**同じ検査手法**で足した:

- (甲) と同じ「JOIN を含む本物の `search()` を `EXPLAIN` し、`Index Scan ... using
  idx_memory_embeddings_hnsw` を選ぶか」を検査する——**「フックが呼ばれたか」ではなく
  「実際に効いたか」を見る**、既存2本と同じ寄せ方。書き込み経路だけ `createMemory` から
  `supersedeWithNewMemories`（`supersede: []`、`news` は1件ずつ）に差し替えている。
- **専用の使い捨てデータベース**（`mnemora_memories_statistics_supersede_test`）と
  **`resetMemoriesWriteCounterForTesting()`** を使い、同一ファイル内で先に走る (甲)/(乙) の
  書き込みが `memoriesWriteCounts`（`memories-statistics.ts` のモジュールスコープの
  カウンタ）に残す累計に依存しないようにした——(甲)/(乙) はこのカウンタの持ち越しに
  依存する書き方をしているが（(乙) のコメントは「カウンタはまだ0」と書いているのに、
  実際には (甲) が先に4,000回書き込んだ後に走る。それでも通っているのは、両者の間で
  閾値を跨がないため——後述「確かめていないこと」参照）、**3本目を追加する側が同じ
  暗黙の前提を積み増すと、テストの順序を変えるたびに数値の再計算が要る脆い形になる**
  ため、この歯だけは独立させた。

### 変異試験（【実測】）

**退避**: `cp packages/postgres/src/memory-store.ts /tmp/memory-store.ts.orig`

**変異**: `supersedeWithNewMemories` に足した `if (result.created.some((entry) =>
entry.created)) { await maybeAnalyzeMemoriesAfterWrite(this.db); }` のブロックを削除
（`return result;` だけを残す）。

```
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/memories-statistics.postgres.test.ts -t "丙"
```

→ **1 failed | 2 skipped**。実際に赤くなったメッセージ（逐語）:

```
AssertionError: expected 'Limit  (cost=115.97..115.99 rows=10 w…' to match /Index Scan.*using idx_memory_embeddin…/

- Expected:
/Index Scan.*using idx_memory_embeddings_hnsw/

+ Received:
"Limit  (cost=115.97..115.99 rows=10 width=40)
  ->  Sort  (cost=115.97..116.02 rows=21 width=40)
        Sort Key: ((e.embedding <=> '[0.5,0.5,0.5]'::vector)), m.recorded_at DESC, e.memory_id
        ->  Nested Loop  (cost=4.64..115.51 rows=21 width=40)
              ->  Bitmap Heap Scan on memories m  (cost=4.36..36.40 rows=10 width=56)
                    Recheck Cond: (tenant_id = 'memories-statistics-tenant'::text)
                    ->  Bitmap Index Scan on idx_memories_period_ann_stage  (cost=0.00..4.35 rows=10 width=0)
                          Index Cond: (tenant_id = 'memories-statistics-tenant'::text)
              ->  Index Scan using memory_embeddings_memories_statistics_test_crossing_su_79c_pkey on memory_embeddings_memories_statistics_test_crossing_su_79c1d6fd e  (cost=0.28..7.90 rows=1 width=60)
                    Index Cond: ((tenant_id = 'memories-statistics-tenant'::text) AND (memory_id = m.id))"
```

`cp /tmp/memory-store.ts.orig packages/postgres/src/memory-store.ts` で復元 →
`git status --porcelain` が空であることを確認 → 同じコマンドで**3 passed** に戻ることを
実測した（フィルタ無しの全ファイル実行、(甲)(乙)(丙) すべて緑）。

---

## 測ったこと・測っていないこと（Issue #269 コメントの「今回は直さない」に付随する空白）

**Issue #269 のコメント自身が「この経路が実害になるかは測っていない」旨を明記していた
わけではない**が、ADR 0221 の測定はすべて `createMemory`/`vectorStore.upsert` を1行ずつ
呼ぶ**一括投入**シナリオ（4,000行、新規インストール直後）だった。**この経路
（`supersedeWithNewMemories`）が同じ規模の実害を生むかは、本 PR でも測っていない。**

**【現物】測ったこと**: `packages/core/src/runtime.ts` で `supersedeWithNewMemories` を
呼んでいる2箇所（`grep -n "supersedeWithNewMemories.call"`）を読み、`news` 配列の実際の
長さを確認した:

- **`reextract`（2052〜2057行付近）**: `news` は `newMemories`——**1回の `observe()` に
  対応する単一の observation から抽出された候補**（`buildNewMemoriesForCandidates`）に
  限られる。1回の呼び出しで数千件になることは、この呼び出し元の構造上ありえない。
- **`consolidate`（3361〜3363行付近）**: `news` は常に**長さ1**（`[{ input: newMemory,
  jobKinds: [...] }]`）——統合先は必ず1件。

⟹ **`packages/core` を経由する実運用では、この経路が1回に書く行数は
`createMemory`/`createMemoryWithOutbox` の一括インポートシナリオより明確に少ない**
（1回の呼び出しあたり1〜数件）。**しかし**:

- **累積では閾値を跨ぎうる。** `reextract`/`consolidate` が高頻度で繰り返し呼ばれる運用
  （例: 大量の観測を継続的に再抽出するバッチ）では、1回あたりの行数が少なくても
  `memoriesWriteCounts` の累計は他の経路と同じく増え続け、いずれ等比閾値を跨ぐ。
  ⟹ **「1回あたりの行数が少ない」ことは「この経路にフックが要らない」ことを意味しない**
  ——Issue #269 のコメントが「直っていない」と名指ししたのは正しい。
- **`MemoryStore` interface を直接使う採用者**（`packages/core` を経由しない使い方、ADR
  0221「引き受けた負債」1番と同じ注記）は、`news` に大量の要素を渡して1回で呼ぶことも
  できる——この場合は `createMemory` の一括インポートと同じ規模の露出になりうる。
  **この経路を実際に大量の `news` で撃って ANN プランの劣化を再現する実測は、本 PR では
  行っていない**（ADR 0221 が (甲) で `createMemory` に対して行った実測を、本 PR は
  (丙) で `supersedeWithNewMemories` に対して**行数を揃えて**再現した——4,000件・
  `INITIAL_ANALYZE_THRESHOLD` の4倍——ので、**この経路単体の劣化と修復は実測している**。
  測っていないのは「`packages/core` 経由の実運用での累積速度」である)。

---

## 採らなかった案

### 案A: `supersedeWithNewMemories` 専用の別カウンタ・別テーブル名キーを持たせる

**却下。** `memories-statistics.ts` の設計（ADR 0221）は「対象が `memories` という単一の
固定テーブルであること」を根拠に単一エントリの `Map` を採用している。書き込み経路が
`createMemory` か `supersedeWithNewMemories` かは、`memories` という**物理的な対象**に
とって無関係——ANALYZE すべきかどうかは「`memories` の統計がこのプロセスの累計行数に
追随しているか」だけで決まり、どの API 経由で書いたかは関係が無い。経路ごとに別カウンタを
持たせると、片方の経路だけ何度も1000件ずつ書いて片方だけ閾値を跨ぐ、というように
**同じテーブルの同じ問題を2つの独立したカウンタで別々に(遅れて)発見する**ことになり、
ADR 0221 が「`memories` は固定1テーブルなので実質1エントリで足りる」と決めた前提を
崩す。

### 案B: `supersedeWithNewMemories` の中で `news` 1件ごとに ANALYZE 判定を呼ぶ

**却下。** `createMemory` は1呼び出しにつき1行なので「1回の書き込みごとに1回判定」と
「1行ごとに1回判定」が一致するが、`supersedeWithNewMemories` は1呼び出しで複数行を
書けるため、この2つは違う。`news` の要素ごとに `maybeAnalyzeMemoriesAfterWrite` を呼ぶと、
**トランザクションの内側から** DB へ何度も往復することになり、上の「実装」節で避けている
ロック重複の問題が要素数倍に増える。ADR 0221 の「トランザクション外側で1回」という設計は
「呼び出し全体で1回」を前提にしており、`analyze-threshold.ts` の
`maybeAnalyzeTableAfterWrite` 自体は1呼び出しにつきカウンタを1しか増やさない
（`count = (counters.get(table) ?? 0) + 1`）。本 PR はこの前提をそのまま踏襲した——
**`news` に10件渡しても、カウンタは1しか増えない**という既存の粒度をそのまま引き継いで
いる（下の「引き受けた負債」参照）。

---

## 引き受けた負債

1. **カウンタの粒度は「呼び出し回数」であり「書いた行数」ではない。** `news` に何件
   渡しても `maybeAnalyzeMemoriesAfterWrite` は1回しか呼ばれず、カウンタは1しか増えない
   ——`createMemory`/`createMemoryWithOutbox` は元から1呼び出し1行なのでこの区別が
   無かったが、`supersedeWithNewMemories` で初めて表面化する。⟹ **`news` に多数の要素を
   渡す呼び出しパターンでは、実際に書いた行数より閾値越えの検知が遅れる**。上の
   「採らなかった案」案Bで述べた理由から、本 PR はこれを引き受けた。
2. **`packages/core` 経由の実運用でこの経路が累積でどれだけ早く閾値を跨ぐかは測っていない**
   （上の「測ったこと・測っていないこと」節）。
3. ADR 0221 の既存の負債（プロセスローカルのカウンタ、mnemora 外からの直接 SQL には
   届かない、`ANALYZE` の失敗を握り潰さない、等）はすべてそのまま引き継いでいる——
   本 PR はそれらを1つも新しく増やしていないし、減らしてもいない。

---

## これが覆るとしたら

- **案A（案B）で却下した理由の前提が崩れたとき**——たとえば `news` に数千件を渡す
  呼び出しパターンが実運用で確認されたとき（上の負債1番）は、「呼び出し回数」ではなく
  「書いた行数」でカウンタを増やす設計に作り直す必要がある（`analyze-threshold.ts` の
  `maybeAnalyzeTableAfterWrite` に増分を渡せる形へ拡張する、等）。
- ADR 0221「これが覆るとしたら」の1〜3番は、この経路にもそのまま適用される
  （閾値の変更・行数ベースへの設計変更・複数プロセス協調のいずれも、本 PR が触った
  `supersedeWithNewMemories` だけを特別扱いする理由が無い）。

---

## 確かめていないこと

- **`packages/core` 経由の実運用で、この経路が閾値を跨ぐ速度**（上の「測ったこと」節）。
- **(乙) が「カウンタはまだ0」と書いている前提が、(甲) が先に4,000回書き込んだ後の実行
  順でも成立する理由**を、本 PR は数値として書き出していない(このファイルへ歯を足す
  ときに気づいた点だが、既存2本の書き換えは指示されていないため直していない——
  (丙) を独立させたのはこの脆さを新しい歯に持ち込まないためであり、既存2本の脆さ自体は
  本 PR の範囲外)。
- **`news` に複数件（2件以上）渡した場合の閾値検知の遅れ**を、実際に2件以上の `news` で
  実行して数値で確かめてはいない(上の「引き受けた負債」1番は理屈からの記述であり、
  `count` が1しか増えないことは `analyze-threshold.ts` のコードを読んで確認したが、
  「遅れがどれくらいの規模になるか」を実測してはいない)。
- ADR 0221 の「確かめていないこと」節にある項目（CI の Docker イメージでの autovacuum
  実測、本番相当の負荷での窓の長さ、等)は、本 PR も引き継いだままで何も追加確認して
  いない。
