# ADR 0175: 語彙チャンネルの `search()` に決定的な最終キーを足す — ANN 側（ADR 0170）と同じ形で、同族の欠陥を塞ぐ（Issue #345）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0167/0170 の体裁を踏む）。

- **【実測】** — この ADR の書き手が、本物の PostgreSQL 17.11（`postgresql://postgres@127.0.0.1:5433/mnemora`、既に稼働中の共有インスタンス）に対して自分の手で走らせて確かめた。範囲は下記「置いた歯」節と「4. EXPLAIN の実測」節の注記に明記する。
- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【受】** — 前任の作業者が実測し、マネージャーの指示文として引き継いだ内容。書き手自身は**再実行していない**。個々の主張にその旨を明記する。

---

## 結論（先に）

**Issue #345 が指摘した「語彙チャンネルの `ORDER BY` に決定的な最終キーが無い」という構造的欠陥は、実際に存在した**（`packages/postgres/src/lexical-store.ts` の `buildLexicalSearchSelect`、修正前は `ORDER BY coverage DESC, rank DESC`）。

**ADR 0170（Issue #339、ANN チャンネル側）が採った形をそのまま踏襲する**——`ORDER BY` に `recorded_at DESC, id` を足し、`coverage DESC, rank DESC, recorded_at DESC, id` の4段にした。ADR 0170 の「これが覆るとしたら」2番が、この対処を名指しで予約していた形である。

**この PR は「実害を実測してから直す」ものではない。**この修正が対処する非決定性は、この PR の範囲では実データ上で再現しなかった（下記「5. 非決定性は再現しなかった」参照、【受】）。**構造的な欠陥を、先例のある形で塞ぐ**という性格の修正である。

---

## 1. 引き継ぎ

- **Issue #345**: ADR 0170（Issue #339）が ANN チャンネル側で直した「`search()` の tie-break が `memory_id`（ランダム UUID）にしか頼っておらず、fresh ingest のたびに同点候補の並び順が変わる」という欠陥と、**同じ形の欠陥が語彙チャンネル側のコードに構造として存在する**ことを指摘した issue。ADR 0170 自身が「採らなかった案」で「本 PR ではこの同族欠陥を直さない」と明記し、別 issue として切り出した経緯を持つ。
- **前任の作業者**が `packages/postgres/src/lexical-store.ts` の `ORDER BY` を `coverage DESC, rank DESC, recorded_at DESC, id` に直し、クラス doc と `buildLexicalSearchSelect` の doc も更新済みだった（未コミット）。**この実装は正しく、本 ADR はこれを作り直していない。**
- 本 ADR の書き手が引き継いだ残作業: `LexicalStore.search` interface の doc・歯（決定性テスト）・変異試験・本 ADR。

---

## 2. 【現物】既存実装の確認

`packages/postgres/src/lexical-store.ts` の `buildLexicalSearchSelect` は次の形になっている（前任者の実装、本 ADR で変更していない）:

```sql
ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
```

- `coverage`/`rank` は ADR 0092 が既に定めた順序（`ScoreBreakdown.lexicalMatch` に入るのは `coverage`、`rank` は同値時のタイブレークにしか使わない）。
- `recorded_at DESC` は ADR 0170 が ANN 側で採ったのと同じ理由——テナント内の ingest 処理順に紐づく値であり、fresh ingest をまたいでも相対順序が再現する。
- `id`（`memories.id`、`gen_random_uuid()`）は最終フォールバック。

---

## 3. 【実測】同じ `content` を持つ行は `coverage`/`rank` が完全一致する

歯を書く前に、psql で直接確認した（`mnemora_lexical_coverage`/`ts_rank_cd` はどちらも `content` だけの関数であることの検算）:

```sql
WITH t(content) AS (
  VALUES ('widget alpha bravo tie-break test content'),
         ('widget alpha bravo tie-break test content')
)
SELECT content,
  mnemora_lexical_coverage(content, 'widget') AS coverage,
  ts_rank_cd(to_tsvector('simple', mnemora_lexical_normalize(content)),
             mnemora_lexical_query_or('widget'), 32) AS rank
FROM t;
```

結果: 2行とも `coverage=1`・`rank=0.09090909` で完全一致。**⟹ 同じ `content` を持つ行を作れば、`coverage`/`rank` のタイを確実に作れる**（下記「4(c). 副産物」で前任者が20,000行規模で実測した性質と整合する）。

---

## 4. 【受】EXPLAIN の実測（前任の作業者。**この書き手は再現していない**）

