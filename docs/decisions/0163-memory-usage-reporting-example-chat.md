# ADR 0163: `examples/chat` が `memory_usage` を報告する — `reinforce` を実アプリで発火させる（Issue #301）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0133 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた。この作業環境には
  `DATABASE_URL` が無かったため、`initdb`/`pg_ctl` で自分専用の Postgres 17 +
  pgvector 0.8.0 のクラスタを立て（`/usr/lib/postgresql/17/bin`、パッケージ
  `postgresql-17-pgvector` が最初から入っていた）、CI の `example-chat` ジョブと
  同じ拡張（`vector`/`btree_gin`/`pgcrypto`）を有効にして測った。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 文脈

**Issue #301**: `reinforce`（使われた記憶の減衰を遅らせる側）の呼び出し口は
`packages/core/src/runtime.ts` の `handleMemoryUsage` に**在る**が、
`examples/chat` がそれを起動する `observe({kind:'memory_usage', recallId,
usedMemoryIds})` を一度も呼んでいなかった【現物、issue 本文と一致することを
`grep -rn "memory_usage" examples --include="*.ts" | grep -v __tests__` で再確認、
0件】。連鎖は:

```
observe({kind:'memory_usage', ...}) → handleMemoryUsage
  → memoryStore.recordUsage(...) → insertedMemoryIds
  → insertedMemoryIds ごとに reinforce(ctx, memoryId, now)
```

`reinforce` は `last_reinforced_at`/`decay_floor_at` を更新するが **`strength` は
動かさない**（ADR 0041。テスト側で明示的に固定されている契約）。この鎖の起点が
どこからも引かれていないため、**使われた記憶と使われなかった記憶が同じ速さで
遠ざかっていた**——`docs/north-star.md`「目指す姿」の「使われない記憶が、静かに
遠ざかる」が言う*選別*が、実アプリでは効いていなかった。

---

## 決めたこと

### 決定1: `examples/chat/src/mnemora-path.ts` に明示的な opt-in 関数 `reportMemoryUsage` を足す

```ts
export type MemoryUsageReport =
  | { reported: true; recallId: RecallResult["recallId"]; usedMemoryIds: string[] }
  | { reported: false };

export async function reportMemoryUsage(
  runtime: Runtime,
  ctx: Ctx,
  recall: RecallResult,
): Promise<MemoryUsageReport>
```

`recall.memories.map(m => m.memoryId)` を `usedMemoryIds` とする——これは
`buildMnemoraPrompt(recall)`（既存関数、「実際にプロンプトへ積む文字列」を組み立てる）
が積んでいるのと**同じ集合**である【現物】。0件なら `observe()` を呼ばずに
`{reported:false}` を返す——`ObserveMemoryUsageInputSchema.usedMemoryIds` が
`z.array(...).min(1)` であり、空配列を渡すと zod に弾かれるため、呼び出し側で
この分岐を持つ必要がある【現物、`packages/core/src/observation.ts`】。

`RecallResult.recallId` は元から公開されている欄で、doc コメントが
「`observe()` の usage 報告で使う」と明記していた【現物、`packages/core/src/
recall.ts`】——**この ADR は新しい欄を足していない。**繋いでいなかっただけである。

### 決定2: 配線先は `cli.ts` の `chat` サブコマンドと `compare.ts` の `runComparison`

- **`cli.ts` の `runChat()`**: `buildMnemoraPrompt(withoutBudget)` を画面へ出した
  直後に `reportMemoryUsage(handle.runtime, ctx, withoutBudget)` を呼ぶ。
  **budget 有りの2回目の recall（`withBudget`）は報告しない**——このデモは
  「budget が実際に切り詰める」ことを見せる別の実演であり、`withoutBudget` の
  デモ（「呼び出し側がプロンプトへ積む文字列」を明示的に印字する箇所）だけが
  「実際にプロンプトへ積んだ」という前提を文章として持っている。両方報告する
  案も検討したが、下の「採らなかった案」参照。
