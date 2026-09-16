# ADR 0190: `correction` サブコマンドを CI の歯にする — 既存ジョブへ相乗り・`deterministic` 層・`omitted` の `superseded` assert

- **状態**: 採用 (2026-09-17)
- **日付**: 2026-09-17

---

## 文脈

[Issue #374](https://github.com/takecchi/mnemora/issues/374) が指摘した穴:

> `grep -c "correction" .github/workflows/ci.yml` → `0`

`examples/chat` の `correction` サブコマンド（`examples/chat/src/cli.ts` の
`command === "correction"` という dispatch 行、`runCorrection()` → `runCorrectionDemo()`
→ `markContested`/`recall`（段3 発火）→ `resolveContested`/`recall`）は、CI から
一度も実行されていなかった。`correction-demo.postgres.test.ts`
（`test:db` 経由で CI に拾われる）は `runCorrectionDemo()` を直接 import しており、
`cli.ts` の dispatch 行そのものを経由しない——**dispatch 行が消えても、あのテストは
落ちない。**

この鎖は、recall 段3（矛盾の解決と必須の同伴取得、`docs/recall.md` §2 段3）が
**本番経路（CLI 経由）で発火する唯一の道**であり、北極星「目指す姿」項目5
「間違いを正すと、古いほうが先に出てこなくなる」を実演する唯一の呼び手でもある
（Issue #303 / ADR 0162）。

issue 本文はやることを3つ挙げている:

1. `ci.yml` に `correction` の実行を足す（**新しいジョブを増やす必要が在るかを先に
   判断すること**）
2. `checkCorrectionDemo()` の7欄が全部 true であることを CI が判定する（印字するだけに
   しない）
3. 🔴 `omitted` を assert する — `resolveContested` の後、負けた側が
   `condition: "superseded"` として `omitted` に出ることを測る（「消えた」と
   「最初から無かった」を区別する、北極星 項目6）

マネージャーから、**「守る歯を足さず、守られていないことを文書に書く」で止めてよい**
という明示の許可も添えられていた。本 ADR は「足す」ほうを選んだ理由と、その根拠を記録する。

---

## 決定

### 決定1: 新しいジョブを作らず、既存の `example-chat` ジョブへ1ステップ足す

`example-chat` ジョブ（`.github/workflows/ci.yml`）には既に、`pgvector/pgvector:pg17`
の service container・`DATABASE_URL`・`pnpm install --frozen-lockfile`・拡張の作成
（vector/btree_gin/pgcrypto）・`pnpm --filter @mnemora/postgres run migrate` が揃っている。
`correction` の実行はこれらをそのまま使い回せる——**ステップを1本足すだけで、新しい
コンテナも install も migrate も増えない。**

**費用の相対比較（実測はしていないが、コードから数えた操作の量）**:
`runCorrectionDemo()` がこのステップで行うのは、`observe()` 2回（`DeterministicLLMProvider`
——文字数で digest を切るだけの stub、ネットワーク I/O 無し）・`drainEmbedTicks()`
（`DeterministicEmbeddingProvider`——文字コードからベクトルを作るだけの stub、これも
ネットワーク I/O 無し）・`recall()` 3回（DB 読み取り）・`markContested`/`resolveContested`
各1回（DB 書き込み）。**外部 API 呼び出しは0件**であり、SQL の往復もひと桁件数に収まる。
同じジョブ内の `compare` ステップ（`DEFAULT_COMPARE_SEQUENCE` の12点、各点で複数ターンの
会話を `observe`/`recall`、カセット再生とはいえ I/O は correction よりずっと多い）や、
直前の `test:db` ステップ（`examples/chat` の conformance/往復テスト一式）と比べて、
**桁で軽い**と判断した。⚠ **wall-clock 時間そのものは計測していない**——CI 上で実測が
可能になった時点で、この判断が合っていたかを検算できる（「確かめていないこと」参照）。

**採らなかった案（新規ジョブ）**: 独立ジョブにすると、service container の起動・
`pnpm install --frozen-lockfile`・拡張作成・migrate をもう1セット払う。上の費用比較から、
その追加コストに見合う理由が無いと判断した。

### 決定2: provider 層は `deterministic`（明示の override をしない）

`runCorrection()` は `createExampleRuntime(requireDatabaseUrl())` を、env の override 無しで
呼ぶ。CI の `example-chat` ジョブは `OPENAI_API_KEY` を設定しないため、
`selectProviderMode` は `deterministic` を返す。

**`recorded` にしなかった理由**: `examples/chat/cassettes/` には `compare.json`/
`retrieval.json` しか無く、correction デモの発話（`correction-scenario.ts` の
`CORRECTION_SCENARIO`）は記録に無い入力になる。`RecordedLLMProvider`/
`RecordedEmbeddingProvider` は記録に無い入力を例外にする（ADR 0051 ——擬似物へ黙って
倒れないための設計）。`recorded` を選ぶなら、まず記録を録る工程（`record:compare` 相当）
が要る。

**`deterministic` で足りると判断した根拠**: このデモが確かめる性質——
`markContested` 後に両方が隣接して出るか・`mandatory_companion` が正しく付くか・
`resolveContested` 後に敗者が消え、`omitted` に理由が残るか——は、**スコアの質に依存しない
構造的な性質**である。`limit: 1` の効果（ADR 0162 決定5）で「対向が `withinLimit` から
落ちれば必ず強制的に連れてこられる」という段3の契約そのものを検査しており、
埋め込みが意味を捉えているかどうかは無関係。`AGENTS.md` の4層表が
`deterministic` を「配線・契約・適合テストの検査用」と位置づけているのと合致する
——このデモは「配線・契約」側であり、北極星の主測定（`compare`/`retrieval`、
`recorded` で走る、ADR 0051）ではない。この独立性は
`correction-scenario-compare-isolation.test.ts` が機械的に見張っている
（`correction-demo.ts`/`correction-scenario.ts` は `compare`/`scenario`/`probe-set`/
`naive-path` のいずれも import しない）。

### 決定3: `checkCorrectionDemo()`/`checkCorrectionOmission()` を「印字するだけ」から「assert して非0で終わる」へ変える

`examples/chat/src/cli.ts` の `runCorrection()` に、`checkCorrectionDemo(result)` と
`checkCorrectionOmission(result)`（決定4）の全欄を走査し、1つでも `false` なら
`console.error` で名指しして `process.exitCode = 1` にするコードを足した。これまでは
`formatCorrectionDemo()` が画面に「はい/いいえ」を印字するだけで、CI のログを人間が
目視しない限り退行に気づけなかった——issue が名指しした「印字するだけにしない」への対処。

**既存コマンド（`association-probes`/`consolidation-cost`）と同じ規律**（`warmup` 失敗時に
`console.error` + `process.exitCode = 1` で打ち切る形）に合わせた。

### 決定4: `omitted` の `superseded` assert は、既存の7欄とは別の関数にする

`correction-demo.ts` に `CorrectionOmissionCheck`/`checkCorrectionOmission()` を新設した
——`CorrectionDemoCheck`（既存の7欄）に8番目のフィールドとして足す案もあったが、
issue が「7つの欄」と「`omitted` を assert する」を別項目として挙げていること、
既存の `checkCorrectionDemo` の doc コメント・呼び出し側（`correction-demo.test.ts`/
`correction-demo.postgres.test.ts`）の「7欄」という言及をそのまま保つほうが、
**この PR が何を足したかを差分から読みやすい**と判断したため、別関数にした。

`checkCorrectionOmission` は `result.afterResolve.omitted` に
`{ kind: "filtered", condition: "superseded", count > 0 }` が実際に含まれているかを見る。
`CorrectionDemoCheck.afterResolveOriginalAbsent` は「`recall().memories` に居ない」ことしか
見ず、それだけでは「機構の都合で superseded として棚上げされた」のか「そもそも最初から
無かった」のかを区別できない——北極星 項目6「知らないことを、知らないと言える」——
「見つからなかった」と「探していない」を同じ顔で返さない、の適用。`count` の下限
（`> 0`）だけを見て、特定の `memoryId` には紐づけない——`aggregateScope` の
`filteredSuperseded` はスコープ内の集約であり、個々の Memory を名指ししない設計
（`packages/core/src/recall.ts`）にそのまま従う。

### 決定5: `correction-demo.postgres.test.ts` にも同じ assertion を足す

CI で実際に DB に対して走る場所（`test:db`、この決定は Postgres が無いと検証できない）にも
`checkCorrectionOmission` の assertion を足した。CLI 経由の assertion（決定3）とは別の
経路（直接 import）だが、こちらのほうが先に CI 上で走る（`test:db` ステップが `correction`
ステップより前）ため、両方に同じ検査を置くことで「どちらの経路が先に壊れを検出するか」を
問わない形にした。

---

## 採らなかった案

### 案A: 新しい独立ジョブを `correction` 専用に作る

決定1の「費用の相対比較」で棄却。既存ジョブへ1ステップ足すほうが、13本の担い手が
CI の緑を待っている状況（マネージャー指摘）で CI 時間の増分を抑えられる。

### 案B: `recorded` モードで走らせる

決定2で棄却。カセットが無い（`examples/chat/cassettes/` に correction 用の記録が無い）。
録る案（`record:correction` のようなスクリプトを新設し、実 API を叩いて記録する）も
検討したが、このデモが確かめる性質はスコアの質に依存しない構造的なものであり、記録・
維持のコスト（ADR 0051 の「記録に無い入力は例外」という契約を保守し続ける負債）に
見合わないと判断した。

### 案C: `omitted` の assert を `CorrectionDemoCheck` の8番目のフィールドにする

決定4で棄却。issue の項目分けと、既存コードの「7欄」という言及をそのまま保つため
別関数にした。

### 案D: 何もしない（マネージャーから明示された「歯を足さない」選択肢）

**採らなかった**。決定1の費用比較のとおり、追加コストは既存ジョブへの1ステップに収まり、
守るものが「北極星 項目5を実演する唯一の本番経路」（issue のB判定、優先度は棚卸しで
「v1.0.0 後すぐ」の最上位）である——費用が小さく便益が大きいと判断した。

---

## 引き受けた負債

### 負債1: `deterministic` 層は「性能」を測らない

`AGENTS.md` の警告どおり、`deterministic` の embedding（文字コードからの機械的なベクトル)
は意味的な類似度を持たない。correction デモが確かめるのは「段3の契約（対向が
`withinLimit` から落ちれば強制的に連れてくる）が実際に発火するか」という**構造**であり、
「訂正後に正しい記憶が選ばれるか」という**質**ではない。質の低下（例: 段2の再スコアの
実装が変わり、`limit:1` でも両方が自然に残るようになった、など）は、このデモが false
positive で見逃す可能性がある——ただしこれは ADR 0162 決定5がそもそも `limit: 1` で
設計した契約の範囲内であり、本 PR が新たに引き受けたものではない。

