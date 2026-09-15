# ADR 0011: 段1の ANN クエリに `count(*) OVER ()` を入れない

- **状態**: 採用 (2026-09)

- **文脈**:
  `docs/recall.md` §3 の当初案は、段1（索引が効くフィルタ + ANN）のクエリに `count(*) OVER ()`
  を含め、「追加のクエリ無しに候補件数を取得でき、`omitted.countKind = 'exact'`
  （[ADR 0008](./0008-absence-taxonomy.md)）を安く出すための実務上の要である」と書いていた。
  マネージャーが PostgreSQL 18.6 + pgvector 0.8.6・50万行・HNSW（`vector_cosine_ops`）で
  実測したところ、**この前提は成立しなかった。** 本 ADR はこの実測結果を記録し、
  `docs/recall.md` §3 の該当箇所を修正した根拠を残す。

  併せて、`docs/recall.md` §3 と [ADR 0004](./0004-decay-at-query-time.md) が段1のクエリに
  含めていた `decay_floor_at > now()` の扱いについても、`docs/roadmap.md`
  （Phase 1 の範囲の記述）と食い違っていたため、本 ADR で整理する（詳細は「decay_floor_at
  の扱いについて」の節）。

- **実測（本 ADR の中心的な根拠）**:

  以下はマネージャーが実施し、`packages/postgres` の `count-over-window.test.ts` として
  歯にした実測である（環境: PostgreSQL 18.6 + pgvector 0.8.6。テスト自体はより小さい
  データ量——3,000〜9,000行——でも同じ現象を再現できることを確認済み。50万行という規模は
  現象の有無ではなく実運用規模での再現確認のために使った）。

  段1のクエリの形（`WHERE tenant_id = ... AND status IN (...) ORDER BY embedding <=> $1
  LIMIT k'` に `count(*) OVER ()` を足したもの）を PostgreSQL のプランナに渡すと、
  二つの分岐しか存在せず、**どちらも「索引を保ったまま exact な件数を追加コスト無しに得る」
  という当初案の主張を満たさない**。

  - **分岐A（索引が使われた場合）**: HNSW の索引スキャンは `hnsw.ef_search` 件までしか
    下流に行を渡さない（pgvector の近似探索の仕様）。`LIMIT` を外して候補全体を数えても、
    索引が返す行数は `hnsw.ef_search` の設定値に一致した（設定を 40 → 200 に変えると
    返る件数も比例して変わり、テーブルの総行数を 20,000 行から 900,000 行まで変えても
    値はほぼ変わらなかった）。つまり、この分岐で得られる「件数」は
    **データとは無関係な、ANN の探索設定に依存する値**である。これを
    `countKind: 'exact'` として返すことは、[ADR 0008](./0008-absence-taxonomy.md) の
    「推定値を実測値の顔で出さない」に正面から反する。推定値ですらなく、
    データと無関係な定数に近い。
  - **分岐B（正しい件数が出る場合）**: `count(*) OVER ()` は空の `PARTITION BY` を持つ
    window 関数であり、パーティション全体を確定してからでないと集約できない。
    これは「上位 `k'` 件だけを遅延評価で返す」という HNSW の索引スキャンの実行方式と
    根本的に相容れない。実測では、プランナは正しい総件数を出すために HNSW を
    捨て、Seq Scan + WindowAgg（大規模データでは `Storage: Disk` に溢れる）を選んだ。
    これは `docs/recall.md` 冒頭・[ADR 0004](./0004-decay-at-query-time.md) が
    禁じている「索引が効かない形」そのものである。

  **`WHERE tenant_id = ...` のように選択性の低い等値条件を伴う場合**、上記の分岐Aは
  そもそも起こりにくい。`memory_embeddings_<space>` の主キー `(tenant_id, memory_id)` が
  「`tenant_id` で絞ってから明示的に `Sort` する」という、常に正確な件数を返す代替経路を
  提供してしまうため、`enable_seqscan = off` で Seq Scan を禁じても、プランナは
  Bitmap Index Scan（主キー）+ Sort を選び、HNSW 自体を使わない。つまり、
  **mnemora の実際のクエリ形（`tenant_id` で絞る）では、実務上は常に分岐Bに落ちる**
  （索引を殺してでも正しい件数を返す）。分岐Aは `WHERE` 句を持たない、より一般的な
  ANN クエリで生じる現象として実測した（本 ADR の主張——「索引を使ったまま exact な
  件数を安く得る手段は無い」——を裏付けるための、より一般的な状況での確認）。

