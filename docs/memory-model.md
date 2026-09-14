# Memory Model

本書は mnemora の記憶データモデルを定義する。対象は
**「6. DB schema 案」**と**「7. Memory lifecycle」**であり、そこへ到達するために必要な
Observation / Provenance / Digest / 矛盾 / 強化 / 忘却 / taxonomy / 監査ログの各決定を先に固める。

全体を貫く原則「文脈を剥がして提示しない」(Qualified Presentation) は `docs/architecture.md` 冒頭で
定義される。本書はその原則の適用先の一つであり、以降で「原則」と呼ぶときはそれを指す。

DDL は PostgreSQL を対象とする。各テーブル・各列に、どの Phase で導入されるかを明記する
（Phase 1 = 初期実装、Phase 2 = 後続）。Phase の指定が無い列は、そのテーブルが導入される
Phase と同じである。

---

## 1. Memory とは何か / Observation との違い

- **Observation** — 外から入ってきた出来事の生の記録。**不変。解釈しない。**
  発話・イベント・使用報告・投入文書など、mnemora の外側で起きたことをそのまま保持する。
  Observation は一度書かれたら内容を書き換えない。訂正は新しい Observation として追加される。
- **Memory** — Observation から抽出された、再利用可能な単位の記憶。**解釈済み。**
  誰が・何を・いつ言ったかではなく、「何が真だとみなせるか」を表す。

この二つを同一テーブルにしない理由は一つに絞れる。**抽出器のバージョンが上がったとき、
生記録が残っていなければやり直せない。** 抽出は決定的でも完全でもない。プロンプトを直す・
モデルを差し替える・抽出ロジックのバグを直す、といったことは実運用で必ず起きる。そのたびに
「もう一度、最初から抽出できる」ことが必要で、それを保証できるのは Observation が
Memory の作成後も無傷で残っている場合だけである。Memory だけを保存して Observation を
捨てる設計は、抽出器を一度でも間違えた瞬間に取り返しがつかなくなる。

この分離は冪等性の設計とも直結する。抽出は `(source_observation_id, extractor_version)` の組で
冪等にする。同じ Observation に同じバージョンの抽出器をもう一度かけても、Memory が重複しない。
これは Observation が変更されないことが前提であり、両者を混ぜると成立しない。

Observation の中には、Memory を生まないものもある。`observe(ctx, { kind: 'memory_usage', ... })`
（後述 §6）は「どの Memory が実際に使われたか」の報告であり、これは抽出器を通らず
`recall_usages` へ直接反映される。Observation は「mnemora の外で起きたことの記録」という
共通の型を持つが、そこから先の処理は `kind` によって分岐する。

---

## 2. Provenance（判別可能ユニオン）

Memory がどこから来たかは、後から付け足すフラグではなく、Memory の型そのものである。

```ts
type Provenance =
  | { kind: 'stated';       sourceObservationId: string; speaker?: string; at: string }
  | { kind: 'inferred';     model: string; promptVersion: string;
      basis: { memoryIds: string[]; observationIds: string[] }; confidence: number }
  | { kind: 'consolidated'; sources: string[] /* memoryIds */ }
  | { kind: 'reflected';    sources?: string[] /* memoryIds, 省略可 */ }
  | { kind: 'imported';     batchId: string }
```

DB では `provenance_kind` を**列**にし、`stated | inferred | consolidated | reflected | imported`
以外の値を受け付けない。判別に使うキーだけを列に上げ、残りのペイロード（`model` や `basis` など
kind ごとに形が違う部分）は `provenance` jsonb 列にまとめる。列にする理由は二つしかない。
**フィルタと索引。** recall がデフォルトで `stated` と `inferred` を区別して返す、あるいは
呼び出し側が推論を除外するオプションを使う、といった操作は SQL の `WHERE provenance_kind = ...`
で済ませたい。jsonb の中の値でしか判別できない設計だと、この頻出条件のたびに式インデックスを
別途用意することになり、それは列を持つのと手間が変わらないまま柔軟性だけ失う。

**ここが本書で最も明確にしておきたい対応関係:** オーナーの原則7「AI の推論とユーザーが言った事実を
区別する」は、実装上は別のフラグや別のテーブルとして現れるのではない。**`provenance.kind` の
値そのもの**がその区別である。`stated` と `inferred` の間に追加の「これは AI 由来か」という
フラグを設ける必要はない。判別可能ユニオンのタグが、そのままオーナーの要求している区別になっている。

**規律: 推論は根拠なしに提示しない。** `inferred` の Memory は `basis`（どの Memory / Observation
から導いたか）を持つ。しかし `basis` が指す先が消えている場合がある——参照先が `forgotten` に
なった、あるいは `purge()` で本文が失われた（§9・§11）。この状態を隠さない。`basis` が解決
できない `inferred` は、提示時に「根拠を失った推論」として印を付けて返す（削除はしない。
推論という事実自体は消えていないため）。これは原則の第2の現れそのものである——
「推論は、その根拠と必ず同時に提示する」という規律を、根拠が失われた場合にも一貫させるなら、
「根拠が失われたという事実」を提示するのが唯一の整合的な振る舞いになる。

---

## 3. 三つ（四つ）の時計

Memory は目的の異なる複数の時刻を持つ。これを一つの「時刻」に丸めると、後から分解できなくなる。

| 列 | 意味 | NULL 許容 | Phase |
|---|---|---|---|
| `occurred_at` | その出来事・事実がいつのものか | 可（不明なら NULL） | 1 |
| `recorded_at` | mnemora がいつ知ったか | 不可 | 1 |
| `last_reinforced_at` | 最後に実際に使われたのはいつか | 可（未強化なら NULL） | 1 |
| `valid_from` / `valid_until` | その事実がいつからいつまで真か | 可 | 2 |

**鮮度スコアは `occurred_at ?? recorded_at` を使う。減衰は `last_reinforced_at` を使う。**
**⚠ 鮮度は 1 で頭打ちにする**（[ADR 0036](./decisions/0036-clamp-freshness-at-one.md)）——`occurred_at` は
この表の定義上ふつうに未来になり（「来月、京都へ出張する」）、減衰式は経過時間が負のとき 1 を超えて
上限を持たないためである。**「まだ起きていない出来事は、最も古びていない」と決めた。**
この二つを同じ列に混ぜない理由は具体的である。「これはいつのことか」（鮮度）と
「最後に役に立ったのはいつか」（減衰）は、値が乖離するケースが普通にある。5年前に起きた
出来事（`occurred_at` は古い）を昨日思い出して使った（`last_reinforced_at` は新しい）Memory は、
鮮度としては古いが減衰としては強い。逆に、昨日聞いた話（`occurred_at` は新しい）を一度も
再利用していない Memory は、鮮度は高いが強化された実績が無い。この二つを一本の
「freshness」に潰すと、どちらの意味で計算したスコアなのかがコードを読まないと分からなくなり、
後から「実は鮮度と減衰は別の目的で使い分けたかった」と気づいても、過去に書き込まれた値が
どちらの意味だったのか復元できない。列を分けておけば、スコアリング式は自由に変更でき、
どちらの時計を使ったかは常に明示的である。

---

## 4. Digest（要旨）

`memories.digest` は **NOT NULL。抽出時に生成する。**

alteroid との対比が設計理由をよく示す。alteroid の要旨は、書き手が Markdown の frontmatter に
literal に書いた `description` を 200 文字で切るだけの処理であり、`description` が無ければ
「（要旨なし）」という固定文言が入る（先頭 N 文字を自動で切り出すフォールバックすら無い）。
これは「要旨は人間が書く」という前提に立っている。

