# ADR 0178: 公開 API 表面の破壊的変更を検出する歯を CI に足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 問い（[Issue #342](https://github.com/takecchi/mnemora/issues/342)）

v1.0.0 のリリース準備で `git diff v0.1.9..main` の公開面を人手で棚卸ししたところ（PR #341）、
公開 API の破壊的変更が2件、根拠 ADR に破壊性の記載が無いまま `main` に着地していたことが
見つかった。

| 変更 | パッケージ | 根拠 ADR | commit の `!` | ADR 本文の記載 |
|---|---|---|---|---|
| `Runtime.getRecall` を**必須**メソッドとして追加 | `@mnemora/core` | [ADR 0161](./0161-runtime-get-recall.md) | 無し | 破壊性への言及が無い |
| `TenantSettingsStoreConformanceOptions.supportsDecayClock` を**必須**フィールドとして追加 | `@mnemora/testkit` | [ADR 0165](./0165-decay-activity-clock.md) | 無し | 「この PR 全体が非破壊」と逆のことを断言（PR #341 で訂正済み） |

[ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) は「公開 API の破壊的
変更も、ADR を書けば実装してよい」という委譲であり、**ADR を書くことを免除してはいない**。
ところが `.github/workflows/ci.yml` の六つの門（`typecheck`/`lint`/`format:check`/`test`/
`build`/`pack:check`）のどれも、公開型の差分を見ていない——`pack:check`
（`scripts/check-publish-pack.mjs`）が検査する9項目は tarball の中身（`workspace:` 残存・
版の揃い・エントリポイントの実在・README 同梱等）であり、型の互換性は1つも見ていない。

⟹ **着地から発見まで、誰も気づいていなかった。**効いていた歯は「人が棚卸しすること」だけで
あり、それは v1.0.0 リリース準備という不定期な工程に依存していた。

## 決定

**新スクリプト `scripts/check-public-api-surface.mjs` を足し、`.github/workflows/ci.yml` の
既存の `build` ジョブ（`name: typecheck / lint / test / build`）の `Build` ステップの直後に
1ステップとして配線する。**

### 1. 対象パッケージは `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` を流用する

新しい対象リストを作らない。ADR 0066 が「publish 対象は1箇所（`PUBLISH_TARGETS`）へ集める」
と決め、2箇所に写しがある状態を消した経緯そのものであり、ここに3箇所目を作らない
（`scripts/check-publish-pack.mjs`/`scripts/check-cjs-transpile-parse.mjs` も同じ理由で
同じリストを import している）。

### 2. 起点は `package.json` の `exports.*.types`。相対 import/export を BFS で辿った
`.d.ts` だけを対象にする

`dist/` 配下を無差別に拾わない。**実測**（`packages/*/dist` を一度ビルドして確認した）:
`@mnemora/postgres` は `mapping.d.ts`（どの `.d.ts` からも import されず、コメントの中で
名前が言及されるだけ）・`bin/cli-options.d.ts`/`bin/migrate.d.ts`（`exports` に `bin` の
エントリは無く、到達しない）を持ち、`@mnemora/testkit` は `__fixtures__/id.d.ts`
（`fixtures.d.ts` が再 export していない内部専用ファイル）を持つ——6パッケージ中2つで、
無差別 diff だと計4ファイルの内部専用ファイルが混入する。これらを snapshot に含めると、
中身を読まずに「差分があるから `--write`」を繰り返す習慣ができる——歯の趣旨（破壊性の
申告を人間に強制する）と逆行する。

`@mnemora/testkit` は `exports` に `"."` と `"./fixtures"` の2エントリを持つ——両方を起点に
する（`entryTypesFilesFromExports` が `exports` の全サブパスのうち `types` を持つものを
拾う）。

### 3. `.cjs`/`.mjs` の相対 import を正しく `.d.cts`/`.d.mts` へ解決する

