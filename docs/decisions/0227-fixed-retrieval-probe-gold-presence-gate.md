# ADR 0227: 固定した probe ごとの gold 到達を、`example-chat` の必須 CI へ直接繋ぐ回帰ゲート（Issue #497）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0088 / ADR 0111 の体裁を踏む）。

- **【実測】** — この ADR の書き手が、自分専用の `initdb` インスタンス（本物の
  PostgreSQL 17 + pgvector）に対して自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を、書き手が自分で読んで確かめた。
- **【受】** — この作業を委譲した側（マネージャー）が事前に実測した結果として渡された。
  **この PR の作業者自身は、この節の実測を再導出していない。**

---

## 結論（先に）

`examples/chat/src/__tests__/retrieval-quality-regression.postgres.test.ts` に、
**`recorded` provider（カセット再生）+ `fixedClock`（固定時刻）+ 既存の凍結済み
`probe-set.ts`** で `runRetrievalQualityArm` を1 arm だけ実行し、**7 probe すべてに
ついて、gold が `recall()` の既定候補（`limit=10`）に入っていること**を assert する
歯を1本足した。新しいジョブ・新しいステップ・branch protection の変更は**していない**
——既存の `example-chat` ジョブの `test:db`（= `vitest run`）が `src/__tests__/`
配下を丸ごと拾うため、この歯はそこにそのまま乗る。

## 文脈

Issue #497 は「固定した品質回帰ケースを必須 CI で失敗させる」ことを求めている。
`scripts/retrieval-quality-summary.mjs`（ADR 0088）は基準値との差があっても
`exit 0` のままであり、想起の質が退行しても `example-chat` ジョブは赤くならない
——ADR 0088/0033 が「n=7 の標本では閾値の門は偽陽性を出す」ことと「decay/freshness
が壁時計時刻で6桁目が揺れる」ことを理由に、意図してこの形にしている。

`docs/autonomy.md` §2.2（ADR 0224）は、品質を変える検査には「時刻・入力・provider
を固定できるケースで守る振る舞いを検査し、必要な記憶や情報を落とす変異で赤、復元後に
緑を確認する」ことを求め、`deterministic` stub への置き換えを明示的に禁じている。

## 測った条件

- 器: **PostgreSQL 17.11**（Debian 17.11-0+deb13u1）+ **pgvector 0.8.0**
  （`select version()` / `select extversion from pg_extension where extname='vector'`
  で確認。`AGENTS.md` の手順どおり `initdb` で立てた自分専用インスタンス、
  共有ポートは使用せず）。【実測】
- commit: このブランチの base は `main` の `64a4e83`。【現物】
- run 数（この PR の作業で）: 単体ファイルの vitest 実行を**4回**（初回 + 追加3回）。
  【実測】
- provider 層: `MNEMORA_LLM=recorded` / `MNEMORA_EMBEDDING=recorded`
  （`examples/chat/cassettes/retrieval.json` を再生。`OPENAI_API_KEY` は一切参照しない
  ——`selectLLMMode`/`selectEmbeddingMode` が `MNEMORA_LLM`/`MNEMORA_EMBEDDING` を
  最優先で見るため、実行環境にキーが在っても黙って実 API へは倒れない）。【現物】
- 固定した時計: `fixedClock(new Date("2030-01-01T00:00:00.000Z"))`
  （なぜこの値かは次節）。【実測】

### ⚠ 現物と食い違った点 — `fixedClock` を過去日付にすると embed ジョブが一生 claim されない

マネージャーの設計メモは「`fixedClock` を注入すると5 run で完全一致した」という
**先行の実測**（decay/freshness の生値まで一致。この PR の作業者は未検算・【受】）を
根拠に置いていたが、**このメモには `fixedClock` の値そのものは書かれていなかった**。
最初に `fixedClock(new Date("2026-01-01T00:00:00.000Z"))`（実行時点の 2026-09-17 より
過去）を指定したところ、**7 probe すべてで `recalledRows=0`**（gold どころか候補が
1件も返らない）になった。【実測】