条件: 20,000行、`obsidian shards` にヒットする行は2%(400行)、`LIMIT 50`、`lexical-store-index.test.ts` の `seedManyMemories` と同一の INSERT を `psql` で再現、`ANALYZE memories` 済み、各形5回 `EXPLAIN (ANALYZE, BUFFERS)`。

| | プラン形 | 索引 | Heap Blocks | Sort Method | Exec 中央値 | buffers(shared hit) | Bitmap Heap / Bitmap Index |
|---|---|---|---|---|---|---|---|
| 甲 現状 `coverage DESC, rank DESC` | 同一 | `idx_memories_lexical` 使用 | exact=400 | top-N heapsort 28kB | 31.225 ms | 683 | 677 / 274 |
| **乙 `+ recorded_at DESC, id`（採用）** | **同一** | **使用** | **exact=400** | top-N heapsort 28kB | **30.789 ms** | 689 | **677 / 274** |
| 丙 `+ id` のみ | 同一 | 使用 | exact=400 | top-N heapsort 31kB | 32.901 ms | 686 | 677 / 274 |

**⟹ プランの形・スキャン量は3形で完全一致。** 理由: `coverage`/`rank` は計算式であり索引が順序を提供できないため、**追加のタイブレークキーの有無に関わらず、元から filter 後の Top-N ソート**になっている——キーを足してもスキャン量に影響しない。

**これは Issue #349（ANN 側の tie-break が索引スキャンを汲み出しすぎると疑われている件）と同じ轍を踏まないことの確認として測られたもの**——そう前任者から引き継いだ。

⚠ **測っていないこと（前任者も明記、この書き手も再検証していない）**: 全15回で `shared read`（ディスク I/O）が0＝**完全にキャッシュ常駐でしか測っていない**。行数・選択性・`LIMIT`・`status` 分布を振っていない。大規模テナント（ADR 0111 域）・同時実行下は未測定。

**本書き手が確かめたこと**: `lexical-store-index.test.ts`（同じ `buildLexicalSearchSelect` を `EXPLAIN` する既存の歯、20,000行 seed）を、乙の形（現行実装）に対して名指しで実行し、`idx_memories_lexical` が使われ `Seq Scan on memories` が出ないことを確認した（下記「置いた歯」節）。**ただし甲・丙の形に対する EXPLAIN の再実測、ミリ秒単位の比較は行っていない**——上表の数値は【受】のままである。

---

## 5. 【受】非決定性は再現しなかった

前任の作業者が、別 DB を**3回フルに作り直して**（`DROP`/`CREATE`/migrate/seed）語彙チャンネルの `search()` の返る順序を突き合わせたが、**3回とも完全一致**（md5 一致）だった。**この書き手はこの再現作業を行っていない。**

⟹ **Issue #345 は「実際に踏んだ」ではなく「構造的に踏みうる」ままである。**

見立て（**見立てであって実測ではないと前任者が明記しており、この書き手もそれ以上の検証をしていない**）: 再現に使ったのが単一バッチの `INSERT ... SELECT` 1回であり、Bitmap Heap Scan が TID（物理配置）順に読むため物理配置が挿入順と一致してしまう。ADR 0170 が実際に踏んだ経路（逐次的な `observe()`・並行 ingest・autovacuum）とは負荷パターンが違う。

⟹ **この PR は「実害を実測してから直す」のではなく、「構造的な欠陥を、先例のある形で塞ぐ」ものである。**

---

## 6. 【受】副産物

前任の作業者が同じ 20,000行 seed で、ヒットした**400行が全部 `coverage=1, rank=0.16666667` で完全同点**だったことを実測した。⟹ **現行コードは既存のテストデータの上で日常的に400件のタイから `LIMIT 50` で切り詰めている。タイは空論ではない。**

本書き手はこの400行規模の実測を再現していないが、上記「3.」の psql での小規模な検証（同一 `content` → `coverage`/`rank` 完全一致）と整合する性質である。

---

## 7. 先例

**ADR 0170「これが覆るとしたら」2番**が、語彙チャンネル側についてこの形（`id` を最終フォールバックに足す）を名指しで指定している:

> **`lexical-store.ts` 側で同種の非決定性が実際に踏まれたとき**——同じ形の tie-break（`id` を最終フォールバックに足す）を `ORDER BY coverage DESC, rank DESC` に追加すること。

**⟹ 本 ADR は設計を作り直していない。**ADR 0170 が既に指定した形に、実際の踏まれ方（構造的な存在の確認）を添えて実装しただけである。