- **`compare.ts` の `runComparison`**: 各行の `recall`/`factStatementSurvived`
  を測り終えたあとに `reportMemoryUsage(runtime, ctx, recall)` を呼ぶ。
  `ComparisonRow` に `memoryUsageReported: boolean` を足し、可視化・テストの
  歯を置けるようにした。**`compare-json.ts` の `buildCompareJson`/
  `CompareRowJson` はこの欄を写さない**——⭐ 門（ADR 0133）の `compare.json`
  スキーマを変えないため、明示的に列挙から外してある。
  `runComparison` は `cli.ts` の `runCompare()`（対話 `compare` サブコマンド）と
  `recordCompare()`（`record:compare`、カセット記録）の両方から呼ばれるため、
  **この配線は両方に一度で効く**。`handleMemoryUsage` は抽出器を通らず
  LLM/Embedding を一切呼ばない（`observation.ts` の doc コメント「使用報告は
  抽出器を通らず recall_usages へ直接反映される」【現物】）ため、カセット記録側
  （`recordCompare`）に新しい API 呼び出しを増やさない。

### 決定3: 北極星の問い2「これを無効にしたとき、Memory Framework として成立するか」

**成立する。** `reportMemoryUsage` は `tick()`/Scheduler/`TICK_SUPPORTED_JOB_KINDS`
のどこにも登録していない、ただの明示的な非同期関数である。呼ばない呼び出し側は
今までどおり `observe`/`recall` が成立する——**実際に、`examples/chat` の残り
7本の呼び出し側（`scope.ts`/`retrieval-quality.ts`/`identifier-arm.ts`/
`consolidation-cost.ts`/`archive-sweep-cost.ts`/`backfill.ts`/
`time-term-arm.ts`）はこの PR の後も1つも呼んでいない**【現物、
`grep -rn "reportMemoryUsage" examples/chat/src/*.ts` の結果が `cli.ts`/
`compare.ts` の2ファイルだけであることを確認】。これらは以前と1バイトも
挙動を変えず、`memory_usage` 種の Observation を作らないまま recall し続ける
——ADR 0114 決定3（`sweepArchive`）・0115 決定7（`event_retention_purge`）と
同じ「明示的に呼んだときだけ走る」規律をそのまま踏襲した。

---

## 検討して採らなかった案

1. **⛔ `runtime.observe`/`runtime.tick` の内部で自動的に使用報告する。**
   却下——決定3の理由そのもの。呼び出し側が「実際に何を使ったか」を知っているのは
   呼び出し側だけであり、`recall()` が返した候補を自動的に「使った」ことにすると、
   一度も画面に出さなかった記憶まで reinforce してしまう。それは「使われた記憶が
   居着く」の意味を破壊する。

2. **⛔ `chat` サブコマンドで budget 有り/無し両方の recall を報告する。**
   却下（今回は）——2回報告すると、同じ会話・同じテナントに対して2つの
   `recallId` が「使用報告された」ことになり、デモの読み手が「結局どちらの
   recall が実際に使われたことになっているのか」を混同しやすくなる。
   `buildMnemoraPrompt` を明示的に印字している箇所（`withoutBudget`）だけを
   報告対象にし、`withBudget` は「budget が切り詰める」という別の主張の実演に
   留めた。**引き受けた負債1として残す**（下記）。

3. **⛔ `ComparisonRow.memoryUsageReported` を `compare-json.ts` の
   `CompareRowJson` にも足す。**
   却下——⭐ 門（ADR 0133）が比較しているのは `mnemoraShareOfNaiveChars`/
   `factStatementSurvived` の2値だが、`compare.json` のスキーマ自体を広げると
   「この PR は compare.json の形も変えた」という主張が増え、ADR 0133 の
   決定4（「全欄一致を門にしない」）の理由と紛れる。可視化はテスト・呼び出し側
   （`ComparisonRow` を直接読む TypeScript コード）で足りる。

