# 移行ガイド（v0.1.9 → v0.2.0 → v1.0.0）

**この文書は、利用者が版を上げるときに何をどう直すかだけを扱う。**⭐ **2世代を持つ:**

| 世代 | 破壊的変更 | どこ |
|---|---|---|
| **v0.1.9 → v0.2.0**（出荷済み） | **7件** | 「🔴 破壊的変更（v0.1.9 → v0.2.0）」の **1〜7** |
| **v0.2.0 → v1.0.0**（未リリース） | **3件** | 「🔴 破壊的変更（v0.2.0 → v1.0.0）」の **8〜10** |

⚠ **番号は通しである**（1〜10）。⛔ **「破壊的変更が10件ある」と読まないこと**——
**どちらの版へ上げるかで、読む範囲が変わる。**
各変更の設計判断・検討した代替案・引き受けた負債は、リンク先の ADR を見ること
——ここでは複製しない（`AGENTS.md` の反重複規律）。ユーザー向けの新機能・バグ修正の
一覧は [CHANGELOG.md](../CHANGELOG.md) を見ること。

---

## ⚠ この文書は当初「v0.1.9 → v1.0.0」として書かれた

**そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**
**実際に出たのは 2026-09-16 の `v0.2.0` であり、下に挙げる🔴6+1件・🟡3件は
すべて `v0.2.0` に入って出荷された**（tag `v0.2.0` が指すのは `c52be47`。
【実測】`gh release list --limit 10` の最新が `v0.2.0`、
`npm view @mnemora/<pkg> dist-tags` が6パッケージとも `latest: 0.2.0`）。
⟹ **表題と本文の版を `v0.2.0` に直した。手順の中身は1件も変えていない。**

⛔ **`v1.0.0` はまだ切られていない。**経緯は [docs/roadmap.md](./roadmap.md) §7.12 に在る。