**ADR 0170「引き受けた負債」1番**（`recorded_at` 衝突時は `id` に落ちて非決定に戻る）を、語彙チャンネル側でもそのまま引き継ぐ（下記「引き受けた負債」参照）。

---

## 決定

### 決定1: `PostgresLexicalStore.search()` の `ORDER BY` を4段にする

```sql
ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
```

1. `coverage` DESC（ADR 0092）。
2. `rank` DESC（ADR 0092、`coverage` 同値時のみ効く）。
3. `recorded_at` DESC——新しい方を先に。ADR 0170 と同じ理由（テナント内で ingest は逐次的に行われるため、fresh ingest をまたいでも相対順序が再現する）。
4. `id`——最終フォールバック（下記「衝突時の挙動」）。

**実装は前任の作業者が既に書いていた。本 ADR はこの実装を作り直していない。**

### 決定2: `LexicalStore.search`（`packages/core/src/interfaces/lexical-store.ts`）の doc に「同点のときの順序まで adapter の責務である」ことを明記する

ADR 0170 が `VectorStore.search`（`packages/core/src/interfaces/vector-store.ts`）に対して行ったのと同じ書き方・同じ濃さで、`LexicalStore.search` の doc に段落を足した:

- `coverage`/`rank` が完全一致する行が複数あるときの順序も adapter の責務である。
- **⚠ これが効く理由は「core が返却順をそのまま使うから」ではない。** 段2は `compareScoredCandidates`（ADR 0170 決定2、`recall-runtime.ts:802` の `scored.sort(compareScoredCandidates)`）で候補を**並べ直す**——`score.total` → 実効時刻 → `memory.id` の3段で、`memory.id` は一意だから**全順序**である。⟹ 段2に届いた後の並びは `search()` の返却順に依存しない。**効くのはその手前、`opts.limit` による切り詰めのほうである**——`search()` が「同点の候補のうちどの `limit` 件を返すか」を決めており、**そこで落ちた候補は段2に一度も届かない。**⟹ 順序が変われば**候補集合そのものが変わる。**ADR 0170 が Issue #339 で実際に踏んだのもこの機序である（あちらは `maxCount`／段2の `limit` による切り詰めだった）。
  - ⚠ **この段落は、最初この ADR にも interface の doc にも「段2の `Array.prototype.sort` が安定だから `search()` の順序が保たれる」と誤って書いていた。マージ前のレビューで `recall-runtime.ts:802` を読んで誤りと分かり、両方を直した。** 記録として残す——`compareScoredCandidates` は ADR 0170 自身が足したものであり、それを読まずに「core は順序を保つ」と書くと、**この PR が塞いでいる穴の場所そのものを取り違える。**
- `PostgresLexicalStore` は `coverage → rank → recorded_at DESC → id` の4段で tie-break する。

### 決定3: `recorded_at` が完全一致したときの挙動を明記する（衝突は無くならない）

ADR 0170 決定4 と同じ整理——`recorded_at` は ms 精度で衝突しうる。衝突したら `id` にフォールバックし、その場合に限り ingest ごとに順序が変わりうる。それ以外の行の順序には影響しない。

---

## 採らなかった案

| 案 | 却下理由 |
|---|---|
| **`id` だけ足す最小形**（`ORDER BY coverage DESC, rank DESC, id`、上表「丙」） | 実行計画は乙と同等（4.の EXPLAIN 実測、【受】）だが、`recorded_at` の「作り直しをまたいで再現する」性質を捨てる——`id` は fresh ingest のたびに大小関係が引き直されるランダム値であり、これだけでは ADR 0170 が直したのと同じ非決定性がそのまま残る |
| **`content_hash` を tie-break に使う** | ADR 0170 が却下したのと同じ理由——今回のタイはまさに「同一内容」で起きる（上記「3.」「6.」の実測）。`content_hash` は同一内容の行どうしでは必ず同値になり、差別化する力を持たない |
| **挿入シーケンス列（bigserial 等）を足す** | より強い決定的キーになりうるが migration を要する。ADR 0170 が同じ理由で見送り、「将来の候補」として残したもの。今回もその判断を引き継ぐ |
| **何もしない**（現状維持） | `compare` が既定で ANN チャンネルしか使わないため実害が観測されていない。だが ADR 0170 が半日を溶かした欠陥と同族であり、`compare` 以外の呼び手（語彙チャンネルを直接使う構成、ADR 0148）や将来のベンチ変更で顕在化しうる。踏んでから直すのは高くつく——ADR 0170 自身がその高さを実測している |

