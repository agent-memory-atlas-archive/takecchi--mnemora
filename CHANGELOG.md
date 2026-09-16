# Changelog

このファイルは [Keep a Changelog](https://keepachangelog.com/) の形式に倣う。
**手で書く**（tag や commit ログからの自動生成ではない）。理由と、版の権威が
Release の tag にあるという既存の決定（[ADR 0070](./docs/decisions/0070-version-comes-from-the-release-tag.md)）
との関係は [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) を見ること。

## 過去のバージョンについて

**v0.1.0 〜 v0.1.9 の変更は、このファイルには書き起こしていない。**
[GitHub Releases](https://github.com/takecchi/mnemora/releases) の各 tag を参照すること
（理由: [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) 決定4）。

⚠ **このファイルの初版と ADR 0169 決定4 は「v1.0.0 以降を対象とする」と書いていた。**
そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**実際に出たのは
2026-09-16 の `v0.2.0` である**（tag が指すのは `c52be47`）。⟹ **このファイルが実際に
対象としているのは `0.2.0` 以降である。**書き起こさない範囲（v0.1.0 〜 v0.1.9）は
決定4 のまま変えていない。⛔ **ADR 0169 の本文は当時の記録なので書き換えていない**
（`AGENTS.md`）。

## 何を載せるか

**利用者に見える変更だけを載せる。** docs のみの PR・内部スクリプトの修正・ADR 索引の
再生成・テスト追加のみの PR は載せない——GitHub が自動生成する Release notes（全 PR を
無差別に列挙する）との意図的な違いである。各項目は1〜2行の要約と ADR/Issue へのリンクに
留め、詳細は複製しない（`AGENTS.md` の反重複規律）。

---

## [1.0.0] - 未リリース

⛔ **`v1.0.0` の tag はまだ切られていない。**【実測】2026-09-17、`gh release list` の最新は `v0.2.0`。

**この節は `0.2.0` からの差分を対象とする。**

⭐ **数えた基準を明記する。**この節の数字は `v0.2.0` … **`4b92134`** の範囲を数えたものである。
⟹ 🔴 **`origin/main` がこれより進んでいたら、この節は腐っている可能性がある**——読む人が
`git log --oneline 4b92134..origin/main` で自分で判定できる。**数字を焼き込む以上、`main` が動けば
必ず腐る**（`docs/roadmap.md` §7.0 と同じ規律を、この節にも掛ける）。

【実測】`git rev-list --count v0.2.0..4b92134` は **36**、
うち `feat`/`fix` は **13本**。冒頭「何を載せるか」の除外規則（docs のみ・テスト追加のみ・
内部スクリプト・ADR 索引の再生成は載せない）に当てると、**利用者に見える PR は8本**である。
⚠ **項目の件数は9件で、PR の本数と一致しない**——PR #416 が「後方互換の追加」と「破壊的変更」を
**両方**持つため、下では2項目に分けて書いている。⟹ **PR の本数と項目の件数を同じ数だと思わないこと。**

⚠ **「`packages/*/src` を触ったか」で数えないこと。**この規則とずれる例が両方向に在る——
`0016`/`0017` のマイグレーション追加（PR #396）は `src` を1行も触らないが**載せる**（利用者が
マイグレーションを流す必要がある）。逆に PR #383 は `packages/*/src` を触っているが
**doc コメントのみで実行コードに差分が無い**ので**載せない**。

### 変更（破壊的）

⚠ **3件ある。1件目・2件目と、3件目とで壊れ方が違う。**

**1件目・2件目は「返り値の型に必須フィールドが増えた」形**である。⟹ **読むだけの利用者は影響を受けない。**
**自分で組み立てている側**（独自 adapter・テストダブル）だけが型エラーになる。

🔴 **3件目は「公開クラスのメソッドの署名が変わった」形**である。⟹ **呼んでいる側が壊れる。**
同期から `Promise` へ変わったので、**引数を直しただけでは足りない**（`await` が要る）。

- `FilteredOmission` に必須フィールド `scopeRelation` が増えた。`decayed` だけが
  `totalInScope` の**内側**を数えるという非対称を、契約として明示するもの
  （[#352](https://github.com/takecchi/mnemora/issues/352) / [ADR 0174](./docs/decisions/0174-filtered-omission-scope-relation.md)、PR #376）
- `Omission` の `over_limit` に `stage` が増えた。連想枠（段3.5）の `maxCount` 切り捨てを
  段1 の打ち切りと区別して名乗るため（[#375](https://github.com/takecchi/mnemora/issues/375) /
  [ADR 0188](./docs/decisions/0188-association-over-limit-omission.md)、PR #391）
- 🔴 **`@mnemora/testkit` の `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls` の署名が変わった。**
  `(tenantId: string, recalls: number): void` → **`(ctx: Ctx, recalls: number): Promise<void>`**。
  ADR 0197 が `TenantSettingsStore` interface に同名の**本番**メソッドを足したため名前が衝突し、
  **テスト専用フックのほうを消して本番の口だけを残した**
  （[ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)、PR #416）。
  ⟹ 呼んでいた側は **`store.setDefaultHalfLifeRecalls({ tenantId }, recalls)` へ書き換え、
  返り値を `await` する**必要がある。
  ⚠ **これは `@mnemora/testkit/fixtures` の公開型である**——`packages/testkit/src/fixtures.ts` は
  `v0.2.0` の時点で既に `InMemoryTenantSettingsStore` を export しており、
  `@mnemora/testkit` は publish 対象6本の1つである。
  ⟹ ⭐ **`@mnemora/core` だけを見て数えると、この1件は落ちる。**
  ⚠ **移行手順は複製しない**——[docs/migration-v1.md](./docs/migration-v1.md)
  「8. `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）の
  シグネチャが変わった」を見ること

### 変更（挙動）

- **`ann_unreached` が「窓が満杯のときにも」鳴るようになった。**従来は
  `annHits.length < kPrime` のときだけ鳴っていたため、**近似索引が取りこぼしたのに窓は満杯**
  という場合に沈黙していた（[ADR 0193](./docs/decisions/0193-ann-unreached-covers-full-window.md)、PR #399）。
  ⟹ 北極星「知らないことを、知らないと言える」の穴を1つ塞いだ
- **`sweepArchive` が `opts.clock` 省略時に `tenant_settings.decay_clock` へ従うようになった。**
  従来は掃引だけが常に壁時計で動いていたため、`decay_clock = activity`/`either` を選んだ
  テナントで「想起では生きている記憶が archive される」ことがあった
  （[#364](https://github.com/takecchi/mnemora/issues/364) / [ADR 0186](./docs/decisions/0186-sweep-archive-follows-decay-clock.md)、PR #379）
- **語彙チャンネルの `search()` に決定的な最終キーが入った。**同点の候補の順序が
  呼び出しごとに変わりうる状態を解消（[#345](https://github.com/takecchi/mnemora/issues/345) /
  [ADR 0175](./docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)、PR #390）

### 追加

- **`TenantSettingsStore.setDefaultHalfLifeRecalls`**（任意メソッド）。テナント既定の
  半減期を「recall 回数」で設定する本番の経路（[ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)、PR #416）。
  ⭕ **任意メソッドなので、この追加そのものは後方互換**——実装していない adapter は従来どおり動く。
  ⚠ **ただし同じ PR #416 は破壊的変更も1件持っている**（上「変更（破壊的）」の3件目。
  `@mnemora/testkit` の `InMemoryTenantSettingsStore` の同名メソッドの署名）。
  ⟹ **「任意メソッドだから丸ごと後方互換」と読まないこと。**

### 変更（性能）

- **`PostgresVectorStore.upsert` が、閾値を越えたときだけ埋め込み表を `ANALYZE` するようになった。**
  新しい埋め込み空間へ大量投入した直後は統計が無く、**HNSW 索引が選ばれない窓**が在った
  （[#360](https://github.com/takecchi/mnemora/issues/360) /
  [ADR 0194](./docs/decisions/0194-embedding-space-analyze-threshold.md)、PR #406）

### DB

- **マイグレーションが2本増えた（`0016` / `0017`）。**`memories.provenance_kind` と
  `provenance->>kind` の一致を `CHECK` 制約で強制する
  （[#273](https://github.com/takecchi/mnemora/issues/273) / [ADR 0182](./docs/decisions/0182-provenance-kind-matches-provenance-check.md)、PR #396）。
  ⟹ **上げるときに `pnpm --filter @mnemora/postgres run migrate` が要る。**
  手順と、既存行の走査を `NOT VALID` で切り離した理由は
  [docs/migration-v1.md](./docs/migration-v1.md)「v0.2.0 以降に追加されたマイグレーション」を見ること

⚠ **`v1.0.0` をいつ切るかは、この節を書いた時点で決まっていない。**7項目の現在地は
[docs/roadmap.md](./docs/roadmap.md) §7.13 に在る。

---

## [0.2.0] - 2026-09-16

**Release**: [v0.2.0](https://github.com/takecchi/mnemora/releases/tag/v0.2.0)（pre-release ではない）。
**tag が指すのは `c52be47`**、**前の版は `v0.1.9`**（`6c9d101`）。⟹ **この節は
`v0.1.9` → `v0.2.0` の差分である**（【実測】`git rev-list --count v0.1.9..v0.2.0` = 30）。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更はすべて `@mnemora/core` と `@mnemora/testkit` に限られる**
（`openai`/`anthropic`/`local-embedding` の `src` に v0.1.9 からの差分は無い。【実測】
`git diff --stat v0.1.9..v0.2.0 -- packages/openai/src packages/anthropic/src packages/local-embedding/src`
が空を返す）。

**postgres 利用者へ**: 新しいマイグレーション（`0013`/`0014`/`0015`）が増えている。
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 1 | `MemoryStore.getRecall` が必須メソッドとして追加された。 | `MemoryStore` を自前実装している adapter 作者 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 2 | `NewRecallRecord.returnedMemoryIds: MemoryId[]` を削除し、`returnedMemories: RecallRecordMemory[]` に置き換えた。 | `createRecall` を呼ぶ側・実装する側の両方 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 3 | `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた。 | `aggregateScope` を自前実装している adapter 作者 | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 4 | `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた。 | 消費するだけなら非破壊。**`never` で網羅性を検査しているコードは壊れる** | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 5 | `Runtime.getRecall` が必須メソッドとして追加された。 | `Runtime` を自前実装している側。⚠ 根拠 ADR に破壊性の言及が無い——[移行ガイド](./docs/migration-v1.md)を必ず見ること | [ADR 0161](./docs/decisions/0161-runtime-get-recall.md) |
| 6 | `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドとして追加された。 | `describeTenantSettingsStoreConformance(...)` を呼んでいる adapter 作者。⚠ 根拠 ADR は当初「非破壊」と誤記載していたが訂正済み | [ADR 0165](./docs/decisions/0165-decay-activity-clock.md) |
| 7 | `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドとして追加された。 | **返り値の型なので、読むだけ・呼ぶだけの利用者には非破壊。** `RecallFootprintEstimate` を自前で構築している側だけが影響を受ける。入力側（`estimateRecallFootprint`）は省略可能フィールドとして追加されており非破壊（省略時は `?? 0`）。（【実測】`packages/core/src/recall-footprint.ts:392` が必須、入力側の `RecallFootprintShape.associationCount` は `:368` で省略可能、既定は `:463` の `?? 0`） | ADR 0166 |

### Changed（後方互換だが挙動が変わりうる）

- **`RecallQuery.validAt` ゲートが既定で有効になった**（opt-out は `includeOutsideValidity: true`）。
  **影響を受けるのは、v0.1.9 で `MemoryStore.createMemory` を直接呼んで `validFrom`/`validUntil`
  に non-null を書いていた利用者だけ**——`Runtime.observe` 経由ではこれらの列に値を
  書く経路が v0.1.9 には無かったため、通常の利用者には影響しない。
  ([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **`TICK_SUPPORTED_JOB_KINDS` が2値から4値へ増えた**（`consolidate`/`reflect` を追加）。
  値を消費するだけなら非破壊だが、**網羅性検査（`never`）をしているコードは壊れる。**
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))
- **`PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された。**
  距離が完全一致した候補の順序が決定的になった（以前は未定義）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
- **連想枠の非決定性は、上の修正だけでは消えていなかった（第2段）。** `search()` が返す
  候補に距離の完全一致タイが在ると、`memory_id` による tie-break が取り込みのたびに
  揺れていた。段1と段2の両方で順序を決定的にして直した（Issue #339）。
  ([ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md))

### Added

- **`Runtime.getRecall(ctx, recallId)`** — `recall()` を離れた後でも、`recallId` から
  スコア内訳・`retrievedVia`・`companionOf`/`associationOf` を読み戻せる。
  ([ADR 0161](./docs/decisions/0161-runtime-get-recall.md))
- **`memory_usage` 報告の実践**（`examples/chat`）— プロンプトへ積んだ Memory を
  `observe({ kind: 'memory_usage' })` で伝え返し、`reinforce` を実アプリで発火させる。
  ([ADR 0163](./docs/decisions/0163-memory-usage-reporting-example-chat.md))
- **`validAt` ゲート** — 「この時刻において真だった記憶」を問える。`expired`/`not_yet_valid`
  を `omitted` で名指しする。([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **減衰の時計を2本持てる（`decay_clock`）** — 壁時計（`wall`、既定）に加え、活動時計
  （`activity`）・両方（`either`）をテナントごとに選べる。低頻度利用のテナントが
  一律に沈むのを避けられる。([ADR 0165](./docs/decisions/0165-decay-activity-clock.md))
- **`estimateRecallFootprint` が連想枠の分も見積もれる** — 入力
  `RecallFootprintShape.associationCount?`（**省略可能**）を渡すと、返り値に
  `associationCount` が出る。**渡さなければ従来と同じ値が返る**（`?? 0`）。
  ([ADR 0166](./docs/decisions/0166-recall-footprint-association-term.md))
- **`examples/chat` の想起経路が連想枠を既定で使うようになった**（`maxCount=10`）。
  ⚠ **`@mnemora/core` の `recall()` の既定は off のままである**——連想枠は
  `query.association` を渡したときだけ走る（`packages/core/src/recall.ts:1132`
  「省略時は連想を一切走らせない」）。**変わったのは採用側が明示して使うようになったこと**であって、
  ライブラリの既定ではない。
  ([ADR 0168](./docs/decisions/0168-examples-chat-uses-association.md))
- **`tick()` が `consolidate()`/`reflect()` を駆動できる**（既定 off の opt-in、
  `RuntimeConfig.autoQueueConsolidateReflectOnExtract`）。
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))

### Fixed

- **連想枠（段3.5）の結果が、同一データに対して実行のたびに変わることがあった。**
  原因は `VectorStore.getVectors()` の返却順（adapter が保証しない順序）にそのまま
  依存していたことで、HNSW の近似性とは無関係だった。アンカーの処理順をランク順に
  固定して直した（Issue #316）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