**実測で踏んだ粗さ**: `packages/postgres/dist/migrate.d.ts` は
`import { DEFAULT_MIGRATIONS_DIR } from "./migrations-dir.cjs"` を持つ（ADR 0086 / Issue
#110 が `import.meta` を CommonJS のサイドカー `.cts` へ追い出した副産物）。素朴な
「`.js` → `.d.ts`」変換だけでは、この import を「`migrations-dir.d.ts`」へ誤って解決しよう
とし（実在しないので例外か、見落としで BFS が途切れる）、実際の解決先
`migrations-dir.d.cts` を見つけられない。`scripts/public-api-surface-lib.mjs` の
`DECLARATION_EXTENSION_BY_SOURCE_EXTENSION`（`.js→.d.ts` / `.mjs→.d.mts` / `.cjs→.d.cts`）
で拡張子ごとに対応表を持ち、対応表に無い拡張子や解決先が実在しないケースは**例外を投げて
黙って読み飛ばさない**（`docs/autonomy.md` §4.1「静かに失敗する道具」の族を避ける）。

### 4. 既存 devDependency の `typescript` の parser/printer だけを使い、コメントを剥がして
正規化・連結する

新規依存は追加しない（ルート `package.json` の `typescript` devDependency を使う。各
package.json も同版の `typescript` を devDependency に持つ）。`ts.createPrinter({
removeComments: true }).printFile(sourceFile)` で JSDoc・行コメントを剥がす——**実測**:
`packages/postgres/dist/migrate.d.ts`（328行・13408文字）をこの方法で正規化すると
55行・2090文字になった(約84%の削減、コメントを残したままだと全体の約6割が本文になり、
実際にシグネチャが変わった行との signal/noise 比が落ちる)。

### 5. `--write`（snapshot 更新）と、既定の check モード（差分があれば unified diff・exit 1)

`format`/`format:check` と同じ対。既定は `pnpm run api:check`
（`node scripts/check-public-api-surface.mjs`)、書き込みは `pnpm run api:write`
(`--write`)。diff の生成は `/usr/bin/diff -u`（GNU diffutils、CI ランナーに標準搭載）を
`spawnSync` で呼ぶ——unified diff を自前実装せず、新規依存も足さない。

### 6. 差分が出たときのメッセージに、次にすることを書く

これがこの歯の狙い（破壊性の申告を人間に強制する）そのものである。メッセージは次を明記する:

1. この差分が破壊的変更かどうかを判断する。
2. 破壊的変更なら、根拠 ADR にその破壊性を明記する（ADR 0156 は ADR を書くことを免除
   していない)。
3. `node scripts/check-public-api-surface.mjs --write` で snapshot を更新し、コミットする。

### 7. snapshot は `scripts/__snapshots__/public-api/<パッケージ dir 名>.d.ts` として repo に
コミットする

6ファイル、合計 **5361行**（内訳: `core.d.ts` 2744・`postgres.d.ts` 1985・
`testkit.d.ts` 433・`local-embedding.d.ts` 81・`openai.d.ts` 62・`anthropic.d.ts` 56)。
`eslint.config.mjs`/`.prettierignore` の両方でこのディレクトリを除外した——snapshot は
TypeScript の printer がそのまま出力したものであり、コンパイル可能なソースでも
prettier 書式でもない（`eslint` はこれを実際のソースとして解析しようとし、
`@typescript-eslint/consistent-type-imports` 等の誤検知を実測で踏んだ。`dist/**` と
同じ扱いにした)。

### 8. CI は既存の `build` ジョブへの追加ステップとし、7つ目のジョブを作らない

`gh api repos/takecchi/mnemora/branches/main/protection` で確認済みのとおり
（ADR 0138 が先に確認した内容と同一)、`required_status_checks.contexts` にはこのジョブの
`name:` の文字列（`"typecheck / lint / test / build"`）がそのまま登録されている。ジョブを
分割・改名すると branch protection 側の更新が要り、それはオーナー権限の設定変更であり
この PR の範囲外である。**`Build` ステップの直後**に置く理由は、`packages/*/dist` の
`.d.ts` が既に存在することに依存するため（`pack:check` と異なり、`prepack` 経由で自己完結
的に dist を作り直す設計にはしていない——公開型の比較は「実際にビルドで生成された
成果物」を見るべきであり、独自にビルドし直すと `Build` ステップの成果物と食い違う可能性が
生じる)。

## 検討して採らなかった案