4. **⛔ `recall.memories` のうち一部だけを「実際に LLM が引用した」ものとして
   報告する仕組みを作る（citation ベースの報告）。**
   却下（この PR の範囲外）——`examples/chat` の `chat`/`compare` はどちらも
   実際に LLM が最終応答でどの記憶を引用したかを追跡していない（deterministic/
   recorded provider を使うベンチであり、引用抽出は Phase 1 の範囲に無い）。
   この PR が報告するのは「recall() の結果として実際にプロンプトへ積んだ集合」
   であり、「LLM が実際に言及に使った部分集合」ではない——両者の違いは
   引き受けた負債2として明記する。

---

## 引き受けた負債

1. ⚠ **`chat` サブコマンドの budget 有り recall は使用報告しない。** 実運用で
   budget を使う呼び出し側が居るなら、その recall も報告対象にすべきかは
   別途判断が要る——このデモはそれを実演していない。
2. ⚠ **報告される「使った」は「recall() が返した」の意味であり、「LLM が実際に
   応答で言及した」の意味ではない。** `examples/chat` は LLM の応答文から
   引用を抽出する機構を持たない。実運用のアプリケーションが `reportMemoryUsage`
   と同じパターンを採るときは、この違いを認識した上で「recall() が返した全件」
   を "used" とみなすか、より狭い集合を渡すかを自分で選ぶ必要がある。
3. ⚠ **decay の差の実測（下記）は、1本の Postgres テストが作った1つの
   シナリオでの実測であり、統計的な主張ではない。** 「使われた記憶のほうが
   常にこれだけの比率で長生きする」という一般的な数値ではない——decay の差は
   半減期・reinforce のタイミング・記憶の個数に依存する。

---

## これが覆るとしたら

- **実運用の呼び出し側が「recall() が返したが実際には使われなかった記憶」を
  reinforce してしまうことを問題視したとき。** そのとき citation ベースの
  報告（採らなかった案4）を再検討する材料が要る。
- **`chat` サブコマンドの budget 有り recall についても reinforce を実演したい
  という要望が出たとき。** 引き受けた負債1を埋める。

---

## 測ったこと

**【実測】ブランチ**: `feat/301-memory-usage-reporting-example-chat`。

**【実測】ADR 番号の衝突を、この1本の PR で3回踏んだ**（`docs/autonomy.md` §4
「1つのセッションで3回起きた実績がある」の再現）。この repo は複数のエージェントが
並行して PR をマージしており、`git fetch origin main` 直後に空きだと確認した番号が、
push する頃には別の merge 済み PR に取られている、ということが3回連続で起きた:

| 試行 | 選んだ番号 | 衝突相手 | 発覚した方法 |
|---|---|---|---|
| 1 | 0159 | PR #325（Issue #304）が main に merge 済みだった | `git fetch` 直後の再確認で事前に発覚 |
| 2 | 0160 | PR #330（Issue #306、当時 open） | `git fetch` 直後の再確認で事前に発覚 |
| 3 | 0161 | PR #328（Issue #312）が push 後に main へ merge された | CI の `typecheck / lint / test / build` ジョブの `adr-duplicate-number.test.mjs` が赤くなって発覚 |
| 4 | 0162 | PR #320/#331 系（Issue #303）が push 後に main へ merge された | 同上 |
| **5（採用）** | **0163** | （この ADR の作業時点で衝突なし） | `git fetch` 直後・push 直前の2回、`gh pr list --state open` も確認して押した |

⟹ **「push 直前に確認する」だけでは、この repo の merge 速度には追いつかないことがある**
——3・4回目は「確認して空きだった番号」が、CI 実行中〜完了までの数分の間に
別 PR の merge で埋まった。**CI が検知して教えてくれる**
（`scripts/__tests__/adr-duplicate-number.test.mjs`、Issue #315／PR #318
「ADR 番号の重複を PR でも検出する」）ため実害は無かったが、
同じ番号を採番し直す作業が3往復発生した——製品判断ではなく作業手順の記録として
ここに残す。

