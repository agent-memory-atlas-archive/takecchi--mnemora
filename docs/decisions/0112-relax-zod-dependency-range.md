# ADR 0112: 公開パッケージの `zod` 依存を完全固定から `^` 範囲へ緩める

- **状態**: 採用 (2026-09)

- **文脈**:

  `packages/core` / `packages/openai` / `packages/anthropic` の `dependencies.zod` は
  `"4.5.4"`（完全固定）だった。Issue #166 が、これが**下流の TypeScript プロジェクトに
  実害を与えている**ことを実測で報告した:

  - `@mnemora/core` を使う下流ルートが zod を 4.5.4 より新しく（例: 4.6.2）上げると、
    npm/pnpm は完全固定 `4.5.4` を dedupe できず、
    `node_modules/@mnemora/core/node_modules/zod` にもう1本 4.5.4 が残る。
  - zod は自身のバージョンを型に埋め込んでいる（`_zod.version.minor` がリテラル型）ため、
    2本の zod の型は**構造的に非互換**になる。両者を跨ぐ箇所で再帰ジェネリクスの構造比較が
    組合せ爆発する。
  - 報告者の実測（Node 24.21.0、下流プロジェクト）: zod 1本のとき `tsc --noEmit` の
    Types 272,110 / Instantiations 1,070,572 / 型検査が通る最小ヒープ 1,152 MB。
    zod 2本（root 4.6.2 + `@mnemora/core` 配下 4.5.4）になると Types 4,437,246
    （**16.3倍**）/ Instantiations 24,344,832（**22.7倍**）/ 最小ヒープ 6,144 MB
    （**5.3倍**）。ヒープを8GBまで上げて完走させても `TS2589` と、
    `_zod.version.minor` のリテラル型が `5` と `6` で一致しない型エラーが出る。
    `@typescript/analyze-trace` も `Duplicate packages: zod 4.5.4 / 4.6.2` を直接報告する。
  - 対照として `ai` / `@ai-sdk/*` は `^3.25.76 || ^4.1.8` と範囲指定のため dedupe され、
    重複が起きるのは `@mnemora/core` 由来の zod 1本だけだった、と報告されている。

  **この完全固定は意図した互換性の制約ではない。** ルート `.npmrc` に
  `save-exact=true` があり、`typescript` / `vitest` / `openai` / `drizzle-orm` など
  他の依存も一様に完全固定されている。`packages/core/package.json` の zod の値は
  初回コミットから一度も変わっていない——**`save-exact=true` による機械的な pin**で
  あり、zod だけを特別扱いする根拠は見当たらない。

  Issue の報告者自身が、`pnpm-workspace.yaml` の `overrides` で zod を 4.6.2 に
  差し替えてこのリポジトリのテストを実行し、**このリポジトリ側の互換性**を検証済みである
  （未検証の前提として引用。自分では再検証していない）:

  - `packages/core` typecheck: エラーなし。vitest: 37ファイル/526テスト すべて pass
  - モノレポ全体 typecheck（7パッケージ）: すべて完了
  - モノレポ全体 test: core 526 / testkit 217 / openai 43 / local-embedding 74 /
    anthropic 49 — fail 0件
  - zod の使い方（`z.object(...) satisfies z.ZodType<T>` / `z.infer` / `.safeParse` /
    `.parse` / `ZodError.issues` / `z.toJSONSchema()`）は定型的で、zod 4.6.0 で
    変わった箇所（`toZod`、`.properties()`、`$ZodProperties`）を使っている箇所は
    core / openai / anthropic のソースに見当たらなかった、との報告。
  - **報告者自身が明示した未確認**: `packages/postgres` の `test:db`（実DB要求）と
    `examples/chat` の実LLM呼び出し経路は走らせていない。4.6.2 時点の確認であり、
    今後の 4.6.x で挙動が変わらないことまでは確かめていない。

