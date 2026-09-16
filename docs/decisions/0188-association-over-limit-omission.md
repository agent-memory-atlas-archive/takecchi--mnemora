# ADR 0188: 連想枠（段3.5）の `maxCount` 切り捨てを `omitted` に名乗らせる — `over_limit` に `stage` を足す（Issue #375）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0172 / 0173 の体裁を踏む）。

- **【現物】** — この repo のコード・文書・git 履歴を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`gh`/`vitest`/`tsc`/`eslint`/`prettier` 等を
  走らせて確かめた。DB を要する測定は、既存の使い捨て可能な Postgres クラスタ
  （`postgresql://postgres@localhost:5433/postgres`、PostgreSQL 17.11 + pgvector 0.8.0）に
  対して行った。
- **【受】** — [Issue #375](https://github.com/takecchi/mnemora/issues/375) 本文の実測報告
  として受け取り、その数値自体は再導出していない（出所を明記する）。

---

## 結論（先に）

**`recall()` の段3.5（連想枠、[ADR 0151](./0151-recall-association-unprompted.md)）が
`RecallAssociationQuery.maxCount` で候補を切り捨てるとき、`omitted` に一度も
積まれていなかった。** ⟹ 呼び手は「連想候補が無かった」のか「候補はあったが
`maxCount` で切られた」のかを区別できなかった。

**直し方は、新しい `kind` を作るのではなく、既存の `over_limit`（段2の
`RecallQuery.limit` 切り捨てが既に使っている札）へ `stage: 'rescore' | 'association'`
を足す形にした。**——2つの切り捨ては「ゲートと閾値を通過した集合を、この段自身の
上限で切っただけ」という**同じ形の事象**であり、区別すべきは事象の種類ではなく
**どの上限（`limit` か `maxCount` か）を動かせば直るか**である。この判断の形は、
[ADR 0173](./0173-decayed-omission-counted-by-aggregate-scope.md) が「新しい `kind` では
なく `filtered.condition` に値を足す」を選んだのと同じ理由に基づく。

⭐ **北極星の物差し（`compare` の `mnemoraShareOfNaiveChars` / `factStatementSurvived`）は
動かない**（下記「決めたこと」5番で理由を述べる、実際の CI 結果は PR 本文に書く）。

**この欠落は、[docs/north-star.md](../north-star.md)「目指す姿」6番目——
「知らないことを、知らないと言える。」「見つからなかった」と「探していない」を、
同じ顔で返さない——に正面から当たる。** `maxCount` で切られた連想候補は
「探して、見つかったが、切った」のに、`omitted` はそれについて何も語らない
——呼び手から見ると「そもそも連想候補が無かった」場合と**同じ顔**で返る。
`docs/recall.md` が `decayed` の同種の欠落（ADR 0153 の負債、ADR 0173 が正した）を
「目指す姿」項目6との食い違いと呼んでいるのと同じ理由で、この `slice` の無言の
切り捨ても同じ食い違いである。

---

## 1. 【現物】何が起きていたか

`main` の `packages/core/src/recall-runtime.ts:1163-1164`（Issue #375 が指摘した行、
本 ADR の作業時点でも同じ）:

```ts
associationHits.sort((a, b) => b.similarity - a.similarity);
const selectedHits = associationHits.slice(0, associationQuery.maxCount);
```

- `associationHits` は、複数アンカー分の `VectorStore.search()` 結果を集約し、
  既に忘却ゲート・`validAt` ゲート（[Issue #347](https://github.com/takecchi/mnemora/issues/347) /
  [ADR 0172](./0172-association-passes-decay-and-validity-gates.md)）・除外集合・
  `minSimilarity` を通過し終えた候補プールである。`anchorCount`（既定3）×
  `kPrime`（既定 `limit × overFetchFactor` = 40）で最大120件規模になりうる
  （Issue #375 の実測）。
- そこから `maxCount`（呼び手が渡す。`examples/chat` は10）件だけを残す
  `slice` の**前後、`recall-runtime.ts` の該当ブロックに `omitted.push` が
  1つも無かった。**
- **Issue #375 の10,000件規模の実測**（1テナント10,000行、256次元、`local` 埋め込み、
  HNSW + `ANALYZE`、12 probe、`off`/`on maxCount=3,5,10` の4 arm）: gold が返らなかった
  276通りすべてで `result.omitted` は例外なく `[{"kind":"over_limit","count":30,
"countKind":"exact"}]` の1件だけだった。**これは `off` arm（`association` を渡していない）
  でも同じ形で出る**——段2の構造的な札であり、連想枠固有の理由ではない。
  `below_threshold`/`budget_dropped`/`unit_assembly_dropped`/`stage_skipped` といった
  連想枠に紐づきうる種別は、276通り中一度も現れなかった。【受、Issue #375 本文】

  **⚠ この4 arm のうち3つ（`on maxCount=3,5,10`）は、`packages/core` の既定が
  off だった時点（本 ADR の作業時点でも同じ）で `association: { maxCount: N }` を
  呼び手が明示的に渡し、連想枠を実際に作動させた計測である。** ⟹「`omitted` に
  連想枠由来の札が一度も出なかった」は、**連想枠を明示的に on にした arm でも
  出なかった**という意味であり、⛔「既定が off だったから、そもそも段3.5が
  走っていなかっただけ」ではない。段3.5 自体は3つの `on` arm で実際に走り、
  `associationHits.slice(0, maxCount)` も実行されていたはずだが、その切り捨てが
  `omitted` に一度も現れなかった。【受、Issue #375 本文】

  **この前提は、PR #386（連想枠の既定を on にする、自称 ADR 0187）が着地した後に
  より重い意味を持つ。** 現状この欠落は、呼び手が `association` を明示的に渡した
  経路でしか起きない。PR #386 が着地すると、段3.5 は `packages/core` の**既定
  経路**で走るようになり、この `slice` も既定経路の一部になる——「連想候補は
  あったが黙って切り捨てられた」が、呼び手が何も指定しなくても起こり得る欠落に
  変わる。**⟹ 本 PR（Issue #375）を PR #386（ADR 0187）より先に着地させる**
  ——オーナー判断（規模の小さいほうを先に。本 PR は8ファイル、PR #386 は
  19ファイル）だが、この前提の順序としても理に適う: 既定 on になってから
  `stage` の無い `over_limit` が既定経路で日常的に出る期間を作らない。

⚠ `recall-runtime.ts` の同じブロックに在る「🔴 落ちた件数はここでは数えない」という
コメントは、**この `slice` より後**に置かれた多層防御（`survivesValidityGate`/
`survivesDecayGate` の後置と、二重計上を避けるために Issue #329 / ADR 0173 へ数え方を
委ねた話）についての注記であり、**`slice` そのものの切り捨てとは別物**である
（Issue #375 が明示的に確認済み）。本 ADR が扱うのはこちらの `slice` である。

---

## 2. 北極星の5つの問いに実際に当てた結果

| 問い                                      | この判断にどう当たったか                                                                                                                             | 落ちた案                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**（毎回渡す量を減らす方向に働くか）   | `omitted` に1エントリ（数十バイト）増えるだけで、`memories` の量は1バイトも変わらない。むしろ「`maxCount` を上げるべきか」の判断材料が呼び手に渡る。 | —                                                                                                                                                             |
| **2**（無効にしても成立するか）           | `association` を渡さない呼び出しでは、この段自体が走らない（`associationQuery !== undefined` の外側）。⟹ 挙動は1バイトも変わらない。                 | —                                                                                                                                                             |
| **3**（選ばれた理由を後から説明できるか） | **これが本題**——「連想候補が無かった」と「候補はあったが `maxCount` で切られた」が、初めて別の顔で返る。                                             | **`over_limit` とは別に新しい `kind`（例: `association_over_limit`）を作る案**（§3「採らなかった案」1番）。型としては説明力が同じで、union を無駄に太らせる。 |
| **4**（推論と事実を区別しているか）       | 該当しない——この判断は件数の出所（JS 側で既に確定した集合の内訳）の話であり、provenance に触れない。                                                 | —                                                                                                                                                             |
| **5**（LLM を呼ばずに済ませられないか）   | 既存の `slice` の直後に配列長を比較するだけ。DB 往復も LLM 呼び出しも増えない。                                                                      | —                                                                                                                                                             |

---

## 3. 決めたこと

1. **`OverLimitOmission` に `stage: 'rescore' | 'association'` を足す（必須フィールド）。**
   `packages/core/src/recall.ts` の型・`OverLimitOmissionSchema`（zod）の両方を変更する。
   **既存の `stage_skipped.stage` の enum（`'candidate_generation' | 'rescore' |
'index_band' | 'association'` のうち `'rescore'`/`'association'`）と同じ語を再利用**する
   ——新しい語彙を作らない。

2. **段2（`recall-runtime.ts` の既存の `over_limit` push）に `stage: 'rescore'` を足す。**
   `RecallQuery.limit` を超えた分（`passed.slice(limit)`）。**破壊的変更**——
   既存の `{kind:'over_limit', count, countKind}` を手で組み立てているコード（この repo の
   テストを含む）は `stage` を欠いて壊れる。`docs/autonomy.md` §3（ADR 0156、
   破壊的変更はオーナー承認済みで設計側が決めてよい）に従い、ADR に書くことで実装する。

3. **段3.5（連想枠）の `associationHits.slice(0, maxCount)` の直後に、切り捨てられた側
   （`associationHits.slice(maxCount)`）の件数を `over_limit { stage: 'association' }`
   として push する。** `count` は JS 側で既に確定した配列長の差分であり、
   `countKind: 'exact'` を固定値で置く——`rescoreCountKind`（段2側）のように分岐させない。
   理由は「採らなかった案」3番。

4. **`stage` を必須にし、省略時の暗黙値（例: 省略時は `'rescore'` とみなす）を作らない。**
   `filtered.condition` が必須であることと同じ理由——暗黙の既定値は、呼び手が
   `stage` を読み忘れたときに誤って `'rescore'` だと決めつけさせる。

5. **`docs/recall.md` の型例コードブロックは書き換えない。** `decayed`
   （ADR 0153 / 0173）と同じ作法で、コードブロックの直後に「2026-09-17 追記」として
   `stage` を追記する。§9.2 手順6・「次の一手」表・`filtered(decayed)` の次の一手の
   直後に新設した段落も同様に追記する。

6. **`examples/chat/compare.ts` / `compare-baseline.json` / `cassettes/compare.json` には
   一切触れない。** `formatOmittedSummary`（`compare.ts`）は `Omission` 型をそのまま
   使っているため、`stage` フィールドの追加はコード変更を要求しない
   （TypeScript は構造的に通る）。**⭐門の判定（`scripts/compare-summary-lib.mjs` の
   `computeRegressions`）は `mnemoraShareOfNaiveChars` と `factStatementSurvived` の
   2つしか見ておらず、`omitted` は `DIFF_FIELDS`（Job Summary の差分表示用、
   「門の判定には使わない」とコード自身のコメントが明記）にしか使われない**
   ——【現物】`scripts/compare-summary-lib.mjs` を読んで確認した。⟹ この PR は
   `omitted` の**中身**（`stage` の追加、`association` 由来の新エントリ）を変えるが、
   `mnemoraChars`/`mnemoraTokens`/`returnedCount`/`factStatementSurvived` のどれも
   変えない（`selectedHits` の計算・`associationMemories` の取得順・スコアリングは
   1バイトも変えていない）。**⟹ ⭐門の exit code は動かないはずである**——
   ただし「はず」は読みであり、実測は PR 本文に書く（CI の `example-chat` ジョブの
   実際の結果を見ること）。**もし実際に `mnemoraShareOfNaiveChars` や
   `factStatementSurvived` が動いたら、この ADR の6番の前提が崩れている**ので、
   マージせず報告する。

---

## 採らなかった案

1. **新しい `kind`（例: `association_over_limit`）を独立に作る**。
   **却下**——`over_limit` と意味論が同じ事象（ゲートと閾値を通過した集合を、この段
   自身の上限で切った）であり、`kind` を分けると呼び手は「両方を `over_limit` として
   まとめて扱いたい」場面（例: 「何らかの上限に当たった総数」を知りたいだけの呼び手）で
   2つの `kind` を意識しなければならなくなる。[ADR 0173](./0173-decayed-omission-counted-by-aggregate-scope.md)
   が同種の判断（`decayed` を独立 `kind` にせず `filtered.condition` へ追加）を既に行っており、
   同じ判断の形をここでも踏襲した。

2. **`over_limit` に `stage` を足さず、`count` を段2と連想枠で合算して1件だけ push する**。
   **却下**——「どちらの上限を動かせば直るか」が呼び手から見えなくなる。`limit` を
   増やしても連想枠の切り捨ては直らず、その逆も同様である。合算は北極星の**問い3**
   （なぜそれが選ばれた/選ばれなかったかを説明できるか）で落ちる——`filtered` が
   `superseded` と `forgotten` を束ねなかった [ADR 0027](./0027-split-superseded-forgotten-omission.md)
   と同じ理由。

3. **`countKind` を `'lower_bound'` にする**（ANN の押し下げが `'lower_bound'` になる
   [ADR 0011](./0011-no-window-count-in-ann-stage.md) に倣う）。**却下**——ADR 0011 の
   `'lower_bound'` は「DB 側にまだ見ていない候補が残っている可能性がある」ことに由来する
   不確実性である。`associationHits` の `slice` はその逆で、**候補は既に全部 JS 側の配列に
   載っている**（DB へは戻らない）。`slice` の前後どちらの長さも同じ実行の中で確定して
   いるので、`'unknown'`/`'lower_bound'` を選ぶ理由が無い——段2の `over_limit` が
   `passed.slice(limit)` に対して `'exact'`（`scored` という全数から出る
   `rescoreCountKind`）を使っているのと同じ理屈をそのまま適用した。

4. **`stage` を optional にし、省略時は `'rescore'` とみなす**。**却下**——「決めたこと」4番。
   `OmissionSchema` は他のどの判別フィールド（`filtered.condition`・`stage_skipped.stage`・
   `not_indexed.reason`）も optional にしていない。ここだけ optional にすると、
   **省略時の意味を覚えていないと誤読する**——`filtered.condition` を必須にした
   判断と同じ理由で必須にした。

5. **[Issue #352](https://github.com/takecchi/mnemora/issues/352)（`decayed` だけが
   `totalInScope` の内側を数えている非対称）を、この PR の中で一緒に直す**。**却下**——
   `over_limit` は `filtered` とは別の `kind` であり、`totalInScope` の被覆不変条件
   （群カウントの総和 = `totalInScope`）に一度も関与していない。`over_limit` は
   ADR 0011 が定めた「スコープ内で落ちたもの」の一員として、元々 `totalInScope` の
   **内側**の出来事である（`docs/recall.md` §2 段0 の帰結）。⟹ 本 PR の変更は
   Issue #352 が指摘する非対称に一切触れない・動かさない。Issue #352 は別の担い手が
   対応中であり、本 PR は `recall-runtime.ts` の別の場所（段3.5 の連想枠 slice）だけを
   触る。

---

## 誰が壊れうるか / 引き受けた負債

1. **🔴 破壊的変更。** `OverLimitOmission` に必須フィールド `stage` を足したので、
   `{kind:'over_limit', count, countKind}` をこの型として手で組み立てているコード
   （SDK 利用者側）は型エラーになる。`docs/autonomy.md` §3（ADR 0156）に従い、
   実装のために別途オーナー承認を待つ必要は無いと判断したが、**利用者への告知は
   CHANGELOG 側の仕事として残っている**（本 PR はコード変更のみ）。
2. **`over_limit(stage: 'association')` の `count` は、`selectedHits`
   （`maxCount` 以内に残った側）がこの後さらに通る多層防御（subjectId/period/
   excludeProvenanceKinds/両ゲートの後置）で追加で落ちる分を含まない。**
   これは新しい負債ではなく、[ADR 0172](./0172-association-passes-decay-and-validity-gates.md)
   「決めたこと」3番が既に「連想枠の後置で落ちた分はどこにも数として現れない」と
   明記している既存の負債である——押し下げ（段1と同じ `gateVectorFilterFields`）が
   通常はここで1件も落とさないため実害は小さいと ADR 0172 は評価しているが、
   adapter が契約を破った場合は本 PR の後も無言で減る。
3. **`examples/chat/compare-baseline.json` の `omitted` フィールドは、この PR の後
   実測と食い違う**（`stage` が無い・`association` 由来のエントリが無い）。
   `computeRegressions` の判定には使われないため CI は赤くならない**はず**だが
   （「決めたこと」6番）、**このファイルは本 PR の対象外**——⛔ 更新しない
   （担い手への明示的な指示）。次に `compare-baseline.json` を実測更新する PR が、
   このずれも一緒に解消する。
4. **10,000件規模での実測（Issue #375 の測定そのもの）は、この PR では再実行して
   いない。** 本 PR が検算したのは「`omitted` に `over_limit(stage:'association')`
   が実際に積まれるか」という**配線**であり（下記「測ったこと」参照）、
   Issue #375 が実測した「276通り中いくつが実際にこの札で説明されるようになるか」
   という**量**は再測していない。

## これが覆るとしたら

1. **連想枠が `packages/core` の既定で on になったとき**（別 PR が進行中。
   [Issue #337](https://github.com/takecchi/mnemora/issues/337)）——
   `over_limit(stage:'association')` が既定経路で高頻度に出るようになる。
   もし呼び手側からノイズとして扱われるようであれば、`maxCount` の既定値の見直しや、
   件数だけでなく「切り捨てられた候補の一部を near-miss 的に見せる」拡張
   （`below_threshold.nearMisses` に倣う形）が要るかもしれない——本 ADR はその設計を
   行わない。
2. **[Issue #352](https://github.com/takecchi/mnemora/issues/352) の非対称判断が
   `decayed` を `totalInScope` から引く方向に振れたとき**——`over_limit` は
   `totalInScope` の被覆不変条件に関与していないため、直接の影響は無いと読むが、
   `docs/recall.md` §2 段0「スコープの外延」の記述が変われば、本 ADR の§1に書いた
   前提（`over_limit` はスコープ内の出来事）の言い回しも合わせて確認すること。
3. **`over_limit` にさらに3つ目の `stage` が必要になったとき**（現状 `rescore`/
   `association` の2値だけ）——`filtered.condition` と同じ enum 拡張の形をそのまま
   踏襲すればよい。

---

## 測ったこと

- 【実測】`pnpm run typecheck`（全7ワークスペース）: 緑。`examples/chat` の
  `format.test.ts` が `stage` 欠落で最初赤くなり（`OverLimitOmission` に
  `stage` を必須で足した直後）、`stage: 'rescore'` を足して緑に戻ることを確認した。
- 【実測】`pnpm run lint`（eslint）: 緑、警告0。
- 【実測】`pnpm run format:check`（prettier）: 緑。
- 【実測】`pnpm run build`（`rm -rf packages/*/dist` してから）: 全7パッケージ緑。
- 【実測】`pnpm run pack:check`: 緑（6パッケージ、publish 梱包の9項目すべて）。
- 【実測】`pnpm run test`（`DATABASE_URL` 無し）: ルート1048件 + 各パッケージ
  （core 845・testkit 318・openai 43・anthropic 49・local-embedding 83）すべて緑。
  修正前は `recall.test.ts`（1件）・`recall-pipeline.test.ts`（1件）が
  `stage` 欠落で赤かった（下記「変異試験」参照）。
- 【実測】`DATABASE_URL=postgresql://postgres@localhost:5433/postgres pnpm run test`:
  DB 込みで `packages/postgres` 546件・`examples/chat` 426件を含めすべて緑
  （PostgreSQL 17.11 + pgvector 0.8.0、既存クラスタ）。`recall.postgres.test.ts` の
  段2側 `over_limit` の歯（`stage: 'rescore'` を追加）を含む。
- 【実測】新設した `packages/core/src/__tests__/recall-association-gates.test.ts` の
  2本（「連想候補が `maxCount` を超えると…」「`maxCount` 以下なら積まれない」）が緑。
  `ASSOCIATION.maxCount(5)` に対し候補8件を用意し、`over_limit`
  `{stage:'association', count:3, countKind:'exact'}` が積まれることと、
  `retrievedVia:'association'` の件数がちょうど5件であることを確認した。
- 【実測】変異試験（詳細は PR 本文に転記する）。

## 確かめていないこと

- **⭐門（`compare`）の実際の CI 結果**——本 ADR の「決めたこと」6番は
  `scripts/compare-summary-lib.mjs` を読んだ結果の**読み**であり、この repo の
  `examples/chat` を実際に `compare` サブコマンドで走らせて `mnemoraShareOfNaiveChars`/
  `factStatementSurvived` が動かないことを実測してはいない
  （`examples/chat/compare.ts` 自体には触れない指示のため、独自に走らせて
  確かめることも避けた）。**PR の CI（`example-chat` ジョブ）が実際に生成する
  結果を見て検算すること。**
- **Issue #375 が実測した10,000件規模・12 probe・4 arm の再実行**——本 ADR は
  配線（`over_limit(stage:'association')` が実際に積まれること）だけを小さい
  フィクスチャで確かめた。実運用規模でこの札がどれだけの頻度・件数で出るかは
  測っていない。
- **連想枠が既定 on になったときの、この札のノイズとしての妥当性**
  （「引き受けた負債」1番）——測る器も無い。
- **`packages/testkit` の conformance がこの境界を測るべきかどうか**——`over_limit`
  への `stage` 追加は `packages/core` 内で完結する純粋なロジックであり、adapter
  （`VectorStore`/`MemoryStore` の実装）の契約には触れないため、conformance を
  拡張する必要は無いと判断したが、明示的に検討したわけではない。

Refs #375
