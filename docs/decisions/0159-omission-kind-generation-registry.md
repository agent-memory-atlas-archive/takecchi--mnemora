# ADR 0159: `Omission.kind` の11値に「本番コードが実際に生成する」歯を置く — レジストリ＋駆動、grep でも型だけでもなく

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

- **【実測】** — この作業者が実際にコマンドを走らせて得た出力。
- **【現物】** — この repo のコード・文書を実際に読んで確かめた。
- **【受】** — Issue #304 の本文として受け取り、【現物】で裏取りしたもの。

---

## 結論

**`packages/core/src/__tests__/omission-kind-generation.test.ts` を1本足した。本番コード
（`packages/core/src` 等）は1バイトも変えていない。**

この歯は3つのことを同時に固定する。

1. **`Omission.kind` の11値それぞれについて、その kind を積む本番コードの経路を
   実際に駆動し、`recall()` の戻り値の `omitted` にその kind が現れることを見る。**
   11値すべてが `Runtime.recall()`（= `recall-runtime.ts` の `runRecall` 全段）から踏めた
   ——`recall()` 全体からは踏めない種は、いまのところ無い【実測】。
2. **11値のレジストリを `Record<Omission["kind"], OmissionProbe>` で持つ。**
   ⟹ kind を足して probe を書かなければ**キー不足の型エラー**、kind を減らせば
   **余剰キーの型エラー**になる。
3. **型検査に頼らない二重の歯として、実行時にも
   「レジストリのキー集合 == `OmissionSchema`（`z.discriminatedUnion("kind", …)`）の
   判別子の集合」を突き合わせる。**
   併せて、`examples/chat/src/compare.ts` の網羅性の歯（`const exhaustive: never = o;`）が
   `formatOmittedSummary` に残っていることを、ソース文字列の検査として固定する。

---

## 問い（Issue #304、北極星 項目6の**維持**）

Issue #304 は【受】、**欠陥の報告ではない。**本文が明示している:

> `Omission.kind` 11種すべてに本番の生成コードと歯が在ることを main=`1e65592` で種ごとに
> 数え直した。⟹ **この issue は欠陥の報告ではなく、「在る」を維持する歯の要求である。**

守りたいのは `docs/north-star.md` の項目6【現物】:

> **知らないことを、知らないと言える。**——「見つからなかった」と「探していない」を、
> 同じ顔で返さない。

**この項目の実装が `Omission` の union そのものである。**種が黙って増減すると、
「この種の『無い』は、そもそも報告されなくなった」という退行が**誰にも見えない形で**起きる。

**現状の守りは1箇所だけだった**【現物】。`examples/chat/src/compare.ts` の
`formatOmittedSummary` にある `const exhaustive: never = o;` である。これは

- **型が増えたら気づく**歯ではあるが、
- **本番コードがその kind を実際に生成するか**については何も言っていない。

そして、**この穴は実際に踏まれている**【受】——`unit_assembly_dropped` は
「口は在るが駆動する側が無い」種であり、PR #285 が `docs/recall.md` を訂正するまで
「Phase 1 では発生しない」と誤って書かれていた。

---

## 現物で確認した — 既にある歯は、何を言っていて何を言っていないか

### `packages/core/src/__tests__/recall.test.ts`（schema の歯）

【現物】次の形が並ぶ:

```ts
it("accepts 'over_limit'", () => {
  const result = OmissionSchema.safeParse({ kind: "over_limit", count: 5, countKind: "exact" });
  expect(result.success).toBe(true);
});
```

**期待値をテスト内で手で組み立てて schema に通している。**⟹ 言えるのは
「schema がこの形を受け付ける」だけであり、**その kind を積む本番コードが在るかどうかに
ついては一言も言っていない。**union に値だけ足して生成コードを1行も書かなくても、
この形の歯は緑のまま増やせる。

### `packages/core/src/__tests__/unreachable-union-values.test.ts`（ADR 0117 / 0144 の歯）