- **検討した選択肢**:

  1. **`devDependencies` も含め、`save-exact=true` の方針自体を見直す。**
     このリポジトリ自身のビルド再現性（CI で同じ版のツールチェーンが動くこと）が
     目的であり、Issue #166 が指しているのは**別の問題**（公開した tarball の
     `dependencies` が下流の dedupe を壊すこと）である。`devDependencies` は
     tarball に入らず下流の `node_modules` にも並ばないので、完全固定のままでも
     dedupe を壊さない。方針転換の理由が無いので採らない。
  2. **`workspace` 側の `pnpm.overrides` で zod を上書きする案内をするだけで、
     `package.json` 自体は直さない。** 下流の `overrides`/`resolutions` は
     下流ごとに個別対応が要り、`@mnemora/*` を使うすべての下流に同じ回避策を
     強いる。直せる箇所（このリポジトリの `dependencies`）を直さない理由が無い。
     採らない。
  3. **`zod` を `dependencies` から `peerDependencies` に変える。** 下流が自分の
     zod を持ち込む形にすれば重複自体が起きなくなるが、これは**公開 API の
     破壊的変更**にあたる（インストール契約が変わり、既存の下流は
     `npm error ERESOLVE` 等で壊れうる）。`docs/autonomy.md` §3 が
     「公開 API の破壊的変更は提起までにする」としている以上、この PR の範囲外。
     必要なら別 issue として提起する（下の「確かめていないこと」参照）。
  4. **`dependencies.zod` だけを完全固定から `^4.5.4` に緩める（採用）。**
     Issue が実測で示した実害（型の2本化）にだけ対応する、最小の変更。
     `save-exact=true` の方針そのものは変えない——`devDependencies` は
     このリポジトリの再現性のために完全固定のままにする。

- **決定**:

  `packages/core` / `packages/openai` / `packages/anthropic` の
  `dependencies.zod` を `"4.5.4"` から `"^4.5.4"` に変更する。
  `pnpm-lock.yaml` を追随させ、解決バージョンは変えない（`4.5.4` のまま。
  範囲を緩めただけで、この PR で実際に上げるわけではない）。

  **`devDependencies` は対象外。** ルート `.npmrc` の `save-exact=true` は
  このリポジトリ自身のビルド再現性のためのものであり、Issue #166 が指す
  「公開パッケージの実行時依存が下流の dedupe を壊す」問題とは目的が違う。
  `devDependencies` は tarball に入らないので、完全固定のままでも下流に影響しない。
  **この2つを混同しないことが、この ADR の中心の判断である。**

  併せて、`scripts/publish-pack-checks.mjs` に
  `findExactPinnedDependencyViolations(manifest, exemptDependencyNames)` を追加し、
  `scripts/check-publish-pack.mjs`（`pack:check` 門の9本目）に配線した。
  publish 対象6パッケージの **`dependencies`**（`devDependencies` は対象外）が
  完全固定になっていないかを機械的に検査する——**この Issue が今後別の依存で
  再発することを防ぐ歯**であり、zod 自体の値を検査する歯ではない
  （zod の値そのものは pnpm-lock.yaml の specifier と package.json の一致を
  pnpm 自身の frozen-lockfile チェックが見る）。

- **理由**:

  問題の原因は「zod を固定していること」ではなく、「**公開した tarball の
  実行時依存が固定されていて、下流が dedupe できないこと**」である。
  `devDependencies` を緩めても実害には触れず、逆に `save-exact=true` の
  意図（このリポジトリのビルド再現性）を無関係に弱める。
  **`dependencies` だけを緩めるのが、実害の所在と対処の範囲を一致させる最小の変更。**

