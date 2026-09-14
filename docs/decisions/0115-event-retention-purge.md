# ADR 0115: `MemoryStore.purgeExpiredEvents`（任意メソッド）— 設定できても効いていなかった保持期間の削除側を埋める

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

---

## 文脈

`docs/roadmap.md` §5.4 でオーナーが「必須」と明示した口——**監査ログの既定保持期間は
無期限。テナント単位で短縮できる口は必須**——は、[ADR 0050](./0050-tenant-event-retention.md)
が `TenantSettingsStore.getEventRetention`/`setEventRetention` を足したことで
「設定できる」までは満たされた。**しかし ADR 0050 自身が、削除処理（期限切れ行を
実際に消すジョブ）を明示的に範囲外へ残していた**（決定8）:

> 削除処理（期限切れの `memory_events` 行を実際に消す処理）は入れない。
> `docs/memory-model.md` §9「保持方針」が既に置き場所を決めている……
> 本 ADR・本 PR は「保持期間を決められる」口だけを作る。「消す」ジョブ本体は
> 別の PR の範囲であり、本 ADR はそれを先取りしない。

Issue #210 が現物で確認した通り、この「別の PR」はこれまで着地していなかった:

- `event_retention_days` を条件に `memory_events` を削除するコードは、リポジトリの
  どこにも存在しなかった。
- `kind='events_purged'` を積むコードも存在しなかった（型（`MemoryEventKind`）と
  CHECK 制約には在ったが、書き手が無かった）。

⟹ **`setEventRetention(ctx, 30)` を呼んでも、31日前のイベントは消えなかった。**
「短縮できる」と称している口が、実際には短縮しない——使う人に誤った保証を与えていた。

Issue #210 は着手前の設計メモとして、次の8点の注意を残していた（本文から逐語で引く）。
本 ADR の決定1〜8はこの8点への回答である。

1. `EventStore` に `delete` を足さない（`docs/memory-model.md` §11 行11 が
   「`EventStore` interface は経由しない」と明示）。
2. 任意メソッドにする（`@mnemora/core` は npm 公開済み）。
3. `dryRun` を必ず持たせる。
4. `limit` は必須・既定値なし。
5. `unset` と `unlimited` を同じ顔で返さない。
6. 無限後退——`events_purged` 自体が次回の掃除対象になりうる問題を決めて ADR に書く。
7. 自動実行しない（`tick()`/`observe()` に相乗りさせない）。
8. 削除と `events_purged` の追記は同一トランザクション。

## 決定

### 決定1: `MemoryStore` に**任意**メソッド `purgeExpiredEvents?` を足す

```ts
purgeExpiredEvents?(
  ctx: Ctx,
  opts: PurgeExpiredEventsOptions,
): Promise<PurgeExpiredEventsResult>;

interface PurgeExpiredEventsOptions {
  olderThan: Date;
  limit: number; // 必須・既定値なし
  dryRun?: boolean; // 省略時 false
}

interface PurgeExpiredEventsResult {
  purged: number;
  reachedLimit: boolean;
  oldestPurgedAt: Date | null;
  newestPurgedAt: Date | null;
  dryRun: boolean;
}
```

**必須にしない**（Issue #210 設計上の注意2、[ADR 0100](./0100-supersede-with-new-memories.md)
の `supersedeWithNewMemories?` と同じ判断）。`@mnemora/core` は npm 公開済みであり、
必須メソッドを足すと第三者の `MemoryStore` adapter が壊れる——
[docs/autonomy.md](../autonomy.md) 「してはいけないこと」表の「公開 API の破壊的変更」
に当たる。

**`EventStore` interface は一切経由しない**（Issue #210 設計上の注意1、
`docs/memory-model.md` §9・§11 行11 の規律）。`PostgresMemoryStore` は
`PostgresEventStore` を呼ばず `memory_events` へ直接 SQL を発行し、
`InMemoryMemoryStore`/`FakeMemoryStore` は共有の `events` 配列を直接操作する——
`updateStatusWithEvent`/`supersedeWithNewMemories` が `append` を `EventStore`
経由にせず直接書いているのと同じ形。

### 決定2: `limit` は必須・既定値を持たない

Issue #210 設計上の注意4（`ClaimOutboxJobsOptions.leaseMs` と同じ理由、ADR 0032）。
取り消せない削除の上限を `packages/core` が黙って決めない。