---

## 北極星の問いに当てた結果

| 問い | 当てた結果 |
|---|---|
| 1. 毎回渡す量を減らす方向か | 中立。`ORDER BY` にキーを2本足すが、`LIMIT` の件数・返す行の形は変えない。EXPLAIN 実測（【受】）でもスキャン量は不変 |
| 2. 無効にしても Memory Framework として成立するか | 成立する。`LexicalStore` は任意チャンネルではなく必須だが、tie-break の追加はチャンネルの有無ではなく同一チャンネル内の順序の話——外形は変わらない |
| 3. 選ばれた理由を後から説明できるか | **この ADR が直接当たる問い。** 従来は「同点のときどちらが先か」が `id` の運任せ（説明不能）だった。`recorded_at` を挟むことで「ingest が新しい方が先」という説明可能な理由に変わる |
| 4. 推論と事実を区別しているか | 無関係 |
| 5. LLM を呼ばずに済ませられないか | 無関係（本 ADR は SQL の `ORDER BY` のみを扱う） |

---

## 置いた歯

### `packages/postgres/src/__tests__/lexical-search-tiebreak.test.ts`（新設。本書き手が作成・実行）

`packages/postgres/src/__tests__/vector-search-tiebreak.test.ts`（ADR 0170 の歯）と同じ作法に揃えた。**「同じ入力で2回引いて同じ順序」という単発の歯は弱い**という指摘に応えるため、以下の設計にした:

1. **「recorded_at が新しい方を先に返す」歯を N=20 回繰り返す。** 各回、別々のテナント（`lexical-search-tiebreak-tenant-0`〜`-19`）で `coverage`/`rank` が完全同点（同一 `content`）の2件（`recordedAt` だけ異なる）を作り、`recorded_at` が新しい方が常に先に返ることを検査する。
   - `memories.id` は行ごとに新しいランダム UUID（`gen_random_uuid()`）である。**同じ筋書きを別々のテナントで N 回繰り返すことは、`id` の大小関係を毎回独立に引き直すことに相当する**——「DB を作り直す」ことの本質（fresh ingest のたびに `id` の大小関係が変わる）を、1つの DB・1つのテスト内で標本抽出する形である。
   - **実装が `recorded_at` を見ず `id` 順に落ちていた場合、1回あたりの的中確率は約1/2**（`gen_random_uuid()` が一様分布の UUID を振るため）。**20回連続で「たまたま」正しい向きに転ぶ確率は 2⁻²⁰ ≈ 0.000095%。** ⟹ この歯が緑になることは、単発の歯よりずっと強く「`recorded_at` を実際に見ている」ことを裏付ける。**この理屈をテストのコメントと本 ADR の両方に明記した**——書かないと後から「なぜ20回も回すのか」が伝わらず、1回に減らされる恐れがあるため。
   - 追加で、20回の中で生成された2つの `id` の大小関係（`newer.id < older.id` か否か）を記録し、**両方の向きが少なくとも1回ずつ現れたこと**も検査する（ADR 0170 の歯と同じ発想——「newer が常に先に返る」結果が「newer の id がたまたまいつも小さかった」という偏りの産物でないことを示す）。**⚠ この追加検査は確率的に失敗しうる**——20回中いずれかの向きが一度も出ない確率は概算で 2 × 2⁻²⁰ ≈ 0.00019%。無視できるほど小さいと判断し、そのまま残した（コメントに確率を明記済み）。
2. **「recorded_at まで完全一致したときは id にフォールバックし、欠落・重複が無い」歯**（ADR 0170 の歯の2本目と同じ形。「残余を歯にした」もの）。

### 変異試験（本書き手が実行。前景・名指し `vitest run`）

**⚠ `git checkout` は使っていない**——`cp` で退避コピーを取り、`cp` で復元した（`/tmp/lexical-tiebreak-backup/lexical-store.ts.withfix`）。

**変異A: `ORDER BY` を旧形（`coverage DESC, rank DESC`、`recorded_at`/`id` を落とす）に戻す**

```
$ export DATABASE_URL="postgresql://postgres@127.0.0.1:5433/mnemora"
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/lexical-search-tiebreak.test.ts
```
結果: **2件中1件が赤くなった**（「recorded_at が新しい方を先に返す」N=20 の歯。1回目のイテレーションで期待順序と逆になり即座に失敗）。「recorded_at まで完全一致」の歯は**緑のまま**——この変異が影響しない経路（`recorded_at` が最初から同一なので、旧形でも `id` に落ちる点は変わらない）であり、**これも期待通り**（ADR 0170 の変異試験が同じ形の歯について書いた「影響を受けない経路なので緑のままだった——これも期待通り」と同じ整理）。

