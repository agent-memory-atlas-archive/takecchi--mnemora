# ADR 0186: `sweepArchive` は `opts.clock` 省略時に `tenant_settings.decay_clock` へ従う — ADR 0165 決めたこと12 の数え漏れ（掃引）を埋める

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

- **文脈**:

  [Issue #364](https://github.com/takecchi/mnemora/issues/364) は次を指摘した:
  `packages/core/src/runtime.ts` の `Runtime.sweepArchive` は `opts` をそのまま
  `MemoryStore.archiveDecayed` へ渡すだけで、`decay_clock` を一度も読まない。
  唯一の本番の呼び出し元 `examples/chat/src/archive-sweep-cost.ts:311` も
  `clock`/`nowSeq` を渡していない。⟹ `ArchiveDecayedOptions.clock` の既定
  （`packages/postgres/src/memory-store.ts` の `buildArchiveDecayedTargetSelect`、
  `opts.clock ?? "wall"`）がそのまま効き、**テナントが `decay_clock='activity'` を
  選んでいても、掃引は常に壁時計（`decay_floor_at`）で動く。**

  **これは Issue #305 が立てた約束（[ADR 0165](./0165-decay-activity-clock.md)）を
  無効化する。** ADR 0165 は「低頻度の採用者で記憶が一律に沈む」という懸念に対し、
  活動時計（`decay_floor_seq`、recall の回数を単位にする）をテナントが選べるようにした。
  ところが、`recall()` の忘却ゲート（`packages/core/src/recall-runtime.ts:353-358`）は
  `decay_clock` に従って `decay_floor_seq` だけを見るのに対し、**掃引
  （`sweepArchive`）は `decay_floor_at`（壁時計）だけを見続ける。** 結果として、

  - `recall()` から見ればまだ生きている（`decay_floor_seq` が未来）記憶が、
  - `sweepArchive` からは沈んでいる（`decay_floor_at` が過去）ため `archived` にされる。

  低頻度テナント（1日に何度も recall しない採用者）ほどこの乖離が大きい。既定値
  （`DEFAULT_HALF_LIFE_HOURS=720`、`DEFAULT_DECAY_THRESHOLD=0.05`）での壁時計の床は

  ```
  720時間 × log2(1/0.05) ≈ 3111.8時間 ≈ 129.7日
  ```

  で来るのに対し、活動時計の床（`DEFAULT_HALF_LIFE_RECALLS=720`）は

  ```
  720回 × log2(1/0.05) ≈ 3111.8回 → ceil → 3112回
  ```

  の recall で来る（`packages/core/src/strategies/decay.ts` の `decayFloorOffset`・
  `activityFloorAt` の式そのもの）。**1日1回しか recall しないテナントが `'activity'` を
  選んだ意図は「3112回 recall するまでは沈めないでほしい」であるはずなのに、掃引は
  129.7日（採用直後なら4ヶ月強）で機械的に `archived` にしてしまう。** ⟹ 「低頻度でも
  一律に沈まない」という ADR 0165 の約束は、**recall では守られるのに掃引では破られる。**

  ⚠ **「データが失われる」わけではない。** `archived` は `status` 列の UPDATE のみで
  `content`/`digest` は残り、`Runtime.restoreArchived`（[ADR 0122](./0122-restore-archived-memory.md)）
  で `active` へ戻せる（`reinforce` も併走する、[ADR 0153](./0153-recall-decay-floor-gate.md)
  訂正）。**害は「recall には出続けている記憶が、呼び出し側の指示なしに勝手に `archived`
  に落とされ、以後 `recall()` から見えなくなる」ことである**——`archived` は
  `recall()` の候補生成の status ゲート（`["active","contested"]`）に入らないため、
  復元しない限り実質的に見えなくなる。

  **⭐ 原因は ADR 0165 決めたこと12 が数えた「減衰が読まれる3箇所」に、掃引が
  入っていなかったことである。** 決めたこと12 の表は次の3箇所だけを挙げていた:

  | 場所 | 何をしているか |
  |---|---|
  | `packages/postgres/src/vector-store.ts:72-73` | 段1の SQL ゲート（ANN チャンネル） |
  | `packages/core/src/recall-runtime.ts`（全チャンネル共通の後置フィルタ） | 語彙チャンネルの代替ゲート |
  | `packages/core/src/strategies/scoring.ts:182,191` | 段2の再スコア係数 |

  `MemoryStore.archiveDecayed`（ADR 0114 の掃引）は `ArchiveDecayedOptions.clock` を
  **ADR 0165 自身が足している**（決めたこと15、`nowSeq`/`clock` は元から在る）——
  つまり **store 側の口は最初から2軸に対応していた。** 抜けていたのは
  `Runtime.sweepArchive`（呼び出し側の runtime 層）が `opts.clock` を省略したときに
  `tenant_settings.decay_clock` を読んで埋める配線であり、これは決めたこと12 が
  数えた3箇所のどれとも重ならない**第4の読み出し点**だった。実際、ADR 0165
  「引き受けた負債」3番は逐語でこう書いている:

  > **`archiveDecayed` の掃引が2軸になった**（ADR 0114）。`'activity'` / `'either'` の
  > テナントでは、時刻の範囲走査だけでは沈んだ記憶を拾いきれない。

  ⟹ **ADR 0165 は、掃引が2軸で「呼べる」ことは実装し、負債としても名指ししていた。
  抜けていたのは「呼び出し元（`Runtime.sweepArchive`・`examples/chat`）がその軸を
  実際に選ぶ配線」だけである。** ⟹ **本 ADR は ADR 0165 を置き換えるものではなく、
  決めたこと12 の数え漏れ（掃引という第4の読み出し点）を埋めるものである。**

- **決めたこと**:

  1. **`Runtime.sweepArchive`（`packages/core/src/runtime.ts`）が、`opts.clock` を
     省略されたときに限り `tenant_settings.decay_clock` を読んで補う。**

     ```ts
     const clock = opts.clock ?? (await readDecayClock(deps.tenantSettingsStore, ctx));
     const nowSeq =
       opts.nowSeq ??
       (clock === "wall" ? undefined : await readActivitySeq(deps.tenantSettingsStore, ctx));
     const result = await archiveDecayed.call(deps.memoryStore, ctx, { ...opts, clock, nowSeq });
     ```

     `resolveActivityClockInputs`/`resolveReinforceNowSeq`（同じファイル、ADR 0165
     決めたこと12・16）と同じ2関数（`readDecayClock`/`readActivitySeq`、
     `packages/core/src/interfaces/tenant-settings-store.ts`）をそのまま使う——
     この掃引のためだけの新しい読み出し経路は作らない。

  2. **`opts.clock` を明示で渡した呼び出し元の挙動は1バイトも変えない。** `??` に
     しているのは、**将来 `examples/chat` や他の呼び出し元が明示的に `clock` を
     渡す形へ変わっても壊れない**ようにするため——省略時の穴埋めであって、
     常に store 側で決め直すわけではない。

  3. **`decay_clock` を設定していないテナント（既定 `'wall'`）は挙動が1バイトも
     変わらない。** `readDecayClock` は `getDecayClock` 未実装／`'wall'` のどちらでも
     `'wall'` を返し、`clock === "wall"` のときは `nowSeq` の解決式が `readActivitySeq`
     を評価しない（`??` の右辺は左辺が `nullish` のときしか評価されない、かつ
     三項演算子で `"wall"` 側は `undefined` を返すだけで `await` を経由しない）——
     ⟹ **`'wall'` のテナントでは `tenant_activity` に一度も触れない。**
     `resolveActivityClockInputs`/`resolveReinforceNowSeq` が既に守っている規律
     （ADR 0165 決めたこと5「活動時計は、テナントがそれを使うと決めるまで動かない」）を、
     この4つ目の読み出し点でも同じ形で守る。

  4. **`restoreArchived` の JSDoc（`packages/core/src/runtime.ts`）の不正確な一文を直す。**
     ADR 0153 訂正の説明が「`sweepArchive` が `archived` にする選定条件はまさに
     `decayFloorAt <= now` である」と書いていたが、これは `'activity'`/`'either'` の
     もとでは不正確になる（選定条件は `decay_clock` に応じて `decayFloorSeq <= nowSeq`
     を軸に含みうる）。「テナントの `decay_clock` に従う」という一文に直す。
     `Runtime.sweepArchive`/`ArchiveDecayedOptions` 側の doc コメントにも、
     省略時は `decay_clock` に従うことを明記する。

- **北極星の5つの問いに実際に当てた結果**:

  | 問い | この判断にどう当たったか | 落ちた案 |
  |---|---|---|
  | **1**（毎回渡す量を減らす方向に働くか） | 該当しない——掃引は `recall()` の経路ではなく、渡す量に影響しない。 | — |
  | **2**（無効にしても Memory Framework として成立するか） | `opts.clock` を明示すれば今日までと同じ経路が使える。新しい必須の口を1つも作らない。 | — |
  | **3**（選ばれた理由を後から説明できるか） | **これが本題である。** `'activity'` を選んだテナントで、なぜ想起できる記憶が `archived` に落ちないのか（あるいは落ちるのか）を、`decay_clock` という単一の設定から説明できるようになる。 | 「掃引は壁時計専用の保守操作と割り切る」案（下記「採らなかった案」の裏返し）——問い3で「なぜ活動時計を選んだのに壁時計で沈むのか」を説明できず落ちる。 |
  | **4**（推論と事実を区別しているか） | 該当しない。 | — |
  | **5**（LLM を呼ばずに済ませられないか） | 既存の `readDecayClock`/`readActivitySeq`（`tenant_settings`/`tenant_activity` の読み取り）だけで完結する。 | — |

- **採らなかった案**:

  1. **呼び出し元（`examples/chat`）に `clock`/`nowSeq` を明示的に渡させる。**
     `examples/chat/src/archive-sweep-cost.ts:311` の呼び出しに `clock: "activity"`
     等を足すだけでも症状は消える。**採らなかった理由**: これは「本番の呼び出し元
     すべてに、`decay_clock` を読んで `sweepArchive` へ渡す責務」を漏らす形になる。
     `sweepArchive` を呼ぶ経路は `examples/chat` 以外にも将来増えうる
     （保守スクリプト・外部スケジューラ等、`Runtime.sweepArchive` の doc コメントが
     「呼び出し側が明示的にこれを呼んだときだけ走る保守操作」と書いているとおり
     自動では走らない）——**呼び出し元の数だけ同じ配線を複製することになり、
     1箇所でも忘れると（テナントが `decay_clock` を切り替えたことを呼び出し元が
     知らないまま）静かに壊れる。** `resolveActivityClockInputs`/
     `resolveReinforceNowSeq` が `observe`/`restoreArchived` の呼び出し元に
     この責務を負わせていないのと対称的に、`sweepArchive` だけ呼び出し元に
     負わせる理由が無い。

  2. **`decay_floor_at` を活動時計テナントでは書かない、または `NULL` にする。**
     壁時計の列を書かなければ、掃引の壁時計側の範囲走査には最初から掛からない。
     **採らなかった理由**: `memories.decay_floor_at` は **`NOT NULL`** である
     （ADR 0165 決めたこと4は `decay_floor_seq`（活動時計側）を `NULL` 許容にした
     ものであり、逆側の壁時計の列を緩めるものではない）。加えて、`decay_clock`
     には `'either'` という第3の値があり、これは「両方の軸で沈んでいるものだけ掃く」
     （`ArchiveDecayedOptions.clock` の doc コメント、AND）ために**両方の列が
     常に埋まっている**ことを前提にしている——`'either'` を選んだテナントで
     壁時計側を書かない/`NULL` にすると、`'either'` の掃引条件そのものが
     成立しなくなる。**列のスキーマ（NOT NULL）とテナント設定（`'either'`）の
     両方と矛盾する。**

- **引き受けた負債**:

  1. **`decay_clock != 'wall'` のテナントでは、`sweepArchive` の呼び出しごとに
     `tenant_settings`/`tenant_activity` への往復が1回ずつ増える**
     （`readDecayClock` 1回・`readActivitySeq` 1回。`opts.clock`/`opts.nowSeq` を
     明示すれば増えない）。`'wall'`（既定）のテナントには一切掛からない
     （決めたこと3）。掃引は「低頻度の保守操作」であり（ADR 0114 の doc コメント）、
     recall のようにホットパスではないため、**この往復の増分は測っていない**が
     割に合わないほどの回数で呼ばれる経路ではないと見積もっている。

  2. **`'either'` の掃引は AND のままであり、この修正は索引の効き方を変えない。**
     `ArchiveDecayedOptions.clock` の doc コメントが既に明記しているとおり、
     `'either'` は段1のゲート（OR、寛容な側）の論理否定（AND、厳格な側）であり、
     「1本の索引で範囲スキャンできる」ことは主張しない——これは ADR 0165
     「引き受けた負債」2番が段1のゲート自身についてすでに引き受けている負債と
     同じ理由である。**本 ADR は `opts.clock`/`opts.nowSeq` を正しく埋めるだけで、
     `'either'` のクエリ計画そのものには一切手を入れていない。**

  3. **`FakeMemoryStore.archiveDecayed`（`packages/core/src/__tests__/runtime-fakes.ts`）は
     壁時計の `decayFloorAt` だけで絞り込む素朴な実装のままである。** 本 ADR が
     足した歯は「`Runtime.sweepArchive` が `MemoryStore.archiveDecayed` へ正しい
     `opts`（`clock`/`nowSeq`）を渡すか」を `vi.spyOn` で検査するものであり、
     `FakeMemoryStore` 自身が2軸で正しく絞り込むかどうかは検査していない
     （その検査は `packages/postgres`/`packages/testkit` の適合テストの役目であり、
     ADR 0165 が既に持っている）。**⟹ この修正の core 側の歯は「引数を正しく
     組み立てているか」だけを見ており、store 実装側の絞り込みの正しさには依存しない
     形にしてある。**

- **これが覆るとしたら**:

  1. **実運用で「何日/何回で沈むか」の数字が出て、既定の `halfLifeHours`/
     `halfLifeRecalls` の比が見直されたとき。** 本 ADR は既定値そのものを一切
     動かしていない——129.7日 / 3112回という数字は ADR 0165 が既に固定した
     既定値の帰結であり、その基準を動かす条件（既定を `'wall'` から動かす3条件、
     ADR 0165 決めたこと10）はここでは触っていない。

  2. **掃引の呼び出し元が `decay_clock` を知らないところ（外部スケジューラ・
     `@mnemora/core` を直接叩かない運用ツール等）へ移ったとき。** そのときは
     「採らなかった案」1番（呼び出し元に渡させる）の再検討、あるいは
     `MemoryStore.archiveDecayed` 自体の既定を変える判断があり得る——
     ただし後者は npm 公開済みの `ArchiveDecayedOptions` の意味論を動かす
     破壊的変更であり、別の ADR の仕事である。

- **測ったこと**:

  - `pnpm --filter @mnemora/core run typecheck` — 緑（`tsc -p tsconfig.json` の出力
    無し、exit 0）。
  - `pnpm run lint`（`eslint .`、リポジトリ全体）— 緑。
  - `pnpm run format:check`（`prettier --check`、リポジトリ全体）— 緑
    （`All matched files use Prettier code style!`）。
  - `pnpm --filter @mnemora/core exec vitest run src/__tests__/runtime.test.ts` — 緑、
    **79 tests passed**（既存75 + 本 ADR が足した4）。
  - **変異試験**（`docs/autonomy.md` §2、退避コピーは `cp` で取り、`cp` で戻し
    `diff` で一致を確認した——`git checkout` は使っていない）:

    | 変異 | 結果 |
    |---|---|
    | `clock` の解決を `opts.clock ?? "wall"` に戻す（`decay_clock` を読まない、修正前の形） | **赤2件**（`decay_clock='activity'` で `clock: 'activity'` を期待する歯／`'either'` で `nowSeq` を期待する歯） |
    | `'wall'` のときも `readActivitySeq` を無条件に呼ぶようにする | **赤2件**（`'wall'` で `nowSeq` が `undefined` であることを期待する歯／`opts.clock` 明示 `'wall'` で `nowSeq` が `undefined` であることを期待する歯） |

    どちらの変異も、退避しておいた原本と `diff` で一致することを確認したうえで
    `cp` により復元し、復元後に同じ4件の歯が緑へ戻ることを確認した。

- **確かめていないこと**:

  - **DB を要する段（`packages/postgres`/`examples/chat` の DB テスト、
    `retrieval-quality`/`archive-sweep-cost` などの CI ジョブ）は走らせていない。**
    `docs/autonomy.md` の走らせ方の制約により、DB 段・全体の `test`/`build`/
    `pack:check` は CI に委ねている。本 ADR の変更は `packages/core` 内で完結し、
    `packages/postgres`/`examples/chat`/`packages/testkit` には触れていないため、
    それらの既存の歯（store 側の2軸の絞り込み自体、ADR 0165 が既に持つ）が
    本 ADR によって変わることは無いはずだが、**それ自体は CI 側で見届ける。**
  - **`examples/chat/src/archive-sweep-cost.ts` の `compare`/`archive-sweep` の
    実測**（低頻度テナントを模した実運用の数字）は本 ADR では取っていない。
    ⭐門（`compare-baseline.json`/`docs/north-star.md`/`scripts/compare-summary*.mjs`）
    には一切触れていない——本 ADR の射程は `Runtime.sweepArchive` の配線であり、
    ⭐門が測る比較シナリオの数字を動かす変更ではないという判断だが、**その判断自体を
    実測では検算していない。**
  - **`'either'` のクエリ計画（EXPLAIN）**は、本 ADR では一切測っていない
    （負債2番のとおり、この修正はクエリ計画に触れていないため対象外と見積もっている）。