### 決定3: `dryRun?` は省略可（既定 `false`）だが、真のときは1行も書かない

Issue #210 設計上の注意3。`true` のときは対象を数えるだけで、`memory_events` を
1行も DELETE せず、`events_purged` も1行も INSERT しない。`PostgresMemoryStore` は
`dryRun` のとき `db.transaction` すら開かない——削除も INSERT も実行しないので、
トランザクションで包む対象が無い。

### 決定4: `kind = 'events_purged'` 自身を対象から除外する（無限後退を避ける）

Issue #210 設計上の注意6への回答。**除外する側を採った。** 除外しないと、ある回の
掃除が積んだ `events_purged` イベントが次回の掃除対象になり、掃除対象の「件数・期間」
自体が掃除される——「消えたことが見える」という監査ログの性質そのものを壊す
（`docs/memory-model.md` §9 の「消えたことが見える」）。

**代償**: `events_purged` 行はこの口の対象にならず単調に増え続ける。ただし増分は
「呼び出し1回につき高々1行」であり、削除対象の生の件数（`purgedCount`）とは無関係に
小さい。「引き受けた負債」に記録する。

### 決定5: `reachedLimit` を専用の信号にする（`purged === limit` からの推測に頼らせない）

対象が `opts.limit` より多かった（＝この呼び出しだけでは消しきれなかった）ことを、
`purged === opts.limit` という間接的な一致からではなく、専用の boolean で返す
——`opts.limit` ちょうどの件数が対象の全件だった場合と区別できないため。
`PostgresMemoryStore`/`InMemoryMemoryStore`/`FakeMemoryStore` はいずれも
`LIMIT opts.limit + 1`（または相当）で1件多く取得し、この判定に使う。

### 決定6: `unset`/`unlimited`/`store_unsupported`/`purged` の4値を返す `purgeExpiredEventsForTenant`（`packages/core`）を足す

Issue #210 設計上の注意5への回答。`MemoryStore.purgeExpiredEvents?` 自体は
「保持期間が何日か」を知らない（`olderThan` という確定済みの `Date` しか受け取らない
——単体で決定的にテストできるようにするため）。`TenantSettingsStore.getEventRetention`
の3状態（`unset`/`unlimited`/`days`、ADR 0050）と、`purgeExpiredEvents` の有無を
1つの結果に落とす部品として `purgeExpiredEventsForTenant(ctx, deps, opts)` を
`packages/core` に置いた:

```ts
type PurgeExpiredEventsForTenantOutcome =
  | { kind: "unset" }
  | { kind: "unlimited" }
  | { kind: "store_unsupported" }
  | { kind: "executed"; result: PurgeExpiredEventsResult };
```

- `unset`/`unlimited` のときは **`memoryStore` に一切触れない**——`retention` が
  無期限の一種であることを doc で読めるようにするため、store 側の対応の有無を
  問う必要が無い。
- `store_unsupported` は [ADR 0100](./0100-supersede-with-new-memories.md) の
  `WriteAtomicity.store_unsupported` と同じ語彙上の判断——「この adapter では
  構造的に縮められない」ことを実行時エラーではなく戻り値の種類で示す。
- `cutoff`（`olderThan`）は `opts.now`（省略時 `new Date()`）から `retention.days`
  日ぶん遡った時刻として、ここで計算する。
- 🔴 **4番目の値は `"purged"` ではなく `"executed"` と名付けた。** 当初は `"purged"` と
  していたが、`packages/core/src/event.ts` の `MemoryEventKind`（`memory_events.kind` 列の型、
  ADR 0117 の棚卸し対象）にも同名の値 `"purged"` が存在し、両者は無関係の型でありながら
  `kind: "purged"` という同じ文字面のオブジェクトリテラルになっていた。並行で着地した
  [ADR 0117](./0117-unreachable-union-values-inventory.md) の回帰テスト
  （`unreachable-union-values.test.ts`）は型を見ずテキスト一致で `kind: "purged"` を探すため、
  本 PR のこのオーケストレータのコードが「`MemoryEventKind.purged` を生成した」という
  偽陽性を引いた。**文字列の衝突が原因なので、文字列を変えて解消した**——ADR 0117 側の
  テキストスキャンをこちらの都合で型認識に書き換える負担を持ち込まない側を選んだ。

