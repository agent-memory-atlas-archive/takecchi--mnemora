# ADR 0164: recall に `validAt` ゲートを足す — 段1へ押し下げ、`expired`/`not_yet_valid` で名指しする（Issue #280、Issue #202 第2弾）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

[ADR 0145](./0145-valid-from-until-storage.md)（Issue #202 第1弾）が `Memory.validFrom`/
`validUntil` の型・`packages/postgres` の読み書きだけを配線し、「射程外にしたもの」として
残した4項目——(1) `RecallQuery` から「いつ時点で真だった記憶か」を問える口、(2) その絞り込みが
段1（ANN、索引が効く段）に降りているか、(3) `valid_until` を過ぎた記憶が `omitted` で
名指しされるか、(4) 書き込み経路（`ObserveXxxInput`）——を、本 PR（第2弾）で実装する。

- [x] **決定1**: `RecallQuery.validAt?: Date` を足す。「この時刻において真だった記憶」を問う。
      既定は `now`（ゲートは既定で有効。opt-out は `includeOutsideValidity`）。
- [x] **決定2**: `VectorFilter`/`LexicalFilter` に `validAt?: Date` を足し、段1（postgres の
      SQL の `WHERE` 句）へ押し下げる。**新しい索引は足さない。**
- [x] **決定3**: `FilteredOmission.condition` に `"expired"`/`"not_yet_valid"` の2値を足す。
      カウントは `aggregateScope` の `count(*) FILTER` で厳密集計する（`countKind: "exact"`）。
- [x] **決定4**: `ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput` に
      `validFrom?: Date`/`validUntil?: Date` を足し、`occurredAt` と同じ経路
      （`Observation` → `buildNewMemoryFromCandidate` → `NewMemory`）で素通しする。
- [x] **決定5**: `examples/chat` に `validity` probe set/arm/CLI ターゲットを足し、
      `.github/workflows/ci.yml` に非ゲートの `validity` ジョブを新設する。
- [x] **決定6**: `compare`（ADR 0133、required 門）の基準値・配線には一切触れない。

**この PR は `compare`/`retrieval`/`time-term` の挙動を1バイトも変えていない**
（`scenario.ts`/`compare.ts`/`compare-baseline.json` を触っていない——決定6）。

---

## 現状（現物で確認した）

**出所: 私がこの作業環境で実行した（`grep`/`sed`/読解、DB は使っていない）。**

- `packages/core/src/recall.ts` の `RecallQuery` は本 PR 以前、`validAt` に相当する欄を
  持っていなかった（`occurredAfter`/`occurredBefore`（period）・`includeFullyDecayed`
  （忘却ゲート）はあった）。
- `FilteredOmission.condition` は本 PR 以前、7値
  （`"tenant" | "superseded" | "forgotten" | "archived" | "taxonomy" | "period" | "decayed"`）
  だった。ADR 0145 の「射程外にしたもの」節が「6値」と書いているのは、その時点でまだ
  `"decayed"`（ADR 0153）が入る前の記述であり、ADR 0153 が実装した時点で既に7値に
  なっていた——ADR 0145 の記述が古い（本 PR で確かめた）。
- `VectorFilter`/`LexicalFilter` は本 PR 以前、`validAt` に相当する欄を持っていなかった。
- `packages/postgres/src/memory-store.ts` の `aggregateScope` は本 PR 以前、
  `filteredArchived`/`filteredSuperseded`/`filteredForgotten`/`filteredPeriod` の4種類の
  「スコープを定義するフィルタで落ちた件数」だけを持っていた。
- `ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput` は本 PR 以前、
  `validFrom`/`validUntil` を持っていなかった——`Memory.validFrom`/`validUntil`
  （ADR 0145）に非 null を書ける経路は、`MemoryStore.createMemory` を直接呼ぶ
  テスト/スクリプトだけだった。
- `Observation`/`NewObservation`（`packages/core/src/observation.ts`）・
  `observations` テーブル（`packages/postgres/migrations/0001_init.sql`）は本 PR 以前、
  `valid_from`/`valid_until` に相当する列・欄を一切持っていなかった。**これは
  `Memory`/`memories` とは違う**——`memories.valid_from`/`valid_until` は Phase 1 の
  時点（`0001_init.sql`）から存在したが（ADR 0145 が読み書きを配線するまで空だった）、
  `observations` 側は最初から列自体が無かった（本 PR で初めて migration を足す。
  「決定4」参照）。

---

## 決定1: `RecallQuery.validAt?: Date`（`asOf` ではなく `validAt`）

**意味**: 「この時刻において真だった記憶」を問う。

**述語**: `(validFrom IS NULL OR validFrom <= validAt) AND (validUntil IS NULL OR validUntil > validAt)`。

- `validFrom` は**閉じた左端**（`<=`）。
- `validUntil` は**開区間の右端**（狭義の `>`）。**理由**: `VectorFilter.decayFloorAtAfter`
  （ADR 0004/0153）が既に同じ場所（同じ interface）で狭義の `>` を採っている——
  「境界の瞬間そのものはもう真ではない」という読み方に揃える。一方 `occurredAfter`/
  `occurredBefore`（period、ADR 0039）は両端とも包含（`>=`/`<=`）——**この2つの規則は
  出どころが違う**（period は「観測された時刻の範囲」、validity は「効力が切れる境界」）
  ことを、`VectorFilter.occurredAfter` の doc コメントが既に「名前だけで意味論を
  推測しないこと」として警告している。本 PR はその警告に従い、`decayFloorAtAfter`
  側に揃えた。