⭐ **この文書はかつて「`v0.2.0` → `v1.0.0` の移行手順は、この文書には無い」と宣言していた。
2026-09-17、その宣言を撤回した**（[Issue #432](https://github.com/takecchi/mnemora/issues/432)）。

🔴 **撤回した理由は、宣言のほうが現物から遅れていたからである。**【実測】撤回の時点で、
**この文書は既に `v0.2.0` → `v1.0.0` の記述を2箇所持っていた**——「DB マイグレーション」の
「`v0.2.0` 以降に追加されたマイグレーション（`0016`/`0017`）」と、破壊的変更の **8**。
**どちらも `v0.2.0` より後に入ったものである。**

⟹ ⛔ **中身を宣言に合わせて削ると、現に在る有用な記述を捨てることになる。**
**宣言を現実に合わせるほうを採った。**そして**欠けていた 9・10 を足した**——
`CHANGELOG.md` と `v1.0.0` の Release 本文がどちらもこの文書を移行の送り先として
名指ししており、**リンクを踏んだ先に3件のうち1件しか無い**状態だったためである。

**ファイル名が `migration-v1.md` のままである理由**: この名前は
[`docs/roadmap.md`](./roadmap.md)・[ADR 0165](./decisions/0165-decay-activity-clock.md)・
[ADR 0169](./decisions/0169-changelog-hand-curated.md) から参照されており、
**それらは当時の記録なので書き換えない**（`AGENTS.md`）。⟹ **名前は据え置き、中身だけを実態に合わせた。**

---

## まず: 影響を受けない人

**ほとんどの利用者は何もしなくてよい。** `createRuntime()`（`@mnemora/postgres` /
`@mnemora/openai` などの実装を渡して組み立てる）で作った `Runtime` を、
`observe()`/`recall()`/`reflect()`/`consolidate()`/`forget()` の5つの動詞だけで
使っているなら、v0.2.0 でも v1.0.0 でもコードの変更は要らない。

下の🔴10件はすべて「**独自の adapter・独自の `Runtime` 実装・独自のテスト基盤コードを
書いている場合**」にだけ影響する。あなたが該当するかどうかは、次の表で判定できる
（⚠ **`8`〜`10` が `v0.2.0` → `v1.0.0` の分である**）:

| していること | 影響 |
|---|---|
| `@mnemora/postgres` の `PostgresMemoryStore`/`PostgresVectorStore`/… をそのまま使っている | **影響なし** |
| `@mnemora/testkit` の in-memory 実装をテストでそのまま使っている | **影響なし**（ただし `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls` を直接呼んでいる場合だけ 🔴 8 を見ること） |
| `createRuntime()` が返す `Runtime` をそのまま使っている（自分で `Runtime` interface を実装していない） | **影響なし** |
| `MemoryStore`/`VectorStore`/`TenantSettingsStore` を自分で実装している（自作 adapter） | 🔴 1・2・3・6 を見ること |
| `Runtime` interface を自分で実装している（`createRuntime()` を使わず、独自に組み立てている） | 🔴 5 を見ること |
| `MemoryStore.createRecall`/`aggregateScope` の戻り値を直接読んでいる、または `FilteredOmission.condition` を網羅的に分岐している | 🔴 2・3・4 を見ること |
| `TICK_SUPPORTED_JOB_KINDS` の値を網羅的に分岐している | 🟡「`TICK_SUPPORTED_JOB_KINDS`」を見ること |
| v0.1.9 で `MemoryStore.createMemory` を直接呼び、`validFrom`/`validUntil` に non-null を書いていた | 🟡「`validAt` ゲート」を見ること |
| `RecallFootprintEstimate` オブジェクトを自分で組み立てている（`estimateRecallFootprint()` の戻り値をそのまま使うだけではない） | 🔴 7 を見ること |
| **`FilteredOmission` を自分で組み立てている**（自作 adapter の `aggregateScope` 実装・テストダブル） | 🔴 **9** を見ること（`v1.0.0`） |
| **`Omission` の `over_limit` を自分で組み立てている** | 🔴 **10** を見ること（`v1.0.0`） |

---

## DB マイグレーション

**postgres を使っているなら、まずこれを実行する。**

`@mnemora/postgres` が提供する `mnemora-postgres-migrate`
（[`packages/postgres/README.md`](../packages/postgres/README.md) に詳細）は、
`migrations/*.sql` を**ファイル名の昇順ですべて自動適用する**——特定のバージョンだけを
選んで適用する形にはなっていないので、個別の呼び方は不要である。

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate
# または、このリポジトリの workspace 内なら
DATABASE_URL=... pnpm --filter @mnemora/postgres run migrate
```

v0.1.9 の時点で `0012_half_life_hours_range.sql` まで適用済みであれば、上のコマンドは
次の3本を追加で適用する（**現物のファイル名で確認済み**）:

| ファイル | 内容 | 対応する変更 |
|---|---|---|
| `0013_recall_returned_memories_jsonb.sql` | `recalls.returned_memory_ids`（uuid[]）を削除し、`recalls.returned_memories`（jsonb）へ置き換える | 🔴 2 |
| `0014_observations_valid_from_until.sql` | `observations` に `valid_from`/`valid_until` を追加する | 🔴 3・🟡「`validAt` ゲート」 |
| `0015_decay_activity_clock.sql` | `tenant_activity` テーブルを新設し、`memories` に `decay_base_seq`/`decay_floor_seq`/`half_life_recalls` を追加する | 新機能「`decay_clock`」 |

**`0013` は破壊的マイグレーションである**（列の削除を含む）。適用前に `recalls` テーブルの
バックアップを取ることを推奨する。マイグレーション自体は列の移行（`returned_memory_ids`
→ `returned_memories` への変換、`breakdownCaptured: false` で移行元行を明示）を
自動で行う——手作業でのデータ移行は不要。

新規インストールの場合は、初回データ投入後に `--analyze-memories` を実行すること
（v0.1.9 から変わっていない手順、[packages/postgres/README.md](../packages/postgres/README.md) 参照）。

**この移行ガイドの作業者はこの環境で上記マイグレーションを実際に Postgres へ適用していない**
（`DATABASE_URL` が無い作業環境のため）——SQL の内容はファイルを読んで確認したが、
実行結果の検算は CI／実運用の DB に委ねている。

### v0.2.0 以降に追加されたマイグレーション（`0016`/`0017`）

v0.2.0 の時点で `0015_decay_activity_clock.sql` まで適用済みであれば、上のコマンドは
次の2本を追加で適用する（**現物のファイル名で確認済み**）:

| ファイル | 内容 | 対応する変更 |
|---|---|---|
| `0016_provenance_kind_matches_provenance.sql` | `memories` に CHECK 制約 `memories_provenance_kind_matches_provenance`（`provenance_kind = provenance->>'kind'`）を `NOT VALID` で足す。既存行は走査しないが、この時点から先の INSERT/UPDATE には即座に効く | [Issue #273](https://github.com/takecchi/mnemora/issues/273) / [ADR 0182](./decisions/0182-provenance-kind-matches-provenance-check.md) |
| `0017_provenance_kind_matches_provenance_validate.sql` | `0016` の制約を既存行に対して `VALIDATE CONSTRAINT` する | 同上 |

**`0013`〜`0015` と違い、`0016`/`0017` は非破壊的である**（列の削除も型変更も無い。足すのは
CHECK 制約だけ）。**ただし `0017` は、既存の `memories` 行に
`provenance_kind`（列）と `provenance->>'kind'`（jsonb）が実際にずれている行があれば、
そこで失敗する。** 失敗した場合は `0016` の保護（新規の不一致行の拒否）は適用済みのまま残る
——**その場で失敗したデータを直そうとせず、原因（何がその行を作ったか）を先に特定すること**
（[`0017_provenance_kind_matches_provenance_validate.sql`](../packages/postgres/migrations/0017_provenance_kind_matches_provenance_validate.sql)
「🔴 このファイルが失敗したら」参照）。通常の書き込み経路（`@mnemora/postgres` が
提供する `PostgresMemoryStore` をそのまま使っている場合）ではこの2列は常に同じ値から書かれる
ため、通常は `0017` も無事に適用される。

**この節の作業者は、上記2本を実際に Postgres へ適用して確認した**（`/tmp` に自前で立てた
PostgreSQL 17、`0001`〜`0015` を先に適用した DB に対して実際のコード経路
（`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories`）で行を投入した後、
`0016`/`0017` を追加適用して成功することを確認した。詳細は ADR 0182「測ったこと」参照）。

---

## 🔴 破壊的変更（v0.1.9 → v0.2.0）—— **1〜7。出荷済み**

⭐ **`v0.2.0` から `v1.0.0` へ上げるだけの人は、この節を読まなくてよい。**次の節（8〜10）へ飛ぶこと。

対象はすべて `@mnemora/core` と `@mnemora/testkit`。`@mnemora/openai` / `@mnemora/anthropic` /
`@mnemora/local-embedding` に破壊的変更は無い（`src` に v0.1.9 からの差分が無いことを確認済み）。

### 1. `MemoryStore.getRecall` が必須メソッドになった

**誰が影響を受けるか**: `MemoryStore` interface を自分で実装している場合
（`@mnemora/postgres`/`@mnemora/testkit` が提供する実装をそのまま使っているなら影響なし）。

**何をすればよいか**: 次のシグネチャでメソッドを実装する。

```ts
getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null>;
```

契約（`get`/`getObservation` と同じ規律）:
- 対象の行が存在しない、または `tenant_id` が `ctx.tenantId` と一致しない場合は
  **例外を投げず** `null` を返す。
- `RecallRecord` は `recalls` 行1件ぶん全部
  （`recallId`/`tenantId`/`subjectId`/`query`/`budget`/`omitted`/`usage`/`indexBand`/
  `explain`/`returnedMemories`/`createdAt`）を返す。

根拠: [ADR 0155](./decisions/0155-recall-score-breakdown-persisted.md)。

### 2. `NewRecallRecord.returnedMemoryIds` → `returnedMemories`

**誰が影響を受けるか**: (a) `MemoryStore.createRecall` を直接呼んでいる側、
(b) `MemoryStore.createRecall`/`getRecall` を自分で実装している adapter 作者。
`Runtime.recall()`/`Runtime.observe()` を使っているだけなら影響なし
（この変更は `Runtime` の外に出ない内部の記録経路である）。

**何をすればよいか**:

```ts
// 旧（v0.1.9）
interface NewRecallRecord {
  returnedMemoryIds: MemoryId[];
  // ...
}

// 新（v0.2.0）
interface NewRecallRecord {
  returnedMemories: RecallRecordMemory[]; // { memoryId, score, retrievedVia, companionOf?, associationOf? }
  // ...
}
```

**`memoryId` の配列だけが必要な場合の最小の読み替え**:

```ts
// 旧: const ids = record.returnedMemoryIds;
const ids = record.returnedMemories.map((m) => m.memoryId);
```

`MemoryStore.createRecall`/`getRecall` を自分で実装している場合は、単なるリネームでは
済まない——`score`/`retrievedVia`/`companionOf`/`associationOf` も保存・読み戻しする
必要がある（`RecallRecordMemory` の全フィールド）。

根拠: [ADR 0155](./decisions/0155-recall-score-breakdown-persisted.md)。

### 3. `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた

**誰が影響を受けるか**: `MemoryStore.aggregateScope` を自分で実装している場合
（提供済みの実装をそのまま使っているなら影響なし）。

**何をすればよいか**: 次の2フィールドを `ScopeAggregate` の戻り値に足す。

```ts
filteredExpired: { count: number; countKind: CountKind };      // validUntil <= validAt で落ちた件数
filteredNotYetValid: { count: number; countKind: CountKind };  // validFrom > validAt で落ちた件数
```

`validAt` ゲート（下記🟡参照）を実装しない・対応しない adapter であれば、
**両方とも `{ count: 0, countKind: 'exact' }` を固定で返してよい**——`validFrom`/
`validUntil` に non-null を書く経路が無い限り、この値は常に0で正しい。

根拠: [ADR 0164](./decisions/0164-valid-from-until-recall.md)。

### 4. `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた

**誰が影響を受けるか**: `Omission`/`FilteredOmission` を消費するだけなら影響なし。
**`condition` を `switch`+`never` などで網羅的に分岐しているコードはコンパイルが壊れる。**

**何をすればよいか**: 分岐に2ケースを足す。

```ts
switch (omission.condition) {
  case "tenant": /* ... */ break;
  case "superseded": /* ... */ break;
  case "forgotten": /* ... */ break;
  case "archived": /* ... */ break;
  case "taxonomy": /* ... */ break;
  case "period": /* ... */ break;
  case "decayed": /* ... */ break;
  case "expired": /* 追加: validUntil を過ぎて落ちた */ break;
  case "not_yet_valid": /* 追加: validFrom に未到達で落ちた */ break;
  default: {
    const exhaustive: never = omission.condition;
    throw new Error(`unhandled condition: ${exhaustive}`);
  }
}
```

根拠: [ADR 0164](./decisions/0164-valid-from-until-recall.md)。

### 5. ⭐ `Runtime.getRecall` が必須メソッドになった

**⚠ 根拠 ADR（[ADR 0161](./decisions/0161-runtime-get-recall.md)）にも、この変更を
導入した commit にも、破壊的変更である旨の言及が無い。この移行ガイドが唯一の告知である。**

**誰が影響を受けるか**: `Runtime` interface を**自分で実装している**場合——
`createRuntime()`（`@mnemora/core`）で組み立てた `Runtime` をそのまま使っているだけなら
影響しない（`createRuntime()` は v0.2.0 で `getRecall` を実装済みで返す）。自分で
`Runtime` を実装するのは主に次のようなケース: テストのための mock/stub、`Runtime` を
ラップする独自の facade、`Runtime` interface に依存するが `createRuntime()` を経由しない
独自実装。

**何をすればよいか**: 次のメソッドを実装する。多くの場合、`MemoryStore.getRecall` への
単純な委譲でよい（`createRuntime()` 自身の実装がまさにこの形）。

```ts
async getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null> {
  return this.memoryStore.getRecall(ctx, recallId);
}
```

契約は `MemoryStore.getRecall`（上記1番）と同じ——見つからない・別テナントなら
`null`、例外にしない。

### 6. ⭐ `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドになった

**⚠ 根拠 ADR（[ADR 0165](./decisions/0165-decay-activity-clock.md)）は当初「この PR
全体が非破壊である」と書いていたが、それは誤りだった——ADR 本文の「🔴 訂正」節で
自己訂正されている。この移行ガイドと CHANGELOG がその訂正の反映先である。**

**誰が影響を受けるか**: `@mnemora/testkit` の `describeTenantSettingsStoreConformance(...)`
を、自作の `TenantSettingsStore` adapter のテストから呼んでいる場合。`@mnemora/postgres`/
`@mnemora/testkit` 同梱の実装をそのまま使っているだけなら影響しない。

**何をすればよいか**: 呼び出しに `supportsDecayClock: boolean` を追加する。

```ts
describeTenantSettingsStoreConformance({
  name: "my-tenant-settings-store",
  createStore: () => new MyTenantSettingsStore(),
  // v0.2.0 で必須になった:
  supportsDecayClock: false, // 自作 adapter が getDecayClock/setDecayClock/
                              // getDefaultHalfLifeRecalls/getActivitySeq を実装していないなら false
});
```

- 自作 adapter が `TenantSettingsStore` の4つの**任意**メソッド
  （`getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`/`getActivitySeq`、
  いずれも `?` 付きで非破壊に追加された）を実装していないなら、**`supportsDecayClock: false`
  を渡すだけでよい**——4メソッドはもともと任意なので、実装していないこと自体は
  v0.1.9 から変わっていない。
- 実装している場合は `supportsDecayClock: true` にし、追加のフック
  （`setDefaultHalfLifeRecalls`/`advanceActivitySeq`、いずれも任意）も検討する
  （`packages/testkit/src/tenant-settings-store-conformance.ts` の doc コメント参照）。

### 7. `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドになった

**【実測】2026-09-16、PR #336 の着地後に現物（`packages/core/src/recall-footprint.ts`）で
確かめた**: 返り値の `RecallFootprintEstimate.associationCount: number` は `:392` で**必須**、
入力の `RecallFootprintShape.associationCount?: number` は `:368` で**省略可能**、
省略時の既定は `:463` の `Math.max(0, shape.associationCount ?? 0)` である。

**誰が影響を受けるか**: **読むだけ・呼ぶだけの利用者には非破壊。**
`estimateRecallFootprint()`/`compareWithFullLog()` を呼んで戻り値を読んでいるだけなら
影響しない。**`RecallFootprintEstimate` 型のオブジェクトを自分でリテラルとして
組み立てている場合だけ**、コンパイルが壊れる。

**何をすればよいか**: 自分で構築している場合は `associationCount: number` を追加する。
入力側（`estimateRecallFootprint` への引数）は省略可能フィールドとして追加されており、
**省略すれば `0` として扱われる**（非破壊）。

---

## 🔴 破壊的変更（v0.2.0 → v1.0.0）—— **8〜10。未リリース**

⛔ **`v1.0.0` の tag はまだ切られていない。**⟹ **この節は「切られたときにこうなる」ものである。**

**3件ある。壊れ方が2種類ある:**

- **9・10 は「返り値の型に必須フィールドが増えた」形**（どちらも `@mnemora/core`）。
  ⟹ **読むだけ・消費するだけなら影響しない。**自分で組み立てている側だけがコンパイルで落ちる。
- 🔴 **8 は「公開クラスのメソッドの署名が変わった」形**（`@mnemora/testkit`）。
  ⟹ **呼んでいれば壊れる。**同期から `Promise` へ変わったので、**引数を直すだけでは足りない。**

⚠ **`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` / `@mnemora/postgres` に
破壊的変更は無い。**一覧と根拠 ADR は [CHANGELOG.md](../CHANGELOG.md) の `[1.0.0]` を見ること。

### 8. ⭐ `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）のシグネチャが変わった

**【現物】2026-09-17、ADR 0197（Issue #338 の第1弾）で変わった**:

```diff
-setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void
+setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void>
```

**なぜ変わったか**: `TenantSettingsStore` に本番の口 `setDefaultHalfLifeRecalls?(ctx, recalls)`
が足された（ADR 0197）。`InMemoryTenantSettingsStore` は `TenantSettingsStore` を
`implements` しているため、**同名で引数の形が違う旧テスト専用フックと共存できない。**
⟹ 旧フックを削除し、本番の口だけを残した。**回避できる形は無い**——名前の衝突そのものが
原因であり、旧フックを別名へ寄せる案も「旧名の削除」である点は変わらない。

**誰が影響を受けるか**: **`InMemoryTenantSettingsStore` を `TenantSettingsStore` として
構築して渡しているだけなら影響しない。** `setDefaultHalfLifeRecalls` を
**旧シグネチャで直接呼んでいる場合だけ**、コンパイルが壊れる。

**何をすればよいか**:

```diff
-store.setDefaultHalfLifeRecalls(tenantId, 3000);
+await store.setDefaultHalfLifeRecalls({ tenantId }, 3000);
```

第1引数が `Ctx` になり、**戻り値が `Promise` になったので `await` が要る。**
値域は `(0, ∞)`（有限の正の実数。`isHalfLifeRecallsInRange`）で、外れた値は
`HALF_LIFE_RECALLS_INVALID_MESSAGE` を含む `Error` で**拒まれる**——旧フックは
検証していなかったので、**0・負・`NaN`・`Infinity` を渡していたテストは落ちるようになる。**

⚠ **この変更は `@mnemora/core` と `@mnemora/postgres` には及ばない**（どちらも非破壊。
interface 側は `?` 付きの追加、`PostgresTenantSettingsStore` はメソッドの追加のみ）。
パッケージごとの内訳は ADR 0197「破壊的変更か否か」の表にある。

---

### 9. `FilteredOmission` に必須フィールド `scopeRelation` が増えた（`@mnemora/core`）

**誰が影響を受けるか**: `FilteredOmission` を**自分で組み立てている**場合だけ
——自作 adapter の `aggregateScope` 実装や、`omitted` を作るテストダブルなど。
⭕ **`recall()` の戻り値を読むだけなら影響しない。**

**何をすればよいか**: `scopeRelation` を足す。⭐ **値を自分で決めないこと**——
`condition` から引く公開定数が `@mnemora/core` に在る。

```diff
+import { FILTERED_CONDITION_SCOPE_RELATION } from "@mnemora/core";

 omitted.push({
   kind: "filtered",
   condition,
+  scopeRelation: FILTERED_CONDITION_SCOPE_RELATION[condition],
   count,
   countKind,
 });
```

⚠ **式を手で書き写さないこと。**`FilteredOmission.scopeRelation` の doc コメントが逐語で
「**`FILTERED_CONDITION_SCOPE_RELATION` である——ここでは決めない・重複させない
（式を2箇所に書くと必ずずれる、ADR 0038 が実測した穴）**」と書いている。

**何を意味する欄か**: `decayed` **だけ**が `totalInScope` の**内側**を数える
（`"within_scope"`）という非対称を、契約として名乗るための欄である。他の condition は
すべて `"outside_scope"`。⟹ **この非対称は以前から在ったが、型としては見えていなかった。**

根拠: [Issue #352](https://github.com/takecchi/mnemora/issues/352) /
[ADR 0174](./decisions/0174-filtered-omission-scope-relation.md)。

---

### 10. `Omission` の `over_limit` に必須フィールド `stage` が増えた（`@mnemora/core`）

**誰が影響を受けるか**: `OverLimitOmission` を**自分で組み立てている**場合だけ。
⭕ **`omission.count` を読むだけなら影響しない。**

**何をすればよいか**: `stage` を足す。値は2つで、**どちらで切ったかで決まる**:

```diff
 omitted.push({
   kind: "over_limit",
+  stage: "rescore",       // 段2 の limit で打ち切った分
   count,
   countKind,
 });
```

| 値 | いつ |
|---|---|
| `"rescore"` | **段2 の `RecallQuery.limit` で打ち切った**分（従来から在った唯一の経路） |
| `"association"` | **連想枠（段3.5）の `RecallAssociationQuery.maxCount` で切り捨てた**分 |

⭐ **従来の `over_limit` はすべて `"rescore"` に相当する。**⟹ **既存のコードは
`stage: "rescore"` を足せば意味が変わらない。**

**なぜ増えたか**: 連想枠の切り捨てを段1 の打ち切りと**区別して名乗る**ため。
⚠ **区別が要る理由は、次の一手が違うからである**——`"rescore"` は `limit` を上げれば減るが、
`"association"` は `limit` では直らない（切り捨ての件数を決めているのは `maxCount` だけである）。

根拠: [Issue #375](https://github.com/takecchi/mnemora/issues/375) /
[ADR 0188](./decisions/0188-association-over-limit-omission.md)。

---

## 🟡 後方互換だが挙動が変わりうるもの（v0.1.9 → v0.2.0）

### `RecallQuery.validAt` ゲートが既定で有効になった

**影響を受ける条件を明示する**: 次の**両方**に該当する場合だけ、recall の結果が
黙って変わる可能性がある。

1. v0.1.9 の時点で `MemoryStore.createMemory` を**直接**呼び出し、
   `validFrom`/`validUntil` に non-null の値を書いていた。
2. その `Memory` を `recall()` で取得している。

**該当しない場合は何も変わらない**——`Runtime.observe()` 経由では v0.1.9 の時点で
`validFrom`/`validUntil` に値を書く経路が存在しなかった（v0.2.0 で初めて
`ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput` に追加された）ため、
通常の利用者（`Runtime.observe()` だけで記憶を作っている場合）は影響を受けない。

**該当する場合、何をすればよいか**: 従来どおり `validFrom`/`validUntil` を無視して
recall したいなら、`RecallQuery.includeOutsideValidity: true` を渡す。

根拠: [ADR 0164](./decisions/0164-valid-from-until-recall.md)。

### `TICK_SUPPORTED_JOB_KINDS` が2値から4値になった

`["extract", "embed"]` → `["extract", "embed", "consolidate", "reflect"]`。

**影響を受ける条件**: この定数、または `OutboxJob.kind`/`TickResult` 関連の型を
`switch`+`never` などで網羅的に分岐しているコード。

**何をすればよいか**: `"consolidate"`/`"reflect"` のケースを追加する。**それ以外の
コード（値を消費するだけ）には影響しない**——既定では `tick()` がこれらの kind を
自動で積むことは無い（`RuntimeConfig.autoQueueConsolidateReflectOnExtract` が既定
`false` の opt-in、詳細は [CHANGELOG.md](../CHANGELOG.md) を参照）。

根拠: [ADR 0157](./decisions/0157-tick-drives-consolidate-and-reflect.md)。

### `PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された

**影響を受ける条件**: 通常は無し。距離が完全に一致する候補が複数あるとき、以前は
順序が未定義だったが、v0.2.0 では `memory_id` の順に決定的になる。**この変更で
recall の結果が意味的に変わることは無い**——同点だった候補の並び順が固定されるだけ。

根拠: [ADR 0167](./decisions/0167-association-getvectors-order-nondeterminism.md)。

---

## 🟡 v0.2.0 → v1.0.0 で、挙動が変わるが手順は要らないもの

⭐ **`v0.2.0` → `v1.0.0` には、`🟡` に相当する変更が3件ある**（`ann_unreached` の発火条件・
`sweepArchive` が従う時計・語彙チャンネルの tie-break）**が、いずれも利用者側の手順を要さない。**
⟹ **この文書には節を置かない。**中身と根拠 ADR は [CHANGELOG.md](../CHANGELOG.md) の
`[1.0.0]` の `### 変更（挙動）` / `### 変更（性能）` を見ること——**ここには複製しない。**

⚠ **DB マイグレーションは別である**——`0016`/`0017` の適用が要る。上の「DB マイグレーション」節を見ること。

---

## この文書が確かめていないこと

- **DB マイグレーション（`0013`/`0014`/`0015`）を実際に Postgres へ適用した結果**
  ——この作業環境には `DATABASE_URL` が無く、SQL ファイルの内容を読んだ確認に留まる。
- **ここに挙げた「誰が影響を受けるか」の判定が、実際の外部 adapter 実装者にとって
  過不足ないか**——この repo の中からは検証できない。