### 負債2: CLI 経由（`tsx src/cli.ts correction`、本番の呼び出し経路そのもの）の
assertion を、本物の DB に対して実行して確認していない

この作業環境には `DATABASE_URL` が無い（`docs/autonomy.md` §1.1）。「確かめたこと」節の
とおり、dispatch 行を消すと `tsx src/cli.ts correction` が exitCode=1 で終わること
（`requireDatabaseUrl()` に到達する前に `printHelp()` 分岐へ落ちる）は DB 無しで実際に
確認した。しかし、**dispatch 行を残したまま `checkCorrectionDemo`/`checkCorrectionOmission`
の assertion が本物の Postgres に対して実際に true を返すこと**（＝この PR の主眼である
「歯が噛む」ことの最終形）は、CI の `example-chat` ジョブが初めて実行する。手元では
`correction-demo.test.ts`（偽 Runtime）と `correction-demo.postgres.test.ts` の型検査・
非DB部分までしか確認できていない。

### 負債3: `runCorrection()` の exit code 契約を変えた

これまで `correction` サブコマンドは（`requireDatabaseUrl()` 等の前提エラーを除けば）
常に exitCode 0 で終わっていた。本 PR で、`checkCorrectionDemo`/`checkCorrectionOmission`
のいずれかが false なら exitCode 1 で終わるようになった——`examples/chat` はサンプル
アプリであり、これを外部から呼ぶ利用者は想定していない（`AGENTS.md`「いまの状態」表の
「サンプル CLI」という位置づけ）ため、破壊的変更として扱うほどの影響は無いと判断したが、
明示はしておく。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