**`unset` と `unlimited` を同じ顔で返さない**（Issue #210 設計上の注意5）——
ADR 0050 が `TenantSettingsStore.getEventRetention` 自体で守った区別を、
この関数の返り値でも潰さない。

### 決定7: 自動実行しない——`tick()`/`observe()` に配線しない

Issue #210 設計上の注意7。`purgeExpiredEventsForTenant` は `packages/core` の
どこからも呼ばれない。呼び出すのは運用側のスクリプト・cron・別の保守ジョブの責務であり、
`packages/core`/`packages/postgres` は「呼ぶための部品」だけを提供する。
**定期実行そのものは本 PR の範囲外のまま**（「守れないもの」参照）。

### 決定8: 削除と `events_purged` の追記は同一トランザクション

Issue #210 設計上の注意8。[ADR 0031](./0031-supersede-status-and-event-in-one-transaction.md)・
[ADR 0100](./0100-supersede-with-new-memories.md) と同じ「必ず」の強制。
`PostgresMemoryStore.purgeExpiredEvents` は `db.transaction` の中で
`SELECT`（対象選定）→ `DELETE` → `INSERT`（`events_purged`）を行う。`purged === 0`
（対象が無かった）ときは、削除も追記も一切発生しない——「何も変わらなかった」ことを
表す `events_purged` 行を積む意味が無いため（0件の掃除を毎回記録すると、頻繁な
スケジュール実行で無意味な行が積み上がる）。

### 決定9: `(tenant_id, at)` の索引を新設する（部分索引にしない）

受け入れ条件が要求する「索引が在るか確認、無ければ足し、`EXPLAIN` で使われることを
測る歯」への回答。既存の2索引（`idx_memory_events_by_memory (tenant_id, memory_id, at)`・
`idx_memory_events_by_kind (tenant_id, kind, at)`）はどちらも `memory_id`/`kind` を
等値で拘束しないと `at` の全体順序を提供できない——`purgeExpiredEvents` の対象選定
（`WHERE tenant_id = $1 AND at < $2 AND kind <> 'events_purged' ORDER BY at LIMIT $3`）
はどちらの等値絞り込みも使わないため、`migrations/0010_memory_events_retention_index.sql`
で `idx_memory_events_by_retention (tenant_id, at)` を新設した。

**`kind <> 'events_purged'` は索引に含めない（部分索引にしない）**——`idx_memories_requeue_embed`
（migration 0007）が「大半が対象外」という強い選択性を部分索引に活かした前例とは対称に、
ここでの除外対象（`events_purged`）は掃除1回につき高々1行しか増えない**少数派**であり、
部分索引にしても母数はほとんど削れない。`kind <> 'events_purged'` は Filter として
プランナに任せる。

対象選定の `SELECT` は `buildPurgeExpiredEventsTargetSelect` として本体（`memory-store.ts`）
から切り出し、`memory-events-retention-index.test.ts` の `EXPLAIN` がこの関数の返り値を
そのまま測る（`buildRequeueEmbedTargetSelect`/`explainTargetSelect` と同じ理由——
テスト側に述語を書き写すと、本体の述語を直したときにその歯だけが古い述語を測り続ける）。

## 守れないもの

- 🔴 **任意メソッドである以上、サードパーティの adapter の上では「短縮できる口」は
  恒久的に効かない。** `store_unsupported` はそれを見えるようにするだけで、直さない
  （ADR 0100 決定「守れないもの」と同型）。
- 🔴 **定期実行そのものは範囲外のまま。** `purgeExpiredEventsForTenant` を実際に
  cron やスケジューラから呼ぶ経路は、本 PR には無い。**⟹ この PR が閉じるのは
  「短縮できる口が効かない」であって、「保持期間が自動的に守られる」ではない。**
  運用側が明示的に呼ばない限り、設定した保持期間を超えて `memory_events` は伸び続ける。
- ⚠ **口の有無は原子性の証拠ではない**（ADR 0100 決定6 と同じ注意）。実装している
  と宣言していても、実際にはトランザクションを張っていない adapter をこの機構は
  見抜けない。
- ⚠ **`events_purged` 行自身は対象から除外される**（決定4）——その代償として、
  このテーブルの行数はこの列については単調に増える。

