# ADR 0120: 時間項 probe（8件）を継続計測の CI に配線する — 値は残すが門にはしない。#109 か別建てかは決めていない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける**（ADR 0088 / ADR 0094 / ADR 0109 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 🔴 この ADR は帰属を決めていない

**Issue #217 は「これは #109（想起の質を実 embedding で継続計測する）の範囲内か、
別建てか」という問いを明示的に含む**。逐語:【現物】

> **これは #109（想起の質を実 embedding で継続計測する）の範囲内か、別建てか。**
> - 範囲内とみなすなら、#109 の受け入れ条件に1行足すのが素直
> - 別建てなら、この issue が住所になる
> どちらでも技術的には成立するので、**選び方は製品の判断**
> （`docs/autonomy.md` §3.1 の見分け方）。

`docs/autonomy.md` §3.1 の見分け方（「どちらを選んでも技術的には成立するが、
選び方が製品の性格を決める」なら製品判断行き）にそのまま当たる。
**⟹ この ADR はその判断をしない。**配線のコード（後述 §2〜§4）はどちらに転んでも
同一であり、判断を待つ理由がないため**配線だけを先に実装し、帰属の判断は開いたまま
オーナーへ残す**。

- **⛔ この ADR は Issue #109 の受け入れ条件を書き換えない。**
- **⛔ この ADR は Issue #109 を close しない。**
- **⛔ この ADR は Issue #217 を close しない。**（配線は塞いだが、それが #109 の一部か
  独立の完了かという製品判断が残っている以上、issue 自体を閉じる権限はこの ADR にない）

---

## 文脈

Issue #217 は Issue #109 の棚卸しの副産物として見つかった。逐語:【現物】

> `examples/chat/src/time-term-probe-set.ts`（**8件**、decay / freshness を測る probe）は、
> **継続計測の CI ジョブに配線されていない。**
>
> `retrieval-quality`（ADR 0088）と `identifier-probes`（ADR 0094）は毎 PR で走り、
> Job Summary と artifact に数字を残す。**時間項の probe だけがそこに入っていない。**

理由として ADR 0109 の実測を引いている。逐語:【現物】

> ADR 0109（PR #180）の実測が「順位を決めているのは similarity ただ1項で、
> `total` は210行すべてで `similarity × decay²` にビット単位で一致する」と報告している以上、
> **減衰の項は順位に効いている**。にもかかわらず、その項が回帰したことを捕まえる歯が
> 継続計測側に無い。

Issue #217 自身が、8件という母数について先回りして書いている。逐語:【現物】

> **8件という母数が継続計測に足るか**は測っていない。`identifier-probes` の閾値説明コメントが
> 「30件・12件でも統計的な閾値判定に足る母数ではない」と書いている以上、
> **8件を門にはできない**。⟹ 入れるとしても `retrieval-quality` と同じく
> **「値は残すが門にはしない」**の形になるはずである。

**⟹ この ADR が採る形（§2 以降）は、issue 本文が既に示唆している通りである。**

### この環境の制約

**この作業環境には Postgres も docker も無く、`DATABASE_URL` を用意できない。**
`time-term` サブコマンドも `examples/chat/src/__tests__/time-term.postgres.test.ts` も
DB を要求する（`requireDatabaseUrl()`）ため、**この ADR の作業では実際の probe 実行結果
（outcome や freshness/decay の値）を一度も測っていない。**
[AGENTS.md](../../AGENTS.md) / [docs/autonomy.md](../autonomy.md) §1.1 の線に従い、
DB を要する歯は「緑」でも「空」でもなく**「判定不能」**として扱う——測れなかったことは
「測れなかった」と書く（下記「確かめていないこと」）。

---

## 1. 【現物】既に在ったもの・無かったもの

作業開始前に現物を確認した。

**既に在った**（1文字も変えていない）:

- `examples/chat/src/time-term-probe-set.ts`（8 probe。ADR 0058）
- `examples/chat/src/time-term-arm.ts`（`runTimeTermArm` / `classifyPairOutcome` /
  `formatTimeTermReport`。`PairOutcome` の7値）
- `examples/chat/src/cli.ts` の `time-term` サブコマンド（`runTimeTerm()`）と
  `package.json` の `"time-term": "tsx src/cli.ts time-term"` スクリプト
