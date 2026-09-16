# ADR 0193: `ann_unreached` を「窓が満杯でも鳴る」形に直す — `ann-truncation.ts` の約束をようやく果たす

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0111 / 0188 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`vitest`/`tsc`/`eslint`/`prettier` 等を
  走らせて確かめた。
- **【受】** — ADR 0011 / ADR 0111 が別の作業で実測した数字を、そのまま引用した
  （再測していない）。

---

## 結論（先に）

`packages/core/src/ann-truncation.ts` の doc コメントは、逐語でこう約束していた:

> ただし `sim_k'` は**索引が返した** k' 番目であって**真の** k' 番目ではない——
> 近似索引が scope の他の場所へ行っていた場合、上界は破れる。その事象は本判定の対象ではなく
> `ann_unreached`（ADR 0025 / 0026）が別に扱う。**塞げていない範囲を塞いだことにしない。**

ところが `ann_unreached`（[ADR 0026](./0026-ann-unreached-omission.md)）の発火条件は
`candidateGenerationExecuted && kPrime > 0 && annHits.length < kPrime && annHits.length < eligible`
であり、3つ目の条件 `annHits.length < kPrime`（**窓が埋まっていない**）が付いていた。
**この判定（`decideAnnTruncation`）が実際に動くのは窓が満杯（`annHits.length >= kPrime`）の
ときだけ**なので、`ann_unreached` の旧条件は**まさに `ann_truncated` の判定が動く場合を
除外していた**。⟹ 上に引用した一文が「別に扱う」と名指ししていた事象（窓が満杯なのに
近似索引が scope の他所へ行っていた場合）は、`ann_unreached` の条件式自身によって
**一度も鳴りようがなかった**。**約束が破れていた——文書は「担当する」と言い、実装は
その事象を担当できない形をしていた。**

**この ADR の決定は、`annHits.length < kPrime` を条件から落とし、窓の満杯/未満を問わず
`annHits.length < eligible` だけで判定するよう実装を直すことである。** 案（b）「文書の一文を
削る（約束を引っ込める）」は採らなかった——理由は §4。

**⟹ この変更のあと、`ann_truncated` と `ann_unreached` は同時に立ちうる**（旧: 排反）。
これは新しい重複ではなく、2つの札がもともと別の問いに答えていたことが露出しただけである
（§5）。

**⚠ この決定には、正面から答えていない引き受けた負債が1つある。** 本番既定の
`kPrime = 40` に対し、scope の候補（`eligible`）がそれを超えるテナントでは、
`ann_unreached` が実質すべての `recall()` で鳴るようになる。**これは「問題ない」と
断定できる話ではない**（§8）。

---

## 1. 何が起きていたか（文書の約束が破れていた）

### 1.1 `ann-truncation.ts` の約束

`decideAnnTruncation`（`ann_truncated` の判定本体）は、窓（`annHits`、`kPrime` 件まで
埋まる）に載った候補の `sim_k'`（窓の最後の類似度）を使って、「窓の外に scope の
真の上位 k' 件が残っていないか」の上界を計算する。その doc コメントは、この上界が
機能する前提として「`sim_k'` は近似索引が返した k' 番目であり、**近似索引が実際に
scope 全体をきちんと辿っていること**を暗黙に仮定している」と述べたうえで、
**その仮定が破れる場合（近似索引が scope の他所へ行ってしまった場合）は
`ann_truncated` の対象外であり、`ann_unreached` が別に扱う**、と名指しで約束していた。

### 1.2 `ann_unreached` の旧条件がその約束を裏切っていた

`recall-runtime.ts` の `ann_unreached` の旧条件（【現物】、この PR の直前の `main`
= `2097a72`）:

```ts
candidateGenerationExecuted &&
  kPrime > 0 &&
  // k' に達していない。達していれば ann_truncated の領域であり、これと同時には立てない
  annHits.length < kPrime &&
  // scope 内にまだ見られていない候補が残っている。
  annHits.length < eligible
```

`annHits.length < kPrime` は「窓が埋まっていなければ `ann_truncated` の領域ではないので、
`ann_unreached` が代わりに鳴ってよい」という設計だった。**しかしこの前提こそが、
`ann-truncation.ts` の doc コメントが否定している事象と重なっていた**——`decideAnnTruncation`
が実際に判定を行う（＝呼ばれて何かを返しうる）のは `annHits.length >= kPrime`
（窓が満杯）のときだけである。つまり:

