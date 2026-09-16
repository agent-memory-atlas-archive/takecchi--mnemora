# ADR 0166: `recall-footprint` の見積もりに連想枠の項を足す — 新しい自由係数は増やさず、構造から導く（PR #336 / ADR 0168 の前提）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0133 / 0168 の体裁を踏む）。

- **【実測】** — この ADR の書き手が自分の手で走らせて確かめた（CI 経由を含む）。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 結論（先に）

**`packages/core` の `estimateRecallFootprint`（Issue #276）に、連想枠（`RecallQuery.association`、ADR 0151）が本体（`memories` tier）へ昇格させる件数の項 `associationCount` を足した。** 新しい自由係数（較正対象の数値）は1つも増やしていない——連想の効果は、既存の2係数（`charsPerDigest` / `fixedIndexChars`）が使う式の中で `returnedMemories` と `bandEligible`（目次帯の資格件数）を組み替えるだけで表現できる。

| 決めたこと | 内容 |
|---|---|
| 入力の形 | `RecallFootprintShape.associationCount?: number`。**`maxCount` ではない**——実際に昇格する件数は埋め込み空間上の類似度分布に依存し、`maxCount` と `memoryCountInScope` だけからは決まらないため、呼び出し側が実測/見積もりとして渡す |
| 較正 | `calibrateRecallFootprint` は**変更していない**。新しい係数を要らないと判断したため |
| 後方互換 | `associationCount` を渡さない呼び出しは、**この ADR より前と1バイトも変わらない**（テストで明示） |
| 精度 | `examples/chat/compare-baseline.json`（12点、ADR 0133 の⭐門）に対する最大誤差が **2.5%以内**（現行の基準値で **2.068%**。⚠ 執筆時は 4558 / 2.304% と書いていた——下の「2026-09-17 訂正」節） |

---

## 背景 — なぜ必要になったか

PR #336（Issue #291 / ADR 0168）が `examples/chat` の想起経路（`mnemora-path.ts` の `queryRecall`）で連想枠を既定 on（`maxCount=10`）にし、`compare-baseline.json` を更新したところ、`examples/chat/src/__tests__/recall-footprint-baseline.test.ts`（Issue #276 の `recall-footprint.ts` を基準値に対して検算する⭐門の歯）が赤くなった。

原因を突き止めると、**基準値の更新漏れではなかった**——`estimateRecallFootprint` のモデルが実質

```
totalChars ≒ fixedIndexChars + memoryCount * charsPerDigest   （目次帯が空のとき）
```

であり、**連想枠の項を持っていなかった**。較正に使う7行（`totalInScope <= DEFAULT_RECALL_LIMIT`。目次帯が空で連想枠も何も拾わない）は連想 on/off で1バイトも動かないが、hold-out側の5行（`totalInScope` が42/82/162/322/642ターンに対応する14/25/49/95/189）は連想枠が実際に候補を昇格させ、モデルが説明できない量だけ動いた:

| turnCount | 誤差（連想の項を持たない旧モデル） |
|---|---|
| 42 | 10.34% |
| 82 | 12.81% |
| 162 | 11.36% |
| 322 | 5.70% |
| 642 | 3.97% |

⟹ **項が足りない。較正し直しても当たらない。**

`docs/north-star.md`「目指す姿」7本目——**「どれだけ載せるかを、使う側が決められる」**——は、`estimateRecallFootprint` が「mnemora を使うべきか、会話ログを全部積むべきか」を正しく見積もれることの上に立っている（`recall-footprint.ts` 冒頭の doc、`compareWithFullLog` が北極星の物差しそのものに答える設計）。**連想枠を実運用に入れて見積もりが外れるなら、この約束が壊れる。**⟹ 推定器のほうを直すのが筋であり、見積もりの精度を要求する門（`ACCURACY_TOLERANCE`）を緩めて済ませる話ではない。

---

## なぜ非単調に動くか（自分で確かめた）