原因は `packages/postgres/src/outbox-store.ts` の `claimBatch`——embed ジョブの
claim 条件 `available_at <= opts.now` の `opts.now` は**注入した `Clock.now()`**
だが（`packages/core/src/runtime.ts` の `tick()` が `now: clock.now()` を渡す）、
`available_at` の既定値は `packages/postgres/src/memory-store.ts` の
`INSERT INTO outbox (...) VALUES (..., now(), ...)` —— **DB 自身の実時刻**である。
固定時計を過去にすると、実行時に書かれる `available_at`（実時刻）が常に
`opts.now`（過去に固定した値）より後になり、`tick()` は例外を出さずに
`processed: 0` を返し続ける。`extractionCounts.ok` は正常な値（74件）を示すため、
ingest 自体は成功したように見えるまま、**embed ジョブだけが静かに滞留する**。【実測】

`fixedClock` を `2030-01-01T00:00:00.000Z`（実行時点より確実に未来）に変えたところ、
embed ジョブは3 tick で処理しきり（`totalProcessed=75`、`firstTickProcessed=50`——
既定の `DEFAULT_TICK_LIMIT=50` を確実に超える構成であることの再確認）、7 probe すべてで
`recalledRows=10`・`goldRank !== null` になった。【実測】この時計と `recordedAt`
（`packages/core/src/runtime.ts` が `clock.now()` から書く）の関係自体は健全で、
問題は「過去日付を選んだこと」だけである——**この PR が採る `fixedClock` の値は
実行時点より未来である必要がある**、という運用上の制約を新たに明らかにした。

### 【実測】7 probe 全件で gold が候補に入っていた

上の条件（`recorded` + `fixedClock(2030-01-01)`）で4回実行し、**4回とも完全一致**
（goldRank/distractorRank/hit1/hit10/recalledRows が1桁も動かない）:

| probe | goldRank | distractorRank | hit1 | hit10 |
|---|---|---|---|---|
| color | 1 | 2 | true | true |
| pet | 1 | 2 | true | true |
| exercise | 2 | 1 | false | true |
| diet | 6 | 1 | false | true |
| family | 1 | 2 | true | true |
| language | 1 | 2 | true | true |
| travel | 2 | 1 | false | true |

**7/7 で `hit10=true`（gold が既定候補に入っている）。** ⟹ **選別は要らない**——
全 probe を検査対象にした。「見て調整したケース」問題（ADR 0224 §2.2 の5番）は
発生していない。

## 決定

1. **`examples/chat/src/__tests__/` に vitest の歯を1本置く**（新しいファイル
   `retrieval-quality-regression.postgres.test.ts`）。新しい CI ジョブ・新しい
   ステップ・branch protection の変更はしていない——`.github/workflows/ci.yml` は
   1バイトも変更していない。既存の `example-chat` ジョブの `test:db` ステップ
   （`vitest run`、`src/__tests__/` を丸ごと拾う）がそのまま実行する。
2. **固定するもの3つ**: provider = `recorded`（`deterministic` にはしない——
   ADR 0224 §2.2 が意味的品質の検査で stub への置き換えを禁じているため。ADR 0051
   の「記録に無い入力は例外」という規律も同時に効く）、時計 =
   `fixedClock(new Date("2030-01-01T00:00:00.000Z"))`（実行時点より確実に未来。
   理由は上の「現物と食い違った点」節）、入力 = `probe-set.ts` の `PROBES`/
   `buildProbeSetConversation`（ADR 0058 §1.4 で凍結済み。1件も足さない・変えない）。
3. **守る振る舞い**: probe ごとに、`probe.fact`（gold）が `recall()` の返す既定候補
   （`limit=10`）に入っていること。**測定用ベンチ**（`retrieval` サブコマンド・
   `scripts/retrieval-quality-summary.mjs`・`retrieval-baseline.json`・
   `compare-baseline.json`）は一切変更していない——ADR 0224 §2.2 の3番（測定用ベンチと
   失敗で変更を止める検査を分ける）を、物理的に別ファイルにすることで満たす。
   `runRetrievalQualityArm`/`probe-set.ts`/`cassette-io.ts`/`runtime-factory.ts` は
   全て既存の再利用であり、この歯自身が新しい実装を持つのは
   assert 文とテナント/時計の配線だけである。
