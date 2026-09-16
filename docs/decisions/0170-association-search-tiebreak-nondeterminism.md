# ADR 0170: 連想枠の非決定性・第2段 — `search()` の完全一致タイと、`memory_id` tie-break が fresh ingest ごとに揺れる根本原因を直す（Issue #339）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0167 の体裁を踏む）。

- **【実測】** — この ADR の書き手が、本物の PostgreSQL 17.11 + pgvector 0.8.0（この環境に
  `docker` は無いため、ADR 0167 と同じ方法で `initdb`/`pg_ctl` により非特権ユーザで
  自分専用の独立クラスタを立てた——他エージェントが使用中の既存クラスタ
  （port 5433 の `/home/worker/pgdata`、port 5544 の `/home/worker/b5/pgdata`）とは
  別に、port 5460 で `/home/worker/n339/pgdata` を新設した）と本物の
  `@mnemora/local-embedding`（ONNX、実推論）に対して自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【受】** — Issue #339 本文・ADR 0167 として引き継いだ、前任者の実測。
  書き手は個々の主張を下記のとおり自分の手で検算し直した。

---

## 結論（先に）

**Issue #339 の非決定性は、ADR 0167 が直したのとは別の層で起きていた。**
ADR 0167 は「複数アンカーが同じ候補を連想したとき、*どのアンカーの手柄にするか*」
の処理順（`getVectors()` の返却順依存）を直した。**その修正は実際に機能している**
——本 ADR の実測でも、`associationOf` は常に同一アンカーに収束することを確認した。

**今回の原因は、1つのアンカーに対する `VectorStore.search()` 自体が、本物の重複
コンテンツによって完全に距離が一致する行を大量に返し、それを `maxCount`（または
段2の `limit`）で切り詰める箇所に、fresh ingest をまたいで再現するタイブレークが
無かったことである。** ADR 0167 が「防御的に」`vector-store.ts` の `ORDER BY` に
足した `memory_id` tie-break は、**`memory_id` が ingest のたびに
`gen_random_uuid()` で新しく振られるランダムな UUID**であるため、同一 DB 内では
決定的でも、**DB を作り直す（fresh ingest）たびに勝者が変わる**——これが Issue #339
で観測された揺れの直接の原因である。

**`examples/chat` の合成会話（`scenario.ts` の `FILLER_USER_LINES`/
`FILLER_ASSISTANT_LINES`、12種類の固定文を最大320回使い回す）は、実際に bit-for-bit
一致する埋め込みを大量に生む**——`association-probes` ベンチ（ADR 0158/0167）の
コーパス（62文、重複を意図的に含まない自然文）には存在しない性質であり、これが
ADR 0167 のときに欠陥が発覚しなかった理由である。

**修正**: `packages/postgres/src/vector-store.ts` の `search()` の `ORDER BY` を
「距離 → `memory_id`」の2段から「距離 → `m.recorded_at` DESC → `memory_id`」の
3段にした。`recorded_at` はテナント内の ingest 処理順に紐づく値であり、
**fresh ingest をまたいでも相対順序が再現する**——`memory_id` と違って、値そのものが
無関係なランダム値ではない。加えて、`packages/core/src/recall-runtime.ts` の段2
（再スコア、`scored.sort`）にも明示のタイブレークを足した（多層防御。下記「決定」）。

---

## 引き継ぎ

- **Issue #339**: PR #336（`examples/chat` が連想枠を既定で使う、ADR 0168）が
  ⭐門 `compare` の `turnCount=322` 行を非決定にした。同一 commit の CI 実行で
  `mnemoraChars` が 4481/4555/4558 と揺れ、`returnedCount` は常に20——**件数は
  同じで中身が違う**。ADR 0167 の修正では消えていなかった。
- **依頼の中心の問い**: 「ADR 0167 の修正が届いていない経路が別に在るのではないか」。
  **本 ADR はこれを実測で確認した**（下記「2」）。