- **両方 `null` は「いつでも真」と解釈する（「不明」ではない）。** 理由: この PR の
  時点で、`validFrom`/`validUntil` に非 null を書く production 経路が1つも無く
  （ADR 0145「開いている穴」2番、「決定4」参照）、既存行の大多数が `NULL`/`NULL`
  である。「不明」と解釈すると、この述語は既存のほぼ全ての記憶を落とす——
  「いつ時点で真だったか分からない記憶は無いことにする」という、issue が意図しない
  破壊的な挙動になる。

**省略時の既定は `now`**（＝ゲートは既定で効く。`includeFullyDecayed`、ADR 0153 と
同じ opt-out 型）。**根拠**: `valid_until` を過ぎた記憶は定義上もう真ではなく、
黙って返すのは誤り。かつ**この PR の時点で production 経路が1つも非 null を書いて
いない**ため、既定 on にしても述語が恒真になり、既存の挙動は1バイトも変わらない。
これは推測ではなく、**歯で固定した**（`packages/core/src/__tests__/recall-channels.test.ts`
「歯②: 既定は1バイトも変わらない」に `validAt` を通した上で緑を確認——`explain.stages`
に `validAt` の値そのものは新しく出るが、`recall()` が返す `memories`/`omitted` の
中身は1件も変わらない。この歯は「値が両方 null の既存データでは絞りが恒真になる」ことの
実測でもある）。

**opt-out**: `includeOutsideValidity?: boolean`（`includeFullyDecayed` と対称）。
`true` を渡すと `validFrom`/`validUntil` を一切見ない。`validAt` を同時に渡しても
無視される（ゲートそのものが無効になるため）。

---

## 決定2: 段1（索引が効く段）へ降ろす、かつ新しい索引は足さない

`VectorFilter`/`LexicalFilter` に `validAt?: Date` を足し、postgres の SQL の `WHERE`
句に述語を入れる。**`period`（ADR 0059）と同じ形——ANN・語彙の両チャンネルに存在する。**
`decayFloorAtAfter`（ANN だけが持ち、語彙側は core の後置フィルタで受ける非対称、
ADR 0153「決めたこと」3）とは扱いが違う——`validAt` は両チャンネルとも SQL の
`WHERE` で直接絞る（マネージャー決定2「語彙チャンネルの SQL にも直接効く」）。

**受け入れ条件は「絞り込みが段1に降りている」であって「索引を足す」ではない。**
実際に索引は足していない——理由:

1. **述語の選択性は逆向きである。** この PR の時点で、大多数の行が
   `valid_from IS NULL AND valid_until IS NULL` で**述語を通る**
   （「決定1」参照——production 経路が1件も非 null を書いていない）。索引で
   絞れる対象は「述語で落ちる行」であり、その行が少数（実質ゼロ）である以上、
   btree でも部分索引でも計画は改善しない——絞る対象がほぼ存在しないところに
   索引を張っても、スキャンする行数はほとんど変わらない。
2. **ADR 0059 の `idx_memories_period_ann_stage`
   （`packages/postgres/migrations/0003_period_ann_stage_index.sql`）は流用できない。**
   現物を読んで確かめた——この索引は `(tenant_id, status, COALESCE(occurred_at,
   recorded_at))` という**単一の式（単調な1点の値）に対する比較**の式索引である。
   `validFrom`/`validUntil` は**2つの NULL 許容列による区間包含**
   （`validFrom <= x AND (validUntil IS NULL OR validUntil > x)`）であり、1つの
   COALESCE 式に単純化できない——単一列の単調比較を前提にした ADR 0059 の式索引の
   形は、そのまま流用できない。この指摘は ADR 0145「射程外にしたもの」2番が既に
   書いていたものであり、本 PR で現物（migration ファイル）を読んで確認した。
3. `docs/recall.md` §3（**133行目、「partial index は離散値・低カーディナリティの
   フィルタに向くが、連続値の範囲比較には向かない」**）——`validFrom`/`validUntil`
   は連続値（timestamptz）の範囲比較であり、この制約にそのまま当たる。
4. **将来 `valid_until` 非 null の行が多数になったら、この判断は覆る**
   （「これが覆るとしたら」参照）。

**⚠ 推測で書いていない。** 現物の migration（`0001_init.sql`〜`0013_*.sql`、
本 PR が足す `0014_observations_valid_from_until.sql`）と索引定義
（`packages/postgres/src/schema.ts`、`migrations/0003_period_ann_stage_index.sql`）を
読んで、実際に確かめたことだけを上に書いた。**計画（`EXPLAIN`）は測っていない**
——`DATABASE_URL` が無くこの作業環境では本物の Postgres を起動できないため
（「確かめていないこと」参照）。ADR 0059 が行った実測（3窓・4パターンの
`EXPLAIN ANALYZE` 比較）と同水準の検証は、本 PR では一次実測していない。

**多層防御**: `period`/`decayed` と同じく、段1の後にも core の後置フィルタで同じ述語を
もう一度見る（`recall-runtime.ts` の `filteredCandidates` ループ）。`VectorFilter`/
`LexicalFilter` の契約は adapter が実際に適用しなければならない（ADR 0034）が、
正しさの責任は後段にも置く。

