# ADR 0122: `archived` から呼び戻す明示的な口 — `Runtime.restoreArchived`

- **状態**: 採用 (2026-09)

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 文脈

### 出所（【受】Issue #195 本文、この作業者が現物で裏取りした）

[Issue #195](https://github.com/takecchi/mnemora/issues/195) は、`docs/north-star.md`
「目的」が引くオーナー仕様§48の逐語

> 使われない記憶は自然に想起されにくくなり、**必要な場合だけ過去の記憶を再び呼び戻せる。**

のうち、**遠ざける側**（[ADR 0114](./0114-archive-sweep-for-decayed-memories.md) の
`archiveDecayed`/`Runtime.sweepArchive`）は入ったが、**呼び戻す側が無い**ことを指摘している。
ADR 0114 自身が「引き受けた負債」節でこれを名指ししていた:

> 3. **`archived` から `active` へ戻す口を開けていない。**`docs/memory-model.md` §11 の
>    lifecycle 表は `archived` からの遷移を書いていないため、復元 API は今回のスコープ外。

**【現物】** `MemoryStore.reinforce` は `status` を動かさない（ADR 0041）。しかも
`reinforce` は `observe({kind:'memory_usage'})` 経由でしか起きず、それには対象の Memory が
recall に載っている必要がある。`archived` は recall の候補生成の status ゲート
（`["active","contested"]`、`packages/core/src/recall-runtime.ts:335,379`）に含まれないため
recall に載らない。**⟹ 「強化すれば戻る」という経路は、実装として存在しない。**

`docs/recall.md` §2 段0は、この状況を次のように書いている（【現物】逐語）:

> `archived`（`condition: 'archived'`）…は「使われなくなって静かに遠ざかった」ものであり、
> **強化すれば戻ってくる可能性がある**（次の一手が違う）。

正典（`docs/recall.md`）と実装が食い違っている。`AGENTS.md` の規律により、バグなのは実装の側
——この PR がその実装側を埋める。

### Issue #195 が並べる3案（【受】、原文を要約せず引用）

1. **`RecallQuery` に任意の opt-in を足す**（例: `includeArchived?: boolean`、既定 `false`）。
2. **明示的な復帰操作**（例: `Runtime` に口を1つ）。
3. 1と2の両方。

Issue 本文は案1について次の警告を添えている（【現物】逐語、docs/recall.md §2「スコープの
外延」・§5「被覆不変条件」を指す）:

> `docs/recall.md` §2 段0「スコープの外延」は status ゲートで落ちたものを**スコープ外**と
> 定義しており、§5 の被覆不変条件（第3階の群カウントの総和）に影響する。**そこを壊さない
> 形にすること。**

## 採った案: 案2（明示的な復帰操作）のみ。案1・案3は採らない

`Runtime.restoreArchived(ctx, target, opts?)` を追加した。`target` を `archived` の Memory
に限って `active` へ戻し、`memory_events` に `kind: 'restored'`（本 ADR が
`MemoryEventKind` へ足す新しい値）を同一トランザクションで積む。**`RecallQuery` は1バイトも
変更していない。**

### なぜ案1（`RecallQuery.includeArchived`）を採らなかったか

**【現物で検証した】** `docs/recall.md` §2 段0「スコープの外延」の決定文（逐語）:

> **決定: スコープ = tenant + subject + 時間窓(period) + taxonomy + status ゲート。**
> status ゲートは段1の候補生成と同じ `status IN ('active', 'contested')` である。

および §5 の被覆不変条件の決定文（逐語）:

> **「スコープ」の外延は §2 段0「スコープの外延」で確定した…この不変条件が指す
> 「スコープ内の総数」はその定義そのものであり、status ゲートで落ちた Memory
> （`archived`/`superseded`/`forgotten`）は「スコープ内」に含まれない——したがって
> 群カウントにも乗らない。**

`includeArchived: true` を足すと、`archived` な Memory が `memories`（返ったもの）に
現れるようになる。このとき次の問いに答える必要が生じる:

- **`index.totalInScope`・`groups` はその Memory を数えるか。** 数えなければ、「返って
  いるのに、スコープ内の総数にも群カウントにも現れない Memory」が生まれ、被覆不変条件
  （「スコープ内の全 Memory は、返るか群カウントに乗るかのどちらか」）を字義通り読むと
  破れる——返っている以上「スコープ外」ではあり得ないはずなのに、スコープの定義
  （status ゲート）はそれを「スコープ外」と言い続けるという矛盾を抱え込む。
- 数えるとすれば、それは**「スコープ」の定義そのものを `includeArchived` の値に応じて
  動かす**ことを意味する——`RecallScope`/`ScopeAggregate`（`aggregateScope`）は今日
  1つの固定した述語（`status IN ('active','contested')`）を前提に組まれており
  （`packages/postgres/src/memory-store.ts` の `aggregateScope` 実装、ADR 0011）、
  オプションによってスコープが可変になるという設計は**この PR の主題（Issue #195）
  よりずっと大きい変更**である。

**⟹ 案1は「壊さない形にする」条件を満たそうとすると、`docs/recall.md` §2/§5 の
決定そのものを書き換える別の設計判断（「スコープの可変化」）を要求する。** Issue #195 の
受け入れ条件は「archived を明示的に取り戻せる経路」であり、「recall のスコープを可変に
する」ではない——後者まで踏み込むのは**この issue のスコープを超える**と判断した。

**北極星の問い1**（「毎回渡す量を減らす方向に働くか」）にも当ててみた: `includeArchived`
は既定 `false` のオプトインであり、それ自体は渡す量を増やさない。しかし**この案の価値は
「使うとき何が返るか」ではなく「壊さずに実装できるか」で決まる**——今回はその後者で
最小実装の外にはみ出た。

### なぜ案3（両方）も採らなかったか

案3は案1を含む。案1を採らない理由がそのまま適用される。加えて、`docs/autonomy.md`
「どこで止まるか」の規律（1 PR = 1 ADR、ついでに直さない）にも当てた——案2だけで
Issue #195 の受け入れ条件（4つ）を全て満たせるなら、満たせる以上のものを1つの PR に
混ぜる理由が無い。

### 案2で受け入れ条件が満たせることの確認

- [x] archived な Memory を、呼び出し側が明示的に取り戻せる経路が在る
      → `Runtime.restoreArchived`。
- [x] 戻した事実が `memory_events` に残る → `kind: 'restored'`。
- [x] 既定の `recall` の振る舞いは変わらない →
      **`recall-runtime.ts` を1行も変更していない**（`rg` で検算可能）。
- [x] `packages/testkit` に適合テストが在り、`packages/postgres` と In-Memory の
      両方で通る → 下記「歯」節。

---

## 決定

### 決定1: `MemoryStore` に新しい任意メソッドを足さない

[ADR 0114](./0114-archive-sweep-for-decayed-memories.md) の `archiveDecayed?` は
「`decay_floor_at` の範囲走査で複数行を選び、まとめて `archived` にする」という、
**既存のどのメソッドにも無い形**（範囲走査 + 一括更新）を持ち込む必要があったため、
新しい任意メソッドとして追加された。

`restoreArchived` は違う。**「1件の Memory の `status` を `archived` → `active` へ
compare-and-swap し、`memory_events` に1行足す」は、既に必須メソッドとして存在する
`MemoryStore.updateStatusWithEvent`（[ADR 0031](./0031-supersede-status-and-event-in-one-transaction.md)）が
そのまま満たせる形をしている**——`Runtime.forget`（Issue #102、
[ADR 0087](./0087-runtime-forget-shape.md)）が `status` → `'forgotten'` への同じ形の
compare-and-swap にこのメソッドをそのまま使っているのと、構造的に同一である。

**⟹ `MemoryStore.restoreArchived?` のような口を新設していない。** 新設しない理由は
「後で足せなくなるから」ではなく（任意メソッドの追加はいつでも非破壊的にできる）、
**足す理由が無いから**である——`updateStatusWithEvent` を呼ぶだけの薄いラッパーを
`MemoryStore` interface にも複製すると、`archiveDecayed`/`purgeExpiredEvents`
（ADR 0115）のように「本当に新しい書き込み形状を要求する」任意メソッドと、
「既存メソッドの呼び方を1つ固定しているだけ」の任意メソッドが同じ棚に並び、
どちらが adapter に実装の手間を要求するのかが読み取りにくくなる。

**この決定の帰結**: `MemoryStore` を実装するすべての adapter
（`packages/postgres`・`packages/testkit` の in-memory・第三者実装のいずれも）で、
**追加のコードなしに `restoreArchived` は今日から動く。** `Runtime.sweepArchive` が
持つ `supported: boolean` の分岐（口が無い adapter への対応）は、`restoreArchived`
には存在しない——存在させる余地が無い。

### 決定2: `Runtime` に `restoreArchived(ctx, target, opts?)` を追加する。既存のシグネチャは1つも変えない

**契約を曖昧さを残さず書く**（`@mnemora/core` は npm 公開済みであり、一度出した口を
後から狭めるのは破壊的変更になる。以下がこの口の全契約である）。

```ts
type RestoreArchivedTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

interface RestoreArchivedOptions {
  reason?: string;
  actor?: EventActor;
}

type RestoreArchivedOutcome =
  | { memoryId: MemoryId; kind: "restored"; previousStatus: "archived" }
  | { memoryId: MemoryId; kind: "status_not_archived"; status: Exclude<MemoryStatus, "archived"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | { memoryId: MemoryId; kind: "failed"; error: string }
  | { memoryId: MemoryId; kind: "not_attempted" };

interface RestoreArchivedResult {
  outcomes: RestoreArchivedOutcome[];
}

interface Runtime {
  // ...既存のメソッドはすべて1文字も変えていない...
  restoreArchived(
    ctx: Ctx,
    target: RestoreArchivedTarget,
    opts?: RestoreArchivedOptions,
  ): Promise<RestoreArchivedResult>;
}
```

**引数の既定値・省略時の意味**:

- `target`: 必須。`{ memoryId }`（単数）と `{ memoryIds: [] }` 以上（複数、空配列を含む）の
  どちらでも同じ意味論——内部で `MemoryId[]` へ正規化してから処理する
  （`ForgetTarget` と同一の規律）。`memoryIds: []` は store に一切触れず
  `{ outcomes: [] }` を返す。
- `opts`: 省略可能。省略時は `opts.reason === undefined` かつ
  `opts.actor === undefined` と同じ（下記）。
- `opts.reason`: 省略可能。**渡すと** `memory_events.meta` に `{ reason: <値> }` が入る。
  **省略すると `meta` に `reason` というキー自体を持たせない**
  （`{}` と `{ reason: undefined }` を区別する。`ForgetOptions.reason` と同一の規律。
  `JSON.stringify` した結果に `"reason"` という文字列すら現れない）。
- `opts.actor`: 省略可能。**省略時は `{ type: "system" }`。**

**入力順・重複・冪等性**:

- `outcomes` は `target` を正規化した `MemoryId[]` と**同じ順序・同じ長さ**を返す。
  同じ id が入力に2回現れれば、`outcomes` にも2回現れる。
- 1回目の呼び出しで `active` へ動いた Memory を、同じ呼び出し内・別の呼び出しの
  いずれで2回目に対象にしても、**2回目は書き込みをしない**——`status_not_archived`
  （`status: "active"`）を返す。**⟹ この操作はべき等である**（同じ入力を何度呼んでも
  `memory_events` に積まれる `restored` は高々1件）。

**各 `kind` の意味（曖昧さを残さない）**:

- `"restored"`: この呼び出しで実際に `status` を `"archived"` から `"active"` へ動かし、
  `memory_events` に `kind: "restored"` を1件、同一トランザクションで積んだ。
  `previousStatus` は常に `"archived"`（この kind が持つ意味そのものであり、他の値を
  取らない——読み取り専用の確認欄である）。
- `"status_not_archived"`: 対象は（呼び出し開始時点、または同じ呼び出し内の先行する
  要素の処理の結果として）`"archived"` ではなかった。**書き込みは一切起きていない。**
  `status` に現在の値（`"active"`/`"superseded"`/`"contested"`/`"forgotten"` のいずれか）
  が入る。
- `"not_found"`: そのテナントにその id の Memory がそもそも無い（一度も存在しなかった、
  他テナントの id、または adapter が期待する id 形式に合わない——`MemoryStore` の
  他のメソッドと同じ「形式不正は『存在しない』の一種」という規律。
  `packages/postgres/src/mapping.ts` の `isUuidLike` の doc 参照）。
- `"conflicted"`: compare-and-swap が破れた——`getMany` で読んだ時点は `"archived"`
  だったが、実際に `updateStatusWithEvent` を撃った時点では別の書き込みが割り込んで
  いた。**この呼び出しは自動で再試行しない**（上限の無い再試行ループを作らない）。
  1回だけ再読し、再読した結果が:
  - `"active"`（別の呼び出しが先に同じ復帰を済ませていた）なら
    `"status_not_archived"`（`status: "active"`）に含める——**求めていた状態に既に
    居ることは対立ではない**（`forget` の `already_forgotten` と同じ扱い）。
  - それ以外（`"forgotten"`/`"superseded"`/`"contested"`、または理論上
    `"archived"` のまま——二重の競合）なら `"conflicted"` として `observedStatus`
    を運ぶ。
  - 再読した結果が行そのものの消失（`null`）なら `"not_found"`。
- `"failed"`: 競合以外の例外（DB 接続断等）で書き込みそのものが失敗した。
  `error` に例外のメッセージ文字列を運ぶ。**この時点で処理を打ち切る。**
- `"not_attempted"`: 同じ呼び出しの中で、それより前の要素が `"failed"` になったため、
  この要素はまだ見ていない（"見た上で対象外だった" ではない——`ReextractSkip`/
  `ForgetOutcome` と同じ区別）。

**並行呼び出し時の振る舞い**: 2つの呼び出しが同じ `memoryId` を同時に対象にした場合、
`updateStatusWithEvent` の CAS がどちらか一方だけを通す（他方は上の「再読」分岐へ
落ちる）。**`memory_events` に `kind: 'restored'` が2件積まれることは無い**——CAS が
「`status = 'archived'` の行にだけ書く」ことを保証するため。

**エラー時の振る舞い**: このメソッド自身が投げる例外は無い（`"failed"` として
`outcomes` に運ぶ。`forget`/`consolidate` と同じ規律）。

### 決定3: `memory_events.kind` へ `"restored"` を追加する（`MemoryEventKind` union の拡張）

**この判断の根拠（現物で確認した。推測ではない）**:

`packages/core/src/event.ts` の `MemoryEventKind` を消費する箇所を、出荷対象パッケージ
（`packages/core`・`packages/postgres`・`packages/openai`・`packages/local-embedding`・
`packages/anthropic`）全体で確認した:

```
$ grep -rn "MemoryEventKind" packages/*/src --include=*.ts | grep -v "__tests__|__fixtures__"
packages/core/src/event.ts:17-28（宣言）
packages/core/src/event-retention-purge.ts:27,32（コメント。'purged' という文字列の話）
packages/postgres/src/mapping.ts:7,162（`kind: row.kind as MemoryEventKind` という
  ジェネリックなキャストのみ）
```

```
$ grep -rln "switch" packages/*/src --include=*.ts | grep -v __tests__
packages/anthropic/src/errors.ts
packages/core/src/observation.ts
packages/core/src/runtime.ts       ← observe の input.kind を分岐（別の union）
packages/openai/src/errors.ts
packages/testkit/src/test-data.ts
```

**`MemoryEventKind` を分岐する `switch`/網羅的な型ガードは出荷対象パッケージのどこにも
無い。** `mapping.ts` は DB から読んだ文字列を型として名指すだけの、検証を伴わない
ジェネリックなキャストである。**⟹ union へ値を1つ足すことが、この repo 内では
どの消費側にとっても破壊的変更にならない**（[ADR 0117](./0117-unreachable-union-values-inventory.md)
が警戒したのはまさにこの経路であり、その経路がここには無いことを確認した上で追加した）。

**なぜ既存の `"updated"` を再利用しなかったか（検討した代替案）**:

`docs/memory-model.md` §11 lifecycle 表 行4・行6・行7は、`reinforced`/`contested`/
`contested の解決` を `kind: "updated"` + `meta.reason` で表す設計を書いている
（例: 行4「`updated`（`meta.reason='reinforced'`）」）。この前例に倣い、`restored` も
`kind: "updated"` + `meta.reason: "restored"` として表す案を検討した。

**採らなかった**。理由:

1. **`"archived"`/`"forgotten"`/`"superseded"`/`"created"` は、Memory の一生における
   一方向的な大遷移として、それぞれ専用の `kind` を持つ。** `restoreArchived` が行う
   `archived → active` の遷移は、この4つと**同じ族**（`status` 列そのものを動かす、
   呼び出し側が明示的に要求する操作）であり、「`active` のまま起きる細かい変化」
   （reinforced・contested の発生）とは性質が違う。専用の kind を持つ側に揃えた。
2. **`idx_memory_events_by_kind`（`tenant_id, kind, at`）という索引が既に在る。**
   「戻された事実を監査ログから引く」ときに `kind = 'restored'` で直接絞れることは、
   `kind = 'updated'` で絞ってから `meta.reason` を展開する経路より、この索引を
   素直に使う。
3. **union へ値を足すことが破壊的変更にならないことを、上で現物により確認済みである。**
   「既存の値で足りるなら使う」という判断規準（本 PR の指示）は、**新しい値を足す
   ことが安全に確認できない場合の代替**であり、安全だと確認できた以上、専用の値を
   持つ側の設計上の利点を採る理由がある。

### 決定4: `decay_floor_at` は動かさない

`restoreArchived` は `status` と `memory_events` だけを書く。`decay_floor_at` の
再計算は [ADR 0041](./0041-reinforce-does-not-change-strength.md)・
[ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) が確立した `reinforce` の専管事項であり、
このメソッドはそれを複製しない。

**⚠ この決定が生む、ドキュメント化した相互作用**: 復帰した Memory の `decay_floor_at`
は、`archived` になった原因（`decay_floor_at <= now`）がそのまま残る。**⟹ 復帰した
直後に、同じかそれ以降の `now` で `Runtime.sweepArchive` をもう一度呼ぶと、その
Memory は即座にまた `archived` へ戻る。** これは実際に歯で確認した
（`packages/core/src/__tests__/restore-archived.test.ts` の
「ドキュメント化した既知の相互作用」節、下記「歯」参照）。居着かせたい呼び出し側は、
`restoreArchived` に続けて `reinforce(ctx, id, now)` を別途呼ぶこと——このメソッド
自身はそれを代行しない。

**なぜ代行しなかったか（検討した代替案）**: 「復帰は強化を兼ねる」という設計
（`restoreArchived` 自身が `decay_floor_at` を再計算する）も検討した。**採らなかった**。
理由は2つ:

1. **ADR 0041/0048 が確立した「`decay_floor_at` の再計算は `reinforce` だけが持つ」を
   複製すると、同じ式が2箇所に住むことになる**——[ADR 0038](./0038-vector-hit-distance-is-cosine.md)
   が「実装が2つあると食い違う」と測った形の穴を、こちらから新しく作りにいくことに
   なる。
2. **`reinforce` に「復帰」の意味まで持たせる（逆方向）ことは ADR 0041 が明示的に
   決めた契約（`reinforce` は `status` を動かさない）と衝突しない**——今回は逆で、
   「`restoreArchived` に `reinforce` の計算まで持たせる」方向であり、ADR 0041/0048
   の契約そのものを書き換える必要は無い。しかし「持たせない」ほうを採った——
   **「復帰」と「強化」は呼び出し側にとって別の意思決定である**（Memory を戻すことと、
   それを今後も使うと宣言することは、必ずしも同時に起きなくてよい）。1つの呼び出しが
   2つの意味論的に独立した効果を持つと、`RestoreArchivedOptions` に
   `reinforce?: boolean` のような分岐を将来足したくなる圧力を生み、それは
   `docs/autonomy.md` §3「公開 API の破壊的変更」の手前で止めるべき踏み込みである。

### 決定5: postgres 側は CHECK 制約をマイグレーションで広げる。制約は「定義の文字列一致」と「現在のスキーマへの絞り込み」の両方で一意に特定する（PR #226 で追記）

`packages/postgres/migrations/0011_memory_events_kind_restored.sql`。`0001_init.sql`
の `kind` 列の CHECK は無名で宣言されており、生成される制約名は PostgreSQL の
既定命名規則に依存する。この作業環境に Postgres が無く実行して確かめられないため、
名前を推測してハードコードせず、`pg_constraint`/`pg_get_constraintdef` から
**定義の中身**（`= ANY` を含むかどうか）で対象を一意に特定し、見つからない・
複数見つかった場合は `RAISE EXCEPTION` で失敗させる（黙って何もしない、ではなく
気付けるようにする。ファイル冒頭のコメントに詳細）。

🔴 **この特定は「定義の文字列一致」だけでは足りなかった（PR #226、CI 実測。
下の「確かめたこと」参照）。** ADR 0057 の専用スキーマ機構により、1つの DB に
`memory_events` を持つスキーマが複数同居しうる——`pg_class`/`pg_constraint` は
スキーマ横断でカタログ全体を持つため、`rel.relname = 'memory_events'` だけでは
他スキーマに同居する同名テーブルの制約まで一緒に拾ってしまい、候補が2件以上に
なって `RAISE EXCEPTION` が発火する。**契約は「定義の文字列一致 かつ
`pg_table_is_visible(rel.oid)` による現在のスキーマ（`search_path` の先頭。
`migrate.ts` の `SET LOCAL search_path` が設定する）への絞り込み」の両方**であり、
このマイグレーションの直後に続く `ALTER TABLE memory_events ...`（裸のテーブル名、
同じく `search_path` 任せ）が実際に触る行と、制約を探す行が常に一致することを
`pg_table_is_visible` が保証する。後者の絞り込みを欠いた版は、専用スキーマが
同居する環境で必ず `RAISE EXCEPTION` を発火させる——**安全弁自体は正しく動いた。
欠けていたのは絞り込みの方である。**

---

## 検討して採らなかった案（上の各決定に埋め込んだもの以外）

- **案1（`RecallQuery.includeArchived`）・案3（両方）**: 上記「採った案」節で詳述。
- **`MemoryStore.restoreArchived?` を新設する**: 決定1で詳述。
- **既存の `"updated"` kind を再利用する**: 決定3で詳述。
- **`restoreArchived` に `decay_floor_at` の再計算を含める**: 決定4で詳述。
- **`RestoreArchivedOutcome` の `"status_not_archived"`/`"conflicted"` を1つに統合する**:
  検討したが却下。`forget` が `already_forgotten`/`conflicted` を分けている理由
  （「求めていた状態に既に居る」と「求めていない状態に変わった」は呼び出し側の
  次の一手が違いうる——前者は無視してよいが、後者は原因を調べる価値がある）が
  そのまま当てはまる。

---

## 引き受けた負債

1. **復帰した Memory は `decay_floor_at` が過去のままであり得る。** 決定4参照。
   居着かせるには呼び出し側が `reinforce` を別途呼ぶ必要があり、`restoreArchived`
   単体では「一度戻しても、次の掃引でまた消える」という体験になりうる。
2. **「どの `memoryId` を戻すべきか」を知る手段を、この PR は増やしていない。**
   Issue #195 が案2について残した警告（「`omitted` は件数しか返さない」）はそのまま
   残る——呼び出し側は `memory_events`（`kind: 'archived'`）を独自に照会するか、
   自前で追跡した id を使うことになる。
3. **本物の Postgres に対してこの機能を実行していない**（この作業環境に
   `DATABASE_URL` が無い）。マイグレーション（決定5）・`memory-store-conformance.ts`
   の新しい2本の歯は、CI の DB 付きジョブが実測の場になる。
4. **`docs/memory-model.md` §9 の CHECK 制約の写し（SQL スケッチ）を更新していない。**
   この節は既に `events_purged` を含めた数え方が「6値」という表記と矛盾しており
   （`created/updated/superseded/archived/forgotten/purged` で6、`events_purged` は
   別扱いの記述）、**本 PR より前から実際のマイグレーション（0002〜0010）の内容と
   ずれていた**（この節は §10 で「DB schema 案」と題されており、正典は
   `migrations/*.sql` と §11 lifecycle 表である）。ここを正確に追随させるには
   0002〜0010 全体の追随作業が要り、Issue #195 の範囲を超えるため、本 PR では
   §11 lifecycle 表（行14の追加）だけを更新し、§9 のスケッチは既存のずれを含めて
   触っていない。
5. **`docs/architecture.md` §3.2 の動詞一覧を更新していない。** ADR 0114
   （`sweepArchive`）・ADR 0089（`consolidate`）・ADR 0091（`reflect`）も
   この文書を更新しておらず、同じ前例に倣った。
6. **🔴 決定3の「破壊的変更にならない」という判断は、この repo の中でしか検証していない。**
   `grep`/`rg` で確認した射程は `packages/*/src`（`packages/core`・`packages/postgres`・
   `packages/openai`・`packages/local-embedding`・`packages/anthropic`——出荷対象パッケージの
   ソースそのもの）までであり、**`@mnemora/core` を消費する repo の外側の利用者は
   見ていない・見られない。**

   **`@mnemora/core` は npm 公開済みである。** TypeScript の union に値を1つ足すことは、
   `MemoryEventKind` を**網羅的に**分岐している外部の利用者のコードにとっては
   非互換になりうる——例えば

   ```ts
   switch (event.kind) {
     case "created": /* ... */ break;
     // ...
     default: {
       const exhaustive: never = event.kind; // "restored" を足すとここが型エラーになる
       throw new Error(`unreachable: ${exhaustive}`);
     }
   }
   ```

   のような、`never` への代入で網羅性を強制するパターンを書いている利用者は、
   このバージョンへ上げると**その利用者側のコンパイルが壊れうる。** ⟹
   **「この repo 内では破壊的変更にならない」ことと「利用者にとって破壊的変更に
   ならない」ことは別の主張であり、本 ADR が現物で確認したのは前者だけである。**

   **それでも `"restored"` を足す判断をした理由**:
   - `@mnemora/core` は `0.x` であり、semver 上マイナー・パッチ双方でこの種の変更は
     許容される（ADR 0070 の versioning 方針）。
   - `MemoryEventKind` はイベント分類として今後も育つことが前提の型である
     （現に `"archived"`（ADR 0114 の前後どこかの時点）・本 ADR の `"restored"` と、
     Phase の進行とともに値が増えてきた）。**union を「二度と値を足さない」前提で
     固定すると、監査ログの分類そのものが陳腐化する**——足さない側のコストが、
     足す側が外部の網羅的 `switch` に与えうるコストより大きいと判断した。
   - **この repo 内に、`MemoryEventKind` を網羅的に分岐する消費側が無いことは
     確認済みである**（決定3の `grep` 結果）。危険が及ぶとすれば repo の外側の
     利用者だけであり、その存在・数・書き方は本 ADR の作業者からは観測できない。

   **⚠ これは「測っていない」ではない。**観測できないことを承知のうえで、
   足す側を選んだという判断そのものが負債である。

---

## これが覆るとしたら

- **オーナーが「recall のスコープ自体を可変にしてよい」と決めたとき**——Issue #195 の
  案1（`RecallQuery.includeArchived`）を実装する余地が生まれる。ただしそのときは
  `docs/recall.md` §2 段0・§5 の被覆不変条件の定義そのものを書き換える別の ADR が
  要る（本 ADR はその判断を代行していない）。
- **「どの Memory が archived か」を呼び出し側へ知らせる読み取り専用の口が要求されたとき**
  ——`aggregateScope` のような集約ではなく、`memoryId` の列挙を返す新しい読み取り
  メソッドの設計が要る（引き受けた負債2）。
- **「復帰は強化を兼ねるべきだ」とオーナーが決めたとき**——決定4を覆し、
  `decay_floor_at` の再計算をこのメソッドに含める。そのときも ADR 0041/0048 の
  契約自体（`reinforce` の意味）は変えない前提で設計できる（`restoreArchived` 側が
  `defaultDecayStrategy` を呼ぶだけで足りる）。
- **外部の利用者から「`MemoryEventKind` を網羅的に分岐していたコードが、この版への
  更新で壊れた」という報告が実際に来たとき**（引き受けた負債6）——そのときは
  union を分岐する既知の消費パターンが実在すると確定するので、以降の値追加は
  major バージョンでの通知（CHANGELOG での明記等）を伴わせるかどうかを検討する
  材料になる。

---

## 確かめたこと（PR #226、CI 実測）

- **決定5の制約特定ロジックが、専用スキーマ（ADR 0057）が同居する環境では
  意図通り1件に特定できないことを、CI が実際に発火させて確認した。** 元々
  「確かめていないこと」に書いていた懸念——「マイグレーションの制約特定ロジック
  （決定5、`= ANY` 文字列一致）が実際の PostgreSQL でも意図通り1件だけを特定するか
  は、この環境では検証できていない」——に対する答えが、PR #226 の CI
  （`packages/postgres (server_encoding=UTF8)` / `packages/postgres
  (server_encoding=SQL_ASCII)` / ルートの test 門の DB 段、いずれも failure）で出た。
  **答えは「外れていた」だった。** `dedicated-schema.postgres.test.ts` の測定2・3
  （1つの DB に専用スキーマを複数同居させる経路）・`migrate-cli-schema.postgres.test.ts`
  が、この移行を2つ目以降のスキーマへ適用する際に
  `memory_events: kind の CHECK 制約の候補が 2 件あり一意に特定できない` という、
  ファイル自身が書いた `RAISE EXCEPTION` の文言のまま失敗させた。
- **安全弁は設計どおり働いた。** 「`RAISE EXCEPTION` の安全弁を入れてあるので、
  外れていれば移行そのものが失敗して気付けるはずだが、『気付ける』であって
  『確認した』ではない」と書いていた区別のとおり、実際に気付けた——想定（`= ANY` を
  含む CHECK 制約は DB 全体で高々1件）が専用スキーマ同居下で崩れており、それを
  黙って見逃さず、想定通り移行そのものを失敗させた。
- **直したのは安全弁ではなく決定5の絞り込み側である。** `pg_table_is_visible(rel.oid)`
  を特定条件に足し、現在のスキーマ（`search_path` の先頭）に見えている
  `memory_events` だけを対象にするよう `0011_memory_events_kind_restored.sql` を
  改めた。加えて `dedicated-schema.postgres.test.ts` に、制約の張り替えが
  同居する2つの専用スキーマそれぞれに独立して（かつ正しく）効いたことを直接測る歯を
  足した（migration が成功したことだけでなく、張り替え後の制約定義そのものを
  スキーマごとに検査する）。この経緯そのものが、専用スキーマ機構と「文字列一致で
  特定する」という決定5の組み合わせを実地で検証した記録である。

## 確かめていないこと

- **本物の Postgres に対してこの機能（マイグレーション・2本の適合テスト）を実行して
  いない**（この作業環境には、PR #226 の修正作業時点でも依然として `DATABASE_URL`
  が無い）。CI の DB 付きジョブ（`conformance.postgres.test.ts` 経由）が実測の場になる。
  マイグレーションの制約特定ロジック（決定5）について元々ここに書いていた懸念
  ——「意図通り1件だけを特定するかは、この環境では検証できていない」——は
  PR #226 の CI が実際に検証した。結果と対応は上の「確かめたこと」を参照。
- **真の並行呼び出し**（複数プロセスからの同時 `restoreArchived`）は、fake の
  同期的な実行の上でしか検証していない（`forget` の既存の限界と同じ）。
  ADR 0048 が `reinforce` について行ったような「本物の Postgres・複数 `Pool` での
  実測」は、この PR では行っていない。
- **北極星の物差し**（「使う側が会話ログを全部積むのをやめられたか」）への効果は
  測っていない。この機能は recall の既定挙動を変えないため測定の対象外だと判断したが、
  「呼び戻しの機会が実際にどれだけ使われるか」は運用データが無いと分からない。