- **中間報告での切り分け**: 原因の大枠を実測で特定した時点で、実装前に一度
  マネージャーへ中間報告し、方針（`recorded_at` を tie-break に使う案・
  衝突時の挙動を明記すること・`recall-runtime.ts` 側にも明示のタイブレークを
  検討すること）の承認を得た。本 ADR はその承認後の実装を記録する。

---

## 1. 【実測】まず、他人の報告を鵜呑みにせず自分の手で再現した

**環境**: `postgresql-17` + `postgresql-17-pgvector` の Debian パッケージから、
非特権ユーザのまま独立クラスタを立てた（`/home/worker/n339/pgdata`、port 5460）。
既に稼働中の他クラスタ（port 5433・5544）とは触れていないことを `ps aux` で
確認済み。

`examples/chat` の `compare`（`MNEMORA_COMPARE_JSON` で機械可読出力）を、DB を
`DROP DATABASE`→`CREATE DATABASE`→`migrate` で毎回まっさらに作り直して**5回**
実行した（cassette 再生、CI と同じ `llmMode=recorded`/`embeddingMode=recorded`）:

```
run1: turnCount=322 mnemoraChars=4558
run2: turnCount=322 mnemoraChars=4558
run3: turnCount=322 mnemoraChars=4555
run4: turnCount=322 mnemoraChars=4558
run5: turnCount=322 mnemoraChars=4547
```

**Issue #339 の揺れがこの環境で再現した。**

---

## 2. 【実測】原因を特定した——`getVectors()` ではなく `search()` 自身のタイ

`recall().memories` を `sourceObservationId → externalId`（`turn-N`）まで辿る
デバッグ用の一時スクリプト（`examples/chat/src/debug-322.ts`、**commit しない**）
を書き、`retrievedVia`・`associationOf`・`digest` 長を出力させた。

**主体（段1、`retrievedVia:"ann"`）の上位10件は5/5 runsで externalId・スコアとも
完全一致——安定。**

**連想枠（段3.5）の10件は、`associationOf` が常に同一アンカー（例: `turn-298`）に
収束する**——ADR 0167 の修正（アンカー処理順の固定）が機能していることの直接証拠。
だが**そのアンカーの近傍としてどの10件が選ばれるかは run ごとに変わった。**

SQL を直接引いて確認した:

```sql
select o.external_id, m.digest
from observations o join memories m on m.source_observation_id = o.id
where o.tenant_id = '...' group by ...
```

- ある filler 文（「新しい趣味を始めようと思っている。」）の digest を持つ
  Memory が **13件**、埋め込みは `embedding <=> embedding` で **距離0**
  （bit-for-bit 一致）。
- 別の filler 文（「運動不足を感じているので何か始めたい。」）の digest を持つ
  Memory も同様に13件、こちらはアンカーからの距離が全13件とも
  **0.4874170249434402（一致）**——`minSimilarity=0.5` をわずかに上回る。
- アンカーの近傍候補は「距離0の13件（うち9件は既に主体で消費済み、残り4件）」＋
  「距離0.4874…の13件」の合計17件で、`maxCount=10` に対して**7件超過**——
  4件は確定で入り、残り13件から**6件だけ**を選ぶ必要がある。**この6件の
  中身が run ごとに変わっていた。**

`vector-store.ts` の `search()` の `ORDER BY`（当時: 距離 → `memory_id`）を見ると、
2番目のキーである `memory_id` は `gen_random_uuid()` が ingest のたびに新しく
振る値——**同じ13件でも、DB を作り直せば `memory_id` の大小関係が変わり、
「距離が完全一致したときに先頭に来る6件」が変わる。**

**⟹ ADR 0167 が「防御的に」足した tie-break そのものが、fresh ingest をまたいで
均されるべき Issue #339 の非決定性を止められていなかった。**

---

## 3. なぜ 322 行だけが揺れ、162・642 は違って見えるのか（統一的な説明）