---

## 決定3: `omitted` で名指しする — `FilteredOmission.condition` に2値足す

`"expired"`（`validUntil <= validAt`）と `"not_yet_valid"`（`validFrom > validAt`）。

**1値にまとめない。** ゲートは両端を独立に落とす（`validFrom` 超過と `validUntil`
超過は別の原因）。1つの `"invalid"` のような値に束ねると、「まだ来ていないのか、
もう過ぎたのか」を呼び出し側が判定できなくなり、issue が禁じる「片方だけ名指しして
残りが黙って減る」形になる——`"superseded"`/`"forgotten"` を分けた
[ADR 0027](./0027-split-superseded-forgotten-omission.md) と同じ判断。

**ADR 0084/0117/0144 の方針（実装を伴わない値をユニオンに置かない）を守った。**
2値とも同じ PR で実際に生成される経路（`recall-runtime.ts` の
`aggregate.filteredExpired`/`filteredNotYetValid` からの push）とテスト
（`recall-validity.test.ts`・`memory-store-conformance.ts` の新規歯）を持つ。

**カウントは `period` に倣って exact にした。** `RecallScope` に `validAt` を足し、
`aggregateScope` の `count(*) FILTER` で厳密集計する——段1で SQL が落とすので後置
ループでは数えられない、という `period`/`decayed` の先例をそのまま踏襲した。
**構造的に無理だったので `lower_bound` に倒す、という事態にはならなかった**——
`period` と同じ CTE（`scoped`）に列を足すだけで厳密集計できた（postgres 側は
`memory-store.ts` の `aggregateScope`、in-memory 側は `packages/testkit`/`packages/core`
の同名メソッドで、それぞれ同じ形の独立した2条件カウントを実装した）。

`aggregateScope` が呼ばれない経路は無い——`recall-runtime.ts` は常に
`deps.memoryStore.aggregateScope(ctx, scope, ...)` を呼ぶため、in-memory
（testkit）/`packages/core` のテスト用 fake も含め、全ての `MemoryStore` 実装が
`filteredExpired`/`filteredNotYetValid` を持つ必要がある——3実装すべてに追加した。

**`count === 0` のとき omitted に積むかどうかは `period`/`decayed` の作法に合わせた**
——0件なら積まない（`aggregate.filteredExpired.count > 0` を見てから push する）。

---

## 決定4: `Runtime` から書ける口

`ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput` に
`validFrom?: Date`/`validUntil?: Date` を足し、`occurredAt` と**同じ経路**
（`ObserveXxxInput` → `Runtime.observe` → `Observation` →
`buildNewMemoryFromCandidate` → `NewMemory`）で素通しする（ADR 0037「呼び出し側が
渡す」規律）。zod schema も同様に更新した。

**⚠ ここで設計の前提が現物と食い違った点（報告する）**: マネージャー決定4の文面は
「`occurredAt` と同じ経路で…素通しする」だが、**`occurredAt` の経路は
`Observation`/`observations` テーブルに列を持つことが前提になっている**——
`extract: 'deferred'` を選ぶと、抽出は `outbox` 経由で後から `processExtractJob`
（`runtime.ts`）が拾い、そこでは `MemoryStore.getObservation` で**DB から読み直した**
`Observation` しか手元に無い（元の `ObserveXxxInput` はとうに破棄されている）。
`occurredAt` はこの理由で `observations.occurred_at` 列を持つ。

**⟹ `validFrom`/`validUntil` を deferred 経路でも保持するには、`Observation`/
`NewObservation` に同名フィールドを足し、`observations` テーブルにも列を足す必要が
あった。** これは「新しい索引は足さない」（決定2）とは別の話——`observations` の列は
recall 側の索引選択性の話ではなく、書き込み経路の完全性（sync/deferred のどちらでも
値が失われない）の話である。**マネージャーの元の指示が想定していなかった規模の
変更（`observations` テーブルへの migration）になったので、ここに明記して報告する**
——`packages/postgres/migrations/0014_observations_valid_from_until.sql`
（`ALTER TABLE observations ADD COLUMN valid_from timestamptz, ADD COLUMN
valid_until timestamptz`）。禁止事項（`docs/autonomy.md` §3）には当たらないと判断し、
実装を進めたが、設計の前提が現物と食い違った点として明記する。

**粒度の限界**: observation 単位のスカラーなので、1回の `observe()` から複数の
候補が抽出されると全候補が同じ区間を共有する——`occurredAt` が既に抱えている限界
（ADR 0037 が受け入れ済み）と同型であり、先例に倣う。

**抽出（LLM）に推測させる案は採らない**（Issue #202/#280 が明示的に射程外にしている。
「採らなかった案」参照）。

**`buildReflectedMemory`/`buildConsolidatedMemory` は今回触らない**——「射程外に
したもの」参照。

---

## 決定5: 測る器

Issue #280 が「着手する人が最初にやるべきことは (2) の測る器」と明示している。

