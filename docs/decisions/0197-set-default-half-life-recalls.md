# ADR 0197: `TenantSettingsStore` に `setDefaultHalfLifeRecalls` を本番の経路として足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0111 / 0188 / 0193 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `tsc`/`eslint`/`prettier`/`vitest`/`initdb` 等を
  走らせて確かめた。
- **【受】** — マネージャーから、別の器で測られたものとして受け取った実測。この書き手は
  その実測自体を再現していない（`docs/autonomy.md` §5「人から受け取った前提」）。

---

## 文脈

[ADR 0165](./0165-decay-activity-clock.md)「引き受けた負債」7 は、`'activity'` を選ぶ
採用者について逐語でこう書いていた:

> **既定が `'wall'` である限り §7.4 の「約129.6日」は1ビットも動かない**が、`'activity'` を
> 選ぶ採用者は **`half_life_recalls` を自分の recall 頻度に合わせて上げる必要がある。**
> `DEFAULT_HALF_LIFE_RECALLS = 720` が想定しているのは「1時間に1回程度の recall」であり
> （同定数の doc コメント）、**それより2桁多いテナントには既定値が合わない。**

[Issue #338](https://github.com/takecchi/mnemora/issues/338) は同じ対処を issue として立て、
**【受】** マネージャーから次の実測を受け取った（出所: Issue #338 のコメント
[#338#issuecomment-5701509764](https://github.com/takecchi/mnemora/issues/338#issuecomment-5701509764)。
この書き手自身は本物の Postgres に対してこの実測を再現していない）:

> 1日3112回の recall（ADR 0165「引き受けた負債」7 の逆算どおり）をするテナントで、
> 本物の Postgres に対して実際に `recall()` を3112回まで走らせたところ想起できたが、
> **3113回目で消える**ことを実測した。

**この対処の口が本番コードに無かった。** 【現物】確認した内容:

- `packages/core/src/interfaces/tenant-settings-store.ts` の `TenantSettingsStore` interface
  の setter は、本 ADR 以前は `setEventRetention` と `setDecayClock` の2つだけだった。
- `packages/postgres/src/tenant-settings-store.ts` にも書き込みの口が無く、`setDecayClock` の
  `INSERT` は `default_half_life_recalls` を書かず DB 側の `DEFAULT 720`
  （`packages/postgres/migrations/0015_decay_activity_clock.sql`）に任せていた。
- `setDefaultHalfLifeRecalls` という名前が在ったのは、`packages/testkit` の in-memory fixture
  （`__fixtures__/in-memory-tenant-settings-store.ts`、削除前の版で `tenantId: string` を
  取る同期メソッド）と、適合テストの任意フック（`tenant-settings-store-conformance.ts`）
  だけだった——どちらも本番の呼び出し経路ではない。

Issue #284 の規律（本番コードから呼ぶ経路が無ければ「在る」と数えない）を当てると、この
対処は「在る」と数えられない。実際、テナントの `default_half_life_recalls` を変えるには
`UPDATE tenant_settings SET default_half_life_recalls = ...` を直接叩くしかなかった。

## 決めたこと

1. **`TenantSettingsStore` に `setDefaultHalfLifeRecalls?(ctx: Ctx, recalls: number):
Promise<void>` を足す。** `getDefaultHalfLifeRecalls`（既存、ADR 0165 決めたこと13）の
   書き込み版であり、`setDecayClock` と完全に同じ形の UPSERT を Postgres 側で行う。

2. **`setDefaultHalfLifeHours`（壁時計側の対称なメソッド）は足さない。** 理由:

   - **文書が「対処」として名指ししているのは `half_life_recalls` の側だけである。**
     ADR 0165「引き受けた負債」7 も Issue #338 も、`'activity'` を選んだ採用者が
     `half_life_recalls` を上げる必要がある、としか書いていない。壁時計側の既定値の
     与え方は [Issue #305](https://github.com/takecchi/mnemora/issues/305) が
     「既定値の指針」を3案のうちの1つとして挙げたまま、オーナーが「設計の見直しそのもの」
     を指示したことで宙に浮いており（ADR 0165 の「文脈」節）、**まだ決着していない
     オーナー判断の領域**である。
   - **対称性のためだけに足すなら、それは「ついでに直す」である**（`docs/autonomy.md` §2
     「⚠ 『ついでに直す』をしない。ADR に書いていない変更を混ぜると、その PR が何を
     主張しているのか読めなくなる」）。
   - ⭐ **ADR 0165 自身が同じ判断をしている。** 「検討した代替案」7 は
     `LexicalStore` 側の壁時計/活動時計の非対称を「範囲外」として落とし、逐語でこう
     書いている:

     > `LexicalFilter` は `decayFloorAtAfter` を**そもそも持っていない**
     > （`packages/postgres/src/lexical-store.ts:29`、ADR 0153 が既に引き受けた非対称）。
     > **本 ADR はこの非対称を広げも狭めもしない。** 壁時計で解いていない非対称を、
     > 活動時計のついでに解こうとすると、**2つの判断が1つの PR で混ざる。**

     **この先例をそのまま引く**——`setDefaultHalfLifeHours` を足すことは、壁時計側で
     解いていない「既定値の与え方」の判断を、活動時計側の対処のついでに解こうとする形に
     なる。同じ理由で落とす。

3. **既定値 `DEFAULT_HALF_LIFE_RECALLS = 720` は1バイトも変えない。** これは
   `docs/roadmap.md` §5 相当のオーナー判断（Issue #338 案3、ADR 0165「これが覆るとしたら」4
   「『決めたこと』10 の3条件が揃ったとき。⟹ 既定の変更をオーナーへ提起する。**こちらで
   既定を動かさない。**」）であり、本 ADR の範囲外。

4. **カウンタ（`activity_seq`/`half_life_recalls`）を `subject` 単位にする変種はやらない。**
   ADR 0165「これが覆るとしたら」1 が逐語で「これはオーナーの判断を要する種類の分岐である」
   （`docs/autonomy.md` §3.1 の「どちらを選んでも技術的には成立するが、選び方が製品の性格を
   決める」に当たる、とも書いている）と決めており、本 ADR もその判断に従う。

5. **interface のメソッドは省略可能（`?` 付き）にする。** ADR 0165 決めたこと13 が
   `getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`/`getActivitySeq` の4メソッドを
   `?` 付きにした理由（`@mnemora/core` は npm 公開済みであり、必須メソッドを足すと外部の
   `TenantSettingsStore` 実装が軒並みコンパイルできなくなる）が、5メソッド目にもそのまま
   当てはまる。**新しい必須フィールドは1つも増やさない**——これは下の「破壊的変更か否か」
   節で扱う ADR 0178 / Issue #342 の教訓を踏まえた選択である。

6. **`writeDefaultHalfLifeRecalls`（`writeDecayClock` に対応するヘルパ）は足さない。**
   `writeDecayClock` が存在するのは、`examples/chat` の CLI（`--decay-clock` フラグ、
   `archive-sweep-cost.ts`/`compare.ts`）という**具体的な呼び出し元**が「省略時は明示的に
   `Error` で失敗する」という契約を必要としたからである。【現物】確認した限り、
   `setDefaultHalfLifeRecalls` には本 PR の範囲内で対応する呼び出し元（CLI フラグ等）が
   無い——`examples/chat` への配線はこの Issue の対象外である。**呼び出し元が無いヘルパを
   先回りして足すのは、`readDecayClock` 等が読み込み側の規律として存在する理由
   （呼び出し側にフォールバックを散らさない）とは違う話であり、対称性のためだけに足す
   コードになる**（決めたこと2と同じ判断の適用）。呼び出し元ができた時点で、
   `writeDecayClock` と同じ形で足す（下記「これが覆るとしたら」）。

7. **`packages/testkit` の in-memory fixture の名前衝突は「本番の口だけを残す」で捌く。**
   詳細は下の節。

## テストキットの名前衝突とその解決

`packages/testkit/src/__fixtures__/in-memory-tenant-settings-store.ts` には、本 ADR 以前から
**テスト専用フック** `setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void`
（`setDefaultHalfLifeHours(tenantId, hours)` と対になる、値域検査だけを行う同期メソッド）が
在った。本 ADR が `TenantSettingsStore` interface に足す本番メソッド
`setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void>` と**名前が衝突する**
——引数の形（`tenantId: string` 対 `ctx: Ctx`）も戻り値の形（同期 `void` 対
`Promise<void>`）も違うため、同じクラスに同じ名前で両立できない。

**検討した2案**:

- **A. テスト用フックを `setDefaultHalfLifeRecallsForTest` のような別名へ寄せる。**
  `packages/core/src/__tests__/runtime-fakes.ts` の `FakeTenantSettingsStore` が既に
  `setDefaultHalfLifeRecallsForTest(tenantId, value)` という名前を使っている
  （当時のコメント曰く「`TenantSettingsStore` interface に `setDefaultHalfLifeRecalls` は
  無い」——本 ADR 以前は事実だった）。この前例に揃えるなら A である。
- **B. 本番の口だけを残し、テスト専用フックを削除する。**

**B を採った。** 理由:

- **`setDecayClock` に前例がある。** `setDecayClock` は最初から本番の interface メソッドで
  あり（ADR 0165）、`InMemoryTenantSettingsStore` に別名のテスト専用フックは存在しない
  ——production メソッドがそのままテストのセットアップにも使われている。`setDecayClock`
  同様、`setDefaultHalfLifeRecalls` も本番メソッドが存在する以上、テスト専用フックは
  完全に冗長になる（値域検査は同じ `isHalfLifeRecallsInRange` を経由するので、
  振る舞いも重複する）。
- **`setDefaultHalfLifeHours` に別名フックを残さなかった理由と対になる。**
  `setDefaultHalfLifeHours` は本 ADR でも本番メソッドを足さない（決めたこと2）ため、
  そのテスト専用フックは**唯一の設定手段のまま**残る——削除する理由が無い。
  `setDefaultHalfLifeRecalls` はこれと非対称に見えるが、非対称の理由は「壁時計側だけ
  本番の口が無い」という決めたこと2の帰結であって、テストキットの都合ではない。
- 【現物】**旧フックの呼び出し元をすべて確認した**——`packages/testkit/src/__tests__/
in-memory-fixtures.conformance.test.ts` の適合テスト配線1箇所だけで、他に呼び出し元は
  無かった（`grep -rn "\.setDefaultHalfLifeRecalls\("` で確認）。配線側は本番メソッドを
  直接呼ぶ形に書き換え済みであり、A（別名への退避）を選んでも実質的に使われないコードが
  残るだけだった。

⚠ **B は `@mnemora/testkit` の公開型に対する破壊的変更である**——次節で扱う。

## 破壊的変更か否か

**⚠ この節は必須項目である**（[ADR 0178](./0178-public-api-surface-gate.md) /
[Issue #342](https://github.com/takecchi/mnemora/issues/342) が「根拠 ADR に破壊性の記載が
無いまま着地した」ことを問題にしたための必須項目——ADR 0156 は破壊的変更の実装を免除して
いるが、ADR を書くことは免除していない）。

**パッケージ単位で答えが違う:**

| パッケージ          | 破壊的変更か              | 根拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mnemora/core`     | **非破壊**                | `TenantSettingsStore` interface へのメソッド追加は `setDefaultHalfLifeRecalls?` という**省略可能**な形であり、既存の実装者は1行も直さずコンパイルが通る。`isHalfLifeRecallsInRange`/`HALF_LIFE_RECALLS_INVALID_MESSAGE`/`assertValidHalfLifeRecalls` はいずれも新規追加のみで、既存のエクスポートを1つも変更・削除していない。`pnpm run api:check` の差分（下記「測ったこと」）も追加のみである。                                                                                                                                                                                                              |
| `@mnemora/postgres` | **非破壊**                | `PostgresTenantSettingsStore` に新しいメソッドを実装として追加しただけ。既存のメソッドのシグネチャは1つも変えていない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@mnemora/testkit`  | **⚠ 破壊的変更が1件ある** | `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void` という公開メソッドを削除した（上の「名前衝突とその解決」節）。同名で `setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void>` を追加しているが、**シグネチャが違うため既存の呼び出し元は移行が要る**——`store.setDefaultHalfLifeRecalls(tenantId, recalls)` は `store.setDefaultHalfLifeRecalls({ tenantId }, recalls)`（`await` が要る）に書き換える必要がある。`TenantSettingsStoreConformanceOptions` 型自体は変更していない（フィールドの追加・削除は無い、必須フィールドも増やしていない）。 |

**`@mnemora/testkit` の破壊的変更を実装してよい根拠**: [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) がオーナーの逐語回答
「破壊的変更であっても構わず実装してください」により、公開 API の破壊的変更を ADR を書けば
実装してよいと委任している。**この節がその ADR の記載である。**

**この破壊の影響範囲**: 【現物】確認した限り、この repo 内で旧シグネチャの呼び出し元は
適合テストの配線1箇所だけであり、それは本 PR で書き換え済みである。`InMemoryTenantSettingsStore`
は「roadmap.md 段階3のプレースホルダ実装」（同ファイルの doc コメント）であり、
`examples/chat` 等の本番相当の経路では使われない（`packages/openai` のテストで
コンストラクタだけ使われているが、このメソッドは呼んでいない）。**repo 外の利用者
（`@mnemora/testkit` を npm から使っている外部の adapter 実装者）がこの旧シグネチャを
直接呼んでいた場合は影響を受ける**——これは確かめていない（下記「確かめていないこと」）。

## 引き受けた負債

🔴 **この口を足しても、対処は「一部」しか効かない。これが本 ADR でいちばん重要な負債である。**

`packages/postgres/migrations/0015_decay_activity_clock.sql` は逐語でこう書いている:

> `tenant_settings.default_half_life_recalls` は**新規作成時の初期値としてのみ**使う。

`half_life_recalls` が Memory 単位の列である理由は、`docs/memory-model.md` §7 が
`half_life_hours` について書いている理由とまったく同じである:

> **half_life をテナントごとに後から変えたくなった瞬間、`decay_floor_at` の全件再計算が
> 必要になる**——これは roadmap.md のリスク表で名指ししているリスクである。対処は、
> `half_life_hours` を**Memory 単位の列**として持つこと……`tenant_settings` に持つ既定値は
> あくまで**新規作成時の初期値**として使うだけであり、テナント設定を変更しても既存の
> Memory の `half_life_hours` を書き換えない。

⟹ **`setDefaultHalfLifeRecalls` を呼んでも、既存の記憶の `half_life_recalls` と
`decay_floor_seq` は1件も変わらない。効くのは、呼び出し後に新規作成される記憶だけである。**
すでに `'activity'` で運用しているテナントが `half_life_recalls` を引き上げても、
**それ以前に作られた記憶は、古い（低い）`half_life_recalls` のまま沈み続ける**——
Issue #338 の実測（3112回で消える）が指し示す症状は、この口を足しただけでは、
**既存の記憶に対しては直らない。**

⛔ **これを曖昧に書かない。** 既存行を直す手段（テナント全件の `half_life_recalls`/
`decay_floor_seq` を再計算するバッチ等）は**本 ADR の範囲外**である。要るなら別 Issue で
オーナーへ提起する（下の「これが覆るとしたら」参照）。

その他の負債:

- `@mnemora/testkit` の破壊的変更（上記「破壊的変更か否か」節）。
- `writeDefaultHalfLifeRecalls` ヘルパが無いため、将来 `examples/chat` 等から呼ぶ実装者は
  「省略時にどう振る舞うか」を自分で決める必要がある（`writeDecayClock` のような
  1箇所に閉じ込めたフォールバックが無い）。

## 採らなかった案

1. **`setDefaultHalfLifeHours` も同時に足す。**
   ⛔ **落とした。** 決めたこと2、および ADR 0165「検討した代替案」7 の逐語
   （「壁時計で解いていない非対称を、活動時計のついでに解こうとすると、2つの判断が
   1つの PR で混ざる」）を、そのままこの判断にも適用した。

2. **既定の `720` を変える（Issue #338 案3）。**
   ⛔ **落とした。** オーナー判断（ADR 0165「これが覆るとしたら」4「こちらで既定を
   動かさない」）。本 ADR の範囲外。

3. **既存行の `half_life_recalls`/`decay_floor_seq` を設定変更時に一括 `UPDATE` する。**
   ⛔ **落とした。** これは `docs/memory-model.md` §7 がまさに避けようとしている形
   （「half_life をテナントごとに後から変えたくなった瞬間、全件再計算が必要になる」）
   であり、`packages/postgres/migrations/0015_decay_activity_clock.sql` が3列とも
   `NULL` 許容にして「NOT NULL + マイグレーション時の全件 UPDATE は採らない」と
   明記している選択とも矛盾する。上の「引き受けた負債」でそのまま負債として書いた。

4. **カウンタを `subject` 単位にする変種。**
   ⛔ **落とした。** ADR 0165「これが覆るとしたら」1 が「オーナーの判断を要する種類の
   分岐である」と明記している。決めたこと4で踏襲。

5. **テストキットの名前衝突を、テスト用フックを別名（`ForTest`）へ退避して解く。**
   ⛔ **落とした（B を採った）。** 理由は「名前衝突とその解決」節を参照——旧フックの
   呼び出し元が適合テストの配線1箇所しか無く、退避しても使われないコードが残るだけ
   だったため、`setDecayClock` の前例（本番メソッドがテスト用途も兼ねる）に揃えた。

## これが覆るとしたら

1. **既存行にも効かせる必要が実測で出たとき。** ⟹ 再計算バッチ（低頻度・オプトイン、
   `docs/memory-model.md` §7 が想定している形）を導入する別 Issue を立てる。
2. **壁時計側の既定値の与え方（Issue #305）がオーナー判断で決まったとき。** ⟹
   `setDefaultHalfLifeHours` を、本 ADR の `setDefaultHalfLifeRecalls` と同じ形（`?` 付き、
   `setDecayClock` 型の UPSERT）で足す。
3. **`examples/chat` 等から `setDefaultHalfLifeRecalls` を呼ぶ具体的な必要が生まれたとき。**
   ⟹ `writeDefaultHalfLifeRecalls`（`writeDecayClock` と同じ「省略時は
   `HALF_LIFE_RECALLS_UNSUPPORTED_MESSAGE`（新設）で明示的に失敗する」規律）を足す。

## 測ったこと

【実測】このブランチの器で実際に走らせたコマンドと結果:

```
$ pnpm --filter @mnemora/core run build   → 成功（tsc エラー無し）
$ pnpm --filter @mnemora/postgres run build → 成功
$ pnpm --filter @mnemora/testkit run build  → 成功
$ pnpm run typecheck   → 7/7 workspace projects、examples/chat 含めすべて Done
$ pnpm run lint        → エラー無し
$ pnpm run format:check → 全ファイル Prettier 準拠
$ node scripts/check-public-api-surface.mjs → 差分3件（core: 追加のみ、postgres: 追加のみ、
    testkit: 旧 setDefaultHalfLifeRecalls(tenantId, recalls): void の削除 + 新シグネチャの
    追加）。差分を確認したうえで --write で snapshot を更新し、再度 --check で exit 0 を確認。
```

`packages/postgres` の DB 適合テストと `packages/testkit` の in-memory 適合テストの
両方で、`setDefaultHalfLifeRecalls` の検査（設定して読み戻せる／値域の外を拒む／行が無い
テナントに行ができる／`decay_clock` を壊さない）が緑であることを確認した（コマンドと
出力は PR 本文に書く）。

**変異試験**（`docs/autonomy.md` §2 必須項目、手順は `docs/autonomy.md` §「手元で
Postgres を立てる」に従い、`cp` での退避・復元・`diff` 一致を実施):

1. `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls` の UPSERT から
   `ON CONFLICT DO UPDATE ... SET` を落とす → 「設定済みのテナントにはその値を返す」系の
   歯が赤くなることを確認。
2. `assertValidHalfLifeRecalls` の呼び出しを外す → 「値域の外を拒む」歯が赤くなることを
   確認。

いずれも復元後に同じ歯が緑へ戻ることを確認した（結果の詳細は PR 本文）。

## 確かめていないこと

- **`@mnemora/testkit` の破壊的変更が、repo 外の実際の利用者に影響するかどうか。**
  npm 上の `@mnemora/testkit` を使って `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls
(tenantId, recalls)` を直接呼んでいる外部コードが存在するかは確認していない
  （確認する手段が無い——npm の依存グラフを外部から検索していない）。
- **Issue #338 の「3112回で消える／3113回目で消える」実測を、この書き手自身は再現していない。**
  マネージャーから受け取った実測として引用しただけである（出所は上の「文脈」節）。
- **既存の記憶に対する再計算バッチの要否・設計。** 本 ADR の範囲外（「これが覆るとしたら」
  1）。
- `examples/chat` へ `setDefaultHalfLifeRecalls` を配線した場合の CLI の形（フラグ名等）。
  本 ADR の範囲外。
