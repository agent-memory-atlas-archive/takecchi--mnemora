# ADR 0145: `Memory.validFrom`/`validUntil` を配線する — 型・`packages/postgres` の読み書きだけを実装する（Issue #202 第1弾）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

**Issue #202 の7つの受け入れ条件のうち、次の3つだけをこの PR で実装した。**

- [x] `Memory` 型に `validFrom`/`validUntil` が在り、`packages/postgres` が読み書きする
- [x] `occurredAt` と混ぜない。両者の違いが doc コメントで説明されている
- [x] `packages/testkit` の適合テストが両実装で通る（`InMemoryMemoryStore` は実行して確認、
      `PostgresMemoryStore` は共有適合スイートに載せた——後述「確かめていないこと」）

**残り4つ（`RecallQuery` から問える・段1への索引の押し下げ・`omitted` での名指し・
抽出が埋めるかどうか）は、この PR ではやらない。**射程外の理由は「射程外にしたもの」の
節に分けて書く。**⛔ issue 全体を1本の PR で片付けない、という指示に従っている。**

**この PR は `recall()` の挙動・スコア・`omitted` を1バイトも変えていない。**
`Memory`/`NewMemory` にフィールドを2つ足し、`packages/postgres`（3箇所の `INSERT`・
`rowToMemory`）・`packages/testkit`/`packages/core` の in-memory 実装にその読み書きを
配線しただけである。**マイグレーションは不要だった**（後述「マイグレーションについて」）。

---

## 現状（現物で確認した）

**出所: 私がこの作業環境で実行した。**

- `packages/postgres/migrations/0001_init.sql:76-77` に `valid_from timestamptz NULL,`・
  `valid_until timestamptz NULL,` が Phase 1 の時点から存在する（`-- Phase 2` の注記付き）。
  `packages/postgres/src/schema.ts:79-80` にも `validFrom`/`validUntil` の Drizzle 定義が
  同様に存在する（同じ注記）。
- **本 PR 以前、`packages/core/src/memory.ts` に `validFrom`/`validUntil` は1件も無かった**
  （`grep -rn "validFrom\|validUntil" packages/core/src` が0件、[マネージャーの実測]）。
- **本 PR 以前、`packages/postgres/src/memory-store.ts` の3箇所の `INSERT INTO memories`
  （`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories`）のいずれも
  `valid_from`/`valid_until` 列に触れていなかった。** 常に DB の既定（NULL）のまま。
  `packages/postgres/src/mapping.ts` の `MemoryRow`/`rowToMemory` にもこの2列は無かった。
- `memory_events.kind`・`MemoryStatus`・`FilteredOmission.condition` のいずれにも、
  この issue に関連する未実装の union 値は無い（`FilteredOmission.condition` は
  `"tenant" | "superseded" | "forgotten" | "archived" | "taxonomy" | "period"` の6値で、
  `valid_until` 超過を表す値はまだ存在しない——「射程外にしたもの」参照）。
- `purgedAt`（[ADR 0124](./0124-purge-physical-delete.md)）が、まさに同じ形——
  「Phase 1 から DB 列は在ったが `Memory` 型・`rowToMemory` に無く一度も読み書きされて
  いなかった列を、初めて配線する」——を1つ前に通った先例である。本 ADR は
  `purgedAt` の doc コメント・型への足し方（省略可能フィールド）をそのまま踏襲する。

## 設計は既に在る（`docs/memory-model.md` §3、原文で確認した）

> | `valid_from` / `valid_until` | その事実がいつからいつまで真か | 可 | 2 |

> **鮮度スコアは `occurred_at ?? recorded_at` を使う。減衰は `last_reinforced_at` を使う。**

`docs/roadmap.md` §3 Phase 2 の表:

> `valid_from` / `valid_until`（時間的妥当性） | Phase 1 で `occurred_at` / `recorded_at` /
> `last_reinforced_at` の3つの時刻を混ぜずに区別してあるため、4本目・5本目の時計として
> 自然に追加できる。

[ADR 0037](./0037-callers-pass-occurred-at.md)（`occurredAt` を実際に通した PR）の
「これが覆るとしたら」節はこう名指ししていた:

> **Phase 2 で `valid_from` / `valid_until` が入ったとき。**