- `examples/chat/src/validity-probe-set.ts`: `time-term-probe-set.ts`
  （ADR 0058）の設計思想を踏襲——**fact/query の本文をペアで厳密に同一にし、
  `validFrom`/`validUntil` だけを変える。** 2 probe:
  - `address`（`otherReason: "expired"`）: 「去年の住所」（`validFrom` 365日前・
    `validUntil` 30日前）と「今の住所」（`validFrom` 30日前・無期限）。既定
    （`validAt` 省略）では「今の住所」だけが返り「去年の住所」は `omitted` に
    `"expired"` で名指しされること、`validAt` を100日前に指定すると**逆に**
    「去年の住所」が返り「今の住所」が `"not_yet_valid"` で落ちること
    （受け入れ条件1本体——「いつ時点で真だったかを問える」）を測る。
  - `subscription-plan`（`otherReason: "not_yet_valid"`）: 「今のプラン」
    （`validFrom` 10日前・無期限）と「来月からの新プラン」（`validFrom` 30日後）。
    既定では「今のプラン」だけが返り「新プラン」は `"not_yet_valid"` で
    落ちることを測る。
  - 両 probe とも `includeOutsideValidity: true` でゲートが外れ、両方返ることを
    測る。
- `examples/chat/src/validity-arm.ts`: `time-term-arm.ts` に倣うが、
  **`MutableClock` は要らない**——動かす項は `recordedAt`（壁時計）ではなく
  `validFrom`/`validUntil`（`observe()` に明示的に渡す `Date`）なので、`Clock` を
  注入し直す必要がない。`MNEMORA_LLM=deterministic`/`MNEMORA_EMBEDDING=deterministic`
  既定、カセット新規記録なし。
- ⭐ **memory を作る経路は `Runtime.observe()` の `validFrom`/`validUntil`
  （決定4）を使う。** `MemoryStore` を直に叩いていない——書き口が端から端まで
  通ることの実演になっている。
- `examples/chat/src/validity-json.ts`: `time-term-json.ts` に倣う機械可読出力
  （`MNEMORA_VALIDITY_JSON`）。
- CLI ターゲット `validity`（`examples/chat/package.json`・`cli.ts`）と、
  `.github/workflows/ci.yml` の `time-term` と同型の**非ゲート**ジョブ `validity`
  を新設した。**required 6門には一切触れていない**（`jobs:` のキー一覧を
  `js-yaml` で機械的に確認済み——`build`/`example-chat`/`postgres`(×2 regime)/
  `postgres-regime-coverage`/`root-gate-db-stage` はすべて変更前と同一の
  ジョブ名で残っている）。

**基準値ファイル（`time-term-baseline.json` のような形）は用意していない。**
`validity` ジョブはこの PR で初めて作るため、比較対象になる「初回 CI の実測値」が
まだ存在しない（ADR 0120 §5 の手順は「初回 CI の結果をそのまま基準値としてコミット
する」という順序であり、その初回 CI 自体がまだ走っていない）。次の担い手が、
この PR の CI が出す `validity` artifact を基準値としてコミットする形を想定する
（「確かめていないこと」参照）。

---

## 決定6: `compare` の基準値を動かさない

`examples/chat/src/scenario.ts`/`compare.ts`/`mnemora-path.ts`/`naive-path.ts`・
`examples/chat/compare-baseline.json` のいずれも触っていない
（`git diff --stat` で確認——後述「測ったこと」）。新しい書き口（`validFrom`/
`validUntil`）を `scenario.ts` に配線するのは次の PR の仕事であり、本 PR の
射程外である（「射程外にしたもの」参照）。

**理論的リスク（段1の SQL に恒真の述語を足すと ANN の計画が変わりうる）について**:
`validAt` を渡さない・かつ既存データが両端 `NULL` である限り、`WHERE` 句に足す条件は
`(NULL::timestamptz IS NULL OR ...) AND (NULL::timestamptz IS NULL OR ...)` の形
——`validAt` パラメータ自体が渡らないケース（`includeOutsideValidity: true`）では
条件そのものが `WHERE` 句に現れない（`opts.filter.validAt !== undefined` のガードで
分岐している）ため、`compare`/`scenario.ts` が使う既定の `recall()` 呼び出し
（`validAt`/`includeOutsideValidity` のどちらも渡さない）では、**`validAt` は
`now` になり、`WHERE` 句に新しい条件行が実際に追加される**。この条件は既存データ
（両端 NULL）に対しては恒真だが、**プランナが見る条件の数自体は増えている**ため、
ANN の計画が変わる可能性は理論上ゼロではない。**この作業環境では Postgres を
起動できず、実際に `EXPLAIN` を比較していない**——CI の `examples/chat`
（`compare` を含む）ジョブの結果を見て、退行があれば**基準値を書き換えて通そうと
せず、止めて報告する**（マネージャー指示のとおり）。

---

## 北極星の5つの問いに実際に当てた結果

