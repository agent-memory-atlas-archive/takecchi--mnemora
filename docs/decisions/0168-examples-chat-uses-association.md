# ADR 0168: `examples/chat` が recall() の連想枠を既定で使う — `maxCount=10`、既定 on は別の判断として分離する（Issue #291）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0158 / 0167 の体裁を踏む）。

- **【実測】** — この ADR の書き手が自分の手で走らせて確かめた（この環境には `docker` は無いが、`postgresql-17` + `postgresql-17-pgvector` の Debian パッケージを使い、ADR 0167 と同じ手法で非特権クラスタを立てて実行した）。
- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【受】** — Issue #291 のコメント・ADR 0151/0158/0167 として引き継いだ、前任者の実測。

---

## 結論（先に）

**`examples/chat` の「アプリとしての想起経路」（`mnemora-path.ts` の `queryRecall`）が、`RecallQuery.association` を既定で渡すようにした。** `maxCount=10`。

| 決めたこと | 内容 |
|---|---|
| 対象 | `examples/chat/src/mnemora-path.ts` の `queryRecall`（`compare.ts`・`budget-demo.ts`・`cli.ts` の `chat` サブコマンドが使う経路）だけ。**5本のベンチ arm（`retrieval-quality.ts`/`identifier-arm.ts`/`time-term-arm.ts`/`consolidation-cost.ts`/`archive-sweep-cost.ts`）と `association-arm.ts` は触っていない** |
| `maxCount` | **10**（既定値、`DEFAULT_MNEMORA_PATH_ASSOCIATION = { maxCount: 10 }`） |
| 上書き | `MnemoraPathOptions.association` に明示的な値、または `null`（`packages/core` 側の既定=offへ戻す）を渡せる |
| `packages/core` の既定 | **変えていない。**`RecallQuery.association` を渡さない呼び出しは1バイトも挙動が変わらない（ADR 0151 決定・維持） |
| 既定 on（`recall()` 自体の既定を変える案） | **この ADR の範囲外。**オーナーに諮る案件として分離する（下記） |

**⚠ 「実装した」と「効いた」は別である。**本 ADR は「`examples/chat` という一呼び手が、連想枠を実際に使うようになった」ことと、その呼び手の中で北極星の物差し（`compare` の `mnemoraShareOfNaiveChars`）がどう動いたかまでを実測して記録する。

---

## 背景（Issue #291 の到達点）

ADR 0151（連想枠の実装）・ADR 0158（測る器を作った）・ADR 0167（器の非決定性の原因を直した）を経て、Issue #291 の 2026-09-16 コメントが**信頼できる器の上で**次を実測した【受】:

| arm | goldReturned /12 | うち連想由来 | `memoryChars` |
|---|---|---|---|
| off | 0 | 0 | 52,006（基準） |
| on `maxCount=3` | 9 | 9 | +1.44% |
| on `maxCount=5` | 10 | 10 | +2.22% |
| on `maxCount=10` | **12** | 12 | **+4.32%** |

**⟹ +4.32% の文字数で、連想でしか届かない gold の到達が 0/12 → 12/12。**同じコメントは「体験を動かす道は2つ」と整理している——(1) `examples/chat` が `association` を使う、(2) `packages/core` の既定を on にする。**(2) は ADR 0151 が北極星の問い1で明示的に落とした形であり、この issue で勝手に決めない**とも明記されている。

**マネージャーからの作業指示も同じ線引きを明示している**（本 PR の背景）: 「道1（`examples/chat` が `association` を使う）を採る。道2（既定 on）は手を付けない」。**⟹ 分岐そのものはこの ADR が新しく決めたものではなく、Issue #291 と作業指示が既に決めていたものを実装する。**

---

## 1. どの門・どの基準値が動くか（実装前の洗い出し）

**`examples/chat/src` 全体で `recall(` を呼んでいる箇所を全て確認した【現物】。**