働かない——本 PR は CI の歯であり、recall の量そのものは変えていない（ADR 0162 の
「問1」評価がそのまま当てはまる）。

### 問2: Background Cognition を無効にしても成立するか

成立する。`correction` サブコマンドは明示的に呼んだときだけ動く。CI に足したステップも
`tick()`/`observe()` の自動経路とは無関係。

### 問3: この記憶が選ばれた理由を、後から説明できるか

説明できる方向に働く。`formatCorrectionDemo()` の出力に、`omitted` の
`condition: "superseded"` が実際に記録されているかどうかの行を足した——「なぜ古いほうが
出てこなくなったか」を、`recall().memories` から消えたことだけでなく `omitted` の理由から
も辿れるようにした。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

この PR は `provenance.kind` を一切参照・変更しない。

### 問5: LLM を呼ばずに済ませられないか

済ませた。`deterministic` LLM/embedding はどちらもネットワーク I/O を持たない stub であり、
CI に足したステップは実質的に SQL の往復だけで完結する。

---

## 測ったこと

**この器（`DATABASE_URL` 無し、docker 無し）で実際に走らせたもの:**

- `pnpm --filter @mnemora/example-chat run typecheck` — 緑。
- `pnpm run typecheck`（全 workspace、7/8 project） — 緑。
- `pnpm run lint`（`eslint .`） — 緑。
- `pnpm run format:check` — 緑（`correction-demo.ts`/`correction-demo.test.ts`/
  `correction-demo.postgres.test.ts` の3ファイルは最初 `prettier --write` で整形が
  必要だったため整形してから再チェックし、緑を確認した）。
