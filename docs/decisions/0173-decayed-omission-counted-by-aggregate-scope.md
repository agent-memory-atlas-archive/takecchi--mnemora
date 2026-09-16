# ADR 0173: 忘却ゲートで落ちた件数を `aggregateScope` で厳密に数える — 押し下げは外さず、`countKind` を `lower_bound` から `exact` へ上げる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

- **文脈**:

  [Issue #329](https://github.com/takecchi/mnemora/issues/329) は、**既定の recall 経路
  （ANN 1本、`DEFAULT_RECALL_CHANNELS = ["ann"]`）では、忘却ゲートで落ちた記憶が
  `omitted` に1件も現れない**ことを指摘した。機序は単純である:

  - `condition: "decayed"` を作るのは `packages/core/src/recall-runtime.ts` の
    **後置フィルタ1箇所**だけだった（`decayFilteredCount` を数え、0 でなければ push）。
  - しかし ANN チャンネルでは、ゲートは段1の `VectorFilter.decayFloorAtAfter` へ
    **押し下げられる**（[ADR 0153](./0153-recall-decay-floor-gate.md)。ADR 0165 で
    `decayFloorSeqAfter`/`decayFloorAnyAxis` の2軸になった）。⟹ 落ちる記憶は
    Postgres 側の SQL で**候補集合にすら入らない**ので、後置フィルタは一度も見られない。
  - ⟹ `decayFilteredCount` は 0 のまま、「0件のときは push しない」が働き、
    **`omitted` は空のまま**になる。使う側から見ると、記憶は**何の名乗りも無く消える。**

  **これは `docs/north-star.md`「目指す姿」項目6（「知らないことを、知らないと言える。
  ——『見つからなかった』と『探していない』を、同じ顔で返さない」）と正面から食い違う。**
  項目3（「なぜそれを思い出したのか」の裏返し）にも触れる。
  `AGENTS.md`「正典と実装が食い違ったら、**バグなのは実装のほうである**」。

  **⚠ これは ADR 0153 が自分で「引き受けた負債」2 として書き残したものである**（逐語）:

  > **ANN の押し下げで落ちた分の件数は、この PR の後も原理的に分からないままである。**
  > `omitted.filtered(condition:'decayed').countKind` は常に `'lower_bound'`——実際の
  > 除外件数はこれ以上でありうる。

  **本 ADR はこの負債を返す。**ADR 0153 の本文は書き換えない（当時の判断の記録である）。

- **北極星の5つの問いに実際に当てた結果**（`docs/north-star.md`「迷ったときの問い」。
  問いは書いた時点では飾りと区別が付かない、という同文書の戒めに従い、
  **実際に何が落ちたか**を記録する）:

  | 問い | この判断にどう当たったか | 落ちた案 |
  |---|---|---|
  | **1**（毎回渡す量を減らす方向に働くか） | `omitted` に1エントリ（数十バイト）増えるだけで、`memories` の量は1バイトも変わらない。**むしろ「呼び出し側が `includeFullyDecayed` を渡すべきかどうか」を判断できるようになる**——今は判断材料が出ていない。 | **案(A)（押し下げを外して後置に一本化する）**。押し下げが買っているのは速度ではなく**候補の質**であり（下記「測ったこと」）、外すと over-fetch の窓 k' が減衰済みの候補に食われる。**90%減衰で 40件の窓に生き残る候補が中央値 4件（min 0）**——同じ `limit` を埋めるために窓を広げる圧力が生まれ、この問いで落ちる。 |
  | **2**（無効にしても Memory Framework として成立するか） | `omitted` の1エントリであり、無視しても既存の呼び出し側は今日と同じ結果を得る。新しい必須の口を1つも作らない。 | — |
  | **3**（選ばれた理由を後から説明できるか） | **これが本題である。**「なぜ思い出さなかったのか」が既定経路で初めて説明されるようになる。 | **「数えていないと名乗る」案**（下記）。これは問い3を満たしているように見えて満たさない——「数えていない」は説明ではなく、次の一手を1つも生まない。 |
  | **4**（推論と事実を区別しているか） | 該当しない（この判断は件数の出所の話であり、provenance に触れない）。 | — |
  | **5**（LLM を呼ばずに済ませられないか） | 既存の集約クエリに `count(*) FILTER` を1本足すだけ。列と索引で解いている。 | — |

- **決めたこと**:

  1. **押し下げを一切外さない。** `packages/postgres/src/vector-store.ts` の
     `decayFloorAtAfter`/`decayFloorSeqAfter`/`decayFloorAnyAxis` の WHERE 述語は1バイトも
     変えない。**これが本 ADR の設計の核心である**（理由は「採らなかった案」1番）。

  2. **`RecallScope` に忘却ゲートの軸を足す**（`packages/core/src/recall.ts`）。
     `decayFloorAtAfter` / `decayFloorSeqAfter` / `decayFloorAnyAxis` の3欄で、
     **`VectorFilter` と同じ名前・同じ意味・同じ境界（狭義の `>`）**である。
     **新しい概念を1つも導入していない**——[Issue #280 / ADR 0164](./0164-valid-from-until-recall.md)
     が `RecallScope.validAt` で行ったことの再演である。

  3. **`scope` の構築を、`decay_clock`/`activity_seq` の読み取りより後ろへ移す**
     （`recall-runtime.ts`）。ゲートの2軸はテナントの `decay_clock`（ADR 0165）を
     読まなければ決まらないためである。**`stage: "scope"` の trace の内容と順序は
     変わっていない**——移動先までの間に `stages.push` が1つも無いことを確認した。

  4. **段1の `VectorFilter` は、式を書かず `scope` の3欄から作る。**
     ⟹ 押し下げ側と集約側が**構造的に同じ述語**を見る。
     [ADR 0038](./0038-vector-hit-distance-is-cosine.md) が測った「実装が2つあると食い違う」
     穴を、自分から作りにいかない。

  5. **`ScopeAggregate.filteredDecayed` を足し、`MemoryStore.aggregateScope` が
     `count(*) FILTER` で厳密に数える。** postgres 実装は `scoped` CTE の projection に
     `decay_floor_at`/`decay_floor_seq` を足し、`count(*) FILTER` を1本増やしただけである
     （**別クエリにしない**。理由は「採らなかった案」2番）。

  6. **後置フィルタの計数をやめる。** `decayFilteredCount` とその `omitted.push` を削除し、
     `period`/`expired` と同じ扱いにする（件数は集約1本から取る）。
     ⛔ **フィルタそのものは残す**——多層防御（[ADR 0034](./0034-vector-store-filter-conformance.md)
     の契約を adapter が破ったとき）と、語彙チャンネルが混ざったときの保険である
     （ADR 0153 決めたこと3）。**両方から数えると二重計上になる**ので、数えるのは片方だけにする。

  7. **`countKind` を `"lower_bound"` から `"exact"` へ上げる。**
     **⚠ 戻り値の意味が変わった**——下記「引き受けた負債」1番に明記する。
     型は変わらない（`CountKind` に `"exact"` は既に在り、呼び手は既に両方を扱える）。

  8. **`filteredDecayed` は `totalInScope` から引かない。** 減衰しきった Memory は
     **スコープ内に在る**——`docs/recall.md` §2 段0「スコープの外延」が列挙する次元
     （tenant + subject + period + taxonomy + status）に忘却ゲートは**入っていない**。
     ⟹ 群カウントにも目次帯にも現れ続け、**被覆不変条件（群カウントの総和 = `totalInScope`）は
     動かない**。この点だけ `archived`/`period`/`expired` と関係が違う（`below_threshold` の側に
     属する）ので、型の doc・適合テスト・本 ADR の3箇所に明記した。

- **採らなかった案**:

  1. **案(A): 押し下げを外し、後置フィルタ1本に寄せる**（そうすれば後置が全件を見るので
     数えられる）。**落とした理由は latency ではなく候補の質である。**

     **latency では実質無料だった** 【前任の調査者の実測。本作業では再測していない】——
     100k 行・50%減衰で **1.216ms → 1.202ms**（有意差なし）。⚠ **しかしその理由は
     「押し下げが効いているから」ではない**——`decay_floor_at` の述語は
     **HNSW 索引スキャンに一切届かず**、`memories_pkey` の Nested Loop 内側の Filter に
     出るだけである（EXPLAIN で全20クエリ・全減衰率でプラン形が同一）。

     **押し下げが実際に買っているのは候補の質である。**押し下げ無しで `LIMIT 40`
     （k' = limit 10 × over-fetch 4）を引くと、生き残る候補は
     **50%減衰で中央値 21/40、90%減衰で 4/40（min 0）** 【同上】。
     ⟹ 同じ `limit` を埋めるために窓を広げることになり、**北極星の問い1で落ちる。**
     ⟹ **「数えるために質を捨てる」取引になっており、割に合わない。**

  2. **別クエリで数える**（`aggregateScope` はそのままにし、`SELECT count(*)` を1本足す）。
     **落とした理由は2つある。**
     - **速い経路ではない** 【本作業で実測】: 100k 行で **24.6〜27.6ms・Seq Scan**
       （5回、`EXPLAIN (ANALYZE)` の Execution Time）。既存の集約に相乗りさせたときの
       増分 **+9.5ms** の 2.6倍である。
     - **別スナップショットになる。**`totalInScope` と食い違いうる。これは
       [ADR 0011](./0011-no-window-count-in-ann-stage.md) が段1から `count(*) OVER ()` を
       締め出したときと、目次帯を同じ CTE に相乗りさせたとき（ADR 0073 決定7）と、
       **同じ理由**である——`docs/recall.md` §2 段0 が「件数はすべて単一の集約から取る」と
       決めている。

  3. **「数えていないと名乗る」案**（`count: 0, countKind: "unknown"` のエントリを
     常に積む、あるいは `stage_skipped` 相当の札を出す）。
     **落とした理由**: `docs/recall.md` §4 が区別の基準を
     **「その区別があると、呼び出し側の次の一手が変わるか」**と定めている。
     「数えていない」は次の一手を1つも生まない——閾値も窓も `includeFullyDecayed` も、
     どれを動かすべきか判断できない。**問い3（説明できるか）を満たしているように見えて
     満たさない。**⚠ ただしこの案は**費用が 0 である**という利点を持っており、
     もし決定5の +9.5ms が将来割に合わなくなったら、戻ってくる候補である（「これが覆るとしたら」）。

  4. **`filteredDecayed` を `totalInScope` から引く**（`archived`/`expired` と同じ扱いにする）。
     **落とした理由**: `docs/recall.md` §2 段0「スコープの外延」を書き換える判断になる。
     それは「減衰しきった記憶は目次帯にも出さない」という**別の製品判断**であり、
     この ISSUE が問うている「名乗りが出ない」こととは独立している。
     ⟹ **1つの PR は1つの ADR とその実装**（`docs/autonomy.md` §2）に従い、混ぜない。
     ⚠ **この案が正しい可能性は残っている**——下記「これが覆るとしたら」3番。

- **🔴 既存の歯を反転させた。なぜ反転が正しいのか**

  `packages/postgres/src/__tests__/recall-decay-cross-day.postgres.test.ts` の

  ```ts
  expect(gated.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(false)
  ```

  を `toBe(true)` に変えた（さらに (a) `count` が実測件数と一致すること
  (b) `countKind === "exact"` (c) `includeFullyDecayed: true` では逆に積まれないこと、の
  3つを足した）。**「テストが邪魔だから変えた」ではない。**理由は3つある。

  1. **この歯は「実装がそうである」ことを記録した歯であって、「そうあるべきである」ことを
     定めた歯ではない。** 削除した逐語のコメントが自認している——
     「**確かめた実態**（`recall-runtime.ts` を読んで追跡した）」。
     **期待の出所は仕様でも ADR でもなく、当時の実装を追跡した結果である。**

  2. **追跡された実態は、ADR 0153 が自分で「引き受けた負債」2 として明記したものと同一である。**
     ⟹ **この歯が固定していたのは、負債の現在値である。**負債を返した以上、現在値は動く。
     **動いた後もこの歯が残れば、それは「負債を返してはならない」と主張する歯になる。**

  3. **この期待は北極星 項目6 と正面から衝突していた。**既定経路で記憶が静かに消え
     `omitted` が何も言わない状態を、**緑のまま固定していた。**
     `AGENTS.md`「正典と実装が食い違ったら、バグなのは実装のほうである」。

  ⛔ **反転にあたって歯を弱めていない。** `toBe(false)` を削除したのではなく `toBe(true)` に
  変え、上の (a)(b)(c) を足した。⟹ **この歯の役割が変わった**——
  「減衰しきった記憶が消える事実の記録」から
  **「段1の押し下げと段5の集約が同じ述語を見ていることの検算」**へ。
  **押し下げを外す変異も、集約の述語を取り違える変異も、この歯が捕まえる。**

- **引き受けた負債**:

  1. **⭐ (B) が返す数は「scope 内で減衰しきっていた件数」であって、「ANN が k' の窓の中で
     落とした件数」ではない。この2つは違う数である。**
     例: scope に 1000 件あり 400 件が減衰しきっていて、k'=40 の窓に減衰済みが 3 件しか
     入らなかったとき、`count` は **400** であって 3 ではない。

     **⚠ ただし、これは契約違反ではない。** `archived`/`period`/`expired`/`not_yet_valid` も
     **全部前者**を数えており、`docs/recall.md` §5「スコープの外延」の契約が
     **そもそも前者である**（「件数はすべて単一の集約から取る」）。⟹ **契約と整合する。**
     **「窓の内側で何件落ちたか」は [ADR 0011](./0011-no-window-count-in-ann-stage.md) の
     限界として引き続き不明であり、(B) の欠陥ではなく契約の範囲外である。**
     この区別は `FilteredOmission.condition` の doc と `docs/recall.md` §4 にも明記した。

  2. **`aggregateScope` が +3〜7% 重くなる** 【本作業で実測】。100k 行・テナント全体で
     median **150.6ms → 160.1ms（+9.5ms、+6.3%）**。buffers は **6456 で同数**
     （CTE の projection が2列広がるだけで、読むページ数は変わらない）。
     ⚠ **`subjectId` で絞った呼び出しのコストは測っていない**（`docs/recall.md` §5 の
     既存の実測では全規模で 1ms 未満であり、そちらが実運用の主経路である）。

  3. **`decay_floor_at`/`decay_floor_seq` の述語が、3箇所から4箇所に増えた。**
     押し下げ（`vector-store.ts`）・後置フィルタ（`recall-runtime.ts` の `survivesDecayGate`）・
     掃引（`buildArchiveDecayedTargetSelect`。⚠ こちらは `'either'` が **AND** で向きが逆）に加えて、
     集約（`memory-store.ts` の `isDecayed`）が増えた。`period`/`validAt` が既に持っている
     「4箇所の複製」と同じ形の負債である。**適合テストと `(丙)` の歯がこの一致を検算するが、
     掃引側との非対称（OR / AND）を検査する歯は無い**（掃引はこの ADR の射程外）。

     ⚠ **`recall-runtime.ts` 側の「軸を決める式」は、増えるどころか1箇所に減った**
     （下記「ADR 0172 との合流」）——`scope` が唯一の出所であり、
     `gateVectorFilterFields` も `aggregateScope` も、そこから読むだけである。

  4. **`filteredDecayed` が `totalInScope` の部分集合であることは、他の `filtered*` 欄と
     関係が違う。** 呼び出し側が「`filtered` の件数を全部足せばスコープ外の総数になる」と
     読むと、`decayed` の分だけ過大になる。型の doc に明記したが、**型としては区別できない**
     （どちらも `{ count, countKind }` である）。

- **これが覆るとしたら**:

  1. **`aggregateScope` の +9.5ms が割に合わなくなったとき。** `docs/recall.md` §5 は
     「何 ms なら割に合わないか」の閾値を**まだ定義していない**と明記している。その閾値が
     決まり、テナント全体の集約がそれを超えたら、「採らなかった案」3番（数えていないと名乗る）か、
     近似カウント経路（同 §5 が設計の意図として書きつつ Phase 1 では実装していないもの）へ
     倒す判断があり得る。

  2. **「窓の内側で何件落ちたか」が実際に必要になったとき。** 負債1番の2つの数の違いで
     呼び出し側が誤った一手を打った事例が出たら、ADR 0011 の限界そのものを
     （例えば厳密検索へのフォールバックや、段1に別の数え方を足すことで）見直す判断があり得る。
     **今日そのような事例は無い**——この ADR は正典と実装の突き合わせから出ている。

  3. **「減衰しきった記憶はスコープ外である」と決め直したとき**（採らなかった案4番）。
     そのときは `totalInScope`・群カウント・目次帯がすべて動き、**⭐門の基準値も動く。**
     `docs/recall.md` §2 段0 の書き換えを伴う、別の ADR の仕事である。

  4. **語彙チャンネルが既定に昇格したとき。** ADR 0153「引き受けた負債」1番（語彙側の
     over-fetch 窓が減衰済み候補に食われる）は本 ADR では返していない。そちらを返す判断
     （`LexicalFilter` に `decayFloorAtAfter` を足す）が下りたら、後置フィルタの役割が減り、
     決定6の「フィルタは残す」の根拠のうち片方が消える。

- **測ったこと**:

  **【本作業で実測】2026-09-16、ローカルの PostgreSQL 17 + pgvector 0.8.0、
  100,000 行・1テナント（`bench-tenant`、うち `decay_floor_at <= 基準時刻` が 49,857 行）。**
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` の `Execution Time` を、
  変更前後の `aggregateScope` の SQL（目次帯の相乗りを含む、実コードと同じ形）で交互に11回ずつ。

  | | median | min | max | buffers（shared hit+read） |
  |---|---:|---:|---:|---:|
  | 変更前 | **150.6ms** | 131.5ms | 176.5ms | 6456 |
  | 変更後（`decayed_filtered` 1本追加） | **160.1ms** | 151.0ms | 185.9ms | 6456 |

  ⟹ **+9.5ms（+6.3%）。buffers は同数。**

  **別クエリ案**（同じ述語を `SELECT count(*)` 1本で引く）は **24.6 / 25.7 / 25.8 / 26.8 / 27.6ms**
  （5回）で、プランは **Seq Scan**。⟹ 相乗りの増分 +9.5ms の **2.6倍**。

  **正しさの検算**: 集約が返す `decayed_filtered` と、別クエリの `count(*)` と、
  `count(*) FILTER (WHERE decay_floor_at <= 基準時刻)` の素の値が、**3つとも 49,857 で一致した。**

  **【本作業で実測】本物の Postgres に対する歯**: `packages/postgres` の DB テストを
  上記クラスタに対して実行した（`(丙)` の活動時計の歯を含む）。

  **【本作業で実測】ADR 0172 との合流後に、もう一度掛けた変異**（`main` に
  ADR 0172 が着地したあと `git merge origin/main` で合流し、`recall-runtime.ts` の
  衝突を解いた状態で実施）。**「衝突解決で Issue #347 を黙って戻していない」ことの証拠は
  これである**——合流後のコードから ADR 0172 の配線を剥がしたときに、
  ADR 0172 の歯が実際に赤くなること:

  | 変異（合流後のコードに対して） | 結果 |
  |---|---|
  | 段3.5 から `...gateVectorFilterFields` の spread を剥がす | **赤2件**（ADR 0172 の**配線**の歯: 「段1と段3.5 の4欄が一致する」「`includeFullyDecayed`/`includeOutsideValidity` で連想用 filter でもゲートが外れる」） |
  | 段3.5 から後置（`survivesValidityGate`/`survivesDecayGate`）を剥がす | **赤3件**（ADR 0172 の**多層防御**の歯: 減衰 / 活動時計 / 期限切れ） |

  ⚠ **spread を剥がしても「振る舞い」の歯は緑のまま**である——後置が救うためであり、
  これは ADR 0172 自身が「実 Postgres の歯は押し下げ単体を切り分けない（後置が救うため）
  ——切り分けは core の配線の歯が持つ」と記録していたとおりである。⟹ **合流の正しさを
  検査しているのは、配線の歯2本である。**

  **【前任の調査者から受け取った前提。本作業では再測していない】**
  （`docs/autonomy.md` §5「人から受け取った前提——出所を書く」）:
  - 案(A) の latency（1.216ms → 1.202ms、有意差なし）と、その理由（`decay_floor_at` の
    述語が HNSW 索引スキャンに届かず `memories_pkey` の Nested Loop 内側の Filter に出るだけ。
    EXPLAIN で全20クエリ・全減衰率でプラン形が同一）。
  - 押し下げ無しの候補の質（`LIMIT 40` で生き残るのが 50%減衰で中央値 21/40、
    90%減衰で 4/40、min 0）。

- **確かめていないこと**:

  - **⭐門（`examples/chat` の `compare`）への影響**は、下記「⭐門」節のとおり実測した結果を
    書く。**この ADR を書いている時点での予想は「動かない」であり、その根拠は
    「この器のシードは既定 `halfLifeHours=720` で `decayFloorAt ≈ 作成+約129.6日`、
    ベンチはそれよりずっと短い実行時間で終わるので、減衰しきった Memory が1件も無い」である**
    ——予想であって、実測がこれを裏切ったら実測を採る。
  - **`subjectId` で絞った `aggregateScope` の増分コスト**は測っていない（負債2番）。
  - **1M 行での増分**は測っていない。`docs/recall.md` §5 の既存の実測では、テナント全体の
    集約は 1M で 408ms である——本 ADR の増分が同じ比率（+6%）で効くかどうかは不明である。
  - **活動時計（`decay_clock: 'activity'`/`'either'`）での latency / EXPLAIN** は測っていない。
    **正しさ（段1の押し下げと集約の一致）は歯で埋めた**が、`decay_floor_seq` を含む
    `count(*) FILTER` が壁時計の場合と同じコストかどうかは確かめていない。
  - **掃引（`archiveDecayed`）の `'either'`（AND）と、ゲートの `'either'`（OR）の非対称**を
    検査する歯は足していない（負債3番）。既存の ADR 0165 の記述に依存している。

- **歯**（`docs/autonomy.md` §2「歯が実際に噛むことを変異試験で示した」）:

  - `packages/core/src/__tests__/recall-decay-gate.test.ts`
    - ANN 単独の既定経路で `omitted` が `{count: 1, countKind: "exact"}` を名乗ること
      （**この ISSUE そのもの**。以前は「積まれないこと」を固定していた歯の反転）。
    - 押し下げを剥がした壊れた adapter でも、正しい adapter でも、**同じ件数**を名乗ること
      （段1と段5が同じ述語を見ていることの検算）。
    - `includeFullyDecayed: true` では積まれないこと。
    - `subjectId` で絞ると、その subject の件数だけを数えること。
    - 活動時計3種（`wall`/`activity`/`either`）の各分岐で、**鳴る側と鳴ってはいけない側の
      両方**を固定（`'either'` の OR を AND と取り違える変異はここで赤くなる）。
  - `packages/testkit/src/memory-store-conformance.ts`（adapter 非依存の適合テスト、6件）
    - 境界（`decayFloorAt === decayFloorAtAfter` は沈む側、狭義の `>`）。
    - **`totalInScope` から引かれないこと**（群カウントの総和とも突き合わせる）。
    - 活動時計の軸だけで数えること・`decay_floor_seq IS NULL` は沈まないこと。
    - `decayFloorAnyAxis` の OR と、渡さないときの AND の**4象限**。
    - `subjectId`/`period` で絞った scope に従うこと。
    - `archived`/`expired` と**二重計上しない**こと。
  - `packages/core/src/__tests__/recall-association-gates.test.ts`（ADR 0172 の歯。**1件反転**）
    - 連想用 `search()` がゲートを剥がされた状態でも、`filtered(decayed)` の `count` が
      **ちょうど 1**であること（＝段5の集約だけが数え、両段の後置は足さない＝**二重計上しない**）。
      反転の理由は下記「ADR 0172 との合流」。
  - `packages/postgres/src/__tests__/recall-decay-cross-day.postgres.test.ts`
    - `(乙)` の反転（上記「歯の反転」節）+ (a)(b)(c)。
    - `(丙)` **活動時計の3種すべてで、段1の押し下げと段5の集約が一致すること**（本物の Postgres）。
      ⚠ この軸は「測ったこと」の実測が一度も触れていない——**歯で埋めた。**

- **[ADR 0172](./0172-association-passes-decay-and-validity-gates.md)（Issue #347）との合流**:

  本 ADR の実装中に、ADR 0172 が先に `main` へ着地した。**2つは同じ関数（`runRecall`）の
  同じゲートに触っており、向きは噛み合っている。**

  - **ADR 0172 がしたこと**: ゲートの4欄（`decayFloorAtAfter`/`decayFloorSeqAfter`/
    `decayFloorAnyAxis`/`validAt`）を `gateVectorFilterFields` という**1つの断片**に集約し、
    段1（ANN）と**段3.5（連想枠）の両方**がそれを spread する形にした。後置も
    `survivesDecayGate`/`survivesValidityGate` を両段で共有させた。
    理由は「3欄を足すだけでは、次にゲートが増えたときにまた連想枠だけが漏れる」。
  - **本 ADR がしたこと**: 同じ4欄を `RecallScope` へ持ち上げ、**段1の `VectorFilter` は
    式を書かず `scope` から作る**形にした。理由は「段5の集約が同じ `scope` を受け取るので、
    押し下げと集約が構造的に同じ述語を見る」。

  **⟹ 合流後の形は、2つの規律を重ねたものである**（本 ADR の実装がこれである）:

  > **`gateVectorFilterFields` は式を1つも持たず、4欄すべてを `scope` から読む。
  > 段1と段3.5 は、その同じ断片を spread する。段5の `aggregateScope` は、同じ `scope` を受け取る。**

  ⟹ **ゲートを増やすときの手順が1本に定まった**: `RecallScope` に欄を足す →
  `gateVectorFilterFields` でその欄を撒く（両段が自動で追随する）→
  `aggregateScope` の述語に同じものを足す。**この3点セットで1つである。**
  片方だけやると、ADR 0172 が塞いだ穴（連想枠だけ漏れる）か、
  本 ADR が塞いだ穴（落ちた数を名乗れない）のどちらかが再発する。

  **⭐ 合流で ADR 0172 の歯を1件反転させた。**
  `packages/core/src/__tests__/recall-association-gates.test.ts` の
  「減衰しきった記憶は、連想用 `search()` がゲートを剥がしても返らない」にあった
  `expect(result.omitted).not.toContainEqual({condition:"decayed"})` を、
  `toContainEqual({count: 1, countKind: "exact"})` に変えた。

  - **この歯も、本 ADR を名指しで待っていた歯である。**逐語のコメントが根拠として
    挙げていたのは「段1の押し下げで落ちた分を数えないのと同じ扱いであり、
    **Issue #329 の対応と数え方を混ぜないため**」——⟹ ADR 0172 は
    「数え方は変えない」という**自分の射程の宣言**をこの行で固定していたのであって、
    「載ってはならない」という性質を定めたのではない。
  - **ADR 0172 の主張そのものは1ミリも変わっていない**——
    「連想枠の後置は件数を足さない」は今も真である。変わったのは、
    **別の場所（段5の集約）が数え始めた**ことである。
  - ⛔ **弱めていない。** `not.toContainEqual` を消したのではなく、**`count` がちょうど 1**
    であることを固定した。この scope に減衰しきった Memory は1件しか無いので、
    連想枠の後置か段1の後置が集約とは別に足し込んでいたら **2 になる。**
    ⟹ **この行は「数えるのは段5の1箇所だけ」＝二重計上しないことの検算**になり、
    ADR 0172 が守りたかったもの（射程の分離）をより強く守る。

  **合流が ADR 0172 を黙って戻していないことは、変異試験で示した**（上記「測ったこと」の
  「ADR 0172 との合流後に、もう一度掛けた変異」）。

- **出所について**:

  - **この ISSUE の指摘（正典と実装の食い違い）はオーナーが書いた
    [Issue #329](https://github.com/takecchi/mnemora/issues/329) である。**
  - **案(B) を採るという判断と、`countKind` を `exact` へ上げてよいという判断は、
    マネージャーの決定である**（本作業の担い手が決めたものではない）。その根拠になった
    案(A) の実測値も、マネージャー経由で受け取った（上記「測ったこと」の区分のとおり、
    本作業では再測していない）。
  - **`aggregateScope` の +9.5ms / buffers 6456 / 別クエリ案 24.6〜27.6ms は、
    本作業の担い手がこの環境で実際に走らせて得た値である。**
  - **歯の反転を正当化する3点**は、マネージャーが提示した論拠を土台に、担い手が
    現物（削除した逐語のコメント・ADR 0153「引き受けた負債」2）に当てて書き直した。
