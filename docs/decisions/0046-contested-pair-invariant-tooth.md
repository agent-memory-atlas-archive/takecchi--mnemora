# ADR 0046: `contested` の一対一を「測れる形」にする——振る舞いは決めない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 問い

[ADR 0043](./0043-unit-assembly-dropped-omission.md) は「一対一の対向関係が破れて候補が単位から
漏れたら黙らない」ことを決めた。そこで残していた問いはこれである:

> **その壊れたデータ状態は、この系が自分で作れるか。**
>
> - **作れる** ⟹ 上流のバグ。振る舞いではなく、作れないようにするのが直し
> - **作れない** ⟹ **到達不能という前提そのものを歯にする**

## まず数えた: `contestedWithId` を書ける経路

**出所: 私が実行した**（`git grep` で全追跡ファイル。加えて DB へ直接問い合わせた——後者の実行は
作業者に委譲し、生の出力を受け取っている）。

| # | 経路 | `contested_with_id` を書けるか |
|---|---|---|
| 1 | `PostgresMemoryStore.createMemory`（`memory-store.ts:183`） | **書ける**（`NewMemory` の素通し） |
| 2 | `PostgresMemoryStore.createMemoryWithOutbox`（`:243`） | **書ける**（同上） |
| 3 | `InMemoryMemoryStore.createMemory` / `createMemoryWithOutbox`（testkit） | **書ける**（同上） |
| 4 | `FakeMemoryStore.createMemory`（core の歯の擬似物） | **書ける**（同上） |
| 5 | `updateStatus` / `updateStatusWithEvent` | **書けない**（`SET` 句は `status` と `superseded_by_id` だけ） |
| 6 | `setEmbeddingStatus` / `reinforce` / `recordUsage` | 書けない |
| 7 | **DB 側**（trigger / rule / 列 default） | **1件も無い**（`pg_trigger` 0件・`pg_rules` 0件・列 default は `null`） |
| 8 | `MemoryStore` interface のその他のメソッド | **宣言そのものが無い** |

**⟹ `contested_with_id` は「作成時にしか書けない列」である。**リポジトリ全体に
`UPDATE ... SET contested_with_id` は**1件も存在しない**。

### `Runtime` は自分では作らない

**出所: 私が実行した。**`Runtime`（`observe` / `tick` / `recall` / `reextract`）が組み立てる
`NewMemory` は `extraction.ts` の `buildNewMemoryFromCandidate` が全フィールドを列挙しており、
`status` も `contestedWithId` も**含まれていない**（⟹ 列の既定値 `'active'` / `null`）。
`Runtime` が書く `status` は `reextract` の `'superseded'` の1つだけである。

## 測った: 壊れた状態は作れるのか

**出所: 本物の PostgreSQL 17.9 + pgvector に対して実際に走らせた**（実行は作業者、
生ログを受け取って判定した。スクリプトはリポジトリ外・専用テナント）。

| 状態 | 公開 interface から作れるか | 実測 |
|---|---|---|
| `status='contested'` かつ `contestedWithId = null` | **作れる** | `updateStatus(id, "contested")` が成功し、`contestedWithId` は `null` のまま |
| 鎖 A→B→C | **作れる** | `createMemory` だけで作れた。**末端から**作る順序が要る（C→B→A） |
| 対向先が存在しない id | **作れない**（Postgres） | 外部キー違反 `memories_contested_with_id_fkey` (SQLSTATE 23503) |
| 自己参照 A→A | **作れない** | `id` は `gen_random_uuid()` で DB が採番し、作成時に自分の id を渡せない |
| **相互ペア A↔B** | **作れない** | 片方向しか張れない。**作成後に `contested_with_id` を書くメソッドが interface に無い** |

**⟹ マネージャーの見立て「到達不能なのは `Runtime` 経路に限る」は正しい。**
ただし、数え直すと**それだけでは足りない**ことが2つ出た。

### 出たこと1: 破れの形は1つではなく、最も安いものは公開メソッド1回で作れる

`updateStatus(id, "contested")` は `status` を `contested` にするが、**対向を渡す引数が
signature に無い。**⟹ この呼び出しが作れるのは「対向を持たない `contested`」だけである。
`docs/memory-model.md` §5 機構2 は「`contested` な Memory は**単独で返してはならない**」と
定めているが、段3の同伴取得は `contestedWithId` が非 `null` の候補にしか働かない
（`recall-runtime.ts:379-383`）。⟹ **この1回の呼び出しで作った Memory は、単独で返る。**

**⚠ これは本 ADR では直さない。**`MemoryStore` の公開 interface を締める判断は別の住所で
検討されている（族B の費用の材料集めと衝突する）。ここでは**測れるようにするだけ**である。

**2026-09 追記（[ADR 0136](./0136-contested-lone-dropped-not-returned-alone.md)、Issue #243）**:
「単独で返る」という上の指摘は、その後 [ADR 0134](./0134-mark-contested-explicit-operation.md)
（`Runtime.markContested`）を経てもなお未修復のまま残っていたが、ADR 0136 が
`recall-runtime.ts` の読み取り側で塞いだ——対向が見つからない `contested` 候補は単位を組まず、
`unit_assembly_dropped` として黙らずに落とす。**`MemoryStore` の公開 interface（下の表の
「締める」案）は依然として採っていない**——ADR 0136 は読み取り側の防御のみを実装し、
書き込み側の制約は破壊的変更になりうるため提起に留めている（`docs/autonomy.md` §3）。