1. **`api-extractor`/`attw`/`tsd` 等の専用ツールを導入する。** 却下——新規依存の追加は
   オーナー専権（`docs/autonomy.md` §3）であり、この設計は新規依存ゼロで成立することを
   実測で確認した（上記「決定」4番・5番)。将来「semver 的な安全/危険の自動分類」や
   「npm 公開後の実際の resolution 条件（`exports` の `node`/`import`/`require` 条件分岐
   等）の検査」が要る場面が来たら、そのときにオーナーへ諮って再検討する——この歯は
   「変わったか」だけを検出する土台であり、それらの高度な判定は範囲外。
2. **`src/index.ts` を直接 checker にかける（ビルド前のソースを比較する）。** 却下——
   **実測**: `src/*.ts` を直接 `ts.createProgram` 等にかけて cross-file の型参照を辿ると、
   型注釈が `typeof import("/home/worker/mgr-79ddbc2a/design-342/packages/core/src/...")` の
   ような**絶対パスの塊**になる（TypeScript の言語サービスは、宣言ファイルを生成しない
   ときの cross-module 型参照を、コンパイル対象のファイルパスで埋め込む）。これは実行
   環境（チェックアウト先のディレクトリ）に依存し、CI ランナーと開発者の手元で同じ
   snapshot にならない——portable でない。**tsc の宣言出力（`.d.ts`）は同じ参照を相対
   import（`import("./foo.js").Foo` 等）で portable に解決している**——自前でこれを
   再実装するのは tsc の劣化再実装になる。⟹ ビルド後の `.d.ts` を見る設計にした
   （上記「決定」8番の「`Build` の成果物を見る」という選択とも整合する)。
3. **`dist/` 配下を無差別に diff する。** 却下——上記「決定」2番のとおり、6パッケージ中
   2つ（`postgres` の `mapping.d.ts`/`bin/*.d.ts` の計3ファイル、`testkit` の
   `__fixtures__/id.d.ts` の1ファイル）で内部専用ファイルが混入することを実測した。
   BFS による到達可能性の絞り込みを採用した決め手である。

## 引き受けた負債

1. **「変わった」ことは分かるが「壊れているか」は判定しない。** semver 的に安全な変更
   （例: 新しい任意プロパティの追加、union へのメンバー追加で既存呼び出し側が壊れない形）
   も、危険な変更（必須メソッドの追加）も、この歯は同じ「赤」として扱う。判定は人間・ADR
   に委ねる——これは意図的な設計であり、Issue #342 が指摘した実害（「破壊性の**申告**が
   漏れる」）に対する直接の対処である。「安全かどうかの自動判定」は検討して採らなかった
   案1番のとおり、範囲外とした。
2. **union のメンバー並び替えなど、意味的に無変化でも構文順序が変われば赤くなる。**
   TypeScript の printer は入力の構文順序をそのまま保持して出力するため、たとえば
   `"a" | "b"` を `"b" | "a"` に書き換えるだけの無害な変更でも diff に現れる。偽陽性
   （false positive）を許容している——「変わったら必ず人に見せる」を「意味的に無変化な
   ものは自動で除外する」より優先した。
3. **`bin` エントリ（`@mnemora/postgres` の `mnemora-postgres-migrate`）は対象外。**
   `exports.*.types` だけを起点にするため、`package.json` の `bin` フィールドが指す
   CLI（`packages/postgres/dist/bin/migrate.js`）のインターフェース変更はこの歯の範囲に
   入らない。CLI の引数・フラグ・標準出力の形が変わっても検出しない——**CLI の破壊的
   変更は別の話として扱う**という設計判断であり、CLI 向けの歯が要るなら別の Issue/ADR で
   立てる。
4. **型として書かれていない破壊（実行時の意味変更）は一切拾わない。** 例えば
   `reinforce()` が返す `Promise` の解決タイミングや、例外を投げる条件が変わっても、
   関数シグネチャ（引数・戻り値の型）が同じなら、この歯は差分を検出しない。この種の
   破壊はテスト（適合テスト等）が担う領域であり、この歯の設計上の非目標である。
5. **標本1件（v0.1.9→main、18コミット）でしか設計を検証していない。** 過去の版
   （v0.1.0〜v0.1.9）で同じ問題が起きていないかは未調査——Issue #342 自身が明記した
   「確かめていないこと」と同じ範囲の制約を、この歯もそのまま引き継ぐ。