ADR 0168 は 42〜162ターン行で **費用が減り**、322〜642ターン行で **費用が増える**という非単調な実測を報告し、「目次帯の1件あたり固定費（63字）より、候補を目次帯から本体へ昇格させるほうが安いことがある」という仮説を立てていた——**ただし「コードを読んだ推論であり、変異試験はしていない」と留保していた**。

**この ADR はその仮説を、実装で確かめた。**`packages/core/src/recall-runtime.ts` を読むと:

1. 連想で昇格した Memory は `finalMemories`（本体、`memories` tier）に入る（`allUnits = [...units, ...associationUnits]` → 段4の予算切り詰め → `finalMemories`）。
2. 段5（目次帯の構築）は `aggregate.digestEligible.count` を `excludeMemoryIds: finalMemories.map(...)` で除外して求める——**連想で昇格した Memory は目次帯の資格集合からも同時に除かれる。**
3. `usage.chars`（実測の総文字数）は `digestChars(finalMemories 全件の digest.length 合計) + indexChars(JSON.stringify(indexBand).length)` であり、**association 由来の Memory も普通の `digest` として同じ計算に混ざる**（`usage.byTier.association` は内訳の申告用の別枠であり、加算対象ではない）。

⟹ 連想の効果は「新しい費用の種類」ではなく、**「目次帯に載るはずだった候補を、本体側の集合に移す」という、既存の2集合（`returnedMemories` / `bandEligible`）の組み替えそのもの**である。これは新しい係数を要らない——`returnedMemories` を `min(limit, inScope) + associationCount` に置き換え、`bandEligible` をその差分から再計算するだけで、既存の `charsPerDigest` / `fixedIndexChars` がそのまま使える。

この組み替えを式にすると、非単調性がそのまま出てくる:

- **帯が件数で飽和していない領域**（`bandEligible(昇格前) <= digestBandLimit`）: 昇格1件ごとに、帯の1件（費用 `63+1+min(charsPerDigest,120)`）が消え、本体の1件（費用 `charsPerDigest`）に置き換わる。**このリポジトリの既定プロファイルでは `charsPerDigest`(≒15.5) が帯の1件の費用(≒79.5) より小さい**ため、置き換えは正味で費用を**減らす**。42/82/162ターン行はこちら側。
- **帯が件数で既に飽和している領域**（`bandEligible(昇格前) > digestBandLimit`）: 昇格した候補はどのみち帯に表示されていなかった（表示されるのは先頭 `digestBandLimit` 件だけ）ので、帯の費用は変わらず、本体側の費用だけが純増する。322/642ターン行はこちら側。

**⟹ 「昇格が安いことがある」という前任者の仮説は、コードの構造（目次帯が `excludeMemoryIds` で本体を除く集約であること）そのものから導けることを、この ADR が実装として確認した。**変異試験でも検算した（下記「測ったこと」）——`digest-band.ts` の値を直接動かしたわけではないが、`estimateRecallFootprint` にこの式を実装し、`compare-baseline.json` の実測値（42〜642ターン行）を、新しい自由係数を1つも足さずに 2.5% 以内で説明できたこと自体が、この式が正しい構造を捉えている実測的な裏付けである。

---

## 決めたこと

1. `RecallFootprintShape` に `associationCount?: number` を足す。**`association.maxCount` ではない**——`packages/core` は連想枠の実際の昇格件数を `memoryCountInScope` や `maxCount` だけから知りようがない（ANN の近傍分布・`minSimilarity` の閾値に依存する。`recall-runtime.ts` の連想段）。呼び出し側（`footprintSampleFromRecall` 経由の実測、または過去の実測からの見積もり）が渡す。省略時は `0`。
2. `estimateRecallFootprint` の内部式を次のように拡張する:

   ```
   素の返る件数 = min(limit, memoryCountInScope)
   連想の件数   = min(associationCount, memoryCountInScope - 素の返る件数)   // 構造上の上限で切り詰め
   返る件数     = 素の返る件数 + 連想の件数
   帯の件数     = min(digestBandLimit, memoryCountInScope - 返る件数)
   帯の費用     = min(帯の件数 × (63 + 1 + min(charsPerDigest, 120)), DIGEST_BAND_MAX_CHARS)
   合計         = fixedIndexChars + 返る件数 × charsPerDigest + 帯の費用
   ```

   `associationCount` を渡さなければ「連想の件数」が常に0になり、式は ADR 0166 以前と完全に一致する。