mnemora はこの前提を採らない。**digest は抽出時に LLM が生成し、NOT NULL にする。** 理由は二つ。
(a) mnemora の Memory は人間が Markdown を手で編集する運用を前提にしない。抽出パイプラインが
自動生成した Memory に、人手で要旨を書き足す工程を挟むと、Phase 1 で想定する自動抽出の
スループットと矛盾する。(b) 目次帯（recall.md 参照）の質は digest の質に直接依存する。
100万件規模で「（要旨なし）」が並ぶ目次は、目次としての役割を果たさない。

**ただし alteroid の安全弁は採る。** alteroid では frontmatter が壊れている・未知の値である
場合、分類は必ず `premise`（全文を残す側）に倒れる設計になっている。**曖昧なら厚い側に倒す**
という思想である。mnemora でも digest 生成が失敗した場合に、Memory を「digest だけの薄い状態」
に落とすことはしない。NOT NULL 制約を満たしつつこの思想を反映するため、`digest_source` 列を
持たせる。

```sql
digest         text NOT NULL,
digest_source  text NOT NULL DEFAULT 'llm' CHECK (digest_source IN ('llm', 'fallback')),
content        text NOT NULL   -- 全文。digest 生成の成否に関わらず常に保持する
```

LLM による digest 生成が失敗した場合、パイプラインは機械的な先頭文字列切り出しへ
フォールバックし `digest_source = 'fallback'` を記録する。**content（全文）は生成の成否に
関係なく常に書き込まれる。** 「薄い側にしか情報が無い」状態を作らないのが安全弁の核心であり、
digest の生成方式がどちらであったかを隠さないのは同じ原則の適用でもある。

### ⚠ 安全弁は、作動したことが見えなければならない（2026-09 追記）

上の安全弁には**二段**ある。両者を混ぜないこと。

1. **LLM は候補を返したが digest が空・欠落だった** → 機械的な先頭切り出しへ倒し、
   `digest_source = 'fallback'` を記録する（上記）。
2. **LLM 呼び出し自体が失敗した** → Observation の全文を1件の `stated` Memory として残す。

**2 で残る Memory は「抽出されたもの」ではない。未処理の生テキストである。**
当初の実装はこれを 1 と同じ顔で記録していた——`ObserveResult` は `extracted: true` を返し、
`memory_events` の `created` イベントは `meta.reason = 'extracted'` を記録していた。
⟹ **監査ログが、起きなかったこと（抽出）を起きたと主張していた。**

安全弁そのものは正しい（記憶を失うくらいなら受け取る）。**間違っていたのは、
安全弁が作動したことを記録しなかった点である。** 一過性の LLM 障害が、
気づかれないまま生テキストを「抽出済みの記憶」として残す。

⟹ [ADR 0013](./decisions/0013-extraction-outcome-taxonomy.md) で、
`ObserveResult.extraction: ExtractionOutcome`（`ok` / `llm_failed_whole_observation` /
`skipped`）と、`memory_events.meta.reason` の区別
（`extracted` / `extraction_failed_whole_observation_fallback`）を決めた。

**曖昧なら厚い側に倒す。ただし、倒したことを黙っていない。**
これは [ADR 0008](./decisions/0008-absence-taxonomy.md) が `recall()` に対して定めた原則を、
取り込み側にも一貫させたものである。

ADR 0013 は「検知できるようになっただけで、やり直す操作は無い」という負債を残していた。
**`runtime.reextract(ctx, observationId)`（ADR 0028、2026-09 追記）**がこれを埋める。
同じ Observation に対して抽出をもう一度走らせ、成功すれば、2 で残った生テキストの Memory
（および古い版の抽出結果一般）を `status: 'superseded'` にする——`forgotten`（利用者が
意図して忘れさせた、という**製品の振る舞い**）ではなく `superseded`（より良い抽出に
置き換えられた、という**機構の都合**）にするのはオーナー決定である。詳細・却下した案・
引き受けた負債は [ADR 0028](./decisions/0028-reextract-superseded-cleanup.md) を参照。
supersede しなかった理由（`contested`/`forgotten` だったので飛ばした・変わっていなかった・
そもそも既存を見ていない）は `ReextractResult.skipped` に出る
（[ADR 0029](./decisions/0029-reextract-skip-visibility.md)）。

---

## 5. 矛盾の扱い

### 渡された問題設定

訂正を末尾に積むと、古い方が先に読まれる。ログは追記型なので「その場で置換」という手段が
そもそも使えない。

### ここで一度立ち止まって正直に書く

この因果——「訂正の積み上げによって実害が出た。だから mnemora は置換方針を採る」——は、
**alteroid のコードにもドキュメントにも記録が見つかっていない。** 現物（github.com/takecchi/alteroid）
で確認できたのは次の3点だけである。

- 全文置換ツール `memory_write` と末尾追記ツール `memory_append` が**両方**存在する。
- どちらを使うかは書き手（クローン）に委ねられており、システムとして強制していない。
- supersede（旧記憶を新記憶で置き換えたと機械的に記録する仕組み）や失効マークの機構は
  **存在しない。**

クローン自身がこの問題を実際に経験した可能性を否定するものではない——経験はリポジトリに
残らない性質のものである。しかし、**「alteroid で検証された結論」として今回の設計の根拠に
据えることはできない。** 以下の決定は alteroid の実地検証結果ではなく、問題設定から演繹した
mnemora 独自の設計判断として書く。

### mnemora の決定: 順序では解かない

「新しい方を上に出す」という順位付けの発想そのものを採らない。理由は単純で、**順位付けは
負荷が上がると崩れるが、フィルタは崩れない。** スコアリングにパラメータを足すたびに、
「新しさ」が他の要因（類似度・強度）に埋もれて後退する余地が生まれる。フィルタ（出す/出さない）
は二値であり、他の要因と競合しない。三つの機構すべてがこの原則——**順序ではなく状態と
隣接性で解く**——の具体化である。

**機構1: `status` を列で持つ。** `active | superseded | contested | archived | forgotten` の
5値。既定の recall は `status = 'active'`（および後述の `contested` の一部）で絞り、
`superseded` を**返さない。** 「下に出す」のではなく「出さない」。

**機構2: 判定できないときは `contested` に落とす。** どちらが正しいか、あるいはどちらが
新しいかを機械的に決められない場合、両者を `superseded` にはしない。`contested` な Memory は
**単独で返してはならない。** 対向する Memory を**スコアに関係なく必ず一緒に取得する**
（mandatory companion retrieval）。予算（文字数・トークン）の都合で対向を載せられない場合は、
その Memory 自体に「争われている」という印を付けて返すか、丸ごと落とす。**争われている主張を、
争われていない顔で出さない。**

**機構3: 隣接を不変条件にする。** 訂正の積み上げで実害が出たのだとしても、その正体は
「古い方が上に出ていた」ことではなく、**「古い方と新しい方が離れていた」**ことである。順位が
入れ替わっていても、両方が隣り合って提示されていれば読み手は矛盾に気づける。⟹ 対向関係にある
Memory は、recall の提示順を通じて**必ず隣接させる**。並び順のどこにも「新しい方だけが単独で
出てくる」状態を作らない。

### スキーマ上の帰結

```sql
status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','superseded','contested','archived','forgotten')),
superseded_by_id   uuid NULL REFERENCES memories(id),
contested_with_id  uuid NULL REFERENCES memories(id),
```

`superseded_by_id` を列として持つ理由は、**グラフ探索ではなく索引で引けるようにするため。**
「この Memory を置き換えたのはどれか」は recall のたびに評価される頻出クエリであり、
関係グラフ（`memory_relations`、Phase 2）を毎回辿るのは高負荷帯では避けたい。列にしておけば
`WHERE superseded_by_id IS NOT NULL` の単純な索引アクセスで済む。