- **窓が満杯**（`ann_truncated` の領域） ⟹ 旧条件は `annHits.length < kPrime` で
  `ann_unreached` を**必ず**落とす。
- **窓が未満**（`ann_truncated` の対象外の領域） ⟹ `ann_unreached` が鳴りうる。

**窓が満杯かつ近似索引が scope の他所へ行ってしまった場合**（`ann-truncation.ts` の
doc コメントが「`ann_unreached` が別に扱う」と名指ししていた、まさにその場合）は、
**上の2つのどちらにも当てはまらない無音の穴**だった——`ann_truncated` 側は
`safetyRatio`（`sim_k'` 基準の計算）が偶然 1 以上になれば黙って omission を積まない
（`AnnTruncationCertainty` の doc コメントの通り「証明できたので立てない」場合は
そもそも積まれない）し、`ann_unreached` 側は `annHits.length < kPrime` で機械的に除外される。
**両方が沈黙しうる。**

### 1.3 直した条件

```ts
candidateGenerationExecuted &&
  kPrime > 0 &&
  // scope 内にまだ見られていない候補が残っている。窓が満杯でも
  // annHits.length >= eligible（scope の候補を全部拾いきった）なら鳴らない。
  annHits.length < eligible
```

`annHits.length < kPrime` を落とした。**「鳴ってはいけない側」を守るのは
`annHits.length < eligible` だけになった**——候補が scope に3件しか無くて3件とも
ANN が返した場合（`kPrime=40`、`hits=3`）、`3 < 40` は成立するが `3 == eligible`
なので鳴らない。この歯は元から在った（ADR 0026 の歯B）ので変えていない。

---

## 2. 北極星の5つの問いに当てた結果

| 問い | この判断にどう当たったか |
|---|---|
| **1**（量を減らす方向か） | `omitted` に数十バイトの札が増えるだけで、`memories` の量は変わらない。ただし §8 の通り、この札が常時出るテナントでは呼び手にとっての情報量は薄まる——「減らす」問いには中立、「読む側の信号対雑音比」には負の面がある。 |
| **2**（無効にしても成立するか） | 該当しない——`ann_unreached` は`candidateGenerationExecuted` が真の通常経路でしか関与せず、この判断はオプトインの機構を増減させない。 |
| **3**（選ばれた理由を後から説明できるか） | **これが本題**。窓が満杯でも近似索引が scope を拾いきれていない場合があるという事実を、いままで一度も説明できていなかった。直した後は説明できる——ただし §8 の通り「常時説明する」ことの意味が薄れるリスクを負う。 |
| **4**（推論と事実を区別しているか） | 該当しない——この判断は件数の出所（ANN が返した窓と scope の候補数の比較）の話であり、provenance に触れない。 |
| **5**（LLM を呼ばずに済ませられないか） | 既存の比較演算の条件を1つ落としただけ。DB 往復も LLM 呼び出しも増えない。 |

### `docs/north-star.md`「目指す姿」6番目との対応

逐語（[docs/north-star.md](../north-star.md)）:

> **知らないことを、知らないと言える。**——「見つからなかった」と「探していない」を、
> 同じ顔で返さない。

旧条件の下では、**窓が満杯かつ近似索引が scope の他所へ行った場合**、呼び手には
「scope に候補が無かった（＝見つからなかった、それが全部）」と「近似索引が探しきれて
いない（＝探していない領域が残っている）」が**同じ無音**として返っていた。
`omitted` に何も積まれない、という一点において両者は区別不能だった。この ADR は
まさにこの区別を、窓が満杯の場合にも届かせる。**§8 で述べる通り、この直しは
「常に知らないと言う」側へ振れすぎるリスクを負っている**——項目6は「同じ顔で
返さない」ことを求めているが、「毎回別の顔（ann_unreached 付き）で返す」ことが
「区別できている」と同義かどうかは、この ADR だけでは決着しない（§8）。

---

## 3. 本番既定の数値 — `kPrime == ef_search`、探索の余裕はゼロ

【現物】:

- `DEFAULT_RECALL_LIMIT = 10`（`packages/core/src/recall.ts`）
- `DEFAULT_OVER_FETCH_FACTOR = 4`（`packages/core/src/recall.ts`）
- `kPrime = Math.max(1, Math.round(limit * overFetchFactor))`（`recall-runtime.ts`）
  ⟹ **既定 `kPrime = 40`**
