# ADR 0162: `examples/chat` に訂正シナリオを足す — `contestedPair` は構造としての宣言、判定はしない

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

### 決定5: `recall()` に `limit: 1` を明示し、`checkCorrectionDemo` を段2のランキング順に依存しない形へ直す（PR #320 の CI 失敗の修正）

**背景（現物で確認した）**: 決定1〜4を実装した PR #320 は CI で赤かった——
`correction-demo.postgres.test.ts` の `expect(check.afterMarkCompanionRetrieval).toBe(true)`
が `false` で落ちる。原因は、`recall-runtime.ts` 段3（`docs/recall.md` §2 段3）の
必須同伴取得が**「対向が既に `withinLimit`（段2の再スコアで残った集合）に居なければ」
だけ発火する**設計であること。このシナリオは `original`/`correction` の2件しか
Memory を持たないため、既定の `RecallQuery.limit`（`DEFAULT_RECALL_LIMIT = 10`、
`packages/core/src/recall.ts:1136`）では**両方が独立に `withinLimit` へ収まってしまい**、
段3の同伴取得が一度も発火しなかった。

デバッグ用のスクリプトで `result.afterMark.memories` を実際に印字して確認した
（`markContested` 直後、既定 limit=10 での実測）:

```
{"memoryId":"...(original)","retrievedVia":"ann", ...}
{"memoryId":"...(correction)","retrievedVia":"ann", ...}
```

両方とも `retrievedVia: "ann"` であり、`"mandatory_companion"` が一件も無い。
`packages/core/src/recall-runtime.ts` の段3実装・`docs/recall.md` §2 段3
（「`contested` は単独で返してはならない——相手を必ず一緒に取得する」）を読み直しても、
**これは `packages/core` のバグではなく、仕様どおりの動作**である——両方が既にスコアで
出ているなら、対向を「強制的に」連れてくる必要が無い。**⟹ 根本原因はデモ側（このシナリオの
組み立て）にあり、`packages/core` は変更していない。**

**採った修正**: `correction-demo.ts` の3回の `recall()` すべてに `limit: 1` を明示する
（`buildRecallQuery`）。`limit: 1` にすると段2の `withinLimit` には1件しか残らず、
残った側が `contested` である限り、対向は limit を超えて強制的に連れてこられる
（実測: `afterMark.memories.length` は limit=1 でも 2 になる。下記「測ったこと」）。
これにより Issue #197 の受け入れ条件「段3 が実際に発火することを測る歯が在る」を
`examples/chat` からも満たす。

**⚠ ここで新たに気づいたこと（現物で確認した）**: `limit: 1` にすると、
**段2のランキングで「アンカー」(=limit 内に自然に残る側) になるのは
`resolveContested` の勝者（`correction`）とは限らない。** 実測では、この決定的
provider・固定テキストの組では **`original` がアンカーになり `correction` が
mandatory_companion として連れてこられた**（デバッグスクリプトの実測、下記
「測ったこと」）——PR #320 の `checkCorrectionDemo` が仮定していた
「敗者側（`original`）が常に mandatory_companion になる」という前提と**逆**である。
段3の同伴取得は`resolveContested`が下す勝敗判定より前に走る、段2のスコアだけで
決まる処理であり、両者は独立している。⟹ `checkCorrectionDemo`
（`afterMarkCompanionOfWinner`）が「`original` が同伴になり `companionOf` が
`correction` を指す」ことを決め打っていたのは、**ランキングの勝敗に依存する
脆い検査**だった。

**採った修正2**: `CorrectionDemoCheck.afterMarkCompanionOfWinner` を
`afterMarkCompanionOfOther` に改名し、`checkCorrectionDemo` を
「`original`/`correction` のどちらか片方が `mandatory_companion` で、その
`companionOf` がもう片方の `memoryId` を指しているか」という、**どちらが
アンカーでどちらが同伴かを決め打たない形**に書き換えた。北極星の核心
（`afterResolveOriginalAbsent`——訂正後に古いほうが出てこない）は一切変えていない。

**検証**: `correction-demo.test.ts` に、mandatory_companion がどちらに付いても
（`original` 側でも `correction` 側でも）正しく検出できることを固定した4テストを
新設した（「mandatory_companion がどちらに付くかを決め打たない」describe）。
うち1本は、段3が発火しなかった場合（両方 `retrievedVia: "ann"`）に
`afterMarkCompanionRetrieval` が正しく `false` になることを固定しており、
これが PR #320 の元の障害そのものの回帰検査になっている。