`contested_with_id` は同じ理由で `status` 列・`superseded_by_id` 列の決定を
一対一の対向関係に限って Phase 1 で成立させるための補助列である。関係グラフ本体（多対多の
`contradicts` / `supersedes` 等、`memory_relations` テーブル）は Phase 2 だが、
**`status`・`superseded_by_id`・`contested_with_id` の3列は Phase 1 のスキーマに入れる。**
これは [roadmap.md](./roadmap.md) の Phase 1 範囲の決定（「後付けのマイグレーションにしない」）をそのまま反映している。一対一の
関係で表現できないケース（一つの Memory が複数の Memory と同時に争われている等）は Phase 2 の
`memory_relations` を必要とし、Phase 1 では `contested_with_id` が指す1件を必須の道連れとして
scoping する設計に留める。

---

## 6. 強化 (Reinforcement)

**実際に使われたものだけを強化する。検索に出ただけでは強化しない。** 候補に出たが LLM に
選ばれなかった Memory まで強化してしまうと、「よく検索に出るから強い」→「強いからさらに
検索に出やすい」という自己強化ループが生まれ、実際の有用性と無関係にスコアが積み上がる。
強化のトリガーは「候補になったこと」ではなく「使われたと報告されたこと」でなければならない。

**ここも正直に書く。** alteroid には reinforcement の実装が存在しない。使用回数・最終使用時刻・
スコア更新のいずれも見つからなかった。したがって上記の結論は**運用で検証された結論ではなく、
設計上の判断**である。「alteroid で効果が確認された」とは書けない。

### 冪等な強化

使用報告は `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })` で受ける
（§4 API 表面）。これは at-least-once（同じ報告が複数回届き得る）を前提にする必要がある。
カウンタを直接インクリメントする実装は、再送のたびに二重計上する。そのため mnemora は
インクリメントではなく**挿入の成否**で冪等性を作る。

```sql
CREATE TABLE recall_usages (
  tenant_id  text        NOT NULL,
  recall_id  uuid        NOT NULL REFERENCES recalls(id),
  memory_id  uuid        NOT NULL REFERENCES memories(id),
  used_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, recall_id, memory_id)
);
```

`(recall_id, memory_id)` の組が主キーであり、`tenant_id` を先頭に足しているのは
「全ての一意制約は tenant_id を先頭に置く」（[ADR 0007](./decisions/0007-tenant-scoping.md)）を一貫させるためである（`recall_id` は既に
特定の `recalls` 行に属し、その行は特定のテナントに属するため意味的な重複ではあるが、
索引・制約の形を全テーブルで統一する）。

同じ `(recall_id, memory_id)` の組が二度目に届いた場合、`INSERT ... ON CONFLICT DO NOTHING`
で**挿入自体が弾かれる。** アプリケーション層は「実際に新しい行が挿入されたかどうか」
（`INSERT` の返り行数、または `RETURNING`）を見て、**挿入が実際に起きたときだけ**
`memories.last_reinforced_at` を更新する（**`memories.strength` は動かさない**——
[ADR 0041](./decisions/0041-reinforce-does-not-change-strength.md)）。再送では何も変化しない。
これにより二重計上が構造的に起きない。

強化が起きると `decay_floor_at` を再計算する（§7）。これは「強化された時点で減衰の起点が
動く」というイベント駆動更新の唯一の発生源であり、cron による全件更新を不要にする設計
（§7）の前提そのものである。

---

## 7. 忘却と減衰 (Decay)

### 問題

pgvector の HNSW / IVFFlat 索引は、`ORDER BY` が距離演算子（`<=>` 等）の結果**そのまま**で
昇順のときにしか効かない。`ORDER BY similarity * decay` のように式にした瞬間、その ORDER BY は
索引を使えなくなる。一方で、テーブル全件に対して毎晩 `UPDATE` を回して減衰値を更新するような
cron ジョブは禁じられている（大量データ規模で破綻するため）。

### 決定: 「減衰した値」を保存せず、「閾値を割る時刻」を保存する

- 減衰は純関数 `decay(now, lastReinforcedAt, strength, halfLife)`。**この計算結果はどこにも
  保存しない。**
- 代わりに `decay_floor_at`（この Memory が閾値を下回る時刻）を**書き込み時（作成時・強化時）に
  一度だけ**計算して列に持つ。この値は時間の経過そのものでは変化しない——**単調**である。
  変わるのは強化が起きたときだけであり、これはイベント駆動の更新点であって、定期実行の
  全件走査を必要としない。

```sql
strength         real        NOT NULL DEFAULT 1.0,
half_life_hours  real        NOT NULL,          -- Memory 単位。テナント設定は既定値としてのみ使う
decay_floor_at   timestamptz NOT NULL,           -- 書き込み時に一度だけ計算
```

### 二段検索とデータモデル側の帰結

具体的な二段検索の SQL の形（over-fetch と段2の再スコアリング）は `docs/recall.md` に譲る。
ここではデータモデル側の帰結——**どの列が必要で、いつ書き換わるか**——だけを述べる。

- 段1（索引が効く段）が要求するのは、**等値または単調な範囲比較で表現できるフィルタ**である。
  `tenant_id`・`status`・`decay_floor_at > now()` はすべてこの形に収まる。ベクトルの
  `ORDER BY` はそのまま距離演算子で書ける。
- 段2（索引が要らない段）が要求するのは、段1で絞り込んだ少数件（k × over-fetch 係数）に
  対して減衰・鮮度・強度を掛けて再スコアするための素材である。`decay()` の入力となる
  `last_reinforced_at`・`strength`・`half_life_hours` はこの段でのみ参照される。

### ⚠ 区別を潰さないこと: iterative scan はスコア問題を解かない

pgvector 0.8.0 で導入された iterative index scan（`hnsw.iterative_scan = strict_order |
relaxed_order`）は、**「WHERE フィルタ下での recall（再現率）改善」であって、
「ORDER BY のスコア式が索引を殺す」問題の解決策ではない。** 両者は別の問題であり、
対処も別である。

| 問題 | 対処 |
|---|---|
| フィルタ問題（`tenant_id` / `status` / `decay_floor_at > now()` の下で十分な件数を ANN が返せるか） | iterative scan (`hnsw.iterative_scan`) + `hnsw.ef_search` の調整 |
| スコア問題（減衰・タグ一致・鮮度を掛けた式で並べたい） | over-fetch + 段2の再スコア（索引に頼らない） |

この二つを混同して「iterative scan を有効にすれば `ORDER BY (similarity * decay)` が書ける」
と考えるのは誤りである。

### partial index についての注意

partial index は**離散値・低カーディナリティ**のフィルタに向く（PostgreSQL 公式の推奨）。
`decay_floor_at > now()` のような連続値・高カーディナリティの範囲条件を partial index の
**述語**に使うのは向かない（`now()` は immutable ではなく、固定した時刻を述語にしても
すぐ陳腐化する）。実際に使うのは次の形——**離散値（`status`）を partial 述語にし、
連続値（`decay_floor_at`）は索引の末尾に通常の列として持たせて範囲スキャンする**——である。

```sql
CREATE INDEX idx_memories_recall_gate
  ON memories (tenant_id, status, decay_floor_at)
  WHERE status IN ('active', 'contested');
```

`status IN ('active', 'contested')` が partial 述語（離散・低カーディナリティ、正しい
使い方）であり、`decay_floor_at` は述語ではなく索引の3列目として範囲スキャンに使われる。
この違いを取り違えると「partial index で忘却を解決しようとして効かない」という失敗を
なぞることになる。（述語が `'active'` 単独ではなく `'contested'` も含む理由は §10・
docs/decisions/0011-no-window-count-in-ann-stage.md を参照。）