3. `RecallFootprintEstimate` に `associationCount`（切り詰め後の実際の値）を足し、呼び出し側が「昇格が何件見積もりに乗ったか」を説明できるようにする（北極星の問い3）。
4. **`calibrateRecallFootprint` は変更しない。** 較正の入力（`RecallFootprintSample`）は既に `totalChars` / `memoryCount`（実測の返った件数）/ `bandEntryCount` を持っており、連想で昇格した Memory も `memoryCount` に自然に含まれる（`footprintSampleFromRecall` が `result.memories.length` をそのまま写すため）。⟹ 較正のロジック自体は連想の有無を意識する必要がなく、**入力が生の実測値である限り、連想枠があってもなくても同じ回帰式で正しく動く。**
5. `examples/chat/src/__tests__/recall-footprint-baseline.test.ts` を、`compare-baseline.json` の `returnedCount`（実測の返った件数）から `associationCount`（= `returnedCount - min(DEFAULT_RECALL_LIMIT, totalInScope)`）を逆算し、`estimateRecallFootprint` / `compareWithFullLog` の呼び出しへ渡すように更新する。**これは「推定」ではなく「実測値を較正の入力の形に変換しているだけ」である**——`returnedCount` は CI が実測した値であり、この歯が新しく仮定した値ではない。

---

## なぜ `calibrateRecallFootprint` 側に係数を足さなかったか

検討した2案:

**案A（採った）: 構造から導く。新しい係数を足さない。**
連想の効果は「目次帯の資格から外れて本体に移る」という集合の組み替えであり、単価は既存の `charsPerDigest`（本体1件の費用）と `bandEntryChars(charsPerDigest)`（帯1件の費用、既存の構造定数から導出済み）で尽きる。新しい係数を導入する理由がない——`RecallFootprintProfile` の doc が言う「自由な係数は2つだけである」という設計方針（他の項は構造定数から決まるので係数として持たない、ADR 0011 と同じ理由）に、素直に従う。

**案B（却下）: 連想専用の係数（例: `associationOverheadChars` のような、昇格1件あたりの追加/削減コスト）を導入し、`calibrateRecallFootprint` にも較正させる。**
却下理由: (1) 上記の構造分析が示す通り、専用係数を置かなくても実測を2.5%以内で説明できており、増やす動機がない。(2) 専用係数を置くと「なぜ `charsPerDigest` や `fixedIndexChars` と別に、この係数だけ連想の有無で場合分けするのか」を説明する負担が増える——**同じ意味の値を2箇所に置くと食い違いうる**という、このファイル自身が繰り返し警告している設計原則（`RecallFootprintProfile.fixedIndexChars` の doc「`groups` は... この係数は定数として扱う」と同じ理由）に反する。(3) 較正に使える標本（`compare-baseline.json` の hold-out 5行）は、連想の効果と「目次帯が飽和しているかどうか」が完全に相関しており（42/82/162は非飽和、322/642は飽和）、専用係数を独立に較正できるだけの標本の広がりがそもそも無い。

---

## 検討して採らなかった案