**採らなかった案**: `afterMarkCompanionRetrieval` の期待値を `false` に変えて
テストを通す案・当該アサーションを削除する案は、いずれも採らなかった——
シナリオの意味（段3が実際に発火することを示す）が壊れるため。

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

### 負債1（決定5で解消）: `correction-demo.postgres.test.ts` を、この作業環境では実行していなかった

**PR #320 時点の出所: 環境の制約。**当時の作業環境には `DATABASE_URL` が無く、
`markContestedPair`/`resolveContestedPair` を実際の Postgres + pgvector に対して
実行していなかった（ADR 0134/0150 の負債3・4と同じ形）——そしてこの負債が実際に
CI の失敗として顕在化した（決定5参照。手元で実行していれば PR #320 の時点で
気づけた）。**この修正作業の環境には `DATABASE_URL` を用意できる Postgres 17 +
pgvector 0.8.0 が入っていたため、`initdb` で一時クラスタを立てて実際に実行し、
赤→修正→緑を確認した**（下記「測ったこと」）。CI の `example-chat` ジョブ・
「ルートの test 門の DB 段」（`root-gate-db-stage`）は引き続き継続的な実測の場である。

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

### PR #320 時点（元の作業者。この記録は履歴として残す——書き換えない）

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

**⚠ この時点の「確かめていないこと」（DB を実行していない・compare-baseline に対する実際の
退行検査をしていない）が、そのまま CI の失敗として的中した**（決定5）。DB を実行していれば
PR #320 の時点で気づけた欠陥だった。

### 決定5（この修正、`DATABASE_URL` を実際に用意して実測）

この作業環境には `psql`/`initdb`/`pg_ctl`（Postgres 17）と pgvector 0.8.0 の拡張が
入っていたため、`initdb` で一時クラスタを立てて `DATABASE_URL` を実際に用意した
（`packages/postgres` のマイグレーションも実行した上で計測）。

- **再現**: 修正前のコードで `correction-demo.postgres.test.ts` を実行し、PR #320 と
  同一の失敗（`afterMarkCompanionRetrieval` が `false`）を実際に再現した。
- **現物の証拠**: デバッグ用スクリプトで `markContested` 直後の `recall()`（既定
  limit=10）の `afterMark.memories` を印字し、両方とも `retrievedVia: "ann"`
  （`mandatory_companion` が0件）であることを確認した——上の「決定5」節に実測 JSON
  を引用済み。
- `pnpm run typecheck`（全 workspace） — 緑。
- `pnpm run lint` — 緑。
- `pnpm run format:check` — 緑（`prettier --write` で2ファイルを整形してから）。
- `pnpm run build` — 緑（`rm -rf packages/*/dist` してから）。
- `pnpm run pack:check` — 緑。
- `pnpm run check:cjs-parse` — 緑（93 個の配布物）。

**⚠ 途中で `origin/main` が2回動いた**（作業開始時点の `442e199` から、この修正の作業中に
`980d3ea`/`8abfb0c` まで進んだ）。`8abfb0c`（PR #323、association-probes ベンチ、
Issue #291）が **`docs/decisions/0158-association-probes-bench.md` を先に main へ着地**
させたため、当初この ADR に振っていた `0158` が衝突した——いったん **`0160`** へ
採番し直した（`0159` は当時 open だった PR #325 が名乗っていたため避けた）。

**その後、PR を出す直前に `origin/main` を再度取り込んだ時点で、番号はさらに動いていた**
——PR #325（`0159-omission-kind-generation-registry.md`）が main へ着地して `main` の
最大が `0159` になり、**さらに open の PR #330 が `0160` を名乗っていた**
（`docs/decisions/0160-budget-demo-teeth-and-channel-registry.md`）。いったん `0161` を
採ったが、**`0161` も並行 PR #328 と衝突していた。**