### リスクと対処

**half_life をテナントごとに後から変えたくなった瞬間、`decay_floor_at` の全件再計算が必要に
なる**——これは [roadmap.md](./roadmap.md) のリスク表で名指ししているリスクである。対処は、`half_life_hours` を
**Memory 単位の列**として持つこと（既に上記 DDL の通り）。`tenant_settings` に持つ
既定値（§9・§10）はあくまで**新規作成時の初期値**として使うだけであり、テナント設定を
変更しても既存の Memory の `half_life_hours` を書き換えない。全件再計算はテナントが
明示的に「既存の記憶にも新しい half-life を適用したい」と要求した場合のみ、低頻度のバッチとして
実行する（Phase 1 の必須機能ではない）。

---

## 8. taxonomy の strict / open

**決定: 二つのモードを二つの経路にしない。「ラベルの状態」一つで表す。**

書き込みは常に自由（open）である。未登録のラベルが付いていても書き込みを失敗させない。
記憶を失うくらいなら受け取る、という判断を taxonomy にもそのまま適用する。ラベルは
`registered | proposed` の状態を持ち、テナントが語彙として登録すると `registered` になる。

**`strict` モードが変えるのは「`proposed` なラベルが検索のフィルタ・加点に参加できるか」
だけである。** strict でも書き込みは通り、`proposed` として記録され、件数が数えられ、
将来 `registered` へ昇格する候補として表に出る。strict と open は同じ機構・同じ経路を通り、
違うのは検索側の真偽値ひとつだけである。

このモデルには専用の「不在の章」を recall.md に立てる必要が無い。strict モードで
`proposed` ラベルがフィルタから外れて記憶が返らなかった場合、それは recall の
`Omission.kind = 'filtered'`（どの条件で落ちたか、を持つ既存の分類）にそのまま乗る——
「taxonomy 用の特別な不在の種類」を新設しなくても、既存の filtered の一種として表現できる。
strict/open を「ラベルの状態」ひとつに単純化した設計上の判断が、recall 側の説明可能性の
語彙を増やさずに済むという形で噛み合っている。

```sql
-- Phase 2
tags text[] NOT NULL DEFAULT '{}'   -- Phase 1: memories 列。open のみ、strict 判定なし
```

```sql
-- Phase 2: labels テーブルが登場して初めて strict/open の区別が意味を持つ
CREATE TABLE labels (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text        NOT NULL,
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('registered','proposed')),
  proposed_count integer     NOT NULL DEFAULT 0,
  registered_at  timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE memory_labels (
  tenant_id text NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id),
  label_id  uuid NOT NULL REFERENCES labels(id),
  PRIMARY KEY (tenant_id, memory_id, label_id)
);
```

Phase 1 は `memories.tags`（`text[]`、常に open な自由記述）のみを持つ。
`labels` / `memory_labels` は Phase 2 で導入し、`tenant_settings.taxonomy_mode`
（後述 §10）が `strict` のテナントでのみ `proposed` 状態が検索へ影響する。既存の `tags` は
`labels` 導入時に `proposed` として移行できる形にしておく。

**⚠ 2026-09 訂正（roadmap.md 段階4/5 の実装 PR）: 「フィルタ・加点に参加しない」という
記述は誤りだった。** この文は「taxonomy の strict/open（`labels` の registered/proposed）
という*ラベル語彙の登録制度*には `tags` はまだ参加しない」ことを言おうとしたものだが、
文面が「`tags` はスコアリングにも一切参加しない」とまで読める形になっており、
実装（`packages/core` の `defaultScoringStrategy`、[./recall.md](./recall.md) §7）および
[./roadmap.md](./roadmap.md) 段階4の完了条件（「vector + tag + freshness のスコアリング」）と
正面から食い違っていた。正しくは次の通りである。

- **`tags` は段2の再スコア（[./recall.md](./recall.md) §2・§7）の加点要素として参加する。**
  クエリタグとの一致数に応じて `ScoreBreakdown.tagMatch` を押し上げるが、
  一致しないことで `total` を 0 に落とすことはない（加点であって除外条件ではない）。
- **`tags` は段1のフィルタには参加しない。** `tags` が無い・一致しないことを理由に
  Memory を候補集合から除外する経路は無い（recall.md §2 のスコープ確定・候補生成の
  いずれにも `tags` によるゲートは無い）。
- **taxonomy の strict/open（`labels` の registered/proposed）という語彙登録制度への参加は
  引き続き Phase 2 である。** `tags` が Phase 1 のスコアリングに参加することと、
  `labels` テーブルによる語彙管理が Phase 2 であることは別の軸であり、混同しない。

---

## 9. 監査ログ

**Phase 1 に入れる。** 理由は単純で、追加費用は1テーブルと1 INSERT 程度である一方、
後から入れると「入れる前に消えたもの」が永久に見えなくなる。監査ログはその性質上、
「無かった期間」を後から埋め合わせられない唯一の機能である。

### alteroid から採る担保の作り方

ここは現物で確認できた設計であり、そのまま真似る価値がある。alteroid の `JournalStore`
インターフェース（`packages/core/src/store.ts:368`）は次の3メソッドしか持たない。

```ts
interface JournalStore {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  list(query?: JournalQuery): Promise<JournalEntry[]>;
  get(id: string): Promise<JournalEntry | null>;
}
```

**`update` も `delete` も型に存在しない。** 型に無ければ、実装がうっかり間違って消す経路が
生えない。削除経路自体は alteroid 内に2箇所（ツール経由・HTTP 経由）あるが、どちらも
「対象を消す処理」と「journal への `append`」を同一処理内で呼んでおり、削除だけが
単独で起きて記録が残らない、という状態を作れない構造になっている。

mnemora の `EventStore` interface（`packages/core` が定義し `packages/postgres` が実装する）も
同じ形にする。**`append` / `list` / `get` のみを持ち、`update` / `delete` を持たせない。**

### スキーマ

```sql
CREATE TABLE memory_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text        NOT NULL,
  memory_id         uuid        NULL REFERENCES memories(id),  -- kind='events_purged' の場合のみ NULL
  kind              text        NOT NULL CHECK (kind IN
                       ('created','updated','superseded','archived','forgotten','purged',
                        'events_purged')),
  at                timestamptz NOT NULL DEFAULT now(),
  actor             jsonb       NOT NULL,   -- { type: 'human'|'system'|'clone', id?: string }
  digest_snapshot   text        NULL,       -- 記録時点の digest。本文(content)は写さない
  size_before_bytes integer     NULL,       -- 削除・置換の直前サイズ
  meta              jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- kind 固有の付帯情報
  CHECK (kind <> 'events_purged' OR memory_id IS NULL)
);

CREATE INDEX idx_memory_events_by_memory ON memory_events (tenant_id, memory_id, at);
CREATE INDEX idx_memory_events_by_kind   ON memory_events (tenant_id, kind, at);
```

記録項目は tenant_id / memory_id / kind / at / actor / digest のスナップショット / 直前の
サイズに限る。**本文（`content`）は残さない。** 監査ログ自体が情報漏洩の経路にならないための
制約である。`kind` の6値（`created / updated / superseded / archived / forgotten / purged`）は
この列挙をそのまま使い、`reinforced` や `contested` のような細分は独立した `kind` を
増やさず `kind = 'updated'` の `meta`（例: `{"reason": "reinforced", "recallId": "..."}`）で
表現する。`kind` の値を増やしすぎると監査ログの分岐がアプリケーションコード側に漏れ出すため、
「状態が実際に変わった大分類」だけを `kind` にし、理由の粒度は `meta` に落とす。