| 問い | この判断にどう当たったか | 落ちた案 |
|---|---|---|
| **1**（毎回渡す量を減らす方向に働くか） | 既定でゲートが効くことで、「もう真ではない事実」（期限切れの古い住所など）が候補から外れる——同じ `limit` 枠を、いま真である記憶で埋める方向に働く。既存データ（両端 null）ではこの効果はまだ現れない（「これが覆るとしたら」参照）。 | **`validAt` を渡したときだけ効く opt-in 案**——既定を変えないなら、`valid_until` を書く経路（決定4）が育つまで、この機能は事実上死んだコードになる。ADR 0153 と同じ理由でこの問いに一歩も応えない。 |
| **2**（これを無効にしたとき、Memory Framework として成立するか） | 既定 ON だが、明示的な opt-out（`includeOutsideValidity`）を必ず持たせた。 | 逃げ道の無い既定 ON——`validFrom`/`validUntil` の意味論自体を疑い直したい呼び出し側の逃げ道が要る。 |
| **3**（選ばれた理由を、後から説明できるか） | `"expired"`/`"not_yet_valid"` を分けて名指しし、`count`/`countKind` を exact にした。`explain.stages` の `candidate_generation.detail.validityGate` にも「押し下げたか無効か」を出す。 | 1つの `"invalid"` に束ねる案・`explain` に何も出さない案——どちらも「なぜ無いのか」の説明力を落とす。 |
| **4**（AI の推論と、ユーザーが言った事実を区別しているか） | このゲートは `provenance.kind` に触れない。無関係。 | 落ちる案なし。 |
| **5**（LLM を呼ばずに済ませられないか） | **抽出に「いつまで真か」を推測させる案を明示的に却下した**（issue 本文・マネージャー決定4の注記どおり）。書き口は `ObserveXxxInput` という、呼び出し側が明示的に渡す形に限定した。 | 抽出プロンプトへ1文足す案——この問いでそのまま落ちる。 |

---

## 採らなかった案

### `RecallQuery` の欄名を `asOf` にする

却下。マネージャー決定1が名前を指定した（`validAt`）。`asOf` は一般的な「いつ時点の
状態か」を表す語だが、`validFrom`/`validUntil` という欄名との対応が薄い——
`validAt` のほうが「`validFrom`/`validUntil` の区間に対して問う時刻」であることが
名前から読み取れる。

### `expired`/`not_yet_valid` を1つの `"invalid"` にまとめる

却下。「決定3」参照——ADR 0027 と同じ理由。

### 索引（`(tenant_id, status, valid_from, valid_until)` の複合 btree、または部分索引）を足す

却下。「決定2」参照——選択性が逆向き（大多数が述語を通る）であり、
`docs/recall.md` §3 の partial index 制約にも当たる。

### 抽出（LLM）に「この事実がいつまで真か」を推測させる

却下。issue 本文が明示的に射程外にしている。北極星の問い5（LLM を呼ばずに済ませ
られないか）にも当てて落ちる——`ObserveXxxInput` 経由の呼び出し側渡しを先に検討
していない段階で LLM 推測へ飛ぶのは、ADR 0037/0055 が確立した規律に反する。

### `validFrom`/`validUntil` を `Observation` に足さず、sync 経路だけの一時変数として `runExtraction` に別引数で渡す

却下（検討したが、決定4の「⚠ 設計の前提が現物と食い違った点」で書いたとおり
deferred 経路で値が消えるため採らなかった）。`occurredAt` と同じ経路に揃えることで、
sync/deferred のどちらでも値が保持されることを構造的に保証する。

### `compare`/`scenario.ts` に `validFrom`/`validUntil` を配線し、量への効果も測る

却下（この PR では）。決定6・「射程外にしたもの」参照——既存データがまだ両端 null
しか持たないため、配線しても効果が測れない（既存の recall/compare 呼び出しが
`validFrom`/`validUntil` を書く経路を一切通っていない）。

---

## 射程外にしたもの

### 1. `buildReflectedMemory`/`buildConsolidatedMemory`（reflect/consolidate の派生 Memory）

**触っていない**——`validFrom`/`validUntil` は null のまま（＝「いつでも真」）。
理由: 複数の元 Memory が異なる区間を持つとき、どう引き継ぐか（最新を採る／区間の積を
採る／和を採る）は別の判断であり、null のままが最も安全（何も落ちない）。

### 2. 抽出（LLM）が `validFrom`/`validUntil` を埋めるかどうか

**採らなかった案参照。** issue 本文・マネージャー決定4が明示的に射程外にしている。

### 3. `examples/chat/src/scenario.ts` への配線

**触っていない**（決定6）。`compare`（required 門）の基準値に影響しないよう、
意図的に配線を避けた。次の PR の仕事。

### 4. 段1（ANN・語彙）への索引追加

**足していない**（決定2）。「これが覆るとしたら」参照。

### 5. 連想枠（Issue #200、`recall-runtime.ts` の段3.5）への `validAt` の適用

**適用していない。** 現物を読んで確認した——段3.5（連想）は、そもそも
`decayFloorAtAfter`（忘却ゲート、ADR 0153）も一度も見ていない
（`vectorStore.search` の filter に `decayFloorAtAfter` を渡さず、`memory` の後置
チェックにも `decayFloorAt` の判定が無い）。**これは ADR 0153 が残した既存の
未対応であり、本 PR が新しく作った穴ではない。** `validAt` だけを連想枠に足すと、
「忘却ゲートは掛からないが validity ゲートは掛かる」という新しい非対称を作ることに
なるため、本 PR では両者を揃えて「連想枠はどちらのゲートも見ない」という現状を
維持した。連想枠にゲートを揃えて足すなら、忘却ゲートと validity ゲートを同じ PR で
一緒に足すべきであり、単独の issue/ADR に値する。

### 6. `docs/memory-model.md`/`docs/roadmap.md` の表の Phase 欄を書き換える

