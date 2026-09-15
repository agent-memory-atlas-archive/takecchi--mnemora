# ADR 0161: `Runtime.getRecall` を足す — `recall()` の戻り値からは分からない「後から」を、`Runtime` だけを持つ採用側にも届かせる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

---

## 文脈

### Issue #312 が指摘したこと

[ADR 0155](./0155-recall-score-breakdown-persisted.md)（PR #307）で `recalls` に
per-memory のスコア内訳が永続化され、`MemoryStore.getRecall(ctx, recallId)` で
読み戻せるようになった。Postgres・InMemory の両 adapter に実装があり、適合テストも
通っている。

**しかし、それを呼ぶ本番コードは1つも無かった。**[Issue #312](https://github.com/takecchi/mnemora/issues/312)
が `git grep` で確認したとおり、`getRecall(` のヒットは実装本体2件
（`packages/postgres/src/memory-store.ts`・`packages/testkit/.../in-memory-memory-store.ts`）
だけで、呼び出しは0件。加えて:

- **`Runtime` に口が無い**——`packages/core/src/runtime.ts` に `getRecall` という名前は
  一度も出てこない。⟹ `Runtime` だけを持つ採用側は、`MemoryStore` を自分で掴み直さない
  限り、ADR 0155 が作った読み口に到達できない。
- **`examples/chat` に `getRecall`/`explainRecall` の言及が0件**——一度も実演されていない。

`docs/north-star.md`「目指す姿」の逐語（`docs/north-star.md:30`）:

> **なぜそれを思い出したのかを、後から説明できる。**

ADR 0155 は「説明できる」ための行を永続化したが、**「後から」**——`recall()` を呼んだ
その場を離れた後でも届く、という性質——を、`Runtime` という mnemora の主要な公開面に
出さなかった。ADR 0155 自身が「引き受けた負債」・「これが覆るとしたら」の両方で
これを明示的に射程外に置いている:

> **`examples/chat` の配線（Issue #298「何が要るか」5番）。** この PR の範囲に含めて
> いない——範囲判断は要求されておらず、`format.ts` は変更していない。

`docs/north-star.md`「目指す姿」冒頭の逐語:

> **機能の名前ではなく、外から見てどう現れるかで書く。**

⟹ 機構が在るだけでは「在る」ではない。誰も呼ばないなら、外からは存在しないのと同じ
——Issue #312 が挙げるとおり、この形（機構は入ったが呼ぶ経路が無いまま起票された別 issue
に持ち越される）は #303（`markContested`）・#291（連想枠の既定 off）に続く3例目であり、
本 ADR で4例目になる。

### Issue #312 の受け入れ条件のうち、本 ADR が決めること

Issue #312 は「`Runtime` に口を出すのか、`MemoryStore` を直接使う形を文書で示すのかは、
着手する人が決めて ADR に理由を残すこと」を残していた。**本 ADR は前者を選ぶ**——
理由は「決定」節・「検討して採らなかった案」節を見よ。

### 先例: `Runtime.reembed`

`packages/core/src/runtime.ts` の `Runtime.reembed`（ADR 0079）の JSDoc は、
`MemoryStore.requeueEmbedJobs` への素通しについて逐語で次のように書いている:

> 引数と返り値は {@link RequeueEmbedJobsOptions} / {@link RequeueEmbedJobsResult} を
> **そのまま使う**（`TickOptions` のように別の型を立てない）。この口は store の同名
> メソッドへ素通しするだけで、runtime 側が足す選択肢が1つも無いためである——
> 同じ形の型を2つ置くと、片方だけ直したときに黙ってずれる。

`Runtime.getRecall` はこれと**まったく同じ形**——`MemoryStore.getRecall` が返す値に
`Runtime` の側で足す選択肢が1つも無い（`recall()` のように候補生成・スコアリング・
予算処理のような runtime 固有のロジックが挟まる余地が無く、単純な1行読み出しの
中継でしかない）。⟹ 本 ADR は `RecallRecord`（`packages/core/src/recall.ts`）を
**そのまま**返り値の型として使い、新しい型を1つも立てない。

### 北極星の問いに当てた——⭐ 問い1で落ちない理由

ADR 0155 が既に「`recalls` はプロンプトに1バイトも載らない」ことを根拠に問い1
（毎回渡す量を減らす方向に働くか）を通している。本 ADR は**その内訳を読む口を
`Runtime` に生やすだけ**であり、`recall()`/`RecallResult` の形は1バイトも変更しない
——`packages/core/src/recall.ts` の `RecallResultSchema`/`RecalledMemory` は本 PR で
変更していない（`git diff --stat` で確認できる）。`examples/chat` 側の `explain`
サブコマンドも、`compare`/`retrieval-quality` が使う経路（`compare.ts`/`compare-json.ts`/
`naive-path.ts`/`scenario.ts`/`probe-set.ts`/`retrieval-quality.ts`）を一切 import せず、
それらのプロンプト相当の文字列に一切混ざらない、独立したデモである。
⟹ **⭐門（`compare`、ADR 0133）は本 PR で1行も触っていない**——
`git diff --stat origin/main` で `examples/chat/src/compare.ts`・`compare-json.ts`・
`naive-path.ts`・`scenario.ts`・`probe-set.ts`・`examples/chat/compare-baseline.json`・
`scripts/compare-summary*.mjs` のいずれも変更されていないことを確認済み
（「測ったこと」節）。

---

## 決定

### 決定1: `Runtime.getRecall(ctx, recallId)` を薄い素通しとして足す

```ts
getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null>;
```

実装は `createRuntime` 内で `deps.memoryStore.getRecall(ctx, recallId)` へ素通しする
だけ（`packages/core/src/runtime.ts`）。`reembed` と同じ理由で**新しい型を立てない**
——`RecallRecord` をそのまま返す。契約（見つからない・別テナントなら `null`、例外に
しない）も `MemoryStore.getRecall` の契約をそのまま引き継ぐ。

### 決定2: `examples/chat` に独立したサブコマンド `explain` を足す

`examples/chat/src/recall-explain.ts`——`scope.ts` と同じ形式（デモ本体
`runRecallExplainDemo` と純粋な整形関数 `formatRecallExplainDemo` を分離、冒頭 JSDoc に
「北極星の主測定には一切関わらない」旨を明記、`compare.ts`/`compare-json.ts`/
`naive-path.ts`/`scenario.ts`/`probe-set.ts`/`retrieval-quality.ts` を import しない）。

デモの中身:

1. 2件の事実（好きな食べ物・趣味）を `observe` し、`drainEmbedTicks` で embed を
   干上がらせる。
2. 3件目（住んでいる街）を観測するが、**あえて embed を干上がらせない**——
   `embeddingStatus: 'pending'` のまま残す。「索引に載っていない記憶」を1件意図的に
   作り、「なぜ落ちたか」も見せるため。
3. `runtime.recall(...)` を呼び、**返り値からは `recallId` だけを使う**。
4. **別の呼び出しとして** `runtime.getRecall(ctx, recallId)` を呼び、`RecallRecord` を
   得る。表示に使う値（`score` の内訳・`retrievedVia`・`companionOf`/`associationOf`・
   `omitted`・`explain.stages`・`usage`・`indexBand`）は、すべてこの2回目の呼び出しから
   組み立てる——1回目の `recall()` の戻り値を整形し直したものではないことを、
   `formatRecallExplainDemo` が `RecallExplainDemoResult.record`（`getRecall` の戻り値）
   だけを引数に取り、`RecallResult` を一切受け取らない形で保証する。
5. `record.returnedMemories` の各 `memoryId` について `memoryStore.get(ctx, id)` で
   `digest` を引く。
6. 実在しない `recallId`（`crypto.randomUUID()`）で `getRecall` を呼び、`null` を
   実演する。

`breakdownCaptured: false` は「内訳を持たない」と名指しで印字し、スコアを「0」や
「空」に読み替えない（ADR 0008「無い」の分類、ADR 0155 決定2の維持）。`getRecall` が
`null` を返した場合も「見つからなかった」と名指しで印字する——これらはどちらも
DB を使わない歯（`recall-explain.test.ts`）で検査している。

### 決定3: 採らなかった案として `Runtime.explainRecall`（digest を join した合成ビュー）

Issue #312 の受け入れ条件が求めているのは「`recallId` から説明を引く経路」であり、
「1回の呼び出しで digest まで揃った完成品を返す」ことではない。検討した代替案
`Runtime.explainRecall(ctx, recallId)`（`MemoryStore.getMany` で `digest` を join した
合成ビューを返す）は、次の理由で採らなかった:

(a) **新しい型を立てることになり、`reembed`/決定1の先例と逆を向く。**
   `RecallRecord` に `digest` を混ぜた新しい型（例えば `ExplainedRecallRecord`）を
   `Runtime` 側だけに立てると、「同じことを言う道が2つ在り、片方だけ直したときに
   黙ってずれる」という、このリポジトリが繰り返し踏んできた欠陥
   （`TICK_SUPPORTED_JOB_KINDS`・`MAX_STRENGTH` の JSDoc が名指しする族）を新しく作る。

(b) **ADR 0035 が既に引いた線と同じ向きで、join は表示層の仕事である。**
   `RecalledMemory.provenanceKind` の doc コメント（ADR 0035）は「`model`/
   `promptVersion`/`basis`/`confidence` が要るなら `MemoryStore.get()` を引く。そちらは
   『1件を詳しく見る』問いである」と書いている。`digest` の join もまったく同じ形の
   問いであり、`Runtime` の役目（想起パイプラインの実行）ではなく、呼び出し側
   （何を・どう見せるか）の役目である。

(c) **`examples/chat` が実際に join をやって見せることで、その経路が文書ではなく
   動く例として示される。** `provenance-trace.ts` の `resolveExternalId` が
   `MemoryStore.get`/`getObservation` を2段階で呼んで系譜を辿る先例と同じ形——
   `recall-explain.ts` も `memoryStore.get` を呼んで `digest` を引く。`Runtime` 自身が
   この合成を隠すと、「`Runtime` の外にどんな公開 interface があるか」を呼び出し側が
   知らなくても動いてしまい、`MemoryStore` という既存の公開面の存在が見えにくくなる。

**覆るとしたら**: 「`Runtime` しか持たない採用側が `digest` に届かない」ことが、
実際の採用で痛みとして報告されたとき（下の「引き受けた負債」参照）。

### 決定4: `RecallResult` を1バイトも太らせない（ADR 0155 決定4 の維持）

`recall.ts` の `RecallResult`/`RecalledMemory`/`RecallResultSchema` は本 PR で変更して
いない。北極星の問い1が意図して通す形（`recalls` はプロンプトに載らない）を、
読む口を足すこの PR でも崩さない。

---

## 検討して採らなかった案

1. **決定3で述べた `Runtime.explainRecall`（digest 込みの合成ビュー）。** 却下理由は
   上記(a)(b)(c)。

2. **`Runtime` には何も足さず、「`MemoryStore` を直接持て」と文書（README/JSDoc）で
   案内するだけにする。** 却下——Issue #312 が指摘した欠落そのものが「`Runtime` だけを
   持つ採用側が`MemoryStore` を自分で掴み直さない限り到達できない」ことであり、
   文書での案内はこの欠落を追認するだけで埋めない。`reembed`/`sweepArchive`/
   `restoreArchived`/`forget`/`purge`/`markContested`/`resolveContested` はいずれも
   「明示的操作は `Runtime` の口として公開する」という既存の一貫した設計
   （`packages/core/src/runtime.ts` の `Runtime` interface全体）に反する。

3. **`Runtime.getRecall` の戻り値をフォーマット済み文字列（`describeRecall(): string`）
   にする。** 却下——`packages/core` は表示・整形の責務を持たない
   （`docs/architecture.md` の package 分割、`examples/chat/src/format.ts` が整形を
   担う既存の役割分担）。`Runtime` に文字列整形の意見を混ぜると、`packages/core` の
   「zod 以外の実行時依存を持たない・薄い」という性質（AGENTS.md「いまの状態」表）が
   崩れる。整形は `examples/chat/src/recall-explain.ts` の
   `formatRecallExplainDemo`（純関数）に置いた。

4. **`getRecall` を `MemoryStore` と同じく必須メソッドではなく任意（`getRecall?`）に
   する。** 却下——ADR 0155 決定3が既に `MemoryStore.getRecall` を必須にした理由
   （「後から説明できる」を任意機能にすると、それは「後から説明できない」と同じ）が
   `Runtime.getRecall` にもそのまま及ぶ。`MemoryStore` が必須で持つ口を `Runtime` が
   条件付きで隠す理由が無い。

---

## 引き受けた負債・覆えていない範囲

1. 🔴 **`Runtime` だけを持つ採用側は、`getRecall` から `memoryId` とスコア内訳には
   届くが、`digest` には届かない。**`Runtime` には記憶を1件読む口が無いため
   （`MemoryStore.get`/`getObservation` に相当するものが `Runtime` に無い）。
   `recall()` の返り値（`RecalledMemory`）には `digest` が在るのと非対称である。
   `examples/chat/src/recall-explain.ts` が `memoryStore`（`MemoryStore`）を別途
   受け取って `digest` を引いているのは、この非対称を回避するためではなく、
   **この非対称が実在することを動く例として見せるため**である——`Runtime` だけを
   渡された関数は同じことができない。

2. **`explain` デモの facts/query は疑似 embedding の文字コード重なりに依存する
   （`scope.ts` と同じ前提を踏襲しただけで、新規に検証していない）。**
   `DeterministicEmbeddingProvider`（`packages/testkit`）は文字コードの総和を
   バケットに積むだけの実装であり、意味的な関連性を測らない。本 PR の facts/query は
   `scope.ts` の先例（`recall()` が実際に非0件を返すことを CI が確認済みの形）を
   踏襲したが、**このアルゴリズム自体が将来変わった場合にデモが0件を返す可能性は
   検証していない**（DB が無くこの環境では実行できないため。下記「確かめていない
   こと」参照）。

3. **書き込み容量・段トレースの内容そのものについての新しい実測は無い。**
   本 ADR は `getRecall` を読む口として `Runtime` に生やしただけであり、ADR 0155
   「引き受けた負債」1番（書き込み容量を実測していない）を追加で解消していない。

---

## これが覆るとしたら

- **負債1（`digest` に `Runtime` から届かない）が実際の採用で痛みとして報告されたとき。**
  決定3で却下した `Runtime.explainRecall`（digest 込みの合成ビュー）を再検討する材料に
  なる。
- **`RecallRecord` の形が変わったとき**（ADR 0155「これが覆るとしたら」参照）。
  `Runtime.getRecall` は型を複製していない素通しなので、`RecallRecord` 側を直せば
  自動的に追随する——本 ADR がこの構造を選んだ理由そのもの。
- **`packages/core` が表示・整形の責務を持つ設計へ転換したとき**（決定3の却下理由3）。
  そのときは `describeRecall` のような文字列整形口を `Runtime` に足す判断がありうる。

---

## 測ったこと

**出所: この PR の担い手が実際に走らせた。**

| 門 | 結果 |
|---|---|
| `pnpm --filter @mnemora/core run typecheck` | 緑 |
| `pnpm --filter @mnemora/core run test` | `Test Files 50 passed / Tests 710 passed` |
| `pnpm --filter @mnemora/example-chat run typecheck` | 緑 |
| `npx vitest run src/__tests__/recall-explain.test.ts`（`examples/chat` 直下） | `Test Files 1 passed / Tests 5 passed`（DB 不要） |

**変異試験（`docs/autonomy.md` §2 の止まる条件）**:

- `packages/core/src/runtime.ts` の `getRecall` 実装を一時的に
  `return deps.memoryStore.getRecall(ctx, recallId);` → `return null;` に書き換えた
  （退避コピーを `/tmp/runtime.ts.bak` に取ってから書き換え、そこから戻した——
  `git checkout` は使っていない）。`pnpm --filter @mnemora/core run test -- -t getRecall`
  が「createRecall で書いた行を、memoryStore.getRecall と同じ内容で読み戻す」を赤くした
  （`AssertionError: expected null not to be null`）。復元後、同じコマンドで
  `710 passed`（全緑）に戻ることを確認した。
- `examples/chat/src/recall-explain.ts` の `formatReturnedMemories` から
  `breakdownCaptured: false` の警告文を削り、`formatRecordOrMissing` の `null` 分岐を
  `"0件"` に書き換えた（退避コピーを `/tmp/recall-explain.ts.bak` に取ってから書き換え）。
  `recall-explain.test.ts` の該当2本（「内訳を持たない」「見つからなかった」）が
  期待どおり赤くなった。復元後、`5 passed` に戻ることを確認した。

**⭐門を動かしていないことの確認**:

```
git diff --stat origin/main -- examples/chat/src/compare.ts examples/chat/src/compare-json.ts \
  examples/chat/src/naive-path.ts examples/chat/src/mnemora-path.ts examples/chat/src/scenario.ts \
  examples/chat/src/probe-set.ts examples/chat/compare-baseline.json scripts/compare-summary.mjs
```

出力無し（変更0件）。

---

## 確かめていないこと

- 🔴 **DB テストを実行していない。** この作業環境には `DATABASE_URL` が未設定で、
  `docker` コマンドも存在しない（`packages/postgres`/`examples/chat` の `test:db` は
  ADR 0015・0155 と同じ理由でこの環境では走らせられない）。
  `examples/chat/src/__tests__/recall-explain.postgres.test.ts`
  （`getRecall` が `recall()` と同じ `memoryId` 集合をスコア内訳つきで読み戻すこと、
  3件目が `not_indexed(pending)` として `omitted` に現れること、存在しない `recallId`
  で `null` が返ること、の3本）は、**この環境では
  「DATABASE_URL が設定されていません」で即座に失敗することまでしか確認していない**
  ——CI（`DATABASE_URL` が在る）が初めて実行する。
- 負債2（疑似 embedding の文字コード重なりへの依存）の実際のリスク。
- 書き込み容量の実測（ADR 0155 負債1、本 PR でも未解消）。