`events_purged` は本書での追加である（理由は次項）。

**「必ず」の強制**: `forget()` は `EventStore` への追記と同一トランザクションで行う。
リポジトリ層を経由しない削除経路（例えば `packages/postgres` から直接 `memories` を
UPDATE するようなショートカット）を作らない。

### 保持方針（alteroid に無く、mnemora に要るもの）

alteroid の日誌は無期限に積む設計であり、保持期間・ローテーション・上限を持たない。
single-tenant・小規模データを前提にすれば成立するが、multi-tenant で桁違いの量を扱う
mnemora ではこの前提が成立しない。

⟹ テナント単位で保持期間を設定可能にする。既定は無期限（`NULL`）。期限切れの
`memory_events` 行を削除する処理そのものが、**`events_purged` イベントとして記録に残る**
（件数と期間のみ。削除された個々のイベントの詳細は残らない）。「消えたことが見える」という
性質を、ログの掃除に対しても一貫させる。この削除処理は `EventStore` interface（アプリケーション
コードが通常使う経路）を経由しない、独立した保守ジョブとして実装する——通常の書き込み経路に
「まとめて削除する」機能を持たせないという、alteroid から採った「型に無ければ生えない」の
考え方を、削除操作自体にも及ぼす。

**実装済み（2026-09-15、Issue #210 / [ADR 0115](./decisions/0115-event-retention-purge.md)）**:
`setEventRetention`（ADR 0050）で保持期間を設定できても、実際に古い行を消すコードが
長らく存在しなかった（Issue #210。「設定できる」と「効く」は別だった）。いま埋まっている口は
`MemoryStore.purgeExpiredEvents?`（任意メソッド。`@mnemora/core` は npm 公開済みのため、
必須にすると第三者 adapter を壊す）——`limit` 必須・`dryRun` 対応・`kind = 'events_purged'`
自身は対象から除外（無限後退を避ける）。`packages/core` の `purgeExpiredEventsForTenant` が
`TenantSettingsStore.getEventRetention` の3状態を読み、有限日数のときだけこれを呼ぶ。
**`tick()`/`observe()` には配線していない**——呼び出すのは運用側のスクリプト・cron の責務であり、
このリポジトリは「呼ぶための部品」だけを提供する。

```sql
CREATE TABLE tenant_settings (
  tenant_id                text        PRIMARY KEY,
  default_half_life_hours  real        NOT NULL DEFAULT 720,   -- 30日。Memory 作成時の既定値
  event_retention_days     integer     NULL,                    -- NULL = 無期限
  taxonomy_mode            text        NOT NULL DEFAULT 'open' CHECK (taxonomy_mode IN ('open','strict')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
```

**`tenant_settings` は [ADR 0007](./decisions/0007-tenant-scoping.md) が禁じる「テナントの台帳」ではない。** mnemora はテナントの識別・
認証・存在確認を行わない——`tenant_id` は呼び出し側が渡す不透明な文字列のままである。
`tenant_settings` に行が無いテナントは、コード中の定数による既定値で動作する。この表は
「その `tenant_id` というテナントが存在する」という真実を保持するものではなく、
既に呼び出し側から渡されている `tenant_id` に対する**任意の運用パラメータ**（保持期間・
既定 half-life・taxonomy モード）を保持するだけであり、無くても mnemora は動く。

### forget() と purge() を分ける

削除には二種類ある。`forget()` = 論理削除（`status` を変える。復元可能）。`purge()` = 物理削除
（法的要求。内容を消す。イベントは残る）。**Phase 1 は `forget()` のみを実装する。`purge()` は
Phase 2 以降だが、`memory_events.kind` の `'purged'` は Phase 1 のスキーマに含める**
（後からマイグレーションで `kind` の CHECK 制約を広げるのは、既存行との整合を壊すリスクが
あるため避ける）。

`purge()` が実行された場合、`memories` 行自体は残す（`memory_events` からの外部キー参照
整合性のため、また `superseded_by_id` / `contested_with_id` の参照先としても残す必要が
あるため）。ただし `content` と `digest` を固定のトゥームストーン文字列で上書きする
（`digest` の NOT NULL 制約は §4 の決定でありここでも維持する。「NULL にする」ではなく
「消えたことを示す値で上書きする」ことで、NOT NULL と物理削除の両立を図る）。

```sql
-- Phase 2
purged_at timestamptz NULL   -- 非NULLなら content/digest はトゥームストーン済み
```

---

## 10. DB schema 案

以降が本書の中心である。テーブルごとに導入 Phase を明記する。**`tenant_id` は全テーブルで
NOT NULL とし、全ての一意制約・索引の先頭列に置く**（[ADR 0007](./decisions/0007-tenant-scoping.md)）。これは mnemora の隔離境界が
アプリケーションコードの慎重さではなく、スキーマの形そのものによって保証されることを
意味する。

### 前提: pgvector のバージョン

- **`>= 0.8.0` を必須**とする。iterative index scan（`hnsw.iterative_scan`）が §7 の
  フィルタ問題対処に必要なため。
- **`>= 0.8.2` を推奨**とする（2026-02-26 リリース。CVE-2026-3172 のバッファオーバーフロー
  修正を含む）。
- **確かめていないこと**: マネージド Postgres 各社（RDS / Cloud SQL / Supabase 等）が
  実際に提供している pgvector のバージョンは確認していない。導入環境ごとに
  `SELECT * FROM pg_available_extensions WHERE name = 'vector';` で確認すること。
- 同様に、PostgreSQL 本体側の下限バージョンと pgvector 0.8 系の組み合わせについても
  網羅的な検証はしていない。`gen_random_uuid()` を拡張なしで使う前提を置いているが
  （PostgreSQL 16 以降で標準搭載）、それより前のバージョンでは `pgcrypto` 拡張が要る。

### `observations`（Phase 1）

```sql
CREATE TABLE observations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text        NOT NULL,
  subject_id   text        NULL,
  external_id  text        NULL,        -- 呼び出し側の冪等キー（テナント内一意）
  kind         text        NOT NULL,    -- 'utterance' | 'event' | 'usage' | 'document' | ...
                                          -- 開いた判別可能ユニオンのため CHECK を付けない
  payload      jsonb       NOT NULL,
  occurred_at  timestamptz NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- observe() の再送は同じ Observation を返す（冪等性）
CREATE UNIQUE INDEX uq_observations_external_id
  ON observations (tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX idx_observations_by_subject ON observations (tenant_id, subject_id, recorded_at);
```

`kind` はあえて `CHECK` 制約を付けない。observe() の入力ユニオンは `...` で開かれており
（§4）、新しい Observation の種類を追加するたびにマイグレーションを要求しない設計にする。
これは `memories.status` や `provenance_kind`（閉じたユニオン、CHECK 制約あり）とは
意図的に扱いを変えている——**開いているものは開いていると分かる形にし、閉じているものは
閉じていると分かる形にする。**

`kind = 'usage'` の Observation（`observe(ctx, { kind: 'memory_usage', ... })`）は抽出器を
通らない。payload の `{ recallId, usedMemoryIds }` を直接読み、`recall_usages` への挿入に
使われる（§6）。他の `kind` は抽出パイプラインを経て `memories` 行を生む。

### `memories`（Phase 1。一部列は Phase 2）