| ファイル | 呼び出し方 | どのサブコマンド | 影響 |
|---|---|---|---|
| `mnemora-path.ts`（`queryRecall`） | `{ text, budget?, association? }` | `compare`（`compare.ts` 経由）・`chat`（`budget-demo.ts` 経由） | **対象。`compare-baseline.json` が動く** |
| `scope.ts` | `runtime.recall(ctx, { text })` 直呼び | `scope` | 触れない。association を渡していない |
| `backfill.ts` | `runtime.recall(ctx, { text, occurredAfter? })` | `backfill` | 触れない |
| `correction-demo.ts` | `runtime.recall(ctx, { text, limit: 1 })` | `correction` | 触れない |
| `recall-explain.ts` | `runtime.recall`/`getRecall` | `explain` | 触れない |
| `retrieval-quality.ts` | `runtime.recall(ctx, { text, channels? })`。**docstring で「`text` 以外を渡さない」と明記** | `retrieval` | **触れない。`retrieval-baseline.json` は動かない** |
| `identifier-arm.ts` | `runtime.recall(ctx, { text })` | `identifier-probes` | **触れない。`identifier-probe-baseline.json` は動かない** |
| `time-term-arm.ts` | `runtime.recall(ctx, { text })` | `time-term` | **触れない。`time-term-baseline.json` は動かない** |
| `consolidation-cost.ts` | `runtime.recall(ctx, { text[, limit, budget] })` | `consolidation-cost` | **触れない。`consolidation-baseline.json` は動かない** |
| `archive-sweep-cost.ts` | `runtime.recall(ctx, { text[, limit, budget] })` | `archive-sweep-cost` | **触れない。`archive-sweep-baseline.json` は動かない** |
| `association-arm.ts` | `runtime.recall(ctx, { text, association? })`。**arm 自身が on/off を明示的に切り替える測定器** | `association-probes` | **⛔ 意図して触れない**（基準値ファイル無し、ADR 0158 決定3・4） |

**⟹ 影響するのは `compare-baseline.json` の1本だけである。**理由は構造的なもの——`retrieval-quality.ts`/`identifier-arm.ts`/`time-term-arm.ts`/`consolidation-cost.ts`/`archive-sweep-cost.ts` はいずれも「`recall()` にはこの欄以外を渡さない」という明示的な規律を持つ独立した測定器であり、他の欄（`channels`/`budget`/`limit` 以外）を増やすこと自体がその規律を破る。**5本のベンチの既存の規律を保つ**ことを、この ADR は意図して選んだ——`docs/autonomy.md`§3.1「どちらを選んでも技術的には成立するが」に該当するので、ここに理由を書く:

- **もし5本にも association を混ぜていたら**: 「順位が変わったのは連想枠のせいか、チャンネル/予算/limit のせいか」を切り分けられなくなる。ADR 0151/0158 が「連想枠は既存の測定に混ぜない」ために独立した `association-probes` を新設した理由（ADR 0158 決定3「既存 probe 集合に混ぜる案を却下」）と、まったく同じ理由がここにも刺さる。
- **`examples/chat` を「呼び手」として見たとき、実際にアプリの応答生成に相当する経路は `mnemora-path.ts` の `queryRecall` である**——このファイルの既存の docstring 自身が「経路B（mnemora）の想起段」「呼び出し側が実際にプロンプトへ積むのは…」と明記しており、5本のベンチ（測定器）とは役割が違う。

**`budget-demo.ts`（`chat` サブコマンドの一部）も `queryRecall` を経由するため影響を受ける**が、基準値ファイルを持たない（本物の Postgres に対する postgres test が3本あるのみ）。**実測してこの3本が壊れないことを確認した**（下記「測ったこと」）。

---

## 2. `maxCount` を 10 にした理由（北極星の問い1に当てる）

北極星の問い1: **「これは、毎回渡す量を減らす方向に働くか。増やすなら、その分だけ想起が良くなると言えるか。」**