6. **`#137`（`LocalEmbeddingPipeline` を必須 interface にするかどうか、オーナー判断)が
   OPEN のままである。** `LocalEmbeddingPipeline`（`packages/local-embedding/src/
   pipeline.ts`）は現状すでにこの歯の snapshot 対象に入っている型であり、`#137` が
   破壊的な案を採れば、この歯はその変更を差分として拾うだけである——**判断の中身は
   この歯もこの ADR も縛らない。** ただし正直に書くと、**この歯が今 snapshot を固定する
   ことは、`#137` が結論を出す前の現状の型を、事実上「今のところの基準線」として
   追認しているように見えなくもない。** 実際にはそうではない（snapshot は「変わったら
   気づく」ための基準点であり、「このまま変えてはいけない」という凍結宣言ではない——
   `#137` が破壊的な結論を出せば、担当者は通常の手順（差分を確認し ADR に破壊性を
   明記して `--write`）で更新すればよい）が、**この歯の存在が `#137` の議論に対して
   心理的な現状維持バイアスを足す可能性は否定しない。**

## これが覆るとしたら

- **snapshot の diff だけでは判断が難しい変更が頻発し、semver 的な自動分類が要ると
  分かったとき。** そのときは検討して採らなかった案1番（`api-extractor` 等の専用ツール）
  を、オーナーへ諮った上で再検討する。
- **`bin` エントリ（CLI）の破壊的変更が実際に無告知で着地する事故が起きたとき。**
  そのときは CLI 向けの歯を別途立てる——この ADR の対象を広げるのではなく、別 Issue/ADR
  にする（上記「引き受けた負債」3番)。
- **偽陽性（union のメンバー並び替え等）の頻度が高く、担当者が「どうせ赤くなる」と
  diff を読み飛ばす習慣ができてしまったとき。** そのときは意味的な差分検出（構造の
  比較であって構文順序に依存しない比較）への切り替えを検討する——これは実質的に
  「検討して採らなかった案1番」寄りの設計へ寄る判断になる。
- **`#137` が `LocalEmbeddingPipeline` について破壊的な結論を出したとき。** 通常の
  手順（`--write` して根拠 ADR に破壊性を明記）で snapshot を更新すればよく、この歯の
  設計自体を見直す必要はない——念のため明記する。

## 測ったこと

- **【実測】snapshot の生成**: `rm -rf packages/*/dist && pnpm run build && node
  scripts/check-public-api-surface.mjs --write` を実行し、6ファイル・合計5361行の
  snapshot を生成した（内訳は上記「決定」7番)。再度 `node
  scripts/check-public-api-surface.mjs`（`--write` 無し）を実行し、`差分なし`/`✔ 公開 API
  表面の門を通りました。`で exit 0 になることを確認した。
- **【実測】到達可能性の絞り込みが効いていること**: 生成した snapshot に対し
  `grep -c "mapping.d.ts" scripts/__snapshots__/public-api/postgres.d.ts` /
  `grep -c "bin/" scripts/__snapshots__/public-api/postgres.d.ts` /
  `grep -c "__fixtures__/id" scripts/__snapshots__/public-api/testkit.d.ts` がいずれも
  `0` であること、一方で `grep -c "migrations-dir"
  scripts/__snapshots__/public-api/postgres.d.ts` が `2`（import 文とその再 export)で
  あることを確認した——`.cjs → .d.cts` の解決が効いている一方、内部専用ファイルは
  混入していない。
- **【実測】コメント剥がしの削減率**: `packages/postgres/dist/migrate.d.ts` を
  `ts.createPrinter({ removeComments: true })` で正規化すると 13408 文字・328行から
  2090 文字・55行になった（約84%削減、上記「決定」4番)。