- **非テストコードは `hnsw.ef_search` を一度も `SET` しない**。【現物】
  `grep -rln "ef_search" --include=*.ts --include=*.sql .` が返すのは
  `packages/core/src/recall-runtime.ts`（コメントのみ）・
  `packages/postgres/src/__tests__/hnsw-ef-search-window-ceiling.test.ts`・
  `packages/postgres/src/__tests__/count-over-window.test.ts`・
  `packages/testkit/src/memory-store-conformance.ts`（適合テスト側）の4箇所だけで、
  本番経路（`PostgresVectorStore.search`）は一度も `SET` していない。

**⟹ `hnsw.ef_search` は pgvector の既定値（40）のまま動く。**
`packages/postgres/src/__tests__/hnsw-ef-search-window-ceiling.test.ts` はこの一致
（`kPrime <= hnsw.ef_search 既定値`）を機械的に固定している歯であり、[ADR 0111](./0111-hnsw-window-shrinks-with-tenant-scale.md)
「検査1」がその実測の出所である。

【受、ADR 0011 / ADR 0111】この2つの ADR が既に実測している通り:

- HNSW の索引スキャンが選ばれる経路では、`ef_search` 件までしか下流に行を渡さない
  （ADR 0011。PostgreSQL 18.6 実測）。
- `tenant_id` で絞る mnemora の実際のクエリ形では、**本番規模（数十〜数百行/テナント）
  では既定のプランナは HNSW を避け、Seq Scan または Bitmap Index Scan + Sort を選ぶ**
  （ADR 0011 分岐B、ADR 0111 段A が PostgreSQL 17.11 で再現）——この領域では
  ANN 段は事実上厳密検索であり、`kPrime` 件の中身は scope の真の上位である。
- **ただし同一テナントが約10万行に育つと、プランナは GUC 無しで自然に HNSW を選ぶ**
  （ADR 0111 段B2）。そのとき ANN 段の窓は実測 **14件**へ縮んだ
  （`LIMIT 40` を要求しても14行しか返らない、`EXPLAIN` に `Rows Removed by Filter: 52`）。
  **この領域で効くのは「順序が壊れる」ではなく「候補が窓に入らない」——まさに
  `ann_unreached` が扱う事象そのもの**である。

**⟹ `kPrime == ef_search == 40` は「余裕を持って over-fetch している」という体裁だが、
実際には pgvector 側の探索窓の天井と同じ値であり、探索の余裕はゼロである。**
テナントが小さいうちは ANN 段が厳密検索に近い経路へ落ちるため実害は薄いが、
テナントが育つと窓が実測14件まで縮む領域が既に実測されている——ANN 段が
scope を拾いきれない状況は、仮説ではなく実測済みの現象である。

---

## 4. なぜ「文書の一文を削る」側を採らなかったか

`ann-truncation.ts` の一文（「その事象は `ann_unreached` が別に扱う」）を削って、
`ann_truncated` の doc コメントから「別の判定に委ねる」という約束そのものを
引っ込める案（b）も検討した。**却下した。**

1. **(b) は ADR 0008「無いには種類がある」の後退になる。** 「窓が満杯だが近似索引が
   scope の他所へ行った」という事象は、`ann_truncated` の証明が前提としている
   「窓の中身が scope の真の上位 k' 件である」を壊す固有の事象であり、既存のどの
   `Omission` の種類にも属さない。文書からこの一文を削っても事象自体は消えない
   ——ただ「知らないふりをする」に戻るだけである。
2. **(a) は実装 1箇所の条件を落とすだけで済んだ。** `ann_truncated` と `ann_unreached`
   の設計はもともとこの事象を `ann_unreached` に割り当てる形をしていた——旧条件の
   `annHits.length < kPrime` は「窓が満杯なら安全」という誤った前提の産物であって、
   設計の意図そのものではない。**バグなのは実装のほう**（`AGENTS.md`「正典と実装が
   食い違ったら」）。
3. **AGENTS.md の原則**が、実装の都合で文書（正典・doc コメント）を書き換えることを
   禁じている。`ann-truncation.ts` の一文は、実装がその通りに動いていないという
   バグの証拠であって、書き直すべき誤りではなかった。

