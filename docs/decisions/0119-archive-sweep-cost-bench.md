# ADR 0119: 掃引（ADR 0114）を `examples/chat` のベンチへ配線する — `archive-sweep-cost`

- **状態**: 採用 (2026-09)

- **文脈**:

  ## この ADR が埋める穴

  [ADR 0114](./0114-archive-sweep-for-decayed-memories.md) が `MemoryStore.archiveDecayed` /
  `Runtime.sweepArchive` を実装したが、その ADR 自身が明言していたとおり
  **`examples/chat` への配線は範囲外**だった。⟹ 掃引が北極星の物差し
  （「使う側が、会話ログを全部プロンプトへ積むのをやめられたか」）に**実際に効くか**を、
  誰も測っていなかった（[Issue #209](https://github.com/takecchi/mnemora/issues/209)）。

  ## Issue #136 と全く同じ形の穴である

  Issue #136（`consolidate()` が配線されていない）を解いたのが
  [ADR 0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md) の
  `consolidation-cost` サブコマンドである。Issue #209 は本文で「2つを別々に解かないこと。
  先に #136 を読み、設計を合わせること」と明示している。⟹ **この ADR は
  `consolidation-cost` の体裁（型の分担・CLI 配線・summary スクリプト・CI ジョブ）を
  土台にする。**現物（`examples/chat/src/consolidation-cost*.ts` /
  `scripts/consolidation-cost-summary*.mjs` / `.github/workflows/ci.yml` の
  `consolidation-cost:` ジョブ）を読み、同じ形に揃えた。

  ## 🔴 掃引はベンチの実行時間内には自然に発火しない

  既定の `tenant_settings.default_half_life_hours` は 720 時間（30日）であり、
  `decayFloorAt = recordedAt + halfLifeHours × log2(strength / threshold)` 時間
  （`packages/core/src/strategies/decay.ts` の `floorAt`、`strength=1`・既定閾値 `0.05` なら
  `log2(20) ≈ 4.32`）——720時間の既定なら約 3110 時間（約130日）先になる。
  **ベンチは数十秒で終わる。**⟹ 掃引の対象がそもそも0件のまま「対応している/いない」
  さえ測れない。**受け入れ条件1（half-life を短くした専用 arm）はこの構造的な穴を
  埋めるためにある。**

- **決定**:

  ## 決定1: `archive-sweep-cost` サブコマンドを足す（`consolidation-cost` の姉妹）

  `examples/chat/src/archive-sweep-json.ts`（前任の WIP。376行、この PR の土台）が持つ
  型・純関数の上に、DB/LLM/embedding を要求する `archive-sweep-cost.ts`・人が読む要約
  `archive-sweep-format.ts`・環境変数のパース `archive-sweep-options.ts` を足し、
  `cli.ts` に `archive-sweep-cost` サブコマンドとして配線した。

  `consolidation-cost` と同じく **`deterministic` LLM + `local` embedding に固定する**
  （`cli.ts` の `runArchiveSweepCostCommand` が明示的に上書きする）。この bench 専用の
  会話（filler を backdate した conversation）は `recorded` のカセットに無い入力を含むため、
  `RecordedLLMProvider`/`RecordedEmbeddingProvider` は使えない。

  ## 決定2: half-life を短くした専用テナント + filler だけを `MutableClock` で backdate する

  **「専用 arm で掃引を実行時間内に発火させる」を、次の2つの組み合わせで実現する:**

  1. この bench 専用テナントの `tenant_settings.default_half_life_hours` を
     `MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS`（既定 **1時間**）へ設定する。
  2. `probe-set.ts` の haystack（filler）だけを、`decayFloorOffsetMs(halfLifeHours) +
     marginHours` 分（既定 marginHours=0.5、`archive-sweep-json.ts` の
     `fillerBackdateMs`）だけ過去へ backdate して `observe()` する。
     gold/distractor は実時刻のまま ingest する。

  **この2つを両方使う理由**（どちらか片方では成立しない）:

  - **half-life だけを短くし、backdate をしない案**は却下した。halfLifeHours=1時間でも
    `decayFloorOffsetMs` は約4.32時間——CI のジョブが4時間以上 sleep するのは非現実的
    （`timeout-minutes: 15` の他ジョブと比べても異常な長さになる）。
  - **backdate だけをして、half-life を既定の720時間のままにする案**も技術的には成立する
    （`decayFloorOffsetMs(720)` 分バックデートすればよい）が、そのオフセットは約130日分の
    `Date` 演算になる——桁が大きいほど「本当にこの経路が動いているのか、単に日付演算の
    余裕で吸収されているだけなのか」が読みにくくなる。**half-life を1時間まで縮めることで、
    backdate 量を約4.3時間という扱いやすい桁に保ち、受け入れ条件が要求する
    「half-life を短くした専用 arm」を文字どおり満たす。**

  **`MutableClock` を注入する仕掛けは新規実装ではない**——`time-term-arm.ts` が
  `decay`/`freshness` を分離するために既に確立している（`createMutableClock()` →
  `createExampleRuntime` の第4引数 → ingest 直前に `set()` → **recall/tick の直前に
  必ず実時刻へ戻す**）。**戻し忘れは実際に踏まれた罠であり**
  （`time-term-arm.ts` のコメント「8 probe すべてが『この項を持つ候補が無い』になった」）、
  `archive-sweep-cost.ts` も同じ順序（filler を backdate → 実時刻へ戻す →
  `drainEmbedTicks`）を踏む。

  `tenant_settings.default_half_life_hours` を書く公開の口が `TenantSettingsStore`
  （`@mnemora/core`）に無い（`getDefaultHalfLifeHours` の読み出しと
  `setEventRetention` しか無い）ため、**`packages/core`/`packages/postgres` を変更せず**、
  `embed-failure-kind.ts` の `lookupLatestEmbedFailureKind` と同じやり方
  （`pool.query` への素の SQL）でこの bench 専用テナントの行だけを UPSERT する。
  書き込んだ値は裁量の定数のまま JSON へ書かず、**読み戻した実値**
  （`ArchiveSweepCostRunJson.halfLifeHours`）を使う。

  ## 決定3: `./consolidation-json.ts` と型を共有しない。測定の部品は共有する

  `archive-sweep-json.ts` 冒頭の docstring（前任の WIP が既に書いていた設計意図）を
  そのまま採用する。理由:

  - **consolidate は「N件をLLMで1件へ畳む」操作**であり、JSON は round ごとの
    `groups`/`llmCalls`/`outcomes`/`embeddingStatus` を持つ。
  - **sweep は「`decay_floor_at` を過ぎた行を status だけ書き換える」操作**であり、
    LLM を1回も呼ばない・新しい Memory を1件も作らない・ラウンドを反復しない
    （ADR 0114「一度 archived になった行は…同じ行が二度 archived になることはない」——
    1回 sweep すれば対象は尽きる）。⟹ JSON は `rounds[]` ではなく `before`/`after` の
    **2 phase**しか持たない。

  **この違いのため、専用の JSON 型（`ArchiveSweepCostRunJson` 等）を持つ。**
  ただし測定の部品は共有する:

  - `carriedDigestTokensOf`/`meanExcludingNullGoldRank`（`consolidation-json.ts` から
    そのまま import）。
  - `DEFAULT_BUDGET_LADDER`/`DEFAULT_RECALL_LIMIT`（`consolidation-cost-options.ts` から
    そのまま import。予算段は「gold を載せるのに要った最小予算」を分解能良く読むために
    ADR 0101 が実測調整した値であり、書き写すと片方だけ直したときにずれる）。
  - `probe-set.ts` の `PROBES`/`buildProbeSetConversation`/`goldExternalId`（既存のまま、
    変更していない）。

  **現物で確認した**: `archive-sweep-cost.ts`/`archive-sweep-options.ts` の import 文が
  この共有方針どおりになっている（コード自体を参照）。⟹ 前任の WIP が書いた設計意図と
  実装が一致していることを、この PR の作業として確認した。

  ## 決定4: 受け入れ条件2の3指標を、掃引の前後（`before`/`after`）で必ず対にして持つ

  Issue #209 本文が要求する3指標を、`ArchiveSweepPhaseJson`（before/after で同じ形）に
  そのまま持たせる:

  1. `recall().usage.chars`（`ArchiveSweepMeanJson.usageChars`。減るはず）。
  2. `omitted` の `{kind:'filtered', condition:'archived'}` の件数
     （`ArchiveSweepProbeJson.omittedArchivedCount`。0 → 正 へ動くはず）。
  3. `goldRank`（`ArchiveSweepProbeJson.goldRank`。落ちていないことを見る欄）。

  **`omittedArchivedCount` はテナント/サブジェクトスコープ全体の集計であることに注意**
  （`packages/core/src/recall-runtime.ts` の `aggregate.filteredArchived.count` は
  `memoryStore.aggregateScope` から来る、クエリ内容に依らないスコープ全体の件数）。
  ⟹ **掃引が起きれば、全 probe が同じ値を示す。**これは probe ごとの語彙的な関連性とは
  無関係であり、バグではない——`archive-sweep-cost-summary-lib.mjs` の注意書きに明記した。

  `consolidation-cost` と同じく、`recalledActiveShare`（退化検知）・`usage.chars`/
  `indexChars` の内訳・`activeCount`/`archivedCount`/`supersededCount` も併記する
  （ADR 0088 §4「数字を、条件から離さない」、ADR 0101 決定8）。

  ## 決定5: CI の門にしない

  [ADR 0088](./0088-retrieval-quality-measured-in-ci.md) §2 の理由をそのまま継ぐ——
  標本は probe 7件であり（[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §3）、
  `decay`/`freshness` は実行毎に揺れる。**この bench は `decay_floor_at`（掃引の判定基準
  そのもの）を扱うぶん、`consolidation-cost` より慎重であるべき理由はあっても、
  緩めてよい理由は無い。**⟹ `consolidation-cost` と同じ3つの形（基準値を repo にコミット・
  差分を Job Summary に出す・一致していれば1行で黙る）を採り、**基準値と違っても
  `exit 0`。落ちるのは bench そのものが壊れたとき（重み取得失敗・`sweep.supported:false`）
  だけ**（`archive-sweep-json.ts` の `exitCodeForArchiveSweepCostRun`）。

  ## 決定6: 🔴 この PR では基準値ファイルを作らない

  `examples/chat/archive-sweep-baseline.json` に相当するファイルは、**この PR ではコミット
  しない。**理由: この作業環境に `DATABASE_URL`（本物の Postgres + pgvector）が無く
  （`docs/autonomy.md` §1.1「DB を用意できない環境では、段2・段4は『判定不能』」）、
  **実測せずに数値を書けば、それは捏造である。**
  ⟹ `scripts/archive-sweep-cost-summary.mjs` は `--baseline` を**省略可能**にしてある
  （`consolidation-cost-summary.mjs` も元々そういう作りである——`readArgValue` が
  `undefined` を返せば `baselineValidated` は作られず、`buildSummaryMarkdown` は差分節を
  出さない）。**初回 CI が出す artifact（`archive-sweep-cost.json`）を、後続の PR で
  基準値としてコミットすることを想定している。**

- **検討して採らなかった案**:

  1. **`consolidation-cost` と同じ `ConsolidationCostRunJson` 型を流用する。**
     却下。決定3参照——sweep は round を反復せず、LLM を呼ばない。同じ型に無理に
     載せると、使われない欄（`groups`/`llmCalls`/`outcomes`）を持て余すか、
     意味の違う欄（`round` は0/1の2値しか取らない等）を無理に共有することになる。

  2. **half-life を書く口を `TenantSettingsStore` に足す（`setDefaultHalfLifeHours`）。**
     却下。`@mnemora/core` は npm 公開済みであり、interface へメソッドを足すこと自体は
     破壊的ではないが、**この bench 専用の書き込み経路のために公開 interface を広げる
     必要が無い**——`examples/chat` は既に `pool`（`PostgresClient["pool"]`）を
     公開の返り値として持っており（`embed-failure-kind.ts` の先例）、素の SQL で
     この bench 専用テナントの1行だけを触れば十分である。**ADR に書いていない
     変更を混ぜない**という規律（`docs/autonomy.md` §2）にも合う。

  3. **halfLifeHours を極端に小さくし（例: 数秒相当）、backdate せずに自然経過を待つ。**
     却下。tenant 全体が同じ half-life を共有するため、gold/distractor も同じ速さで
     減衰してしまう——filler だけを狙って掃くには、gold/distractor と filler の
     `recordedAt` を分けて動かす必要があり、それは結局 backdate と同じ仕掛けを要求する。
     さらに CI の実行速度に結果が依存する（embed の drain・DB 往復にかかる秒数が
     ジョブごとに揺れる）ため、決定性が下がる。

  4. **`ci-yml-consolidation-wiring.test.mjs` に相当する、`ci.yml` を直接読む歯を足す。**
     見送った（却下ではなく後置）。マネージャーの指示（「2本」）どおり
     `archive-sweep-cost-summary.mjs`/`archive-sweep-cost-summary-lib.mjs` の歯だけを
     足した。`ci.yml` の配線自体は `archive-sweep-cost-summary.mjs`/`-lib.mjs` の歯とは
     別の心配事（「誰かが `ci.yml` から要約の段を消しても、既存の2本は緑のまま通る」）
     であり、`consolidation-cost` 側の先例に倣うなら本来は足すべきものである
     （下記「引き受けた負債」参照）。

  5. **本物の Postgres が無いこの環境で、`DATABASE_URL` を疑似的に立てて測る。**
     却下。`docs/autonomy.md` は「DB を用意できない環境では判定不能」と明示しており、
     疑似 DB（sqlite 等）で代替すると `AGENTS.md` の「テストは本物の Postgres + pgvector
     に対して走る」という不変条件を壊す。**測れないものは測れないと書く。**

- **引き受けた負債・覆えていない範囲**:

  1. 🔴 **本物の Postgres に対してこの bench を1度も走らせていない。**
     この作業環境に `DATABASE_URL` が無い（`docs/autonomy.md` §1.1）。
     `archive-sweep-cost.postgres.test.ts` は歯として置いたが、**CI の
     `archive-sweep-cost` ジョブが実測の場になる。**backdate の算術
     （`decayFloorOffsetMs`/`fillerBackdateMs`）は `defaultDecayStrategy.floorAt` を
     直接呼んだ単体テストで検算したが、**「実際に掃引が発火し、gold/distractor が
     残ること」を実行して確認したのはこの ADR を書いた時点ではまだ無い。**
  2. **基準値ファイルが無い**（決定6）。初回 CI の後、後続の PR で
     `examples/chat/archive-sweep-baseline.json` をコミットする必要がある。
  3. **`ci.yml` の配線自体を検査する歯（`ci-yml-*-wiring.test.mjs` 相当）が無い**
     （採らなかった案4）。`consolidation-cost`/`retrieval-quality`/`identifier-probes`
     はいずれもこの種の歯を持つが、この PR では作らなかった——スコープを
     `archive-sweep-cost-summary.mjs`/`-lib.mjs` 自体の歯に絞った。
  4. **`halfLifeHours=1`/`marginHours=0.5` はこの bench が選んだ裁量値である。**
     実運用の推奨半減期について何も言っていない——`groupSize=5`（ADR 0101）と同じ
     位置づけの、測定を成立させるための値である。
  5. **`recalledActiveShare` の退化検知は `consolidation-cost` から流用したが、
     この bench の典型的な値でどう振る舞うかは実測していない**（負債1と同根）。

- **これが覆るとしたら**:

  - **CI で実際に走らせた結果、backdate の余裕（`marginHours=0.5`）が足りない/
    大きすぎることが分かったら**、`MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS` で調整する
    （既定値を変える判断は実測後にする）。
  - **Issue #196（recall 段1の `decay_floor_at` 読み取りフィルタ）が「既定にする」で
    決着したら**、`omittedArchivedCount` の意味がこの bench の時点とは変わりうる
    （ADR 0114「これが覆るとしたら」と同じ懸念をこの bench 側からも引き継ぐ）。
  - **probe 数が数十件に増えたら**（Issue #109 項目1）、決定5（門にしない）を
    見直す材料になる——`consolidation-cost`/`retrieval-quality` と同じタイミングで
    まとめて判断すべき事柄である。

- **測ったこと**:

  **【実測】**この作業環境（`DATABASE_URL` 無し）で、DB を要求しない部分を
  直接 `vitest run <ファイル>` で実行した(root の `pnpm run test` は
  `examples/chat` のテストを丸ごとスキップする——`package.json` に `test`
  スクリプトが無く `test:db` は DB 前提であるため。個別ファイル指定なら
  DB 不要のテストだけを読み込める)。

  ```
  cd examples/chat && npx vitest run \
    src/__tests__/archive-sweep-json.test.ts \
    src/__tests__/archive-sweep-options.test.ts \
    src/__tests__/archive-sweep-format.test.ts
  # Test Files  3 passed (3) / Tests  30 passed (30)

  npx vitest run \
    scripts/__tests__/archive-sweep-cost-summary-lib.test.mjs \
    scripts/__tests__/archive-sweep-cost-summary.test.mjs
  # Test Files  2 passed (2) / Tests  74 passed (74)
  ```

  **【実測】変異試験**（`docs/autonomy.md` §2「歯が実際に噛むことを、変異試験で示した」）:
  変異前に `cp` で退避コピーを取り（`git checkout` による消失事故が
  `docs/autonomy.md` §4 に記録されているため）、以下の2箇所を壊して赤くなることを
  確認し、コピーから復元して緑に戻ったことを再確認した。

  1. `archive-sweep-json.ts` の `computeRecalledActiveShare` の分子分母を入れ替え、
     `exitCodeForArchiveSweepCostRun` の `supported` 判定を反転 → 4件のテストが失敗
     → 復元後、30件全て成功。
  2. `archive-sweep-cost-summary-lib.mjs` の `DEGENERATE_SHARE_THRESHOLD` を
     `0.999` から `0.001` に変更 → 3件のテストが失敗 → 復元後、74件全て成功。

  **【実測】6つの門**（この作業環境で）:

  - `pnpm --filter @mnemora/example-chat run typecheck` → 緑（エラー0件）
  - `pnpm run lint` → 緑
  - `pnpm run format:check` → 緑
  - `pnpm run test` → 緑。ただし「DB テストは実行していません」と明示して通っている
    （`docs/autonomy.md`/[ADR 0015](./0015-root-test-gate-reports-skipped-db-tests.md) の
    仕様どおり。**DB 側は判定不能——CI の `archive-sweep-cost` ジョブが実測の場になる**）。
  - `pnpm run build` → 緑
  - `pnpm run pack:check` → 緑

  **【現物】** `.github/workflows/ci.yml` を `js-yaml`（`node_modules` 配下の
  別パッケージのものを間借り。この repo 自体は yaml パーサを依存に持たない）で
  parse し、`jobs['archive-sweep-cost']` が意図した構造（`steps` 10段、
  `env.DATABASE_URL` あり）を持つことを確認した。

- **確かめていないこと**:

  - **本物の Postgres + pgvector に対してこの bench を実行したこと**（負債1）。
    CI が初めての実測の場になる。
  - **CI が実際に緑になること。**PR を出した時点ではまだ CI の結果を見ていない
    （この ADR は PR 作成前に書いている。CI の結果は PR 本文に別途記載する）。
  - **`local` embedding の重み取得が CI のネットワーク環境で成功すること**
    （`identifier-probes`/`consolidation-cost` ジョブが既に同じキャッシュキーで
    運用しているため成功する可能性は高いが、この PR 自体としては未確認）。
  - **`halfLifeHours=1`/`marginHours=0.5` という具体的な数値が、CI の実行速度
    （embed の drain・DB 往復にかかる時間）に対して十分な余裕を持つかどうか**の
    実測値。理論上の計算（決定2）はしたが、実行時間の変動まで含めた実測ではない。