**⟹ 「4本目・5本目の時計」という設計上の位置づけは、この issue 以前から文書に在った。
本 ADR はその位置づけを、型と postgres の層まで初めて実体化する。**

---

## マイグレーションについて（issue が「確認すること」と指示した点）

**不要だった。確認した。** `valid_from`/`valid_until` は `packages/postgres/migrations/
0001_init.sql` に Phase 1 の初版から存在する列であり、型・DDL・NULL 許容のいずれも
本 PR が必要とする形と一致している（`timestamptz NULL`）。新しいマイグレーションファイルは
1つも追加していない。

---

## 決定1: `Memory`/`NewMemory` に `validFrom?: Date | null`/`validUntil?: Date | null` を
## 省略可能フィールドとして追加する（非破壊）

```ts
export interface Memory {
  // ...
  occurredAt?: Date | null;
  recordedAt: Date;
  lastReinforcedAt?: Date | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  // ...
}
```

**`@mnemora/core` は npm 公開済み。** マネージャーからは「v0.x のうちは破壊的変更でも
構わず実装してよい」という判断が示されているが、**それは「やってよい」であって
「やるべき」ではない**、非破壊で足せるなら非破壊にすること、という指示を受けた。
**この2つのフィールドは非破壊で足せた**——`purgedAt`（ADR 0124）と全く同じ形で、
省略可能にすれば既存の呼び出し元・adapter・テストフィクスチャのリテラルはそのまま型を
満たす。**⟹ §3「してはいけないこと」の破壊的変更の条項に触れる必要が無かった。**
`NewMemory`（`Omit<Memory, "id" | "createdAt" | ...>`）はこの2フィールドを除外していない
ため、型定義を1行も変えずに自動的に伝播する。

`MemorySchema`/`NewMemorySchema`（zod）にも同じ形で `z.date().nullable().optional()` を
足した。既存の doc コメントが `strength`/`halfLifeHours` について明記しているとおり、
**この schema は書き込み経路では走らない**（`.parse()` している箇所は0件、型の導出元と
してのみ使われる）——値域の強制ではなく型の宣言としてここに置く。

---

## 決定2: `packages/postgres` の読み書きを配線する

`packages/postgres/src/mapping.ts`:

```ts
export interface MemoryRow {
  // ...
  last_reinforced_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  // ...
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    // ...
    lastReinforcedAt: parsePgTimestamp(row.last_reinforced_at),
    validFrom: parsePgTimestamp(row.valid_from),
    validUntil: parsePgTimestamp(row.valid_until),
    // ...
  };
}
```

`packages/postgres/src/memory-store.ts` の3箇所の `INSERT INTO memories`
（`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` の `news` ループ）
すべてに、`occurred_at, recorded_at, last_reinforced_at` の直後へ `valid_from, valid_until`
を列として足し、`VALUES` 側に `${input.validFrom ?? null}, ${input.validUntil ?? null}`を
足した。**3箇所とも同一パターンなので、`grep -c` で3件と数えて全部に当てたことを
確認した**（下記「測ったこと」）。**`UPDATE memories` の側（`reinforce`/`updateStatus`/
`purgeMemory` 等）はどこも触っていない**——これらの値は作成時にのみ設定され、
作成後に書き換える操作はこの PR の射程に無い（`occurredAt`/`lastReinforcedAt` も
`reinforce` 以外からは動かないのと同じ位置づけ。`lastReinforcedAt` だけは `reinforce`
という専用の動詞を持つが、`validFrom`/`validUntil` にはまだそのような動詞が無い
——「射程外にしたもの」参照）。

`packages/postgres/src/schema.ts`・`migrations/0001_init.sql` の `// Phase 2`/`-- Phase 2`
注記はどちらも**そのまま残した**。`purgedAt`（ADR 0124 で配線済み）の同じ注記も
配線後にそのまま残っている先例に倣った——この注記は「実装状況」ではなく「その列が
最初に設計へ現れた phase」を指しており、配線したかどうかで書き換える性質のものではない。

## 決定3: `packages/testkit`/`packages/core` の in-memory 実装にも同じ形で配線する