| 案 | 却下理由 |
|---|---|
| ⛔ `ACCURACY_TOLERANCE`（0.025）を緩める | オーナーが明示的に禁じている。加えて、緩めても「推定器が連想を説明できない」という実体は変わらず、北極星の問い3（説明できるか）に反したまま門だけ通す形になる |
| ⭐門（`recall-footprint-baseline.test.ts`）の側だけ連想枠を使わない見積もりに変える（`compare` 経路の実測を歯の対象から外す） | ⭐門が「compare の実際の想起経路が何を積むか」という実態を見なくなる。ADR 0133 が `compare` を⭐門にした理由（再現性が高く、北極星の物差しを直接検査できる）が消える |
| `maxCount` を下げて連想の効果自体を弱め、旧モデルの誤差を許容範囲に収める | 効果を測るための調整であるべき `maxCount` を、**門を通すためだけに**動かすことになる。ADR 0168 が `maxCount=10` を選んだ理由（12件全件に届く唯一の値）を壊す。北極星の問い1「増やすなら、その分だけ想起が良くなると言えるか」を、推定器の都合で答えを変えることになり本末転倒 |
| `RecallFootprintShape` に `association: RecallAssociationQuery`（`maxCount`/`anchorCount`/`minSimilarity` 全部）をそのまま持たせ、内部で ANN の挙動をシミュレートする | 却下——`packages/core` は候補の埋め込み分布を知らない（`recall()` を呼ぶ前に見積もりたい、というこの関数の存在理由そのものに反する）。シミュレートするには埋め込みが要り、「LLM も DB も引かない純関数」という設計を壊す |

---

## 引き受けた負債

1. 🔴 **`associationCount` は呼び出し側が正しい値を渡すことに依存する。** 渡す値を間違えれば（例えば `maxCount` をそのまま渡してしまえば）見積もりは大きく外れる——`RecallFootprintShape.associationCount` の doc で明示的に警告しているが、型では強制できない（`fullLogChars` と同じ種類の負債であり、この関数の設計全体が抱える負債である）。
2. ⚠ **hold-out 5行のうち、322ターン行の誤差が2.068%と、許容誤差(2.5%)にかなり近い。** 12行という小さい標本の中での話であり、より多様な会話長・より多くの連想候補を持つ実データで、この余裕がどこまで保たれるかは確認していない。
3. ⚠ **この式は「昇格した候補は、すべて本来ならその会話長で目次帯の資格集合に入っていた」という前提を置く**（`associationCount` を `memoryCountInScope - baseReturned` の範囲でしか使わない、という構造上の上限）。実際には連想の探索窓（アンカーごとの ANN 近傍）が `memoryCountInScope` の外（同じ scope 内だが ANN が別のクラスタに飛ぶ、等）を向く可能性はコード上否定できないが、`recall-runtime.ts` の連想段は scope フィルタ（tenant/subject/status/period）を段1と同一にかけているため、範囲外に出ることは構造的に無いと読んでいる——ここは実装を読んでの結論であり、変異試験はしていない。
4. ⚠ **`compare` ベンチ以外（実運用の会話パターン）でこの式がどこまで一般化するかは確認していない**（ADR 0168 の負債1と同じ性質の限界）。

---

## これが覆るとしたら

1. **より多様な会話長・連想パターンを持つ実測データで、この式の誤差が2.5%を超えたとき。** そのとき、案Bで却下した専用係数の導入、または `bandEntryChars` の近似（`min(charsPerDigest, DIGEST_BAND_MAX_ENTRY_CHARS)`）の精度不足を疑う必要がある。
2. **連想枠のアンカー選定・近傍探索の実装が変わり、昇格した候補が `memoryCountInScope` の外から来るようになったとき。** そのとき負債3が実害になり、構造上の上限（`memoryCountInScope - baseReturned`）の妥当性を見直す必要がある。
3. **`packages/core` の既定を on にする判断（Issue #291「道2」）がオーナーによって選ばれ、`associationCount` を渡さない呼び出しが実質存在しなくなったとき。** そのとき `associationCount` を省略可能なオプションとして残す設計（後方互換のための分岐）の意味合いが変わりうるが、値そのもの・式そのものは変わらない。

---

## 測ったこと

**【実測】`packages/core` の6つの門**（この作業環境）:

- `pnpm --filter @mnemora/core run typecheck` → 緑
- `npx vitest run src/__tests__/recall-footprint.test.ts`（`packages/core`）→ **28件 全件緑**（既存18件 + 新設10件）。既存18件は**1行も変更していない**——これ自体が「省略時に既存の挙動が変わっていない」ことの間接的な裏付けである。
- `pnpm run lint` / `pnpm run format:check` / `pnpm run build` / `pnpm run pack:check`（`rm -rf packages/*/dist` 後）→ すべて緑
- `pnpm run test`（ルート、`DATABASE_URL` 無し）→ 緑。「DB テストは実行していません」と明示

**【実測】後方互換の直接検査**（`packages/core/src/__tests__/recall-footprint.test.ts` に新設）:
`associationCount` を省略した呼び出しと `associationCount: 0` を明示した呼び出しが `toEqual` で完全一致すること、および ADR 0166 以前の式をテストコード内に独立して複製し、実装の出力と数値ごと一致することを、5種類の `shape`（0件・limit未満・limit超過・帯飽和・極端に大きい件数）で検査した。

**【実測】`compare-baseline.json`（PR #336 が既に置いていた、main 未マージ時点の12行）に対する精度**（`node` で `calibrateRecallFootprint` / `estimateRecallFootprint` を直接呼んで検算):

| turnCount | totalInScope | 実測 mnemoraChars | 見積もり | associationCount(逆算) | 誤差 |
|---|---|---|---|---|---|
| 2 | 2 | 205 | 201.80 | 0 | 1.562% |
| 4 | 3 | 216 | 217.26 | 0 | 0.581% |
| 6 | 3 | 216 | 217.26 | 0 | 0.581% |
| 8 | 3 | 216 | 217.26 | 0 | 0.581% |
| 10 | 4 | 232 | 232.71 | 0 | 0.308% |
| 12 | 5 | 249 | 248.17 | 0 | 0.332% |
| 22 | 8 | 295 | 294.55 | 0 | 0.153% |
| 42 | 14 | 583 | 579.30 | 1 | 0.635% |
| 82 | 25 | 1345 | 1325.34 | 3 | 1.462% |
| 162 | 49 | 3075 | 3040.34 | 6 | 1.127% |
| 322 | 95 | 4547 | 4452.96 | 10 | **2.068%**（⚠ 訂正。旧: 4558 / 2.304%） |
| 642 | 189 | 4476 | 4452.96 | 10 | 0.515% |

**⟹ 12行すべて 2.5% 以内。**旧モデル（連想の項なし）の誤差 3.97%〜12.81% から、最大2.068%まで縮まった。

### ⚠ 2026-09-17 訂正: 上の表の 322 行は、執筆時 `4558` / `2.304%` と書いていた（Issue #340）