---

## 5. `ann_truncated` と `ann_unreached` が同時に立ちうるようになった

### 5.1 ADR 0026 当時の判断は書き換えず、追記で更新した

[ADR 0026](./0026-ann-unreached-omission.md) は「2つは同時には立たない
——`ann_truncated` の条件（hits ≥ k'）と `ann_unreached` の条件（hits < k'）は
排反である」と決定していた。**その決定は、当時の実測・当時の設計としては正しく
記録されている。この ADR はその記述を書き換えていない。** 代わりに ADR 0026 の
末尾に「追記（2026-09-17）」の節を足し、この ADR 0193 が何を・なぜ覆したかを
そこから指す形にした（`docs/decisions/0026-ann-unreached-omission.md` 参照）。
`docs/recall.md` の同じ記述も同様に、旧文をその場で書き換えるのではなく
「🔴 2つは同時に立ちうる（2026-09-17 訂正）」という節を足し、旧記述が何を
主張していたかを引用したうえで訂正した。

### 5.2 なぜ同時に立っても顔が潰れないのか

2つの札は別の問いに答えている:

- **`ann_truncated`**（[ADR 0069](./0069-ann-truncated-says-nothing-about-loss.md)）:
  「窓の中身（`annHits`）が scope の真の上位 k' 件である」という前提のもとで、
  「窓の外は k 位を抜けないと証明できるか」に答える。`certainty: 'loss_possible'`
  （証明できなかった＝損しうる）または `'undecidable'`（判定自体ができなかった）
  のどちらかで積まれる——**`ann_truncated` が `omitted` に現れている時点で、
  それは「安全だと証明できた」を一度も意味しない**（ADR 0069 の
  `AnnTruncationCertainty` の doc コメント: 「証明できたので立てない」場合は
  そもそも積まれない）。
- **`ann_unreached`**: 上の前提そのもの（窓の中身が scope の真の上位 k' 件で
  あること）が成り立っているかに答える。`annHits.length < eligible` は
  「scope 内にまだ見られていない候補が残っている」という**前提の破れ**を直接
  検出する。

**⟹ `ann_truncated` が現れているとき、それは常に「不確実」を意味しており、
`ann_unreached` が同時に現れても矛盾しない**——両方とも「窓の中身を鵜呑みに
できない」という同じ方向の警告を、別の角度から出しているに過ぎない。

### 5.3 ⚠ それでも正直に書く: 見た目が「矛盾」に見える組み合わせが残っている

**`ann_truncated` が `omitted` に現れていない**（＝証明が通った、または
`certainty` を計算する前提自体が満たせず判定に入らなかった）状態で、
**`ann_unreached` だけが現れる**組み合わせは、この ADR の前後を問わず起こりうる。
これは新しい重複ではない——`ann-truncation.ts` の doc コメントがもともと
「`sim_k'` は索引が返した k' 番目であって真の k' 番目ではない」と書いている通り、
`ann_truncated` の証明（`safetyRatio` の計算）は**窓の中身が正しい**という
前提の上に成り立っており、その前提が破れているかどうかは `ann_truncated`
自身の計算範囲の外にある。**「窓の中身に基づく証明が通った」ことと
「窓の中身が scope の候補を拾いきっている」ことは別の主張であり、
前者が成立していても後者が成立するとは限らない。**

**読む側がこれを見て「損が無いと証明されたはずなのに、なぜ同時に不確実性の札が
立つのか」と誤読しうる。** この誤読を防ぐ手当て（例えば `ann_truncated` が
不在のときに限り `ann_unreached` の文言を強めるといった作り込み）は、この ADR
では行っていない——引き受けた負債として §8 にまとめる。

---

## 6. 決めたこと（実装）

1. `recall-runtime.ts` の `ann_unreached` 発火条件から `annHits.length < kPrime`
   を削除し、`candidateGenerationExecuted && kPrime > 0 && annHits.length < eligible`
   に変更する。
2. `recall.ts` の `AnnUnreachedOmission` の doc コメントを、`ann_truncated` との
   関係が「相乗り禁止（排反）」から「別の問いに答える（同時に立ちうる）」に
   変わったことが分かるように書き直す。**`countKind` は `'unknown'` のまま
   変えない**——件数を数えられない事情（ANN が触れなかった候補の分布が原理的に
   分からない）はこの変更で変わらない。