4. **K を「`recall()` の既定 `limit`（=10）」にした**。実測順位（1,1,2,6,1,1,2）
   そのものを焼き込まない——ADR 0201 決定3が較正係数（`charsPerDigest / 2`）から
   FLOOR を導き、実測値の丸写しを避けたのと同じ考え方。実測した最大値「6」を境界に
   すると、正当な reranking の変更（例えば `diet` が6位から8位へ動くが依然として
   使い物になる変更）が、製品として許容範囲でもこの歯を赤くする。「候補に入って
   いるか」という `recall()` 自身が既定で引く境界だけを固定すれば、**情報が候補集合
   から丸ごと落ちたときだけ**赤くなる。

## ⭐ ADR 0223 決定3（偽陽性率に上限を置けない検査は門にしない）への答え

ADR 0223 決定3の一般形: 「門にしてよいのは、偽陽性率に上限を置けると実測できた
ものだけである。置けないなら門にしない。」

(i) **揺れの源を列挙し、機序ごとに消したことを示す**:
  - **時刻由来の揺れ**（ADR 0088 §2 が実測した decay/freshness の6桁目のオーダーの
    揺れ）: `fixedClock` により**全観測の `recordedAt` が同一値**になり、
    recall 時の `clock.now()` も同じ固定値であるため、`decay`/`freshness` の
    起点からの経過時間は**すべての候補で厳密に 0**になる——ADR 0088 §2 が観測した
    「6桁目が揺れる」だけでなく、**そもそも候補間で差がつく余地自体が消える**。
    これは ADR 0088 §2 が指摘した現象を「観測されなかった」ではなく「計算式の項を
    ゼロにして構造的に消した」という機序の主張である。
  - **ANN 由来の非決定性**: マネージャーの委譲文が渡した先行実測【受・未検算】
    によれば、`vector-store.ts` の `search()` と同形の SQL を `EXPLAIN (ANALYZE,
    BUFFERS)` した結果、この規模（1テナント74〜75行）では HNSW 索引はプランに現れず、
    主キーへの Bitmap Index Scan + Sort による**正確走査**になっている（`ef_search`
    は既定のまま、本番経路はどこも `SET` していない）。これは ADR 0111 が別の
    probe set・commit で実測した「この repo の実際のクエリ形ではプランナが既定で
    HNSW を避ける」という結果と同種であり、**この PR の入力規模（haystack 60 +
    probe 14 = 74件/tenant）ではこの結論が構造的に成り立つ**——テナントごとに
    スコープが切られ、ANN が万単位の行数まで育たない限り自然選択されない、という
    ADR 0111 の条件と一致する。
  - **同順位 tie-break 由来の揺れ**（ADR 0170/0167 が連想枠の `search()` で実測した
    `getVectors()` 返却順依存・`memory_id` tie-break の揺れ）: この bench の
    haystack は `buildHaystackUtterance` が3軸の直積で作るため、同一文の使い回しが
    無く、埋め込みの完全重複は先行実測【受・未検算】で0件（745行）——tie-break の
    第2キー（`recorded_at DESC`）が実際に働く場面（距離が完全一致する候補が複数
    ある場面）自体が、この入力集合には存在しない。
  - **`fixedClock` 自身が生んだ新しい負債**（tie-break 第2キーの無力化）は下の
    「引き受けた負債」で扱う。上の3点とは別種の懸念であり、ここでは扱わない。

(ii) **⛔ n=4〜5 の run では偽陽性率の実用的な数値上限は主張できない。** ADR 0223
  決定6（「出なかった」を積んでも事象が起きないことの証明にはならない）に従い、
  そう名乗る。この PR の作業で確かめたのは「4回とも一致した」という事実だけであり、
  「何回に1回揺れるか」という頻度は測っていない・測れない。

(iii) **それでも門にしてよい根拠は「観測回数」ではなく「揺れの項を計算式から
  消した」という機序である。** これは ADR 0133 決定3が `compare` を門にしたときの
  根拠（同一 commit で CI を2回実行し、出力が完全一致したという**観測**）と同種
  だが、**それより強い**——ADR 0133 は自分自身の「引き受けた負債」1番で
  「2回一致は決定的であることの証明ではない」「この揺れがランキングの境界を
  動かすほど大きくならなかったためだと推測するが、3回目以降の run でも同じ結果に
  なる保証はない」と明記しており、**根拠は観測回数の積み上げだった**。
  この ADR はそこを一歩進める——`fixedClock` によって decay/freshness の変動項を
  **構造的にゼロへ固定**しているため、「揺れの原因になる自由度そのものが無い」と
  主張できる。ANN・tie-break についても、「起きなかった」の代わりに「この規模・
  この入力では発生条件（1万行規模のテナント／完全一致する埋め込みの複数存在）を
  満たしていない」という条件面の議論を添えている。⛔ **これでも「原理的に抑えられる
  はず」だけでは済ませない**——上の3点はいずれも、この PR の入力規模・実装の
  現物（`packages/postgres`/`packages/core` のコード、`EXPLAIN` の出力、embedding
  の重複件数）に基づく実測または実測の引用であり、抽象論ではない。

