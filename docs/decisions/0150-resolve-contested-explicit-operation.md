# ADR 0150: 矛盾の解決 — `Runtime.resolveContested` で `contested → active | superseded` を閉じ、段3の発火を変異試験で測る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

**[ADR 0134](./0134-mark-contested-explicit-operation.md) が「別の主張として切り出す」と明記して
範囲外に置いた `docs/memory-model.md` §11 lifecycle **行7**（`contested → active | superseded`）を、
本 PR で実装する。**

- `Runtime.resolveContested(ctx, firstId, secondId, resolution, opts?)` を足す。
- `MemoryStore.resolveContestedPair?` を**任意メソッド**として足す（フォールバック経路は作らない）。
- **この口も「どちらが正しいか」を判定しない。**決着は呼び出し側が渡す
  （`{ kind: 'supersede', winnerId }` か `{ kind: 'both_active' }`）。
  ⟹ `docs/memory-model.md` §5「順序では解かない」と、`docs/north-star.md` 問い5「LLM を呼ばずに
  済ませられないか」の両方に、**判定を持たないことで**抵触しない。
- あわせて、Issue #197 の受け入れ条件「**段3が実際に発火することを測る歯**」を、
  **到達を数える歯**（`explain.stages` の `contradiction_resolution.companionsAdded`）と
  **変異試験**（段3が壊れた世界をテスト側で作り、歯が赤くなることを示す）の2枚で満たす。

⟹ **これで Issue #197 の「間違いを正すと、古いほうが先に出てこなくなる」は、
機構としては一巡する**——`markContested` で対を立て、`recall` が両方を隣接させて出し、
`resolveContested` で決着させると、**負けた側は次の `recall` から返らなくなる。**
一巡が実際に通ることは、1本のテストで端から端まで通している（「測ったこと」参照）。

---

## 文脈

### 正典（`docs/memory-model.md` §11 行7、原文で確認した）

> 7 | contested → active \| superseded | 新しい証拠・人手の訂正・統合により解決 |
> 判定は非同期でよいが書き込みは1トランザクション | `status` を確定、`contested_with_id` を
> クリア、（負けた側は）`superseded_by_id` を設定 | `updated` または `superseded`

**この行から4つ読み取った**（読み取りであって、実装の都合ではない）:

1. **決着は2種類ある。**`active | superseded` は「両方が同じ行き先へ行く」ではない——
   `superseded_by_id` を設定するのは**負けた側だけ**である。
2. **「負けた側」が居ない決着も許されている。**括弧書き「**（負けた側は）**」がそれを示す
   ——新しい証拠で「この2件はそもそも対向していなかった」と分かる場合、両方 `active` へ戻る。
3. **`contested_with_id` は必ずクリアされる。**どちらの決着でも「争っている」印は残らない。
4. **書き込みは1トランザクション。**判定（誰が勝つか）は非同期でよいが、書き込みは割れない。

### 前段（本 PR 以前の現物。私が `grep` で確認した）

- `status='contested'` を**正しく書ける唯一の口**は `MemoryStore.markContestedPair`
  （[ADR 0134](./0134-mark-contested-explicit-operation.md) / [ADR 0140](./0140-contested-write-side-companion-required.md)）。
- **`contested` から出る経路は1本も無かった。**`contested_with_id` を `null` に戻せる口が
  `MemoryStore` に存在しない——`updateStatus`/`updateStatusWithEvent` の引数に
  `contestedWithId` が無く、しかも ADR 0140 以後は `status:'contested'` を対象にした
  呼び出し自体が常に拒否される。
  ⟹ **本 PR 以前、一度 `contested` になった Memory は永久に `contested` のままだった。**
- 段3（`recall-runtime.ts` の `contradiction_resolution`）は ADR 0134 以後**発火するように
  なっており**、「Phase 1 ではここは一度も通らない」という古いコメントは ADR 0134 で
  既に置き換えられている（本 PR では、解決側が入ったことを追記するだけ）。

---

## 決定

### 決定1: 解決も「明示的操作」にする。判定はこの口が持たない

ADR 0134 決定2と同じ形を、解決側にもそのまま適用する。`resolveContested` は
**「この対はこう決着した」という呼び出し側の決定を、正典が要求する形で機械的に書くだけ**である。