- `pnpm run build`（全 workspace） — 緑。
- DB 不要な vitest ファイル
  （`npx vitest run src/__tests__/correction-demo.test.ts
  src/__tests__/correction-scenario.test.ts
  src/__tests__/correction-scenario-compare-isolation.test.ts`、`examples/chat` 配下で
  直接 `vitest` を実行、`test:db` フルセットではなく対象を絞った実行） — **29 tests 緑**
  （このデモ足す前の基準 25 tests + `checkCorrectionOmission` の新設4テスト）。

**変異試験（`git checkout` は使わず、`/tmp/mutation-backup/` へ事前に `cp` で退避してから
`cp` で復元。書き換えは `node -e` のワンショットスクリプトで一意な文字列だけを狙い撃ちした）:**

1. `checkCorrectionOmission` の判定条件を `condition === "superseded"` から
   `condition === "archived"` へ書き換え → `correction-demo.test.ts` の新設4テストのうち
   2件が赤くなることを確認（`omitted に condition="superseded"…が在れば true` と
   `condition が別の理由…だけでは false`）→ 復元 → 29 tests 緑に戻ることを確認。
2. `CorrectionDemoCheck.afterResolveOriginalAbsent` の計算を固定値 `false` へ書き換え →
   既存の「北極星の核心」テストが赤くなることを確認 → 復元 → 緑に戻ることを確認。
3. `cli.ts` の `else if (command === "correction") { await runCorrection(); }` という
   dispatch 行を削除 → `DATABASE_URL` 未設定のまま `npx tsx src/cli.ts correction` を実行
   → `printHelp()` の分岐に落ちて **exitCode=1** で終わることを確認（`requireDatabaseUrl()`
   に到達する前に落ちるため、DB が無くてもこの mutation の効果を検証できた）→ 復元 →
   同じコマンドを再実行し、今度は `requireDatabaseUrl()` のエラー（`runCorrection` の
   スタックフレームを経由）で落ちることを確認した——**dispatch が復元されたことの
   直接証拠**（削除時は `printHelp` 経由、復元後は `runCorrection`/`requireDatabaseUrl`
   経由、と失敗の形そのものが変わる）。

---

## 確かめていないこと

- **CI の `example-chat` ジョブが実際にこのステップで緑になること。** この PR を出した
  時点では CI が走っていない。`checkCorrectionDemo`/`checkCorrectionOmission` が本物の
  Postgres + `deterministic` provider に対して全欄 true を返すことは、CI が確認する
  （`correction-demo.postgres.test.ts` の同種の assertion は過去に ADR 0162 決定5で
  実測済みだが、`omitted` の superseded assert は今回新設したものであり、この作業環境では
  一度も DB に対して実行していない）。
- **CI ステップの wall-clock コスト。** 決定1の「桁で軽い」という判断は操作の数を数えた
  推論であり、実測（既存ジョブの所要時間がどれだけ伸びるか）はしていない。
- `pnpm run pack:check`/`check:cjs-parse` — `examples/chat` は publish 対象外
  （`private: true`）であり対象外と判断したが、実行はしていない。
- ルートの `pnpm run test`（全体）は、指示により実行していない。