## ADR 0088 との関係 — ⭐ 0088 を覆すものではない

ADR 0088 が想起の質を門にしなかった理由は2つ: (a) decay/freshness が壁時計時刻で
6桁目のオーダーで揺れる、(b) 標本が7件しかなく閾値の門は偽陽性を出す（ADR 0033 §3）。

- **(a) は `fixedClock` で消える**——上述のとおり、揺れの発生源（`clock.now()` の
  実行ごとの違い）自体を固定する。
- **(b) は消えていない。** 標本は依然として probe 7件のままである。**⟹ だから
  この歯は集計値（MRR・hit@1 の分数）に閾値を置かず、probe ごとの個別判定
  （gold が候補に入っているか）にしている。** 1 probe の判定は他の6 probe の結果と
  無関係に決まるため、「順位が1つ動くと分数全体が変わる」という閾値特有の脆さを
  持たない——`hit@1` が「4/7 か 3/7 か」を問うのではなく、「`color` probe の gold は
  候補に入っているか」を個別に問う。閾値の門が偽陽性を出す機序（ADR 0088 §2.1 /
  ADR 0033 §3 の「n=7 では1件の順位変動が分数を動かす」）は、この形には当たらない。

**この ADR は ADR 0088 を覆さない。** ADR 0088 の「これが覆るとしたら」は
「ゴールデンセットが数十件規模になったとき」であり、その条件はまだ満たしていない
——`scripts/retrieval-quality-summary.mjs`・`retrieval-baseline.json`・
`compare-baseline.json`・`probe-set.ts` はこの PR で1つも変更していない。
ADR 0088 が守っていた「値を残すだけで exit 0」という設計はそのまま残る。

## 保証範囲

ADR 0224 §2.2 の2番に従い、3つを区別する:

- **出典への到達**: この歯は見ていない。`sourceObservationId` の一致は問わない。
- **回答に必要な情報の保持**: **これがこの歯が見ているものである。** `recall()`
  が返す候補集合に gold の記憶が入っているかどうかを見る——回答を組み立てる材料
  （記憶）が候補から落ちていないか、という保持の検査。
- **最終回答の正しさ**: この歯は見ていない。この bench には LLM が最終回答を
  組み立てる段が無く（probe は `recall()` を直接呼ぶだけ）、`correction-demo` 等の
  別の歯の領分である。

⛔ **広く名乗らない**——この歯が緑でも、「想起した記憶から正しい回答が作れる」
「順位が正しい」ことは何も言っていない。見ているのは「必要な記憶が候補集合の中に
存在するか」だけである。

### ⛔ この歯は時間項（`decay` / `freshness`）の退行を検出できない

上の3分類（出典への到達／情報の保持／最終回答の正しさ）とは**別の軸**として、
明示的に名乗る——**これはトレードオフであって、書き忘れていた副作用ではない。**

上の「ADR 0223 決定3への答え」(i) で述べた「時刻由来の揺れを消す機序」を、
現物で検算した:

- `packages/core/src/runtime.ts` の `handleExtractableObservation` は
  `recordedAt: clock.now()` を書く（`observe()` のたびに注入した `Clock` を読む）。
  【現物】
- `packages/core/src/recall-runtime.ts` は `const now = deps.clock.now();` を
  1回だけ読み、`defaultScoringStrategy` の全候補に同じ `now` を渡す。【現物】
- `packages/core/src/strategies/scoring.ts`/`decay.ts` は、`decay` の起点を
  `lastReinforcedAt ?? recordedAt`、`freshness` の起点を `occurredAt ?? recordedAt`
  とし、`elapsed = now - 起点` から `decayFactor(elapsed, halfLifeHours) =
  0.5 ** (elapsed / halfLifeHours)` を計算する。【現物】

