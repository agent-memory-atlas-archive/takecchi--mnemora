# ADR 0177: 段3の歯の「壊れても緑のままの assert」2件を直す — 変異試験で実測する（Issue #293）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

**[Issue #293](https://github.com/takecchi/mnemora/issues/293) が指摘した2つの盲点を、
`packages/core/src/__tests__/mark-contested.test.ts`「recall() の段3が実際に発火する」歯で直す。**

1. **`expect(stage?.executed).toBe(true)`** は、段3が壊れているかどうかの検出力を
   持たない。本番コード（`recall-runtime.ts`）が `companions.length` に関わらず
   常に `executed: true` を push するため。⟹ **消さずに残すが**、「段3のコードが
   実行されたことしか言っていない」と明記するコメントを添え、**発火の根拠は直後の
   `detail.companionsAdded` に一本化する**（元から在ったので、これは既存の assert を
   正しく読み直すだけである）。
2. **隣接性の assert `Math.abs(indexStrong - indexWeak) === 1`** は、`indexOf` が
   見つからないとき `-1` を返すため、**片方が完全に不在の世界で偶然成立する**
   （`Math.abs(0 - (-1)) === 1`）。⟹ **両方の index が `>= 0` であることを先に assert
   してから**、隣接性を比較する形に直す。

**この2点を直したこと自体を、変異試験で証明する**（下の「測ったこと」）。
`packages/core/src/__tests__/stage3-mandatory-companion-mutation.test.ts`
（PR #283 / ADR 0150 が足した変異試験の現物）を拡張し、**変異体C（段3の入口条件を外す）で、
直す前は緑・直した後は赤になる**ことを、この歯自身の中に検算として残した。

**あわせて、Issue #293 の「やること（案）」3番（同じ形の盲点が他の歯にも在るか）を横断調査し、
`packages/core/src/__tests__/recall-pipeline.test.ts` と
`packages/postgres/src/__tests__/recall.postgres.test.ts` に同じ形の盲点を見つけて直した**
（下の「決定4」）。

---

## 文脈

### Issue #293 の主張（読み取り）

PR #283（Issue #197 の解決側、ADR 0150）が変異試験を書いた**副産物**として、
「元の歯自身が、段3が壊れても緑のままだった」ことが実測で見つかった。ADR 0150
「測ったこと」節に既にこの実測は記録されている——本 PR はそれを**直す**側である。

🔑 Issue #293 の主張は「テストが足りない」ではなく、
**「在ると思わせるのに、噛んでいない assert が在る」**である。
在ることで、誰も見に行かなくなる分だけ、無いテストより悪い。

### 前段（この作業者が現物で確認した）

- `packages/core/src/__tests__/mark-contested.test.ts` 356〜365行目の該当箇所は、
  Issue #293 の引用と一致していた（コピペではなく、実ファイルを読んで確認した）。
- **ADR 0150 の「測ったこと」節と Issue #293 本文はどちらも、
  「`packages/core/src/__tests__/resolve-contested.test.ts` は既にこの（`index >= 0` を
  先に assert する）形で書いてある」と述べている。** ⟹ **この作業者が `resolve-contested.test.ts`
  を実際に読んだところ、事実と異なっていた**——この歯には `indexOf` を使った隣接性の
  assert 自体が1つも無い（`grep -n "Math.abs\|adjacency\|>= 0" ...` が0件）。**「検出から
  解決までの一巡」歯は `toContain` で両者の存在を確認するだけで、提示順の隣接性は
  一度も検査していない。**
  ⟹ **これは ADR 0150／Issue #293 の側の誤りである**（推測ではなく実測。読み間違いか、
  執筆時点で在った下書きが後に落ちたのかは分からない）。本 ADR はこの誤りを踏襲せず、
  実際に `index >= 0` を先に assert している既存の先例として
  `examples/chat/src/__tests__/correction-scenario.test.ts`
  「turns 内で original.text が correction.text より先に現れる」歯
  （`expect(originalIndex).toBeGreaterThanOrEqual(0); expect(correctionIndex).toBeGreaterThan(originalIndex);`）
  を採る。**`resolve-contested.test.ts` に隣接性の assert を足すことは、本 PR のスコープに
  含めない**——「ついでに直さない」（`docs/autonomy.md` §2）。足りないのは Issue #293 が
  主張する「壊れた assert」ではなく「無い assert（未着手のカバレッジ）」であり、
  **性質が違う**。別issueの候補として報告する。

---

## 決定

### 決定1: `executed` は消さず、コメントで射程を明記する

Issue #293 のやること案1は「消すか、コメントで明記する」の二択を示している。
**消さない**ことを選んだ——`executed` は「段3のコードパスに入ったか」という別の情報を
持っており（`companionsAdded` が語らない情報ではないが、`stage` オブジェクト自体が
存在すること・`executed` フィールドの形そのものが壊れていないことは、この assert が
引き続き検査している）。**「何も言っていない」わけではなく「発火の証拠にならない」だけ**
なので、削除ではなく**射程を正しく書いたコメント**を選んだ。

`mark-contested.test.ts` と `stage3-mandatory-companion-mutation.test.ts` の両方に、
同内容のコメントを置いた（後者は元から詳しいコメントを持っていたので、Issue 番号の参照だけ足した）。

### 決定2: 隣接性の assert は「両方 `>= 0`」を自分自身の前提として先に assert する

```ts
const indexStrong = ids.indexOf(strong.id);
const indexWeak = ids.indexOf(weak.id);
expect(indexStrong).toBeGreaterThanOrEqual(0);
expect(indexWeak).toBeGreaterThanOrEqual(0);
expect(Math.abs(indexStrong - indexWeak)).toBe(1);
```

**採った理由**: 「上のほうで `toContain` を既に assert しているから大丈夫」という
**他の行への依存**は、Issue #293 が暴いた盲点そのものの構造である
（`mark-contested.test.ts` は実際に `toContain` を先に持っていたが、その2行と
隣接性の行の間に依存関係は無く、**隣接性の assert 単体を取り出すと自立していなかった**
——`stage3-mandatory-companion-mutation.test.ts` の `originalAssertions` が各 assert を
独立したサンクとして評価するのは、まさにこの「他の行に守られているだけ」を暴くためである）。
⟹ **assert は、それ単体で見ても意味が通る形にする。**

### 決定3: 変異試験（`stage3-mandatory-companion-mutation.test.ts`）を、直した式に合わせて更新する

このファイルは PR #283 が「`mark-contested.test.ts` の assert 群を**式を変えずに複製**する」
という設計で作られている（`originalAssertions` の doc コメント）。⟹ 本 PR で
`mark-contested.test.ts` 側の式を変えたら、**複製側も同じ式に揃えないと「式を変えずに複製」
という前提自体が崩れる**。

`originalAssertions.adjacency` を決定2と同じ式に更新し、**変異体C**
（段3の入口条件を外す＝`status` を `'contested'` から `'active'` に見せる。weak だけが
結果から消え、strong だけが残る）の `expectRed` に `"adjacency"` を追加した
——**直す前はこの変異体で緑のままだったことを、直す前のコードで実際に確認した
（下の「測ったこと」）。**

### 決定4: 同じ盲点を実際に持つ他の歯も、範囲を絞って直す（Issue #293 やること案3）

`packages/` と `examples/` を `indexOf` で横断検索し、**「`indexOf` の結果を `Math.abs(...) === 1`
のような差分比較にそのまま使い、`>= 0` の事前チェックを持たない」歯**を探した。

| ファイル | 該当行 | 同じ盲点を持つか | 対応 |
|---|---|---|---|
| `packages/core/src/__tests__/mark-contested.test.ts` | 357〜359 | ✅ 持つ（Issue #293 の指摘そのもの） | 直した（決定2） |
| `packages/core/src/__tests__/stage3-mandatory-companion-mutation.test.ts` | 131〜132・139 | ✅ 持つ（上の複製） | 直した（決定3） |
| `packages/core/src/__tests__/recall-pipeline.test.ts`「同伴取得された Memory は提示順で必ず隣接する」 | 800〜804 | ✅ 持つ。**しかも `toContain` による事前の存在確認すら無い**——`mark-contested.test.ts` より露出している | 直した |
| `packages/postgres/src/__tests__/recall.postgres.test.ts`「段3/段4: 矛盾の同伴取得は予算に収まらなければペアごと落とす」 | 483〜490 | ✅ 持つ。`toContain` は事前に在るが、隣接性の assert 自体は自立していない | 直した |
| `packages/testkit/src/vector-store-conformance.ts:198`・`packages/testkit/src/lexical-store-conformance.ts:275` | `expect(ids.indexOf(idA)).toBeLessThan(ids.indexOf(idB))` | ⚠ **形が違う**。`Math.abs(...) === 1`（隣接）ではなく `toBeLessThan`（順序）。**理論上は近い病巣**を持つ——片方（`idA`/`fullId`）が完全に不在なら `indexOf` が `-1` を返し、`-1 < 非負の数` が常に真になるため、「本来先頭に来るべきものが丸ごと消えた」場合に**偶然パスしうる**。**ただし Issue #293 が主張している「隣接性の `Math.abs(...) === 1`」とは異なる式であり、この PR の主張（`mark-contested.test.ts` の2盲点を直す）の範囲には入らない**——`docs/autonomy.md` §2「ついでに直さない」に従い、**直さず、ここに記録するだけに留める**。別issueの候補。 | **直していない（報告のみ）** |
| `examples/chat/src/{identifier-arm,time-term-arm,association-arm,archive-sweep-cost,consolidation-cost,retrieval-quality}.ts` | 各所 | ❌ 持たない。**いずれも `indexOf === -1 ? null : index + 1` の形で、`-1` を明示的に「順位無し」へ変換してから使っている**——`-1` が数値のまま比較式に紛れ込む余地が無い。`time-term-arm.ts` 82行目のコメントが同じ懸念を先んじて言語化し、対処済みであることを示している。⛔ 本タスクの制約で `examples/chat` の compare 回帰判定の基準値は触っていない（そもそも触る必要が無かった） | 対象外（既に安全） |
| `examples/chat/src/__tests__/correction-scenario.test.ts` | 55〜57 | ❌ 持たない。むしろ**正しい先例**（`toBeGreaterThanOrEqual(0)` を先に assert している） | 対象外（模範として参照した） |
| その他の `indexOf` ヒット（CLI引数パース・文字列内オフセット探索・マイグレーションSQL文字列検査） | 各所 | ❌ 無関係。ID の配列に対する隣接性/順序比較ではない | 対象外 |

**直したのは4ファイルに限定した**——「同じ盲点（`-1` で偶然成立する `Math.abs(...) === 1`）を
実際に持つもの」だけを本 PR の主張の範囲とし、**形が違う（`toBeLessThan` の順序比較）ものは
理論上近い懸念があっても直さず、報告に留めた**（依頼どおり）。

---

## 採らなかった案

### 案A: `executed` の assert を削除する

Issue #293 が示した二択のもう一方。**採らなかった**——決定1の理由のとおり、
`executed` は「段3のコードパスに入ったか」という、`companionsAdded` とは独立した
情報を持っており、削除すると「`stage` オブジェクトの形そのものが壊れていないか」を
見る手段が1つ減る。コメントで射程を明記するほうが、**情報を捨てずに誤読だけを防げる**。

### 案B: `resolve-contested.test.ts` にも隣接性の assert を足す

ADR 0150／Issue #293 の記述を字面どおり信じるなら「既にある形を保守する」PR に
見えるが、**実際には無い**（上の「前段」で実測した）。足すこと自体は筋が悪くない
提案だが、**「壊れた assert を直す」という本 PR の主張とは別の主張**
（「無いカバレッジを足す」）になる。⟹ **1 PR = 1 主張を守るため採らなかった**。
負債として下に残す。

### 案C: `vector-store-conformance.ts` / `lexical-store-conformance.ts` の順序比較も直す

決定4の表のとおり、**理論上は近い病巣を持つ**が、式の形（`toBeLessThan` 対
`Math.abs(...) === 1`）が異なり、Issue #293 が実測で示した盲点そのものではない。
**「ついでに直さない」を優先し、報告に留めた。**

---

## 引き受けた負債

### 負債1: `resolve-contested.test.ts` に隣接性の assert が無い（案Bの裏返し）

ADR 0150／Issue #293 が「既にある」と誤って記述していたカバレッジは、**実際には
今も無いまま**である。`markContested → recall（隣接）→ resolveContested → recall`
の一巡歯（`resolve-contested.test.ts` 428〜482行目）は、1回目の `recall` で
`toContain` により両者の存在は確認しているが、**提示順が隣接することは検査していない**。
⟹ 段3の隣接性そのもの（`docs/memory-model.md` §5 機構3）は、`mark-contested.test.ts`・
`recall-pipeline.test.ts`・`recall.postgres.test.ts` の3箇所でのみ検査されている。

### 負債2: `vector-store-conformance.ts` / `lexical-store-conformance.ts` の `toBeLessThan` 順序比較は、理論上の同型盲点を残したまま

決定4・案Cのとおり。**「片方が完全に不在なら `-1 < 非負` で偶然パスする」という
構造は残っている。**実際にこの盲点が発火する（=正しい順序で来るべきものが完全に
消える、というバグが実在する）かどうかは、**この作業では確認していない**——
これらは `packages/testkit` の適合テストであり、複数 adapter が使う共通の検査である
ため、直す場合の影響範囲がこの PR の主張より広い。別issueの候補として残す。

---

## 北極星の問いに当てた結果

### 問3: この記憶が選ばれた理由を、後から説明できるか

このADR自体は recall の挙動を変えない（テストのみの変更）ため、直接には効かない。
**間接には効く**——「段3が本当に噛んでいるか」を検査する歯が、実際に噛む形になったことで、
**将来 `recall-runtime.ts` の段3を変更したとき、壊れたら本当に赤くなる**保証が強まった。
これは `explain.stages` が単なる飾りでないことの、テスト側からの担保である。

---

## 測ったこと

**出所: この PR の担い手が、ブランチ `fix/293-stage3-blind-asserts` 上で実際に走らせた。**
**⚠ この作業環境には `DATABASE_URL` が無い**（AGENTS.md）。DB を要する
`packages/postgres` の変更（`recall.postgres.test.ts`）は、**構文・型として妥当であることは
`typecheck`/`lint`/`format:check` で確認したが、実際に Postgres へ対して走らせてはいない**
——CI が実行する。手元で実行して結果を得たのは `packages/core` の3ファイルのみ。

### 1. 直す前: ベースライン（`main` と同一のコード。編集は一切していない）

```
$ pnpm --filter @mnemora/core exec vitest run \
    src/__tests__/mark-contested.test.ts \
    src/__tests__/resolve-contested.test.ts \
    src/__tests__/stage3-mandatory-companion-mutation.test.ts \
    src/__tests__/recall-pipeline.test.ts

 Test Files  4 passed (4)
      Tests  110 passed (110)
```

**この時点で `stage3-mandatory-companion-mutation.test.ts` も緑である**——
つまり「盲点2（隣接性が偶然成立する）」は、**変異体Cに対して、既存の変異試験自身の中でも
緑のまま**だった（`expectRed` に `"adjacency"` が入っていなかったため）。これが
「壊れても緑のまま」の実物である。

### 2. 中間実験: assert の式だけ直し、変異体Cの分類（`expectRed`）を直さずに走らせる

`stage3-mandatory-companion-mutation.test.ts` の `originalAssertions.adjacency` を
決定2の式（`>= 0` を先に assert）へ変更し、**`expectRed` はまだ更新しない**状態で
単体実行した:

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/stage3-mandatory-companion-mutation.test.ts

 ❯ 段3「必須の同伴取得」— 変異体 C: 隣接そのものは崩せなかったので代わりに段3の入口条件を外す…
   × 壊す場所: recall-runtime.ts 620〜625行目 …

AssertionError: expected [Function adjacency] to not throw an error but
'AssertionError: expected -1 to be gre…' was thrown

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

**これが「直した後は赤くなる」の直接証拠である**——`expectGreen`（この変異体では
本来 assert が生き残るはずという分類）に含めたままの `"adjacency"` が、修正後の式では
`indexWeak` が `-1` のため `toBeGreaterThanOrEqual(0)` で落ちる。**修正前は同じ変異体で
このキーは緑のままだった**（上の1番）。**修正が、修正前には検出できなかった壊れ方を
検出できるようになったことの、実測による対比である。**

### 3. `expectRed` を更新し、正しい分類にした最終状態

`C` の `expectRed` に `"adjacency"` を足し（決定3）、`mark-contested.test.ts` にも
同じ式を適用した状態で、再度実行した:

```
$ pnpm --filter @mnemora/core exec vitest run \
    src/__tests__/mark-contested.test.ts \
    src/__tests__/resolve-contested.test.ts \
    src/__tests__/stage3-mandatory-companion-mutation.test.ts \
    src/__tests__/recall-pipeline.test.ts

 Test Files  4 passed (4)
      Tests  110 passed (110)
```

**変異試験は緑に戻り、かつ変異体Cの `adjacency` は「赤くなるはずのもの」として
正しく分類されている**（`expectRed` に載っている状態で `.toThrow()` を要求しているため、
このキーが引き続き `throw` することを、この歯自身が毎回検算し続ける）。

### 4. `packages/core` 全体（触っていないファイルへの影響が無いことの確認）

```
$ pnpm --filter @mnemora/core exec vitest run

 Test Files  57 passed (57)
      Tests  842 passed (842)
```

### 5. 速い門（typecheck / lint / format:check）

```
$ pnpm run typecheck   # 7 workspace すべて Done
$ pnpm run lint        # 出力無し（クリーン）
$ pnpm run format:check
All matched files use Prettier code style!
```

**走らせていないもの**: `pnpm run test`（ルート・全体実行）、`pnpm run build`、
`pnpm run pack:check`、`packages/postgres`・`examples/chat` の DB を要する段。
**理由**: 作業中にマネージャーから「全体実行はせず、触ったファイルの検査と速い門だけを
前景で行い、残りは CI に任せる」という実行方法の制約が追加されたため（この制約が
届く前に typecheck/lint/format:check とパッケージ単位のテストは既に実行済みだった）。
⟹ **build・pack:check・DB 段は CI が初めて実行する。**

---

## 確かめていないこと

- `packages/postgres` 側の変更（`recall.postgres.test.ts`）を、実際に Postgres へ対して
  実行していない（上の「測ったこと」参照。この作業環境に `DATABASE_URL` が無い）。
- `pnpm run build` / `pnpm run pack:check` / ルートの `pnpm run test` を、この作業では
  走らせていない（実行方法の制約による。CI が見届ける）。
- `packages/testkit` の `toBeLessThan` 順序比較（負債2）が、実際に「片方が完全に不在」の
  ケースで偶然パスする状況を**本物の adapter で再現できるかどうか**は確認していない
  ——理論上の構造の指摘に留まる。
- ADR 0150／Issue #293 の「`resolve-contested.test.ts` は既にこの形で書いてある」という
  記述がなぜ事実と食い違ったのか（執筆時の下書きが後で落ちたのか、別ファイルとの混同か）は、
  調べていない。**誤りがあった、という事実だけを記録する。**
- Issue #197 が今も OPEN である理由の全体像。この作業者が確認した範囲では、
  `Runtime.markContested`（ADR 0134）・`Runtime.resolveContested`（ADR 0150）が着地して
  段3は公開 API から到達可能になっており、**「検出経路が1つも無い」という #197 の
  タイトルの字面は陳腐化している**（このことは Issue #303 の本文が既に指摘し、#197 側にも
  コメントを残している、と #303 に書かれている——**この作業者自身は #197 へのコメントの
  実在は確認していない**）。#197 が閉じていない理由が「自動検出（LLM を介さない検出の
  トリガー）がまだ無いから」なのか、「タイトルが更新されないまま放置されているだけ」
  なのかは、**この作業では判定しない**——オーナー側の issue 運用判断であり、本 PR の
  主張（テストの assert を直す）とは別の話である。
  ⟹ **「呼び出し側が0件である」（Issue #303 が指摘した論点）は、本 ADR とは別の問題**
  として明確に切り分ける。#303 自体は本 ADR 執筆時点で `state: CLOSED` だったが
  （`gh issue view 303` で確認）、対応する PR #320 は本 ADR 執筆時点で `state: OPEN`
  のままだった——**この不整合（issue は閉じているが対応 PR がまだ開いている）の理由は
  調べていない。**

---

## これが覆るとしたら

- **`resolve-contested.test.ts` に隣接性の assert を足すことが決まったとき**（負債1）。
  そのときは別 PR として、ADR 0150 の記述を実態に合わせて訂正する一文も添えるべきである。
- **`packages/testkit` の順序比較（`toBeLessThan`）にも `>= 0` の事前チェックを
  要求する方針が採られたとき**（負債2）。複数 adapter の適合テストに影響するため、
  この PR 単体より広い合意が要る。
- **Issue #197 の受け入れ条件が改めて精査され、「自動検出」が別 issue として明確に
  切り出されたとき。**そのときは本 ADR の「確かめていないこと」の最後の項が解消される。
