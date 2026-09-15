# ADR 0117: 型に在って一度も生成されない union の値の棚卸し — 落とすのは提起までにする

- **状態**: 採用（棚卸しと非破壊の明示のみ。**分類3は 2026-09-16、[ADR 0144](./0144-drop-unreachable-classification-3-union-values.md) で解決——落とす。下記「追記」参照**）
- **日付**: 2026-09-15

---

## ⚠ 追記（2026-09-16、Issue #206 分類3の決着）

本 ADR の「これが覆るとしたら」節が予告していたとおり、**分類3についてオーナーが「落とす」と
判断した**。中身は書き換えず、ここに追記する（ADR 0072 の「初版に穴が1つ在った」節・
ADR 0064 の「約2.5倍」の訂正と同じ、既存 ADR への追記という慣行に倣う）。

- **承認の出所**: [ADR 0144](./0144-drop-unreachable-classification-3-union-values.md) の
  「§3 の手続きについて」節を見ること——オーナー本人の発言（`v0.x` 段階についての一般論）と、
  クローンが明示した射程（`docs/autonomy.md` §3 の破壊的変更条項という条項単位）と、
  マネージャーによる Issue #206 への援用を、出所ごとに分けて記録してある。**「オーナーが
  Issue #206 を承認した」という意味では読まないこと。**
- **実施 PR**: [ADR 0144](./0144-drop-unreachable-classification-3-union-values.md) を見ること
  （ADR とその実装は同一 PR）。
- **実施内容**: `RecalledMemory.retrievedVia` から `"tag_match"`/`"recency"`、
  `StageSkippedOmission.reason` から `"budget_exhausted"`、`GroupCount.axis` から
  `"time_window"` を落とした。`FilteredOmission.condition` の `"tenant"`（分類1）・
  `"taxonomy"`（分類2）、`GroupCount.axis` の `"taxonomy"`（分類2）、`MemoryEventKind` の
  `"purged"`/`"events_purged"`（分類2。うち `"purged"` は [ADR 0124](./0124-purge-physical-delete.md)
  で既に実装済み）は本 PR の対象外であり、1バイトも変えていない。

**⚠ 各主張の出所を分ける**（ADR 0084 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この作業者が実際に `grep`/`rg`/読解して確かめた。
- **【受】** — Issue #206 の本文・コメントとして受け取り、この作業者が現物で裏取りした。

---

## 文脈

Issue #206（【受】）は、**型（union）には値が在るのに、それを生成するコードがリポジトリに
1行も無いもの**の棚卸しを求めている。[ADR 0084](./0084-lexical-recall-channel.md) が
「実装を伴わない値をユニオンに置かない」という方針を立てた（§4.3。Issue #106 が提案した
`"recent"` を、実装が無いという理由で型にすら入れなかった）が、**その方針より前に置かれた
値がいくつか残っている。**

`@mnemora/core` は npm 公開済みである（ADR 0014・ADR 0066）。**union から値を落とすことは
公開 API の破壊的変更である。**[docs/autonomy.md](../autonomy.md) §3 は次のように定める（【現物】
逐語）:

> | ⛔ してはいけない         | なぜ                                                                                               |
> | ------------------------- | -------------------------------------------------------------------------------------------------- |
> | **公開 API の破壊的変更** | `0.x` なので semver 上は許されるが、**提起までにする。**ADR を書き、実装は別 PR にして、承認を待つ |

**⟹ この ADR は「値を落とす」決定そのものを行わない。**分類3（後述）は**提起のみ**であり、
実装（落とす／実装する）は別 PR・オーナー承認待ちとする。

---

## 現物で確認した一覧

**すべて次の方法で確認した**: (1) 型が宣言されているファイルを特定する、(2) その値を
オブジェクトリテラルとして構築している箇所（`field: "value"` の形。union 型宣言の
`field: "value" | "other"` は除く）を、出荷対象パッケージ（`packages/core`・`packages/postgres`・
`packages/openai`・`packages/local-embedding`・`packages/anthropic` の `src/`。`__tests__`/
`__fixtures__`/`packages/testkit` は対象外——理由は下の「足した歯」節を見よ）
について `rg` で全件検索する、(3) 0件なら「生成されない」と確定し、コメント等から
**なぜ**生成されないかを読む。この手順は
[unreachable-union-values.test.ts](../../packages/core/src/__tests__/unreachable-union-values.test.ts)
としてコード化してあり、**今後の回帰を機械的に捕まえる**（§「足した歯」）。