**規模（`totalInScope`）の大小では説明できない**——642 は 322 より規模が大きいのに
「安定」して見える。**実際に効いているのは「タイの母集団が `maxCount`（または
段2の `limit`）を超えて切り詰めが必要かどうか」である。**

| turnCount | 規模 | 主体で消費後の同一 digest 母集団 | `maxCount`(=10) との関係 | 観測 |
|---|---|---|---|---|
| 162（fillerPairs=80） | 各 filler 文の重複が6〜7件 | 母集団 ≤ 10 | **切り詰め不要**——母集団全体がそのまま入る | 3回の fresh ingest で連想枠の externalId 集合まで完全一致（真に決定的） |
| 322（fillerPairs=160） | 重複が13件×複数文 | 母集団(17件) > 10 | **切り詰めが発生**——タイの6件を選ぶ必要がある | 揺れる（`mnemoraChars` も揺れる。2つの digest 長（17字/19字）が混在するため、選ぶ組み合わせが変わると合計文字数が変わる） |
| 642（fillerPairs=320） | 重複が26〜27件 | 母集団(18件) > 10 | **切り詰めが発生**——322 と同様 | **`mnemoraChars` は5回とも一致したが、これは「揺れていない」ことの証明にならない**——実際に4回 fresh ingest して連想枠の externalId 集合を比較したところ、**中身は毎回違った**（例: `turn-106,130,250,...` vs `turn-130,154,202,...`）。ただしこの重複クラスタは**単一の digest**（全メンバーが同じ文字数）しか含まないため、どの10件を選んでも合計文字数が変わらず、**`mnemoraShareOfNaiveChars` という⭐門の物差しには現れない** |

**⟹ 642 行も実際には非決定的である。Issue #339 本文の「揺れるのは322行だけ」は
訂正が要る前提である**（オーナー側で Issue #339 に訂正コメントを足す予定と
中間報告で伝達済み）。642 行が「安定して見えた」のは、たまたまこの規模の
コーパスで、切り詰め対象のタイ母集団が単一 digest だったという**データの
巡り合わせ**であり、構造的な安定性ではない。

---

## 4. なぜ ADR 0167 の修正がここに届かなかったか

ADR 0167 が直した層（アンカー選出後、`getVectors()` の返却順に依存していた
「最初に当たったアンカー」判定）は、**本 ADR の実測でも正しく機能していることを
確認した**（`associationOf` が常に同一アンカーに収束する）。

**今回の欠陥は別の層**——1つのアンカーに対する `search()` 自体が、本物の重複
コンテンツによる完全な distance タイを大量に返し、それを `maxCount`/`limit` で
切り詰める箇所である。ADR 0167 自身の bench（`association-probes`、12 probe ×
62文の自然文コーパス）は**重複文を意図的に含まない**ため、この種のタイが
一度も発生せず、ADR 0167 の回帰テスト・3回再実行の bit 一致確認はこの欠陥を
素通りしていた。`examples/chat` の `compare` は逆に、`FILLER_USER_LINES`/
`FILLER_ASSISTANT_LINES` 12種を数百回使い回す設計そのものが重複コンテンツを
大量に生む——**ベンチの性質の違いが、同じ種類の欠陥を片方だけで顕在化させていた。**

---

## 決定

### 決定1: `PostgresVectorStore.search()` の `ORDER BY` を3段にする

`packages/postgres/src/vector-store.ts`:

```sql
ORDER BY e.embedding <=> ${queryLiteral}::vector, m.recorded_at DESC, e.memory_id
```

1. 距離（そのまま昇順、ADR 0001 の規約は変えていない）。
2. `m.recorded_at` DESC——新しい方を先に。ingest はテナント内で逐次的に行われる
   ため、同じ内容を何度作り直して ingest しても**相対順序は再現する**。
3. `e.memory_id`——最終フォールバック（下記「決定4・衝突時の挙動」）。

`memories` は既に `JOIN` されているため、追加の JOIN・列は不要。

### 決定2: `packages/core/src/recall-runtime.ts` の段2（再スコア）に明示のタイブレークを足す

