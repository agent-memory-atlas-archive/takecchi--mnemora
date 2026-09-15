# ADR 0124: `purge()`（物理削除）の入口を実装する — `forgotten` からのみ、`dryRun` 付き、`tick()`/`observe()` には配線しない

- **状態**: 採用 (2026-09)

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 文脈

### 出所（【受】Issue #198 本文、この作業者が現物で裏取りした）

[Issue #198](https://github.com/takecchi/mnemora/issues/198) は、`docs/roadmap.md` §5.3 でオーナーが明示的に決定した

> **既定の忘却は、実際に落とさず順位を下げる。物理削除は明示的な操作として分ける。**
> （2026-09-06 オーナー回答）

の「分ける」と決めた**明示的な操作のほう**が、`forget()`（[ADR 0087](./0087-runtime-forget-shape.md)）の実装後もまだ無いことを指摘している。

**【現物】** 確認した現状:

- `memories.purged_at` 列は `packages/postgres/migrations/0001_init.sql:90` に既に在る（`-- Phase 2` の注記付き）。この列に書き込むコード・読み取り条件に使うコードは、`packages/*/src` 全体に1行も無い（`rg -n "purged_at|purgedAt" packages/*/src` で確認、0件）。
- `memory_events.kind` の CHECK 制約（同ファイル `:149-150`）は初版 `0001_init.sql` の時点で既に `'purged'` を含む。**マイグレーションで追加する必要は無い**（[ADR 0122](./0122-restore-archived-memory.md) が `'restored'` のために書いた `0011_memory_events_kind_restored.sql` のような追加マイグレーションは、この PR には不要）。
- `packages/core/src/event.ts` の `MemoryEventKind` union にも `"purged"` は既に在る（`event.ts` 自身の doc コメントが「生成するコードが無い」と名指ししていた——[ADR 0117](./0117-unreachable-union-values-inventory.md) の棚卸し対象そのもの）。**union への値追加は不要。**
- `Memory`（`packages/core/src/memory.ts`）には `purgedAt` に相当するフィールドが**無い**。DB 列は在るが、core の型にも `MemoryRow`/`rowToMemory`（`packages/postgres/src/mapping.ts`）にも一度も現れない。**この PR が初めて配線する。**
- `Runtime`（`packages/core/src/runtime.ts`）に `purge` という動詞は無い（`observe/tick/recall/reextract/reembed/sweepArchive/restoreArchived/forget/consolidate/reflect` の10個）。`MemoryStore` にも `purgeMemory` 相当の口は無い。

### 仕様（`docs/memory-model.md` §9「forget() と purge() を分ける」・§11 行10、原文で確認した）

> `purge()` が実行された場合、`memories` 行自体は残す（`memory_events` からの外部キー参照整合性のため…）。ただし `content` と `digest` を固定のトゥームストーン文字列で上書きする（`digest` の NOT NULL 制約は…維持する。「NULL にする」ではなく「消えたことを示す値で上書きする」ことで、NOT NULL と物理削除の両立を図る）。

lifecycle 表 行10（逐語）:

> forgotten → purged（Phase 2） | `purge(ctx, target)` 呼び出し（法的要求） | 同期 | `content`/`digest` をトゥームストーンで上書き、`purged_at` 設定 | `purged`

`(*)` の注記: 「`purged` は `memories.status` の値ではなく、`memory_events.kind = 'purged'` と `memories.purged_at IS NOT NULL` で表される」。**⟹ `MemoryStatus` に値を足す設計ではない**（`ForgetOutcome`/`RestoreArchivedOutcome` が既に確立した「status に値を足さない」規律、[ADR 0087](./0087-runtime-forget-shape.md) 決定1と同根）。

### この issue が明示的に残した設計判断（推測で進めない）

> ⚠ 任意の status から直接 purge できるかは**設計判断**。ADR に理由を残すこと

lifecycle 表 行10は遷移元を `forgotten` 単独と書いているが、これは「仕様として既に決まっている」のか「設計側が決めてよい」のか、issue 本文が名指しで**決めて理由を書け**と要求している。本 ADR の決定1がこれに答える。

### 先例（形を揃える）

- [ADR 0087](./0087-runtime-forget-shape.md)（`forget`）: `Target`（単数/複数）・`Options`（`reason?`/`actor?`）・`Outcome`（6値の kind、「無い」の種類を潰さない）・`Result { outcomes }`・1回だけ再読して打ち切る CAS 安全弁、という形を確立した。
- [ADR 0122](./0122-restore-archived-memory.md)（`restoreArchived`）: 直近の同型の口。契約を曖昧さなく書く様式（引数の既定値・省略時の意味・各 kind の意味・並行呼び出し時の振る舞い・エラー時の振る舞い）をそのまま踏襲する。
- [ADR 0100](./0100-supersede-with-new-memories.md)・[ADR 0114](./0114-archive-sweep-for-decayed-memories.md)・[ADR 0115](./0115-event-retention-purge.md): `MemoryStore` へ**任意メソッド**を足す先例（`@mnemora/core` は npm 公開済み。必須にすると第三者 adapter を壊す）。

⚠ **[ADR 0115](./0115-event-retention-purge.md) の `purgeExpiredEvents`（`events_purged`）とこの ADR は別物である。** あちらは `memory_events` の行を消す（監査ログの保持期間）。こちらは `memories.content`/`digest` を潰す（Memory 本文の物理削除）。イベント種別も `events_purged` と `purged` で別。混同しない。

---

## 決定

### 決定1: `purge` は `status = 'forgotten'` からのみ遷移できる。任意の status からは直接 purge できない

**採った理由**:

1. **`docs/memory-model.md` §11 行10 が既に `forgotten → purged` とだけ書いている。** 正典を書き換えずに実装するなら、この1本が最小の実装である。
2. **「取り消せない操作である」という issue の受け入れ条件と、二段階であることが噛み合う。** `forget()` は可逆な論理削除であり、`purge()` は不可逆な物理削除である。`active`/`contested` から直接 `purge` を許すと、「まだ生きている記憶を、忘れさせる操作を経ずに一撃で物理削除できる」経路ができる。**呼び出し側が一度 `forget()` を経由してから `purge()` を呼ぶ、という2段の意思決定を強制することが、不可逆な操作に対する最小の安全弁になる**——`docs/north-star.md` の「間違いを正すと、古いほうが先に出てこなくなる」「使われない記憶が、静かに遠ざかる」という目指す姿にも、`forget → purge` の二段階は自然に対応する（`archived`/`superseded` は「機構の都合」であり、利用者の明示的な意思とは限らない。`forgotten` だけが「利用者が明示的に忘れさせた」という意思表示である、という [ADR 0027](./0027-split-superseded-forgotten-omission.md) の区別をそのまま踏襲する）。
3. **`contested` を経由する不整合を作らない。** `active`/`contested` から直接 purge を許すと、`contested` な Memory を対向の解決を経ずに消す経路ができ、[ADR 0087](./0087-runtime-forget-shape.md) が「引き受ける負債」に挙げた「`contested` な Memory を forget すると対向の一対一が破れる」と同じ族の穴を、より重い操作（不可逆）に対して新しく作ることになる。

**採らなかった案**: 「`active`/`archived`/`superseded`/`contested` からも直接 purge できるようにする」。却下。上記2・3の理由に加え、`docs/memory-model.md` の正典を書き換える判断（lifecycle 表行10の遷移元を広げる）はこの issue のスコープを超える——issue 本文も「forgotten からの遷移として実装されている」を受け入れ条件の先頭に置いており、広げる要求ではない。

**帰結**: `status !== 'forgotten'` な対象は `status_not_forgotten` として書き込み無しで返る（決定2）。`forgotten` にする経路は既存の `forget()` のみであり、本 ADR はそこへ新しい経路を足していない。

### 決定2: `Runtime.purge(ctx, target, opts?)` — `forget`/`restoreArchived` と同じ形

```ts
export type PurgeTarget = { memoryId: MemoryId } | { memoryIds: MemoryId[] };

export interface PurgeOptions {
  /** 監査ログ（`memory_events.meta.reason`）に残る自由文。省略時、`meta` に `reason` キー自体を持たせない。 */
  reason?: string;
  /** イベントの `actor`。省略時 `{ type: "system" }`。 */
  actor?: EventActor;
  /**
   * 🔴 **下見（issue の受け入れ条件が名指しする "dryRun 相当")。** `true` のとき、
   * 一切の書き込み（`content`/`digest`/`purged_at` の更新、`memory_events` への追記、
   * `VectorStore.delete`）を行わず、「実行していたら何が起きたか」だけを返す。
   * 省略時 `false`。
   */
  dryRun?: boolean;
}

export type PurgeOutcome =
  | { memoryId: MemoryId; kind: "purged"; previousStatus: "forgotten" }
  | { memoryId: MemoryId; kind: "would_purge"; previousStatus: "forgotten" }
  | { memoryId: MemoryId; kind: "already_purged" }
  | { memoryId: MemoryId; kind: "status_not_forgotten"; status: Exclude<MemoryStatus, "forgotten"> }
  | { memoryId: MemoryId; kind: "not_found" }
  | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
  | { memoryId: MemoryId; kind: "failed"; error: string }
  | { memoryId: MemoryId; kind: "not_attempted" };

export interface PurgeResult {
  /**
   * `MemoryStore.purgeMemory` が実装されていたか。`false` のとき `outcomes` は
   * **全要素が `not_attempted`**（`dryRun` の有無に関わらず）——`SweepArchiveResult.supported`
   * （ADR 0114）と同じ「無い」の扱い。
   */
  supported: boolean;
  outcomes: PurgeOutcome[];
}

interface Runtime {
  // ...既存のメソッドはすべて1文字も変えていない...
  purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult>;
}
```

**引数の既定値・省略時の意味（曖昧さを残さない。`@mnemora/core` は npm 公開済みであり、一度出した口を後から狭めるのは破壊的変更になる）**:

- `target`: 必須。`{ memoryId }`（単数）と `{ memoryIds: [] }` 以上（複数、空配列を含む）のどちらでも同じ意味論——内部で `MemoryId[]` へ正規化してから処理する（`ForgetTarget`/`RestoreArchivedTarget` と同一の規律）。`memoryIds: []` は store に一切触れず `{ supported: <purgeMemory の有無>, outcomes: [] }` を返す。
- `opts`: 省略可能。省略時は `opts.reason === undefined`・`opts.actor === undefined`・`opts.dryRun === false` と同じ。
- `opts.reason`: 省略可能。渡すと `memory_events.meta` に `{ reason: <値> }` が入る。省略すると `meta` に `reason` キー自体を持たせない（`ForgetOptions.reason` と同一の規律）。
- `opts.actor`: 省略可能。省略時は `{ type: "system" }`。
- `opts.dryRun`: 省略可能。既定 `false`。

**入力順・重複・冪等性**:

- `outcomes` は `target` を正規化した `MemoryId[]` と**同じ順序・同じ長さ**を返す。同じ id が入力に2回現れれば、`outcomes` にも2回現れる。
- **この操作はべき等である。** 1回目の呼び出しで `purged` へ動いた Memory を、同じ呼び出し内・別の呼び出しのいずれで2回目に対象にしても、2回目は書き込みをしない——`already_purged` を返す。`memory_events` に積まれる `purged` イベントは、同じ Memory につき高々1件。

**各 `kind` の意味（呼び出し側の次の一手）**:

- `"purged"`: この呼び出しで実際に `content`/`digest` をトゥームストーンで上書きし、`purged_at` を設定し、`memory_events` に `kind: "purged"` を1件、同一トランザクションで積んだ。対応する embedding の削除も試みた（決定5）。`previousStatus` は常に `"forgotten"`。
- `"would_purge"`: `opts.dryRun: true` のとき、対象が `status === "forgotten"` かつ未 purge（`purgedAt === null`）であり、`dryRun: false` で呼べば `"purged"` になったはずであることを示す。**書き込みは一切起きていない。**
- `"already_purged"`: 対象は既に purge 済み（`purgedAt !== null`）だった。**書き込みは一切起きていない**（`dryRun` の有無に関わらず同じ kind——「何も起きない」という結論自体は `dryRun` で変わらない）。
- `"status_not_forgotten"`: 対象の `status` が `"forgotten"` ではなかった（決定1）。`status` に現在値が入る。**書き込みは一切起きていない。**
- `"not_found"`: そのテナントにその id の Memory がそもそも無い。
- `"conflicted"`: compare-and-swap が破れ、1回だけ再読した結果も `not_found`/`already_purged`/`status_not_forgotten` のいずれにも明確に分類できなかった（下記「並行呼び出し」参照。現在の実装では到達しない防御的な分類——`forgotten` から抜け出す経路が本 PR の時点で存在しないため）。
- `"failed"`: 競合以外の例外で書き込みそのものが失敗した。**この時点で処理を打ち切る。**
- `"not_attempted"`: それより前の要素が `"failed"` になった、または `supported: false`（口が無い）ため、この要素はまだ見ていない。

**並行呼び出し時の振る舞い（🔴 この操作固有の CAS 条件——`forget`/`restoreArchived` と違う点）**:

`forget`/`restoreArchived` の CAS は `status` の値そのもの（`expectedStatus`）で競合を検出できる——遷移前後で `status` が変わるからである。**`purge` は `status` を動かさない**（`forgotten` のままである、決定1・仕様）。**⟹ `status` だけを CAS の条件にすると、同じ Memory への2回目の `purge` 呼び出しも条件を満たしてしまい、`content`/`digest` が再び上書きされ、`purged_at` が新しい時刻へ書き換わり、`memory_events` に `purged` イベントが2件目積まれる**——「2回 purge したらどうなるか」という issue の暗黙の問い（冪等性）に対して、素朴な実装は答えを誤る。

**⟹ CAS の条件は `status = 'forgotten' AND purged_at IS NULL` の両方にする。** `purged_at IS NULL` がこの操作固有のべき等性を買う。2つの `purge` 呼び出しが同時に同じ Memory を対象にした場合、`MemoryStore.purgeMemory`（決定4）のこの二条件 CAS がどちらか一方だけを通す。他方は「弾かれた」ことを検知し、**1回だけ**再読する（上限の無い再試行ループにはしない、`forget`/`restoreArchived` と同じ安全弁）:

- 再読した `purgedAt !== null`（別の呼び出しが先に purge していた）⟹ `already_purged`——求めていた状態に既に居ることは対立ではない（`forget` の `already_forgotten` と同じ扱い）。
- 再読した `status !== 'forgotten'`（理論上、`forgotten` から抜け出す経路が将来入った場合）⟹ `status_not_forgotten`。
- 再読が `null`（行が消えていた）⟹ `not_found`。
- 上のどれにも当てはまらない（`status === 'forgotten' && purgedAt === null` のまま、つまり CAS が弾いた理由を再読が説明しない）⟹ `conflicted`。**本 PR の時点で到達しないはずの防御的な分岐**——`forgotten` から抜け出す経路も、`purge` 以外に `purged_at` を書く経路も存在しないため。

**エラー時の振る舞い**: このメソッド自身が投げる例外は無い（`"failed"` として `outcomes` に運ぶ。`forget`/`restoreArchived` と同じ規律）。

### 決定3: 🔴 `tick()`/`observe()` からは絶対に呼ばれない。「歯で示す」

issue の受け入れ条件が要求する「明示的でない経路からは絶対に呼ばれないこと」を、**書いていないことの主張ではなく、測った事実として**示す:

1. **`TICK_SUPPORTED_JOB_KINDS`（`packages/core/src/runtime.ts`）に `purge` 相当の kind を足していない。** `tick()` が処理する job kind の唯一の出所（ADR 0082）であり、ここに無ければ `tick()` の `processJob` ディスパッチから構造的に呼ばれようがない。
2. **`ObserveInput` の分岐（`observe()` 内の `switch`）に `purge` を混ぜていない。** `observe()` の実装は `utterance`/`event`/`document`/`memory_usage` の4種を分岐するだけであり、`purge` はこの `switch` のどの `case` にも現れない。
3. **歯（`packages/core/src/__tests__/purge.test.ts`）が次を実測する**:
   - `tick(ctx, { leaseMs })` を、`purge` を要求するようないかなる outbox ジョブも積まずに呼んでも、`purge` 対象の Memory の `purgedAt` は `null` のままである（そもそも `purge` 用の job kind が無いので「積みようがない」ことを、outbox に何も積まれていないことで確認する）。
   - `observe(ctx, { kind: "memory_usage", ... })`（既存の4種のうち `purge` に最も近い「既存の記憶に触れる」経路）を呼んでも、対象 Memory の `purgedAt`/`content`/`digest` は変化しない。
   - **これは「呼んだら壊れる」ことを示す歯ではなく、「呼んでも何も起きない」ことを示す歯である**——変異試験（下記「変異試験」節）で、`tick()`/`observe()` の内部に `purge` 相当の呼び出しを**わざと**混ぜ込むと、この歯が実際に赤くなることまで確認した（「歯を置いた」と「歯が噛む」は別、という `docs/autonomy.md`/先行 ADR 群の規律）。

### 決定4: `MemoryStore` に**任意**メソッド `purgeMemory?` を足す

```ts
purgeMemory?(
  ctx: Ctx,
  id: MemoryId,
  tombstone: { content: string; digest: string },
  event: NewMemoryEvent,
): Promise<{ memory: Memory; event: MemoryEvent }>;
```

🔴 **必須にしない。**理由は [ADR 0100](./0100-supersede-with-new-memories.md) 決定1・[ADR 0114](./0114-archive-sweep-for-decayed-memories.md) 決定1と同じ——`MemoryStore` は npm 公開済みの `@mnemora/core` が定義する公開 interface であり、必須メソッドを足すと第三者 adapter を壊す破壊的変更になる。

**なぜ既存の `updateStatusWithEvent`（ADR 0031）を再利用しなかったか（[ADR 0122](./0122-restore-archived-memory.md) 決定1との対比）**:

ADR 0122 は `restoreArchived` について「`status` を1つ動かし、同一トランザクションで `memory_events` に1件積む」という形が既存の `updateStatusWithEvent` にそのまま収まるため、新しい任意メソッドを足さなかった。**`purge` はこの形に収まらない**——`status` を動かさない代わりに `content`/`digest`/`purged_at` という、`updateStatusWithEvent` のシグネチャには無い列を書く必要がある。これは ADR 0114/0115 が言う「既存のどのメソッドにも無い形」に該当する——**新しい書き込み形状を要求する任意メソッド**であり、ADR 0122 が避けた「既存メソッドの呼び方を1つ固定しているだけの任意メソッド」ではない。

**契約**:

- 対象の行が存在しなければ「memory not found」の `Error` を投げる（`updateStatusWithEvent` と同じ規約。`packages/postgres/src/mapping.ts` の `isUuidLike` の doc が言う「形式不正は『存在しない』の一種」も同様に適用する）。
- **CAS の条件は `status = 'forgotten' AND purged_at IS NULL` の両方**（決定2「並行呼び出し」節参照）。条件を満たさない場合（対象は存在するが、`status !== 'forgotten'` または `purged_at` が既に非 `NULL`）は `MemoryPurgeConflictError`（`interfaces/memory-store.ts` に新設。`MemoryStatusConflictError` と同じ族）を投げる。`observedStatus`/`observedPurgedAt` は投げる直前に読み直した値であり、**{@link MemoryStatusConflictError} の doc コメントと同じ注意が当てはまる**——「投げられた瞬間の値」の保証ではない。呼び出し側（`Runtime.purge`）はこの値を信用せず自分でもう一度 `get` を呼ぶ。
- 条件を満たす場合、`content`/`digest` を `tombstone.content`/`tombstone.digest` へ上書きし、`purged_at` に書き込み時刻（DB 側の `now()`。in-memory 実装は `new Date()`）を設定し、同一トランザクションで `event`（`kind: 'purged'`）を追記する。**片方だけ起きることはない**（ADR 0031 が確立した「更新とイベントは同値」をここでも適用）。
- `status`/`content_hash`/`digest_source` は変更しない。`status` は `'forgotten'` のままである——`purged` は `memories.status` の値ではなく `memories.purged_at IS NOT NULL` で表される（仕様どおり）。
- `event.digestSnapshot` は呼び出し側（`Runtime.purge`）が上書き**前**の digest を渡す（このメソッド自身は snapshot を作らない——`updateStatusWithEvent` と同じ、「呼び出し側が読んだ値を event に埋める」規律）。🔴 **purge 後、元の digest が残る唯一の場所はこの監査ログである**（`content` は事後もどこにも残らない——これが「物理削除」の実質）。

**トゥームストーンの値**: `packages/core/src/interfaces/memory-store.ts` に固定の定数として持つ——`PURGE_TOMBSTONE_CONTENT = "[purged]"`・`PURGE_TOMBSTONE_DIGEST = "[purged]"`。呼び出し側ごとに異なる文字列を発明させない（`Runtime.purge` はこの2定数をそのまま `purgeMemory` へ渡す）。**判定に文字列を使わない**——「purge されたか」は常に `purgedAt !== null` で判定し、`content`/`digest` の値そのものを比較しない。トゥームストーン文字列は人間可読性のためだけに在り、値を変えても購入している性質（判定可能性）は壊れない。

**採らなかった案**: `digestSource`（`'llm' | 'fallback'`）にも `'purged'` 相当の値を足す。却下——digest の内容がトゥームストーンに変わったことを `digestSource` にも反映したくなるが、これは union への値追加であり、[ADR 0122](./0122-restore-archived-memory.md) 決定3が慎重に検討した「外部の網羅的 switch を壊しうる」判断を、今度は理由なく（`MemoryEventKind` の場合のような「union は育つ前提の型」という積極的な理由を持たずに）繰り返すことになる。`digestSource` は purge 後は意味を失う（元々どう作られた digest だったかの記録に過ぎず、購入後に何かを保証する値ではない）と割り切り、**変更しない**——「引き受けた負債」節に記録する。

### 決定5: `VectorStore.delete` はベストエフォート。失敗しても `"purged"` の判定を変えない

`Runtime.purge` は `purgeMemory` の成功後、`deps.vectorStore.delete(ctx, deps.embeddingProvider.space, id)` を呼ぶ。

**理由**: [ADR 0003](./0003-memorystore-vs-vectorstore.md) の非対称契約（`MemoryStore` が真実の源、`VectorStore` は再構築可能な派生索引）により、`VectorStore.delete` の失敗は `MemoryStore` 側の書き込みが既に確定した後に起きるため、**この失敗を理由に `"purged"` を `"failed"` に格下げすると、`"failed"`/`"not_attempted"` が確立している「何も起きていないことの保証」（[ADR 0087](./0087-runtime-forget-shape.md) 決定5）を裏切る**——`content`/`digest` は既に不可逆に上書きされているのに `"failed"` と名乗ると、呼び出し側は「安全に再試行できる」と誤読しうる（再試行すれば `already_purged` になり、埋め込み削除の再試行にはならない）。

⟹ `vectorStore.delete` の例外は握り潰す（catch して無視する）。**`"purged"` の判定は `MemoryStore.purgeMemory` の成功だけで決まる。**

**引き受ける負債**: `vectorStore.delete` が実際に失敗した場合、埋め込み行が消えずに残る。これは recall には現れない（`PostgresVectorStore.search` は `m.status = ANY(...)` で `memories` と JOIN しており、`status IN ('active','contested')` を渡す既存の呼び出し側の下では `forgotten` な行はそもそも候補に上がらない——purge の前後で変わらない）が、法的要求（「実際に消える」）の観点では未達のまま残る可能性がある。自動リトライは持たない——`archiveDecayed`/`purgeExpiredEvents` と同じく、`packages/core` が独自のリトライポリシーを発明しない、という規律に揃える。埋め込み削除の失敗を運用側が知る手段は、本 PR の範囲では無い（下記「これが覆るとしたら」参照）。

### 決定6: `aggregateScope`/`recall-runtime.ts` は1行も変更していない

issue のヒント（「`purge` は `forgotten` からの遷移なので、`recall` の status ゲート（`active`/`contested`）には元々載らない。問題になるとすれば `aggregateScope` の群カウントのほう」）を検算した。

**【現物で検証した】** `docs/recall.md` §2 段0・§5 の決定文（逐語、両方とも既存）:

> 決定: スコープ = tenant + subject + 時間窓(period) + taxonomy + status ゲート。status ゲートは段1の候補生成と同じ `status IN ('active', 'contested')` である。

> status ゲートで落ちた Memory（`archived`/`superseded`/`forgotten`）は「スコープ内」に含まれない——したがって群カウントにも乗らない。

**決定1により、`purge` は `status = 'forgotten'` の対象にしか効かず、`status` を動かさない。** ⟹ purge された Memory は、purge の前後を通じて常に `status = 'forgotten'` であり、**この決定文により、そもそも一度も「スコープ内」に入ったことが無い**。`groups`/`totalInScope`（第3階の群カウント）は最初から対象にしていない——purge はこの事実を作ってもいなければ、この事実に触れてもいない。

**⟹ `packages/core/src/recall.ts` の `ScopeAggregate`・`packages/core/src/recall-runtime.ts`・`packages/postgres/src/memory-store.ts` の `aggregateScope` 実装は、この PR で1行も変更していない**（`rg -n "purge" packages/core/src/recall*.ts` で検算可能——0件のまま）。

**`filteredForgotten`（`ScopeAggregate.filteredForgotten`）はどうなるか**: この件数は `status = 'forgotten'` の Memory を数える既存の集約であり、purge 済みかどうかを区別しない。**意図的にそのままにした**——`filteredForgotten` は「利用者が明示的に忘れさせた件数」という意味を持ち（[ADR 0027](./0027-split-superseded-forgotten-omission.md)）、purge はその Memory が「忘れさせられている」という事実を変えない（`status` は動かないため）。区別したくなったとしても、`ScopeAggregate` に新しい欄（例: `filteredPurged`）を足す判断は本 issue の受け入れ条件（「群カウントに現れない」）を満たすために必要ではなく、**混ぜると「ついでに直す」になる**（`docs/autonomy.md` §2）。「検討して採らなかった案」に記録する。

**この不変条件が崩れていないことを実測する歯**: `packages/core/src/__tests__/purge.test.ts` に、`forget → purge` した Memory が (a) `recall()` の `memories`/`omitted` のどこにも現れず、(b) `aggregateScope`（`runtime.recall` 経由）の `index.totalInScope`/`groups` の総和を、purge の前後で**変えない**ことを確認する歯を置く（`restore-archived.test.ts` の「往復」節と同じ作法——被覆不変条件を主張ではなく実測で示す）。

### 決定7: マイグレーションは追加しない

文脈節で確認したとおり、`purged_at` 列・`memory_events.kind` の `'purged'` 値は `0001_init.sql` に既に在る。新しい索引も追加しない——`purge` は明示的な `id` を対象にした単発の CAS 書き込みであり（`archiveDecayed` のような範囲走査ではない）、主キー索引で十分である。

---

## 検討して採らなかった案（決定に埋め込んだもの以外）

1. **任意の `status` から直接 purge できるようにする。** 決定1参照。
2. **`updateStatusWithEvent` を再利用する（新しい任意メソッドを足さない）。** 決定4参照——`content`/`digest`/`purged_at` を書く必要があり、既存メソッドのシグネチャに収まらない。
3. **`digestSource` に `'purged'` 相当の値を足す。** 決定4参照。
4. **`ScopeAggregate` に `filteredPurged` を足す。** 決定6参照——受け入れ条件を満たすために必須ではなく、範囲を広げる。
5. **`VectorStore.delete` の失敗を `"failed"` として扱う。** 決定5参照——「安全に再試行できる」という `"failed"`/`"not_attempted"` の確立済みの意味を裏切る。
6. **`vectorStore.delete` の呼び出しをトランザクション内に含める（`MemoryStore`/`VectorStore` を同一 DB 接続でまとめて片方だけ起きないようにする）。** 却下——`VectorStore` は `MemoryStore` とは独立した interface であり（[ADR 0003](./0003-memorystore-vs-vectorstore.md)）、embed 済みの Memory を作る既存の経路（`embed` outbox ジョブ）自体が同じ非対称の上に成り立っている。この PR だけこの非対称を覆すのは範囲外。

---

## 引き受けた負債

1. 🔴 **`vectorStore.delete` が実際に失敗した場合、埋め込み行が残ったままになりうる。** 決定5参照。recall には現れない（status ゲートで既に弾かれる）が、法的要求の観点では未達が残りうる。運用側がこれを検知する手段（例: 埋め込み行の存在と `memories.purged_at IS NOT NULL` の突き合わせバッチ）は、本 PR の範囲に無い。
2. **`digestSource` は purge 後も元の値（`'llm'`/`'fallback'`）のまま残る。** 決定4「採らなかった案」参照——digest の中身が変わったことをこの列は反映しない。実害は小さい（`digestSource` は recall のどの判定にも使われていない、`rg -n "digestSource" packages/core/src/recall-runtime.ts` で確認済み・0件）が、正確ではない。
3. **`ScopeAggregate.filteredForgotten` は purge 済み/未済を区別しない。** 決定6参照。区別が要求されたら新しい欄を足す判断が要る。
4. **`content_hash` は purge 後も元の値のまま残る。** 本文が上書きされているのに `content_hash` はトゥームストーン以前の内容のハッシュを指し続ける。`(tenant_id, source_observation_id, extractor_version, content_hash)` の一意制約は `source_observation_id` が同じ行に対してのみ働き、purge された行は既に `forgotten` であって新規作成の対象にならないため実害は無いと判断したが、**「本文とハッシュが一致しない行が存在する」という事実は残る**。
5. **本物の Postgres に対してこの機能を実行していない**（この作業環境に `DATABASE_URL` が無い）。「確かめていないこと」節参照。
6. **並行呼び出しの歯は fake の store に対してのみ測っており、実 DB の行ロックの振る舞いは測っていない**（[ADR 0087](./0087-runtime-forget-shape.md) が確かめていないこととして残した限界と同じ）。
7. **`docs/architecture.md` §3.2 の動詞一覧を更新していない。** [ADR 0114](./0114-archive-sweep-for-decayed-memories.md)（`sweepArchive`）・[ADR 0122](./0122-restore-archived-memory.md)（`restoreArchived`）もこの文書を更新しておらず、同じ前例に倣った。

---

## これが覆るとしたら

- **オーナーが「`forgotten` を経ずに直接 purge できる経路が要る」と判断したとき**——決定1を覆す。そのとき `docs/memory-model.md` §11 lifecycle 表行10の遷移元を広げる正典側の変更が先に要る（実装の都合で正典を黙って広げない、`AGENTS.md` の規律）。
- **`vectorStore.delete` の失敗が実運用で無視できない頻度で起きたら**（負債1）——決定5を見直し、失敗した embedding 削除を再試行するための独立した保守操作（`purgeExpiredEvents`/`archiveDecayed` と同じ形の、明示呼び出しのみの任意メソッド）を追加する判断が要る。
- **`filteredForgotten` と「purge 済みかどうか」を区別する要求が来たら**（負債3）——`ScopeAggregate` に新しい欄を足す ADR が要る。
- **`digestSource`/`content_hash` の不整合が実害を持つ規模になったら**（負債2・4）——`purgeMemory` の契約を広げてこれらも書き換える判断が要る。ただし `digestSource` は union への値追加を伴いうるため、その時点で改めて破壊的変更の判断（`docs/autonomy.md` §3）が要る。

---

## 測ったこと（手元、`packages/core`・`packages/testkit` に対して実行した）

- `pnpm --filter @mnemora/core test`・`pnpm --filter @mnemora/testkit test`（In-Memory 実装に対する適合テスト経由）が緑であること。
- 変異試験（下記コマンドと出力は PR 本文に転記する）:
  - `purgeMemory` の CAS 条件から `purged_at IS NULL` を外す変異 → 「2回目の purge は書き込みをしない」歯が赤くなる。
  - `Runtime.purge` の `status !== 'forgotten'` チェックを外す変異 → 「`active`/`archived`/`superseded`/`contested` は purge できない」歯が赤くなる。
  - `tick()`/`observe()` に `purge` 相当の呼び出しを混ぜ込む変異 → 決定3の歯が赤くなる。
  - `vectorStore.delete` の呼び出しを消す変異 → 「embedding が実際に消える」歯が赤くなる。
  - `aggregateScope`/`recall-runtime.ts` を変更していないことの確認（変異ではなく `rg` による静的な検算）。
- **既存の回帰の歯が実際に噛んだ（設計どおりの副作用）**: [ADR 0117](./0117-unreachable-union-values-inventory.md) の棚卸し（`unreachable-union-values.test.ts`）は `kind: "purged"` を「分類2: 後続 Phase 待ち」として登録していた。本 PR で `Runtime.purge` がこの値を実際に生成するようになった結果、この歯が赤くなった——**まさにこの歯が捕まえるべきものを捕まえた**（「実装漏れ」ではなく「実装完了」の検知）。棚卸しの一覧からこのエントリを外すことで対応した（`unreachable-union-values.test.ts` の追記コメント参照）。

## 確かめていないこと

- **本物の Postgres に対してこの機能（`PostgresMemoryStore.purgeMemory`・適合テスト）を実行していない。** この作業環境に `DATABASE_URL` が無い（`docs/autonomy.md` §1.1「DB を用意できない環境では判定不能」）。CI の `packages/postgres` ジョブ・ルートの `pnpm run test` の DB 段が実測の場になる。
- **真の並行呼び出し**（複数プロセス・複数コネクションからの同時 `purge`）は fake store 上でのみ検証しており、実 DB の行ロックの振る舞いは検証していない（[ADR 0087](./0087-runtime-forget-shape.md) と同じ限界）。
- **`vectorStore.delete` が実際に失敗するケース**（ネットワーク断等）は、本物の環境で発生させて確認していない——決定5の設計は推論に基づく。
- **北極星の物差し**（「使う側が会話ログを全部積むのをやめられたか」）への効果は測っていない。`purge` は recall の既定挙動を変えないため測定対象外と判断した（[ADR 0122](./0122-restore-archived-memory.md) と同じ扱い）。