**書き換えていない。** ADR 0145 と同じ判断——本 PR は `recall()` 側の実装を完了させたが、
「4本目・5本目の時計が Phase 1 で完成した」と表の値自体を書き換えるのは、issue 全体
（7つの受け入れ条件）が全て揃ってから検討すべきであり、`docs/memory-model.md` §3・
`docs/roadmap.md` §3 の脚注（ADR 0145 が既に足したもの）を更新するに留める判断も
あり得るが、本 PR では文書更新そのものを見送った（診断: 実装漏れではなく、
「表の記述をいつ更新するか」という別の判断だと考えたため）。

---

## 開いている穴・引き受けた負債

1. **`packages/postgres` に対する実際の書き込み・読み戻しは、この作業環境では
   一度も実行できていない**（`DATABASE_URL` 無し）。`observations`/`memories` への
   `valid_from`/`valid_until` の読み書き・段1の SQL の絞り込み・`aggregateScope` の
   `count(*) FILTER` は、静的な読解と型検査（`tsc`）だけで確認しており、本物の
   Postgres に対する実行は CI の DB ジョブで初めて確認される。
2. **`EXPLAIN` を一切測っていない**（決定2の「⚠ 推測で書いていない」参照）。
   「索引を足さない」という判断の根拠は、現物の migration/索引定義の読解と
   `docs/recall.md` の既存の指摘であり、実行計画そのものの実測ではない。
3. **`compare`/`retrieval`/`time-term` に対する退行の実測をしていない**
   （決定6「理論的リスク」参照）——CI の結果を見て判断する。
4. **連想枠（Issue #200）は忘却ゲート・validity ゲートのどちらも掛からないままである**
   （「射程外にしたもの」5番）。
5. **`validity` ジョブに基準値ファイルが無い**——次の担い手が、この PR の初回 CI の
   実測値を基準値としてコミットする作業が残る（ADR 0120 §5 と同じ手順）。
6. **既存データが両端 null しかない前提のもとでの「非破壊」の主張は、`validFrom`/
   `validUntil` に非 null を書く運用が実際に始まった瞬間から成立しなくなる。**
   これは意図した設計（決定1の既定 on の根拠そのもの）だが、運用開始後は
   「recall の結果が変わった」という問い合わせが来る可能性がある——`includeOutsideValidity`
   という逃げ道はあるが、既定挙動の変化そのものは避けられない。

## これが覆るとしたら

- **`valid_from`/`valid_until` に非 null を書く行が実際に増え、述語の選択性が
  逆転したとき**——大多数の行が区間を持つようになれば、「決定2」で索引を足さなかった
  理由（選択性が逆向き）が消え、複合索引（またはバケット列）を足す判断に変わる。
  そのときは `EXPLAIN` の実測（ADR 0059 が行ったのと同水準の実測）が必要になる。
- **`ObserveXxxInput` 経由で書かれる区間が、複数の Memory 候補にまたがる粒度の
  細かさを要求されたとき**——「決定4」の限界（observation 単位のスカラー）が
  塞がらなくなり、`ExtractedMemoryCandidate` 単位で区間を持たせる設計（抽出結果の
  スキーマ自体の変更）が要る。
- **連想枠（Issue #200）に忘却ゲート・validity ゲートを揃えて足す判断が下されたとき**
  ——「射程外にしたもの」5番が塞がる。
- **`scenario.ts`/`compare` に `validFrom`/`validUntil` を配線する判断が下されたとき**
  ——量への効果（「もう真ではない事実を積まなくなった分、コンテキストが減るか」）を
  実測できるようになる。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。**

- `pnpm --filter @mnemora/core run typecheck` / `run test`: 緑
  （720 件、既存707件 + 新規13件 `recall-validity.test.ts`）。
- `pnpm --filter @mnemora/testkit run typecheck` / `run test`: 緑
  （289件、既存280件 + 新規9件——`vector-store-conformance.ts` 3件・
  `lexical-store-conformance.ts` 2件・`memory-store-conformance.ts` 4件）。
- `pnpm --filter @mnemora/postgres run typecheck`: 緑。
- `pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/mapping-observation-valid-from-until.test.ts
  src/__tests__/mapping-valid-from-until.test.ts`: 緑（6件、DB 不要）。
- `pnpm run typecheck`（ルート、全 workspace）: 緑。
- `pnpm run test`（ルート）: 緑（946件 → 本 PR で948件に増、DB テストは
  「実行していません」の告知どおり未実行）。
- `.github/workflows/ci.yml` の YAML を `pnpm dlx js-yaml` でパースし、
  `jobs` のキー一覧が変更前の11ジョブ+`validity`の12ジョブになっている
  （既存11ジョブのキー名は1つも変わっていない）ことを確認した。
- **変異試験**（下記「変異試験」節）。

### before/after（決定5、Issue #280 の指示）

**「先に器を作って実装前の数字を取る」は、この作業環境では実行できなかった。**
理由は2つある:

1. **`examples/chat` のベンチは `DATABASE_URL`（本物の Postgres）を要求する**
   （`docs/autonomy.md` §1.1）。この作業環境には無い。
2. **`validity` ジョブ自体がこの PR で初めて存在する。** 「実装前」の CI 実行という
   ものが構造的に存在しない——このジョブは実装（決定1〜4）と同じ PR で追加した
   ため、「ジョブは在るが実装が無い状態」を経由していない。

