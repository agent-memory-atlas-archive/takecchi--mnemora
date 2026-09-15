# ADR 0160: `examples/chat` の「予算あり/なし」対比デモに歯を足し、`usage.byTier` の新チャンネル漏れを検査する「登録表」の歯を置く（Issue #306）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

---

## 文脈

北極星 項目7「**どれだけ載せるかを、使う側が決められる。**」は、`docs/recall.md` §6 の
`budget`/`usage` として実装済みだった。しかし、それが「外から見て動く例」として成立して
いることを担保していたのは `examples/chat/src/cli.ts` の `runChat()` にインラインで書かれた
対比デモ（budget 無し／`{ budget: { maxMemoryChars: 60 } }` の両方で `recall()` を呼び、
差分を画面に出す）だけであり、**`__tests__` の外にあるため、リファクタで消えても CI は
赤くならなかった**（Issue #306）。

加えて、`docs/recall.md` §6 は「目次帯（`index`）は budget の対象外」、
`recall-runtime.ts:949` のコメントは「連想枠（`association`）は budget の内側」と、それぞれ
別の場所に「どちらの側か」を書いているが、**この2つを1箇所に集めて見張る歯は無かった**。
新しい出力チャンネルを `usage.byTier` に足す人が、それを段4（budget 切り詰め）の算入対象に
含めるかどうかを決め忘れても、機械的には何も赤くならない。

Issue #306 の受け入れ条件は2つ:

1. `cli.ts` の対比デモが実際に「予算あり < 予算なし」を出すことを検査する歯
2. 新しい出力チャンネルを budget の算入から漏らすと赤くなる歯（か、少なくとも漏らしやすい
   箇所の名指し）

---

## 決定

### 1. デモ本体を `examples/chat/src/budget-demo.ts` に切り出す

`scope.ts`（ADR なし、`scope.postgres.test.ts` 参照）・`backfill.ts`（ADR 0037）と同じ形
——**デモ本体（印字を持たない）・機械判定・印字を分ける**——に倣った。

- `TINY_BUDGET_CHARS`（`cli.ts` から移した。`cli.ts` は import する）
- `runBudgetDemo(runtime, ctx, conversation)` — budget 無し／
  `{ budget: { maxMemoryChars: TINY_BUDGET_CHARS } }` の両方で `recall()` を呼び、両方の
  `RecallResult` を返す（印字しない）。**`ctx` に `conversation` が既に ingest 済みである
  ことを前提にする**——これは `queryRecall`（`mnemora-path.ts`）自身の前提と同じであり、
  新しい前提を持ち込んでいない。
- `checkBudgetDemo(result)` — 見せたい性質を機械判定する純関数
- 歯: `examples/chat/src/__tests__/budget-demo.postgres.test.ts`
  （`scope.postgres.test.ts`/`backfill.postgres.test.ts` と同じ規約: `createExampleRuntime`
  に `env: {}` を渡し deterministic を強制、DB は擬似物で代替しない）

`cli.ts` の `runChat()` は、これまでの2回の `queryRecall()` 呼び出しを
`runBudgetDemo()` 呼び出し1回に置き換えた。**印字（`console.log` の呼び出し・文字列）は
1行も変えていない**——`formatRecall`/`buildMnemoraPrompt` の呼び出しと引数はそのままで、
計算結果を先に取ってから同じ順で printする形にしただけである。これは `chat` サブコマンドの
画面出力を1バイトも変えないという制約（⭐ `compare` とは別に、この PR に課された制約）を
満たすための選択であり、`formatBudgetDemo` のような新しい印字関数は**あえて作っていない**
（下記「検討して採らなかった案」）。

### 2. `usage.byTier` の「チャンネル登録表」を歯の側に持つ

`packages/core/src/__tests__/recall-budget-channel-registry.test.ts` を新設した。
`packages/core` 本体には何も追加していない（登録表はこのテストファイル自身が持つ、
検査側の意見であって本体の仕様ではない）。

```ts
const BUDGET_CHANNEL_REGISTRY = {
  full: "inside_budget",
  digest: "inside_budget",
  index: "outside_budget",
  association: "inside_budget",
};
```

歯は3種:

1. **`usage.byTier` にこの表が知らないキーが現れたら赤くなる**（association 無し／
   込みの両方の呼び出し形で検査）。新チャンネルを足した人がこの表を更新しない限り通らない。
2. **`inside_budget` と宣言したチャンネルのうち、実際に駆動できるもの（`digest`/
   `association`）が、きつい予算で実際に落ちることを確認する。**
3. **`outside_budget` と宣言した `index` が、きつい予算でも変わらないことを確認する**——
   ただし「変わらない」の中身は、書いてみて初めて分かった以下の限定が付く。

**この歯は DB を要さない**（`recall-pipeline.test.ts`/`recall-association.test.ts` と同じ
インメモリ経路、`runtime-fakes.ts`）。Issue 本文が「まず歯を書く方向で真面目に試すこと」と
求めていた点は、この形で満たせた——機械的な登録表として書けた。