**【実測】ローカル Postgres 環境**（`DATABASE_URL` が元から無い作業環境のため、
自分で用意した）:

```
$ dpkg -l | grep postgres
postgresql-17                 17.11-0+deb13u1
postgresql-17-pgvector        0.8.0-1
$ initdb -D ~/pgdata -U postgres --auth=trust
$ pg_ctl -D ~/pgdata -o "-k ~/pgsock" start
$ psql ... -c "CREATE EXTENSION vector; CREATE EXTENSION btree_gin; CREATE EXTENSION pgcrypto;"
```

CI の `example-chat`/`postgres` ジョブが使う `pgvector/pgvector:pg17` の
拡張3種と同じ組み合わせ【現物、`.github/workflows/ci.yml`】。

**【実測】新設した本物の Postgres 上の歯**
（`examples/chat/src/__tests__/memory-usage-reinforce.postgres.test.ts`）:

会話16件（fact 1 + filler 15）を ingest し、既定 limit(10) で絞り込まれる
recall を2回（`t0`・`t0+200h`）撃って `reportMemoryUsage` で報告し、
`t0+400h` の時点で読み戻した:

```
[Issue #301 実測] recall_usages に入った行数: 20（recall1: 10件 + recall2: 10件 の報告に対応）
[Issue #301 実測] decayFloorAt 使用側=2027-01-31T22:28:45.821Z 対照側=2027-01-23T14:28:45.821Z
[Issue #301 実測] t2(+400h)時点の decay(strengthAt): 使われた側=0.8248605943353025 対照側=0.6803950000871885 (差=0.144465594248114, 比=1.2123260668135445)
```

- `recall_usages` に実際に20行入った（`pool.query` で直接数えた。単体テストの
  緑だけでなく SQL の直接カウントで確認した）。
- 使用報告された Memory の `last_reinforced_at` は reinforce が発火した時刻
  （2回目の報告時刻 `t1 = t0+200h`）に一致し、一度も使用報告されなかった
  Memory（対照群、`status='active' AND id != ALL(...)` で直接 SQL 抽出）は
  `last_reinforced_at` が作成時のまま `null` だった。
- `decay_floor_at` は使用側が対照側より約8日後ろにずれていた（ADR 0010の
  `floorAt` が reinforce の新しい基準点から再計算されるため）。
- 同一時刻 `t2` に対して `defaultDecayStrategy.strengthAt` を計算すると、
  使用側 0.8249、対照側 0.6804（比 約1.21）——**使われた記憶のほうが、
  同じ壁時計時間の経過に対して、より遠ざかっていない**ことを実測した。

**【実測】変異試験**（`docs/autonomy.md` §2。`git checkout` は使わず
`/tmp/mutation-backup-301/` へ `cp` で退避してから戻した）:

1. `mnemora-path.ts` の `reportMemoryUsage` から `runtime.observe(...)` 呼び出しを
   無効化（`if (true) return {...}` で早期リターン）→
   `mnemora-path.test.ts`（単体、observe のモック呼び出し回数を見る歯）と
   `memory-usage-reinforce.postgres.test.ts`（`recall_usages` の行数・
   `last_reinforced_at` を見る歯）の両方が赤くなった。`recall_usages` の行数は
   期待値20に対し実測0。復元後、両方とも緑に戻った。
2. `compare.ts` の `runComparison` で `reportMemoryUsage` の呼び出しを
   `{reported:false}` の即値へ差し替え → `compare.postgres.test.ts` に新設した
   「各行で使用報告が実際に行われ、recall_usages に returnedCount と同じ件数の
   行が入る」歯が赤くなった。復元後、緑に戻った。

**【実測】examples/chat の `test:db`**（42ファイル・342テスト、上記ローカル
Postgres に対して）: 全件緑。

**【実測】ルートの6門**:

- `pnpm run typecheck` → 緑（8 workspace のうち7、examples/chat 含む）
- `pnpm run lint` → 緑
- `pnpm run format:check` → 緑
- `pnpm run build` → 緑
- `pnpm run pack:check` → 緑
- `pnpm run test`（`DATABASE_URL` 無し）→ 緑。「DB テストは実行していません」と
  明示して通った（ADR 0015 の仕様どおり）。943テスト。