`cp` で復元後、再実行:
```
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/lexical-search-tiebreak.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
**2/2 が緑に戻った。**

**変異B: `recorded_at DESC` だけ抜いて `ORDER BY coverage DESC, rank DESC, id` にする**

```
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/lexical-search-tiebreak.test.ts
```
結果: **2件中1件が赤くなった**（N=20 の歯。1回目のイテレーションで `id` 順にしかならず失敗）。「完全一致」の歯は緑のまま（この変異でも `recorded_at` 同値時の `id` フォールバックという経路そのものは変わらないため）。

`cp` で復元後、再実行:
```
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/lexical-search-tiebreak.test.ts src/__tests__/lexical-store-index.test.ts
 Test Files  2 passed (2)
      Tests  4 passed (4)
```
**新設2件・EXPLAIN の既存歯2件、あわせて4/4 が緑に戻った。**

**⟹ 新設の歯は、`recorded_at` を無視する2種類の退化（旧形・`id` のみ形）のどちらに対しても、1イテレーション目で即座に赤くなった**——N=20 回すまでもなく崩れる強さがあることを実測した（歯自体は N=20 を要求しているが、退化を検出するのに20回すべてを要したわけではない、という追加の実測事実）。

---

## 誰が壊れうるか / 引き受けた負債

1. **`recorded_at` の衝突**——ADR 0170「引き受けた負債」1番と同じ残余。実運用で高頻度・並列な ingest を行う場合、同一 ms（あるいは同一トランザクション）内に複数の Memory が作られ `recorded_at` が完全一致することがありうる。その場合、衝突した行どうしの間でだけ非決定に戻る。より強い決定的キー（挿入シーケンス列など）は migration を要するため、今回も採らなかった。
2. **`recall-runtime.ts` 側の多層防御は、`score.total` の同点までは吸収するが、語彙チャンネル由来の `coverage`/`rank` 自体のタイは吸収しない**（ADR 0170「引き受けた負債」2番が既に指摘していた構図——本 ADR がその負債を解消した）。
3. **この修正の効果は、この PR の範囲では非決定性の再現によって裏取りされていない**（上記「5.」、【受】）。実データでの効果は未証明のまま、構造的な対処だけを先に入れている。

## これが覆るとしたら

1. **`recorded_at` の衝突が実運用で実際に問題になったとき**——`memories` に insertion-sequence 列（bigserial 等）を足す migration を検討すること（ADR 0170 と同じ判断）。
2. **語彙チャンネルを実際に使う経路（`examples/chat` の `retrieval` ベンチの語彙チャンネル構成、ADR 0148 等）で、非決定性が実際に踏まれたとき**——本 ADR の対処が十分かどうかを実データで再検証すること。
3. **EXPLAIN の実測（4節、【受】）を、キャッシュ非常駐・大規模テナント・同時実行下で再測定した結果、スキャン量への影響が実は無視できない大きさだと分かったとき**——その場合は `recorded_at`/`id` を式索引に含める等の対処を再検討すること。

## 確かめていないこと

- **EXPLAIN の実測（4節）を、この書き手自身が甲・丙の形について再現していない。** 乙（採用形）が `idx_memories_lexical` を使い `Seq Scan` にならないことは既存の歯（`lexical-store-index.test.ts`）を名指しで走らせて確認したが、甲・丙とのミリ秒単位の比較・`EXPLAIN (ANALYZE, BUFFERS)` の再取得は行っていない。
- **非決定性の3回再現の再検算（5節）を行っていない。** 前任者の実測をそのまま引き継いだ。
- **`recorded_at` の衝突が、CI のように速い・並列度の高い環境で実際にどの程度の頻度で起こるか**——ADR 0170 と同じく測っていない。
- **語彙チャンネルを実際に使う経路（`retrieval` ベンチ、ADR 0148 の構成）で、`externalId` の列が fresh ingest をまたいで一致するかを実測していない**——Issue #345 本文が挙げていた候補だが、本 ADR の範囲には含めていない。
- **10万行規模のテナント（ADR 0111 の領域）での本修正の効果**——ADR 0167/0170 と同じく測っていない。
- **CI（GitHub Actions の Postgres service container）が、この環境で使った PostgreSQL 17.11 と厳密に同じバージョンかどうか**——ADR 0167/0170 と同じ限界を引き継ぐ。

Refs #345