## 未決の問い

- **定期実行の器（cron・BullMQ ジョブ・examples/chat 側のスクリプト等）をどこに置くか**
  は本 ADR では決めない。`docs/roadmap.md` §1.3 が Phase 1 の範囲外とする
  Background Cognition の実運用と同じ扱いであり、実際に必要になった段階で
  別の Issue/ADR が住所を持つべきだと判断した。

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| `EventStore` に `delete`/`purgeBefore` を足す | `docs/memory-model.md` §11 行11・§9 が「`EventStore` interface は経由しない」と明示。append-only の型に触れない、という alteroid 由来の規律（§9「型に無ければ生えない」）を削除操作でも守る |
| 必須メソッドにする | `@mnemora/core` は npm 公開済み。必須化は第三者 adapter を壊す破壊的変更であり、`docs/autonomy.md` の「してはいけないこと」に当たる |
| `events_purged` 自身も掃除対象に含める（無限後退を受け入れる） | 「消えたことが見える」という監査ログの性質そのものが壊れる。何回目の掃除でどの `events_purged` が消えたかを追えなくなる |
| `limit` に既定値を持たせる | `ClaimOutboxJobsOptions.leaseMs` と同じ理由（ADR 0032）。取り消せない削除の上限を `packages/core` が黙って決めない |
| `unset`/`unlimited` を1つの「削除しない」値に潰す | ADR 0050 が既に区別した3状態を、削除側で潰すと「まだ設定していない」と「明示的に無期限を選んだ」が呼び出し側から区別できなくなる（ADR 0011/0025/0027/0028/0034/0029/0050 が繰り返し問題にしてきた族と同じ形の失敗） |
| `purgeExpiredEventsForTenant` を `runtime.tick()`/`observe()` に配線する | Issue #210 設計上の注意7「自動実行しないこと」が明示。北極星の問い2（Background Cognition を無効にしても成立するか）にも触れる論点であり、先取りしない |
| `PostgresMemoryStore.purgeExpiredEvents` が `dryRun` でも `db.transaction` を開く | 削除も INSERT も実行しないなら、トランザクションで包む対象が無い。無駄なコネクション往復を増やすだけ |
| `kind <> 'events_purged'` を部分索引の条件にする | 除外対象が少数派（`idx_memories_requeue_embed` の「大半が対象外」とは逆）であり、母数をほとんど削れない。決定9参照 |

## 引き受けた負債

- **定期実行の自動化が無い。**「守れないもの」に既述。設定した保持期間は、
  誰かが明示的に `purgeExpiredEventsForTenant`（または `MemoryStore.purgeExpiredEvents`
  自体）を呼ばない限り効かない。
- **`events_purged` 行は単調に増える。**決定4の代償。増分は掃除1回につき高々1行。
- **サードパーティ adapter では恒久的に効かない。**「守れないもの」参照。
- **`PostgresMemoryStore.purgeExpiredEvents` と `memory-events-retention-index.test.ts`
  の `EXPLAIN` の歯は、この環境では一度も実行していない。**「確かめていないこと」参照。
- **`FakeMemoryStore.purgeExpiredEvents` の当初のテストに、`reachedLimit` を実際に
  `true` にする経路と、`kind='events_purged'` 自身の除外を検査する歯が無かった。**
  本 PR の作業中に変異試験で見つけ、埋めた（「歯について」参照）。

## これが覆るとしたら

- **オーナーが「削除の定期実行も mnemora が持つべき」と判断したとき。**その場合、
  `Runtime`/`tick()` への配線、あるいは独立したスケジューラの設計が新しい ADR として要る
  ——決定7を覆す判断であり、北極星の問い2に照らして検討が要る。
- **`events_purged` 自身の増加が実害を持つ規模になったとき。**決定4の代償が無視できなく
  なったら、`events_purged` 自身にも別の保持期間（あるいは無条件の圧縮）を設ける判断が
  要るかもしれない。
- **`docs/memory-model.md` §9・§11 の記述が変わったとき**（正典側の変更、オーナーの判断）。
- **サードパーティ adapter の必須化が必要だと判断されたとき。**「守れないもの」1点目、
  ADR 0100 未決の問いと同型の分岐。

## 歯について