---

## 実測して分かったこと: `usage.chars` は budget を締めても縮むとは限らない

Issue #306 の本文は受け入れ条件1の検査例として
`withBudget.usage.chars < withoutBudget.usage.chars` を挙げていたが、**これは実データでは
成り立たないことがある**——本 PR で本物の Postgres に対して実測して発見した。

`buildConversation(8)`（`cli.ts` の `chat` が使う既定の会話）を ingest し、
`queryRecall` を budget 無し／`{ maxMemoryChars: 60 }` の両方で呼ぶと:

| | `usage.chars` | `usage.byTier.digest` | `usage.byTier.index` |
|---|---:|---:|---:|
| budget 無し | 346 | 155 | 191 |
| budget あり（`maxMemoryChars: 60`） | **793** | 40 | **753** |

**`chars`（memories tier + 目次帯）は縮むどころか2倍以上に増えた。** 理由は
`docs/recall.md` §5 の被覆不変条件にある——budget が `memories` から押し出した Memory は
「スコープには入ったが段4で落ちたもの」として目次帯（digest 帯）の対象になり、目次帯の
実費（`indexChars`）がその分だけ増える。これは実装の欠陥ではなく、被覆不変条件
（「recall のスコープ内にある全ての Memory は、返り値の中に全文／digest 1行／群カウントの
いずれかで必ず現れる」)が要求する当然の帰結である。

**⟹ `budget-demo.ts` の `checkBudgetDemo` と、その歯（`budget-demo.postgres.test.ts`）は
`usage.chars` ではなく `usage.byTier.digest`（memories tier だけの実費）で「予算を変えると
載る量が変わる」を検査する。** `byTier.digest` は段4の `fits()` が直接縛る量であり、
budget を締めれば構造的に必ず縮む。`usage.chars` の逆説的な増加は、この ADR と
`budget-demo.ts` の doc コメントに実測値として明記し、**画面には出るが検査の根拠には
しない**という扱いにした（`cli.ts` の「まとめ」節が `usage.chars` をそのまま表示し続ける
ことは変えていない——画面出力を1バイトも変えない制約のため。この逆説自体を画面に
説明として足すことは、本 PR の範囲外として送る）。

同じ理由で、「登録表」の歯（`recall-budget-channel-registry.test.ts`）の `index` に対する
検査も、`indexChars`/`byTier.index` の値そのものではなく、段0で確定し budget を一切
参照しない `index.totalInScope`/`index.groups`（第3階・群カウント）の不変性で見ている。
「目次帯は budget の対象外」の実体はここにある。

---

## 検討して採らなかった案

**`formatBudgetDemo(result)` を `scope.ts`/`backfill.ts` と揃えて用意し、`cli.ts` の
印字をそれに差し替える案。** `scope.ts`/`backfill.ts` は「デモ本体・機械判定・印字」の
3関数構成であり、素直に倣うならこの形になる。

**採らなかった理由**: `runChat()` の対比デモの印字は、`formatRecall`/`buildMnemoraPrompt`
という既存の汎用印字関数の呼び出しと、`naive` path の数値を混ぜた「まとめ」節から成り、
budget デモ専用の1つの文字列ブロックとしてきれいに切り出せる形をしていない。
`formatBudgetDemo` を新設してそこへ差し替えると、**`console.log` の呼び出し列・改行位置を
1文字単位で作り直す必要があり**、本 PR に課された「`chat` サブコマンドの画面出力を1バイトも
変えない」という制約に対して検証可能性が落ちる（この sandbox には DB は用意したが、
変更前後の実行結果を исторical に比較する手段が「ソースを読んで計算が同じ順で呼ばれるか」
以上には無い）。**印字を1行も触らない**という、確実に安全側に倒せる選択を採り、
`checkBudgetDemo` だけを歯とデモ本体で共有する2関数構成にした。

**引き受けた負債**: `formatBudgetDemo` が無いため、`scope.ts`/`backfill.ts` との構造的な
対称性は完全ではない（3関数ではなく2関数）。将来 `chat` サブコマンドの出力形式そのものを
見直す機会があれば、そのときに `formatBudgetDemo` を足して `cli.ts` の印字を委譲する形に
揃えるとよい。

**`usage.byTier` に `full` チャンネルも `inside_budget` と宣言したが、実際に落ちることを
検査していない。** `full` は現在の実装で常に `0`（未使用のプレースホルダ、
`recall-runtime.ts` の `usage` 構築部）であり、駆動する経路が無いため検査できない。歯の中に
「引き受けた負債」として明記し、`full` を実際に使うチャンネルが実装された時点でこの歯を
拡張する必要がある、と書き残した。

---

## これが覆るとしたら