- `examples/chat/src/__tests__/time-term.postgres.test.ts`（8 probe の outcome を
  本物の Postgres に対して assert する歯。5件）
- `examples/chat/src/__tests__/time-term-arm.test.ts`（`TIME_PROBES` の構造検査・
  `classifyPairOutcome` の単体検査）

**無かった**（この ADR が足したもの）:

1. **機械可読な JSON 出力口。**`retrieval`/`identifier-probes`/`consolidation-cost` は
   それぞれ `MNEMORA_*_JSON` 環境変数で機械可読な結果を書けるが、`time-term` にはその口が
   無かった（`cli.ts` の `runTimeTerm()` に `writeFileSync` の呼び出しが無い）。
2. **要約スクリプト。**`scripts/` に `time-term-summary*.mjs` が存在しなかった。
3. **CI ジョブへの配線。**`.github/workflows/ci.yml` に `time-term` の言及が0件だった。

**⟹ Issue #217 の「何が無いか」節の記述（「継続計測の CI ジョブに配線されていない」）は
現物と一致していた。**ただし issue 本文は「無いのは配線だけ」と書いているのに対し、
実際には機械可読な出力口と要約スクリプトも無く、**「配線」に足る土台が3つとも欠けていた**
——CLI/postgres テストが在ることと、CI に載せられる形で値を取り出せることは別である。

---

## 2. 決めたこと

1. **`examples/chat/src/time-term-json.ts` を新設する**（`buildTimeTermJson`）。
   `runTimeTermArm()` が返す `TimeTermArmReport` を、条件（`armLabel`/`llmMode`/
   `embeddingMode`）付きの機械可読 JSON に写す純関数。ファイル I/O・環境変数・時刻取得は
   一切行わない（`retrieval-json.ts`/`identifier-json.ts`/`consolidation-json.ts` と同じ分担）。
2. **`cli.ts` の `runTimeTerm()` に `MNEMORA_TIME_TERM_JSON` を足す。**未設定なら
   挙動を変えない（既存3コマンドと同じ規約）。
3. **`scripts/time-term-summary-lib.mjs` / `scripts/time-term-summary.mjs` を新設する。**
   Job Summary 用の Markdown を組み立てる純関数と、その CLI ラッパー
   （`retrieval-quality-summary*.mjs`/`identifier-probe-summary*.mjs` と同じ2分割）。
4. **`.github/workflows/ci.yml` の末尾（`consolidation-cost` ジョブの後）に `time-term`
   ジョブを1本足す。**並行 PR が同じファイルへジョブを足す衝突を避けるため、末尾に置く
   （マネージャー指示）。
5. **⛔ 門にしない。**基準値と相違しても `exit 0`。落ちるのは bench 自体が壊れたとき
   （入力 JSON が読めない・`outcome` が未知の値・`probes` が空 等）だけである（後述 §3）。
6. **基準値ファイルはこの PR では作らない。**値を捏造しないためである（後述 §5）。

---

## 3. ⛔ 門にしない理由（ADR 0088 §2.1 / ADR 0094 §7 と同じ理由を、この標本数に当てる）