### 基準線（本 PR 着手前、`main` = `c3dda79` を一時的な worktree で実測）

`typecheck && lint && format:check && test && build` は `EXIT=0`。

| package | Test Files | Tests |
|---|---|---|
| root vitest | 37 | 667 |
| `packages/core` | 38 | 529 |
| `packages/testkit` | 3 | 217 |
| `packages/openai` | 6 (1 skipped) | 54 (11 skipped) |
| `packages/anthropic` | 4 (1 skipped) | 51 (2 skipped) |
| `packages/local-embedding` | 5 (2 skipped) | 89 (15 skipped) |

`DATABASE_URL` 未設定のため DB テストは実行していない（ADR 0015）。

### 本 PR 後（6つの門を手元で実行、いずれも `EXIT=0`）

- `typecheck`: 7ワークスペース全て `Done`
- `lint`: `eslint .` 出力なし（クリーン）
- `format:check`: `prettier --check` 全ファイル通過
- `test`: root 37/667（変わらず。ルート vitest はパッケージ配下を含まない）、
  `packages/core` **40 / 539**（+2 files, +10 tests）、`packages/testkit`
  **3 / 223**（+6 tests）、他パッケージは変化なし。DB テストは今回も「実行していません」
  と告知して緑（ADR 0015）
- `build`: 7ワークスペース全て `Done`（`rm -rf packages/*/dist` の後）
- `pack:check`: `✔ publish 梱包の門を通りました。`

### 変異試験（手で撃った。`.claude/skills/mutation-testing/` はこの環境に存在しないと確認済み）

各変異は、変異の前に取った退避コピー（`/tmp/mutation-210-backup/*.ts`）から
`cp` で復帰した（`git checkout <file>` は使っていない——`docs/autonomy.md` §4 が
記録する「未コミットの編集も一緒に消える」実績のある穴を踏まないため。本 PR 着手時点で
このファイル群は既にコミット済みだったが、退避コピー方式に統一した）。

#### `FakeMemoryStore.purgeExpiredEvents`（`packages/core/src/__tests__/runtime-fakes.ts`）

| # | 変異 | 走った歯 | 結果 |
|---|---|---|---|
| M1 | `kind !== "events_purged"` の除外条件を `true` に潰す | `packages/core` 全体 | **当初は生存**（539件全部緑）——`fake-memory-store-purge-expired-events.test.ts` に無限後退を検査する歯が無かった。歯を新設（後述）してから撃ち直すと**死亡**（1件赤: 「対象は普通のイベント1件だけ」assertion） |
| M2 | `dryRun` の分岐を `purged === 0` だけに潰す（`dryRun` を無視） | 同上 | **死亡**（1件赤: 「dryRun のときは1行も消さず、events_purged も積まない」） |
| M3 | 境界条件 `at < olderThan` を `at <= olderThan` に緩める | 同上 | **死亡**（1件赤: 「境界（at === olderThan）は残す」で `purged` が2になった） |
| M4 | `reachedLimit` を常に `false` に固定 | 同上 | **当初は生存**（539件全部緑）——既存の歯は `reachedLimit === false` を1箇所しか検査しておらず、`true` になるはずの経路が無かった。歯を新設（後述）してから撃ち直すと**死亡**（1件赤） |
| M5 | 呼び出し部品 `purgeExpiredEventsForTenant` の cutoff 計算で符号を反転（`now + days` にする） | `event-retention-purge.test.ts` | **死亡**（2件赤: 有限日数の2本とも `purged` の期待値が外れた） |
| M6 | 同上、`unset` の早期 return を無効化 | 同上 | **死亡**（1件赤: `unset` のとき `memoryStore` に触れないはずが `purged` を返した） |
| M7 | 同上、`store_unsupported` の早期 return を無効化 | 同上 | **死亡**（1件赤: `TypeError: purgeExpiredEvents is not a function`） |

**M1・M4 は生存した。** 変異試験そのものが2つの実在するテスト不足を見つけた
——`FakeMemoryStore.purgeExpiredEvents` は `packages/testkit` の適合テスト
（`InMemoryMemoryStore`・`PostgresMemoryStore` が対象）の範囲外であり
（`fake-memory-store-purge-expired-events.test.ts` 冒頭のコメントが明記）、
独自にテストを持つ必要があったが、当初はそのテストが「境界」「dryRun」
「テナント越境」の3本しかなく、「無限後退の除外」と「`reachedLimit` が実際に
`true` になる経路」を検査していなかった。**本 PR で次の2本を追加し、追加後は
M1・M4 とも死亡することを確認した:**

