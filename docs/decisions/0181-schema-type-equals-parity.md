# ADR 0181: `satisfies` の片方向性を `Equals`/`MutualAssignable` の型検査で塞ぐ — `schema-type-equals-parity.test.ts`（Issue #272）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

- **【実測】** — この作業者が実際にコマンドを走らせて得た出力。
- **【現物】** — この repo のコード・文書を実際に読んで確かめた。
- **【受】** — マネージャー経由で受け取った前提（Issue #272 本文、別担当の先行調査）。

---

## 文脈

**【受】** [Issue #272](https://github.com/takecchi/mnemora/issues/272) は、[ADR 0144](./0144-drop-unreachable-classification-3-union-values.md)
の変異試験（PR #271）が副産物として見つけた非対称性を報告している:

> `packages/core` の型（TypeScript union）と zod スキーマの一致は、**片方向にしか
> 守られていない**。
>
> - **zod だけを広げる**（型より広い値を受け付けるようにする）→ **`typecheck` が
>   赤くなる** ✅
> - **型だけを広げる**（zod より広い値を型に置く）→ **どの門も検知しない** ❌

機序: `z.enum([...]) satisfies z.ZodType<T>` は「**zod が作る型が `T` に代入できるか**」
だけを検査する。zod が広ければ代入できず赤くなるが、zod が `T` の部分集合のままなら
（＝型だけが広がっても）代入可能性は崩れないので通る。**「型が zod を超えないこと」は
どこにも検査されていなかった。**

**実害**: `@mnemora/core` は npm 公開済みであり、型は利用者への約束である。型に在って
zod に無い値は、利用者から見れば「あり得る値」だが `parse` を通らない——
[Issue #206](https://github.com/takecchi/mnemora/issues/206) が人手の棚卸しで見つけた
のと同じ形の嘘が、歯の無いまま再び入りうる。

**先行する部分的な防御**: [ADR 0164](./0164-valid-from-until-recall.md) の変異Dが、
`FilteredOmission.condition` という**1つの union だけ**についてこの非対称性を実測し、
`recall.test.ts` の `ALL_FILTERED_CONDITIONS`（`Record<FilteredOmission["condition"], true>`
+ `safeParse` の網羅表）で塞いだ。**⟹ 逆向きの歯の実例は、この時点で既にこの repo に
在った**——ただし1 union に限られ、他の全 union には及んでいなかった。

**別担当の先行調査【受】**（本 issue に着手する前の実測。私は再検算していないが、
以下は本 ADR の実装過程で独立に確認した箇所が多い——各箇所に印を付ける）:

- `satisfies z.ZodType<...>` は `packages/core/src` に**55箇所**、8ファイル
  （recall.ts 29 / observation.ts 7 / provenance.ts 6 / memory.ts 5 / event.ts 5 /
  outbox.ts 1 / embedding.ts 1 / ctx.ts 1）。**【実測で再確認】**——本 ADR の実装時に
  `grep -c 'satisfies z\.ZodType<' packages/core/src/<file>` を各ファイルで実行し、
  同じ内訳を得た（下記「測ったこと」参照）。**この55という数は「55ペア」の数であり、
  本 ADR で `satisfies` を3行足した後も変わらない**——足したのは既存ペアの再カウント
  ではなく、まとめの discriminated union 自体への新規の宣言だからである（下記「決定」）。
- 型側だけ union を広げる変異（`RecalledMemory.retrievedVia` に旧値を1つ戻す）は
  `typecheck` も vitest も検知しない。**【実測で再確認、下記「変異試験」】**。
- `OmissionSchema`（`z.discriminatedUnion`）は、55箇所のうち唯一
  `satisfies z.ZodType<Omission>` を持たない。**【実測で再確認】**——ただし、本 ADR の
  実装中に、**同じ形の欠落が `ProvenanceSchema`（provenance.ts）と
  `ObserveInputSchema`（observation.ts）にもあることを追加で見つけた**（下記
  「55ペアの外側で見つかったこと」）。これは受け取った前提には無かった、本 ADR 独自の発見。
  **2026-09-17 追記（マネージャー指摘）**: 当初は `OmissionSchema` にだけ `satisfies` を
  足し、`ProvenanceSchema`/`ObserveInputSchema` は「1つだけ直すと、残り2つが
  『意図的に外してある』と誤読されうる」というマネージャーの指摘を受けて、
  **3つとも同じ扱いに揃えた**（下記「決定」2番）。

---

## 決定

### 1. `packages/core/src/__tests__/schema-type-equals-parity.test.ts` を新設した

**変更を新しいテストファイル側に閉じることを優先した**（`recall.ts` は他の担当が
並行して触っている可能性があったため——実際には作業時点で衝突は無かったが、
その前提で設計した）。55ペアすべてについて、型レベルの相互代入可能性を
`Equals<A, B>`（またはその弱い形 `MutualAssignable<A, B>`）で固定する:

```ts
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _p01_CountKind = Expect<Equals<z.infer<typeof CountKindSchema>, CountKind>>;
```

`Equals<A, B>` が `false` になった瞬間、その型エイリアスの宣言自体が
`TS2344: Type 'false' does not satisfy the constraint 'true'.` でコンパイルエラーになる。
**実行時コードは生成しない**——`tsc`（`typecheck` 門）だけがこれを検査する。

**`satisfies` との違い**: `satisfies z.ZodType<T>` は「zod が型を超えないこと」だけを
見る片方向の検査だが、`Equals` は**その逆方向も同時に見る**——型だけを広げても、
zod だけを広げても、どちらでも赤くなる（下記「変異試験」で実測）。

**11 + 4 + 4 = 19本の枝は、対応する const が `export` されていない**
（`StageSkippedOmissionSchema`・各 `ObserveXxxInputSchema`・各 `XxxProvenanceSchema`。
まとめの `OmissionSchema`/`ObserveInputSchema`/`ProvenanceSchema` だけが公開されている）
ため、`z.infer<typeof ObserveInputSchema>` を `kind` で `Extract` して個々の枝の推論型を
取り出した。**これは同時に「まとめの discriminated union 自体が手書きの union 型と
一致するか」も検査する**——`_p03_Omission_whole`/`_p34_ObserveInput_whole`/
`_p40_Provenance_whole` の3本がそれである（55ペアの外側、下記参照）。

### 2. `OmissionSchema`/`ProvenanceSchema`/`ObserveInputSchema` の3つとも `satisfies` を1行ずつ足した

55箇所のうち唯一 `satisfies` を欠いていたのは `OmissionSchema`（recall.ts）だと
受け取っていたが、本 ADR の実装中に **`ProvenanceSchema`（provenance.ts）と
`ObserveInputSchema`（observation.ts）にも同じ欠落があることを見つけた**（上記
「文脈」参照）。

**当初は `OmissionSchema` にだけ `satisfies z.ZodType<Omission>` を足し、他の2つは
ファイルを変更せずテスト側の `Equals` 検査だけで済ませていた**（`_p40_Provenance_whole`/
`_p34_ObserveInput_whole`）。**マネージャーの指摘を受けて、3つとも同じ扱いに揃えた**
——1つだけ直して2つ残すと、次に読む人が「この2つは意図的に外してある」と誤読しうる
という理由に同意する。

- `recall.ts` の `OmissionSchema` に `satisfies z.ZodType<Omission>` を追加。
- `provenance.ts` の `ProvenanceSchema` に `satisfies z.ZodType<Provenance>` を追加。
- `observation.ts` の `ObserveInputSchema` に `satisfies z.ZodType<ObserveInput>` を追加。

**3箇所とも、足す前に `tsc` が緑のままであることを確認してから残した**（各 union の
全枝が既に個別に `satisfies` を持ち、`Equals` によるテスト側の検査でも緑だったため、
実質的にリスクが無いと判断した——`pnpm run typecheck` の結果は下記「測ったこと」）。
**赤くなっていたら足さず「実際にずれている発見」として報告する予定だったが、
3箇所とも赤くならなかった。**

3ファイルとも、それ以外の箇所（`Omission`/`Provenance`/`ObserveInput` の種類・
`recall-runtime.ts` 等）は一切触っていない——変更はそれぞれの discriminated union の
宣言直前に doc コメントと `satisfies z.ZodType<...>` を足した1箇所のみ
（`git diff --stat` で確認、下記「測ったこと」）。

**足しても既存の検査に対して冗長である**（各枝が個別に検査済みのため）が、
「まとめの discriminated union 自体は誰も見ていない」という読み手の誤解を防ぐ、
という文書的な価値のために残した。テスト側の `_p03_Omission_whole`/
`_p40_Provenance_whole`/`_p34_ObserveInput_whole` の3本が、この3行が万一巻き戻っても
同じ検査を独立に持つ。

**⟹ `satisfies z.ZodType<...>` の出現数は 55 → 58 に変わった**（下記「決定」5番の
歯の期待値もこれに合わせて更新した）。

### 3. `Equals` が通らなかった4ペアは `MutualAssignable`（弱い形）に落とした

55ペア全部について実際に `Equals` を書いて `tsc` を走らせ、通らないものを個別に
分類した（下記「測ったこと」に実測コマンドと出力）。

| ペア | 原因 | 対応 |
|---|---|---|
| `OutboxJobRecord.kind` | `OutboxJobKind = "extract" \| "embed" \| "consolidate" \| "reflect" \| (string & {})` という**意図的に開いたブランド型**。zod は `z.string().min(1)`（素の `string`）。相互に代入可能（`string` と `OutboxJobKind` は双方向 `extends` を満たす）だが、`Equals` はこれを「同じ型」と認めない。 | `MutualAssignable`（弱い形）+ 代表値の `safeParse`（4リテラル + 任意の非空文字列1つ） |
| `NewObservation` | `Omit<Observation, "id" \| "recordedAt"> & { recordedAt?: Date }` という **intersection 型**。zod（`.omit().extend()`）は1つに平らな object 型を返す。値としては同じだが、`Equals` は intersection とフラット型を別の型表現として扱う。 | `MutualAssignable` |
| `NewMemory` | 同上（`Omit<Memory, ...> & Partial<Pick<Memory, ...>>`）。 | `MutualAssignable` |
| `NewMemoryEvent` | 同上（`Omit<MemoryEvent, "id" \| "at"> & { at?: Date }`）。 | `MutualAssignable` |

**残り51ペア（+3本の discriminated union 全体一致）は `Equals` で通った**——
`readonly` 配列（`AnnTruncatedOmission.assumptions?: readonly string[]` と
`z.array(z.string()).readonly()`）、`optional` と `T | undefined`
（`exactOptionalPropertyTypes: false` のため区別されない）、discriminated union
（`z.discriminatedUnion` の推論型と手書き union の相互代入可能性）は、いずれも
`Equals` で正しく検査できることを確認した。

**`Equals` が通らなかった4ペアはすべて「実際のずれ」ではなく「型の表現方法の違い」
だった**——4ペアとも、単純な双方向 `extends`（`MutualAssignable`）は通る
（下記「測ったこと」でデバッグ用の scratch を使って個別に確認した）。**実際に
zod と型がずれているペアは見つからなかった。**

### 4. `_pNN` の本数を数える歯を「壊れても緑のままの assert」から実際に数える形へ直した（ADR 0177 と同種、マネージャー指摘）

**この repo は本 PR の直前、[ADR 0177](./0177-fix-stage3-tooth-blind-asserts.md)
（Issue #293）で「在ると思わせるのに噛んでいない assert」を2件直したばかりだった。**
本 PR の初版は、同じ形の欠陥を新しく持ち込んでいた——マネージャーのレビューで
指摘を受けた。

**元の形**（`packages/core/src/__tests__/schema-type-equals-parity.test.ts`
「実行時の存在証明」節）:

```ts
it("55ペア（...）+ 3本（...）を保持する", () => {
  // この it 自体は何も実行時検証をしない——上のファイル全体が `tsc` に通ることが検査である。
  expect(55 + 3).toBe(58);
});
```

`55 + 3` は TypeScript がコンパイル時に計算する**定数どうしの比較**であり、
このファイルのどの `_pNN` を何本消しても、`55 + 3` は `55 + 3` のまま変わらない
——**ADR 0177 が指摘した「壊れても緑のままの assert」と全く同じ構造**
（あちらは `indexOf` が `-1` を返す世界で `Math.abs(...) === 1` が偶然成立する形、
こちらは「ファイルの中身を一切見ずに、コメントで主張した数を定数として書き写す」形。
**どちらも「本来検査したいものを見ていない」という点で同じ族**）。

**直した形**: このファイル自身のソースを `readFileSync` で読み、
`/^type _p(\d+)_[A-Za-z_]+ =/gm` で `_pNN` 宣言を実際に数え上げ、
(a) 本数が58であること、(b) 番号の集合が `1..58` の連番（重複も欠番も無い）であること
の2つを検査する。**これで「`_pNN` を1本消す／複製する」という変異に対して、
実際に赤くなる歯になった**（下記「測ったこと」の変異試験で実測）。

**失敗メッセージにも、何をすべきかを書いた**——`expect(numbers.length, howToFix).toBe(...)`
の第2引数に、EXPECTED_PAIR_COUNT を更新すべきか・番号の重複を疑うべきかの分岐と、
Issue #272 / 本 ADR への参照を埋め込んだ（下記「決定」5番と同じ形）。

### 5. 「satisfies の出現数」の歯にも、失敗メッセージへ対処法を埋め込んだ

「引き受けた負債」節で述べる `satisfies z.ZodType<...>` の出現数を数える歯
（`packages/core/src` 全体を静的走査するほう）は、当初 `expect(count).toBe(56)` という
メッセージ無しの形だった。**マネージャーの指摘**——「58と59が違う、としか言わない
失敗出力では、赤くなった人が何をすればいいか分からない」——を受けて、
`expect(count, "<説明>").toBe(EXPECTED_SATISFIES_COUNT)` の形に直した。説明文には
「新しい `satisfies` を足したなら、対応する `_pNN` を本ファイルへ足し、この期待値と
決定4の歯の期待値も一緒に更新すること」と、Issue #272 / 本 ADR への参照を入れた。

**この歯自体は、他の担当（並行して走っている複数のマネージャー）が `packages/core` に
新しい zod スキーマを足すたびに赤くなる**——これは摩擦だが、意図した挙動である
（マネージャーの判断で維持。「引き受けた負債」節参照）。

---

## 採らなかった案

### 方向2: ソースの静的走査（`unreachable-union-values.test.ts` の向きを反転させる）

**採らなかった。**既存の `unreachable-union-values.test.ts` は「型に在るのに**生成
されない**値」を、`field: "value"` というオブジェクトリテラルの文字列一致で数える。
これを反転させて「zod の enum 値と型の union 値が一致するか」を文字列比較で検査する
ことも考えられたが:

- **union の宣言を2箇所（型の union リテラルと zod の enum 配列）で独立に文字列として
  読み取り、集合として突き合わせる**必要があり、これは事実上「型を手で書き写す」
  歯になる——[ADR 0159](./0159-omission-kind-generation-registry.md) が
  `TICK_SUPPORTED_JOB_KINDS`/`RECALL_CHANNELS` について引いた「散文で数え直した瞬間に
  次に値が増えたとき黙って嘘になる」という同じ問題を抱える。
- **object 型（`Memory`・`RecallQuery` 等、55ペアの大半）には効かない。**文字列一致で
  拾えるのは列挙値（union of literals）だけであり、フィールドの型・optional/required・
  ネストした object の形までは検査できない。`Equals` は型システムそのものに検査させる
  ため、object 型にもそのまま効く（本 ADR の55ペアのうち union of literals は
  `CountKind`/`NotIndexedReason`/discriminant/`MemoryStatus` 等の一部に過ぎず、
  大半は object 型である）。

**ただし、部分的には採った**——`OutboxJobRecord.kind` の弱い形（代表値の `safeParse`）
は文字列一致的な発想であり、**「型がそもそも閉じた union ではないとき」だけ**この
戦略に戻る。

### 方向3: zod を単一の情報源にする（型を `z.infer` から導出し、手書きの union を廃す）

**採らなかった。**Issue #272 自身がこの案の代償を「大きな変更」「doc コメントの
置き場所が変わる」と予告しており、実際に55箇所を読んで確かめた:

1. **規模。** 55箇所という数そのものが、この変更の費用を決める。1〜2箇所なら
   `z.infer` からの型導出に切り替える費用は小さいが、55箇所を一度に切り替えるのは
   `packages/core` の公開型の書き方を丸ごと変える破壊的な作業になる。
2. **union member ごとの doc コメントの置き場所が消える。**
   `FilteredOmission.condition` の宣言（`recall.ts` 123〜132行）を実際に読むと、
   **9値それぞれに数段落の説明が付いている**——`"tenant"`/`"taxonomy"` が
   なぜ生成されないか（ADR 0117）、`"decayed"` の `count`/`countKind` の意味
   （ADR 0173）、`"expired"`/`"not_yet_valid"` の境界規則（ADR 0164）等、
   **1つの型宣言全体が82行（`recall.ts` 54〜135行）あり、そのほとんどが doc コメントである。**
   `z.enum([...])` の配列リテラルの各要素には、TypeScript の構文上、
   この密度のドキュメントを直接添えられない（zod の `.describe()` は1行の説明文
   しか持てず、この repo の doc コメントが持つ「なぜ」「ADR 参照」「⚠ 注意」の
   構造化された形を表現できない）。**⟹ 型を第一級にして zod をそこから導出する
   のではなく、型を第一級に保ったまま zod との整合を別の歯で守る、という
   本 ADR の方向のほうが、この repo の「なぜ」を書く文化と整合する。**
3. **`GroupCount`/`RecalledMemory`/`RecallQuery` 等、doc コメントが同じ密度で
   付いている他の型にも同じ問題がある**（`RecalledMemory.retrievedVia` のフィールド
   宣言だけで26行のコメント（`recall.ts` 904〜929行）、`RecallQuery.validAt` は
   36行（`recall.ts` 1096〜1131行）——いずれも `awk` で実測した）。

### 案(c): `satisfies` を諦めて `z.infer` の型を毎回手で書いた型と比較する assert 関数を作る

検討したが、型レベルの `Expect<Equals<...>>` と本質的に同じことを実行時関数
（`function assertSchemaMatches<T>() {...}`）でやる形であり、**型レベルでできることを
わざわざ実行時に持ち出す理由が無い**——型だけのミスマッチは実行時に1回も
`assertSchemaMatches` を呼ばなくても `tsc` が検出できる。採らなかった。

---

## 引き受けた負債

- **この歯は「新しい型を足した人が登録し忘れる」ことを完全には防げない。**
  55ペアは`_p01`〜`_p58`として**手で**列挙したものであり、`Record<Union, ...>`
  のように union から機械的に導いてはいない（55ペアは55個の**別々の型**への
  言及であり、単一の union から取り出せる形ではないため、[ADR 0159](./0159-omission-kind-generation-registry.md)
  の `OmissionProbe` レジストリのような「キー不足で `tsc` が落ちる」形の強制は
  作れなかった）。
  - **部分的な緩和として、`satisfies z.ZodType<...>` の出現数を数える歯を足した**
    （`schema-type-equals-parity.test.ts` 末尾の
    「satisfies z.ZodType<...> の出現数が変わったら気づく」）。`packages/core/src`
    （`__tests__` を除く）を `unreachable-union-values.test.ts` と同じ手法
    （ディレクトリ走査 + コメント行除外）で静的に走査し、出現数が58（55 + 本 ADR で
    足した `OmissionSchema`/`ProvenanceSchema`/`ObserveInputSchema` の3行、
    「決定」2番）と一致することを検査する。失敗時のメッセージに対処法を埋め込んだ
    （「決定」5番）。
  - **これに加えて、`_pNN` 宣言の本数と番号自体を数える歯も足した**（「決定」4番）
    ——`ADR 0177` と同種の「壊れても緑のままの assert」を直したものであり、
    「新しい型を足したのに `_pNN` を足し忘れた」ケースの一部（本数が合わない・
    番号が飛ぶ）を検出できる。
  - **これらは強制ではなく合図である。**新しい `satisfies z.ZodType<X>` が
    どこかに増えれば、出現数の歯が赤くなって「対応する `_pNN` をここへ足すこと」に
    気づける。**しかし**: (a) 2箇所が同時に増減して数が偶然一致すれば見逃す、
    (b) 数が正しく58のままでも、55ペアのうちどれかが**別の型を指すように
    書き換えられた**場合（例: コピペミスで `_p23_RecalledMemory` が
    `RecallScope` と比較するようになった）はどちらの歯でも気づけない——**歯そのものが
    網羅を強制しているのではなく、数の一致・番号の連番だけを見ている。**
  - **⟹ 強制できるか、で問われたら「できない」と正直に書く。** ADR 0159 の
    `Record<Omission["kind"], OmissionProbe>` は union の要素数と1対1対応する
    キー不足検査で真に強制できていたが、本 ADR の55ペアは「型とスキーマの
    ペア」という、単一の union から機械的に導けない関係であるため、同じ水準の
    強制は作れなかった。
- **`OutboxJobRecord.kind` の弱い形は、`OutboxJobKind` が意図的に開いた型
  （`(string & {})`）であるという前提に依存している。**将来この型が閉じた union
  （ブランドを外す）に変わったとき、`Equals` へ格上げできるかどうかは
  再検討が必要——この ADR はその判断をしない。
- **`MutualAssignable` は `Equals` より弱い。**「型として同一」までは主張できず、
  「相互に代入可能」までしか言えない。intersection 型（`Omit<T,K> & {...}`）が
  今後も同じ限界を持ち続ける限り、`NewObservation`/`NewMemory`/`NewMemoryEvent`
  の3ペアは今後もこの弱い形のままである。

---

## これが覆るとしたら

- **`Equals` トリック自体が TypeScript のバージョン更新で挙動を変えたとき**
  ——本 ADR が実測した「intersection 型とフラット object 型を区別する」という
  挙動は、TypeScript の型システムの実装詳細に依存する。バージョンが上がって
  この挙動が変わったら、`MutualAssignable` に落としていた4ペアが `Equals` に
  昇格できるか（あるいは逆に、通っていた51ペアのどれかが落ちるか）を
  再検査する必要がある。
- **55ペアのうちどれかの型が `z.infer` から導出する形に切り替わったとき**
  ——方向3を個別の型について採る決定が下されたら、その型の `_pNN` は
  `Equals<z.infer<typeof X>, z.infer<typeof X>>`（自明に真）になり、意味を
  失う。そのときは該当行を削るか、コメントで「この型は zod 由来である」と
  明記する。
- **`OutboxJobKind` が閉じた union に変わったとき** ——上記「引き受けた負債」参照。

---

## 測ったこと

**出所: すべて私がこの作業環境で実行した。**

### 手元の門

```
$ pnpm run typecheck   # 7 workspace projects すべて Done
$ pnpm run lint        # eslint . でエラー無し
$ pnpm run format:check  # All matched files use Prettier code style!
$ pnpm --filter @mnemora/core run test
 Test Files  58 passed (58)
      Tests  846 passed (846)
$ rm -rf packages/*/dist && pnpm run build   # 7 projects すべて Done
$ pnpm run pack:check   # ✔ publish 梱包の門を通りました。
```

### 55箇所の内訳の再確認（決定2で3行足す前）

```
$ for f in recall.ts observation.ts provenance.ts memory.ts event.ts outbox.ts embedding.ts ctx.ts; do
    echo "$f: $(grep -c 'satisfies z\.ZodType<' packages/core/src/$f)"
  done
recall.ts: 29        observation.ts: 7   provenance.ts: 6
memory.ts: 5         event.ts: 5         outbox.ts: 1
embedding.ts: 1      ctx.ts: 1
```
（合計55。受け取った前提と一致した。）

### 58箇所への再確認（決定2で `OmissionSchema`/`ProvenanceSchema`/`ObserveInputSchema` に `satisfies` を足した後）

```
$ for f in recall.ts observation.ts provenance.ts memory.ts event.ts outbox.ts embedding.ts ctx.ts; do
    n=$(grep -v -E '^\s*(\*|//)' packages/core/src/$f | grep -c 'satisfies z\.ZodType<')
    echo "$f: $n"
  done
recall.ts: 30        observation.ts: 8   provenance.ts: 7
memory.ts: 5         event.ts: 5         outbox.ts: 1
embedding.ts: 1      ctx.ts: 1
```
（合計58 = 55 + 3。`recall.ts`/`observation.ts`/`provenance.ts` がそれぞれ1本ずつ増えた。
コメント行を除外するコマンドに変えたのは、本 ADR の追記コメント自身が
`satisfies z.ZodType<...>` という文字列を3回プローズで引用しており、コメント行を
除外しないと自分の説明文を誤って数えてしまうため——「決定」5番の歯が実装過程で
実際に踏んだ問題と同じである。）

### `Equals` が通らなかった4ペアの原因切り分け

`NewObservation`/`NewMemory`/`NewMemoryEvent` の3ペアについて、単純な双方向
`extends`（`X extends Y` と `Y extends X` を別々に見る、`Equals` のトリックを使わない
形）を scratch ファイルで試したところ、**3ペアとも両方向とも通った**
（`tsc` がエラーを出さなかった）。**⟹ `Equals` だけが「同じ型」と認めず、実際には
相互に代入可能。** 最小再現として次を試し、`Omit<T,K> & {...}` という intersection
の書き方そのものが原因であることを確認した:

```ts
interface Full { a: number; b: string; c: boolean }
type Flat = { a: number; b: string };
type ViaOmit = Omit<Full, "c">;
type _c1 = Expect<Equals<Flat, ViaOmit>>; // 通る（Omit だけなら問題ない）

interface WithOptional { a: number; b?: string }
type ViaOmitExtend = Omit<Full, "c" | "b"> & { b?: string };
type _c2 = Expect<Equals<WithOptional, ViaOmitExtend>>; // TS2344 で落ちる
```

`OutboxJobRecord.kind` についても同様に、`string extends OutboxJobKind` と
`OutboxJobKind extends string` を個別に検査し、両方とも通ることを確認した
（`Equals<string, OutboxJobKind>` だけが `false` を返す）。

### 変異試験（歯が実際に噛むことを示す）

**`docs/autonomy.md` §4「`git checkout <file>` で変異を戻すと未コミットの編集も
消える」を踏まないため、`cp` で退避コピーを取り、そこから戻した。全6変異について、
戻した後に `diff <backup> packages/core/src/recall.ts` が0行であることを確認した。**

3フィールド × 2方向（型だけ広げる／zod だけ広げる）= 6変異。

| # | フィールド | 変異 | `tsc` の結果（抜粋） |
|---|---|---|---|
| 1 | `RecalledMemory.retrievedVia` | 型だけ `\| "tag_match"` を足す | `schema-type-equals-parity.test.ts(281,35)` `_p23_RecalledMemory` が **TS2344 で赤**。`(301,33)` `_p30_RecallResult`（`RecalledMemory[]` を含むため連鎖）も赤。**`satisfies` 側（`recall.ts`）は緑のまま**——issue #272 の指摘どおり |
| 2 | 同上 | zod だけ `.enum([...,"tag_match"])` にする | 上と同じ2箇所が赤に加え、`recall.ts(966,4)` `RecalledMemorySchema` と `recall.ts(1431,4)` `RecallResultSchema` が **TS1360（`satisfies` 違反）で赤** |
| 3 | `StageSkippedOmission.reason` | 型だけ `\| "budget_exhausted"` を足す | `(215,35)` `_p03_Omission_whole`、`(218,3)` `_p04_StageSkippedOmission`、`(301,33)` `_p30_RecallResult` が赤。`satisfies` 側は緑のまま |
| 4 | 同上 | zod だけ広げる | 上3箇所に加え、`recall.ts(329,4)` `StageSkippedOmissionSchema`・`recall.ts(433,4)` `OmissionSchema`（本 ADR で足した1行が捕まえた）・`recall.ts(1431,4)` `RecallResultSchema` が TS1360 で赤 |
| 5 | `GroupCount.axis` | 型だけ `\| "time_window"` を足す | `(261,31)` `_p15_GroupCount`、`(273,30)` `_p19_IndexBand`（`GroupCount[]` を含むため連鎖）、`(301,33)` `_p30_RecallResult` が赤。`satisfies` 側は緑のまま |
| 6 | 同上 | zod だけ広げる | 上3箇所に加え、`recall.ts(463,4)` `GroupCountSchema`・`(543,4)` `IndexBandSchema`・`(1431,4)` `RecallResultSchema` が TS1360 で赤 |

**⚠ この表の行番号は、本 PR の最終状態（`_pNN` を数える歯を「決定」4番の形へ直し、
`ProvenanceSchema`/`ObserveInputSchema` に `satisfies` を足した後）で測り直したものである。**
初稿の表はそれより前の版で測った行番号を載せており、**最終状態では再現しなかった**
（テストファイル側が一律2行、`recall.ts` 側も変異4の3箇所ずれていた）。
**実測として書いた数字が再現しないのは、測っていないのと同じである。**
6変異すべてを最終状態で1本ずつ測り直し、表を入れ替えた。

**変異1・3・5（型だけ広げる）はいずれも、変異後に既存の歯
（`unreachable-union-values.test.ts`・`recall.test.ts`）を実行しても緑のままである
ことを確認した**（`pnpm --filter @mnemora/core exec vitest run
src/__tests__/unreachable-union-values.test.ts src/__tests__/recall.test.ts` →
68 tests passed、3変異とも）——**issue #272 が指摘した非対称性がこの repo で
現に再現し、かつ既存の歯では検知されないことを、本 ADR の実装対象そのもので
実測した。**

**`examples/chat` の偶然の赤**: 変異1・2（`RecalledMemory.retrievedVia` を広げる）の
とき、`pnpm --filter @mnemora/example-chat exec tsc --noEmit -p tsconfig.json` も
赤くなった:

```
src/association-arm.ts(350,7): error TS2322: Type '"association" | "ann" | "lexical" |
  "mandatory_companion" | "tag_match" | null' is not assignable to type
  '"association" | "ann" | "lexical" | "mandatory_companion" | null'.
```

`examples/chat/src/association-arm.ts:46` の `AssociationProbeOutcome.goldRetrievedVia`
が `RecalledMemory["retrievedVia"]` を型参照ではなく**手で複製した union リテラル**
として持っているため、`RecalledMemory.retrievedVia` を広げると代入できなくなる。
**これは `Equals` の歯が捕まえたのではなく、たまたま同じ変更で別の箇所（型の
複製）が壊れただけである**——`RecallQuery.channels` のような他のフィールドを
広げても `examples/chat` は無関係のまま赤くならない。**体系的な門ではなく、
再現性の無い偶然の赤として記録する**（`association-arm.ts` の union を
`RecalledMemory["retrievedVia"] | null` という型参照に直せば消える種類の赤だが、
本 ADR の範囲外のため直していない）。

すべての変異は `cp` の退避コピーから復元し、`diff` が0行であることを確認した
うえで `git status --short packages/core/src/recall.ts` が
「`M packages/core/src/recall.ts`」（本 ADR で足した1行の変更のみ）であることを
確認した。

### 変異試験: `_pNN` を数える歯（「決定」4番、ADR 0177 と同種の欠陥を直したことの証明）

**マネージャー指摘を受けて修正した「`_pNN` の本数を数える歯」自身についても、
`cp` で退避コピーを取り、2種類の変異で赤くなることを確認してから復元した。**

**変異A: `_p29_RecallOutputValidation` の宣言を丸ごと1つ削除する**（本数が58→57になる）

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/schema-type-equals-parity.test.ts
 ❯ schema ↔ 型 の Equals parity（Issue #272） (1)
   × _pNN 宣言が58本あり、番号1..58に重複も欠番も無い

AssertionError: packages/core/src/__tests__/schema-type-equals-parity.test.ts の
`type _pNN_...` 宣言を数え直したところ期待値と食い違った。…
expected 57 to be 58

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

**変異B: `_p30_RecallResult` を `_p29_RecallResult` に改名する**（本数は58のまま、
番号29が重複し30が欠番になる——本数だけを見る検査では拾えない壊れ方）

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/schema-type-equals-parity.test.ts
 ❯ schema ↔ 型 の Equals parity（Issue #272） (1)
   × _pNN 宣言が58本あり、番号1..58に重複も欠番も無い

AssertionError: …（番号が1..58の連番になっていない）: expected [ Array(58) ] to deeply equal [ Array(58) ]
- Expected
+ Received
@@ -26,11 +26,11 @@
    29,
-   30,
+   29,
    31,

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

**両変異とも、`cp` の退避コピーから復元し `diff` 0行を確認した後、再実行して
4 tests すべて緑に戻ることを確認した。** 変異Aは「本数」の assert（1つ目）が、
変異Bは「番号の連番」の assert（2つ目）が、それぞれ独立に捕まえている——
本数だけを見る検査だと変異Bは見逃す（58本のまま）ため、2つの assert を両方
残す判断（「決定」4番）が実際に効いていることを、この変異で確認した。

**⟹ 当初の `expect(55 + 3).toBe(58)`（定数どうしの比較）では、変異A・Bのどちらを
入れても永遠に緑のままだった**（`55 + 3` はファイルの中身を一切見ないため）。
直した歯は両方の変異で実際に赤くなり、ADR 0177 が要求する「歯が実際に噛むことを
変異試験で示す」を満たす。

---

### ⭐ この歯は、着地する前に実際に噛んだ（`ScopeRelation`）

**【実測】本 PR の CI が、`typecheck / lint / test / build` ジョブで
`expected 59 to be 58` で赤くなった**（head `e8e0cb1`、
`https://github.com/takecchi/mnemora/actions/runs/35119246121/job/104872499214`）。

原因は本 PR の誤りではない。**PR #376（[ADR 0174](./0174-filtered-omission-scope-relation.md)、
`FilteredOmission` に `scopeRelation` を足した）が、`main` に
`ScopeRelation` の型と `ScopeRelationSchema`（`satisfies z.ZodType<ScopeRelation>` 付き）を
入れていた**ためである。

**ここで重要なのは、なぜ手元では緑だったかである** ——本 PR のブランチは
その `main` を取り込む前の木を見ており、手元の6つの門はすべて緑だった。
**CI は PR と `main` のマージ後の木を検査するので、そこで初めて 59 件になった。**
⟹ `docs/autonomy.md` §2 の「手元の門の緑を、CI の緑の代わりにしない」が、
**この歯についても当てはまる**ことの実例である。

**対処**: `git merge origin/main` して `_p59_ScopeRelation` を足し、
`EXPECTED_PAIR_COUNT`／`EXPECTED_SATISFIES_COUNT` を 59 へ上げた。

⟹ **「新しい型を足した人が、対応するペアの登録を忘れる」という、まさにこの ADR が
『引き受けた負債』として書いた事象が、ADR が着地する前に1件起きた。**
そして**歯はそれを拾った。**下の「引き受けた負債」に書いたとおり、
**これは「気づける」であって「強制できる」ではない**——気づいた後にペアを足すのは
人間の仕事である。**ただし、気づけなければ 55ペアの一覧は静かに腐っていた。**

⚠ **この歯は、`packages/core` に zod スキーマを足す他の PR を赤くする。**
それは摩擦であるが、**上のとおり、それがこの歯の唯一の働き方である。**
2つの歯の失敗メッセージには、赤くなった人が何をすべきかを埋め込んである。

## 確かめていないこと

- **`Equals` トリックが TypeScript のどのバージョンから今の挙動を持つかは
  確認していない。**`typescript 5.9.3`（本 repo の devDependency）でのみ確認した。
- **`packages/postgres`/`packages/openai`/`packages/anthropic`/`packages/local-embedding`
  に同種の `satisfies z.ZodType<...>` があるかは調べていない**——issue #272 も
  受け取った前提も `packages/core` に限定している。他パッケージへ射程を広げるかは
  この ADR の範囲外。
- **DB を要する検査は実行していない**（この issue の射程に DB は関係しない
  ため、そもそも該当する検査が無い）。
- **「satisfies z.ZodType<...> の出現数」の歯・「`_pNN` の本数と連番」の歯が、
  実際に将来の担当者に気づかれて正しく行動（`_pNN` を足す・期待値を更新する）に
  つながるか**は、実際にそのシナリオが起きるまで確認できない
  （マネージャーが「並行する他のマネージャーが `packages/core` にスキーマを足すと
  この歯で赤くなる」と指摘した摩擦は、CI で実際に観測されるまで机上の想定である）。

---

## 参照

- [ADR 0144](./0144-drop-unreachable-classification-3-union-values.md) —
  非対称性を最初に実測で確認した ADR（「開いている穴」2番）。
- [ADR 0164](./0164-valid-from-until-recall.md) — `FilteredOmission.condition` 1本
  だけについて、先行して同じ非対称性を塞いだ変異D。
- [ADR 0159](./0159-omission-kind-generation-registry.md) — `Omission.kind` の
  レジストリ型検査（`Record<Union, Probe>`）。本 ADR が「同じ水準の強制は
  作れなかった」と書いた比較対象。
- [ADR 0177](./0177-fix-stage3-tooth-blind-asserts.md)（Issue #293） —
  「壊れても緑のままの assert」を直した直前の ADR。本 ADR の初版が同じ形の欠陥
  （`expect(55 + 3).toBe(58)` という定数どうしの比較）を新しく持ち込みかけ、
  マネージャーの指摘で「決定」4番のとおり直した（「これが覆るとしたら」ではなく
  実際に本 PR の中で起きた）。
- [Issue #206](https://github.com/takecchi/mnemora/issues/206) /
  [ADR 0117](./0117-unreachable-union-values-inventory.md) — 「型に在って
  一度も生成されない値」の人手の棚卸し。同じ形の嘘を歯で防ぐ、という
  本 issue の動機の出所。
- [Issue #272](https://github.com/takecchi/mnemora/issues/272) — 本 ADR の対象issue。
- `packages/core/src/__tests__/schema-type-equals-parity.test.ts` — 本 ADR の実装。