`scored.sort()` を `compareScoredCandidates`（新設、export）に置き換えた:

1. `score.total` 降順。
2. 実効時刻（`occurredAt ?? recordedAt`、ADR 0039）降順。
3. `memory.id` 昇順——最終フォールバック。

**理由（なぜ SQL 側の修正だけに委ねなかったか）**: `scored` は ANN チャンネルだけで
なく**語彙チャンネル**（`PostgresLexicalStore.search()`）の候補も束ねる。
`packages/postgres/src/lexical-store.ts:138` の `ORDER BY coverage DESC, rank DESC`
には `id` 相当の完全なタイブレークが無く、**同じ種類の欠陥が語彙チャンネル側にも
潜在的に存在する**（`compare` は既定で ANN チャンネルしか使わないため、本 Issue
では踏んでいない）。`recall-runtime.ts` 自身がタイブレークを持てば、この
潜在欠陥を実際に踏むまで待たずに防御できる——ADR 0034/0056/0059 が繰り返し
採ってきた「多層防御。正しさの担保を1箇所に置かない」という規約をここでも踏襲した。

### 決定3: `recall-runtime.ts:1041`（段3.5、連想枠の `associationHits.sort`）には明示のタイブレークを足さない

代わりに、**`VectorStore.search()` の doc（`packages/core/src/interfaces/
vector-store.ts`）に「同点のときの順序まで adapter の責務である」ことを明記**し、
`recall-runtime.ts` 側のコードには「なぜ足さなかったか」を明示するコメントを
置いた。

**理由**: `associationHits` はまだ `Memory` を取得していない段階（`memoryId` だけ
を持つ）——ここで `occurredAt`/`recordedAt` によるタイブレークを足すには、
**選ばれなかった候補も含めて全件の `Memory` を先に取得する**必要があり、
`maxCount` 件だけ後から取得するという現在の設計（余計な DB 往復を避ける）を崩す。
また、`memoryId`（文字列）だけでの再タイブレークは、SQL 側が既に確定した
意味のある順序（`recorded_at` に基づく）を無関係な UUID の辞書順で上書きしてしまい、
かえって adapter 側の修正を無効化する。**⟹ ここは「adapter が完全な順序を返す」
契約に乗ることを選んだ**（`docs/autonomy.md` §3.1「どちらを選んでも技術的には
成立するが」に該当するため、ここに理由を残す）。

### 決定4: `recorded_at` が完全一致したときの挙動を明記する（衝突は無くならない）

**`recorded_at` は ms 精度で、衝突しうる**。書き手が実測した ingest（`examples/chat`
の `compare`、cassette 再生、実 DB 往復を伴う逐次 `observe()` 呼び出し）では
27行すべてが別々の timestamp を持っていたが、**これはデータの性質であって
構造的な保証ではない**——一括 ingest が速ければ同一 ms（あるいは同一トランザクション
内で `now()` を使えば同一値）に入りうる。

**衝突したら何が起きるか**: `ORDER BY` の3番目のキー（`memory_id`）にフォールバック
する。これは**まさに ADR 0167 が最初に足した挙動**——`recorded_at` が競合した
特定の行どうしの間でだけ、ingest ごとに順序が変わりうる。**それ以外の行
（`recorded_at` が競合しない行）の順序には影響しない**——退化の範囲は
局所的である。

**より強い決定的キー（内容由来のもの等）を検討したが採らなかった**（下記
「採らなかった案」3・4番）。

---

## 採らなかった案