この bench は `recall_usages`/`reinforce` を一度も呼ばない（`lastReinforcedAt` は
常に null）、`observe()` に `occurredAt` を渡さない（常に null）——⟹ `decay`/
`freshness` はどちらも起点 = `recordedAt` になる。`fixedClock` により
**全観測の `recordedAt` と recall 時の `now` が同一の Date インスタンス**になるため、
`elapsed` は**すべての候補で厳密に 0**、`decayFactor(0, halfLifeHours) = 1`——
**`decay`/`freshness` は候補間で差がつく余地が無いだけでなく、常に定数 `1` になる。**

**⟹ `decay`/`freshness` の計算式が丸ごと壊れて別の値（負の値・`NaN`・常に0など）を
返すようになっても、全候補が同じように壊れる限り相対順位は変わらず、この歯は
検出できない。** 揺れを消したのと同じ機序（`elapsed` をゼロへ固定する）が、
同時にこの2項に対する検出力をゼロにしている——これは意図した設計上のトレードオフ
であり、見落としではない。

時間項の振る舞いは、この歯とは別に **`time-term` ジョブ**（`.github/workflows/ci.yml`
の `time-term:` ジョブ、`deterministic` provider・`MutableClock` で `decay`/
`freshness` を分離して測る。ADR 0058）が既に走っている。【現物】
ただし branch protection の required checks（6件、`gh api
repos/takecchi/mnemora/branches/main/protection/required_status_checks` で確認）に
`time-term` は含まれておらず、**required ではない。**【実測】

## 記録再生の射程

ADR 0224 §2.2 の6番に従う。この歯は `examples/chat/cassettes/retrieval.json` に
**記録済みの入力・記録済みの応答**に対してのみ動く。記録に無い入力（probe を
1件足す・haystack を変える）は例外になり、この歯が「別の入力でも成り立つ」ことを
確かめる手段にはならない。**現在の実 API（最新のモデル）や、未知の会話に対する
想起の質の保証には広げない。** カセットを録り直したとき（`record` サブコマンド）に
同じ結果が再現するかは、この PR の作業では確かめていない（下記「確かめていない
こと」）。

## 実行費用

【実測】新設したファイル単体を `vitest run` で実行:
- テスト本体（ingest + drain + recall、7 probe 分）: **約 4.4〜6.7 秒**
  （4回の実測で 4369ms / 3679ms / 5220ms / 5929ms / 6741ms — 最後の1つは
  mutation を仕込んだ run）。
- vitest プロセス全体（node 起動・transform 込み、単体ファイルのみ）: **約 14〜18秒**
  （`Duration` 表示で 14.23s〜17.62s、`real` で 18.08s）。

**この単体ファイルの数字は `example-chat` ジョブへの正味の増分ではない**——
`test:db` は `src/__tests__/` を丸ごと1プロセスで実行し（`fileParallelism: false`）、
transform のコストは他のファイルと共有される。より近い数字を得るため、既存の
`retrieval-quality.postgres.test.ts`（すでに DB を使う既存の歯）と組み合わせて
実行し、単体実行との差分を見た:

| 構成 | Duration |
|---|---|
| `retrieval-quality.postgres.test.ts` のみ | 23.24s |
| 上 + この PR の新ファイル | 33.44s |
| **差分（この歯の正味の増分の近似）** | **約 10.2 秒** |

**約10秒**は「目安: 1分を大きく超える」の基準を大きく下回るため、arm 数・haystack
サイズを削っていない——1 arm（`recorded` のみ）・既定の haystack（60件、
`DEFAULT_HAYSTACK_SIZE`）のまま、`probe-set.ts` の凍結された入力をそのまま使う。

### ⭐【実測】CI 実機での所要時間 —— ローカルの近似より1桁小さい

**上の数字はローカルの `initdb` インスタンスでの近似である。**この PR をマージする側が、
`example-chat` ジョブ（`pgvector/pgvector:pg17` の service container、GitHub Actions
ランナー）の実ログから、この歯自身の所要時間を引いた:

```
✓ src/__tests__/retrieval-quality-regression.postgres.test.ts (1 test) 1058ms
  ✓ PROBES の全7件で、gold が recall() の既定候補(limit=10)に入っている 1052ms
Test Files  58 passed (58)
   Duration  61.39s
```