連想枠は量を増やす機能である。増やす以上、増やした分に見合う効果を示す義務がある。Issue #291 の実測（上表）を効率で見ると:

| 変化 | gold の増分 | 費用の増分 | 効率（gold/費用%） |
|---|---|---|---|
| off → `maxCount=3` | +9 | +1.44% | 6.25 |
| `maxCount=3` → `5` | +1 | +0.78% | 1.28 |
| `maxCount=5` → `10` | +2 | +2.10% | 0.95 |

**限界効率は単調に下がる**（典型的な逓減）。これだけを見ると `maxCount=3` が最も「効率が良い」ように見えるが、**この12件は「聞かれていないことを、自分から思い出す」という目指す姿そのものを検査するために設計された三角形 probe である**（ADR 0158）。`maxCount=5` はこの12件のうち2件（`ascii-project`・`ascii-router`、`goldRank` が16・17位）を**構造的に取りこぼす**——連想枠の探索窓は `limit(10) + maxCount` であり、この2件の gold はその窓の外に居る。

**⟹ `maxCount=5` を採ると、目指す姿7項目のうち唯一まるごと空いていた項目2（ADR 0151 が実装するまで0%だった）を、また部分的にしか満たさない状態に戻す。** `maxCount=10` は、この12件の範囲で**構造的な取りこぼしを完全に閉じる**（0/12 → 12/12）唯一の値である。費用は追加で+2.10ポイント（合計+4.32%）——絶対値としては小さい（`compare` の実測では会話が長いほど naive に対する比率はさらに小さくなる。下記「測ったこと」参照）。

**「大きいほうが良い」という理由では選んでいない**——選んだ理由は、**この値だけが「聞かれていないことを、自分から思い出す」を12件全件で実現できると実測されており、次の値（5）では実測上2件が構造的に取りこぼされる**という、効果の質的な違いである。北極星の問い1が要求する「増やすなら、その分だけ想起が良くなると言えるか」に対し、`maxCount=10` は「12件中12件に届く」という明確な答えを持つが、`maxCount=5` は「12件中10件」という部分的な答えしか持たない。

**⚠ この判断は12件の合成 probe に基づく。** 実運用での一般化は、下記「引き受けた負債」に明記する。

---

## 3. `packages/core` の既定を on にしない理由（分離の再確認）

ADR 0151 は北極星の問い1で「既定 on」を明示的に落としている——連想枠は量を増やす機能であり、既定 on は「明示していない呼び手の焼く量が黙って増える」という、問い1が名指しで落とす形そのものだからである。**この ADR はその判断を覆さない。**`examples/chat` という**1つの呼び手**が、**明示的に**`association`を渡す形を採ることと、`packages/core` 自身の既定を変えることは別の階層の判断であり、後者は北極星の問い1を当て直す新しい ADR を要する、かつ「製品の性格を決める判断」（`docs/autonomy.md`§3.1）としてオーナーに諮る必要がある。**この PR・この ADR はそこに踏み込まない。**

---

## 決定

1. `examples/chat/src/mnemora-path.ts` に `DEFAULT_MNEMORA_PATH_ASSOCIATION: RecallAssociationQuery = { maxCount: 10 }` を追加する。
2. `MnemoraPathOptions.association?: RecallAssociationQuery | null` を追加する。`queryRecall` は `opts.association` が省略されていれば既定値を渡し、`null` が明示されていれば `packages/core` の既定（off）のまま呼ぶ。
3. `compare.ts`・`budget-demo.ts`・`cli.ts` の `chat` サブコマンドは呼び出し方を変えていない（`opts.association` を渡さない）——**関数側の既定を変えたことで、これらの呼び出し側は自動的にオプトインする。**
4. 上記5本のベンチ arm・`association-arm.ts` には一切触れない。
5. `examples/chat/compare-baseline.json` を、この PR 自身の CI（`example-chat` ジョブ）が生成した artifact で更新する（ADR 0133 決定1と同じ手順）。