| 値                                                | 宣言                              | 生成コードの捜索方法（【現物】）                                                                                                                                                                                                                                                                                                                                                                                    | 分類                                     |
| ------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `RecalledMemory.retrievedVia: "tag_match"`        | `packages/core/src/recall.ts`     | `rg -n 'retrievedVia:' packages -g'*.ts'` → `recall.ts`（宣言・schema）と `__tests__`/`format.ts`（表示のみ、`${m.retrievedVia}`）以外に出現しない。`recall-runtime.ts` 内部の `ScoredCandidate.retrievedVia` はそもそも `"ann" \| "lexical" \| "mandatory_companion"` に絞られた別の（より狭い）型であり、`"tag_match"` を代入すると型検査で落ちる                                                                 | 3                                        |
| `RecalledMemory.retrievedVia: "recency"`          | 同上                              | 同上                                                                                                                                                                                                                                                                                                                                                                                                                | 3                                        |
| `StageSkippedOmission.reason: "budget_exhausted"` | `packages/core/src/recall.ts`     | `rg -n 'budget_exhausted' packages -g'*.ts'` → 宣言2箇所（`interface`・`z.enum`）以外に0件。`recall-runtime.ts` の `reason:` 代入は `"empty_query_content"` / `"embedding_provider_unavailable"` の2つのみ（`grep -n "reason:" recall-runtime.ts`）                                                                                                                                                                 | 3                                        |
| `GroupCount.axis: "time_window"`                  | `packages/core/src/recall.ts`     | `rg -n '"time_window"' packages -g'*.ts'` → 宣言2箇所のみ。`axis:` を代入している本番コードは `packages/postgres/src/memory-store.ts:931` の1箇所のみで、値は `"subject"` 固定                                                                                                                                                                                                                                      | 3                                        |
| `FilteredOmission.condition: "tenant"`            | 同上                              | `rg -n 'condition: "tenant"' packages -g'*.ts'` → 宣言1箇所のみ。`recall-runtime.ts` の `condition:` 代入は `"archived"`/`"superseded"`/`"forgotten"`/`"period"` の4つのみ（`grep -n "condition:" recall-runtime.ts`）。既存の doc コメント（`ScopeAggregate` 直上）が「tenant はスコープの外側境界なので `filtered` として報告しない」と説明している——**ただしその文は誤りを含んでいた**（下記「見つけた副産物」） | 1                                        |
| `FilteredOmission.condition: "taxonomy"`          | 同上                              | 同上の grep 手順。0件。labels テーブルが Phase 2（[Issue #201](https://github.com/takecchi/mnemora/issues/201)）                                                                                                                                                                                                                                                                                                    | 2                                        |
| `GroupCount.axis: "taxonomy"`                     | 同上                              | 同上。→ Issue #201                                                                                                                                                                                                                                                                                                                                                                                                  | 2                                        |
| `MemoryEventKind: "purged"`                       | `packages/core/src/event.ts`      | `rg -n '"purged"' packages -g'*.ts'` → **宣言2箇所（`type` と `z.enum`）以外に repo 全体で1件も出現しない**（テストのフィクスチャにも無い）。→ [Issue #198](https://github.com/takecchi/mnemora/issues/198)（`purge()` の入口が無い）                                                                                                                                                                               | 2                                        |
| `MemoryEventKind: "events_purged"`                | 同上                              | `rg -n '"events_purged"' packages -g'*.ts'` → `packages/core/src`・`packages/postgres/src` に0件。`packages/testkit/src/event-store-conformance.ts` と各 `__tests__/` に、FK 制約（`memory_events.memory_id` が NULL を拒まないこと）を検査するリテラルとして出現する——`purge()` を模してはいない                                                                                                                   | 2                                        |
| `memories.provenance_kind` 列                     | `packages/postgres/src/schema.ts` | `rg -n 'provenanceKind\|provenance_kind' packages/postgres/src` → 書き込み（`memory-store.ts` 3箇所）とフィルタ述語（`vector-store.ts:90`, `lexical-store.ts:102` の `excludeProvenanceKinds`）にのみ出現。`rowToMemory`（`mapping.ts:93-118`）は `provenance`（jsonb）だけを返し、この列を読み戻していない                                                                                                         | 該当外（union ではなく DB 列。詳細は下） |

### 見つけた副産物: 既存の doc コメントに1件、事実誤認があった

`ScopeAggregate`（`packages/core/src/recall.ts`、旧463行目付近）の doc コメントは
**「`FilteredOmission.condition` に `'tenant'`/`'subject'` の値が無い」**と書いていた。
**【現物】これは半分だけ正しい**——`condition` の union に `"subject"` という値は無いが、
`"tenant"` は在る（`condition: "tenant" | "superseded" | ... `。ちょうど今回の棚卸し対象その
ものである）。「値が無い」と「値は在るが生成されない」は、型を読む側にとって別の事実であり、
混同するとこの棚卸しの受け入れ条件（「型定義を読むだけで来ないと分かる」）が成立しない。
本 PR でこの1文を訂正した（値そのものは1バイトも変えていない。ドキュメントのみ）。

---

## 分類

Issue #206 が立てた3分類をそのまま使う。

### 分類1: 意図的に発火しない（`condition: "tenant"`）

**残すのが正しい。**tenant はスコープの外側の境界であり、「別テナントのデータを omission
として報告しない」のと同じ理由で、恒久的に来ない。**問題は「発火しないこと」ではなく
「それが型を読むだけで分からないこと」だった。**本 PR で `FilteredOmission.condition` の
宣言直上に doc コメントを足し、この場で完結して読めるようにした（`ScopeAggregate` まで
遡って読む必要が無いようにした）。**型そのもの・値そのものは変えていない。**

### 分類2: 後続 Phase 待ち（`condition`/`axis: "taxonomy"`、`kind: "purged"`/`"events_purged"`）

**この ADR では触らない。**対応する issue（#201・#198）が実装されれば発火するようになる。
Issue #206 の「⚠ 注意」（ADR 0084 の方針そのものは変えない。方針が立つ前に置かれた値の
後始末であって方針の見直しではない）に倣い、**先送りの是非そのものは論じない。**
doc コメントには「いつ発火するようになるか」（対応する issue 番号）を明記した。

**⚠ 副次的な発見**: `"purged"` は `"events_purged"` より**さらに孤立している**——後者は
少なくとも `packages/testkit` の適合テストが FK 制約検査のリテラルとして参照するが、
前者は宣言以外に repo 全体で1回も出現しない。これは Issue #198 側で拾うべき情報であり、
本 PR では doc コメントに記録するに留める。

### 分類3: 設計が消えたのに値だけ残った（本題）

`retrievedVia: "tag_match"/"recency"`、`reason: "budget_exhausted"`、`axis: "time_window"`
の4値。**これらは「実装する」か「union から落とす（＝破壊的変更）」かを決める必要がある
が、この作業者には決める権限が無い**（`docs/autonomy.md` §3）。

**⟹ この ADR が決めるのはここまでである: 提起する。実装しない。落とさない。**

- **落とすなら**: `RecalledMemory.retrievedVia` を `"ann" | "lexical" | "mandatory_companion"`
  に縮める、`StageSkippedOmission.reason` から `"budget_exhausted"` を除く、`GroupCount.axis`
  から `"time_window"` を除く。**いずれも `@mnemora/core` の公開型の破壊的変更であり、
  semver 上は `0.x` なので許容されるが（ADR 0070 の versioning 方針）、`docs/autonomy.md` §3
  により「提起までにし、実装は別 PR・承認待ち」にする。**
- **実装するなら**: `"tag_match"`（タグ一致による候補生成）・`"recency"`（直近取得）は
  `docs/recall.md` §2 が一般形として触れている機能であり、ADR 0084 §8 も「まだ実装が無い」
  と明記している。`"budget_exhausted"` は `RecallBudget` 超過時の `stage_skipped` 版
  （現状は `budget_dropped` だけがある）。`"time_window"` は目次帯の時間軸グルーピング
  （`docs/recall.md` §5 が触れている）。**これらはいずれも北極星の物差し
  （「渡す量を減らせるか」）に効きうる機能だが、`retrieval` ベンチでの効果測定を伴う
  独立した設計判断であり、この棚卸し PR の範囲外である。**

**⟹ オーナーへの提起事項**（PR 本文にも独立節として掲載する）:

1. `retrievedVia: "tag_match"` — 実装するか、落とすか。
2. `retrievedVia: "recency"` — 実装するか、落とすか。
3. `reason: "budget_exhausted"` — 実装するか、落とすか。
4. `axis: "time_window"` — 実装するか、落とすか。

**「落とす」と決まった場合の実装は、この ADR ではなく承認後の別 PR で行う。**

### 分類外: `memories.provenance_kind` 列

union の値ではなく DB の列だが、Issue #206 の受け入れ条件に含まれるためここに記録する。
**`provenance.kind`（jsonb）と意図的に二重で持つ、書き込み専用・フィルタ専用の列である。**
`rowToMemory` が読み戻さない理由は「読み戻す先が無い」——core の `Memory` 型は
`provenance: Provenance` だけを持ち、`provenanceKind` という別欄は無い。この列の存在理由は
`vector-store.ts`/`lexical-store.ts` の `excludeProvenanceKinds` フィルタが jsonb を展開せずに
`provenance_kind <> ALL(...)` で絞れるようにするため、かつ `idx_memories_provenance_kind`
（`tenant_id, provenance_kind`）に載せるためである。**読み戻す側を増やすと、書き込み時に
jsonb とこの列がずれた場合の不整合が result に混入する経路が生まれる**——増やさない
判断を doc コメントとして `schema.ts` に残した（本 PR）。

---

## 決めたこと（本 PR の範囲）

1. **値は1つも落とさない。**分類1・2・3のいずれについても、union の実体は1バイトも
   変えていない。
2. **分類1の値（`condition: "tenant"`）に、宣言直上の doc コメントを足した。**
   型定義を読むだけで「意図的に来ない」と分かるようにした。
3. **分類3の値（4つ）に、宣言直上の doc コメントを足した。**「設計が消えて型に残った」
   「実装するか落とすかはオーナー判断待ち」であることを、値を見た人がその場で分かる
   ようにした。
4. **既存の doc コメントの事実誤認を1件訂正した**（`ScopeAggregate` 直上。上記「見つけた
   副産物」）。
5. **`schema.ts` の `provenanceKind` 列に doc コメントを足した。**読み戻さない理由を
   その場で説明する。
6. **回帰を捕まえる歯を足した**
   （`packages/core/src/__tests__/unreachable-union-values.test.ts`。次節）。

### 足した歯

`unreachable-union-values.test.ts` は、この棚卸しの表の各行について、出荷対象パッケージ
（`packages/{core,postgres,openai,local-embedding,anthropic}/src`。`__tests__`/
`__fixtures__`/`packages/testkit` を除く）を静的に走査し、その値がオブジェクトリテラルとして
構築されている箇所が0件であることを主張する。

**【実測】歯が実際に噛むことの変異試験**: `packages/core/src/recall-runtime.ts` に
`condition: "tenant"` / `axis: "time_window"` を含むダミーのオブジェクトリテラルを一時的に
挿入し、テストを再実行した。

```
❯ src/__tests__/unreachable-union-values.test.ts (9 tests | 2 failed)
  ❯ axis: "time_window"（…） は、出荷対象パッケージの本番コードから生成されない
  ❯ condition: "tenant"（…） は、出荷対象パッケージの本番コードから生成されない
```

挿入した2行に対応する2件のテストだけが落ち、残り7件は緑のままだった（=
他の7値を誤って拾っていない）。ファイルを退避コピーから復元し、`git diff` が空である
ことを確認したうえで再実行し、9件全て緑に戻ることを確認した（`docs/autonomy.md`§4「`git
checkout <file>` で変異を戻すと未コミットの編集も消える」の穴を踏まないため、`cp` による
退避と復元を使った）。

**⚠ この歯の限界**:

- 静的な文字列一致であり、`condition: someVariable` のような間接的な代入経路は検出しない。
- `packages/testkit/src` は意図的に対象外——適合テストは DB 制約を検査するために、本番では
  起きない値をわざと組み立てることがある（`kind: "events_purged"` の FK 検査が実例）。
  これを「生成された」と数えると、この歯が捕まえたい回帰と見分けが付かなくなる。

---

## 検討した代替案

- **分類3の4値を union から落とす。** **この PR では採らない。**`@mnemora/core` は npm
  公開済みであり、`docs/autonomy.md` §3 は破壊的変更を「提起までにする」と明示する。
  オーナー承認前に実装すると、この文書の運用そのものが崩れる。
- **`switch`/型ガードの網羅性検査（ESLint の `no-fallthrough` や独自ルール）を足す。**
  **見送った。**今回の問題は「網羅性が壊れている」ことではなく「union に来ない値が
  在ること」であり、網羅性検査は「来ない値」を型として要求し続けてしまう
  （呼び出し側に `case "tag_match":` を書かせるコストは、値を落とすまで消えない）。
  今回のスコープは「来ないことを知らせる」までであり、それ以上は分類3の決定を待つ。
- **`unreachable-union-values.test.ts` を `packages/testkit` の source-of-truth 定数
  （例: `RECALL_CHANNELS`）から値の一覧を自動導出する。** **見送った。**対象の9値は
  4つの異なる型（`RecalledMemory`・`StageSkippedOmission`・`FilteredOmission`・
  `GroupCount`・`MemoryEventKind`）に散らばっており、単一の定数から導出できる形に
  なっていない。ADR 0082 が引いた「散文で数え直さない」原則は、**単一の定数が既に
  在る**場合に効く原則であり、今回は無い。表（`UNREACHABLE_VALUES`）を手で持つ以外の
  形にすると、かえって「どの型のどの値を見ているか」が読みにくくなる。

---

## 引き受けた負債

- **分類3の4値は、この PR の後もまだ union に残る。**呼び出し側は今も
  `switch (m.retrievedVia)` で `"tag_match"`/`"recency"` を網羅する圧力を受け続ける
  （doc コメントは IDE のホバーでは読めるが、`switch` の網羅性検査はコメントを読まない）。
  **これはオーナー判断が出るまで解消しない。**
- **`unreachable-union-values.test.ts` の対象パッケージ一覧
  （`PACKAGES_TO_SCAN`）は手書きである。**新しい出荷パッケージが増えたときに、
  この一覧へ追記し忘れると、その新パッケージ内の回帰を見逃す。

---

## これが覆るとしたら

- **分類3についてオーナーが「実装する」と決めたとき**——該当する doc コメントと、
  この ADR の該当行を削り、実装 PR 側に「値が来るようになった」ことを記録する。
- **分類3についてオーナーが「落とす」と決めたとき**——別 PR で union を縮め、
  この ADR に「承認日・実施 PR」を追記する。**この PR 単体では実施しない。**
- **Issue #198・#201 が着地したとき**——分類2の該当行は「後続 Phase 待ち」から
  「生成されるようになった」に変わる。`unreachable-union-values.test.ts` の該当する
  `it` が赤くなるはずであり、**それがこの歯の正しい反応である**（実装が入ったのに
  棚卸しの記述を直し忘れたことを教える）。

---

## 確かめていないこと

- **`retrieval` ベンチ（MRR / `hit@1`）への影響は測っていない。**分類3の値を実装した
  場合に想起がどう変わるかは、この ADR の範囲外であり、実装 PR 側の仕事である。
- **DB を要する検査は実行していない。**この作業環境には Postgres も docker も無い
  （`packages/postgres` の適合テスト・`idx_memories_provenance_kind` 索引が実際に使われるかの
  `EXPLAIN` 等は CI 側でしか確認できない）。
- **`packages/testkit`・examples・各 `__tests__` を含めた「repo 全体」を毎回 grep で
  再確認したわけではない。**棚卸しの主張は、上の表に書いた個別の `rg` コマンドの出力
  （【現物】）に基づく。歯（`unreachable-union-values.test.ts`）が継続的な保証を引き継ぐ。