```sql
CREATE TABLE memories (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text        NOT NULL,
  subject_id            text        NULL,

  -- 抽出の起点。stated/inferred は必須、consolidated/reflected/imported は
  -- provenance.sources 側で複数ソースを表すため NULL を許す。
  source_observation_id uuid        NULL REFERENCES observations(id),
  extractor_version     text        NULL,

  content               text        NOT NULL,
  content_hash          text        NOT NULL,
  digest                text        NOT NULL,
  digest_source         text        NOT NULL DEFAULT 'llm' CHECK (digest_source IN ('llm','fallback')),

  provenance_kind        text        NOT NULL
                            CHECK (provenance_kind IN ('stated','inferred','consolidated','reflected','imported')),
  provenance              jsonb       NOT NULL,
  CHECK (provenance_kind NOT IN ('stated','inferred') OR source_observation_id IS NOT NULL),

  status                text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','superseded','contested','archived','forgotten')),
  superseded_by_id      uuid        NULL REFERENCES memories(id),
  contested_with_id     uuid        NULL REFERENCES memories(id),

  tags                  text[]      NOT NULL DEFAULT '{}',

  occurred_at           timestamptz NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  last_reinforced_at    timestamptz NULL,
  valid_from            timestamptz NULL,   -- Phase 2
  valid_until           timestamptz NULL,   -- Phase 2

  strength              real        NOT NULL DEFAULT 1.0,
  half_life_hours       real        NOT NULL,
  decay_floor_at        timestamptz NOT NULL,

  embedding_status       text        NOT NULL DEFAULT 'pending'
                            CHECK (embedding_status IN ('pending','ready','failed','skipped')),

  purged_at              timestamptz NULL,   -- Phase 2

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
```

**索引**（各索引がどのクエリのためかを併記する）:

```sql
-- 抽出の冪等性: 同じ Observation に同じ版の抽出器を再実行しても重複を作らない
-- NULLS NOT DISTINCT は必須（下の「⚠ NULLS NOT DISTINCT が要る理由」を参照）
CREATE UNIQUE INDEX uq_memories_extraction
  ON memories (tenant_id, source_observation_id, extractor_version, content_hash)
  NULLS NOT DISTINCT
  WHERE source_observation_id IS NOT NULL;

-- recall 段1のゲート（§7）: tenant + (active|contested) + decay_floor_at の範囲スキャン
--
-- ⚠ 2026-09 訂正（PR #2、docs/decisions/0011-no-window-count-in-ann-stage.md）:
-- 当初案の述語は WHERE status = 'active' だった。これでは contested な Memory が
-- 段1の候補集合にそもそも入らず、「争われている主張を、争われていない顔で出さない」
-- （mandatory companion retrieval、§5・docs/recall.md §8）が実装として成立しなかった。
-- 述語を 'active' 単独から ('active', 'contested') に広げて修正する。
CREATE INDEX idx_memories_recall_gate
  ON memories (tenant_id, status, decay_floor_at)
  WHERE status IN ('active', 'contested');

-- 置換の解決（§5）: 「この Memory は何に置き換わったか」の単純な索引アクセス
CREATE INDEX idx_memories_superseded_by
  ON memories (tenant_id, superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

-- 係争中の Memory の一括検出・companion 取得（§5）
CREATE INDEX idx_memories_contested
  ON memories (tenant_id, status)
  WHERE status = 'contested';

-- 第3階の群カウント（recall.md の目次帯）: subject 単位の件数集計
CREATE INDEX idx_memories_by_subject
  ON memories (tenant_id, subject_id, status);

-- provenance によるフィルタ（推論を除外する recall オプション）
CREATE INDEX idx_memories_provenance_kind
  ON memories (tenant_id, provenance_kind);

-- Phase 1: open タグの絞り込み。tenant_id を先頭に含めるため btree_gin を要求する。
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX idx_memories_tags
  ON memories USING gin (tenant_id, tags);
```

### ⚠ `NULLS NOT DISTINCT` が要る理由（2026-09 追記。実測で判明した）

本書の原案は `uq_memories_extraction` に `NULLS NOT DISTINCT` を付けていなかった。
**これは誤りである。** Postgres は既定で一意索引の NULL 同士を「異なる値」として扱う。
`extractor_version` は NULL 許容なので、既定のままだと `extractor_version = NULL` の行に対して
**この一意制約が発火しない。**

実測（PostgreSQL 18.6）: 同じ `(tenant_id, source_observation_id, NULL, content_hash)` を
2回挿入すると、`ON CONFLICT ... DO NOTHING` を付けていても**2行できた**
（`extractor_version` に値が入っている場合は正しく1行に収まる）。

⟹ [roadmap.md](./roadmap.md) 段階3 の完了条件「同じ Observation を二重に送っても
Memory が重複して作られない」が、**この経路だけ静かに崩れる。**
`NULLS NOT DISTINCT`（PostgreSQL 15 以降）は NULL を1つの値として扱い、この穴を塞ぐ。

**この誤りが見つからなかった理由も記録しておく。** `packages/testkit` の適合テストは
`extractorVersion` に値が在る場合と `source_observation_id` が NULL の場合は検査していたが、
**「`source_observation_id` は在るが `extractor_version` が NULL」という組み合わせを
検査していなかった。** さらに、インメモリのプレースホルダ実装は JS の文字列キーで
NULL を空文字に潰すため**偶然に**冪等であり、Postgres 実装との食い違いが
適合テストからは見えなかった。**分岐を数えて一本ずつ歯を通す**という規律が、
この種の食い違いを見つける唯一の手段である。

`idx_memories_recall_gate` について: `status IN ('active', 'contested')` は離散・
低カーディナリティの partial 述語として使う（正しい使い方。2値になったが離散性は変わらない）。
`decay_floor_at` は述語ではなく索引の3列目に置き、`WHERE decay_floor_at > now()` を
通常の範囲スキャンとして解決する（§7 で述べた partial index の取り違えを避けるための形）。
**ただし roadmap.md の Phase 1 範囲の整理により、この `decay_floor_at > now()` という
読み取りフィルタ自体は Phase 2 から有効にする。Phase 1 は `decay_floor_at` を書き込む
だけで、段1の読み取りフィルタには使わない。** 索引の3列目としては最初から持たせておく
ことで、Phase 2 で読み取りに使い始める際に索引を作り直す必要が無いようにする
（docs/decisions/0011-no-window-count-in-ann-stage.md に整理を記録）。

### `memory_embeddings_<space>`（Phase 1。テーブルは空間ごとに作る）

**埋め込みは空間（モデル, 次元の組）ごとに別テーブルにする。** 理由は pgvector の仕様上の
制約であり、確認済みの事実である——**pgvector は次元を指定しない `vector` 列を作れるが、
その列には索引を張れない。** 次元を固定した `vector(N)` 列でなければ HNSW / IVFFlat の
索引宣言が通らない。したがって「1つの `memory_embeddings` テーブルに次元の異なる
埋め込みを共存させる」設計は選べない。

⟹ **決定: 埋め込み空間を登録する操作の一部として `memory_embeddings_<space>` テーブルを
作る。** `core` パッケージは次元を知らない（次元はテーブルの DDL に閉じ込められる）。
`<space>` は `(provider, model, dimensions)` から導出したスラグを使う。

```sql
-- 例: OpenAI text-embedding-3-small, 1536次元
CREATE TABLE memory_embeddings_openai_text_embedding_3_small_1536 (
  tenant_id   text        NOT NULL,
  memory_id   uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  embedding   vector(1536) NOT NULL,
  model       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id)
);

-- HNSW 索引。operator class を明示する（cosine 距離を採用する場合）
CREATE INDEX idx_memory_embeddings_openai_1536_hnsw
  ON memory_embeddings_openai_text_embedding_3_small_1536
  USING hnsw (embedding vector_cosine_ops);
```

