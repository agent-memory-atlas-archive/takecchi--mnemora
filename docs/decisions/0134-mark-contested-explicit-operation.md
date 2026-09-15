# ADR 0134: 矛盾の検出（第1弾）— `Runtime.markContested` という明示的操作で `contested_with_id` を初めて書く

- **状態**: 採用 (2026-09)

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 文脈

### 出所（Issue #197 本文、この作業者が現物で裏取りした）

[Issue #197](https://github.com/takecchi/mnemora/issues/197) は、`docs/north-star.md` の「目指す姿」——
**「間違いを正すと、古いほうが先に出てこなくなる」**——のうち、**「間違いを正す」側の検出**が
リポジトリのどこにも実装されていないことを指摘している。

**【現物】確認した現状**（自分で `grep`/コード読解で裏取りした）:

- `status = 'contested'`・`contestedWithId` を書く本番コードは、本 ADR 実装前は **0件**
  （`grep -rn "'contested'|\"contested\"" packages/core/src packages/postgres/src` の全ヒットは
  読み出しゲート（`status IN ('active','contested')`）と型定義のみ）。
- `packages/core/src/recall-runtime.ts` の段3（矛盾の解決と必須の同伴取得）は実装済みだが、
  実行前のコードには「Phase 1 ではここは一度も通らない。`Runtime` は `contested` も
  `contestedWithId` も書かないため」というコメントが実際に置かれていた（`:699-702`）。
- [ADR 0046](./0046-contested-pair-invariant-tooth.md)（既存 ADR、実測記録）が数え上げたとおり:
  - `contested_with_id` を**作成後**に書けるメソッドは `MemoryStore` に**1つも無かった**
    （`updateStatus`/`updateStatusWithEvent` の `SET` 句は `status` と `superseded_by_id` だけ）。
  - **相互ペア A↔B は、当時の公開 interface の組み合わせでは構成できなかった**
    （`createMemory` は作成時にしか `contestedWithId` を書けず、相手側はまだ存在しないため
    先に指せない）。
  - 一方で `updateStatus(id, "contested")` は**単体で今日も成功し**、`contestedWithId` は
    `null` のまま——「片側だけの `contested`」という壊れた状態は既に作れていた。

`Runtime` が `contested` を書く経路は、供給する主体が2つある: `runtime.reextract`/
`runtime.consolidate` の `supersede`（置換が機械的に決定できる側）と、**この issue が
埋めようとしている「判定できない対向を検出する」側**（`docs/memory-model.md` §11 行6）。
前者は既に実装されているが、後者は今日まで存在しなかった。

### 仕様（`docs/memory-model.md` §5・§11、原文で確認した）

§5「mnemora の決定: 順序では解かない」:

> 「新しい方を上に出す」という順位付けの発想そのものを採らない…**機構2: 判定できないときは
> `contested` に落とす。**どちらが正しいか、あるいはどちらが新しいかを機械的に決められない
> 場合、両者を `superseded` にはしない。

§11 lifecycle 行6・行7（逐語）:

> 6 | active → contested | 判定できない対向を検出 | 同上 | 両側の `status='contested'`、
> `contested_with_id` を相互に設定 | `updated`（`meta.reason='contested'`）
>
> 7 | contested → active \| superseded | 新しい証拠・人手の訂正・統合により解決 |
> 判定は非同期でよいが書き込みは1トランザクション | `status` を確定、`contested_with_id` を
> クリア、（負けた側は）`superseded_by_id` を設定 | `updated` または `superseded`

行6（検出・本 ADR の範囲）と行7（解決・別 ADR の範囲）は、正典の時点で既に別の行として
分かれている。

### issue が明示した2つの制約

1. **順序では解かない**（`docs/memory-model.md` §5 の既存決定を再提出しない。「新しい発話が
   勝つ」を安易に実装しない）。
2. **LLM を呼ばない**（`docs/north-star.md` 問い5。同じ北極星の表が「矛盾を recall のたびに
   LLM に判定させる」を既に落とした案として記録している——同じ案を再提出しない）。

### issue が推奨した分割

> **1 PR に収まらない可能性が高い。**最低でも次の2つに割れる: 1. 検出（`contested` を書く）
> 2. 解決（`contested` → `active | superseded`）

---

## 決定

### 決定1: 第1弾の範囲を「検出のうち、明示的操作」1本に絞る

issue 本文の受け入れ条件は、検出の置き場所として **抽出時 / 背景処理 / 明示的操作** の3つを
並列に挙げている。本 PR は**明示的操作**だけを実装する。

**採った理由**:

1. **「1つの主張になる境目」がここにある。** ADR 0046 が確認した欠落——
   「`contested_with_id` を作成後に書くメソッドが存在せず、相互ペアが公開 interface の
   組み合わせで構成できない」——は、**自動検出の有無に関係なく埋めるべき、純粋に機械的な
   欠落**である。これを埋めるだけで「段3が実際に発火する」という issue の核心的な受け入れ
   条件（「recall 段3は今日ひとつも発火しない」の解消）を満たせる。
2. **自動検出（抽出時・背景処理）には、LLM を使わない一般化の方法が無いと判断した。**
   `packages/core/src/memory.ts` の `Memory` 型を確認したところ、`content`/`digest`/`tags`/
   `subjectId` 以外に「何についての主張か」を表す構造化フィールド（主語・述語・対象など）が
   無い。任意の2つの Memory が意味的に矛盾するかどうかを、列と索引だけで一般的に判定する
   方法は無い——これは北極星の問い5に対して「解けない」と正直に出た結果である
   （詳細は「採らなかった案」参照）。
3. **解決（行7）は、別の主張として切り出す。** 行6（検出）と行7（解決）は正典の時点で
   別の行であり、「`contested` になった Memory をどう `active`/`superseded` へ戻すか」は
   本 PR が書く「対を作る」ロジックとは独立に設計できる。混ぜると、この PR が「検出の
   経路を作る」と「解決の方針を決める」という2つの主張を同時に背負うことになる。

### 決定2: 判定そのものは持たない。「対だと決まっている2件を、契約どおりに書く」操作にする

`Runtime.markContested(ctx, firstId, secondId, opts?)` は、**この2件が矛盾しているかどうかを
自分で判定しない。**呼び出し側（人・上位のアプリケーション層・将来の自動検出）が既に
「この2件は対向する」と決めていることを前提に、その決定を `docs/memory-model.md` §5 が
要求する形（一対一・相互参照・mandatory companion retrieval が働く状態）で機械的に
書き込むだけである。

**⟹ 2つの制約は、判定そのものをこの口が持たないことで自動的に満たされる**:
- **順序で解かない**: 「新しい方を勝たせる」という順位付けの発想が、そもそも入り込む余地が
  無い。CAS は両側 `status='active'` のみを見る——`recordedAt`/`occurredAt` のどちらが新しいかは
  一度も参照しない。
- **LLM を呼ばない**: このコードは1箇所も LLM を呼ばない。判定は呼び出し側の責務のまま
  持ち出さない。

### 決定3: `MemoryStore.markContestedPair?` は任意メソッド・フォールバック無し

`purgeMemory?`/`archiveDecayed?`（ADR 0124/ADR 0114）と同じ判断——`@mnemora/core` は npm に
公開済みであり、必須メソッドを足すと第三者 adapter を壊す破壊的変更になる。

**フォールバック（口が無い adapter に対して既存メソッドの組み合わせで代替する）は意図的に
作らない。** `supersedeWithNewMemories?`（ADR 0100）は「口が無ければ `updateStatusWithEvent` +
`createMemoryWithOutbox` の2段で今日どおり代替できる」という等価な代替経路を持っていたが、
本操作にはそれが無い。既存メソッドで書けるのは「片方だけ `status='contested'` にして
`contestedWithId` は空のまま」という状態に限られ、それは ADR 0046 が「単独で返り、機構2
（`docs/memory-model.md` §5）が破れる」と名指しした壊れた状態そのものである。**擬似
フォールバックを作ると、この PR 自身が ADR 0046 の指摘した欠陥を再生産する**——だから
「対応していない」とだけ返し、劣化した代替を試みない。

### 決定4: CAS は両側 `status='active'` 固定。部分成功を許さない（`supersedeWithNewMemories` とは異なる設計）

`supersedeWithNewMemories`（ADR 0100）は対象ごとに独立して CAS を評価し、競合した対象だけを
`conflicted` に積んで他は commit する——各対象が独立した置換であるため、部分成功が意味を持つ。

**本操作はこの設計を採らない。** 対向ペアは本質的に結合している——「片方だけ `contested` に
なった」状態を作ること自体が防ぐべき対象（ADR 0046 の指摘そのもの）であるため、**全部成功
するか全部失敗するかのどちらかにする。**片方の CAS が破れたら、もう片方が先に成功していても
ロールバックする（`packages/postgres` は1トランザクション、`packages/testkit`/
`FakeMemoryStore` は「まだ何も書いていないうちに両方を検証してから書く」ことで同じ意味論を
模す）。

### 決定5: `firstId === secondId` は書き込み前の `RangeError`

「自分自身と矛盾する」は意味を持たない入力であり、`supersedeWithNewMemories` の
`supersededByIndex out of range`（ADR 0100）と同じ位置——書き込みを一切試みる前に、
呼び手のバグとして落とす。CAS の結果（`ineligible`/`conflict`）と同じ「データとして返す
結果」には混ぜない。

### 決定6: `memory_events.meta.reason` は固定値 `'contested'`。呼び出し側の自由文は `meta.note`

`docs/memory-model.md` §11 行6 が `meta.reason='contested'` を明示している。これは
`forget`/`restoreArchived` の「呼び出し側の自由文がそのまま `meta.reason` に入る」規律とは
別物で、`consolidate`/`reflect` の「操作の種類を表す固定タグ」の扱いに揃えた
（`meta.reason: 'consolidated'`/`'reflected'` と同じ形）。`opts.reason` を渡した場合は
`meta.note` に追加で入れる——固定タグを上書きしない。

---

## 採らなかった案

### 案A: 抽出時・背景処理での自動検出（意味的な矛盾判定）

**採らない理由**: `Memory` 型（`packages/core/src/memory.ts`）は `content`/`digest`/`tags`/
`subjectId` 以外に構造化された「何についての主張か」を持たない。「ユーザーの好きな食べ物」
のような属性・値のペアを機械的に比較できる形で保持していないため、任意の2つの Memory が
意味的に矛盾するかどうかを**列と索引だけで一般的に**判定する方法が無い。無理に実装すると、
選択肢は実質2つしかない: (a) LLM に判定させる——issue が明示的に禁じ、`docs/north-star.md`
の表が既に落とした案そのものを再提出することになる。(b) 表層的なヒューリスティクス
（同じ `subjectId` かつタグ重複かつ埋め込み類似度が閾値超え、等）で「矛盾かもしれない」を
推測する——これは実質的に「類似しているが違う」を「矛盾している」と混同するリスクが高く、
北極星の問い3（説明できるか）に答えられない誤検出を量産しうる。**列と索引で一般的に解ける
問題ではない、というのが北極星の問い5に正直に当てた結果である。**この判断自体を、
`docs/roadmap.md` §5 のような「オーナー判断待ち」の場に送るのではなく、issue #197 が既に
自動検出を「抽出時/背景処理/明示的操作」の3択として提示していたことを根拠に、技術的に
決めてよい範囲として扱った（`docs/autonomy.md` §3.1「技術的に決められるなら決めて、理由を
ADR に書く」）。**将来 Memory の型に構造化された属性・値の表現が入るなら、この判断は
覆りうる**（「これが覆るとしたら」参照）。

### 案B: 順序（`recordedAt`/`occurredAt` の新しいほう）を根拠に自動的に片方を supersede する

**採らない理由**: `docs/memory-model.md` §5 が既に明示的に却下している(「新しい方を上に出す
という順位付けの発想そのものを採らない」)。同じ案を issue #197 の文脈で再提出しない。

### 案C: フォールバック経路を持たせる（`markContestedPair` が無い adapter に既存メソッドで代替）

**採らない理由**: 決定3参照。既存メソッド（`updateStatus`/`updateStatusWithEvent`）は
`contestedWithId` を書けないため、代替として書けるのは「片方だけ `contested`」という壊れた
状態に限られる。これは ADR 0046 が名指しした欠陥そのものであり、フォールバックの名目で
同じ欠陥を新しく作ることになる。

### 案D: `MemoryStore.markContestedPair` を必須メソッドにする

**採らない理由**: `@mnemora/core` は npm に公開済みであり、必須メソッドの追加は第三者
adapter を壊す破壊的変更になる（`docs/autonomy.md`「してはいけないこと」表）。ADR 0100/0114/
0124 と同じ判断。

### 案E: 既存の `updateStatus`/`updateStatusWithEvent` を拡張して `contestedWithId` を書けるようにする

**検討したが採らなかった。** `opts` に `contestedWithId` を足す案も考えたが、(a) この
メソッドは単一の Memory を対象にした CAS であり、**相互設定という「2件を1つの操作にする」
性質**を持たせるには結局シグネチャを大きく変える必要がある、(b) 既存の呼び出し元
（`reextract`/`consolidate`/`forget`/`restoreArchived`/`purge`）はこの拡張を必要としない
——`supersedeWithNewMemories`/`purgeMemory` が「既存メソッドの形に収まらない操作は新しい
専用メソッドにする」という先例を既に確立している。この先例に揃えた。

---

## 引き受けた負債

### 負債1: 片側だけの `contested`（`contestedWithId=null`）は、本 PR の後も作れるし、直せない

**出所: 私が実行して確かめた。**マネージャーの指摘を受け、`packages/core/src/recall-runtime.ts`
を読み直した。

- 段1の候補生成の status ゲートは `["active", "contested"]`（`recall-runtime.ts:335`,`:379`）
  ——`contestedWithId` の有無は見ていない。
- 段3の必須同伴取得は `c.memory.status === "contested" && c.memory.contestedWithId &&
  !presentIds.has(...)` でフィルタする（`:620-624`）——**`contestedWithId` が `null` なら、
  この対象はそもそも同伴取得の対象に入らない。**
- それ以外に `contestedWithId === null` を弾く・印を付ける処理は無い
  （`grep -n "contestedWithId" packages/core/src/recall-runtime.ts` の全行を確認した）。

**⟹ `packages/core/src/interfaces/memory-store.ts:175` 付近の契約
「`status='contested'` の Memory を単独で返してはならない」は、`updateStatus(id,"contested")`
を直接呼べば今日も破れる。** これは `docs/recall.md` §8 が避けたい事故——「争われている主張を、
争われていない顔で出す」——そのものである。実際に破れることを歯で示した
（`packages/core/src/__tests__/recall-pipeline.test.ts` の「recall() — 既知の未修復のギャップ:
片側だけの contested（Issue #243）」。`createEmbeddedMemory` で `status:'contested',
contestedWithId:null` の Memory を作り、`recall()` に単独で出ることを実測している）。

**この PR の `markContested` は、この状態を修復できない。** CAS を両側 `status='active'`
固定にしているため、既に `contested`（`contestedWithId=null`)な Memory を対象に渡しても
{@link MemoryStatusConflictError} で弾かれる——「壊れているものを直す」ための API が、
この PR には無い。

**なぜここで塞がないか**: (a) 今日この状態を作れる経路は `MemoryStore.updateStatus`/
`updateStatusWithEvent` を `Runtime` を経由せず直接叩く以外に無い——`Runtime` が書く
`contested` は本 PR で追加した `markContested` だけであり、これは常に相互参照込みでしか
書かない。⟹ 実害が起きるのは、呼び出し側や将来のコードが `MemoryStore` を直接操作した
場合に限られる。(b) ADR 0046 自身が「`MemoryStore` の公開 interface を締める」ことを
**採らなかった案**として明記し、「別の住所で検討されている」と理由を残していた——この
PR で無理に押し込むと、決定3・決定4で確立した「1つの明確な主張」に、性質の異なる別の
主張（読み取り側の防御、または書き込み側の interface 変更）を混ぜることになる。

**⟹ [Issue #243](https://github.com/takecchi/mnemora/issues/243) を新規に起票した。**
選択肢を2つ提示している: ①`recall-runtime.ts` 側で「`contested` かつ `contestedWithId=null`
の候補は単独で返さず `omitted` に落とす」読み取り側の防御、②`updateStatus`/
`updateStatusWithEvent` が `status:'contested'` を単独で書けないようにする書き込み側の
制約（破壊的変更になりうるため要検討）。どちらを採るか・両方要るかは issue #243 で
決める。

**これが実害になる条件（確かめた範囲）**: 今日のコードベースには `updateStatus(id,
"contested")` を直接呼ぶ本番の呼び出し元は無い（`Runtime` はこの形で呼ばない）。⟹ **現時点
では潜在的な欠陥であり、顕在化するのは誰か（呼び出し側アプリケーション・将来の PR）が
`MemoryStore` を直接操作したときに限られる**——ただし本 PR が `contested` を初めて「意味の
ある、実際に書かれる」status にしたことで、この経路への注目・利用が増える可能性は上がる。

### 負債2: `Runtime` を経由した `contested` ペアの一対一は、TOCTOU 以外では破れないが、証明はしていない

`markContested`/`markContestedPair` の CAS は両側 `status='active'` を要求するため、
`Runtime` 経由では鎖（A→B→C）や片方向を作れない——ただし、これは**実装の設計から導かれる
主張であり、任意の並行呼び出しパターンに対する形式的な証明ではない。**
`packages/core/src/__tests__/mark-contested.test.ts` の並行性の歯は
「読んだ後・書く前に1回だけ割り込む」という単純な race を固定条件付きの hook で再現した
ものであり、より複雑な interleaving（同時に3件以上を対象にした複数の `markContested`
呼び出しが絡み合う場合等）までは測っていない。

### 負債3: `packages/postgres` の実装は、この作業環境で実際に Postgres へ対して実行していない

**出所: 環境の制約。**この作業環境には `DATABASE_URL` も docker も無く、
`packages/postgres` の新しいコード（`PostgresMemoryStore.markContestedPair`）を実際の
Postgres + pgvector に対して実行していない。typecheck は通した。CAS・外部キー・事前検証の
順序（`second.id` が存在しない場合に外部キー違反という別種の失敗にならないよう、両方の
存在確認を UPDATE の前に済ませる設計にした）は、既存の実装（`updateStatusWithEvent`/
`purgeMemory`/`getMany`）の実測済みパターンをそのまま踏襲することでリスクを下げているが、
**実測はしていない。** CI の `postgres` conformance ジョブが実測の場になる。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**本 PR 単体では減らない。** `contested` になった Memory は mandatory companion retrieval に
より対向を道連れにするため、むしろ稀に増えうる（スコアだけなら選ばれないはずの対向が
強制的に追加される。`docs/recall.md` §8・ADR 0046 が既に受け入れている設計）。**削減が
実際に起きるのは行7（解決。別 PR）で `contested` の片方が `superseded` に確定し、既定の
recall から完全に落ちたときである。** 本 PR は、その削減を将来可能にする前提
（`docs/autonomy.md` §1.2 の段3「前提」）に位置する——`contested` を書く経路が無ければ、
行7がどれだけ正しく実装されても一度も入力を受け取れない。**増える分の正当化**は問3が担う:
争われている事実を単独の顔で見せるより、対向を隣接させて見せるほうが、下流（LLM
アプリケーション）が誤って古い事実を信じるリスクを減らす。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `markContested` は明示的な呼び出しでしか動かない。`tick()`/`observe()` からは
一度も駆動されない（`packages/core/src/__tests__/mark-contested.test.ts` の該当する歯で
実測済み）。呼ばなければ、今日と全く同じ挙動が続く。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**できる。** `RecalledMemory.retrievedVia: 'mandatory_companion'`・`companionOf`
（既存実装、本 PR は変更していない）に加え、`memory_events` に両側それぞれ
`kind:'updated', meta.reason:'contested'` を積む（`docs/memory-model.md` §11 行6 が定める
形をそのまま実装した）。「なぜこの2件が一緒に出てきたか」は監査ログと recall の trace の
両方から辿れる。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。** `markContested` は `provenance.kind` を一切参照・変更しない——`stated`/
`inferred`/`consolidated`/`reflected`/`imported` のどの Memory 同士でも成立する。この操作は
「誰が言ったか」ではなく「対向していると既に決まっている2件をどう書くか」だけを扱うため、
区別を混ぜる余地が無い。

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** このコード（`Runtime.markContested`/
`MemoryStore.markContestedPair`/`PostgresMemoryStore.markContestedPair`/
`InMemoryMemoryStore.markContestedPair`/`FakeMemoryStore.markContestedPair`）は1箇所も
LLM を呼ばない。「矛盾しているかどうかの判定」は呼び出し側の責務のまま持ち出しておらず、
この PR はその判定結果を機械的に——CAS と外部キーで——書き込むだけである。**自動検出
（判定そのものをどこで行うか）を LLM 無しで一般化する方法が無いと判断したのは、
「採らなかった案」の案Aである。**

---

## 測ったこと

- `packages/core`: typecheck 緑、`vitest run`（622 tests）緑。新規 `mark-contested.test.ts`
  （17 tests）・`contested-pair-invariant.test.ts` への追加・`recall-pipeline.test.ts` への
  追加（Issue #243 の実測含む）を含む。
- `packages/testkit`: typecheck 緑、`vitest run`（250 tests）緑。in-memory conformance に
  `markContestedPair` の契約テスト（成功・self-id・status バリエーション・not-found・
  クロステナント・任意メソッドの否定側）を追加。
- `packages/postgres`: typecheck 緑。**実際の Postgres への実行はしていない**（負債3参照）。
- `recall()` の段3が `Runtime.markContested` 経由で実際に発火することを
  `mark-contested.test.ts`「recall() の段3が実際に発火する」で実測した——`explain.stages`
  の `contradiction_resolution.executed === true`・`companionsAdded === 1` を確認している。

## 確かめていないこと

- `packages/postgres` の `markContestedPair` を、実際の Postgres + pgvector に対して実行した
  結果（負債3）。
- 3件以上が絡む複雑な並行呼び出しパターンでの振る舞い（負債2）。
- Issue #243（片側だけの `contested`）の実害が、実運用でどの程度の頻度・経路で起きうるか。

## これが覆るとしたら

- **`Memory` 型に構造化された属性・値の表現（主語・述語・対象等）が入ったとき**——
  「採らなかった案A」の前提（列と索引だけでは矛盾を一般的に判定できない）が変わる。
  自動検出（抽出時・背景処理）を LLM 無しで実装できる可能性が生まれる。
- **`docs/memory-model.md` §5 の「順序では解かない」という決定そのものがオーナーによって
  覆されたとき**——決定2の「順位付けの発想を持たない」という設計はその上に乗っている。
- **Issue #243 が「片側だけの `contested`」を書き込み側で塞ぐ方向に決着したとき**——
  `updateStatus(id,'contested')` が単独では成功しなくなり、負債1の前提（「今日この状態を
  作れる経路がある」）が変わる。
- **行7（解決）が実装され、`contested` → `active | superseded` の経路ができたとき**——
  問1の「本 PR 単体では削減しない」という評価は、行7と合わせて評価し直す必要がある。