**⟹ 2つの制約は、判定を持たないことで自動的に満たされる**:

- **順序で解かない**: 実装は `recordedAt`/`occurredAt` を**一度も参照しない**。
  「新しい方を勝たせる」という規則が入り込む場所が無い。
- **LLM を呼ばない**: このコードは1箇所も LLM を呼ばない。

**採った理由**: 「どちらが正しいか」を mnemora の中で決める方法は、ADR 0134 案A で既に
「LLM 以外に一般解が無い」と結論が出ている。**検出で解けなかったものが、解決では解ける、
ということは無い**——むしろ解決は「片方を `superseded` にして recall から消す」という
**不可逆に近い**操作であり、検出（両方出す・隣接させる、という安全側）よりも判定の誤りが痛い。
⟹ **判定を持たないという選択は、解決側ではより強く正当化される。**

### 決定2: 決着は `{ kind: 'supersede', winnerId }` と `{ kind: 'both_active' }` の2つだけ

正典の行7を読み取った2つの形（上の「文脈」1・2）をそのまま型にする。

| `resolution` | 勝った側 | 負けた側 | イベント |
|---|---|---|---|
| `{ kind: 'supersede', winnerId }` | `status='active'`・`contestedWithId=null` | `status='superseded'`・`supersededById=<勝者>`・`contestedWithId=null` | 勝者 `updated` / 敗者 `superseded` |
| `{ kind: 'both_active' }` | — | — | 両側 `updated` |

`{ kind: 'both_active' }` は「新しい証拠で、この2件はそもそも対向していなかったと分かった」
決着である。**`markContested` の取り消し（undo）ではない**——取り消しなら `memory_events` を
巻き戻すことになるが、ここは**追記**であり、「争っていた」という記録は残る。

**`winnerId` が `firstId`/`secondId` のどちらでもなければ `RangeError` を投げ、書き込みは
一切試みない**（ADR 0134 決定5と同じ「開く前に落とす」位置。`supersedeWithNewMemories` の
`supersededByIndex out of range` の先例に揃える）。

### 決定3: 適格性は「両側 `contested` **かつ相互参照が成立している**」

`markContested` の CAS が「両側 `status='active'`」だったのに対し、こちらは
**status だけでは足りない**。`first.contestedWithId === second.id` かつ
`second.contestedWithId === first.id` を要求する。

**理由**: [ADR 0046](./0046-contested-pair-invariant-tooth.md) の対不変条件（両側の
`contestedWithId` が相互に設定される）を、**解決側は読む側から守る**。
相互参照が成立していない2件を「対として解決」してしまうと、
**関係の無い第三者（`A.contestedWithId` が指していた `C`）が `contested` のまま取り残され、
しかもその対向は既に `superseded` になっている**——ADR 0136 が塞いだ「単独 `contested`」を
**解決側から新たに作ってしまう**ことになる。⟹ **この CAS は、不変条件を壊さないための
ものであって、厳しさのためのものではない。**

相互参照が成立していない側は `{ kind: 'pair_broken', contestedWithId }` として分類し、
**`status_not_contested` と潰さない**（ADR 0008「無いを分類して返す」の適用——
「`contested` ですらない」と「`contested` だが対が壊れている」は、呼び出し側が取るべき
次の行動が違う）。

### 決定4: `MemoryStore.resolveContestedPair?` は任意メソッド・フォールバック無し

ADR 0134 決定3と同じ判断。`@mnemora/core` は npm に公開済みであり、必須メソッドを足すと
第三者 adapter を壊す。

**フォールバックは作らない。**`supersedeWithNewMemories`（ADR 0100）が持っていたような
「既存メソッドの組み合わせで等価に代替できる」経路が、ここには**存在しない**——
`contested_with_id` を `null` に戻せる口が他に1つも無いことは、上の「前段」で現物から
確認した。⟹ **口が無い adapter に対しては `{ supported: false, outcome: { kind: 'not_attempted' } }`
を返す**（`PurgeResult.supported`（ADR 0124）・`MarkContestedResult.supported`（ADR 0134）と
同じ「無い」の名乗り方）。**黙って何も起きない形にはしない。**