3. `ann-truncation.ts` の doc コメントに、この ADR を指す訂正注記を足す
   （元の一文はそのまま残し、「この一文はこの ADR より前は嘘だった」と明示する）。
4. `docs/decisions/0026-ann-unreached-omission.md` に追記節を足す（§5.1）。
5. `docs/recall.md` の「同時には立たない」の記述を訂正節で上書きする（§5.1）。
6. `packages/core/src/__tests__/recall-pipeline.test.ts` の歯Cを
   「同時に鳴る」ことを確認する歯に直し、新たに歯D（窓が満杯でも scope を
   拾いきっていれば鳴らない、ADR 0026 の歯Bの窓満杯版）を足す。
7. `packages/core/src/__tests__/omission-kind-generation.test.ts` の
   `producedAt` の記述を新条件に合わせて直す。

---

## 7. 採らなかった案

1. **`ann_unreached` に `certainty`（`ann_truncated` の `AnnTruncationCertainty` に
   倣う）を足し、「窓が満杯」と「窓が未満」を呼び手が区別できるようにする案。**
   却下——`ann_unreached` の主張（scope にまだ見られていない候補が残っている）は
   窓の満杯/未満によって変わらない。区別を増やすと、呼び手の次の一手
   （厳密検索へのフォールバック、subject を絞り直す）も変わらないのに
   union だけが太る。ADR 0173 / ADR 0188 が採った「次の一手が変わらない区別は
   増やさない」という基準に合わせた。
2. **`eligible > kPrime` のときだけ `ann_unreached` を別の重み・別のフィールド
   （例えば `severity`）で表す案。** 却下（この PR の範囲では）——§8 で
   「引き受けた負債」として明示する通り、この懸念自体は正当だが、
   どう表すべきかの設計判断はオーナー判断を要する。この ADR は
   「約束を実装に合わせる」というバグ修正の範囲に留め、新しい表現の設計は
   別の判断に委ねる。
3. **`ann-truncation.ts` の一文を削り、文書の約束を引っ込める。** 却下（§4）。
4. **`kPrime`（`DEFAULT_OVER_FETCH_FACTOR`）自体を上げて `ef_search` との
   ギャップを作る案。** 却下（この PR の範囲では）——ADR 0111「検査1」の歯が
   `kPrime <= hnsw.ef_search 既定値` を固定して守っている通り、`kPrime` を
   上げるなら `hnsw.ef_search` も同じ変更の中で上げ、ADR 0111 の測定を
   引き直す必要がある。この ADR は `ann_unreached` の発火条件のバグを
   直すだけのものであり、本番の探索パラメータ自体の見直しは範囲外。

---

## 8. 誰が壊れうるか / 引き受けた負債

**⛔ 以下は「問題ない」と断定しない。正直に負債として書く。**

1. 🔴 **`eligible` が `kPrime`（既定40）を超える scope を持つテナント・クエリでは、
   `ann_unreached` が実質すべての `recall()` で鳴るようになる。** `eligible` が
   常に40を超えるなら `annHits.length <= kPrime = 40 < eligible` は構造的に
   常に真であり、`ann_unreached` は「毎回言う定型文」になる。**これは意図した
   設計目標ではない**——ADR 0026 が「鳴ってはいけない側を守る」歯（歯B）を
   わざわざ用意していたことからも分かる通り、`ann_unreached` は「時々鳴って
   意味を持つ札」として設計されていた。この ADR の変更は、その設計意図を
   壊さずに「窓が満杯の場合」という穴を塞いだつもりだが、**塞いだ結果、
   scope が大きいテナントでは事実上「常時オン」になる**、という副作用を
   引き起こす。
2. **「正直ではあるが、常時鳴る札は情報量が乏しい」という批判は成立する。**
   北極星「知らないことを、知らないと言える」（項目6）は「同じ顔で返さない」
   ことを求めているが、**毎回同じ顔（`ann_unreached` 付き）で返ることもまた
   一種の「同じ顔」であり**、呼び手が `omitted` を見て「今回は取りこぼしの
   疑いが強い」のか「いつも付いているだけ」なのかを区別できなくなるリスクを
   負う。`countKind: 'unknown'` で件数すら出ないため、呼び手側でこの札を
   フィルタする手がかりも無い。