---

## 検討して採らなかった案

| 案 | 却下理由 |
|---|---|
| `maxCount=5`（費用対効果重視） | 上記2番のとおり、この12件の中で構造的に2件を取りこぼす。「目指す姿を満たす」という本 issue の目的に対して不完全 |
| `maxCount=3` | 効率は最良だが、9/12 止まり。同上の理由でより不完全 |
| `packages/core` の既定を on にする（Issue #291「道2」） | ADR 0151 が問い1で明示的に落とした形。マネージャーの作業指示が明示的に「手を付けない」と分離しており、製品の性格を決める判断としてオーナー側に残す |
| 5本のベンチ arm にも `association` を混ぜる | 上記§1のとおり、各ベンチが持つ「この欄以外を渡さない」という既存の規律を破り、何が順位を動かしたかの切り分けを壊す |
| `association-probes` ベンチ自身の on/off 既定を変える | ADR 0158 決定3・4が明示的に禁じている——on/off比較器の意味が壊れる |
| 環境変数で `maxCount` を上書き可能にする（例 `MNEMORA_CHAT_ASSOCIATION_MAX_COUNT`） | 検討したが採らなかった。`MnemoraPathOptions.association` という呼び出し側のプログラム的な上書き口は既に用意した（テスト・将来の呼び出し側のため）。環境変数までは今回のスコープでは要らないと判断した——使う場面（`examples/chat` を CLI から動かす人が値を変えたい場面）が今のところ無く、「念のため」で選択肢を増やすことは避けた（`docs/autonomy.md`「やりすぎない」規律）。要る場面が具体化したら追加する |

---

## 引き受けた負債

1. 🔴 **この12件の合成 probe から「一般にどの程度効くか」を統計的に主張できない**（ADR 0033 §3・Issue #291 コメント末尾と同じ規律の適用）。`maxCount=10` が「常に最適」であることの証明ではない。
2. ⚠ **`compare` ベンチでの実測（下記）は、`association-probes` ベンチの +4.32% と完全には一致しない**——42〜162ターンの行では**費用が減る**という、事前に想定していなかった向きの効果が観測された（下記「測ったこと」で理由を分析している）。この理由（目次帯の固定費 vs 本体への昇格コスト）はコードを読んで導いたものであり、`digest-band.ts` の値を直接変異させて検証してはいない。
3. ⚠ **CI（GitHub Actions の Postgres service container）ではなく、この作業環境に立てた非特権 Postgres 17.11 + pgvector 0.8.0 クラスタで実測した。** バージョンはメジャーで一致するが、CI の `pgvector/pgvector:pg17` イメージのマイナーバージョンまでは確認していない（ADR 0167 と同じ限界）。
4. ⚠ **`budget-demo.ts`／`chat` サブコマンドの対比デモは、association を既定で申告するようになったが、この PR が使った会話量（`buildConversation(8)`）では association の候補が0件だった**（スコープが `limit`=10 を超えないため）。association が非0になる規模でこのデモ自体を測ってはいない。

---

## これが覆るとしたら

1. **`maxCount=10` の費用（`compare` の322/642ターン行で観測した +3.95%〜+5.83%）が、実運用の会話パターンでもっと大きく出ると実測されたとき。** そのとき `maxCount` を下げる判断が要る——この ADR の§2の分析（12件全件に届く値を選ぶ）を、実運用の costs/benefit で当て直す。
2. **`packages/core` の既定を on にする判断（道2）がオーナーによって選ばれたとき。** そのとき本 ADR の決定3（既定はoffのまま）は上書きされるが、`DEFAULT_MNEMORA_PATH_ASSOCIATION`（呼び出し側の既定値としての `maxCount=10`）自体は、新しい既定値の参考値として引き継げる可能性がある。
3. **`association-probes` ベンチが門になり（ADR 0158「これが覆るとしたら」4番）、`maxCount` の最適値についてより広い実測が得られたとき。** そのとき本 ADR の値をその実測で置き換える。