- **追測（マネージャー、mnemora の実際のクエリ形での確認）**:

  上の「分岐Aは実務上起こりにくい」という記述を、`WHERE tenant_id = ... AND status IN
  ('active','contested')` を伴う mnemora の実際のクエリ形で追試した。
  環境は同じ（PostgreSQL 18.6 + pgvector 0.8.6）。30万行、うち条件に一致するのは 27万行。

  **(1) 分岐Bの代償は「索引が効かない」だけでなく、桁で効く。**

  | クエリ | プラン | 実測 |
  |---|---|---|
  | `count(*) OVER ()` **無し**（設計が望む形） | `Limit → Index Scan using idx_hnsw` (33 rows) | **1.5 ms** |
  | `count(*) OVER ()` **有り**（プランナ既定） | `Limit → Sort → WindowAgg (270,000 rows, Storage: Disk 9,229kB) → Seq Scan` | **156 ms** |

  **同じデータ・同じ絞り込みで約100倍**である。`count(*) OVER ()` は「追加コスト無し」
  どころか、段1のクエリの支配的なコストになる。

  **(2) ただし分岐Aは `WHERE` 無しのクエリに固有の現象ではない。**

  上の記述は「主キーが代替経路を提供するため分岐Aは起こらない」としているが、
  正確には**プランナが既定でその代替経路を選ぶ**というだけであり、分岐A自体は
  `tenant_id` で絞る形でも到達可能である。代替経路（`enable_bitmapscan` /
  `enable_indexonlyscan` / `enable_sort`）も塞いで HNSW を WindowAgg の入力に強制すると:

  ```
  Limit → WindowAgg → Index Scan using idx_hnsw (rows=48, ef_search=60, Rows Removed by Filter: 12)
  count = 48   （真の候補件数は 270,000）
  ```

  返る値は「ef_search が返した件数から、フィルタで落ちた分を引いたもの」であり、
  やはりデータの総数とは無関係である。

  ⟹ **分岐Aは「起こらない」のではなく「プランナが既定では選ばない」。**
  プランナの選択は統計情報・設定・データ分布で変わりうるため、これは
  「実務では踏まない」ではなく**潜在的な危険として扱うべき**である。
  本 ADR の決定（`count(*) OVER ()` を使わない）は、この2点のどちらから見ても変わらない
  ——常に起きる害（索引が死ぬ・約100倍）と、条件次第で起きる害（件数が黙って嘘になる）の
  両方を、同時に避ける。

- **決定**:
  **段1のクエリから `count(*) OVER ()` を落とす。** `docs/recall.md` §3 のクエリ骨格から
  この列を削除した。

  代わりに、**段5（目次帯、`docs/recall.md` §5）が既にスコープ全体に対して群カウントの
  集約クエリを走らせている。この集約の総和が「フィルタ条件下（tenant / status /
  taxonomy 等）に何件あったか」そのものである。** 段1が追加のクエリを持たずに得ようとした
  ものは、実は段5が既に払っているクエリから得られる。新しいクエリを追加する必要はない。

  - `filtered` 系の Omission の件数（`condition: 'status'` 等）は、段5の集約結果から
    `countKind: 'exact'` として出す。
  - ANN が返さなかった分（over-fetch の打ち切り）は、従来通り `Omission { kind:
    'ann_truncated', countKind: 'unknown' }` のままにする（[ADR 0004](./0004-decay-at-query-time.md)・
    [ADR 0008](./0008-absence-taxonomy.md) の扱いを変えない）。

- **decay_floor_at の扱いについて（roadmap.md との整合）**:
  `docs/recall.md` §3 の当初案は段1のクエリに `WHERE decay_floor_at > now()` を含めており、
  [ADR 0004](./0004-decay-at-query-time.md) の記述もこれを前提にしていた。一方
  `docs/roadmap.md`（段階2・段階3 の完了条件、および Phase 2 の一覧表）は
  「`decay_floor_at` 列は Phase 1 では書き込むだけ」「Phase 2 で
  `WHERE decay_floor_at > now()` を使い始めるだけ」と明記しており、両者が食い違っていた。

  **roadmap.md を正とする。** roadmap.md は Phase 1 の実装計画そのものの一次資料であり、
  「後から入れられない／入れると割高になるものだけを Phase 1 に前倒しする」という
  この計画全体の設計方針を体現している。`decay_floor_at` の読み取りフィルタへの採用を
  Phase 2 に送ることは、この方針とも整合する（忘却の実処理自体が Phase 2 の機能である
  ため、その読み取りフィルタだけを Phase 1 で先取りする理由が無い）。

  したがって:
  - **Phase 1 の段1クエリは `decay_floor_at` を読み取りフィルタに使わない。** 書き込み時
    （作成時・強化時）に計算して列に持つだけである（[ADR 0004](./0004-decay-at-query-time.md)
    の決定はそのまま）。
  - **索引の3列目としては最初から `decay_floor_at` を持つ**（`idx_memories_recall_gate`
    の3列目）。これにより Phase 2 で読み取りに使い始める際、索引を作り直す必要が無い。
  - [ADR 0004](./0004-decay-at-query-time.md) はこの点について書き換えない。本 ADR が
    「Phase 1 では段1のクエリにこの行を含めない」という運用上のタイミングを補正する。
    ADR 0004 が決定した仕組み（`decay_floor_at` を書き込み時に一度だけ計算する、という
    構造そのもの）自体に変更は無い。

