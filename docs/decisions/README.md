# Architecture Decision Records

mnemora の設計判断のうち、**後から見て「なぜそうしたか」を追える形で残す必要があるもの**を
ADR (Architecture Decision Record) として記録する。`docs/architecture.md` や
`docs/memory-model.md` 等の他の docs が「何がどう決まっているか」を記述するのに対し、
ここでは各決定について、検討した選択肢・却下した理由・引き受ける負債・覆る条件までを
1ファイルにまとめる。**決定そのものをやり直す場ではなく、決定を記録する場である。**

alteroid (github.com/takecchi/alteroid) を根拠として引く箇所は、確認済み/未確認を分けた
一次調査の記録である [docs/alteroid-findings.md](../alteroid-findings.md) を参照する。

## 一覧

**この表は手で編集しない。** `docs/decisions/*.md` の1行目の見出しと状態欄から `node scripts/generate-adr-index.mjs` が生成する（[ADR 0137](./0137-adr-index-generated-from-source.md)）。ADR を追加する PR の作成者はこの表を触らない——マージする側が、squash merge する**直前**に PR ブランチ上で上のコマンドを実行してコミットし、push してからマージする（手順は ADR 0137「決定」2番）。

<!-- ADR-INDEX:GENERATED:START -->

| 番号 | 題 | 状態 |
| --- | --- | --- |
| [0001](./0001-orm-drizzle.md) | ORM は Drizzle | 採用 (2026-09) |
| [0002](./0002-embedding-space-tables.md) | pgvector の抽象と埋め込み空間ごとのテーブル分割 | 採用 (2026-09) |
| [0003](./0003-memorystore-vs-vectorstore.md) | MemoryStore と VectorStore を分けるか | 採用 (2026-09) |
| [0004](./0004-decay-at-query-time.md) | 忘却をクエリ時に算出しつつ ANN 索引を殺さない | 採用 (2026-09) |
| [0005](./0005-job-queue-abstraction.md) | Job Queue の抽象 | 採用 (2026-09) |
| [0006](./0006-memory-schema.md) | Memory schema の設計判断 | 採用 (2026-09) |
| [0007](./0007-tenant-scoping.md) | Tenant scoping | 採用 (2026-09) |
| [0008](./0008-absence-taxonomy.md) | 「無い」を分類して返す | 採用 (2026-09) |
| [0009](./0009-usage-feedback-via-observe.md) | 使用フィードバックを observe() で受ける | 採用 (2026-09) |
| [0010](./0010-decay-parameters.md) | 減衰の式とパラメータを固定する | 採用 (2026-09) |
| [0011](./0011-no-window-count-in-ann-stage.md) | 段1の ANN クエリに `count(*) OVER ()` を入れない | 採用 (2026-09) |
| [0012](./0012-ingest-pipeline-design.md) | 取り込みパイプライン（`observe()` / `runtime.tick()`）の実装方針 | 採用 (2026-09) |
| [0013](./0013-extraction-outcome-taxonomy.md) | 抽出の失敗を、成功と同じ顔で記録しない | 採用 (2026-09) |
| [0014](./0014-package-name-mnemora.md) | 名前を `mnemora` / `@mnemora/*` に確定する | 採用 (2026-09) |
| [0015](./0015-root-test-gate-reports-skipped-db-tests.md) | ルートの `test` 門は、DB テストを「走らせなかった」と明示する | 採用 (2026-09) |
| [0016](./0016-db-test-gate-explicit-exclusion.md) | DB テストの排他は依存グラフに頼らず、門のコード自身に載せる | 採用 (2026-09) |
| [0017](./0017-runmigrations-advisory-lock.md) | `runMigrations()` を advisory lock でプロセス間排他する | 採用 (2026-09) |
| [0018](./0018-register-embedding-space-advisory-lock.md) | `registerEmbeddingSpace()` を advisory lock でプロセス間排他する | 採用 (2026-09) |
| [0019](./0019-real-openai-measurement-cost.md) | 本物の OpenAI で北極星の物差しを測る — 費用・実測値・分かったこと | 採用 (2026-09) |
| [0020](./0020-temp-database-drain-before-drop.md) | 使い捨てテスト DB は「接続0本」を実測してから `DROP DATABASE`（`WITH (FORCE)` を使わない） | 採用 (2026-09) |
| [0021](./0021-drain-embed-ticks-in-ingest.md) | `examples/chat` の `ingestConversation` は `tick()` を干上がるまで回す | 採用 (2026-09) |
| [0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) | 北極星の「削っても目的の記憶が落ちない」を、擬似 provider の `compare` では主張しない | 採用 (2026-09) |
| [0023](./0023-subject-filter-in-ann-stage.md) | 段1の ANN クエリで `subject` を等値で絞る（`period` は降ろさない） | 採用 (2026-09) |
| [0024](./0024-remove-exact-counts-option.md) | 実装の無い `exactCounts` を、「予約」と書き残さずに削除する | 採用 (2026-09) |
| [0025](./0025-ann-underfill-is-not-reported-in-omitted.md) | 段1の ANN が窓を埋められなかったことが、`omitted` に出ていない（実測。**決定は保留**） | **未決 (2026-09)** |
| [0026](./0026-ann-unreached-omission.md) | 近似索引が scope に届かなかったことを `Omission { kind: 'ann_unreached' }` として出す | 採用 (2026-09) |
| [0027](./0027-split-superseded-forgotten-omission.md) | `filtered` omission の `condition: 'status'` を `'superseded'` と `'forgotten'` に分ける | 採用 (2026-09) |
| [0028](./0028-reextract-superseded-cleanup.md) | `reextract` は古い抽出結果を `superseded` にする（`forgotten` にしない） | 採用 (2026-09) |
| [0029](./0029-reextract-skip-visibility.md) | `reextract` が既存 Memory を supersede しなかった理由を `ReextractResult` に出す | 採用 (2026-09) |
| [0030](./0030-update-status-compare-and-swap.md) | `MemoryStore.updateStatus` を compare-and-swap にし、`reextract` の安全弁の TOCTOU を塞ぐ | 採用 (2026-09) |
| [0031](./0031-supersede-status-and-event-in-one-transaction.md) | `reextract` の supersede が status 更新とイベント追記を別々の2コミットで行っていたのを、1つのメソッド・1トランザクションにまとめる | 採用 (2026-09) |
| [0032](./0032-outbox-claim-lease.md) | `OutboxStore.claimBatch` に claim のリースを足し、「見えない停止」と「先頭詰まり」を塞ぐ | 採用 (2026-09) |
| [0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) | `retrieval` ベンチが順位の理由を捨てていたのをやめる — 実際に順位を決めていた項の実測 | 採用 (2026-09) |
| [0034](./0034-vector-store-filter-conformance.md) | `VectorFilter` を「adapter が実際に適用しなければならない」契約にし、その契約を適合テストの歯として置く | 採用 (2026-09) |
| [0035](./0035-recalled-memory-provenance-kind.md) | `recall()` の返り値に `provenanceKind` を載せる — 「区別して返す」を、返り値の側で満たす | 採用 (2026-09) |
| [0036](./0036-clamp-freshness-at-one.md) | `freshness` を 1 で頭打ちにする — 「まだ起きていない出来事は、最も古びていない」 | 採用 (2026-09) |
| [0037](./0037-callers-pass-occurred-at.md) | `observe()` の `occurredAt` を、実際に通す — 「いつの出来事か」を絞れるようにする | 採用 (2026-09) |
| [0038](./0038-vector-hit-distance-is-cosine.md) | `VectorHit.distance` はコサイン距離だと契約に明記し、適合テストの歯で adapter 非依存に検査する | 採用 (2026-09) |
| [0039](./0039-period-boundary-conformance.md) | `period` の判定規則が4箇所に在ることを、境界の歯で固定する | 採用 (2026-09) |
| [0040](./0040-zero-vector-never-returned.md) | ゼロベクトルが絡む候補は `recall()` の結果に出ない — 契約は振る舞いで揃える | 採用 (2026-09) |
| [0041](./0041-reinforce-does-not-change-strength.md) | `reinforce` は `strength` を動かさない — 「強化」の意味を確定させる | 採用 (2026-09) |
| [0042](./0042-event-store-list-order-and-limit.md) | `EventStore.list` の並び順・`limit`・`since`/`until` を契約に明記し、適合テストの歯で固定する | 採用 (2026-09) |
| [0043](./0043-unit-assembly-dropped-omission.md) | 一対一の対向関係が破れて候補が単位から漏れたら、`omitted` に出す（黙らない） | 採用 (2026-09) |
| [0044](./0044-score-not-comparable-omission.md) | 段2の閾値比較を網羅的な三分割にし、`score_not_comparable` を `omitted` に出す | 採用 (2026-09) |
| [0045](./0045-budget-dropped-count-kind.md) | `budget_dropped` の `countKind` を、単位の網羅性から引き継ぐ | 採用 (2026-09) |
| [0046](./0046-contested-pair-invariant-tooth.md) | `contested` の一対一を「測れる形」にする——振る舞いは決めない | 採用 (2026-09) |
| [0047](./0047-fake-referential-integrity-existence-only.md) | 擬似物（in-memory 実装・core の Fake）にも外部キー相当の「存在」検査を適用する（「整合」までは広げない） | 採用 (2026-09) |
| [0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) | `reinforce` は減衰の起点を巻き戻さない——比較を DB の1文へ入れる | 採用 (2026-09) |
| [0049](./0049-reinforce-monotonicity-in-pseudo-implementations.md) | `reinforce` の単調性を擬似物にも揃える——新しい決定ではなく、ADR 0048 の追随 | 採用 (2026-09) |
| [0050](./0050-tenant-event-retention.md) | `TenantSettingsStore` に event retention の読み書きを足す | 採用 (2026-09) |
| [0051](./0051-recorded-provider-cassette.md) | 記録した実 API の応答を再生する provider を、物差しの経路にだけ入れる（二層にする） | 採用 (2026-09) |
| [0052](./0052-compare-cassette-and-provenance-survival.md) | `compare` を実 API で測ったら「答えが落ちる」は消えた — 擬似物の産物だったことの確認と、その代償 | 採用 (2026-09) |
| [0053](./0053-set-embedding-status-does-not-roll-back-ready.md) | `setEmbeddingStatus` は `ready` を `failed` へ巻き戻さない——禁じるのは1本だけ | 採用 (2026-09) |
| [0054](./0054-idempotent-create-from-the-insert-decision.md) | 擬似実装の `created` は挿入の決定そのものから出す——判定と挿入の間に `await` を挟まない | 採用 (2026-09) |
| [0055](./0055-extraction-prompt-subject-and-inference-not-added.md) | 抽出プロンプトに「主語を復元する1文」も「推論を生成する1文」も足さない — 実 API 18 run で測った結果と、その代償 | 採用 (2026-09) |
| [0056](./0056-exclude-provenance-kinds-in-ann-stage.md) | 段1の ANN クエリで `excludeProvenanceKinds` を絞る（`period` は今回も降ろさない） | 採用 (2026-09) |
| [0057](./0057-dedicated-schema-namespace.md) | mnemora のオブジェクトを置くスキーマを、使う側が指定できるようにする | 採用 (2026-09) |
| [0058](./0058-measure-the-time-term-in-a-separate-arm.md) | 時間項は、既存の probe set を書き換えずに、別 arm で分離して測る — `probe-set.ts` に `occurredAt` を書き込まない | 採用 (2026-09) |
| [0059](./0059-period-in-ann-stage.md) | 段1の ANN クエリで `period` を絞る（`COALESCE(occurred_at, recorded_at)` の式索引を1本足す） | 採用 (2026-09) |
| [0060](./0060-publish-with-pnpm-four-packages-at-0-1-0.md) | npm へ出すのは4パッケージだけ・初回は `0.1.0`・梱包の道具は pnpm に統一する | 採用 (2026-09) |
| [0061](./0061-license-mit.md) | ライセンスを MIT にする | 採用 (2026-09) |
| [0062](./0062-contested-with-id-fk-index.md) | `memories.contested_with_id` の自己参照 FK に索引を足す — `tenant_id` 先頭の複合索引は RI チェックを効率良く供給できないこと・索引名は中身を保証しないこと | 採用 (2026-09) |
| [0063](./0063-hnsw-iterative-scan-not-adopted.md) | `hnsw.iterative_scan` は採らない — 件数は直るが正しさは直らないことを測った | 採用 (2026-09) |
| [0064](./0064-exact-path-cost-vs-scale.md) | 厳密経路の費用倍率を規模で振って測った — 「約2.5倍」の訂正と、`relaxed_order` の recall が規模とともに悪化するという発見 | 採用 (2026-09) |
| [0065](./0065-vector-store-space-separation-conformance.md) | `VectorStore` の space 分離を適合テストの歯にする — `FakeVectorStore` に丸ごと空いていた一段と、監査の漏れの記録 | 採用 (2026-09) |
| [0066](./0066-start-publishing-with-oidc.md) | publish を始める。梱包は pnpm・アップロードは npm（Trusted Publishing / OIDC） | 採用 (2026-09) |
| [0067](./0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md) | 予行フラグの fail-open を安全側へ反転する — そして `--dry-run` は信頼発行元の設定を検証できないと実測した | 採用 (2026-09) |
| [0068](./0068-the-bench-must-not-lie-about-what-it-measured.md) | `retrieval` ベンチが「測っていないこと」を測ったかのように印字するのをやめる — 2回目の実行の嘘・arm を跨いで数字を拾える形・キーが在るだけで実 API へ倒れること | 採用 (2026-09) |
| [0069](./0069-ann-truncated-says-nothing-about-loss.md) | `ann_truncated` は「損したか」を一切言っていない — 正典が付けた条件が機能していないことの実測と、案A（安全余裕を札に載せる）の採用 | 採用 (2026-09) |
| [0070](./0070-version-comes-from-the-release-tag.md) | 版の権威は Release の tag に置く。`package.json` の `version` は権威ではなくなる | 採用 (2026-09) |
| [0071](./0071-delegate-phase-2-selection-to-autonomous-agents.md) | Phase 2 の作業選定を自律エージェントへ委譲する。境界は「取り消せるか」で引く | 採用 (2026-09) |
| [0072](./0072-anthropic-llm-provider.md) | `@mnemora/anthropic` を足す — `LLMProvider` だけを実装し、翻訳先はネイティブの構造化出力にする | 採用 (2026-09) |
| [0073](./0073-digest-band-bounded-without-taxonomy.md) | digest 帯を実装する — taxonomy は要らなかった。上限は3つ持つ | 採用 (2026-09) |
| [0074](./0074-impression-topic-growth-what-mnemora-cannot-hold.md) | 「印象」「話題」「成長」を mnemora は持てるか — 現物で当てた結果と、3つの案 | **提案 (2026-09)** |
| [0075](./0075-openai-refusal-and-truncation.md) | `@mnemora/openai` も、拒否・打ち切りを「空の成功」にしない — `kind` で区別する | 採用 (2026-09) |
| [0076](./0076-extraction-carries-failure-kind.md) | 抽出は例外を飲み続ける。ただし**中身は捨てない** — `kind` を `ObserveResult` まで運ぶ | 採用 (2026-09) |
| [0077](./0077-testkit-fixtures-subpath.md) | インメモリのストアを `@mnemora/testkit/fixtures` から出す — **`index` からは出さない** | 採用 (2026-09) |
| [0078](./0078-strength-value-range.md) | `Memory.strength` の値域を `(0, 1]` に塞ぐ — 口を開ける前に蓋を付ける | 採用 (2026-09) |
| [0079](./0079-requeue-embed-jobs.md) | 索引に載らなかった Memory を積み直す口を開ける — 「見えているのに直せない」を塞ぐ | 採用 (2026-09) |
| [0081](./0081-similarity-is-the-only-term-that-ranks.md) | 順位を決めているのは `similarity` ただ1項である — 項ごとの「何通りか」を数え、`(a)` を2つに割った実測 | 採用 (2026-09) |
| [0082](./0082-tick-names-unsupported-job-kinds.md) | `tick` が処理できない kind を、`failed` の中に埋めない — 「無い」の種類を潰さないを、outbox の側でも守る | 採用 (2026-09) |
| [0083](./0083-cjk-aware-heuristic-token-counter.md) | 既定 `TokenCounter` を文字種で重み付けする — 「4文字 ≒ 1トークン」は日本語で予算を静かに超えさせる | 採用 (2026-09) |
| [0084](./0084-lexical-recall-channel.md) | recall に語彙候補生成チャンネルを足す — 追加拡張を入れず、引けないものを引けないと名乗る | 採用 (2026-09) |
| [0085](./0085-local-embedding-provider.md) | 外部サービスに繋がない埋め込み provider を足す — 契約を変えず、対称 prefix を名前に焼き込む | 採用 (2026-09) |
| [0086](./0086-no-import-meta-in-published-artifacts.md) | 配布物から `import.meta` を消す — CommonJS のサイドカー1枚で、CJS へ変換する利用側に届ける | 採用 (2026-09) |
| [0087](./0087-runtime-forget-shape.md) | `Runtime.forget()` の形を決める — 決めるのは意味論ではなく「無い」の割り方 | 採用 (2026-09) |
| [0088](./0088-retrieval-quality-measured-in-ci.md) | 想起の質を CI で継続計測する — 記録の再生で鍵なしに測り、⛔ 門にはしない | 採用 (2026-09) |
| [0089](./0089-runtime-consolidate-shape.md) | `Runtime.consolidate()` の形を決める — 統合は3層のどれでもなく、`superseded` を使う | 採用 (2026-09) |
| [0090](./0090-embedding-input-token-limit.md) | 埋め込みの入力が上限を超えたことを名乗る — 8192 トークンの壁と、導かれる識別子の余裕 | 採用 (2026-09) |
| [0091](./0091-runtime-reflect-shape.md) | `Runtime.reflect()` の形を決める — 内省は「足す」操作であり、`superseded` を使わない | 採用 (2026-09) |
| [0092](./0092-lexical-or-coverage.md) | クエリ語彙を OR で結び、`lexicalMatch` を被覆率にする — ADR 0084 §10 が残した独立の変更 | 採用 (2026-09) |
| [0093](./0093-extension-verify-mode.md) | `CREATE EXTENSION` を発行できないロールのための口 — 「作らない」ではなく「検査する」 | 採用 (2026-09) |
| [0094](./0094-identifier-probes-local-embedding.md) | 識別子・固有名詞の probe を、鍵もカセットも要らないローカル埋め込みで測る — ゴールデンセットを増やす道を1本開ける | 採用 (2026-09) |
| [0095](./0095-embedding-provider-conformance.md) | `EmbeddingProvider` の適合テストを新設する — 順序の検査は決定性を前提にしているので、決定性を「宣言させる」 | 採用 (2026-09) |
| [0096](./0096-bootstrap-local-embedding-onto-npm.md) | `@mnemora/local-embedding` を npm へ載せる — 初版は OIDC で出せないので、tag 由来の中身を手元から1回だけ出す | 採用 (2026-09) |
| [0097](./0097-recall-usage-share-may-exceed-1.md) | `usage.share` は 1 を超えうる — `.max(1)` は保証ではなく、守られていない宣言だった | 採用 (2026-09) |
| [0098](./0098-validate-recall-output.md) | `recall()` の出力を zod で検証する — 既定では投げず、検証結果を呼び手に返す | 採用 (2026-09) |
| [0099](./0099-conformance-against-real-embedding-providers.md) | 適合テストを**本物の** `EmbeddingProvider` に当てる — 足場が素直だと、歯は緑のまま嘘をつく | 採用 (2026-09) |
| [0100](./0100-supersede-with-new-memories.md) | 統合パイプラインの「新 Memory の作成」と「旧行の supersede」を1トランザクションにする口を足す（任意メソッド） | 採用 (2026-09) |
| [0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md) | 統合が北極星の物差しに効いたかを、どの数で測るか — 🔴 いちばん物差しに近い軸だけが、擬似 LLM では測れない | 採用 (2026-09) |
| [0102](./0102-bench-keeps-partial-measurements-on-abort.md) | ベンチが例外で死ぬとき、測れた分を捨てない — 包むことの増分は「例外」ではなく「文脈」である | 採用 (2026-09) |
| [0103](./0103-negative-tooth-declares-its-precondition.md) | 否定を主張する歯は、その否定が依存している前提を自分で測って名乗る — 揺れていたのは版でもビルドでもロケールでもなく `server_encoding` だった | 採用 (2026-09) |
| [0104](./0104-recall-gate-index-tooth-measures-applicability.md) | 索引の歯は「プランナが選んだ」ではなく「この述語に使える」を測る — 落ちたのは実装ではなく、同じ部分述語の索引が1本増えたからだった | 採用 (2026-09) |
| [0105](./0105-postgres-regime-matrix.md) | `postgres` ジョブを server_encoding の matrix にする — UTF8 と SQL_ASCII を両方走らせ、揃って走ったかを別ジョブで測る | 採用 (2026-09) |
| [0106](./0106-ci-declares-the-regime-it-measures.md) | CI が自分の測っている regime を宣言する — 6本のうち測るのは1本、宣言は6本すべて | 採用 (2026-09) |
| [0107](./0107-local-embedding-cache-warm-network-tooth.md) | cache が効いていることを実ふるまいで固定する — warm でも tokenizer_config.json への Range リクエストは残る | 採用 (2026-09) |
| [0108](./0108-retrieval-bench-does-not-exercise-lexical-channel.md) | `retrieval` ベンチは語彙チャンネルを一度も通していない — ADR 0092 の効果はまだ一度も測られていない | 採用 (2026-09) |
| [0109](./0109-which-score-terms-actually-rank.md) | 残りの4項も丸めずに測った — `total` の順位は `similarity` ただ1項で決まり、`total` は210行すべてで `similarity × decay²` にビット単位で一致する | 採用 (2026-09) |
| [0110](./0110-single-char-token-discriminator.md) | `org-b` が落ちる理由を切り分けた — 「日本語の1文字違い」ではない。弁別が**単独1文字のトークン1個**に載ったときだけ差が消える | 採用 (2026-09) |
| [0111](./0111-hnsw-window-shrinks-with-tenant-scale.md) | 本物の pgvector で確かめた — 順位は変わらない。ただし窓（`ef_search`）はテナントが育つと黙って縮む | 採用 (2026-09) |
| [0112](./0112-relax-zod-dependency-range.md) | 公開パッケージの `zod` 依存を完全固定から `^` 範囲へ緩める | 採用 (2026-09) |
| [0113](./0113-no-attribution-trailers.md) | コミット・PR に帰属トレーラ（`Co-Authored-By:` / `🤖 Generated with`）を付けない | 採用 (2026-09) |
| [0114](./0114-archive-sweep-for-decayed-memories.md) | 減衰しきった記憶をアーカイブへ掃く — `archiveDecayed`（掃引） | 採用 (2026-09) |
| [0115](./0115-event-retention-purge.md) | `MemoryStore.purgeExpiredEvents`（任意メソッド）— 設定できても効いていなかった保持期間の削除側を埋める | 採用 (2026-09) |
| [0117](./0117-unreachable-union-values-inventory.md) | 型に在って一度も生成されない union の値の棚卸し — 落とすのは提起までにする | 採用 (2026-09) |
| [0119](./0119-archive-sweep-cost-bench.md) | 掃引（ADR 0114）を `examples/chat` のベンチへ配線する — `archive-sweep-cost` | 採用 (2026-09) |
| [0120](./0120-time-term-probes-in-ci.md) | 時間項 probe（8件）を継続計測の CI に配線する — 値は残すが門にはしない。#109 か別建てかは決めていない | 採用 (2026-09) |
| [0121](./0121-bench-baselines-from-ci-artifacts.md) | `archive-sweep-cost`/`time-term` の基準値を、CI 初回実測の artifact から作る（手元では書かない） | 採用 (2026-09) |
| [0122](./0122-restore-archived-memory.md) | `archived` から呼び戻す明示的な口 — `Runtime.restoreArchived` | 採用 (2026-09) |
| [0123](./0123-archive-sweep-before-usage-noise-excluded-from-diff.md) | `archive-sweep-cost` の `before` 段 `usage*` を、基準値との厳密等価の比較から外す(比較には数えない・表示は残す) | 採用 (2026-09) |
| [0124](./0124-purge-physical-delete.md) | `purge()`（物理削除）の入口を実装する — `forgotten` からのみ、`dryRun` 付き、`tick()`/`observe()` には配線しない | 採用 (2026-09) |
| [0125](./0125-half-life-hours-domain.md) | `halfLifeHours` の値域を `(0, ∞)`（有限の正の実数）に塞ぐ — ADR 0078 が「別 PR」と名指しした残債 | 採用 (2026-09) |
| [0126](./0126-migration-comment-tooth-strips-comments.md) | マイグレーションの説明 comment に語を書いても歯が反応しないよう、歯の側で comment を剥がしてから検査する | 採用 (2026-09) |
| [0127](./0127-pgvector-job-count-tooth-drops-absolute-total.md) | pgvector ジョブの本数固定を、絶対数ではなく不変条件で持つ — 「同じ regime を宣言しているか」だけを歯にし、「今何本あるか」は数えない | 採用 (2026-09) |
| [0128](./0128-adr-index-completeness-tooth.md) | ADR 索引（`docs/decisions/README.md`）の行数と `docs/decisions/*.md` の本数の一致を検査する歯を足す — 衝突は消さず、抜けだけを捕まえる | 採用 (2026-09) |
| [0130](./0130-postgres-auth-parity-docker-compose.md) | 手元の Postgres 認証方式を CI（scram）に揃える —— `docker-compose.yml` と、揃っていることを測る歯 | 採用 (2026-09) |
| [0132](./0132-ci-green-verdict-procedure.md) | 「CI が緑」の判定手順を自律作業の手引きに足す — head sha 明示・job 単位の conclusion・mergeStateStatus 不使用・安定性の再確認（Issue #228） | 採用 (2026-09) |
| [0133](./0133-compare-baseline-and-gate.md) | `compare`(北極星の物差し)に基準値ファイルを足す — 実測で揺れなかったため、他5本と異なり⭐門にする | 採用 (2026-09) |
| [0134](./0134-mark-contested-explicit-operation.md) | 矛盾の検出（第1弾）— `Runtime.markContested` という明示的操作で `contested_with_id` を初めて書く | 採用 (2026-09) |
| [0135](./0135-numeral-token-discriminator-probe-domain-design.md) | 主測定の被覆を広げる設計（第1弾）— 「単独トークンの数詞・記号インデックス」を弁別軸とする第4の probe 集合を置く。件数は行列から導き、margin の分布で読む | **提案 (2026-09)** |
| [0136](./0136-contested-lone-dropped-not-returned-alone.md) | 片側だけの `contested`（`contestedWithId=null`）を、読み取り側で単独返却させない | 採用 (2026-09) |
| [0137](./0137-adr-index-generated-from-source.md) | ADR 索引（`docs/decisions/README.md`）を `docs/decisions/*.md` から生成する — 案A、行位置の衝突そのものを消す | 採用 (2026-09) |
| [0138](./0138-pack-check-in-ci.md) | 六つの門の `pack:check` を、毎PRの `ci.yml` でも走らせる | 採用 (2026-09) |
| [0139](./0139-consolidation-cost-huge-utterance-timeout.md) | `consolidation-cost` の「巨大な utterance」テストの間欠タイムアウトを直す — 支配的費用は `encode()` であり、同じ壁を kana 巡回文字列で越えると解消する（Issue #258） | 採用 (2026-09) |
| [0140](./0140-contested-write-side-companion-required.md) | `MemoryStore` の書き込み側で、対向（`contestedWithId`）の無い単独 `contested` を拒否する — ADR 0136 決定3の実装（生成経路も含む） | 採用 (2026-09) |
| [0141](./0141-local-embedding-load-retry.md) | `@mnemora/local-embedding` の読み込みに、種類の分かっていない失敗のリトライを足す — キャッシュが hit してもネットワークは0回にならない（Issue #261） | 採用 (2026-09) |
| [0142](./0142-outbox-complete-fail-compare-and-swap.md) | `OutboxStore.complete`/`fail` を compare-and-swap にする — `attempts` をフェンシングトークンに使う（Issue #233、ADR 0032 が残した named debt の実装） | 採用 (2026-09) |
| [0143](./0143-analyze-memories-after-seed.md) | 新規インストール後に `ANALYZE memories;` を明示的に実行できるようにする — `runMigrations`/migrate CLI 末尾での自動実行は構造的に効かないため、独立コマンドにする | 採用 (2026-09) |
| [0144](./0144-drop-unreachable-classification-3-union-values.md) | ADR 0117 分類3の4値を union から落とす — `retrievedVia`/`reason`/`axis` の破壊的変更（Issue #206） | 採用 (2026-09) |

<!-- ADR-INDEX:GENERATED:END -->