---

## 測ったこと

**環境**: この作業環境には元々 `DATABASE_URL` が無かったが、ADR 0167 と同じ方法で `postgresql-17`/`postgresql-17-pgvector` の Debian パッケージから非特権クラスタを立てた（port 5544、`initdb`/`pg_ctl`）。

**【実測】examples/chat の postgres テスト**:

- 変更前: `mnemora-path.postgres.test.ts`（5件）・`budget-demo.postgres.test.ts`（3件）が全件緑。
- 変更後（`queryRecall` の既定を association ありに変更した後）: 同じ8件が**全件緑のまま**。
- `examples/chat` の vitest 全件（`DATABASE_URL` あり）: **50 test files / 396 tests、全件緑**（変更後）。

**【実測】新設した単体テスト**（`mnemora-path.test.ts`、DB 不要）: `queryRecall` が (a) 省略時に `DEFAULT_MNEMORA_PATH_ASSOCIATION` を渡すこと、(b) `association: null` で `packages/core` の既定（off）のまま呼ぶこと、(c) 明示値を渡せば上書きされることを検査する3件を追加。**変異試験**: `queryRecall` の association 決定ロジックを `undefined` 固定に変異させたところ、新設した3件のうち2件が期待通り赤くなった。復元後、5件（既存2件含む）が緑に戻った。

**【実測】`compare` の実測（この PR の変更前後、ローカル Postgres、`llmMode=recorded`/`embeddingMode=recorded`、`examples/chat/cassettes/compare.json` の再生）**:

| 会話ターン数 | mnemora chars（変更前） | mnemora chars（変更後） | mnemora/naive（変更前→変更後） | 返った件数（前→後） |
|---|---|---|---|---|
| 2〜22 | 不変 | 不変 | 不変 | 不変（over_limitが発生しないため association が何も拾わない） |
| 42 | 647 | 583 | 61.7% → 55.6% | 10 → 11 |
| 82 | 1537 | 1345 | 74.5% → 65.2% | 10 → 13 |
| 162 | 3459 | 3075 | 84.7% → 75.3% | 10 → 16 |
| 322 | 4307 | 4558 | 53.0% → 56.0%（🔴 ⭐門が退行と判定） | 10 → 20 |
| 642 | 4306 | 4476 | 26.5% → 27.6%（🔴 ⭐門が退行と判定） | 10 → 20 |

`node scripts/compare-summary.mjs --measured <変更後artifact> --baseline examples/chat/compare-baseline.json` を実行し、変更前の値が基準値と完全一致すること、変更後は42/82/162ターンで基準値との相違（改善方向、退行ではない）、322/642ターンで**退行**（`mnemoraShareOfNaiveChars` の悪化、exit 1）が出ることを確認した。

**⟹ `mnemoraShareOfNaiveChars` の悪化幅（322ターン: +5.83%、642ターン: +3.95%、いずれも相対値）は、`association-probes` ベンチの +4.32%（Issue #291、`maxCount=10`）と近い桁である。** 42〜162ターンでは逆に**改善**した——理由は`digest-band.ts`の`DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS`（63字/件の固定費）にある。除外候補の総数が`DEFAULT_DIGEST_BAND_LIMIT`（50件）以内に収まっている行（42〜162ターン、除外4〜39件）では、連想枠が候補を目次帯から本体（memories tier）へ昇格させると、63字の固定費を伴う目次帯の1行が、固定費を持たない本体の1件に置き換わり、正味の文字数が減ることがある。322ターン以降は除外候補が50件を超えて目次帯が既に上限で頭打ちのため、連想枠が拾う候補は目次帯に元々居場所が無く、純粋な追加になる。**この説明はコードを読んで導いた仮説であり、`digest-band.ts`の値を直接変異させて検証してはいない**（負債2）。

**【実測】6つの門**:

- `pnpm run typecheck` → 緑
- `pnpm run lint` → 緑
- `pnpm run format:check` → 緑
- `pnpm run test`（`DATABASE_URL` 無し） → 緑。「DB テストは実行していません」と明示
- `pnpm run build` → 緑
- `pnpm run pack:check`（`rm -rf packages/*/dist && pnpm run build` 後）→ 緑

## 確かめていないこと

- **`maxCount=10` が実運用の会話パターン（合成 probe ではない）でも同じ費用対効果を持つか。**
- **`compare` の42〜162ターン行での「費用減少」効果が、`digest-band.ts` の固定費以外の要因を持たないか**（コードを読んだ推論であり、直接の変異試験はしていない）。
- **CI の Postgres service container（`pgvector/pgvector:pg17`）のマイナーバージョンが、この作業環境（PostgreSQL 17.11 + pgvector 0.8.0）と一致するか。**
- **`budget-demo.ts` のデモが association 候補を実際に返す規模（会話がより長い場合）でどう動くか。**

## 人から受け取った前提（出所付き）

- Issue #291 の本文・全コメント——`gh issue view 291 --json title,body,comments` で直接読んだ【現物】。
- ADR 0151 / 0158 / 0167 の内容——`docs/decisions/` から直接読んだ【現物】。
- マネージャーからの作業指示（道1を採る、道2はオーナーに諮る案件として分離する、`maxCount` は費用対効果で決める）——委譲文として受け取った。`maxCount=10` を選んだ理由付けそのものはこの ADR が実測に基づき自分で行った。

---

## 追記 (2026-09-16): ADR 0166 が前提として要ったこと／§1の見落としを訂正する

**この ADR が CI 上で `compare-baseline.json` を更新したところ、`examples/chat/src/__tests__/recall-footprint-baseline.test.ts`（Issue #276 の `estimateRecallFootprint` を同じ `compare-baseline.json` に対して検算する⭐門の歯）が7件赤くなった。** [ADR 0166](./0166-recall-footprint-association-term.md) がその原因（推定器が連想枠の項を持っていなかった）を直し、`estimateRecallFootprint` に `associationCount` の項を足している。**⟹ この PR は ADR 0168（本 ADR）単体では成立せず、ADR 0166 を前提として要る。**

**🔴 §1「どの門・どの基準値が動くか」の結論(「影響するのは `compare-baseline.json` の1本だけである」)は誤りだった。** 正確には——**動く基準値ファイルは `compare-baseline.json` の1本で合っている**（`retrieval-baseline.json` 等5本は本文の通り無関係）が、**その1本を読む門は2本ある**ことを§1が見落としていた: (1) `scripts/compare-summary.mjs` が `compare-baseline.json` 自身との差分を見る⭐門（ADR 0133）、(2) `recall-footprint-baseline.test.ts` が**同じ `compare-baseline.json` を、`estimateRecallFootprint`/`calibrateRecallFootprint` の検算に使う**⭐門（Issue #276）。§1は`recall()` の呼び出し箇所（`mnemora-path.ts`・5本のベンチ・`association-arm.ts`）だけを洗い出し、**基準値ファイルの「書き手」側の影響だけを追って、「読み手」側の影響を追っていなかった**——`compare-baseline.json` は `compare` ベンチの基準値であると同時に、`recall-footprint` の較正・検算のデータソースでもある、という二重の役割を持つことが§1の洗い出しから漏れていた。

**引き受けた負債への追記**: 上記は「オーナーが仕様に明示した非目標」のような設計判断ではなく、単純な洗い出し漏れである。**同種の見落とし**——ある基準値ファイルを「書く」経路だけを洗い出し、「読む」経路（他のテスト・他の bench・他の門）を洗い出さない——が、今後 `*-baseline.json` を更新する PR で繰り返される可能性がある。`git grep` で対象ファイル名を検索し、書き手だけでなく読み手も列挙することを、次に基準値ファイルを更新する作業者への申し送りとする。