**⟹ before/after の実測は、CI でしか取れない。** 本 PR の CI が出す `validity`
artifact（`validity.json`）が、この機能の「初めての実測値」になる——時系列上の
「before」は「このクエリの形自体が存在しなかった」ことと同義であり、数値的な
比較対象を持たない。次の担い手（または本 PR のレビュー）が、CI の実測値を見て
2 probe すべてが期待どおりの `outcome`（`current` は既定で返り `other` は
`omitted` で名指しされ、`address` probe は過去の `validAt` で逆転する）になって
いることを確認する必要がある——**これは「確かめていないこと」として明記する。**

---

## 変異試験（歯が実際に噛むことを示す。壊した入力で赤く、直したら緑に戻る）

**`docs/autonomy.md` §4 の指示どおり、`git checkout <file>` を使わず退避コピー
（`/tmp/mutation-backups/`）から戻した。以下の4つは全て実際にコマンドを実行して
確認したものであり、推測・予測ではない。**

### 変異A: `recall-runtime.ts` の `validAt` の既定値フォールバックを削る

```
cp packages/core/src/recall-runtime.ts /tmp/mutation-backups/recall-runtime.ts.orig
```

`const validAt = validatedQuery.validAt ?? now;` を
`const validAt = validatedQuery.validAt;` に変異——`validAt` を省略したときの
既定 `now` が失われる。

- **変異後**: `pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-validity.test.ts` → **赤**（13件中5件 failed）:
  段1へ渡る `filter.validAt` が `undefined` になる歯・既定で期限切れ/未到来が
  隠れることを見る4つの歯・語彙チャンネルの歯、の計5件が実測どおり落ちた。
- 退避コピーから復元:
  `cp /tmp/mutation-backups/recall-runtime.ts.orig packages/core/src/recall-runtime.ts`
  → 元ファイルと `diff` が0行であることを確認 → 再実行 → **緑**（13件全て pass）。

### 変異B: `recall-runtime.ts` の `omitted` push で `condition` のラベルを入れ替える

```
cp packages/core/src/recall-runtime.ts /tmp/mutation-backups/recall-runtime.ts.origB
```

`filteredExpired` の件数を push する箇所の `condition: "expired"` を
`condition: "not_yet_valid"` に変異（値そのものは正しい `filteredExpired.count`
のまま、ラベルだけ誤らせる）。

- **変異後**: 同じ歯を実行 → **赤**（13件中1件 failed）: 「条件3」の歯が、
  `omitted` に `{ condition: "expired", ... }` を期待したところ
  `{ condition: "not_yet_valid", ... }` が返り落ちた（実際の diff 出力を確認した）。
- 退避コピーから復元 → 元ファイルと `diff` が0行であることを確認 → 再実行 → **緑**。

### 変異C: `packages/testkit` の in-memory `aggregateScope` で境界を1文字動かす

```
cp packages/testkit/src/__fixtures__/in-memory-memory-store.ts /tmp/mutation-backups/in-memory-memory-store.ts.orig
```

`const isNotYetValid = memory.validFrom != null && memory.validFrom > scope.validAt;`
の `>` を `>=` に変異——「`validFrom` が境界ちょうどなら in scope（真になっている）」
という決定1の境界規則を壊す。

- **変異後**: `pnpm --filter @mnemora/testkit run test` → **赤**（289件中1件 failed）:
  「aggregateScope は validFrom が validAt より後の Memory を…」の歯が
  `totalInScope` に期待した1（境界ちょうどの1件）が0になって落ちた
  （実際のエラー出力: `expected +0 to be 1`）。
- 退避コピーから復元 → 元ファイルと `diff` が0行であることを確認 → 再実行 → **緑**
  （289件全て pass）。

### 変異D（穴の発見 → 塞いだ）: `FilteredOmission.condition` の zod enum から `"not_yet_valid"` を落とす

```
cp packages/core/src/recall.ts /tmp/mutation-backups/recall.ts.orig
```

`FilteredOmissionSchema` の `condition` enum から `"not_yet_valid"` を削除する変異。

- **型検査（穴を見つけた時点）**: `pnpm --filter @mnemora/core run typecheck` →
  **緑のまま**（型エラーにならなかった）。理由を調べた——`FilteredOmissionSchema` は
  `satisfies z.ZodType<FilteredOmission>` という**片方向の代入可能性チェック**であり、
  「スキーマが推論する型が `FilteredOmission` に**代入できるか**」だけを見る。
  `condition` の値域が本来の10値からナロー化された9値（`"not_yet_valid"` を除く）
  になっても、その9値はどれも `FilteredOmission.condition`（より広いユニオン）の
  要素なので代入可能性は崩れない——**`satisfies` は「値域が本来より狭いこと」を
  検出できない**、という一般的な限界がここで実際に確認できた（この知見は
  `FilteredOmission.condition` に限らない、他の union にも効く一般的な限界として
  残す）。
- **テスト（穴を見つけた時点）**: `pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-validity.test.ts src/__tests__/recall.test.ts` → **緑のまま**
  （68件全て pass）。理由: `recall-validity.test.ts` は `runtime.recall()` の戻り値を
  直接比較しており zod の enum 制約を経由しない。`recall.test.ts` の
  `OmissionSchema` の網羅テスト（題「10 の kind すべて」）も `kind` の10種類だけを
  検査する設計で、`condition` の全値までは検査していなかった。