Phase 1 は**稼働中の空間を1つに限る**。2つ目の空間（例えばモデル移行後の新しい埋め込み）を
追加する操作は、既存テーブルの行を書き換えるマイグレーションにはならない——**新しい
`memory_embeddings_<space2>` テーブルを追加するだけ**で済む形にしておく。移行期間中は
両テーブルが並存し、`memories.embedding_status` がどちらの空間で `ready` かを個別に
追う設計は Phase 2 の課題として残す（Phase 1 は単一空間なのでこの複雑さは出ない）。

**確かめていないこと**: 可変次元の埋め込み列を Drizzle でどう型付けるかは一次情報が
見つからなかった。空間ごとのテーブル分割で回避しているため mnemora の設計には影響しないが、
確認できなかった事実として明記する。

### `memory_relations`（Phase 2）

```sql
CREATE TABLE memory_relations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  from_memory_id  uuid        NOT NULL REFERENCES memories(id),
  to_memory_id    uuid        NOT NULL REFERENCES memories(id),
  kind            text        NOT NULL CHECK (kind IN
                     ('contradicts','supersedes','consolidates_from','derived_from')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_memory_id, to_memory_id, kind)
);

CREATE INDEX idx_memory_relations_from ON memory_relations (tenant_id, from_memory_id, kind);
CREATE INDEX idx_memory_relations_to   ON memory_relations (tenant_id, to_memory_id, kind);
```

Phase 1 で `status` / `superseded_by_id` / `contested_with_id` が担っている一対一の関係を、
Phase 2 では多対多に一般化する。`memories` 側の3列は Phase 2 移行後も残し、
「最も重要な1件」のキャッシュ的な役割として使い続けてよい（索引で引く高速経路として）。

### `memory_events`（Phase 1）

§9 に記載。

### `recalls`（Phase 1）

```sql
CREATE TABLE recalls (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text        NOT NULL,
  subject_id           text        NULL,
  query                jsonb       NOT NULL,             -- 発行された recall クエリ/オプション
  budget               jsonb       NULL,                 -- 申告された予算（§10 の量の計測）
  omitted              jsonb       NOT NULL DEFAULT '[]', -- Omission[] のスナップショット
  usage                jsonb       NOT NULL,              -- RecallUsage のスナップショット
  index_band           jsonb       NOT NULL,              -- 第3階の群カウント（目次帯）
  explain              jsonb       NOT NULL DEFAULT '{}', -- 各段の実行/未実行トレース
  returned_memory_ids  uuid[]      NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recalls_by_subject ON recalls (tenant_id, subject_id, created_at);
```

`recalls` は recall 一回ごとに1行を持つ。これが必要な理由は二つの要求が同じ機構を求めて
いるからである——(a) 「候補に出たが LLM が使わなかった」を後から判定するには recall 自体が
`recallId` を持ち帰れる必要がある（explainability）。(b) 強化（§6）は `recall_usages` を
通じて `recall_id` を参照する。**一つの機構（recall を記録すること）が二つの要求を満たす。**

### `recall_usages`（Phase 1）

§6 に記載。

### `labels` / `memory_labels`（Phase 2）

§8 に記載。

### `outbox`（Phase 1）

```sql
CREATE TABLE outbox (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text        NOT NULL,
  kind          text        NOT NULL,      -- 'extract' | 'embed' | 'consolidate' | 'reflect' | ...
  payload       jsonb       NOT NULL,
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz NULL,
  claimed_by    text        NULL,
  attempts      integer     NOT NULL DEFAULT 0,
  completed_at  timestamptz NULL,
  failed_at     timestamptz NULL,
  last_error    text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ワーカーの claim クエリ: 未着手・未完了のジョブを available_at 昇順で取得
CREATE INDEX idx_outbox_pending
  ON outbox (tenant_id, kind, available_at)
  WHERE completed_at IS NULL AND claimed_at IS NULL;
```

`observe()` のコミットと「抽出ジョブを積む」を同一トランザクションで行うための
transactional outbox（[architecture.md](./architecture.md) §3.4）。DB トランザクションの中から Redis / BullMQ へ直接書くと
at-least-once が壊れるため、まず同じトランザクションで `outbox` へ書き、別の運搬役
（BullMQ ワーカー、または `pg-boss` を使う場合はそのポーリング）が `outbox` を読んで
実際のキューへ渡す。

### `tenant_settings`（Phase 1）

§9 に記載。§9（監査ログの保持方針）と
§7（half-life のテナント既定値）が要求する「テナント設定」を格納する場所として、
本書の裁量で追加した。[ADR 0007](./decisions/0007-tenant-scoping.md) が禁じる「テナントの台帳」（識別・認証の真実源）とは役割が
異なることを §9 で明記した通りである。

### 規約（drizzle-kit と ORDER BY について）

- **ベクトル索引の DDL は手書きのマイグレーションで管理し、`drizzle-kit push` に任せない。**
  drizzle-kit が生成する HNSW の DDL に operator class が欠落する不具合報告があるため
  （drizzle-orm #5792）。`packages/postgres` はマイグレーション実行の口を1つ持つ。
- **`ORDER BY` には距離演算子の結果をそのまま昇順で書く。** `1 - cosineDistance(...)` の
  ような式にしない。Drizzle 公式ガイドの例がこの形（`1 - cosineDistance` を降順）を
  示しているが、これでは HNSW 索引が効かない可能性が指摘されている
  （drizzle-orm-docs #436）。この規約は `testkit` の適合テストで
  `EXPLAIN` を見て索引が実際に使われることを検査する対象にする。

---

## 11. Memory lifecycle

```
                 ┌────────────────────────── (reinforced: last_reinforced_at 更新) ─┐
                 │                                                                  │
observed → extracted → active ─────────────────────────────────────────────────────┘
                          │
                          ├──(置換が機械的に決定できる)──▶ superseded
                          │
                          ├──(判定できない対向を検出)────▶ contested ──(後で解決)──▶ active | superseded
                          │
                          ▼
                       archived  ──(forget() 呼び出し)──▶ forgotten ──(purge() 呼び出し・Phase 2)──▶ purged(*)

(なし) ──consolidate() 呼び出し──▶ active   ※ Observation を経ない。統合元は同時に superseded へ（行5・行12）
(なし) ──reflect() 呼び出し──────▶ active   ※ Observation を経ない。既存の行は一切書き換えない（行13）
```

`(*)` `purged` は `memories.status` の値ではなく、`memory_events.kind = 'purged'` と
`memories.purged_at IS NOT NULL` で表される（§9）。`observed` と `extracted` も
`memories.status` の値ではない——これらはパイプラインの段階を指す名前であり、
`status` 列は Memory が最初に行として存在する時点（`active`）から始まる。

**⚠ 上の図・この注記は、2026-09 追記まで `consolidate()`/`reflect()` の入口を欠いていた**
（Issue #138。ADR 0089・ADR 0091 が現物からそれぞれ確かめて負債として記録していたが、
どちらも「ついでに直さない」（`docs/autonomy.md` §2）を守って表自体は直さなかった）。
`consolidate()`（行12）と `reflect()`（行13）が作る Memory には、**`observed`/`extracted` の
段階自体が無い**——`observe()` を1回も経由せず、最初から `status='active'` の行として
作られる。`source_observation_id`/`extractor_version` は常に `NULL` である（§2・§10 の
`CHECK (provenance_kind NOT IN ('stated','inferred') OR source_observation_id IS NOT NULL)` が、
`consolidated`/`reflected`/`imported` にはこの制約を課していないことに対応する）。**一度 `active`
へ入ってしまえば、それがどの入口（行2・行12・行13）から来たかによらず、行3・行4・行6〜11の
遷移はすべて同じに適用される**——`superseded`/`contested`/`archived`/`forgotten` の判定・
埋め込みジョブ・強化のどれも、由来を区別する分岐を持たない。