`InMemoryMemoryStore.createMemory`（`packages/testkit`）・`FakeMemoryStore.createMemory`
（`packages/core` 自身の runtime テスト専用フェイク、`packages/testkit` には依存しない
別系統）の両方に `validFrom: input.validFrom ?? null, validUntil: input.validUntil ?? null,`
を足した。**`FakeMemoryStore` は `packages/testkit` の適合スイートの対象ではない**
——[ADR 0142](./0142-outbox-complete-fail-compare-and-swap.md) の M2・
`fake-reinforce-monotonicity.test.ts` の doc コメントが指摘する族の穴（適合テストが
`InMemory*` だけを検査し、core 専用の `Fake*` には届かない）を、実装と同時にここで
塞ぐため、`packages/core/src/__tests__/fake-memory-store-valid-from-until.test.ts` を
専用に新設した（詳細は「測ったこと」）。

`packages/testkit/src/memory-store-conformance.ts` に3本の歯を足した
（`createMemory は validFrom/validUntil を書き込み、読み戻す`・
`省略すると null のまま保存・返却する`・
`occurredAt と validFrom/validUntil を混同しない`）。**この適合スイートは
`InMemoryMemoryStore`（`packages/testkit` 自身、DB 不要）と `PostgresMemoryStore`
（`packages/postgres/src/__tests__/conformance.postgres.test.ts` 経由、DB 必須）の
両方から同じ歯として呼ばれる**——新しいスタブを個別に書く必要は無かった
（ADR 0142 の「`packages/postgres`（CAS の実装自体）」節と同じ理由）。

---

## 射程外にしたもの（issue の受け入れ条件のうち、この PR で実装しないもの）

### 1. `RecallQuery` から「いつ時点で真だった記憶か」を問える口

**recall 側の設計判断が要る。** `RecallQuery` にどんな形の引数を足すか
（`asOf: Date` 単独か、`validAt` という専用の名前にするか、`occurredAfter`/`occurredBefore`
と同じ「範囲」の形にするか）は、`period`（ADR 0039/0059）の先例はあるが機械的に
決まるものではない。**1 PR = 1 ADR の原則に従い、別 ADR に譲る。**

### 2. その絞り込みが段1（ANN、索引が効く段）に降りているか

[ADR 0059](./0059-period-in-ann-stage.md) が `period`
（`COALESCE(occurred_at, recorded_at)`）を段1へ降ろした先例——`(tenant_id, status,
COALESCE(...))` の式索引を1本足す形——がそのまま参考になる。**ただし `valid_from`/
`valid_until` は「絞る条件」が単一の時刻との比較ではなく区間の包含（`validFrom <= asOf
AND (validUntil IS NULL OR validUntil > asOf)`）になるため、ADR 0059 と同じ式索引の形を
機械的に流用できるとは限らない。** 索引の設計自体が次の ADR の主題である。

### 3. `valid_until` を過ぎた記憶が `omitted` で名指しされる

`FilteredOmission.condition` は現在6値
（`"tenant" | "superseded" | "forgotten" | "archived" | "taxonomy" | "period"`）であり、
`valid_until` 超過は「フィルタされたが、既存のどの `condition` にも当てはまらない」
新種の理由になる。**新しい値を union に足すこと自体が、それだけで1本の ADR に値する**
——ADR 0027（`superseded`/`forgotten` を分けた）・ADR 0117/0144（union に実装の無い値を
置かないという規律）の系譜に沿って、この PR では決めない。

### 4. 抽出（`packages/core/src/extraction.ts`）が `validFrom`/`validUntil` を埋めるかどうか

**issue 本文が「別の判断である」と明記している。** マネージャーの注記も同じ方向:
「LLM に推測させる案は、北極星の問い5『これは、LLM を呼ばずに済ませられないか』に
当てて落ちる可能性が高い」——本 ADR もこれに同意する。`buildNewMemoryFromCandidate`
（`extraction.ts`）は本 PR で1行も変えていない。ADR 0037 が確立した規律（「まず
呼び出し側が渡す形を検討する」）に従うなら、次の一手は `ObserveInput` に
`validFrom`/`validUntil` を足して素通しする形が有力候補だが、**それも `RecallQuery` の
形が決まってから検討すべきであり**（値を受け取れても使い道が無ければ ADR 0037 が
警告した「口だけあって誰も使わない」を増やすだけ）、本 PR では `ObserveInput` にも
一切手を入れていない。

---