**標本は8 probe である。**
[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §3 の規律
（「🔴 ⚠ 標本は probe 7件である。ここから失敗率も成功率も主張しない」）にそのまま照らせば、
閾値判定に足る母数ではない。ADR 0094 の識別子 probe は30件・12件まで増やした上でも
「⛔ これは Issue #109 を閉じない」——2 run では偽陽性率に上限を置けないと明記している。
**8件はそれよりさらに小さい。**

Issue #217 自身がこの理由を先取りして書いている（§「文脈」引用）ため、
**この ADR は新しい理由を作っていない。issue 本文の予測をそのまま実装した。**

### 何を比べ、何を比べないか

`time-term` が測るのは MRR/hit@k ではなく、probe ごとの **`outcome`**
（`newer-ranked-higher` 等7値。`time-term-arm.ts` の `PairOutcome`）である。
⟹ 要約が基準値と比べるのは `outcome`/`totalInScope`/`omittedKinds` という**離散値**だけであり、
**`freshnessRatio`/`decayRatio`/`totalRatio` のような連続値は比較に使わない。**

理由: これらの比は、`occurredAt`/`recordedAt` を計算した瞬間から `recall()` が実際の
`now` を読む瞬間までの**壁時計の実経過時間**にわずかに依存する。ADR 0088 §2 が
`retrieval-quality` の `decay`/`freshness` について実測した「実行ごとに実際に揺れる
（`total` の6桁目が動く）」のと同じ種類の揺れが、この arm の比にも構造上存在する
（`time-term-arm.ts` の `TIE_EPSILON` の doc コメント自身が「ミリ秒〜数百ミリ秒の差」を
織り込んでいる）。**⟹ 厳密等価で比べると常に「相違あり」になり、ADR 0088 §3-3
「常に同じ量を出す観測口は読まれない」を作り直すことになる。**連続値は JSON にはそのまま
残す（丸めない）——比較には使わないが、artifact を見比べたい人のために捨てはしない。

**⚠ この判断（連続値を比較対象から外す）は、この ADR の作業者が DB 無しで導いたもので
あり、実際の run 間の揺れ幅をこの環境で実測してはいない。**根拠は ADR 0088 §2 の実測
（別 bench・別項目についての実測）からの類推であり、`decay`/`freshness` が同じ式・
同じ起点（`decayBase()`）を経由する以上その類推は妥当だと考えるが、**`time-term` 自身の
run 間差分は測っていない**（後述「確かめていないこと」）。

---

## 4. 🔴 数字を、条件から離さない（ADR 0088 §4 と同じ規律）

`TimeTermRunJson` はトップレベルに `armLabel`/`llmMode`/`embeddingMode`（**宣言値ではなく
`TimeTermArmReport` の実値**）を持つ。`time-term` は `deterministic` LLM + `deterministic`
embedding に固定される設計（`cli.ts` の `runTimeTerm()` の既存 docstring。ペアの本文が
厳密に同一なので `similarity` は構成上定数になる）だが、**宣言に頼らず実値を書く**のは
ADR 0088 §4 が3度の誤り（arm を取り違えて記憶した）から導いた規律をそのまま踏襲するため
である。

**⚠ `identifier-json.ts` と違い `status: "weights_unavailable"` を持たない。**
`time-term` は `@mnemora/local-embedding` を使わない——HuggingFace への外向き通信も、
「重みを取得できなかった」という失敗モードも構造上存在しない。⟹ この bench の CI ジョブは
`identifier-probes`/`consolidation-cost` よりも単純である（モデル重みのキャッシュ
ステップが無い）。

---

## 5. ⚠ 基準値ファイルはまだコミットしていない

`examples/chat/retrieval-baseline.json`・`examples/chat/identifier-probe-baseline.json`・
`examples/chat/consolidation-baseline.json` はいずれも実測値をコミットしているが、
**`examples/chat/time-term-baseline.json` はこの PR では作らない。**

理由: **この環境には DB が無く、`time-term` を1回も実行できていない**（§「この環境の制約」）。
基準値ファイルに書く数字は実測でなければならない——値を捏造して埋めることは
[docs/autonomy.md](../autonomy.md) §5 の「測ったこと」「確かめていないこと」を分ける規律に
反する。

**⟹ 最初にこの CI ジョブが走って得られる artifact を、後続 PR で基準値にする。**
それまでは要約スクリプトに `--baseline` を渡さない。`scripts/time-term-summary.mjs` は
`--baseline` を省略しても動く（`retrieval-quality-summary.mjs`/`identifier-probe-summary.mjs`
と同じ設計——基準値ファイルが存在しない時点でこの規約が無ければ、この PR の CI 自体が
summary 段を組めない）。

---

## 6. 検討して採らなかった案

- ⛔ **この PR で `time-term-baseline.json` を「それらしい」値で作る。**
  §5 の理由により却下。**「初回 CI の artifact を基準値にする」という手順自体を
  この ADR に明記することで代える。**
- ⛔ **標本8件で閾値の門を置く。**§3。ADR 0033 §3 の規律に照らして足りない。
  Issue #217 自身が同じ結論を先取りしている。
- ⛔ **`freshnessRatio`/`decayRatio`/`totalRatio` も基準値と厳密等価で比べる。**
  §3。壁時計時間に依存する連続値であり、ADR 0088 §2 と同じ種類の揺れを持つ
  （実測はしていないが、式の構造から類推できる。上記の限定を付して書いてある）。
- ⛔ **Issue #217 の「範囲内か別建てか」をこの ADR で決める。**§0。製品判断であり
  `docs/autonomy.md` §3.1 に照らして設計側が決めてよい範囲ではない。
- ⛔ **Issue #109 の受け入れ条件に1行足す。**上記と同じ理由で見送った。
  範囲内という判断が下ったときに、オーナーの指示で足す。
- ⛔ **`identifier-probes` ジョブと同様にモデル重みのキャッシュステップを足す。**
  `time-term` は `@mnemora/local-embedding` を使わないため不要（§4）。要らないものを
  「念のため」で足さない。

---

## 7. 引き受けた負債

1. **⚠ 標本は8 probe のままである。**この ADR は1件も増やしていない。CI に常時載ることで、
   読み手が標本の小ささを忘れやすくなる危険はむしろ増える。⟹ だから Job Summary に
   ADR 0033 §3 の注意書きを毎回出す（`buildSummaryMarkdown`）。
2. **⚠ 基準値ファイルがまだ無い。**このジョブが実際に CI 上で緑になり、artifact が
   1回出るまでは、「基準値と比べる」輪は閉じていない。**次の PR で
   `examples/chat/time-term-baseline.json` を追加し、`ci.yml` に `--baseline` を足すこと**
   （ADR 0088 §3 / ADR 0094 §8 が確立した形をそのまま適用する）。
3. **⚠ `freshnessRatio`/`decayRatio`/`totalRatio` の run 間の揺れ幅を、この ADR の作業では
   実測していない**（DB が無いため）。ADR 0088 §2 からの類推でこれらを比較対象から
   外したが、**実際にどれだけ揺れるかは次に DB のある環境で測り直す余地がある**——
   もし実際には厳密に安定している（揺れがほぼゼロ）とわかれば、比較対象に含める判断へ
   覆りうる。
4. **⚠ この PR は `time-term.postgres.test.ts` を実行していない**（DB が無いため。
   §「確かめていないこと」）。**手元での実行結果は「判定不能」であり「緑」ではない。**
   CI で初めて実際に走る。
5. **⚠ Issue #217 の帰属判断が残ったままである。**この ADR は意図的にそれを開いたままに
   している（§0）。**配線が入ったことで「技術的な障害」は無くなったが、
   製品としてどちらの issue に属すると数えるかは、オーナーが決めるまで未定のままである。**

---

## 8. これが覆るとしたら

- **オーナーが「これは Issue #109 の範囲内である」と判断したとき。**
  そのとき Issue #109 の受け入れ条件に1行足し、Issue #217 をその一部として close する
  判断が下る——**この ADR はその判断をしていない**（§0）。
- **オーナーが「これは別建てである」と判断したとき。**
  そのとき Issue #217 がこの機能の恒久的な住所になる。
- **標本が数十件になり、その母数で偽陽性率に上限を置けると実測できたとき。**
  ADR 0088・ADR 0094 の「これが覆るとしたら」と同じ条件——そのとき「⛔ 門にしない」は
  覆りうる。
- **基準値ファイルを追加する後続 PR が着地したとき。**
  そのとき §5・引き受けた負債2は塞がる。
- **`time-term` の run 間差分を実際に DB のある環境で測り、`freshnessRatio` 等が
  想定より安定している（またはより不安定である）と分かったとき。**
  §3 の比較対象の選び方を測り直す。

---

## 測ったこと・確かめていないこと（[docs/autonomy.md](../autonomy.md) §5）

**測ったこと【実測】**（この器で実際に走らせたコマンドと出力）:

- `pnpm run typecheck` / `pnpm run lint` / `pnpm run format:check` / `pnpm run build` /
  `pnpm run pack:check`（`rm -rf packages/*/dist && pnpm run build` 後）——**すべて緑**。
- `DATABASE_URL` 無しで `pnpm run test`——**緑**。「DB テストは実行していません」と
  明示された（`@mnemora/postgres` / `@mnemora/example-chat` の `test:db` が未実行）。
  **これを「全部通った」とは読んでいない。**
- `npx vitest run`（ルート、`scripts/**/*.test.mjs`）——732件すべて緑。新設した
  `scripts/__tests__/time-term-summary-lib.test.mjs`（30件）・
  `scripts/__tests__/time-term-summary.test.mjs`（12件）・
  `scripts/__tests__/ci-yml-time-term-wiring.test.mjs`（10件）を含む。
- `examples/chat` で `npx vitest run src/__tests__/time-term-json.test.ts`
  （DATABASE_URL 無しで直接ファイル指定・単体実行）——7件すべて緑。**⚠ この実行は
  `pnpm run test:db` 経由ではない**——ルートの `test` 門は `DATABASE_URL` が無いと
  この歯を含む `examples/chat` の `test:db` そのものを起動しない（AGENTS.md の通り）ため、
  この歯が実際に自動で走るのは CI（DB あり）が最初である。手元では手動で個別に
  ファイル指定して実行し、正しく書けていることを確認した。
- **変異試験**（`git checkout` は使わず、`/tmp/mutation-backup/` へ退避コピーしてから
  変異・復元）:
  - `examples/chat/src/time-term-json.ts` の `memberJson()` で `rank: member.rank` を
    `rank: member.rank + 1` に変異 → `time-term-json.test.ts` が1件赤くなった
    （`member の rank/total/... を写す`）。復元後、7件とも緑に戻った。
  - `scripts/time-term-summary-lib.mjs` の `DIFF_FIELDS` から `"outcome"` を除去する
    変異 → `time-term-summary-lib.test.mjs` 1件・`time-term-summary.test.mjs` 1件が
    赤くなった。復元後、両ファイルとも緑に戻った（ついでに
    `ci-yml-time-term-wiring.test.mjs` も含めて緑を確認）。
  - `.github/workflows/ci.yml` の `time-term` ジョブの summary 段の `--measured` を
    存在しないパス（`time-term-WRONG.json`）へ変異 → `ci-yml-time-term-wiring.test.mjs`
    が2件赤くなった（配線のずれと、それに伴う実行時エラー）。復元後、緑に戻った。
- **既存の歯への副作用**: `.github/workflows/ci.yml` に `pgvector/pgvector:pg17` の
  service を持つジョブを1本足したことで、`scripts/__tests__/
  ci-yml-postgres-regime-wiring.test.mjs` の固定数（6本/5本）が実態と食い違って
  2件赤くなった。**これは変異ではなく、新しいジョブを足した直接の結果として
  実際に踏んだ既存の歯である。**数を7本/6本へ実測どおりに直し、緑に戻したことを確認した
  （`docs/decisions/0094-identifier-probes-local-embedding.md` §8 が記録した
  「レビューで見つけて直した」先例と同じ扱いとして、ここに明記する）。

**確かめていないこと**（走らせられなかったもの。理由付き）:

- **`time-term` サブコマンドを実際に実行した結果**（8 probe の outcome・
  `freshnessRatio`/`decayRatio` の実値）。この環境に Postgres も docker も無く
  `DATABASE_URL` を用意できないため。CI が実際に走って初めて実測される。
- **`examples/chat/src/__tests__/time-term.postgres.test.ts` と
  `time-term-arm.test.ts` が緑であること。**上記と同じ理由で、この PR の作業では
  1回も実行していない（この ADR は両ファイルに1行も変更を加えていない——差分が
  無いことは `git diff` で確認した）。
- **`freshnessRatio`/`decayRatio`/`totalRatio` の run 間の揺れ幅の実測**（§7 の負債3）。
- **モデル重みのキャッシュが不要であることの実地確認**（§4 は式・依存関係からの
  導出であり、CI ランナー上で実際に外向き通信が発生しないことを実行時に確認しては
  いない）。
- **CI ランナー（GitHub Actions、`pgvector/pgvector:pg17`）上でこのジョブが実際に
  green で終わること。**手元では検証できないため、CI の結果を別途確認する。

**人から受け取った前提（出所付き）**:

- Issue #217 の本文（何が無いか・なぜ問題か・8件の母数の扱い）——マネージャーの指示文の
  引用ではなく、`gh issue view 217` で取得した原文をそのまま引用した【現物】。
- ADR 0058 / ADR 0088 / ADR 0094 / ADR 0109 の内容——いずれもこの repo の
  `docs/decisions/` から直接読んだ【現物】。伝聞では受け取っていない。

Refs #217