- **`usage.chars` の逆説的な増加**（budget を締めると目次帯が伸びて総量が増える）が、
  被覆不変条件の設計変更（例: budget で落ちたものを目次帯の対象から外す）によって解消
  されたら、`checkBudgetDemo`/歯を `usage.chars` ベースの検査に戻せる。ただし
  `docs/recall.md` §5 の不変条件を変える話であり、この ADR の射程を超える。
- **新しい出力チャンネル**（例: 関係グラフ由来の要約、Phase 2 の digest 帯拡張）が
  `usage.byTier` に足されたとき、`recall-budget-channel-registry.test.ts` の
  `BUDGET_CHANNEL_REGISTRY` を更新しなければ最初の歯が赤くなる。これは事故ではなく
  設計どおりの動作である——**赤くなったら、そのチャンネルが budget の内側か外側かを
  決めて表を更新すること。**
- **`full` チャンネルが実際に駆動される実装**が入ったら、
  「引き受けた負債」に書いた検査の欠落を埋める歯を追加する必要がある。

---

## 測ったこと

- `pnpm --filter @mnemora/core exec vitest run`: 51 files / 713 tests 全て pass
  （`recall-budget-channel-registry.test.ts` の6 tests を含む）。
- `pnpm --filter @mnemora/example-chat exec vitest run`（本物の Postgres、ローカルに
  `initdb`/`pg_ctl` で立てた PostgreSQL 17 + pgvector 0.8.0 に対して実行）: 42 files /
  342 tests 全て pass（`budget-demo.postgres.test.ts` の3 tests を含む）。
- `pnpm run typecheck` / `pnpm run lint` / `pnpm run format:check` / `pnpm run build` /
  `pnpm run pack:check`: 全て緑。
- `pnpm run test`（`DATABASE_URL` 未設定）: 「DB テストは実行していません」と明示して
  緑（ADR 0015 の既定どおり）。
- **変異試験（自分の手で壊し、退避コピーから戻した。`git checkout` は使っていない）**:
  1. `recall-runtime.ts` の段4 `fits()` を常に `true` を返すよう書き換え
     （切り詰めを無効化）→ `recall-budget-channel-registry.test.ts` の
     digest/association 落下検査2件・index 不変検査1件の前提部分が赤くなった。
  2. `recall-runtime.ts` の段4切り詰めループを `associationUnits` を対象外にして
     無条件に生き残らせる書き換え（新チャンネルを budget の算入から漏らす典型）
     → 新設した登録表の association 検査、および**既存の**
     `recall-association.test.ts`「予算が厳しいとき、連想の候補が先に落ちて
     budget_dropped に乗る」が両方赤くなった。
  3. `recall-runtime.ts` の `usage.byTier` に未登録のダミーキー
     （`toolCallResult: 0`）を追加 → 登録表の「知らないキー」検査2件が、
     具体的なキー名を含むメッセージ付きで赤くなった。
  4. `budget-demo.ts` の `runBudgetDemo` を「`withBudget` も budget を渡さず呼ぶ」
     ように書き換え（デモが対比を失う典型）→
     `budget-demo.postgres.test.ts` の3件中2件が赤くなった。
  4点とも、書き換えを退避コピー（`cp` で別ディレクトリへ）から戻すと全て緑に復帰した
  ことを確認した。
- `pnpm --filter @mnemora/example-chat run chat`（本物の Postgres）を実際に起動し、
  対比デモの区間（`=== recall()（budget 無し） ===` 〜 `=== まとめ ===`）の出力を目視した
  ——`formatRecall`/`buildMnemoraPrompt` の呼び出し列・引数は変更前と1つも変えていない
  ため、同じ入力に対しては同じ出力になる（本 PR は `console.log` の呼び出し自体を
  1つも書き換えていない、計算の実行順序だけを変えた——ソースレベルで確認済み）。

## 確かめていないこと

- **変更前の `cli.ts`（`origin/main` 時点）と変更後の `chat` サブコマンドの実行結果を、
  実際に2回走らせて diff で突き合わせてはいない。** `tenantId` に `Date.now()` を
  使っており、2回の実行が別テナントになるため単純な diff は無意味になる
  （embedding/LLM が deterministic でも `tenantId` 文字列自体は変わる）。代わりに、
  ソースレベルで「`console.log` 呼び出しを1つも変えておらず、計算順序だけを変えた」ことを
  確認する方法を採った——これは「バイト単位で同一」の直接証明ではなく、
  「同一のはずである」という構造的な論証である。
- `MNEMORA_EMBEDDING=local`/`MNEMORA_LLM=openai` など、deterministic 以外の provider
  モードでこのデモ・歯を走らせてはいない（`createExampleRuntime` に `env: {}` を渡して
  deterministic を強制しているため、CI もこの PR もこの経路は通らない）。
- CI 環境（GitHub Actions）で `budget-demo.postgres.test.ts` /
  `recall-budget-channel-registry.test.ts` を実際に走らせて緑になることは、
  この ADR の執筆時点ではまだ確認していない（PR 本文に CI の job 単位の結果を追記する）。