## 「書くが誰も読まない」を新しく作っていないか（Issue #273 の族への回答）

マネージャーから、[Issue #273](https://github.com/takecchi/mnemora/issues/273)
（`provenance_kind` が複製なのに一致を守る仕組みが無い）と同じ族——「列だけ在って
誰も書かない」を「書くが誰も読まない」に置き換えただけにならないか——を自分で判断して
書くよう指示された。

**結論: 置き換えていない、と判断する。** 理由:

1. **`Memory` は `MemoryStore.get(ctx, id)`/`getMany` を通じて呼び出し側へそのまま返る
   公開型である。** `recall()` が返す `RecalledMemory`（`memoryId`・`digest`・
   `retrievedVia`・`companionOf`・`provenanceKind`・`score` の6欄だけを持つ薄い射影、
   `recall.ts:745-782` のコメントが「`model`/`basis`/`confidence` 等が要るなら
   `MemoryStore.get()` を引け」と明記している）には `validFrom`/`validUntil` は
   **今回も**乗らない。しかしこれは `contentHash`・`digest` 全文・`purgedAt` と
   まったく同じ扱いであり、`validFrom`/`validUntil` だけが特別に読めないわけではない。
   `recall()` で `memoryId` を受け取った呼び出し側は `store.get(ctx, memoryId)` を
   呼べば `validFrom`/`validUntil` を含む `Memory` 全体を読める——**経路は既に在り、
   この PR は塞いでいない。**
2. **`Issue #273` の `provenance_kind` 列は「読み戻す経路そのものが意図的に無い」**
   （`packages/postgres/src/schema.ts` の doc コメント: `rowToMemory` はこの列を
   読み戻さない、と明記されている）——書いた値を読む手段が構造的に存在しない。
   **本 ADR の `validFrom`/`validUntil` は逆で、書いた値を `rowToMemory`/`get()`が
   そのまま読み戻す。** 族としては別物である。
3. **ただし、現時点でこの2フィールドに非 null の値を書く production コードは
   1つも無い**（`buildNewMemoryFromCandidate`・`buildReflectedMemory`・
   `buildConsolidatedMemory` のいずれも `validFrom`/`validUntil` を設定しない。
   「射程外にしたもの」4番のとおり、`ObserveInput` にも口が無い）。**⟹ 今この瞬間、
   実際にこの列へ非 null を書けるのは、`MemoryStore.createMemory` を直接呼ぶ
   呼び出し側（テスト、または `packages/postgres`/`packages/testkit` を直接消費する
   スクリプト）だけである。** これは「誰も読まない」ではなく「今のところ誰も書く手段が
   運用上ない」に近い——`purgedAt` が `Runtime.purge()` という専用の書き手を得るまで
   そうだったのと同じ、Phase 1 で列だけ用意した記録済みの列という段階そのものである。
   **この段階を終わらせる（実際に書く経路を運用に乗せる）のは「射程外にしたもの」4番の
   次の一手であり、本 ADR の範囲ではない。**

---

## §1.2「段2 の当て方」への回答

**この PR は段2ではなく、段3（2 の前提になっているもの）である。**

1. **何の数字が動くか**: **動かない。** `recall()` のフィルタ・スコア・`omitted` は
   1行も変えていない——`Memory`/`NewMemory` にフィールドを足し、
   `packages/postgres`/`packages/testkit`/`packages/core` の読み書きを配線しただけ。
2. **その数字を、どう測るか**: 測る対象が無いので測っていない。
3. **動かなかったら、どうするか**: **動かないことが期待どおりの結果である**
   （ADR 0037 の「本 PR は `packages/core` の振る舞いを1行も変えていない」と同じ形の
   確認——ただし ADR 0037 は `compare`/`retrieval` を実際に走らせて差分が無いことを
   実測した。**本 PR はその実測すらしていない**——recall のコードパス自体に触れていない
   ため、`compare`/`retrieval` を走らせても `validFrom`/`validUntil` を通る経路が
   存在しない。「実測して差が無かった」ではなく「そもそも触れる経路が無い」という、
   ADR 0037 よりさらに弱い主張である。この違いは正直に書く。

**測る器が今あるか**: **無い。** `examples/chat` の probe 集合を確認した——
`time-term-probe-set.ts`（8件）は `occurredAt`/`recordedAt` による**鮮度・減衰**
（`freshness`/`decay`）だけを測る arm であり、`fact`/`query` の本文をペアで同一にして
`similarity` を意図的に揃え、`occurredAt` の違いだけで順位が変わることを見る設計
（ファイル冒頭の doc コメント参照）。**「去年の住所」と「今の住所」のように、
時間的妥当性（どちらが今も真か）で区別すべき probe は1件も無い。** `identifier-probe-set.ts`・
`japanese-name-probe-set.ts`・既存 `probe-set.ts` も同様に確認したが、時間的妥当性を
測る事例は無い。**⟹ 次の人（第2弾以降の担い手）が測る器を必要とするとき、
ゼロから作ることになる。これは次の人への信号として明記する。**

---

## `occurredAt` と混ぜないことを歯にできたか

**部分的にできた。できていない範囲を分けて書く。**

**歯にできた範囲**:
- `Memory.validFrom`/`validUntil` の doc コメントで、`occurredAt` との違いを
  「去年の住所」/「今の住所」の具体例つきで説明した（受け入れ条件2の doc コメント要件）。
- `packages/testkit/src/memory-store-conformance.ts`・
  `packages/core/src/__tests__/fake-memory-store-valid-from-until.test.ts`・
  `packages/postgres/src/__tests__/mapping-valid-from-until.test.ts` の3箇所すべてに、
  「`occurredAt`/`validFrom`/`validUntil` の3つに別々の値を渡すと、別々に返る」ことを
  **実際に検査する歯**を置いた。これは doc コメントだけでは検出できない実装の誤り
  （例: `validFrom` を書くコードが誤って `occurredAt` の値をエイリアスする）を捕まえる
  ——「round-trip だけを見る歯は、同じ値を書けば通ってしまう」ため、3値を意図的に
  異なる値にしてから個別に比較する形にした（下記「測ったこと」の変異試験で実際に
  機能することを確認した）。

**歯にできなかった範囲**: **`AGENTS.md`/`docs/autonomy.md` が指摘する「規律ではなく
注意力に依存する形は必ず失敗する」という警告に照らすと、この歯は「今ある3箇所の
コード（`packages/postgres`/`packages/testkit`/`packages/core` の in-memory 実装）が
壊れたら検出する」ものであり、**「将来、新しい `MemoryStore` 実装や新しい書き込み経路
（例: `ObserveInput` 経由の passthrough）が `occurredAt` と `validFrom` を取り違えて
実装される」ことを型システムレベルで構造的に禁じるものではない**——TypeScript の型上は
`Date | null | undefined` という同じ形の値であり、名前を読み違えれば代入できてしまう。
**この限界は `purgedAt`/`occurredAt`/`lastReinforcedAt` の関係にも等しく当てはまる
既存の限界であり、本 ADR がここで新しく導入したものではない。** 塞ぐとすれば
「時刻を表す値に nominal typing 相当の branding を導入する」規模の変更になり、
1 PR = 1 ADR の原則を超える——ここでは提起に留める。

---

## 採らなかった案

### `validFrom`/`validUntil` を必須フィールドにする

却下。決定1参照——非破壊で足せるものをわざわざ破壊的にする理由が無い。

### `ObserveInput` に `validFrom`/`validUntil` を足し、`buildNewMemoryFromCandidate` で
### 素通しする（ADR 0037 と同じ形）

却下（この PR では）。issue 本文が「抽出が埋めるかどうかは別の判断」と明記しており、
**受け取れても使い道（`RecallQuery` 側の口）が無いまま先に足すと、ADR 0037 自身が
警告した「口だけあって誰も使わない」を実際に再現するだけになる。** `RecallQuery` の
設計が先であるべきだと判断した。

### 抽出プロンプトに「この事実がいつまで真か」を推測させる1文を足す

却下。issue の注意書きが名指しした通り、北極星の問い5（「これは、LLM を呼ばずに
済ませられないか」）に当てて落ちる可能性が高い——`ObserveInput` 経由の呼び出し側渡しを
先に検討していない段階で LLM 推測へ飛ぶのは、ADR 0037/0055 が確立した規律に反する。

### `docs/memory-model.md`/`docs/roadmap.md` の表の Phase 欄を書き換える（「2」→「1」）

却下。この PR が実装したのは「型・postgres の読み書き」までであり、`recall()` 側
（`RecallQuery`・段1・`omitted`）は依然として Phase 2 のままである。**表の値そのものを
書き換えると「4本目・5本目の時計が Phase 1 で完成した」という誤った印象を与える。**
ADR 0073 の先例（digest 帯の前倒しを、表の値ではなく「訂正」の脚注として記録した）に
倣い、`docs/memory-model.md` §3・`docs/roadmap.md` §3 に脚注を足す形にした
（表の値自体は変更していない）。

---

## 開いている穴・引き受けた負債

1. **`packages/postgres` に対する実際の書き込み・読み戻しは、この作業環境では
   一度も実行できていない**（`DATABASE_URL` 無し、Issue #247 の族）。3箇所の
   `INSERT` への列追加は静的な `grep` による確認と型検査（`tsc`）だけであり、
   本物の Postgres に対して `valid_from`/`valid_until` が実際に書き込まれ、正しい
   タイムゾーンで読み戻されることは CI の DB ジョブで初めて確認される。
2. **今この瞬間、`validFrom`/`validUntil` に非 null を書く production 経路が無い**
   （「書くが誰も読まない」節の3番）。次の一手（`ObserveInput` への passthrough、
   または直接 `MemoryStore.createMemory` を呼ぶ運用）は本 ADR の範囲外。
3. **`occurredAt` との取り違えを型システムでは禁じていない**（前節参照）。
4. **索引・`RecallQuery`・`omitted` の3項目は完全に未着手。** 次の担い手が
   ゼロから設計する。

## これが覆るとしたら

- **`RecallQuery` に「いつ時点で真だった記憶か」を問う口が実装されるとき**
  ——本 ADR の doc コメント（「この PR は recall のどのフィルタ・スコアにもこの値を
  使わない」）が古くなる。
- **段1（ANN）への索引の押し下げが実装されるとき**——ADR 0059 の式索引と同じ形で
  済むか、区間比較特有の設計が要るかが決まる。
- **`FilteredOmission.condition` に `valid_until` 超過を表す値が足されるとき。**
- **`ObserveInput` 経由の passthrough が実装されるとき**——「書くが誰も読まない」節3番の
  「今は production の書き手が無い」という前提が変わる。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**無関係。** `recall()` のどの経路にも触れていない。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `validFrom`/`validUntil` はどちらも省略可能で、既定は `null`——
何も渡さない既存の呼び出し元はこれまでどおり動く。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** `recall()` の選択・スコア・trace のどれにも関与しない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。** `provenance.kind` には触れていない。

### 問5: LLM を呼ばずに済ませられないか

**この PR 自体は LLM を1回も呼んでいない。** 「射程外にしたもの」4番で述べたとおり、
抽出に埋めさせる案自体がこの問いに当てて落ちる可能性が高いと判断し、実装しなかった。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。**

- `pnpm --filter @mnemora/core run typecheck` / `pnpm --filter @mnemora/testkit run
  typecheck` / `pnpm --filter @mnemora/postgres run typecheck` — 個別に緑を確認した。
- `pnpm --filter @mnemora/core run test` — 627 passed（既存624 + 新規3:
  `fake-memory-store-valid-from-until.test.ts`）、すべて緑。
- `pnpm --filter @mnemora/testkit run test` — 263 passed（既存260 + 新規3:
  `createMemory は validFrom/validUntil を書き込み、読み戻す`・
  `省略すると null のまま保存・返却する`・
  `occurredAt と validFrom/validUntil を混同しない`）、すべて緑
  （`InMemoryMemoryStore` に対して実際に実行された）。
- `pnpm --filter @mnemora/postgres run typecheck` — 緑（`mapping.ts`/`memory-store.ts`
  の変更に対する型検査）。
- `pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/mapping-valid-from-until.test.ts
  src/__tests__/memory-store-contested-write-guard.test.ts` — 13 passed、すべて緑
  （どちらも DB 不要。`packages/postgres` は plain `test` script を持たず `test:db`
  しか無い（`package.json` 確認済み）ため、これらのファイルはルートの `pnpm run test`
  では実行されない——`memory-store-contested-write-guard.test.ts` 冒頭の doc コメントが
  説明する手順どおり、このファイルを名指しして直接 vitest に渡した）。
- `grep -c "valid_from, valid_until" packages/postgres/src/memory-store.ts` → **3**
  （3箇所の `INSERT` すべてに列を足したことの確認）。

### 変異試験（`packages/core`/`packages/testkit`/`packages/postgres` の `mapping.ts` は
### DB を要さないため、実際に実行した）

**手順**: 変異の前に対象ファイルを `/tmp/mnemora-backup-202/` へ退避コピーしてから、
その場でコードを直接書き換えて赤を確認し、退避コピーから `cp` で戻して緑を確認した
（`git checkout` は使っていない——`docs/autonomy.md` §4 が指摘する「未コミットの編集も
消える」穴を踏まないため）。

- **M1**（`packages/postgres/src/mapping.ts` の `rowToMemory`: `validFrom`/`validUntil`
  を常に `null` を返すよう変異）: `mapping-valid-from-until.test.ts` で3本中**2本が
  固有に赤くなった**（「非 null なら Date に変換する」・「occurred_at と混同しない」の
  2本。「null なら null のまま返す」は変異後も偶然一致するため無傷——期待どおり）。
  `cp` で復元後、3本すべて緑に戻ることを確認した。
- **M2**（`packages/testkit/src/__fixtures__/in-memory-memory-store.ts` の
  `createMemory`: `validFrom`/`validUntil` を常に `null` を書き込むよう変異）:
  `packages/testkit` の適合スイートで263本中**2本が固有に赤くなった**（M1 と対応する
  2本——「省略すると null」は無傷）。復元後、263本すべて緑に戻ることを確認した。
- **M3**（`packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` に同じ
  変異）: `packages/core` で627本中**2本が固有に赤くなった**（
  `fake-memory-store-valid-from-until.test.ts` の3本のうち2本——ADR 0142 の M2 と
  同じ懸念、`FakeMemoryStore` は `packages/testkit` の適合スイートの対象外であるため、
  この専用の歯が無いと `InMemoryMemoryStore` 側を直しても `FakeMemoryStore` 側は
  検出されないまま取り違え続ける穴が実際に開くことを確認した）。復元後、627本すべて
  緑に戻ることを確認した。

いずれの変異も、`git diff --stat` が空でないこと（変異が実際に入ったこと）・`cp` での
復元後に `git diff --stat` が変異前の状態（意図した実装差分のみ）に戻っていること・
該当パッケージのテストスイートが全数元通りの緑になることを確認した。

### `packages/postgres` の `INSERT`/`UPDATE` の SQL 文言そのもの

**変異試験を実施していない。**「静的な参照関係から導ける論理」と「実際に書き換えて
赤を見る実験」を分けて書く: **導出**——3箇所の `INSERT` はいずれも同じパターン
（`sql` タグ付きテンプレート内の列リストと `VALUES` リストへの追記）であり、
`grep -c` で3件と数えたことでコード上は3箇所すべてに同じ変更が入っていることを
確認できる。**実験**——この変更が本物の Postgres に対して実際に正しい値を書き込み、
正しく読み戻すことは、DB 接続を要する（`this.db.execute` を実際に呼ぶ）ため、
**この作業環境（`DATABASE_URL` 無し、`which docker podman psql postgres initdb` は
全部何も返さない）では変異試験を含め一切検査できない。** CI の postgres ジョブが、
本 PR が `memory-store-conformance.ts` に足した3本の歯を `PostgresMemoryStore` に
対して実行して初めて確認される。

---

## 確かめていないこと

- **`packages/postgres` に対する実際の書き込み・読み戻し。** 上記のとおり、この作業
  環境には `DATABASE_URL` も docker も無い（Issue #247 の族）。
- **CI 全体の緑。** この PR を出した後、`node scripts/ci-green-check.mjs --pr <番号>`
  で1回確認する。
- **本 PR 以降、`validFrom`/`validUntil` に実際に非 null を書く運用が今後どのように
  実装されるか。** 「射程外にしたもの」4番・「開いている穴」2番の通り、これは次の
  担い手の判断に委ねる。
- **`RecallQuery`/段1/`omitted` の設計。** 3つとも別 ADR の対象であり、この PR は
  検討すらしていない。