| # | 遷移 | トリガー | 同期/非同期 | 書き換わる列 | 残るイベント (`memory_events.kind`) |
|---|---|---|---|---|---|
| 1 | (なし) → observed | `observe()` 呼び出し | 同期 | `observations` へ INSERT | なし（`observations` 自体が追記専用の記録） |
| 2 | observed → extracted → active | 抽出パイプライン実行。`extract: 'sync'` なら `observe()` 内、`'deferred'` なら `outbox` 経由のワーカー | `sync`: 同期 / `deferred`: 非同期（`outbox` 行は `observe()` と同一トランザクションで先に書かれる） | `memories` へ INSERT（`status='active'`、`digest`、`provenance`、`decay_floor_at` を初期計算） | `created` |
| 3 | active → active（embedding 反映） | 埋め込み計算ジョブ。行2・行12・行13のいずれで Memory が作られても同じ `embed` ジョブが積まれる | 非同期（`outbox` 経由。外部 embedding provider 呼び出しをトランザクション内に置かない） | `memory_embeddings_<space>` へ INSERT、`memories.embedding_status` 更新 | なし（列単位の状態変化はログしない。監査ログ量リスクへの対処） |
| 4 | active → active（reinforced） | `observe({kind:'memory_usage', ...})` により `recall_usages` へ新規行が実際に挿入されたとき | 同期（`observe()` と同一トランザクション） | `recall_usages` へ INSERT（新規のみ）、`memories.last_reinforced_at` / `decay_floor_at` 更新（`strength` は動かさない。ADR 0041） | `updated`（`meta.reason='reinforced'`） |
| 5 | active → superseded | 抽出・統合パイプラインが置換を機械的に決定 | 判定ロジック自体は非同期でよいが、書き込み（旧行の `status`/`superseded_by_id` 更新と新 Memory の作成）は1トランザクションで完結させる | `status='superseded'`、`superseded_by_id` | `superseded` |
| 6 | active → contested | 判定できない対向を検出 | 同上 | 両側の `status='contested'`、`contested_with_id` を相互に設定 | `updated`（`meta.reason='contested'`） |
| 7 | contested → active \| superseded | 新しい証拠・人手の訂正・統合により解決 | 判定は非同期でよいが書き込みは1トランザクション | `status` を確定、`contested_with_id` をクリア、（負けた側は）`superseded_by_id` を設定 | `updated` または `superseded` |
| 8 | active/superseded/contested → archived | `decay_floor_at < now()` を検出する低頻度の掃引、または明示的なアーカイブ操作 | 非同期（定期ジョブ。全件走査ではなく `decay_floor_at` の範囲走査） | `status='archived'` | `archived` |
| 9 | 任意 → forgotten | `forget(ctx, target)` 呼び出し | 同期（`EventStore` への追記と同一トランザクション） | `status='forgotten'` | `forgotten` |
| 10 | forgotten → purged（Phase 2） | `purge(ctx, target)` 呼び出し（法的要求） | 同期 | `content`/`digest` をトゥームストーンで上書き、`purged_at` 設定 | `purged` |
| 11 | (memory_events の掃除) | `MemoryStore.purgeExpiredEvents?` の明示呼び出し（任意メソッド。Issue #210 / [ADR 0115](./decisions/0115-event-retention-purge.md)）。定期実行そのものは呼び出し側（運用のスクリプト・cron）の責務——`tick()`/`observe()` には配線しない | 非同期（保守ジョブ。`EventStore` interface は経由しない） | `memory_events` から古い行を DELETE | `events_purged`（件数・期間のみ。削除対象の詳細は残さない） |
| 12 | (なし) → active（統合先の新規作成。Observation を経ない） | `Runtime.consolidate()` 呼び出し（Issue #103、ADR 0089）。統合元 2件以上が確定した後、LLM 呼び出しが成功した場合のみ | 同期（`consolidate()` の呼び出し1回の中で完結し、`tick()` はこの操作を駆動しない）。統合元の supersede（行5）と同一トランザクションで書けるかは adapter 依存——口（`MemoryStore.supersedeWithNewMemories`）が在れば1トランザクション、無ければ2段（ADR 0100） | `memories` へ INSERT（`status='active'`、`provenance.kind='consolidated'`・`sources=<統合元の memoryId>`、`decay_floor_at` を初期計算、`strength=1`）。`source_observation_id`/`extractor_version` は常に `NULL` | `created`（`meta.reason='consolidated'`、`meta.sources=<統合元の memoryId>`） |
| 13 | (なし) → active（内省による新規作成。Observation を経ない） | `Runtime.reflect()` 呼び出し（Issue #104、ADR 0091）。土台 1件以上に対し LLM が `outcome:'reflected'` を返した場合のみ | 同期（`reflect()` の呼び出し1回の中で完結し、`tick()` はこの操作を駆動しない） | `memories` へ INSERT（`status='active'`、`provenance.kind='reflected'`・`sources=<土台の memoryId>`、`decay_floor_at` を初期計算、`strength=1`）。`source_observation_id`/`extractor_version` は常に `NULL`。**既存の行へは一切書き込まない**——行5〜7のどれも発生しない | `created`（`meta.reason='reflected'`、`meta.sources=<土台の memoryId>`） |

**同期/非同期の要点**: `observe()` は常に同期でリターンする（呼び出し側は待たされない）。
「重い処理」——抽出・埋め込み・アーカイブ掃引・監査ログの保持期間掃除——はすべて非同期に
逃がされるが、逃がし方は一様ではない。抽出と埋め込みは `outbox` を経由する
transactional outbox パターン（同一トランザクションでジョブを積んでから、別の運搬役が
実キューへ渡す）。アーカイブ掃引と監査ログ掃除は、`outbox` すら経由しない定期実行の
保守ジョブであり、範囲走査（`decay_floor_at` の範囲、または保持期限）だけを行い全件走査を
しない。`forget()` と `purge()` は例外的に同期処理として扱う——これらは「消えたことが
確実に記録される」という保証が呼び出し側の応答を待ってでも必要な操作だからである。
`consolidate()` と `reflect()`（行12・行13）も呼び出し自体は常に同期でリターンする——
LLM 呼び出しを含め、呼び出し側の1回の `await` の中で完結する。**`tick()` はこの2つを
駆動しない**——Background Cognition の実運用（スケジューラによる自動起動）は Phase 1 の
範囲外であり（`docs/roadmap.md` §1.3）、呼び出し側が明示的に呼んだときだけ動く。

---

## 確かめていないこと（本書内で参照した範囲の一覧）

- npm org `mnemo` の取得可否（本書の範囲外だが横断的に未確認のまま）。
  - **2026-09 追記**: `mnemora` への改名により、この論点は消えた。npm の org `@mnemora` は
    オーナーが作成し、使用できることを確認している（確認したのはオーナーである）。
    [ADR 0014](./decisions/0014-package-name-mnemora.md) を参照。
- マネージド Postgres 各社が実際に提供する pgvector のバージョン。
- 可変次元の埋め込み列を Drizzle でどう型付けるか（空間ごとのテーブル分割で回避）。
- 「訂正の積み上げによる実害 → 置換方針」という因果自体の alteroid での検証（§5）。
  alteroid のコード・ドキュメントに記録は無く、確認できたのは `memory_write` /
  `memory_append` が両方存在し選択が書き手任せであること、supersede 機構が無いことのみ。
- alteroid の reinforcement・decay の実装状況（§6・§7）。いずれも未実装であることは確認したが、
  「実装すれば効く」かどうかは alteroid からは分からない。