- **⭐【実測】変異試験1（ADR 0161 型の破壊的変更を模す）**: `packages/core/src/
  runtime.ts` の `Runtime` interface に、既存の `getRecall` の直後へ必須メソッド
  `mutationTestProbe(): void;` を追加し、`pnpm --filter @mnemora/core run build`
  → `node scripts/check-public-api-surface.mjs` を実行すると、`[@mnemora/core]` の
  違反として次の diff が出て **exit 1** になった:
  ```
  @@ -2580,6 +2580,7 @@
       tick(ctx: Ctx, opts: TickOptions): Promise<TickResult>;
       recall(ctx: Ctx, query: RecallQuery): Promise<RecallResult>;
       getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null>;
  +    mutationTestProbe(): void;
       reextract(ctx: Ctx, observationId: ObservationId): Promise<ReextractResult>;
  ```
  `git checkout -- packages/core/src/runtime.ts` で変異を戻し（`git status --short` で
  他に未コミットの変更が無いことを確認したうえで実行——`docs/autonomy.md` §4 が警告する
  「`git checkout` で未コミットの編集も一緒に消える」事故を避けるための確認)、
  `pnpm --filter @mnemora/core run build` → `node scripts/check-public-api-surface.mjs`
  を再実行すると **exit 0**（`✔ 公開 API 表面の門を通りました。`)に戻った。
- **⭐【実測】変異試験2（ADR 0165 型の破壊的変更を模す・`?` を必須へ変える形）**:
  `packages/testkit/src/tenant-settings-store-conformance.ts` の
  `TenantSettingsStoreConformanceOptions.setDefaultHalfLifeHours?:` から `?` を外し、
  `pnpm --filter @mnemora/testkit run build` → `node
  scripts/check-public-api-surface.mjs` を実行すると、`[@mnemora/testkit]` の違反として
  次の diff が出て **exit 1** になった:
  ```
  @@ -396,7 +396,7 @@
   export interface TenantSettingsStoreConformanceOptions {
       name: string;
       createStore: () => TenantSettingsStore | Promise<TenantSettingsStore>;
  -    setDefaultHalfLifeHours?: (ctx: Ctx, hours: number) => Promise<void> | void;
  +    setDefaultHalfLifeHours: (ctx: Ctx, hours: number) => Promise<void> | void;
       supportsDecayClock: boolean;
  ```
  同じ手順（`git status --short` で確認 → `git checkout --`）で変異を戻し、再ビルド・
  再実行すると exit 0 に戻った。
- **【実測】手元の6つの門**: `pnpm run typecheck` / `pnpm run lint` /
  `pnpm run format:check` / `npx vitest run`（root、DB 段抜き）/ `pnpm run build` /
  `pnpm run pack:check` に加え、新設の `pnpm run api:check` がいずれも緑。
  `npx vitest run` は `Test Files 58 passed (58)` / `Tests 1060 passed (1060)`
  （このPRが足した3本のテストファイル・35個のテストを含む)。
- **【実測】新設の歯自身の単体テスト**: `scripts/__tests__/public-api-surface-lib.test.mjs`
  （純関数——BFS の絞り込み・`.cjs`/`.mjs` の拡張子解決・コメント剥がし——を合成
  フィクスチャで検査)と `scripts/__tests__/check-public-api-surface.test.mjs`
  （CLI 全体を `MNEMORA_API_CHECK_PACKAGES_ROOT`/`MNEMORA_API_CHECK_SNAPSHOT_DIR` の
  env var 差し替えでエンドツーエンドに検査。`scripts/check-cjs-transpile-parse.mjs` の
  `CJS_PARSE_CHECK_PACKAGES_ROOT` と同じ形)を新設し、どちらも実物の `packages/*/dist`
  には依存しない——CI の `build` ジョブで `pnpm run test`（root vitest)が走る「Test」段は
  「Build」段より前にあり、実物の dist はまだ存在しない可能性があるため
  （`check-cjs-transpile-parse.test.mjs` の docstring が既に説明する制約と同じ)。
- **【実測】`ci.yml` の配線**: `scripts/__tests__/ci-yml-api-check-wiring.test.mjs`
  （既存の `ci-yml-*-wiring.test.mjs` 群と同じ、YAML パーサを使わない文字列ベースの手法）
  で、`build` ジョブに `pnpm run api:check` を打つ段が実在し、`Build` ステップの直後・
  `check:cjs-parse`/`pack:check` より前にあり、`--write` を渡していないことを固定した。