⟹ **この繰り返し自体が、「マージ直前に各 PR が自分で採番し直す」という運用の破綻を示した。**
オーナーが**番号を中央で配る**方式へ切り替え、本 ADR には **`0162`** が割り当てられた
（同時の割り当て: #330→`0160`、#328→`0161`、#305→`0163`、#280→`0164`、#301→`0165`、
#306→`0166`、#316→`0167`）。**⟹ 以後、この ADR の番号をマージ直前に採り直さないこと。**

⚠ **この節の数値は、ADR がまだ `0160` という名前だった時点で測ったものである。**
`0161`／`0162` への改名で変えたのは ADR ファイル名と、それを参照する doc コメント／
テストの文字列だけであり、**測定対象のコードは一切変えていない**——したがって下の数値は
そのまま有効だと考えているが、改名後に全門を測り直してはいない
（下記「確かめていないこと」）。以下は `origin/main` をこのブランチへ merge した**後**に
実行した最終値である（マージ前の途中経過の数値は上書きしていない——このセクションの
直前の値は、マージ前に実際に測った数値として残す）。

- `DATABASE_URL` **無し**での `pnpm run test`（ルート、merge 後） — **1023 passed /
  2 skipped**（54 files passed / 1 skipped）。DB テストは実行していないと明示して通った
  （ADR 0015 の仕様どおり）。
- `examples/chat` の非 DB テスト(`npx vitest run --exclude "**/*.postgres.test.ts"`) —
  merge 前は **32 files / 330 tests 緑**（PR #320 時点の326から+4——今回追加した
  「mandatory_companion がどちらに付くかを決め打たない」describe の4テスト）。
- `examples/chat` の全テスト（`.postgres.test.ts` を含む、`DATABASE_URL` 在り、merge 後） —
  **47 files / 384 tests 緑**（merge で association-probes 関連のテストファイルが増えた
  分、merge 前の45 files/365 testsから増加）。`correction-demo.postgres.test.ts` の
  2テストを含む。
- `DATABASE_URL` **在り**での `pnpm run test`（ルート、「ルートの test 門の DB 段」
  ＝ CI の `root-gate-db-stage` ジョブが実測する経路そのもの、merge 後） — **緑**。
  `scripts/run-db-tests.mjs` が「DATABASE_URL が設定されているため、DB テストを
  実行します（接続先: PostgreSQL 17.11 / pgvector 0.8.0）」と明示した上で、
  `packages/postgres` の `test:db` が **43 files / 488 tests 緑**、
  `examples/chat` の `test:db` が **47 files / 384 tests 緑**、最後に
  「✔ DB テストも実行し、通りました。」で終了コード0。
- `node scripts/generate-adr-index.mjs --check`（`docs/decisions/README.md` の鮮度検査） —
  このブランチでは既知の理由で赤い（「索引が ADR 154本を反映していない」）。ADR 0137 の
  設計どおり——ADR を追加する PR の作成者は索引を更新しない。マージ側がマージ直前の
  PR ブランチ上で `node scripts/generate-adr-index.mjs` を実行する（`docs/autonomy.md`
  §4「ADR PR をマージするとき、索引の再生成を忘れる」の手順）。
- **`compare` を実際にローカル DB に対して実行し、`compare-baseline.json` と突き合わせた**
  （負債2の解消）: `DATABASE_URL=<ローカル> npx tsx src/cli.ts compare` を実行すると
  `OPENAI_API_KEY` 無しでも `examples/chat/cassettes/compare.json`（記録済みカセット）
  により `recorded` モードで走った。出力した `compare.json` を
  `node scripts/compare-summary.mjs --measured <出力> --baseline
examples/chat/compare-baseline.json` に通したところ、**「✅ 一致(差分なし)。全会話長で
  北極星の物差し(mnemoraShareOfNaiveChars 他)が examples/chat/compare-baseline.json と
  同じだった」（exit 0）**。⟹ 決定3の「構造上ゼロ影響」の静的検査に加え、**動的な実測
  でも `compare` の⭐門（ADR 0133）に影響が無いことを確認した**——この PR は
  `compare.ts`/`scenario.ts`/`compare-baseline.json` のいずれも変更していないので、
  数値が変わらないこと自体は自然だが、「変わらないはず」ではなく「変わらなかった」を
  実測で示せた。