### 決定5: 部分成功を許さない。TOCTOU は1回だけ再読して打ち切る

ADR 0134 決定4と同じ。対は本質的に結合しているため、全部成功するか全部失敗するかのどちらか。
{@link MemoryStatusConflictError} が投げられたら**1回だけ**再読して `conflict` を返す
——上限の無い再試行ループにしない（`forget`/`restoreArchived`/`purge`/`markContested` と
同じ安全弁）。

### 決定6: `memory_events.meta` は `reason: 'contested_resolved'` 固定 + `resolution` で決着の種類を残す

`meta.reason` は操作の種類を表す固定タグ（ADR 0134 決定6と同じ扱い。呼び出し側の自由文は
`meta.note`）。加えて **`meta.resolution` に `'supersede' | 'both_active'` を入れる。**

**理由**: 監査ログだけを見て「なぜこの Memory は `contested` でなくなったのか」を追えるように
するため。`status` の遷移先だけでは、`both_active` の2件と「まだ争っていない `active`」が
区別できない。これは `docs/north-star.md` 問い3（この記憶が選ばれた理由を、後から説明できるか）
の、監査ログへの適用である。

### 決定7: 段3の発火は「到達を数える歯」と「変異試験」の2枚で測る

Issue #197 の受け入れ条件は「**段3が実際に発火することを測る歯**」を要求している。
**「テストが緑である」ことは、「その分岐を通った」ことを意味しない**——段3は長らく
**通らないまま緑だった**分岐である。⟹ 2枚重ねる:

1. **到達を数える**: `recall()` の戻り値 `explain.stages` の `contradiction_resolution.detail.companionsAdded`
   を assert する。**これは本番コードが既に出している観測点であり、テスト側に述語を
   書き写していない**——`buildRequeueEmbedTargetSelect`（ADR 0079）・
   `buildArchiveDecayedSelect`（ADR 0114）が本体と歯で同じものを使う理由と同じ。
2. **変異試験**: 段3が壊れた世界をテスト側で作り、上の歯が**実際に赤くなる**ことを示す。

**🔴 変異は本番コードを書き換える形では行わない。**本番コードから歯止めを外すことは、
行為として「安全装置を外すこと」と同一である。⟹ 変異体は**すべてテストファイルの中で
`MemoryStore` を包んで作る**（`getMany` が同伴を返さない／`contestedWithId` を片方向に
見せる、等）。**本番の `packages/*/src` は1バイトも壊していない。**

---

## 採らなかった案

### 案A: 「新しいほうを自動的に勝たせる」解決

`docs/memory-model.md` §5 が明示的に落としている（「順序では解かない」）。ADR 0134 案B と
同じ理由で採らない。**同じ案を再提出しない。**

### 案B: LLM に決着を判定させる

`docs/north-star.md` 問い5。ADR 0134 案A と同じ結論——`Memory` 型に「何についての主張か」を
表す構造化フィールドが無いため、列と索引だけでは解けない。**解けないものを LLM で埋めない**
のが本 PR の立場であり、**解決側では判定の誤りが検出側より痛い**（決定1参照）ため、
検出側より強く採らない。

### 案C: 統合（`consolidate`）による解決を、この PR に含める

正典の行7は解決の契機として「新しい証拠・人手の訂正・**統合**」の3つを挙げている。
このうち**統合による解決**は、`supersedeWithNewMemories`（ADR 0100）で
「両方を `superseded` にして、統合先の新 Memory を1件作る」形になる——
**本 PR の2つの決着（`supersede`/`both_active`）のどちらとも違う第3の形**である。

**含めなかった理由**: この PR の主張（「解決は明示的操作であり、判定は呼び出し側が持つ」）に、
「統合の結果をどう対に結びつけるか」という**別の主張**が混ざる。1 PR = 1 ADR を守る。
⟹ **負債3**に書き、別 issue の候補として残す。

### 案D: 壊れた対（片側だけの `contested`）を `resolveContested` で修復できるようにする

決定3の CAS を緩め、相互参照が成立していなくても解決できるようにする案。
**採らなかった**——「対を正しく畳む」操作と「壊れたデータを直す」操作は目的が違い、
後者は**どの状態まで修復してよいか**という別の設計判断（誰が壊したか分からないデータを、
どこまで書き換えてよいか）を要求する。⟹ **負債2**に書く。