- **誤り1（`idx_memories_recall_gate` の述語）との関係**:
  マネージャーは同時に、`docs/memory-model.md` §10 の `idx_memories_recall_gate` の述語が
  `WHERE status = 'active'` になっており、`contested` な Memory を段1の候補集合から
  排除してしまうこと（mandatory companion retrieval が実装として成立しない）も指摘した。
  この修正（述語を `WHERE status IN ('active', 'contested')` に広げる）は本 ADR の主題
  （window 関数によるカウント）とは独立した問題であり、`docs/memory-model.md` §10 と
  `docs/recall.md` §3 を直接修正することで対応した。本 ADR では「段1のクエリ骨格を
  修正した」という同じ PR 内の変更として言及するに留める。

- **検討した代替案**:
  - **`count(*) OVER ()` を維持し、`hnsw.iterative_scan` で緩和する**: iterative scan は
    「`WHERE` フィルタの下で十分な候補を確保する」機能であり（フィルタ問題）、
    window 関数が索引を殺す問題（スコア/集約問題）とは別種の問題である。
    [ADR 0004](./0004-decay-at-query-time.md) が既に明記している「二つの別問題を混同しない」
    という整理そのものに反するため却下。
  - **`countKind: 'lower_bound'` や `'unknown'` として妥協して残す**: 分岐Aの値は
    `hnsw.ef_search` という設定値に強く依存し、`k'`（over-fetch 後の LIMIT）にすら
    一致しない場合がある。「少なくともこれだけはある」という下限の体をなさない
    （実測では真の総件数よりずっと少ない値になったが、状況によっては何を保証するかが
    説明できない）。`countKind` を持ち出すこと自体が誤解を招くと判断し、
    そもそも段1からこの値を採らないことにした。
  - **段1とは別に、追加の `count(*)` クエリを都度発行する**: [ADR 0008](./0008-absence-taxonomy.md)
    が引き受けた負債として既に想定されていた案（「厳密さが必要な場面では追加のクエリが
    必要になることがある」）。段5が同じ情報を既に集約している以上、独立した
    追加クエリを新設するのは冗長。却下。

- **結果（この決定が招くもの）**:
  良い面: 段1の `ORDER BY` が常に索引を使える形のまま保たれる（`packages/postgres` の
  `EXPLAIN` 検査で確認済み）。件数の正確性は段5の集約という、そもそも exact であることが
  要求されている経路から得られ、二重に実装する必要がない。

  引き受ける負債: `filtered` の exact な件数は段5の実行結果に依存するようになる。
  段5をスキップする経路（`Omission { kind: 'stage_skipped', stage: 'index_band', ... }`）を
  取った場合、`filtered` の件数は `countKind: 'unknown'` に格下げする必要がある——この
  対応関係を実装側が正しく保つ責務が生じる（stage4・stage5 の実装時に検証する）。

- **これが覆るとしたら**:
  - pgvector が将来、索引スキャンの下流でパーティション全体の exact な集約を安価に計算できる
    実行方式（例えば索引自体が総件数を保持するような機構）を持つようになったら、
    段1への回帰を検討する価値がある。
  - 段5の集約が何らかの理由で段1のフィルタ条件と乖離する設計変更が将来入った場合
    （例えば段5が近似のみを許容する設計に変わった場合）、`filtered` の exact な件数を
    どこから取るかを再設計する必要がある。

- **確かめていないこと**:
  - 実測は PostgreSQL 18.6 + pgvector 0.8.6・単一マシンでの計測であり、他バージョンの
    組み合わせ（特に CI が使う PostgreSQL 17 系）で同一の現象が起きるかは
    `packages/postgres` の CI（service container）で継続的に確認する運用にする。
    現象の構造的な原因（HNSW の近似探索・window 関数の集約方式）はバージョンに
    依存しない一般的な性質だと考えられるが、具体的な閾値（何行から分岐Bに落ちるか等）は
    バージョン・パラメータ・データ分布に依存し、汎化はしていない。
  - `hnsw.ef_search` と分岐Aで実際に返る件数の正確な数式的関係（線形か、グラフ構造に
    依存するか）は特定していない。「データ件数に依存しない」ことは複数の規模
    （3,000〜900,000行）で確認したが、`ef_search` の値と返る件数の対応関係を
    一般式として導出してはいない。

- **追記（2026-09、[ADR 0153](./0153-recall-decay-floor-gate.md)、Issue #196）**:
  上の「decay_floor_at の扱いについて」の節が決定した
  **「Phase 1 の段1クエリは `decay_floor_at` を読み取りフィルタに使わない」は、
  ADR 0153 が明示的に上書きした。** `recall-runtime.ts` は既定で
  `VectorFilter.decayFloorAtAfter` に「いま」を渡すようになっている——理由・引き受けた負債・
  検討した代替案は ADR 0153 を参照。**この節の本文自体は書き換えない**（履歴を書き換えない）。
  変わっていないのはこの ADR が決定した仕組みそのもの（`decay_floor_at` を書き込み時に
  一度だけ計算する構造、索引の3列目として最初から `decay_floor_at` を持たせる設計）であり、
  変わったのは「いつ読み取りフィルタとして使い始めるか」というタイミングだけである。