【現物】出荷対象パッケージの `src/` を静的に走査し、`field: "value"` というオブジェクト
リテラルの構築が**0件であること**を主張する。**向きが逆である**——あちらは
「型に在るのに生成されない値」を数える。

**そして、仮に向きを反転させて「1件以上あること」を主張しても足りない**——
`grep` が言えるのは「`omitted.push({ kind: "x", … })` という行が在る」までであり、
**その行に到達する条件が実在するか**は何も言えない。到達不能な分岐に書かれていても
grep は緑になる。Issue #304 が踏み抜いた `unit_assembly_dropped` の件は、まさに
「行は在るが駆動する側が無い」形だった。

### `recall-pipeline.test.ts` / `recall-channels.test.ts` / `recall-association.test.ts`

【現物】個々の kind については、本番経路を駆動する歯が既に在る（11値すべてについて
少なくとも1本ずつ見つかった。この ADR の歯は、その状況設定をほぼそのまま借りている）。
**しかし、それらは網羅であることを主張していない**——**kind を1つ足しても、どのファイルも
赤くならない。**足りないのは個々の歯ではなく、**網羅性そのもの**だった。

---

## 決めたこと

### 1. レジストリを `Record<Omission["kind"], OmissionProbe>` にする

`OmissionProbe` は「その kind を本番コードに生成させる手順」そのものである。
`run()` は `Runtime.recall()` を呼び、**その戻り値の `omitted` をそのまま返す。**
テスト側は `{ kind: "…", count: … }` を1バイトも組み立てない——
**`expect` の左辺は必ず本番コードの戻り値である。**

`Partial<>` や index signature にしないことが、この歯の芯である。

### 2. 実行時にも、レジストリと zod schema の判別子集合を突き合わせる

**これは型の歯の重複ではない。**【現物】`OmissionSchema` は `Omission` 型に対して
`satisfies` で束ねられていない（束ねているのは各枝の `StageSkippedOmissionSchema` 等
だけであり、`z.discriminatedUnion` の結果には `satisfies z.ZodType<Omission>` が付いて
いない）。⟹ **TS の union と zod の union がずれても、型検査だけでは気づかない。**
レジストリを蝶番にして両方へ当てると、そのずれもここで捕まる。

判別子は `OmissionSchema.options.map((o) => o.shape.kind.value)` で **schema 自身から引く**
——宣言を散文で書き写さない（ADR 0082 が `TICK_SUPPORTED_JOB_KINDS` について引いた線と同じ）。

### 3. `compare.ts` の網羅性の歯の固定は、`packages/core` 側に置く

**置き場所は「その検査が走る CI ジョブが在るか」で決めた**【現物】。

- `examples/chat/package.json` の検査スクリプトは **`test:db`**（`test` ではない）。
  ⟹ ルートの `pnpm run test` が呼ぶ `pnpm -r --if-present run test` からは**呼ばれない。**
- 走るのは CI の `example-chat` ジョブだけで、そのジョブは**本物の Postgres を要求する**
  （AGENTS.md / ADR 0015）。⟹ あちらへ置くと「DB が立っているときだけ噛む歯」になる。
- `packages/core` の test は、required ジョブ `typecheck / lint / test / build` の
  `pnpm run test` ステップで **DB 無しに**走る
  （required の6文字列は `gh api repos/takecchi/mnemora/branches/main/protection` で確認【実測】）。

⟹ **DB の有無に依存しない歯にするため、`packages/core` 側に置いた。**
`unreachable-union-values.test.ts` が既に `packages/core` の test から他パッケージの `src/` を
`fs` で走査している先例に倣う（新しい依存は増えない——`node:fs` だけである）。

### 4. `unit_assembly_dropped` については、**種を植える側の限界を明記する**

11値のうちこの1値だけが、「`recall()` の無条件の分岐」ではなく**一対一
（`contestedWithId`）の破れ**という*データの状態*に依存する【現物、Issue #304 本文と一致】。