3. **§5.3 の「見た目の矛盾」**——`ann_truncated` が不在（証明が通った）でも
   `ann_unreached` が単独で立つ組み合わせは、読み手に「損が無いはずなのに
   なぜ警告が出るのか」と誤読させうる。この ADR はその誤読を防ぐ作り込み
   （文言の強弱・相互参照の自動生成等）を行っていない。
4. **`omitted` の出力量が増えることの費用**: 【現物、Explore agent の調査】
   `packages/core/src/recall-footprint.ts` は `omitted`/`ann_unreached`/
   `ann_truncated` のいずれも参照していない（grep 0件）——見積もりの入力は
   会話ログの文字数とスコープ内 Memory 件数のみであり、**この変更で
   `recall-footprint` の較正が数値として狂うことは無い**。`examples/chat` 側も
   `omitted` はコンソール表示・`compare.ts` の品質表・JSON artifact にのみ
   使われ、`buildMnemoraPrompt()`（プロンプト本体）にも ⭐門の判定
   （`computeRegressions()`）にも混入しない（§9「確かめたこと」参照）。
   **⟹ 費用は計算資源やプロンプト長ではなく、`omitted` 配列を読む人間・
   監視系にとっての「信号対雑音比の劣化」である。** 例えば `omitted` の
   非空を単純にアラート条件にしている呼び出し側があれば、この変更で
   アラートが常時発火する側へ倒れる。

**これらの負債は、この ADR の作業の中では解消していない。** 実装を追加で
変えるべきかどうか（例えば §7 の案2・「常時鳴るなら別の表現に倒す」）は、
この ADR の担い手の判断ではなくオーナー判断に委ねる。

---

## これが覆るとしたら

1. **オーナーが「常時鳴る札は情報量が乏しい」という §8 の批判を優先すると
   判断したとき。** その場合、案の候補は（a）`ann_unreached` に severity/
   certainty を足して呼び手が濾せるようにする、（b）`eligible` が
   `kPrime` を常に超えるテナントに対しては `kPrime` 自体を引き上げる
   （ADR 0111 の測定を伴って `hnsw.ef_search` も一緒に上げる）、
   （c）この札を `recall-footprint` や `examples/chat` 側の要約から
   間引く、のいずれか。**この ADR はどれも選んでいない。**
2. **本番テナントの scope 分布の実測**（§8-1 の「常時鳴る」が実際にどの程度の
   割合で起きるか）が取れたとき。この ADR の作業では実測していない
   （§10「確かめていないこと」）。ADR 0111 の `identifier-probes` テナントは
   84〜120行と小さく、`eligible` が40を超える現実のクエリがどれだけあるかは
   未知数のままである。
3. **`ann_truncated` と `ann_unreached` の同時発火が、実際に呼び手を混乱させた
   という報告が来たとき**（§5.3）——その場合、文言の書き分けや相互参照の
   自動生成を足す変更が要る。

---

## 9. 測ったこと