- ⟹ **穴を塞いだ。** `packages/core/src/__tests__/recall.test.ts` に
  `ALL_FILTERED_CONDITIONS`（`Record<FilteredOmission["condition"], true>` の
  オブジェクトリテラル）を足した。**この定義自体がコンパイル時の網羅性チェックになる**
  ——`FilteredOmission.condition` に新しい値が増えたのにここへ足し忘れると
  `tsc` が「キーが足りない」と落ち、逆に存在しない値を足しても落ちる（この
  「足し忘れ検出」自体を、一時的に `FilteredOmission.condition` へ架空の値
  `"future_test_value"` を足す変異で実際に確認した——`tsc` が
  `TS2741: Property 'future_test_value' is missing in type ...` を出して落ち、
  復元後は緑に戻った）。そのキー一覧を `it.each` で回し、各値が
  `OmissionSchema.safeParse({ kind: "filtered", condition, ... })` を通ることを
  検査する（9ケース）。
- **同じ変異Dをもう一度掛けて確認した**: `FilteredOmissionSchema` の enum から
  `"not_yet_valid"` を再度削除 → `pnpm --filter @mnemora/core run typecheck` は
  緑のまま（`satisfies` の限界は変わらない）だが、
  `pnpm --filter @mnemora/core exec vitest run src/__tests__/recall.test.ts` は
  **赤**（新しく足した歯「'filtered' の condition: not_yet_valid は
  OmissionSchema を通る」が `expected false to be true` で failed。他63件は pass）。
  退避コピーから復元 → 元ファイルと `diff` が0行 → 再実行 → **緑**（64件全て pass）。

**⟹ 変異A・B・C・D（塞いだ後の再実行）は歯が実際に噛むことを示せた
——4件とも、壊した入力で実際に赤くなり、退避コピーから戻すと実際に緑へ戻ることを、
コマンドの実行と出力で確認した。変異Dが最初に見つけた「穴」（`satisfies` が値域の
狭小化を検出しない・既存の網羅テストが `condition` まで見ていなかった）は
本 PR で塞いだ——「開いている穴」からは外し、この節に記録として残す。**

**⚠ postgres の SQL 層（`memory-store.ts`/`vector-store.ts`/`lexical-store.ts`）に
対する変異試験は、この作業環境では実行していない**（`DATABASE_URL` 無し）。
SQL は文字列テンプレートなので `tsc` の型検査には掛からず、変異を入れても
`typecheck` は緑のままになる——**これは実行して確かめた**（`memory-store.ts` の
`isExpired` 条件から `valid_until IS NOT NULL AND` を削る変異を実際に加えて
`pnpm --filter @mnemora/postgres run typecheck` を実行し、緑のままであることを
確認してから退避コピーで復元した）。**ただし、この変異が実際に赤くなるかどうかは
本物の Postgres が無いと確認できず、CI の DB ジョブに委ねる。**

---

## 確かめていないこと

- **本物の Postgres に対する実行**（`valid_from`/`valid_until` の読み書き・段1の
  SQL・`aggregateScope`）。`DATABASE_URL` が無い。CI の DB ジョブで見る。
- **`EXPLAIN` による実行計画の実測**（決定2「新しい索引を足さない」の根拠は
  読解であり、計画の実測ではない）。
- **`compare`/`retrieval`/`time-term` への退行の有無**（決定6「理論的リスク」）。
  CI の結果を見る。
- **`validity` arm の before/after の実測数字**——「測ったこと」節のとおり、
  CI でしか取れない。この PR の CI が最初の実測になる。
- **postgres SQL の `isExpired`/`isNotYetValid` 条件の変異を、実際に DB で実行して
  赤くなることの確認**（`typecheck` が緑のままであることは実測したが、実行結果は
  未確認——「変異試験」節参照）。
- ~~`FilteredOmissionSchema.condition` の全値を直接検査する歯が無いこと~~
  **→ 塞いだ**（`recall.test.ts` の `ALL_FILTERED_CONDITIONS`、「変異試験」変異D
  参照）。`satisfies z.ZodType<...>` が値域の狭小化を検出しないという限界自体は
  型システムの一般的な性質であり、これは変わらない——ここで確かめたのは
  「この repo のこの箇所については、別の歯（`Record` の網羅性 + zod の
  `safeParse`）で塞いだ」ことである。
- **連想枠に忘却ゲート/validity ゲートを揃えて足すべきかどうかの判断**
  （射程外6番として提起のみ）。

## 追加補足: `Observation` への migration（決定4の逸脱）について

`packages/postgres/migrations/0014_observations_valid_from_until.sql` は、
`docs/autonomy.md` §3 の⛔一覧（publish・Release・version 上げ・north-star 書き換え・
ライセンス/パッケージ名/依存方針変更）のいずれにも当たらないと判断し、実装した。
`docs/autonomy.md` §3.1「技術的に決められるなら決めて、理由を ADR に書く」の適用——
`occurredAt` と同じ経路に揃えるという技術的な必然（deferred 抽出で値が消えることを
防ぐ）から導かれる判断であり、製品・事業・安全性の判断ではないため、
`docs/roadmap.md` §5 には足していない。