| 案 | 却下理由 |
|---|---|
| **乱数シードを固定する** | オーナーが名指しで却下した逃げ道。本番でも同じ入力に同じ枠が返るべきである |
| **⭐門へ許容誤差を導入する / `compare` を門から外す / `maxCount` を下げる** | オーナーが名指しで却下した逃げ道（Issue #339 本文） |
| **`content_hash`（内容のハッシュ）を tie-break に使う** | 今回のタイはまさに「内容が完全に同一」なケースで起きている——`content_hash` は同一内容の行どうしでは**必ず同値**になり、差別化する力を持たない。tie-break の役に立たない |
| **`memories` に新しい insertion-sequence 列（bigserial 等）を足す** | より強い決定的キーになりうるが、**migration を要する**——今回の欠陥の主因（`search()` の `ORDER BY`）に対して過剰な変更であり、`recorded_at`（既存列）で局所化できる範囲を超える。将来 `recorded_at` の衝突が実運用で問題になったときの候補として残す（下記「これが覆るとしたら」） |
| **`recall-runtime.ts` の段3.5（`associationHits.sort`）にも明示のタイブレークを足す** | 決定3参照。追加の DB 往復を要し、かつ SQL 側が既に確定した意味のある順序を無関係な UUID で上書きするリスクがある |
| **`lexical-store.ts:138` の同族欠陥をこの PR で直す** | `compare` は既定で ANN チャンネルしか使わないため、本 Issue の再現には関与していない。別 issue 相当と判断した（マネージャー同意済み） |

---

## 置いた歯

### `packages/postgres/src/__tests__/vector-search-tiebreak.test.ts`（新設）

- 距離が完全一致する2件を作り、`recorded_at` が新しい方が常に先に返ることを検査
  （`memory_id` の辞書順とは無関係に成立することを、生成された2つの id の大小関係を
  実測した上で確認）。
- `recorded_at` まで完全一致させた2件を作り、**欠落・重複が無く**、`memory_id` の
  辞書順にフォールバックすることを検査（決定4の「衝突したらこうなる」を歯にした）。

**変異試験**: `ORDER BY` を旧形（距離 → `memory_id`）へ一時的に戻したところ、
1本目の歯が期待通り赤くなった（`recorded_at` を無視して `memory_id` 順になるため）。
2本目（`recorded_at` 完全一致のケース）はこの変異の影響を受けない経路のため
緑のままだった——これも期待通り。退避コピー（`/home/worker/n339/backups/
vector-store.ts.withfix`）から復元し、再度2/2件緑に戻ることを確認した。

### `packages/core/src/__tests__/scored-candidate-tiebreak.test.ts`（新設）

`compareScoredCandidates` を直接ユニットテストする（`threshold-partition.test.ts`
の `candidate()` ヘルパーと同じ作法で `ScoredCandidate` の最小形を組み立てる）:

1. `score.total` が違えばそれだけで決まる。
2. `score.total` が同点なら実効時刻が新しい方が先——入力順序を反転させても
   結果が変わらないことを両方向で確認。
3. `occurredAt` があればそちらを使う（`recordedAt` が逆向きでも同点扱い）。
4. `score.total` も実効時刻も同点なら `memory.id` 昇順にフォールバックする。

**変異試験**: `compareScoredCandidates` を `b.score.total - a.score.total` だけの
旧形へ一時的に戻したところ、4件中3件（タイブレークを検査する歯）が期待通り
赤くなり、1件（`score.total` が違う場合の歯、旧形でも通る経路）は緑のままだった
——これも期待通り。退避コピー（`/home/worker/n339/backups/
recall-runtime.ts.withfix`）から復元し、再度4/4件緑に戻ることを確認した。

---

## 3回以上の再実行での突き合わせ

### `compare` の 322 ターン行（修正後）

DB をまっさらに作り直して**5回** `compare` を実行した（cassette 再生、
`llmMode=recorded`/`embeddingMode=recorded`）:

```
run1: mnemoraChars=4547
run2: mnemoraChars=4547
run3: mnemoraChars=4547
run4: mnemoraChars=4547
run5: mnemoraChars=4547
```

**5/5 が完全一致。** 加えて、`recall().memories` の externalId 集合（どの
Memory が返ったか、`mnemoraChars` という要約値だけでなく中身そのもの）も
**3回の fresh ingest で完全一致**することを確認した（`ann`/`association`
それぞれの externalId 集合が3回とも同一）。

### `compare` の 642 ターン行（修正後）

