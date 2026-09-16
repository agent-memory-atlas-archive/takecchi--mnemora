# ADR 0203: `result.memories` と `result.omitted` の排他性を契約にする — 段3.5 が昇格させた記憶を `below_threshold` から取り下げる（Issue #421）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0172 / 0173 / 0188 の体裁を踏む）。

- **【現物】** — この repo のコード・文書・git 履歴を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`tsc`/`eslint`/`prettier` を走らせて確かめた。
- **【受】** — [Issue #421](https://github.com/takecchi/mnemora/issues/421) 本文の実測報告として受け取り、
  その数値自体は自分でも `packages/core` の fake ストアで独立に再現した（下記「測ったこと」参照）。

---

## 結論（先に）

**`RecallQuery.association`（段3.5、[ADR 0151](./0151-recall-association-unprompted.md)）を on にすると、
段2が `below_threshold` として `result.omitted` へ確定させた記憶が、段3.5 を経由して
`result.memories` にも `retrievedVia: "association"` として現れることがある。** 同じ memoryId が
`memories` と `omitted` の両方に載る——「返したものについて『落ちた』と名乗る」。

**この排他性は、どの ADR も明示的に決めていなかった**（Issue #421 が ADR 0008 / 0044 / 0151 / 0172 を
確認し、確かに無いと述べている）。一方 `docs/recall.md` §1 の `RecallResult.omitted` の doc は
逐語で「返らなかったものの分類」と書いており、実際の挙動と食い違っていた。

**本 ADR が決めること**: `omitted` は「返さなかった記憶の集合」であると契約として定め、
段3.5（および構造的には段3の必須同伴取得）が `finalMemories`（実際に返す集合）へ昇格させた
記憶を、`below_threshold` の `count`/`nearMisses` から取り下げる。**連想枠の除外集合は変えない**
——`below_threshold` を連想の候補プールから外すと、連想枠の獲物の大半を失う
（Issue #421 の実測: 連想枠 on の返却の47.5%がこの範囲）。取り下げは、段2の確定を
書き換えるのではなく、**段4（予算による切り詰め）まで終わって実際に返す集合が確定した後の、
分類と実際の突き合わせ**として行う。

**`RecallQuery.association` の既定値（off）はこの ADR では変えない**——#386 / #337 で
「既定 off のまま v1.0.0 を出す」が決着している。既定 off である限り、段3.5 自体が
走らないので本 ADR の変更は1バイトも挙動に影響しない。

---

## 1. 【現物・実測】何が起きていたか

`packages/core` の fake ストア上で、Issue #421 が挙げた形をそのまま再現した
（`packages/core/src/__tests__/recall-association.test.ts` の既存フィクスチャと同じ構成——
クエリ `[1,0]`、アンカー `[0.7071,0.7071]`、連想候補 `[0,1]`）。

```ts
const result = await runtime.recall(ctx, {
  vector: [1, 0],
  association: { maxCount: 5, anchorCount: 1 },
});
```

修正前の実際の出力（陽性対照。テストコードは「測ったこと」節に転記）:

```
memories: [ { id: 'mem-1', via: 'ann' }, { id: 'mem-2', via: 'association' } ]
omitted: [
  {
    "kind": "below_threshold",
    "count": 1,
    "countKind": "exact",
    "nearMisses": [ { "memoryId": "mem-2", "score": 0 } ]
  }
]
```

**`mem-2` が `memories`（`retrievedVia: "association"`）と `omitted[0].nearMisses`
（`below_threshold`）の両方に載っている。** 同じ `recall()` 呼び出しの、同じ `RecallResult` の中である。

### なぜそうなるか

1. 段2（`recall-runtime.ts` の `partitionByThreshold` 呼び出し直後）が、閾値未満の候補を
   `below_threshold` の `Omission` として確定させる（`docs/recall.md` §3「段2で確定し、
   以降は積み上げるだけ。最後に集計し直さない」）。
2. 段3.5（連想、`:1042` 以降）が候補を足し直すのはその**後**であり、除外集合
   （`withinLimit` + `companions` + アンカー自身）は `below_threshold` を含まない
   （`:1096` 付近）。
3. ⟹ 段3.5 は「段2が落ちたと確定させた記憶」を拾い直せる。**これ自体は意図した挙動**
   ——段2で落ちた記憶こそが連想枠の主な獲物であり（Issue #421・#402 の実測: 連想枠 on の
   返却の47.5%がこの範囲）、除外すると連想枠の意味がほぼ無くなる。
4. だが誰も段2の `below_threshold` の宣言を取り下げない。⟹ 「落ちた」という宣言と
   「実際には返した」という事実が、同じ `RecallResult` の中で両立する。

### 破れていないもの（Issue #421 が切り分け済み。本 ADR もこれを引き継ぐ）

- 段2の三分割（`scored = passed + below_threshold + score_not_comparable`、ADR 0044）は
  破れていない。段2の中では正しい。
- `filtered`/`decayed` の二重計上は起きていない（`recall-runtime.ts:1228` 付近のコメントが
  「集約が数えるのは集合の大きさであって、どの段が落としたかではない」と明記）。
- 忘却ゲート（ADR 0172）も破れていない。

**破れているのは `memories` と `omitted` の排他性、その1点だけである。**

---

## 2. 北極星の5つの問いに実際に当てた結果

| 問い | この判断にどう当たったか | 落ちた案 |
| --- | --- | --- |
| **1**（毎回渡す量を減らす方向に働くか） | `omitted` の該当エントリが縮む（または消える）だけで、`memories` の量は1バイトも変わらない。 | — |
| **2**（無効にしても成立するか） | `association` を渡さない呼び出しでは `promotedFromBelowThreshold` は常に空集合になる（`finalMemories` と `belowThreshold` の交差が構造的に生じない）。⟹ 挙動は1バイトも変わらない。**「§9.6 これが無くても成立する」の性質をそのまま保つ**。 | — |
| **3**（選ばれた理由を後から説明できるか） | **これが本題**——「そもそも below_threshold ではなかった」のか「below_threshold だったが返した」のかを、`omitted` の中身自体からは区別できなくなる（取り下げた痕跡を残さない）。この負債は「採らなかった案」2番で検討し、引き受けた（下記「引き受けた負債」1番）。 | `Omission` に「昇格した」ことを示す新しい札を足す案（§3「採らなかった案」2番）。 |
| **4**（推論と事実を区別しているか） | 該当しない——`finalMemories` と `belowThreshold` はどちらも同じ実行の中で既に確定した JS 側の値であり、推論（LLM 等）を経由しない。 | — |
| **5**（LLM を呼ばずに済ませられないか） | 既存の配列に対する `Set` の構築とフィルタだけ。DB 往復も LLM 呼び出しも増えない。 | — |

---

## 3. 決めたこと

1. **`omitted` を「返さなかった記憶の集合」と契約として定める。** `RecallResult.omitted` の
   doc（`packages/core/src/recall.ts`）と `docs/recall.md` §1 に、この契約を明文化する
   （「決める必要があること」3番の逆——排他性を「持たない」と明示するのではなく、
   「持つ」と決めて実装を合わせる）。

2. **段2・段4がすべて終わり `finalMemories`（実際に返す集合）が確定した直後に、
   `below_threshold` の `Omission` を `finalMemories` と突き合わせて取り下げる。**
   場所は `recall-runtime.ts` の `finalMemories` 構築の直後——`associationChars`
   （連想の usage 集計）より前。段2の確定を書き換えるのではなく、**後処理**として
   実装する（`docs/recall.md` §3「最後に集計し直す構造にはしない」という規約と
   正面から当たらないための選択——ここでやっているのは「三分割をもう一度数え直す」
   ことではなく、「確定した分類 1件を、実際に返した集合という既に確定した別の値と
   突き合わせる」ことである）。

3. **対象は `below_threshold` だけにする。** `Omission` の11種のうち、memoryId を
   明示的に持つのは `BelowThresholdOmission.nearMisses` だけである
   （`recall.ts` の各 interface を実際に読んで確認した——他の10種は `count`/`countKind`
   と、種別ごとの分類キー（`condition`/`reason`/`stage` 等）しか持たない）。
   ⟹ 「同じ memoryId が両方に載る」という**個体単位で検証可能な**矛盾を作れるのは
   `below_threshold` だけであり、本 PR の直す範囲もそこに絞る。他の kind
   （`over_limit`/`budget_dropped`/`score_not_comparable` 等）で同種の昇格が
   起きても、それは「件数の内訳が怪しい」という弱い形の問題にしかならず、
   Issue #421 も実測していない（「引き受けた負債」2番）。

4. **連想の除外集合（`recall-runtime.ts:1096` 付近）は変えない。** `below_threshold` を
   除外集合に足す案（「決める必要があること」2番）は採らない——連想枠の獲物の大半
   （47.5%、Issue #421・#402 の実測）を失うため、連想枠の意味がほぼ無くなる。

5. **`count` は「昇格した件数」ぶん正確に減らす。** `belowThreshold`（段2の partition が
   持つ全件、`nearMisses` の上位5件サンプルより広い）を突き合わせの基準にする——
   `nearMisses` だけを基準にすると、`nearMisses` に載らなかった6件目以降が昇格した
   場合に `count` が過大なまま残る。**全件昇格した場合は `below_threshold` の
   `Omission` 自体を配列から取り除く**——他の kind が `count === 0` では push しない
   作法（`filtered`/`over_limit` 等）に揃える。

6. **`RecallQuery.association` の既定値は変えない（off のまま）。** #386 / #337 の決着
   （既定 off のまま v1.0.0 を出す）に触れない。

---

## 採らなかった案

1. **段2の `below_threshold` を段3.5の後まで確定させない（パイプラインの最後に
   まとめて集計する）。** **却下**——`docs/recall.md` §3 が明示的に禁じている構造
   （「パイプラインの最後に『結局何が何件落ちたか』を集計し直す構造にはしない
   ——集計し直す設計は、集計ロジックが実装と乖離した瞬間に `omitted` が嘘をつき
   始める」）。本 ADR の実装は「段2の確定を段3.5の後まで遅らせる」のではなく、
   「段2の確定はそのまま行い、実際に返した集合との差分だけを後から引く」——
   確定のタイミングは変えていない。

2. **`Omission` に「一度落ちたが後で返った」ことを示す新しい情報を残す**
   （例: `below_threshold.promoted: MemoryId[]` を足す、または `RecalledMemory` に
   `wasOmitted: boolean` を足す）。**却下**——北極星の問い3（選ばれた理由を説明できるか）
   には却って強く応えるが、**この PR の射程を超える**。Issue #421 が明示的に
   「決める必要があること」として3案を挙げ「どれを選ぶかはこの issue では決めない」と
   書いた上で、着手コメントは「`omitted` から取り除く形」を推奨として明示した——
   新しい情報を足す設計は、その推奨よりも一段重い決定（型を増やす）であり、
   `docs/roadmap.md` §5 を通す判断に近い。**この却下は「引き受けた負債」1番として
   明示する**——将来、呼び手から「なぜこの記憶が返ったのか、below_threshold
   だったのに」という問い合わせが実際に増えたら、この案を再検討すべきである。

3. **`omitted` の文言を「返らなかったものの分類」から「返らなかった、または段3.5で
   後から返ったものの分類」のように緩め、排他性を契約に**しない**（Issue #421
   「決める必要があること」3番）。** **却下**——`docs/north-star.md` 項目6
   「知らないことを、知らないと言える」の趣旨に反する。呼び手が `memories` と
   `omitted` を足し合わせて母集団を数えている場合、排他性が無いと二重計上になる。
   排他性を「無い」と明示するより、**実際に排他にする**ほうが呼び手の負担が小さい。

4. **`over_limit`/`budget_dropped`/`score_not_comparable` 等、memoryId を持たない
   Omission にも同様の後処理を試みる**（例: 昇格した件数を推定して `count` から
   減らす）。**却下**——これらの kind は「どの記憶が昇格したか」を個体で特定できず、
   `count` を減らす根拠（どの候補が段3.5 の候補プールに実際に含まれ得たか）を
   正確に再現するには、段2・段3.5 双方の内部状態を余分に持ち回る必要があり、
   実装が「決めたこと」3番の判断（個体単位で検証可能な矛盾だけを直す）を
   超えて肥大化する。Issue #421 自身もこれらの kind での発生を実測していない。

---

## 誰が壊れうるか / 引き受けた負債

1. **昇格の痕跡が消える。** `below_threshold` から取り下げられた記憶は、`omitted` から
   見て「そもそも below_threshold ではなかった」場合と区別がつかなくなる。呼び手が
   「なぜこの記憶が閾値未満なのに返ったのか」を `RecallResult` だけから読み取ることは
   できない（`RecalledMemory.retrievedVia: "association"` と `associationOf` から
   「連想枠が拾った」ことは分かるが、「段2では below_threshold だった」ことまでは
   分からない）。「採らなかった案」2番で検討し、コストに見合わないと判断して
   引き受けた。
2. **`below_threshold` 以外の kind（`over_limit`/`budget_dropped`/`score_not_comparable`
   等）で同種の昇格が起きても、この PR は直さない。** 具体的には、段2で `passed` した
   が `limit` を超えて `over_limit(stage:"rescore")` に計上された候補
   （`passed.slice(limit)`）は、連想の除外集合に含まれていない
   （除外集合は `withinLimit` + `companions` + アンカー自身であり、`overLimit` を
   含まない）。⟹ 理論上、段3.5 がこの候補を拾い直すことも構造的にあり得るが、
   `OverLimitOmission` は memoryId を持たないため「同じ memoryId が両方に載る」形の
   矛盾としては検証できず、本 PR は実測もしていない。
3. **段3（必須の同伴取得）が同種の昇格を起こす経路は、構造的には本 PR の後処理で
   救われるが、実測していない。** 争われている記憶の同伴（`contestedWithId`）が
   偶然 `belowThreshold` に居た場合、`companions` 経由で `finalMemories` に入り、
   本 PR の後処理（`finalMemories` 全体との突き合わせ）はこの経路も等しく処理する
   ——コードはどの段が昇格させたかを区別せず、`finalMemories` に実際に載っているか
   どうかだけを見る。だが Issue #421 はこの経路を測っておらず、本 ADR もこの経路に
   限定した歯を置いていない。

## これが覆るとしたら

1. **呼び手から「なぜ below_threshold だった記憶が返ったのか分からない」という
   問い合わせが実際に増えたとき**——「採らなかった案」2番（`promoted` 情報を残す）を
   再検討する。
2. **`association` の既定が on になったとき**（PR #386 が進行中）——本 ADR の
   取り下げ処理は既定経路で常に走るようになる。処理自体は「無効にしても成立する」
   （北極星の問い2）ため挙動に懸念は無いはずだが、`finalMemories` と `belowThreshold`
   の交差判定（`Set` の構築とフィルタ）の計算量が既定経路の一部になる——
   `belowThreshold` は通常小さい（段2の候補全体からの部分集合）ため軽いと見込むが、
   実測はしていない。
3. **`over_limit(stage:"rescore")` や段3の同伴取得で、同じ形の「返したのに落ちたと
   名乗る」矛盾が実際に観測されたとき**——「引き受けた負債」2番・3番の対象を
   本 ADR と同じ設計（`finalMemories` との突き合わせ）で広げる。ただし memoryId を
   持たない kind については、まず `Omission` の型自体に memoryId のサンプルを
   持たせる拡張（`below_threshold.nearMisses` に倣う）が前提になる。

---

## 測ったこと

- 【実測】陽性対照（修正前）: `packages/core` の fake ストア上で、`association` を
  on にした recall を1回実行し、`result.memories` の `mem-2`
  （`retrievedVia: "association"`）が同時に `result.omitted[0].nearMisses`
  （`below_threshold`）にも現れることを、`console.log` の実際の出力で確認した
  （上記「1. 何が起きていたか」に出力を転記）。
- 【実測】修正後、同じ入力に対し `result.omitted` が `[]` になり（below_threshold の
  対象がこの1件だけだったため Omission 自体が配列から消えた）、`result.memories` は
  `mem-2` を `retrievedVia: "association"` のまま返し続けることを確認した。
- 【実測】`packages/core/src/__tests__/recall-association.test.ts` に恒久的な歯を
  2本追加し、緑であることを確認した:
  1. 「段2で below_threshold として落ちた記憶が連想で丸ごと昇格すると、
     below_threshold の omission 自体が消える」
  2. 「below_threshold の一部だけが連想で昇格したときは、残りだけが omitted に残る
     （count / nearMisses とも）」——2件の below_threshold 候補のうち1件だけが
     連想で昇格する構成で、`count` が2→1に減り、`nearMisses` から昇格した側だけが
     消えることを確認した（全件削除ではなく部分フィルタが効いていることの証明）。
- 【実測】変異試験: `recall-runtime.ts` の取り下げブロック（`returnedMemoryIds` の
  構築から `omitted.splice`/代入までの約50行）を丸ごと除去し、上記2本の歯が
  実際に赤くなることを確認した（1本目: `expect(...).toBe(false)` が
  `true` を受け取り失敗、2本目: `expect(belowThreshold.count).toBe(1)` が `2` を
  受け取り失敗）。他8本の既存の歯は影響を受けず緑のままだった。除去した内容は
  `cp` で退避したファイルから `cp` で復元し、`git status --porcelain` が空になる
  ことを確認したうえで、同じ2本の歯が緑に戻ることを確認した。
- 【実測】`pnpm --filter @mnemora/core run typecheck`: 緑。
- 【実測】`pnpm run lint`（eslint、全体）: 緑、警告0。
- 【実測】`pnpm run format:check`（prettier、全体）: 緑。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-association.test.ts src/__tests__/recall.test.ts
  src/__tests__/recall-pipeline.test.ts`: 3ファイル・149件すべて緑
  （既存の `below_threshold`/連想枠の歯を含め、回帰は無い）。

## 確かめていないこと

- **手元の6つの門のうち `test`（DB 込み）・`build`・`pack:check` は走らせていない。**
  `docs/autonomy.md` §2 の方針（「確かめる場所は CI である」）に従い、CI の緑で見届ける。
- **実運用での発生頻度。** Issue #421 が実測した47.5%という数字は「順位の窓」
  （#402）から借りたものであり、「取り下げが実際に何件発生するか」はこの ADR でも
  再測していない。
- **`over_limit(stage:"rescore")`/段3の必須同伴取得 経由の同種の矛盾が実在するか。**
  「引き受けた負債」2番・3番のとおり、構造的にあり得ることは分かるが、実測していない。
- **`decayClock: 'activity'`/`'either'` 経路での挙動。** Issue #421 の元の実測が
  既定の壁時計だけを見ており、本 ADR もそこに追随した——`finalMemories` との
  突き合わせは decay clock に依存しないロジックのはずだが、明示的に確認していない。
- **CI（`typecheck`/`lint`/`test`/`build` の4 required job）の実際の結果。**
  PR 本文に、この ADR を書いた後に取得した sha 付きの実測を記載する。

Refs #421