- 「limit を超えた対象を `reachedLimit: true` で知らせ、超えない呼び出しでは
  `false` になる」（5件仕込み、`limit: 3` → `limit: 10` の2段呼び出し）
- 「`kind='events_purged'` 自身を対象から除外する（無限後退を避ける）」
  （古い `events_purged` 行を直接仕込み、掃除対象に含まれないことを見る）

追加後の `packages/core` は 538 → **539 tests**（このADR「本PR後」の表と一致）。
**生存した変異は、追加後は0件。**

#### `InMemoryMemoryStore.purgeExpiredEvents`（`packages/testkit`、適合スイート経由）

| # | 変異 | 走った歯 | 結果 |
|---|---|---|---|
| T1 | `kind !== "events_purged"` の除外条件を `true` に潰す | `packages/testkit` 全体 | **死亡**（1件赤: 適合スイートの「`kind='events_purged'` 自身を対象から除外する」） |

`packages/testkit` の適合スイート（`describeMemoryStoreConformance`）は
`InMemoryMemoryStore`・`PostgresMemoryStore` の両方に対して同じ歯を走らせる設計
——`InMemoryMemoryStore` 側で1本撃って死ぬことを確認できれば、同じ歯が
`PostgresMemoryStore` に対しても構造的に同じ検査をすることが期待できる
（ただし CI の `postgres` ジョブでの実測は「確かめていないこと」参照）。

#### `PostgresMemoryStore.purgeExpiredEvents`・`memory-events-retention-index.test.ts`

**撃っていない。** この環境に PostgreSQL も Docker も `DATABASE_URL` も無い。
`InMemoryMemoryStore` と同じ適合スイートを共有しているため、同じ歯が CI の
`postgres` ジョブで走れば同様に検出されるはずである——**ただしこれは予測であり
実測ではない。**

## 確かめていないこと

- 🔴 **`packages/postgres` の歯を一度も実行していない。** ルートの `pnpm run test`
  は「DB テストは実行していません」と名指しで出力して緑のまま通る（ADR 0015）。
  新設の `memory-events-retention-index.test.ts`（`EXPLAIN` 3本）と、適合スイートの
  `PostgresMemoryStore` 版は、**CI の `postgres` ジョブが唯一の実行環境**である。
- **`buildPurgeExpiredEventsTargetSelect` が実際に `idx_memory_events_by_retention`
  を使うこと自体**（決定9の主張）は、CI 上で初めて実測される。
- **`db.transaction` が削除と `events_purged` の追記を本当にアトミックに保つこと**
  （決定8）も、CI の `postgres` ジョブで初めて実測される。
- **定期実行の器から呼ばれたときの挙動**（同時に複数のワーカーが同じテナントに対して
  呼んだときの競合など）は、そもそも定期実行の器が無いため測っていない。
- **サードパーティ adapter が実際に `purgeExpiredEvents` を実装しない場合の
  運用上の見え方**（`store_unsupported` を受け取った運用側がどう振る舞うべきか）は、
  本 ADR の範囲外であり確認していない。

## 人から受け取った前提

- `docs/roadmap.md` §5.4 のオーナー回答（2026-09-06、マネージャー経由で伝達された旨が
  同ファイルに既に記録されている）。本 ADR より前に確定していた決定であり、本 ADR は
  それを実装で満たす設計判断を記録する。
- Issue #210 本文の設計上の注意1〜8。**出所: Issue 本文（2026-09-15 の自律作業が
  中断した際に残した下調べ、と明記されている）。** 本 ADR の決定1〜8はこの注意への
  回答として現物のコードと対応させて確認した。
- ADR 番号 `0115` はマネージャーが `origin/main` の現物を確認して割り当てたもの
  （0112〜0114・0116〜0118 は他の並行作業者が使用中/予約済みとの報告を受け取った。
  **未検証——マネージャーの報告として引用する。** 本 PR を出す直前に
  `git fetch origin main && git ls-tree --name-only origin/main docs/decisions/`
  で自分でも空きを再確認する）。