### 出たこと2: 「一対一」が要求する状態を、今日どの経路でも作れない

`contested_with_id` は作成時にしか書けず、対向先は既に存在していなければならない（外部キー）。
⟹ **A↔B の相互参照は、公開 interface の組み合わせでは構成できない。**

**⚠ 「一対一」が相互参照を意味するのかは、私が決めることではない。**
`docs/memory-model.md` §5 は「対向する Memory を必ず一緒に取得する」と書いているが、
実装（段3）は**片方向しか辿らない**——候補として見つかった側の `contestedWithId` を引くだけである。
現に repo 内の fixture（`recall-pipeline.test.ts` の `setupContestedPair`）も片方向で、
対向側は `contestedWithId = null` の `contested` である。

**⟹ 正文と実装の読みが割れている。この ADR はどちらかに決めない。**
検査器は**両方を別々の名前で報告する**ようにし、判断はオーナー／Phase 2 へ残す。

## 決めたこと

**一対一が破れているかどうかを測る検査器を置き、その検査器自身に歯を置く。**

1. **`findContestedPairViolations(memories)`** を
   `packages/core/src/__tests__/contested-pair-invariant.test.ts` に置く。破れの形を
   **6種類に分けて名前を付け**、該当を全部返す（1件が複数の形を同時に持つなら全部返す）。
2. **各形に「発火する歯」と「発火しない歯」を対で置く。**破れていない相互ペアには
   何も出ないことを、同じ歯の中で**対向を持つ Memory が実際に2件在ること**と一緒に確かめる
   ——空配列が「壊れていない」なのか「何も見ていない」なのかを区別するため。
3. **`Runtime` を一巡させて作られた Memory に検査器を当てる歯**を置く。
   空振り防止に「1件以上作られたこと」を同じ歯で確かめる。

### 検査器を本番コードに輸出しない

**出所: 決定。**本番の呼び出し元が無い関数を `packages/core/src` から輸出することは、
[ADR 0024](./0024-remove-exact-counts-option.md) の「実装の無いものを『予約』と書き残さない」に反する。
**測るための道具は、測る場所に置く。**

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| **`Runtime` は `contested` を書かない、を歯にする** | **その前提が変わるのは事故ではなく予定である**（Phase 2 の矛盾検出）。予定で赤くなる歯は「Phase 2 を実装してはいけない」という意味になる |
| **壊れた鎖に対する `recall()` の振る舞いを決める** | Phase 2 の設計判断。ここで決め打ちすると、Phase 2 が別の答えを出したときに歯のほうが障害物になる |
| **`MemoryStore` の公開 interface を締める**（`contested` を単独で書けなくする） | 別の住所で族B の費用が集められている最中であり、衝突する。**2026-09 追記**: Issue #243 / [ADR 0136](./0136-contested-lone-dropped-not-returned-alone.md) がこの案を検討し直したが、破壊的変更になりうるため実装せず提起に留めた（読み取り側の防御を代わりに実装した）。この行の判断そのものは覆っていない |
| **`InMemoryMemoryStore` に参照整合性の検査を足す** | 別 package（`packages/testkit`）で別担当。ただし**食い違いは報告する**（下記） |
| **検査器を本番へ輸出し、`recall()` の中で毎回走らせる** | 費用が北極星の問い5（列と索引で足りるなら LLM/走査を足さない）に反する。**壊れているかを測ることと、毎回検査することは別物** |

## 引き受けた負債

- **`Runtime` 段の歯は、Phase 1 では対向関係の枝を一度も通らない。**`Runtime` が `contested` を
  書かないためである。⟹ **この歯が今日捕まえられる欠陥は無い。**捕まえるのは
  「`contested` を作る主体が入ったあと、それが一対一を破ったとき」である。
  **緑であることを「壊れていない」と読まないこと。**
- **検査器の「破れていない」側の fixture（相互ペア）は、今日どの公開経路でも作れない状態である。**
  ⟹ 検査器は、**まだ構成できない状態を正としている**。これは正文の読みに依存しており、
  読みが割れている点は上に明記した。
- **`InMemoryMemoryStore` と Postgres が食い違う。**Postgres は存在しない対向先を外部キーで
  弾くが、in-memory は**何も検査しない**（`in-memory-memory-store.ts:159` は素通し）。
  ⟹ **in-memory だけを見ている歯は、Postgres が拒む状態を通す。**適合テストはこの点を
  見ていない（見たら in-memory が落ちる）。本 ADR では直さない——報告する。

## これが覆るとしたら

- **Phase 2 が「一対一」を相互参照ではなく片方向と定める**とき。⟹ 検査器の
  `opposite_not_mutual` は不要になり、`contested_without_opposite` の意味も変わる。
- **`contested_with_id` を作成後に書く経路が入る**とき（相互ペアを構成するには要る）。
  ⟹ 「作成時にしか書けない」という上の表が崩れる。**この ADR の表は数え直すこと。**