そして `Runtime.markContested`（ADR 0134）は**両側 `status='active'` の CAS を課したうえで
相互参照を1トランザクションで書く**ため、**`Runtime` 経由で作られた contested ペアが
一対一を破ることは無い**（`recall-runtime.ts` 段3 のコメントが同じことを述べている【現物】）。
`resolveContested`（ADR 0150）も両側の `contestedWithId` を `null` へ戻して決着させる経路で
あり、破れを作らない。

⟹ **破れた状態を作るには `MemoryStore` を直接叩くしかない**（`MemoryStore` も
`@mnemora/core` の公開 interface であり、ADR 0046 が実測したとおり
`updateStatus(id, "contested")` は今日も外から呼べる）。

**正直に分けて書ける形にした**——この probe だけ `seedingCaveat` 欄を持ち、テストの
doc コメントに次を明記してある:

- **言える**: `omitted` にこの kind を積んでいるのは `recall()` の本番コードである。
- **言えない**: `Runtime` の公開操作**だけ**でこの状況に至れる、とは言っていない。

併せて、**`Runtime.markContested` だけで正しく張ったペアでは、この kind が出ないこと**
（鳴ってはいけない側）を同じ足場で1本だけ対照した——probe が「いつでも鳴る」わけでは
ないことを示すため。

### 5. `drivenThrough` 欄を置き、「踏めない種」が出たら名乗らせる

Issue #304 の依頼は「経路が本当に `recall()` 全体からは踏めない種が在れば、下位関数を
直接駆動してよい。**その場合は正直に書くこと**」だった。**現時点ではその種は無い**
【実測】——11本すべてが `Runtime.recall()` を通っている。

将来踏めない種が現れたときに黙って `it.skip` へ逃げられないよう、
**「全 probe の `drivenThrough` が `"recall()"` である」ことを歯にした。**
踏めなくなったら、その欄を書き換える＝この歯が赤くなる＝PR でその事実を説明することになる。

---

## 採らなかった案

### (a) ソース grep だけで済ませる（`unreachable-union-values.test.ts` の向きを反転させる）

**採らなかった。**`omitted.push({ kind: "x", … })` という**行が在ること**しか言えず、
**その行へ到達する条件が実在するか**を一切主張しない。到達不能な分岐に書かれていても緑になる。
Issue #304 が名指ししている `unit_assembly_dropped` の誤記（「Phase 1 では発生しない」）は、
まさに「行は在るが駆動する側が無い」形で起きた——**grep で守れていたなら、あれは起きていない。**

**ただし、grep 型の歯を全否定したわけではない。**受け入れ条件4つ目
（`compare.ts` の `const exhaustive: never = o;` が残っていること）については**採った**
——あそこで守りたいのは「型検査に掛かる文が在ること」そのものであり、実行して観測できる
振る舞いではないからである。**道具の選択は、守りたいものの性質で変える。**

### (b) 型の exhaustive check だけで済ませる（`const exhaustive: never` を core 側にも置く）

**採らなかった。**`compare.ts` に既に在るものと同じ性質のものが1本増えるだけで、
**「本番コードがその kind を生成するか」については依然として何も言わない。**
Issue #304 の受け入れ条件の1つ目（「本番の生成コードが在ることを機械的に検査する」）に
答えていない。

**⚠ 逆に、型の歯を捨てもしなかった。**レジストリを `Record<Omission["kind"], …>` にした
のは、まさにこの型の網羅性を使うためである——採らなかったのは「型**だけ**で済ませる」案であり、
型の歯そのものではない。

### (c) 期待値をテスト内で組み立てて `toContainEqual` で比べる（`recall.test.ts` の形を11値へ広げる）

**採らなかった。**これは Issue #304 の依頼文が名指しで禁じた形である
（「期待値をテスト内で手で組み立てて比べるだけの形にはしないこと——それでは『生成経路が在る』ことを
何も言っていない」【受】）。**同意する**——`safeParse` に手組みの値を通すのは schema の歯であって、
生成経路の歯ではない。