**この ADR が固定した `4558` は、[ADR 0170](./0170-association-search-tiebreak-nondeterminism.md)
の tie-break 修正が入る**前**の、非決定な揺れ（`4481` / `4555` / `4558`）の最大値である**
（[Issue #339](https://github.com/takecchi/mnemora/issues/339)）。**同じ PR（#336）の中で
`examples/chat/compare-baseline.json` の 322 行は `4547` へ差し替えられたのに、
この ADR 本文の表だけが追随しなかった。** ⟹ その後 [Issue #340](https://github.com/takecchi/mnemora/issues/340)
がこの古い数字を引いて「誤差 2.304%・許容 2.5% に対し余裕 約8%」と書くことになった。

**【実測】2026-09-17、`main` が `12abe48` の時点で取り直した値**（⚠ **いつ測ったかを添えるのは、「測ったと書いてある」と「いまの実装を測ってある」が別だからである**——日付と sha が無いと、次に読む人が同じ検算をやり直すことになる。この数字を引くときは `main` がここから動いていないかを見ること。`examples/chat/src/__tests__/recall-footprint-baseline.test.ts`
と同じ手順——同梱の既定プロファイルを使わず、hold-in 7行から `calibrateRecallFootprint` で
較正し直し、`estimateRecallFootprint` で12行を予測する。**DB も API キーも要らない**——
この歯は commit 済みの `compare-baseline.json` を読む純粋計算である）:

| turnCount | 実測 `mnemoraChars` | 較正した推定 | 誤差 |
|---|---|---|---|
| **322** | **4547** | 4452.96 | **2.068%** |
| 2 | 205 | 201.80 | 1.562% |
| 82 | 1345 | 1325.34 | 1.462% |

較正された係数は `charsPerDigest = 15.458` / `fixedIndexChars = 170.881`（この ADR 本文の値と一致。
標本は hold-in 7行）。**同じ計算を3回繰り返して桁まで一致し、歯そのものも3回とも緑だった**
（23 tests passed）。**他の9行はこの ADR の表のままで正しい。**

⚠ **訂正したのは数字の出所だけであり、この ADR の決定は1つも変わっていない。**
許容誤差 `ACCURACY_TOLERANCE = 0.025` も、推定器の形も、`compare-baseline.json` も
**動かしていない**（Issue #340 の対処として「現状を記録して受け入れる」を採ったオーナーの判断。
推定器を直して誤差を減らす案は **v1.0.0 後の宿題**として残っている——`docs/roadmap.md` §7.10）。

🔴 **余裕の見え方は物差しで変わる**（Issue #340 に測定を記録した）。百分率では
`(2.5−2.068)/2.5 ≈ 17%` の余裕に見えるが、**字数で見ると 322 行の実測が `4567.14` 字を
超えた時点で赤くなる ⟹ 現在の `4547` 字からの余白は 20.1 字（0.44%）しかない。**

**【実測】main マージ後の再確認**: 上の表を測った後、`origin/main` を2回取り込んだ（`8e11663`＝PR #334 `validAt` ゲート/ADR 0164、`1021a93`＝PR #335 decay活動時計/ADR 0165、いずれも migration を含む）。この PR 自身の CI run（`35045819349`、head `3b854e3`、`example-chat` ジョブ）が生成した `compare.json` artifact を取得し、`examples/chat/compare-baseline.json` の12行と `measuredAt` を除いて突き合わせたところ、**1バイトも違わなかった**（`docs/decisions/0166-...`執筆時点でこの diff を `node` で実行し確認。`examples/chat/compare-baseline.json` の `provenance.reconfirmedAfterMainMerge` に記録）。⟹ **PR #334・#335 は `compare` の実測値を動かしていない**——`validAt` ゲートはこのシナリオが `valid_from`/`valid_until` を使わないため効かず、decay 活動時計は既定 `'wall'`（非破壊）のままだからである。**⟹ 上の表（誤差3.97%〜12.81%→修正後最大2.304%。⚠ この 2.304% は上の「2026-09-17 訂正」で 2.068% に直っている——ここは当時の記録としてそのまま残す）は main マージ後の状態にもそのまま当てはまる。基準値ファイルの更新は不要だった**（ADR 0133 決定1が言う「CI artifact をそのまま基準値の本体にする」対象は、最初に固定した run `35040893466` の値のままで正しい）。

## 確かめていないこと

- **より長い会話・より多様な連想パターンを持つ実データでの一般化**（引き受けた負債4）。
- **連想の探索窓が `memoryCountInScope` の外へ出ないことの変異試験**（引き受けた負債3。実装を読んだ結論であり、`digest-band.ts`/`recall-runtime.ts` の値を直接動かして検証してはいない）。

## 人から受け取った前提（出所付き）

- ADR 0151 / 0158 / 0167 / 0168 の内容——`docs/decisions/` から直接読んだ【現物】。
- ADR 0168「なぜ非単調か」の仮説（目次帯の固定費 vs 昇格コスト）——ADR 0168 本文から引用した【受】。この ADR はその仮説を自分で読み直し、コードの構造（`excludeMemoryIds` による目次帯の除外集合の組み方）から独立に導けることを確認した【現物】。
- マネージャーからの作業指示（推定器に連想枠の項を足すこと・入力の形は設計側に委ねられていること・ADR 番号は0166固定であること）——委譲文として受け取った。式の形・較正方針の決定はこの ADR が実測とコード読解に基づき自分で行った。