### 案E: `MemoryStore.resolveContestedPair` を必須メソッドにする

ADR 0134 案D と同じ理由で採らない（公開済みパッケージ、第三者 adapter が壊れる）。

---

## 引き受けた負債

### 負債1: 決着の正しさは、mnemora の側では一切検査していない

`resolveContested` は「呼び出し側が正しく判定した」ことを前提にしている。
**間違った勝者を渡されても、そのまま書く。**これは決定1の裏返しであり、
**負けた側は `recall` から返らなくなる**ため、誤った決着の影響は検出側（両方出す）より大きい。

**緩和になっているもの**: (a) 行は消えない——`superseded_by_id` から辿れるし、
`restoreArchived`（ADR 0122）とは別に、`superseded` から戻す操作は今日無いが、
**`content` は残っている**。(b) `memory_events` に `reason='contested_resolved'` と
`resolution` が残るため、**誰がいつどう決着させたかは後から読める**。

**緩和になっていないもの**: 誤った決着を**取り消す操作は無い**。
`superseded → active` の遷移は `docs/memory-model.md` §11 の表に**そもそも行が無い**
（行14 の `archived → active` に相当するものが `superseded` には無い）。
⟹ これは本 PR が作った負債ではなく、**正典の側に元から在る片道**である。

### 負債2: 片側だけの `contested`（`contestedWithId=null`）は、本 PR でも直せない

ADR 0134 負債1 が記録した状態を、本 PR も**修復できない**（決定3 の CAS で `pair_broken`
として弾く）。ADR 0140 で書き込み側の経路は塞がれたため、**今日この状態を新しく作れるのは
`MemoryStore` を `Runtime` も公開 interface も経由せず直接（生の SQL 等で）叩いた場合か、
ADR 0140 以前に書かれた既存データに限られる。**

⟹ **ADR 0140 以前に書かれた行が本番データに在る場合、その行は `contested` のまま永久に残り、
ADR 0136 により `recall` からは落ち続ける。**（**確かめていない**: 本番データにそのような行が
実在するかどうかは、この作業環境からは確認できない。）
修復の口（例: `repairLoneContested`）が要るかどうかは、案D の判断待ちとして残す。

### 負債3: 統合（`consolidate`）による解決は、正典に在るのに実装が無い

案C のとおり。`docs/memory-model.md` §11 行7 が挙げる3つの契機のうち、
**「統合により解決」だけが本 PR の後も実装されていない。**

### 負債4: `packages/postgres` の実装を、この作業環境で実際に Postgres に対して実行していない

ADR 0134 負債3 と同じ。この環境には Postgres も docker も無く（`DATABASE_URL` 未設定）、
`packages/postgres` のテストは**走らせていない**。**CI（`DATABASE_URL` が在る）が初めて
実行した。**⟹ 本 ADR の postgres 側についての記述は、**この作業環境では、コードの
読み取りに基づく主張である。**CI での実測は「測ったこと」に分けて書いた**——手元で
確かめたことと CI が確かめたことを、同じ顔で並べない。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**働く。**`contested` な対は `recall` で**必ず2件セット**で出る（機構2・機構3）。決着がつくと
**1件に減り、負けた側は二度と出ない。**⟹ 解決経路が無い状態は、
**争いが増えるほど毎回渡す量が単調に増える**状態だった。本 PR はそれを止める。

### 問2: Background Cognition を無効にしても成立するか

**成立する。**`resolveContested` は `tick()`/`observe()` から一度も呼ばれない明示的操作である
（`forget`/`purge`/`restoreArchived`/`markContested` と同じ立場）。背景処理を全部止めても、
呼べば動く。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**説明できる方向に働く。**決定6（`meta.resolution`）で、監査ログだけから決着の種類が読める。
また決定7の「到達を数える歯」は、**段3が実際に通ったことを `explain` から読める**ことを
利用しており、これは `explain` が単なる飾りでないことの実地の確認でもある。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**この口は区別を持ち込まない。**`provenance.kind` は一切参照せず、
`inferred` が `stated` に勝つことも、その逆も、**機構としては起きない**。
判定は呼び出し側にあるため、区別するなら呼び出し側が区別する。
（**確かめていない**: 「`stated` は `inferred` に勝つべき」という規則を mnemora が持つべきか
どうかは、正典に記述が無い。持つべきなら別の判断として起票する必要がある。）