- `DATABASE_URL` 有りで `node scripts/run-db-tests.mjs`（`packages/postgres`+
  `examples/chat` の `test:db` を排他実行）→ (CI/PR 本文で追記——このADR執筆時点
  ではクリーンな1本の実行結果を別途確認中。並行して別の vitest 呼び出しを
  同じ DB に当てると FK 違反で無関係なテストが赤くなることを実際に踏んだ
  ——これは環境側の排他ルールを破った自分の操作ミスであり、コードの欠陥では
  ないことを、対象テストを単体で再実行して確認した)。

**【実測】⭐ 門（ADR 0133）への影響——ローカルでの先行確認**:

`examples/chat/cassettes/compare.json`（記録済み実 API 応答の再生、
`recorded` provider）に対して `compare` サブコマンドを上記ローカル Postgres で
実行し、`MNEMORA_COMPARE_JSON` で書き出した JSON を
`examples/chat/compare-baseline.json` と比較した:

```
$ node scripts/compare-summary.mjs --measured /tmp/compare-local.json \
    --baseline examples/chat/compare-baseline.json
✅ 一致(差分なし)。全会話長で北極星の物差し(mnemoraShareOfNaiveChars 他)が
examples/chat/compare-baseline.json と同じだった。
```

12行すべて完全一致（`turnCount` 2/4/6/8/10/12/22/42/82/162/322/642、
`mnemoraShareOfNaiveChars`/`factStatementSurvived` を含む）。これは
「報告は測定済みの recall の後に呼ぶ」という配線方針（`reportMemoryUsage` は
`recall` を受け取るだけで撃たない）が実際にその行の測定値へ影響しないことの
実測である。

**【実測・追記】PR #332 の CI（`example-chat` ジョブ、最終的な head sha
`ded3034aafbe09369a6b39ef78e2d56650ec3095` の run `35037229437`。ADR 番号の
衝突を3回踏んで採番し直した経緯は下記「測ったこと」参照）が成功したのち、
ADR 0133 が定めた本来の手順（`gh run download` で artifact を取得して比較する）
でも同じ比較を行った**:

```
$ gh run download 35037229437 -n compare -D /tmp/ci-compare-332-final
$ node scripts/compare-summary.mjs --measured /tmp/ci-compare-332-final/compare.json \
    --baseline examples/chat/compare-baseline.json
✅ 一致(差分なし)。全会話長で北極星の物差し(mnemoraShareOfNaiveChars 他)が
examples/chat/compare-baseline.json と同じだった。
```

**⟹ ローカルでの先行確認と、CI artifact に対する本来の手順の、両方が同じ結論
（差分なし）を出した。** ⭐ 門（ADR 0133）の基準値はこの PR で動かない。

## 確かめていないこと

- **本物の LLM（`OPENAI_API_KEY` 有り）に対する実行では確かめていない。**
  `recorded`/`deterministic` provider でのみ検査した。
- **`chat` サブコマンドの budget 有り recall を報告した場合に何が変わるかは
  試していない**（引き受けた負債1）。
- **decay の差が、より長い壁時計時間・より多い記憶数でどう変化するかは
  測っていない**（引き受けた負債3）。

## 人から受け取った前提（出所付き）

- Issue #301 の本文——`gh issue view 301` で直接読んだ【現物】。
- ADR 0009 / 0041 / 0114 / 0115 / 0133 の内容——`docs/decisions/` から直接読んだ
  【現物】。
- マネージャーからの作業指示（本 PR の背景・作業場所・報告様式、実装方針の
  たたき台）——委譲文として受け取った。技術的な決定（`reportMemoryUsage` の
  形・配線先の選択・`compare.json` スキーマを変えない判断）はこの ADR が
  自分で決めたものであり、指示そのものの丸写しではない。