### 【実測】この歯は、マージされる前に実際に1度噛んだ（基準線の由来）

**この PR を `origin/main`（`67fd5b7`）へ取り込み直した時点で、`api:check` が
`@mnemora/core` の差分を検出して落ちた。** 初版の snapshot を録った `9e13ac8` から
`67fd5b7` までの間に、公開型が実際に動いていたためである。

**基準線を `main` に合わせる前に、検出された変化の出所を1件ずつ辿った**
（Issue #342 が言っている欠陥は「破壊的変更が根拠 ADR に書かれないまま着地すること」
であり、**確かめずに snapshot を上書きすると、歯を入れる前に歯が見つけたものを消す**）:

| 検出された変化 | 入った PR | 根拠 ADR | ADR に破壊性の記載 |
|---|---|---|---|
| `FilteredOmission.scopeRelation`（**必須**フィールドの追加） | [#376](https://github.com/takecchi/mnemora/pull/376)（`c4a3dc7`） | [0174](./0174-filtered-omission-scope-relation.md) | **在る**——「破壊的変更である（`@mnemora/core` の公開型に必須フィールドを追加した）」と逐語で書かれている |
| `ScopeRelation` / `ScopeRelationSchema` の新規 export | 同上 | 同上 | 同上（追加 export 自体は破壊的ではない） |
| `FILTERED_CONDITION_SCOPE_RELATION` の新規 export | 同上 | 同上 | 同上（追加 export 自体は破壊的ではない） |
| `OverLimitOmission.stage`（**必須**フィールドの追加） | [#391](https://github.com/takecchi/mnemora/pull/391)（`2097a72`） | [0188](./0188-association-over-limit-omission.md) | **在る**——「🔴 破壊的変更。`OverLimitOmission` に必須フィールド `stage` を足したので」 |

⟹ **4件とも申告済みだった。未申告の破壊的変更は見つからなかった**（⟹ 新しい issue は立てていない）。
**そのうえで基準線を `67fd5b7` 時点の `main` に置いた。**

⚠ **これは「この歯が入っていれば #342 の2件を捕まえられた」ことの傍証であって、証明ではない。**
今回捕まえた4件は**どれも申告済み**であり、**未申告のものを捕まえた実績はまだ無い。**

⚠ **`satisfies` の追加（[#382](https://github.com/takecchi/mnemora/pull/382) / ADR 0181）は
snapshot に現れなかった**——`satisfies` は式の型を変えないため宣言出力が動かない。
**⟹ この歯が「型として書かれていない変化を拾わない」ことの実例が1つ増えた**
（「引き受けた負債」の該当項目）。

## 確かめていないこと

- **実際の GitHub Actions 上での変異試験。** 上記「測ったこと」の変異試験2本は、
  いずれもこの作業環境（手元）でのみ行った。ADR 0138 が行ったような「変異をコミットして
  実際に PR へ push し、`gh api .../check-runs` で赤くなることを確認する」実測はまだ
  行っていない——この PR を出した後、CI が実際に緑になることは確認するが、**意図的に
  壊れたコミットを push して CI 上で赤を確認する追加の実測は行っていない**（手元の
  変異試験で歯自体が機能することは確認済みのため、実 CI 上での再現は「同じ `node`
  コマンドが同じ GitHub Actions ランナー上でも動く」という比較的低リスクな外挿である
  と判断した)。
- **過去の版（v0.1.0〜v0.1.9）に同じ破壊的変更の見落としが無かったか。** Issue #342
  自身が明記した「確かめていないこと」と同じであり、この PR の範囲でも追加調査は
  行っていない。
- **`Runtime`/`MemoryStore`/`TenantSettingsStore` を実際に自前実装している外部利用者が
  存在するかどうか。** Issue #342 と同じく未確認——npm 公開パッケージなので存在しうる、
  という前提で設計している。
- **snapshot の内容そのもの（5361行）を、1行ずつ人手でレビューしたわけではない。**
  「BFS の絞り込みが効いていること」「`.cjs`/`.mjs` の解決が効いていること」は grep で
  確認したが、コメント剥がし後のシグネチャがすべて意図どおりかは、この PR のレビューの
  範囲で確認されることを前提にしている。