- 【実測】`pnpm run typecheck`（7ワークスペース）: 緑。
- 【実測】`pnpm run lint`（eslint）: 緑、警告0。
- 【実測】`pnpm run format:check`（prettier）: 緑。
- 【実測】`pnpm run build`（`rm -rf packages/*/dist` してから、7パッケージ）: 緑。
  `examples/chat` に `build` スクリプトは無い（`tsx` で直接実行する構成のため）。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-pipeline.test.ts src/__tests__/omission-kind-generation.test.ts`:
  2ファイル・89件すべて緑。
- 【実測】変異試験（`git checkout` は使わず、`cp` で退避・復元）。
  `/tmp/recall-runtime.ts.orig` に退避したうえで3種の変異を入れ、狙った歯だけが
  赤くなることと、復元後に同じ歯が緑に戻ることを確認した。
  1. **変異1**（旧条件を復元）: `annHits.length < eligible` の前に
     `annHits.length < kPrime &&` を足し戻した（この ADR が削除した条件そのもの）。
     ⟹ 歯C（「窓が満杯でも同時に鳴る」）が赤くなった
     （`expected false to be true`、`ann_unreached` が期待通り鳴らなくなった）。
     他の歯への波及は見ていない（`-t "歯C"` で絞ったため）。
  2. **変異2**（ガードを外し常時鳴る側に倒す）: `annHits.length < eligible` を
     `true && annHits.length && true` に置換（`annHits.length > 0` である限り
     常に真になる、「鳴ってはいけない側」を壊す変異）。⟹ 歯B（ADR 0026 既存、
     「候補を全部拾えたら鳴らない」）と歯D（この ADR が追加、窓満杯版の歯B）が
     両方赤くなった（`expected true to be false`）。
  3. 各変異後、`cp /tmp/recall-runtime.ts.orig packages/core/src/recall-runtime.ts`
     で復元し、`diff` で1バイトも残っていないことを確認したうえで、対象の歯が
     緑に戻ることを実測した（3回とも復元後に該当テストを再実行し、緑を確認）。
- 【現物、Explore agent 委譲の調査】`examples/chat` の `omitted` の使われ方を
  読んだ——プロンプト本体を組み立てる唯一の関数 `buildMnemoraPrompt()`
  （`examples/chat/src/mnemora-path.ts`）は `recall.memories` の digest 群と
  目次帯（`totalInScope`/`memories.length`）だけを連結しており、`omitted` を
  一切参照しない。`ann_unreached` は `compare.ts` の `formatOmittedSummary()`
  が固定文字列 `"ann_unreached"`（件数なし）として Job Summary 用の品質表に
  出すだけで、⭐門の判定関数 `scripts/compare-summary-lib.mjs` の
  `computeRegressions()` は `mnemoraShareOfNaiveChars`/`factStatementSurvived`
  の2値しか見ておらず `omitted` を参照しない。`packages/core/src/recall-footprint.ts`
  も `omitted`/`ann_unreached`/`ann_truncated` のいずれも grep 0件——見積もりへの
  影響経路は無い。**⟹ ⭐門・`recall-footprint` の較正がこの変更で数値として
  動く経路は、静的に読む限り無い。** ただし実際に `compare` を走らせての実測は
  していない（§10）。
- 【実測】**⭐門の実際の CI 結果**: PR #399 の CI（`examples/chat (本物の Postgres +
  pgvector、擬似 provider)` ジョブ）で「北極星の物差しが基準値から悪化していないか
  を判定する（⭐ 門。ADR 0133）」ステップが `success` で通った。`examples/chat/compare-baseline.json`
  は一切変更していない。⟹ 上の「読み」（⭐門は動かない）は実際の CI 結果でも裏付けられた。
- 【実測】**採番の衝突が実際に起きた。** 本 ADR は当初 `0192` として書いたが、
  PR #398（`fix(scripts): ADR 索引の鮮度を CI の pull_request でも強制する`）が
  `main` へ先に着地し、同じ `0192` を使っていた。`git fetch origin main && git merge
  origin/main` の後、`node scripts/adr-renumber.mjs` を実行したところ衝突を検出し、
  本ファイルを自動で `0193` へ付け替え、参照していた8ファイルすべてを書き換えた
  （`docs/decisions/0026-...md`・`docs/recall.md`・`ann-truncation.ts`・`recall.ts`・
  `recall-runtime.ts`・テスト2本・本ファイル自身）。付け替え後、`grep -rn "0192"` で
  本 PR が触ったファイルに旧番号の残骸が無いことを確認した。この衝突自体が、
  `docs/decisions/README.md`（ADR 索引）を「マージ直前に再生成する」規律
  （ADR 0137）と、それを CI の `pull_request` でも強制する仕組み（PR #398 / ADR 0192）
  が、まさに今この PR で機能した実例である。

## 10. 確かめていないこと

- **本番規模での `eligible` の分布**——`eligible` が `kPrime`(40) を実際に
  超えるクエリが、実運用でどれだけの割合を占めるかは測っていない。
  ADR 0111 が実測した `identifier-probes` テナント（84〜120行）はいずれも
  40を下回り、この変更後も `ann_unreached` は（scope 全体を対象にする
  クエリなら）鳴らない側に留まる可能性が高いが、これは実測ではなく
  ADR 0111 の別目的の測定からの外挿である。
- **§8-3 の「見た目の矛盾」が実際に呼び手を混乱させるかどうか**——読み手側の
  受け止め方は測定していない。
- **`examples/chat` の `compare`（⭐門）が実際に動くかどうかの CI 実測**——
  §8-4 の読みはコードを読んだ結果であり、CI の実際の結果は PR 本文に転記する。