**ただし、`OmissionSchema` そのものは使っている**——本番コードが**作った**値を schema に通す。
向きが逆であり、比べる相手が本番の出力検証と同じ1つの出所である点が違う。

### (d) レジストリを `packages/core/src` 側（本番コード）に置き、テストから引く

**採らなかった。**本番コードの挙動を変えない、という Issue #304 の制約に触れる
（公開される型・値が1つ増える）。この歯は**検査の都合**であって、ライブラリの利用者に
提供する情報ではない。ADR 0117 の歯が `__tests__` の中で完結しているのと同じ判断である。

### (e) `examples/chat` 側に `compare.ts` の歯を置く

**採らなかった。**上記「決めたこと」3番のとおり、あのパッケージの検査は
`test:db` であり、CI の `example-chat` ジョブ（**DB 必須**）でしか走らない。
「DB が立っているときだけ噛む歯」になる。

---

## 引き受けた負債

- **各 kind について、駆動しているのは「1つの状況」だけである。**例えば `stage_skipped` は
  `reason` を4つ持つが、レジストリの probe が踏むのは `empty_query_content` の1つだけ。
  残りは既存ファイル側の歯が受け持つ（`recall-association.test.ts` /
  `recall-pipeline.test.ts`）。⟹ **この歯が主張するのは「kind ごとに生成経路が
  少なくとも1本在る」まで**であり、`reason` / `condition` の各値の網羅ではない。
  **`FilteredOmission.condition` の値レベルの棚卸しは、ADR 0117 の歯が別の向きで持っている。**
- **足場（`buildRuntime` / `newMemory` / `createEmbeddedMemory` / `CappedVectorStore`）を
  `recall-pipeline.test.ts` 等から複製した。**既存のテストファイルから import すると、
  向こうの都合（歯④が `lexicalStore` を外す等）がこちらの合否に効いてしまうため、
  意図的に独立させた（`runtime-fakes.ts` 冒頭が `packages/testkit` について述べているのと
  同じ理由）。⟹ **`runtime-fakes.ts` の API が変わると、直す箇所が1つ増える。**
- **`compare.ts` の検査はソース文字列の一致である。**`const exhaustive: never = o;` が
  **在ること**は分かるが、それが到達可能な位置に在るか・コンパイラが実際にその型検査を
  行ったかは言えない。それを言うのは `pnpm typecheck`（`examples/chat` も対象）の仕事であり、
  **この歯は「typecheck が見る対象が消えていないこと」までしか守らない。**
- **「11」という数をこの歯が持っている。**`expect(schemaKinds).toHaveLength(11)` は、
  kind が正当に増えたときにも赤くなる。**これは意図した設計である**（増減の合図として使う）が、
  **正当な増加のときに ADR とこのファイルの記述を直す作業が毎回1つ増える。**

---

## これが覆るとしたら

- **`Omission` の union が「11値」でなくなったとき**——この ADR の本文と、テストの
  `toHaveLength(11)`、および `docs/recall.md` §4 の記述を揃え直す。
  **歯を消すのではなく、数を直す。**
- **`recall()` 全体からは踏めない kind が現れたとき**——`drivenThrough` を
  `"recall-runtime.ts の下位関数"` に書き換える。その瞬間に「全 probe が `recall()` を
  通している」歯が赤くなる。**それがこの歯の正しい反応である**（黙って踏めなくなることを防ぐ）。
- **`examples/chat` の検査スクリプトが `test` にも登録されたとき**——
  「決めたこと」3番の置き場所の根拠（DB 必須ジョブでしか走らない）が消える。
  そのときは `compare.ts` の歯を `examples/chat` 側へ移すほうが素直になる。