### 問5: LLM を呼ばずに済ませられないか

**済ませた。**1箇所も呼ばない（案B）。

---

## 測ったこと

### 段3の変異試験（`packages/core/src/__tests__/stage3-mandatory-companion-mutation.test.ts`）

**出所: この PR の担い手が実際に走らせた。**`pnpm vitest run` で **4本すべて緑**。

歯の作り: `mark-contested.test.ts` の「段3が実際に発火する」テストの assert 式を**一字一句そのまま**
サンク化して並べ（7項目）、変異体ごとに `expect(() => assertion()).toThrow()` で
**「元のテストの assert が実際に赤くなる」ことを直接検算する。**
変異は `MemoryStore` を `Proxy` で包んで作る——**`recall-runtime.ts` は1バイトも触っていない。**

| # | 何を壊したか | `companionsAdded` | 観測された壊れ方 | 元 assert のうち赤くなった数 |
|---|---|---|---|---|
| 対照 | 壊さない | 1 | — | 0/7（全部緑） |
| A | 段3の同伴取得（`getMany`）が空配列を返す | 0 | **弱い方だけでなく強い方も消える**（対向が取れない `contested` は ADR 0136 の経路で単位を組まず落ちる）。`unit_assembly_dropped` が立つ | 6/7 |
| B | `contestedWithId` を片方向に見せる | 0 | A と同じ結果だが**壊した場所が違う**——`companionIds` が空になり、`getMany` は同伴のために**一度も呼ばれない** | 6/7 |
| C | `status` を `'contested'` → `'active'` に見せ、段3の入口条件を外す | 0 | **`unit_assembly_dropped` が立たない**。ADR 0136 の安全網の分岐にすら入らず、**弱い方が何の `omission` も立てずに静かに消える**——A/B より危険な壊れ方 | 4/7 |

### 🔴 この変異試験が見つけたこと（既存の歯の盲点。**推測ではなく実測**）

**「歯が在る」と「歯が噛む」は別だという Issue #197 の指摘は、既存の歯自身に当てはまっていた。**

1. **`expect(stage?.executed).toBe(true)` は、段3が壊れたかどうかの検出力を持たない。**
   本番が `companions.length` に関わらず常に `executed: true` を返すため、
   **3つの変異体すべてで緑のまま**だった。
   ⟹ 段3の発火を測っているのは `executed` ではなく **`detail.companionsAdded` のほうだけ**である。
2. **隣接性の assert `Math.abs(indexStrong - indexWeak) === 1` は、片方が完全に不在のとき
   偶然成立する。**`indexOf` が `-1` を返すため、残り1件だけのとき `abs(0 - (-1)) === 1` が通る。
   変異体C（強い方だけが残る）で**緑のまま**だった。
   ⟹ 隣接を測るなら、**両方が存在すること（`index >= 0`）を先に assert しなければならない。**
   本 PR の `resolve-contested.test.ts` はこの形で書いている。

**この2点は、変異試験を書かなければ見つからなかった**——どちらも「テストは緑だが、壊れても緑のまま」
という、まさに Issue #197 が段3全体について指摘した形の欠陥である。

### 作れなかった変異体（正直に書く）

**「段3は通るが対向が隣に並ばない」変異体は作れなかった。**提示順の隣接性は
`units` を1つの `Unit`（2要素）にまとめてから `flatMap` するという**構造そのもの**で
保証されており（`recall-runtime.ts` 670〜701行付近）、`MemoryStore` の戻り値を
すり替えるだけでは並べ替えられない。⟹ 代わりに変異体C（入口条件を外す）を置いた。
**「隣接は構造で保証されているから壊せない」は、この作業者の読み取りであって、証明ではない。**

### 手元で走らせた門

**出所: この PR の担い手がブランチ `feat/197-resolve-contested` 上で実際に走らせた。**