- **変異試験1（決定5の核）**: `buildRecallQuery` の `limit: 1` を一時的に `limit: 10`
  に戻し、`correction-demo.postgres.test.ts` が PR #320 と同一のメッセージ
  （`afterMarkCompanionRetrieval` が `false`）で実際に赤くなることを確認してから、
  `cp` で退避しておいたコピーから復元した（`docs/autonomy.md` §4 の教訓どおり
  `git checkout` は使っていない）。復元後、`diff` でファイルが変異前と完全一致する
  ことも確認した。
- **変異試験2（rank-independence の回帰検査）**: `checkCorrectionDemo` を
  「`originalId` を決め打ちして `companionOf === correctionId` を見る」旧実装へ
  一時的に書き換え、新設した4テスト中2本
  （「original がアンカー・correction が mandatory_companion」「companionOf が
  もう片方を指していなければ false」）が実際に赤くなることを確認してから、同じく
  `cp` の退避コピーから復元し、`diff` で完全一致を確認した。
- **変異試験3（`limit` の退行を DB 無しで捕まえる歯）**: レビューで「偽 `Runtime` の
  `recall` が引数を一切見ないため、`limit: 1` の退行を捕まえる歯が
  `correction-demo.postgres.test.ts`（本物の Postgres を要求する）だけになっている」と
  指摘を受けた。`FakeRuntimeCalls.recallQueries` に実際に渡ったクエリを記録させ、
  「3回の `recall()` がすべて `{ text, limit: 1 }` で呼ばれる」ことを見る歯を
  `correction-demo.test.ts` に足した。`buildRecallQuery` を `limit: 10` へ戻すと
  **この歯が（DB 無しで）実際に赤くなる**ことを確認し、`cp` の退避コピーから復元して
  `diff` で完全一致を確認した（復元後 9 tests 緑）。⟹ `limit` の退行は、DB を持たない
  `typecheck / lint / test / build` ジョブでも捕まる。
- PR #320 時点の変異試験（`resolveContestedIds` の順序規則化・`compare.ts` への
  import 追加）はこの修正で対象コードを変えていないため、再検証していない
  （既存の効力を引き継ぐ想定——ただし今回改めて実行してはいない。下記
  「確かめていないこと」）。

## 確かめていないこと

- **PR #320 時点の変異試験（`resolveContestedIds` の順序規則化・`compare.ts` への
  import 追加）を、この修正後のコードに対して再実行していない。** 該当コード
  （`resolveContestedIds`・import 文）はこの修正で変更していないため効力は
  引き継がれる想定だが、実際に再実行して確認したわけではない。
- CI（`example-chat`/`postgres`/`root-gate-db-stage` ジョブ）そのものでの実行結果。
  手元の実測（ローカル `initdb` クラスタ、Postgres 17.11 + pgvector 0.8.0）は
  CI の `pgvector/pgvector:pg17` service container と構成は近いが同一である保証は
  無い——`docs/autonomy.md` §2.1 のとおり、CI の緑判定は別途 `gh` 経由で
  （head sha を明示して check-runs を job 単位で）確認する必要がある。この作業では
  push まで行い、CI の起動・結果の確認はしていない。
- **`0162` が最終的に衝突しないこと。** 番号はオーナーが中央で配ったもの
  （上記「測ったこと」の採番の経緯を参照）であり、**この ADR 側で採り直さない。**
  `scripts/__tests__/adr-duplicate-number.test.mjs`（PR #318）は `main` に対する重複しか
  見ず、**他の open PR が同じ番号を名乗っているかまでは見ない**——中央割り当てが守られる
  限り衝突しないはずだが、割り当てを受けた各 PR が実際にそのとおり付け替えたかは
  この ADR からは確認していない。
- **`0162` へ改名した後に、全門を測り直していない。** 改名で変えたのは ADR の
  ファイル名と、それを指す doc コメント／テスト内の文字列（`ADR 0160` → `ADR 0161`
  → `ADR 0162`）、および `docs/decisions/README.md` の索引だけであり、実行される
  ロジックには触れていない。上の「測ったこと」の数値は `0160` 時点のものである。
  改名後の最終的な緑は CI で確認する。

## これが覆るとしたら

- **`Memory` 型に構造化された属性・値の表現が入り、自動検出が現実的になったとき**——
  ADR 0134「これが覆るとしたら」と同じ条件。そのとき `contestedPair` を人手で書く
  このシナリオの形も、自動生成される形へ置き換わりうる。
