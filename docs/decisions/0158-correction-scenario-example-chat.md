# ADR 0158: `examples/chat` に訂正シナリオを足す — `contestedPair` は構造としての宣言、判定はしない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

---

## 文脈

[Issue #303](https://github.com/takecchi/mnemora/issues/303) は、`Runtime.markContested`
（[ADR 0134](./0134-mark-contested-explicit-operation.md)）と `Runtime.resolveContested`
（[ADR 0150](./0150-resolve-contested-explicit-operation.md)）を呼ぶ本番コードが `examples/`
配下に0件であることを指摘している。機構（検出・解決）は `packages/core` の歯で一巡することが
確認済みだが、北極星「目指す姿」項目5「間違いを正すと、古いほうが先に出てこなくなる」は、
`examples/chat` から一度も現れていなかった。

issue 本文は、**「配線するだけ」では済まない**ことも明示している。ADR 0134 決定2が
「mnemora 自身は矛盾を自動検出しない。検出は呼び出し側の役目」と決めている以上、
`examples/chat` は**その呼び出し側の実例**として振る舞う必要がある——判定を持ち込んではならない。

---

## 決定

### 決定1: `correction-scenario.ts` に `contestedPair` を構造として持たせる

新設した `ContestedPairDeclaration`(`firstExternalId`/`secondExternalId`/`winnerExternalId`)は、
「この2件は対向し、こちらが勝つ」という**書いた時点で固定された宣言**である。`markContested`/
`resolveContested` を駆動する `correction-demo.ts` はこの宣言をそのまま渡すだけで、
`turns` の並び順・`recordedAt` の大小・「後に observe したほうが勝つ」といった順序規則からは
一切導かない。

**採った理由**: ADR 0134 決定2・ADR 0150 決定1の「判定は呼び出し側が持つ」という設計を、
`examples/chat` という呼び出し側の実例でも同じ形にするため。北極星 問い5
（「LLM を呼ばずに済ませられないか」）にも、そもそも判定を持たないことで自動的に応える。

**検証**: `correction-demo.test.ts`「宣言を逆にする(winnerExternalId=original)と、観測順は
変えずとも勝者が入れ替わる」で、`winnerExternalId` だけを反転させても `observe()` の呼び出し順
（original が先）は変えていないことを固定し、それでも勝者が入れ替わることを実測している。
`correction-demo.postgres.test.ts` に同じ形の対を置き、本物の Postgres に対しても実測する
（CI の場、下記「確かめていないこと」参照）。

### 決定2: `winnerExternalId` も宣言の一部にする(勝者を関数側で決め打たない)

当初案は `correction-demo.ts` 側に「`correction` を勝者にする」ヘルパー関数を置いていたが、
これは実質的に「常に2番目が勝つ」という順序規則を関数の中に固定することになり、
決定1の主張と矛盾する。**`winnerExternalId` をシナリオの宣言そのものに含める**ことで、
「どちらが勝つか」の決定を100%シナリオ側に置いた。

### 決定3: `compare` の⭐門（ADR 0133）への影響は、非DBの歯で機械的に確かめる

この PR は `compare.ts`/`compare-json.ts`/`scenario.ts`/`compare-baseline.json` の
いずれも変更していない。「変えていない」という申告だけでは Issue #303 の受け入れ条件4
「影響が測られている」を満たさないと判断し、`correction-scenario-compare-isolation.test.ts`
を新設した。この歯は:

1. `correction-demo.ts`/`correction-scenario.ts` が `compare.ts`/`compare-json.ts`/
   `scenario.ts`/`probe-set.ts`/`naive-path.ts` のいずれも import していないこと
   （import グラフに実行時の経路が無い）。
2. `compare.ts`/`scenario.ts` のソースが `correction` という語を含まないこと（逆方向の
   依存も無い）。
3. `compare` が実測に使う値（`DEFAULT_COMPARE_SEQUENCE`・`FACT_STATEMENT`・`QUERY_TEXT`・
   `buildConversation` の出力の形）が既知の値のまま変わっていないこと。

を検査する。**構造上ゼロ影響であることを検査した**のであって、`compare-baseline.json` に
対する実際の退行検査そのもの（DB とカセットが要る）は行っていない——それは、この PR を
マージした後の CI の `example-chat` ジョブが確認する（ADR 0133 の既存ゲートがそのまま働く）。

**採らなかった案**: `compare-baseline.json` を含む複数ファイルを新設 PR の中で「予測して」
書き換える案は採らなかった。実測していない数値を基準値ファイルに書くのは
`AGENTS.md`「確かめていないことは『確かめていない』と書く」に反する。

### 決定4: ADR を書くかどうかは着手者の裁量とされた（マネージャーからの訂正）

当初「ADR を1本足すこと」という指示だったが、作業中にマネージャーから訂正が入った——
「(乙)『呼び出し側のアプリが呼ぶ』は ADR 0134 決定2 が指定した場所であり、`examples/chat`
から `markContested`/`resolveContested` を呼ぶのに許可を取るための ADR は不要」との上位判断。
**この ADR は、それでも書くことを選んだ**——理由は、決定1・決定2・決定3が今後
`examples/chat` に別のシナリオ（矛盾検出の別パターン等）を足す人にとって参照価値があると
判断したため。書かない選択肢も残っていた。

**⚠ この ADR は `docs/decisions/README.md` を変更していない。** ADR 0137 の決定により、
索引の再生成はマージ側がマージ直前の PR ブランチ上で行う——ADR を追加する PR の作成者は
索引を触らない。

---

## 採らなかった案

### 案A: `scenario.ts` に訂正の発話を追加する

**採らなかった理由**: `scenario.ts` は `compare`/`cassette-coverage` の入力そのもの
（ADR 0052 のカセット対応表）であり、これを変更すると `compare-baseline.json` に対する
実際の再測定が必要になる——それは指示で明示的に禁じられた領域（⭐門を守るため touch しない
ファイル）である。別ファイル（`correction-scenario.ts`）に切り出すことで、既存の測定条件を
一切共有しない独立したデモにした（`scope.ts`/`backfill.ts` と同じ規律）。

### 案B: 矛盾の判定を「同じ `subjectId` かつ内容が似ている」ヒューリスティクスで行う

**採らなかった理由**: issue 本文・ADR 0134「採らなかった案A」が既に「表層的なヒューリス
ティクスは『類似しているが違う』を『矛盾している』と混同するリスクが高い」と結論している。
同じ案を再提出しない。本 PR のシナリオは、判定を一切せず構造の宣言だけで対を作る。

---

## 引き受けた負債

### 負債1: `correction-demo.postgres.test.ts` を、この作業環境では実行していない

**出所: 環境の制約。**この作業環境には `DATABASE_URL` が無く、`markContestedPair`/
`resolveContestedPair` を実際の Postgres + pgvector に対して実行していない
（ADR 0134/0150 の負債3・4と同じ形）。typecheck は通した。CI の `example-chat` ジョブが
実測の場になる。

### 負債2: 「構造上ゼロ影響」の検査は、import グラフと既知の定数値の一致を見ているだけである

`correction-scenario-compare-isolation.test.ts` は静的な検査であり、`compare-baseline.json`
に対する動的な実測（数値が実際に変わらないこと）はカバーしない。CI の既存ゲート（ADR 0133）
が退行を検出する前提に依存している——本 PR 自身はその実測をしていない。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

このサンプル単体では減らない——ADR 0134/0150 と同じ評価がそのまま当てはまる（機構は既に
実装済みで、本 PR はその呼び出し側の実例を足しただけ）。

### 問2: Background Cognition を無効にしても成立するか

成立する。`correction` サブコマンドは明示的に呼んだときだけ動き、`tick()`/`observe()` からは
呼ばれない（`markContested`/`resolveContested` 自身の性質を、呼び出し側もそのまま引き継ぐ）。

### 問3: この記憶が選ばれた理由を、後から説明できるか

説明できる方向に働く。`formatCorrectionDemo` は `retrievedVia`/`companionOf` を含めて画面に
印字し、「なぜこの2件が一緒に出て、なぜ片方が消えたか」を辿れる形にしている。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

この PR は `provenance.kind` を一切参照・変更しない。

### 問5: LLM を呼ばずに済ませられないか

済ませた。`correction-scenario.ts`/`correction-demo.ts` はどちらも LLM を呼ばない——
矛盾の判定も勝敗の決定も、シナリオが書いた時点で固定した宣言でしかない。

---

## 測ったこと

- `pnpm --filter @mnemora/example-chat run typecheck` — 緑。
- `pnpm run typecheck`(全 workspace) — 緑。
- `pnpm run lint` — 緑。
- `pnpm run format:check` — 緑。
- `examples/chat` の非 DB テスト(`npx vitest run --exclude "**/*.postgres.test.ts"`) —
  **32 files / 326 tests 緑**(このシナリオを足す前の基準値: 29 files / 306 tests。
  差分は新設した3ファイル・20テスト)。
- `pnpm run test`(ルート) — 941 passed / 2 skipped。**DB テストは実行していないと明示して
  通っている**（ADR 0015 の仕様どおり）。
- **変異試験**: `correction-demo.ts` の `resolveContestedIds` を「常に `correction` を
  勝者にする」(=順序規則)へ一時的に書き換え、`correction-demo.test.ts`
  「宣言を逆にする…」が実際に赤くなることを確認してから復元した。同様に、
  `correction-demo.ts` の先頭に `compare.ts` への import を一時的に足し、
  `correction-scenario-compare-isolation.test.ts` が実際に赤くなることを確認してから復元した
  (`git diff` 相当の `diff` でファイルが変異前と一致することも確認済み)。

## 確かめていないこと

- `packages/postgres`/`examples/chat` の DB テストを、実際の Postgres + pgvector に対して
  実行した結果(負債1。CI が実測の場になる)。
- `compare-baseline.json` に対する実際の退行検査(負債2。CI の既存 `example-chat` ジョブの
  `compare` ステップが、この PR のマージ後も基準値と一致することで確認する)。

## これが覆るとしたら

- **`Memory` 型に構造化された属性・値の表現が入り、自動検出が現実的になったとき**——
  ADR 0134「これが覆るとしたら」と同じ条件。そのとき `contestedPair` を人手で書く
  このシナリオの形も、自動生成される形へ置き換わりうる。