| 門 | 結果 |
|---|---|
| `pnpm run typecheck` | 7 workspace すべて `Done` |
| `pnpm run lint` | 出力無し（クリーン） |
| `pnpm run format:check` | `All matched files use Prettier code style!` |
| `pnpm run test` | ルート `Test Files 50 passed \| 1 skipped (51)` / `Tests 941 passed \| 2 skipped (943)`、`packages/core` 646 passed、`packages/testkit` 269 passed。**すべて緑** |
| `pnpm run build` | 全 workspace `Done` |
| `pnpm run pack:check` | `✔ publish 梱包の門を通りました。` |

**🔴 走らせていないもの: DB を要する段。**ルートの `test` 門は自分で
「**⚠ DB テストは実行していません（DATABASE_URL が未設定）**／この門が緑であることは、
DB 側を見たことになりません」と名指しで出力した（ADR 0015）。
⟹ **`@mnemora/postgres` の `test:db`（`resolveContestedPair` の適合テストを含む）と
`@mnemora/example-chat` の `test:db` は、この作業環境では一度も走っていない。**
**手元の緑を「全部通った」と読まないこと**——`resolveContestedPair` の SQL・CAS 条件・
トランザクション一体性を最初に実行するのは CI である（負債4）。

`packages/postgres` で手元から検査できたのは、**DB に触れる前のガードだけ**
（`first.id === second.id` の `RangeError`・`isUuidLike` 不一致の「memory not found」。
既存の `memory-store-contested-write-guard.test.ts` と同じ形で
`resolve-contested-pair-guard.test.ts` に置いた）。

### CI（**`packages/postgres` の実装が実際に Postgres へ対して走った**）

**出所: この PR の担い手が `gh` で引いて確認した。**PR #283、head sha `adc837c`。

- `node scripts/ci-green-check.mjs --pr 283 --recheck-after 30`（ADR 0132 の手順。
  手製の `grep` の近似は書いていない）→ **`status=green — 11件すべてが completed かつ success`**。
  30秒空けて引き直しても同じで `stable=true`
  （⚠ このツール自身が書くとおり、**「もう増えない」ことの証明ではない**）。
- **`skipped` を緑と読んでいない。**新しい適合テストが**本当に実行された**ことを、
  件数の差分で確かめた:

| ジョブ | `conformance.postgres.test.ts` の件数 |
|---|---|
| `main`（`8adb25d`、run 35004444181） | **228 tests** |
| 本 PR（`adc837c`、run 35005167765） | **237 tests** |

⟹ **`resolveContestedPair` の適合テスト9本が、本物の Postgres + pgvector に対して
実際に走って通った**（`server_encoding=UTF8` / `SQL_ASCII` の両 regime で）。
⟹ **負債4 は、手元については今も真だが、CI については解消した。**

**`origin/main`（`8adb25d`）の CI は `node scripts/ci-green-check.mjs` で
`status=green — 11件すべてが completed かつ success`**（ADR 0132 の手順。
手製の `grep` の近似は書いていない）。

---

## 確かめていないこと

- `packages/postgres` の実装を**実際の Postgres に対して実行していない**（負債4）。
- 本番データに ADR 0140 以前の片側だけの `contested` が実在するか（負債2）。
- 「`stated` は `inferred` に勝つべきか」——正典に記述が無い（問4）。
- 変異試験が**段3のすべての壊れ方を覆っている**とは主張していない。
  変異体は「同伴を取りに行かない」「相互参照が片方向になる」「段3の入口条件を外す」の
  3つであり、**これが網羅であるという証明はしていない。**

---

## これが覆るとしたら

- **自動的な決着（誰が勝つかを mnemora が決める）が要求されたとき。**
  そのときは決定1が覆る。ただし `docs/memory-model.md` §5 と `docs/north-star.md` 問い5 の
  両方を同時に動かす必要があり、**それはオーナーの判断である。**
- **`superseded → active` の取り消しが必要になったとき**（負債1）。正典の §11 に行を足す
  変更を伴う。
- **統合による解決が実装されるとき**（負債3）。`resolution` の union に第3の値が増える
  ——本 PR の型を判別可能 union にしてあるのは、**そのときに壊れずに増やせるようにするため**である。