⟹ **CI 実機では 1058ms**（vitest 自身の reporter が報告する、このファイルの所要時間）。
ローカルで測った「正味の増分の近似 約10.2秒」より**1桁小さい**。

⚠ **両者は同じものを測っていない。**ローカルの 10.2 秒は「2ファイル構成と1ファイル構成の
`Duration` の差」であり、プロセス起動・transform・`resetTestDatabase()` の取り分を含む。
CI の 1058ms は reporter がこのファイル1本に帰属させた時間だけである。⟹ **`example-chat`
ジョブ全体（この run では `Duration 61.39s`）に対するこの歯の比重は、ローカルの近似が
示唆したものより小さい。**

⛔ **この 1058ms は1 run の値であり、分布・ばらつきは測っていない。**

## 変異試験（【実測】、ADR 0224 §2.2 の3番）

`cp` で退避 → 変異を入れる → 赤を確認 → `cp` で復元 → `git status --porcelain` が
空になることを確認 → 緑に戻ることを確認、という `AGENTS.md` の手順に従った。

### 陽性（必要な情報を落とす）

`examples/chat/src/probe-set.ts` の `buildProbeSetConversation` を一時的に変異させ、
`family` probe の gold utterance だけを会話に投入しないようにした。

```
FAIL  … PROBES の全7件で、gold が recall() の既定候補(limit=10)に入っている
AssertionError: probe "family" の gold が recall() の既定候補(limit=10)から落ちた
(goldRank=null)。必要な記憶または情報が失われた可能性がある——recall() のフィルタ・
probe-set.ts の gold の内容・ingest の経路を確認すること。: expected null not to be null
```

**赤くなったのは、狙いどおり `family` probe だけである**（メッセージにその
probeId が出ている——他の6 probe まで巻き込んで落ちていない、という取り違えの
排除）。`cp` で `probe-set.ts` を復元後、`git status --porcelain` が空になることを
確認し、同じ歯を再実行して**緑に戻ることを実測した**（該当テストが `✓` で通過）。

### 陰性対照（無関係な記憶を落としても赤くならない、ADR 0223 決定6）

`runRetrievalQualityArm` に渡す `haystackSize` を既定の60から59へ変え、
**probe と無関係な haystack 発話を1件**落とした（`buildHaystackUtterance` は
決定的な直積生成のため、59件は60件の連番の部分集合であり、`probe-set.ts` の
gold/distractor には触れていない）。**この歯は緑のまま**だった。復元後に
歯自体を書き換えるファイル（この新設テストファイル自身）を `cp` で戻し、
`git status --porcelain` が空になることを確認した。

## 採らなかった案

1. **`scripts/retrieval-quality-summary.mjs` の `exit` を非0にする。** 却下——
   ADR 0088 が意図して設計した「値を残すだけで exit 0」を崩し、標本7件の閾値門の
   偽陽性という ADR 0088/0033 が既に退けた問題を復活させる。マネージャーの設計が
   明示的に禁じている。
2. **`retrieval-quality` ジョブを required に足す。** 却下——branch protection の
   変更はオーナー権限（Issue #426）であり、この PR の作業者の権限外。また
   `retrieval-quality` ジョブは基準値との差分を報告するだけの Summary ジョブであり
   （ADR 0088 決定4）、**それ自体を required にしても閾値の門にはならない**——
   Summary の「成功」を品質合格の根拠にしないという ADR 0224 §2.2 の3番にも反する。
3. **既存の揺れる集計値（MRR・hit@1 の分数）に閾値を置く。** 却下——ADR 0088・
   ADR 0094・ADR 0148・ADR 0224（§2.2 の3番・4番）の4箇所が、標本の薄さ・
   決めていない閾値・実装への合わせ込みを理由に一貫して退けている。この PR も
   同じ理由でこの案を採らない——probe ごとの個別判定（gold の有無）に絞ることで、
   閾値そのものを持たない検査にした。

## 引き受けた負債