- **関係グラフ本体（Phase 2）が入り、`contested` の一対一を `Runtime` 側で破れるように
  なったとき**——`unit_assembly_dropped` の `seedingCaveat` が不要になる。
  **そのときは欄を消す**（消し忘れると、実態より弱く自己申告し続けることになる）。

---

## 測ったこと【実測】

### 手元の門

```
$ pnpm run typecheck
… packages/core typecheck: Done / examples/chat typecheck: Done（全7プロジェクト Done）
$ pnpm run lint            # エラー無し
$ pnpm run format:check    # All matched files use Prettier code style!
$ (packages/core) npx vitest run
 Test Files  51 passed (51)
      Tests  724 passed (724)
```

### 変異試験

**4つ試した。それぞれ、退避コピー（`cp`）から復元し、`git diff` が空であることを確認した**
（`docs/autonomy.md` §4「`git checkout <file>` で変異を戻すと未コミットの編集も消える」の穴を
踏まないため）。出力は PR 本文の「測ったこと」節に全文を貼ってある。要約:

| 変異                                                                      | 型（`tsc`）                                                                                                                                                                        | 実行時（この歯）                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **A: kind を1つ足す**（`mutation_probe` を union と zod schema へ）       | `packages/core`: `Property 'mutation_probe' is missing in type … Record<…>`／`examples/chat`: `compare.ts(185,17): Type 'MutationProbeOmission' is not assignable to type 'never'` | 2件赤（判別子が12個・集合不一致）           |
| **B: レジストリのエントリを1つ消す**（`lexical_truncated`）               | `Property 'lexical_truncated' is missing in type …`                                                                                                                                | 1件赤（集合不一致）                         |
| **C: kind を1つ減らす**（union と zod から `lexical_truncated` を落とす） | `'lexical_truncated' does not exist in type 'Record<…>'`（余剰キー）ほか2件                                                                                                        | 3件赤（probe 本体・判別子の数・集合不一致） |
| **D: `compare.ts` から `const exhaustive: never = o;` を消す**            | （型は通ってしまう——default 節を素の return にしたため）                                                                                                                           | 1件赤（`formatOmittedSummary` に歯が無い）  |

**⚠ D は、この歯が型検査の代わりになった唯一の例である。**`default` 節を
`return "unknown";` に書き換えると**型エラーは1件も出ない**——網羅性の歯が静かに消える。
⟹ **受け入れ条件4つ目（ソース文字列の検査）は、型では代替できない。**

---

## 確かめていないこと

- **DB を要する検査は実行していない。**この作業環境に Postgres は無い
  （`packages/postgres` / `examples/chat` の `test:db`）。**DB 側は CI の3ジョブで見届ける。**
- **フェイクの store / provider しか使っていない。**⟹ **「本番の生成コードが在る」ことは
  言えるが、「本物の Postgres + pgvector でも同じ条件で同じ kind が出る」とは言っていない。**
  adapter の挙動差が絡む kind（`ann_unreached` 等）については特に。
- **`examples/chat` の `compare` 出力（⭐門）は一切触っていない**が、`compare` を実際に
  走らせて出力が同一であることまでは確認していない（DB が要るため）。
  **根拠は「`examples/chat/src` を1バイトも変えていない」という `git diff` のみ**である。
- **`Omission` 以外の union（`MemoryEventKind` 等）に同じ形の歯を広げるべきかは検討していない。**
  Issue #304 の射程は `Omission.kind` である。
- **ADR 番号について**: `git fetch origin main` 時点の main の最大は **0157** だったが、
  **開いている PR #320 のブランチが既に `0158` を使っている**ことを
  `git ls-tree -r --name-only origin/feat/303-correction-scenario-example-chat docs/decisions` で
  確認したため【実測】、`docs/autonomy.md` §4「ADR 番号の衝突」に従って **0159** を取った。
  **他の open PR（#308/#311/#314/#322/#323/#324）のブランチには 0158 以降の ADR は無かった**が、
  **この確認の後に新しい PR が開かれていないことは確かめていない。**