- **結果（この決定が招くもの）**:

  - `@mnemora/core` / `@mnemora/openai` / `@mnemora/anthropic` を使う下流は、
    自分のルートで zod を `4.5.4` より新しい版（`^4.5.4` の範囲内、例: `4.6.x`）に
    上げても dedupe され、型の2本化が起きなくなる。
  - **`4.x` の範囲内でのみ有効。** zod が将来 `5.0.0` を出したとき、下流が
    先に `5.x` へ上げれば同じ問題が形を変えて戻る（`^4.5.4` は `5.0.0` を
    許さないため、今度は dedupe されず2本化する）。これは `^` 範囲の一般的な
    性質であり、zod がメジャーを上げた時点で `@mnemora/*` 側も追随して
    範囲の上限を上げる必要がある——**追随を促す機械的な歯は無い**
    （引き受けた負債。下の「これが覆るとしたら」参照）。
  - `pack:check` 門に9本目の検査が増えた。**publish 対象6パッケージのうち
    `@mnemora/openai`（`openai`）・`@mnemora/anthropic`（`@anthropic-ai/sdk`）・
    `@mnemora/postgres`（`@types/pg` / `drizzle-orm` / `pg`）・
    `@mnemora/local-embedding`（`@huggingface/transformers`）に残る完全固定は、
    `findExactPinnedDependencyViolations` の `EXACT_PINNED_DEPENDENCY_EXEMPTIONS`
    （`scripts/publish-pack-checks.mjs`）へ明示的に除外登録した。**
    これは「問題ない」の一覧ではなく「**未確認のまま残した負債**」の一覧である
    ——`save-exact=true` 由来という点で zod と同じ経緯に見えるが、
    Issue #166 が実測で報告したのは zod のみであり、他の依存が同じ下流2本化を
    実際に起こすかは確認していない。`docs/autonomy.md` §2「ついでに直さない」に
    従い、この PR では対象を zod だけに絞った。
  - **除外リストの一箇所化。** 当初の実装案では
    `EXACT_PINNED_DEPENDENCY_EXEMPTIONS` を `scripts/check-publish-pack.mjs`
    （実行時に使う側）と `scripts/__tests__/check-publish-pack.test.mjs`
    （歯として検査する側）の2箇所に写しで持つ形になっていた。これは
    `PUBLISH_TARGETS` がかつて2箇所の写しでずれた前例（ADR 0066）と同じ形の
    危険であり、レビュー段階で `scripts/publish-pack-checks.mjs`
    （副作用を持たず、両方から安全に import できるモジュール）へ移し、
    唯一の定義にした。**2箇所目を作らなかったので、ずれを検知する歯自体が
    要らなくなった。**
  - **変異試験で確認した**（`packages/core/package.json` の `zod` を
    `"4.5.4"` に戻し、`pnpm-lock.yaml` の対応する specifier も揃えて
    `pnpm run pack:check` を実行）:
    ```
    ✗ 違反が 1 件見つかりました
      - [@mnemora/core] dependencies.zod = "4.5.4"（完全固定。範囲指定（例: "^4.5.4"）にすること）
    ```
    同じ変異で `vitest run scripts/__tests__/check-publish-pack.test.mjs` も
    2件（歯レベル1件・門レベル1件）失敗することを確認した。両ファイルを
    元に戻すと再び緑になることも確認した。

- **これが覆るとしたら**:

  - **zod が `5.0.0` を出し、`@mnemora/*` がまだ `^4.5.4` のままのとき。**
    このときは今回と同じ構造の問題が形を変えて再発する（範囲の上限に阻まれて
    dedupe されない）。対応は「範囲の上限を上げる」だけで、この ADR の判断
    （`dependencies` だけ緩める・`devDependencies` は固定のまま）自体は覆らない。
  - **`EXACT_PINNED_DEPENDENCY_EXEMPTIONS` に残した依存のいずれかが、実際に
    同じ下流2本化を起こすと確認されたとき。** そのときは当該の依存を
    除外リストから外し、`dependencies` を範囲指定に変える——この歯が
    既にあるので、追加の設計判断は要らない（除外を外すだけで検査が始まる）。
  - **`save-exact=true` の方針そのもの（`devDependencies` を含む全依存を
    完全固定する）を見直す判断が下ったとき。** それはこの ADR より上位の
    判断であり、別の ADR で扱うべきである。この ADR は
    `save-exact=true` の存在を前提とし、その適用範囲を「公開パッケージの
    実行時依存」から除外しただけである。

- **確かめていないこと**:

  - **`packages/postgres` の `test:db`（実 DB 要求）と `examples/chat` の
    実 LLM 呼び出し経路は、この変更後に走らせていない**（手元に `DATABASE_URL`
    が無い環境で作業したため）。zod のバージョン自体は変えていない
    （範囲を緩めただけ）ので実害は考えにくいが、実測はしていない。
  - **`EXACT_PINNED_DEPENDENCY_EXEMPTIONS` に残した6つの依存
    （`openai` / `@anthropic-ai/sdk` / `@types/pg` / `drizzle-orm` / `pg` /
    `@huggingface/transformers`）が、zod と同じ「自身のバージョンを型に
    埋め込む」性質を持つかは調べていない。** 調べていないからこそ除外リストへ
    退避した——「問題が無いと確認した」のではなく「この PR の対象外にした」。
  - **zod 4.6.x 以降で実際に問題が起きないことは、Issue 報告者の実測
    （未検証・伝聞として引用）に依っている。** 自分ではこのリポジトリの
    テストスイートを zod 4.6.x に差し替えて再実行していない
    （それ自体が別の変更であり、この PR の範囲——依存指定の緩和——を
    超えるため）。