1. **`fixedClock` による `recorded_at` の同一化が、`vector-store.ts` の tie-break
   第2キー（距離 → `recorded_at DESC` → `memory_id`）を無力化する。** すべての
   観測の `recordedAt` が同一の固定値になるため、`recorded_at DESC` は常に
   同値タイのまま通過し、実質的に第3キー（`memory_id`）だけで決着する構成になる。
   この bench の haystack には埋め込みの完全重複が無い（先行実測【受・未検算】、
   745行で0件）ため、この PR の範囲では実害は出ていないが、**別の入力集合
   （重複する埋め込みを含む会話）にこの歯を拡張したとき、tie-break が
   `memory_id`（実質ランダムな UUID 順）だけに頼ることになる**——ADR 0170/0167 が
   別の経路（連想枠）で実測した非決定性と同種の負債である。
2. **カセット再記録時の再現性は未測**（ADR 0133 の負債2と同型）。
   `examples/chat/cassettes/retrieval.json` を `record` サブコマンドで録り直した
   ときに、同じ7 probe 全件の到達が保たれるかは確かめていない。
3. **`fixedClock` の値（`2030-01-01`）は「実行時点より未来」という条件だけを
   満たす裁量値であり、恒久的に安全な値ではない。** 2030年を過ぎた実行環境で
   このテストを走らせると、再び「過去日付」問題を踏む。値そのものより先に
   このファイルの doc コメントで理由が読めるようにしてあるが、値の更新は
   将来のオーナー・担い手の作業として残る。

## 確かめていないこと

- ~~**CI 実機での所要時間。**~~ ⭐ **これはマージ直前に測れた**——「実行費用」節の
  「⭐【実測】CI 実機での所要時間」を見ること（1 run で 1058ms）。⛔ **ただし測ったのは
  1 run だけであり、分布・ばらつきは測っていない。**
- **HNSW が自然選択される規模（テナントあたり数万行）での挙動。** マネージャーの
  委譲文の先行実測【受・未検算】が示した「この規模では正確走査になる」が別の規模
  でも成り立つかは、この PR の範囲外。
- **decay/freshness の生の min/max が5 run で1e-7桁だけ動いた**というマネージャーの
  先行実測【受・未検算】——この PR の作業者自身はこの5-run比較を再導出していない
  （`fixedClock` により今回の構成ではこの項自体が構造的にゼロになるため、
  再導出する必要も無かった）。
- **`fixedClock` を使わない構成（壁時計のまま）でこの歯を走らせた場合の偽陽性率。**
  この PR は `fixedClock` を使う構成だけを対象にしており、壁時計のままの挙動は
  測っていない。
- **カセット再記録後の同じ歯の挙動**（上記「引き受けた負債」2番）。
- **`fixedClock` の値が実行時点を追い越されたときに何が起きるか**を、実際に
  未来の日付が過去になった状態で再現してはいない（論理的な導出のみ）。

## これが覆るとしたら

- **ゴールデンセットが数十件規模に増える**（ADR 0088 が名指しした条件）と、
  probe ごとの個別判定に加えて、標本の厚みを背景にした集計値の閾値も検討できる
  ようになる——そのときはこの ADR の「集計値に閾値を置かない」という決定も
  見直しの対象になる。
- **embed ジョブの `available_at` が注入した `Clock` を経由するように
  `packages/postgres` 側が変わったら**、「未来の日付を選ぶ」という運用上の制約は
  消える——そのときはこの歯の `fixedClock` の値を、実行時点に依存しない値
  （例えば固定の過去日付）へ戻すことを検討する。
- **この入力集合に埋め込みの完全重複が生じる変更**（`buildHaystackUtterance` の
  直積が枯渇する規模までテナントが育つ、等）が入ったら、上の「引き受けた負債」1番
  の tie-break 負債が顕在化する可能性がある——そのときは ADR 0170/0167 と同じ形で
  tie-break の決定性を別途固定する必要が生じる。
- **時間項（`decay`/`freshness`）の退行を門で守りたくなったら**、この歯とは別に、
  **候補間で経過時間に差がつく固定ケース**（例えば probe ごとに `occurredAt`/
  ingest のタイミングをずらし、相対的な時刻差を持たせた固定入力）が要る——
  `fixedClock` で全候補の `elapsed` を 0 に揃える、という本 ADR の機序そのものが
  時間項の検出力を消しているため、この歯を拡張するのではなく**別の固定ケースを
  新設する**形になる。その設計（何を固定し、何を差分として残すか）は本 ADR の
  射程外である。