同様に5回 `mnemoraChars=4476` で一致（修正前から数字自体は変わらない）。
**加えて、修正前は「数字は一致するが中身は毎回違う」ことを実測していたため**、
本 ADR では**中身**（連想枠の externalId 集合）を3回の fresh ingest で
突き合わせた——**3/3 で完全一致**（修正前は3/3とも異なっていた）。⟹ 642行の
潜在的な非決定性も、今回の修正で解消したことを確認した。

### `association-probes`（ADR 0167 の成果が壊れていないことの確認）

`@mnemora/local-embedding`（本物の ONNX 推論）に対して、DB をまっさらに作り直して
**3回**実行し、`measuredAt` を除いて JSON 全体を比較した——**3/3 で完全一致**
（`goldReturned`/`MRR`/`memoryChars`/`associationChars` 等すべての欄を含む）。
ADR 0167 の成果は壊れていない。

---

## 誰が壊れうるか / 引き受けた負債

1. **`recorded_at` の衝突（決定4）**——実運用で高頻度・並列な ingest を行う
   adapter・利用側では、同一 ms（あるいは同一トランザクション）内に複数の
   Memory が作られ、`recorded_at` が完全一致することがありうる。その場合、
   衝突した行どうしの間でだけ ADR 0167 以前の性質（ingest ごとに順序が
   変わりうる）に戻る。**この PR はこの残余を解消していない**——`recorded_at`
   より強い決定的キー（挿入シーケンス列など）は migration を要するため、
   今回は採らなかった（「採らなかった案」3番）。
2. **`lexical-store.ts:138` の同族欠陥は、本 PR では直していない**——別 issue
   相当と判断した（マネージャー同意済み）。語彙チャンネルを使う呼び手が
   同種の重複コンテンツを持つ場合、同じ形の非決定性が起こりうる。ただし
   `recall-runtime.ts` 側の決定2（多層防御）が、`score.total` の同点までは
   吸収する——語彙チャンネル由来の距離・rank 自体のタイは吸収しない。
3. **段3.5（連想枠）は、`VectorStore.search()` が完全な順序を返すという契約に
   依存し続ける**（決定3）。`PostgresVectorStore` 以外の adapter（将来書かれる
   もの）がこの契約を守らなければ、Issue #339 と同じ形の欠陥が再発しうる——
   `packages/core/src/interfaces/vector-store.ts` の doc がこれを明記しているが、
   コードによる強制ではない。

## これが覆るとしたら

1. **`recorded_at` の衝突が実運用で実際に問題になったとき**——`memories` に
   insertion-sequence 列（bigserial 等）を足す migration を検討すること
   （「採らなかった案」3番）。
2. **`lexical-store.ts` 側で同種の非決定性が実際に踏まれたとき**——同じ形の
   tie-break（`id` を最終フォールバックに足す）を `ORDER BY coverage DESC,
   rank DESC` に追加すること。
3. **`packages/core` 内で `VectorStore.search()` を呼ぶ箇所が増え、adapter の
   返却順を暗黙に信頼する箇所が別に増えたとき**——同じ形の歯
   （`recorded_at`/`memory_id` を意図して操作した組み合わせでの検査）を
   その箇所にも足すこと。

## 確かめていないこと

- **CI（GitHub Actions の Postgres service container）が、この容器で使った
  PostgreSQL 17.11 + pgvector 0.8.0 と厳密に同じバージョンかどうか**——ADR 0167
  と同じ限界を引き継ぐ。
- **`recorded_at` の衝突が、CI のように速い・並列度の高い環境で実際に
  どの程度の頻度で起こるか**——測っていない（引き受けた負債1番）。
- **`lexical-store.ts` 側で同種の非決定性が実際に発生するか**——`compare` は
  既定で ANN チャンネルしか使わないため、この PR の範囲では検証していない。
- **10万行規模のテナント（ADR 0111 の領域）での本修正の効果**——ADR 0167 と
  同じく測っていない。

Refs #339
