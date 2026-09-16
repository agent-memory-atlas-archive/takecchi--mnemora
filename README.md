# mnemora

**既存の LLM アプリケーションの下に敷く「認知レイヤー」。**

単発の `入力 → LLM → 出力` の外側に、永続する記憶と継続する認知処理を置く。

```
Application → Agent / LLM → Cognitive Runtime → Storage / LLM / Queue
                              ├── Observation
                              ├── Memory / Recall / Association
                              ├── Reinforcement / Forgetting / Consolidation
                              └── Reflection / Background Cognition
```

**エージェントフレームワークを作り直すものではない。** LangGraph・Mastra・自作 Agent の
**下に足せる**位置を狙う。

---

## 目指しているもの

**LLM アプリケーションに「思い出す」を与えること。「保存する」ではなく。**

保存はすでに解けている。解けていないのは、
**大量に貯めたものの中から、いま必要な分だけを引き当てること**である。

**近づいたかどうかを測る物差しは一つだけ**——
**使う側が、会話ログを全部プロンプトへ積むのをやめられたか。**

→ **[docs/north-star.md](./docs/north-star.md)**（正典。目的 / 目指す姿 / 物差し / 迷ったときの問い）

---

## 何をするものか

特定のチャットボット専用ではなく、Web アプリ・AI 秘書・Discord Bot・ゲーム NPC・
コーディングエージェント・ロボット・個人 AI・業務エージェントから再利用できる汎用基盤を目指す。

大量の会話ログを毎回 LLM へ全部渡すのではなく、**必要な記憶だけを**
意味・構造・時間・重要度・利用頻度・関連性から思い出す。

そこから新しい知識を統合し、使われない記憶は自然に想起されにくくなり、
必要なときだけ過去の記憶を呼び戻せる。

外から見える API は小さく保つ:

**⚠ `brain` のような受け皿オブジェクトは無い。**下の**中核の5動詞**は
`createRuntime()`（`@mnemora/core`）が返す `runtime` のメソッドであり、
**すべて第一引数に `ctx`（`tenantId` 必須）を取る。**

```ts
import type { Runtime } from "@mnemora/core";

// runtime は createRuntime() で組み立てる（実装は @mnemora/postgres・@mnemora/openai から。
// 配線の詳細は packages/core/README.md）。ここでは型だけを示す骨格。
declare const runtime: Runtime;
const ctx = { tenantId: "guild-123", subjectId: "user-456" };

await runtime.observe(ctx, { kind: "utterance", text: "明日、京都へ出張する", speaker: "user" });
const recalled = await runtime.recall(ctx, { text: "京都の予定は?" });
await runtime.reflect(ctx, { target: { memoryIds: [] } });
await runtime.consolidate(ctx, { target: { memoryIds: [] } });
await runtime.forget(ctx, { memoryIds: [] });
```

**⟹ 中核の5動詞の正式なシグネチャは「## 外から見える API」節、`ctx` の意味は
「## 記憶を誰に紐づけるか」節を見ること。**

---

## いまの状態

**Phase 1（MVP）の実装が一巡した。**`packages/core`（型・interface・runtime）、`packages/postgres`、
`packages/openai`、`packages/anthropic`、`packages/local-embedding`、
`packages/testkit`（適合テスト）、`examples/chat`（サンプル CLI）がある。
Phase 1 の範囲と、そこに入れなかったものは [docs/roadmap.md](./docs/roadmap.md) を参照。

**版の付け方**: `v1.0.0` 以降は [semver](https://semver.org/lang/ja/) に従う
——**公開 API の破壊的変更は major を上げる。**⛔ **「もう変わらない」という意味ではない。**
破壊的変更は major を上げる形で起こりうる。ただしそのとき **ADR を書くことは必須である**
（[docs/autonomy.md](./docs/autonomy.md) §3 逐語「公開 API の破壊的変更も、ADR を書けば
実装してよい……ただし ADR に書くことは変わらず必須」、
[ADR 0156](./docs/decisions/0156-delegate-5-grade-judgment-and-breaking-changes.md)）
⟹ **何がどの版で変わったかは [CHANGELOG.md](./CHANGELOG.md)、なぜ変わったかは
[docs/decisions/](./docs/decisions/) から辿れる。**

名前は `mnemora`（`@mnemora/*`）に確定しており、暫定ではない
（経緯は [docs/vision.md](./docs/vision.md) の「名前について」と
[ADR 0014](./docs/decisions/0014-package-name-mnemora.md)）。

| 文書 | 何が書いてあるか |
|---|---|
| [docs/north-star.md](./docs/north-star.md) | **正典。**目指すもの・物差し・迷ったときの問い |
| [docs/vision.md](./docs/vision.md) | プロジェクトの理解 / 用語 / やらないこと / 名前 |
| [docs/architecture.md](./docs/architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [docs/memory-model.md](./docs/memory-model.md) | DB schema 案 / Memory lifecycle / 矛盾 / 忘却 / 監査ログ |
| [docs/recall.md](./docs/recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [docs/roadmap.md](./docs/roadmap.md) | Phase 1 実装計画 / リスク / まだ判断が必要な点 |
| [docs/alteroid-findings.md](./docs/alteroid-findings.md) | 設計の材料にした運用知見を、現物で検証した記録 |
| [docs/decisions/](./docs/decisions/) | ADR — 重大な設計判断と、その理由 |

このリポジトリで作業する人・エージェント向けの手引きは [AGENTS.md](./AGENTS.md) にある。

---

## 想起の質をどう測っているか

**`recall()` が「必要な記憶だけを思い出せているか」を、CI で毎 PR 測っている。**
API キーは要らない——**実 API が返した埋め込みの記録を再生している**（下の「⚠ 『実 embedding』の意味」）。

| ジョブ（[.github/workflows/ci.yml](./.github/workflows/ci.yml)、`jobs.<キー>`） | 何を測るか | 埋め込み |
|---|---|---|
| 想起の質（[ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md)）`retrieval-quality` | 意味的関連性 probe **7件**の `hit@1` / `hit@10` / MRR | 記録の再生 |
| 識別子・固有名詞 probe（[ADR 0094](./docs/decisions/0094-identifier-probes-local-embedding.md)）`identifier-probes` | 識別子・固有名詞 probe **30件**（`examples/chat/src/identifier-probe-set.ts` の `IDENTIFIER_PROBES`） | `@mnemora/local-embedding`（プロセス内推論） |
| 統合の費用（[ADR 0101](./docs/decisions/0101-how-to-measure-whether-consolidate-moved-the-north-star.md)）`consolidation-cost` | `consolidate()` が「載る量」に効いたか | 同上 |

**⚠ この表は、`ci.yml` の測定系ジョブの全部ではない。**上の3つのほかに
`association-probes`（連想枠が想起の質を動かすか）・`archive-sweep-cost`（掃引が「載る量」/ hit@k に
効くか）・`time-term`（時間項が順位を動かすか）・`validity`（`validAt` ゲートが候補の有無を動かすか）が
**同じく毎 PR 走っている。**⟹ **ここに挙げていないジョブが無いとは読まないこと**——
一覧は `.github/workflows/ci.yml` の `jobs` を直接見ること。

**⚠ 行番号ではなくジョブ名（`jobs.<キー>`）で引く。**ジョブが増減すると行番号は動くが、
ジョブ名は動かない——`.github/workflows/ci.yml` の該当ジョブを `grep -n "^  <ジョブ名>:"`
で探すこと。引き金は `on.push.branches: [main]` と `on.pull_request` である——
**`schedule` ではなく、毎 PR 走る。**値は `retrieval-quality` ジョブの **Job Summary**と
成果物 `retrieval-quality.json`（同ジョブの `actions/upload-artifact` ステップ）に残り、
`examples/chat/retrieval-baseline.json` の基準値と突き合わされる。
**基準値は手で更新する**（CI が書き換えることはない）。

### ⚠ 「実 embedding」の意味

**この2つは別物なので、書き分ける。**

- ⛔ **実 API を毎回叩いてはいない。**CI は `OPENAI_API_KEY` を持たない。
- ✅ **実 API が返した埋め込みを再生している。**`examples/chat/cassettes/retrieval.json`
  （`text-embedding-3-small` / 256次元 / 152件）を `MNEMORA_PROVIDER_SOURCE=recorded`
  （`retrieval-quality` ジョブの env）で再生する。

**⟹ 鍵の無い CI でも、擬似物ではない埋め込みで測れる。**
（擬似 provider で測った想起の質は性能について何も言っていない。3層の区別は [AGENTS.md](./AGENTS.md) を見ること。）

### 🔴 この仕組みが測っていないこと

**「継続的に測っている」は「想起の質を保証している」ではない。**採用を検討する側が
過大に読まないように、測れていない範囲をここに並べる。

- **閾値の門は無い。**基準値と相違しても `exit 0` のままである
  （`scripts/retrieval-quality-summary.mjs:19` に意図として明記）。理由は
  [ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md) §2——
  **probe が7件では閾値の門が偽陽性を出す。**
- **埋め込みモデル側が変わったことによる退行は、再生では検知できない。**
  カセットを録り直すまで同じベクトルが返り続ける。
- **このベンチは語彙チャンネルを一度も通していない**
  （[ADR 0108](./docs/decisions/0108-retrieval-bench-does-not-exercise-lexical-channel.md)）。
  ⟹ [ADR 0092](./docs/decisions/0092-lexical-or-coverage.md) で入れた語彙側の変更は、まだ測られていない。
- **順位を実際に決めているのは `similarity` ただ1項である**
  （[ADR 0109](./docs/decisions/0109-which-score-terms-actually-rank.md)）。
  スコアは5項あるが、**このベンチでは残り4項が順位を動かしていない。**
- **probe 7件は意図して凍結されている。**時間項を定数に保つための統制条件であり
  （[ADR 0058](./docs/decisions/0058-measure-the-time-term-in-a-separate-arm.md) §1.4）、
  gold/distractor の14件は変更しない。
  **⟹ ゴールデンセットを増やすときは、この集合を書き換えず別の集合を作る**（ADR 0094 がその形）。

外から評価する立場からの現状の評価は、[Issue #109](https://github.com/takecchi/mnemora/issues/109)
に測定付きで書いてある。

---

## ローカルでの開発（手元で CI と同じ認証方式を踏む）

`packages/postgres` / `examples/chat` の検査は本物の Postgres + pgvector を要求する
（擬似物へのフォールバックは無い）。**CI の service container は `POSTGRES_PASSWORD`
を設定しており、これは公式 postgres イメージの host 認証を既定で `scram-sha-256`
にする。** 手元でパスワード無し（`trust` 認証）の Postgres を使っていると、
認証方式に依存する壊れ方（パスワード付け忘れ等）が手元の門を素通りしうる
（[Issue #232](https://github.com/takecchi/mnemora/issues/232) /
[ADR 0130](./docs/decisions/0130-postgres-auth-parity-docker-compose.md)）。

手元でも CI と同じ認証方式を踏みたい場合は、repo ルートの
[`docker-compose.yml`](./docker-compose.yml)（CI の service container と値を
揃えてある）を使う:

```bash
docker compose up -d
# health になるまで少し待つ（`docker compose ps` で確認できる）
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemora_ci \
  pnpm --filter @mnemora/postgres run migrate
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemora_ci pnpm run test
docker compose down
```

**使うかどうかは任意である。** `DATABASE_URL` を渡さない既定の `pnpm run test` の
挙動は変えていない——DB テストは「実行していません」と告知して緑のまま通る
（[ADR 0015](./docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)）。

`docker-compose.yml` と `.github/workflows/ci.yml` の値が食い違うと、
`scripts/__tests__/postgres-auth-parity.test.mjs` が赤くなる。

---

## インストール

```bash
pnpm add @mnemora/core @mnemora/postgres @mnemora/openai
# または
npm i @mnemora/core @mnemora/postgres @mnemora/openai
```

**Node.js >= 22 と ESM が要る**（CommonJS からは Node 22.12 以降の `require(esm)` で読める）。
`@mnemora/postgres` は本物の Postgres + pgvector を要求する——擬似物での代替は無い。

LLM を Anthropic で回すなら `@mnemora/anthropic` を足す。**ただし埋め込みは別の provider が要る**
——Anthropic は埋め込み API を提供していないため、`@mnemora/anthropic` は `LLMProvider` だけを実装する
（[ADR 0072](./docs/decisions/0072-anthropic-llm-provider.md)）。

adapter を自作してテストするなら `@mnemora/testkit` も devDependency として入れる。
各パッケージの install コマンドと動く最小の例:

- [packages/core/README.md](./packages/core/README.md)
- [packages/postgres/README.md](./packages/postgres/README.md)
- [packages/openai/README.md](./packages/openai/README.md)
- [packages/anthropic/README.md](./packages/anthropic/README.md)
- [packages/testkit/README.md](./packages/testkit/README.md)

---

## 外から見える API

```ts
observe(ctx, input)      // 起きたことを記録する
recall(ctx, query)       // 問いに対して記憶を取り出す
reflect(ctx, opts)       // 入力が無い状態で、既存の記憶から新しい記憶を作る
consolidate(ctx, opts)   // 複数の記憶を統合する
forget(ctx, target)      // 記憶を落とす / 失効させる
```

**内部が複雑でも、記憶そのものを動かす中核操作はこの5つに保つ。ここは増やさない。**

**⚠ 冒頭の構成図にある `Association`（連想枠）は、`@mnemora/core` の `recall()` では
既定で走らない。**`recall()` に `association: { maxCount: 10 }` のように**明示的に渡した
ときだけ**走る（省略時は連想を一切走らせない——`packages/core/src/recall.ts:1132`、
[ADR 0151](./docs/decisions/0151-recall-association-unprompted.md)）。
⟹ **npm から入れたままの既定の振る舞いは「聞かれたことにしか答えない」。**
渡し方・各フィールドの既定値・渡したときの実測値は
[packages/core/README.md](./packages/core/README.md) を見ること。
⚠ **渡すとき、`anchorCount` だけを上げても連想の裾野は広がらない**——連想の起点は
`RecallQuery.limit`（既定 10）の内側から取るので、`limit` が天井になる（同 README /
[docs/recall.md](./docs/recall.md) §9.2）。

### `Runtime` の残り9個 — 中核を守る3つの層

**`Runtime` には他に9個のメソッドがある**（`tick` / `getRecall` / `reextract` / `reembed` /
`sweepArchive` / `restoreArchived` / `purge` / `markContested` / `resolveContested`）。
これらは「6つ目の動詞」ではなく、**中核を狭く保つために別の層へ出した口**であり、
3つに分かれる（詳細と検討過程は [ADR 0171](./docs/decisions/0171-five-verbs-plus-three-layers.md)）。

- **保守操作**（`tick` / `reembed` / `reextract` / `sweepArchive`）——「いつ動かすか」を
  呼び出し側が決める口。自動では走らない（`sweepArchive` の doc コメント自身が
  「呼び出し側が明示的にこれを呼んだときだけ走る保守操作である」と書いている）。
- **是正・取り消し**（`markContested` / `resolveContested` / `restoreArchived` / `purge`）——
  呼び出し側（人・上位のアプリケーション層・将来の自動検出）が既に下した判断
  （矛盾の指摘・決着・復帰・完全削除）を、決められた形で書き込む口。
  どちらが正しいかを mnemora 自身は判定しない。**⚠ 矛盾を*見つける*処理も持たない**——
  下の「⚠ mnemora が保証していないこと」の節を見ること。
- **説明**（`getRecall`）——なぜそれが想起されたかを、後から読み戻す口
  （`docs/north-star.md`「目指す姿」の3番目）。

**この分類の要点は、歯止めが *どこに* 効くかである。**新しく何かを足したくなったとき、
それが記憶そのものを動かす操作（中核5動詞と同じ性質）なら、足せない。保守・是正・説明の
どれかに当たるなら、その層の性格に合っているかを問う——**「分類できるから足してよい」では
ない。**3層はあくまで既存の9個を説明する後付けの整理であり、新しい口を作る免罪符には
しない。

### 「mnemora を使うべきか」を判定する（動詞ではない）

**mnemora を入れるとプロンプトが小さくなるのか、会話ログを全部積むほうが小さいのかは、
会話の長さによって変わる**——短い会話では mnemora のほうが大きい。
その判定は `@mnemora/core` の**純関数**として提供する（[ADR 0147](./docs/decisions/0147-recall-footprint-estimator.md)）。

```ts
import { compareWithFullLog } from "@mnemora/core";

const verdict = compareWithFullLog({
  fullLogChars: transcript.length,        // 会話ログを全部積んだときの文字数（呼び出し側が測る）
  shape: { memoryCountInScope: 120 },     // スコープ内の Memory 件数
});
// verdict.verdict                 → 'mnemora_smaller' | 'full_log_smaller' | 'too_close_to_call'
// verdict.breakEvenFullLogChars   → 会話ログが何文字を超えたら mnemora が小さくなるか
// verdict.reasons                 → なぜそう判定したか（コードで分岐できる形）
```

⚠ **これは「6つ目の動詞」でも、上の保守・是正・説明のどの層でもない。**`Runtime` の
メソッドですらなく、`ctx` も取らない純関数であり、**`recall()` を一度も呼んでいない時点でも
使える**——「mnemora を入れるべきか」を判断したいのは、まさにその時点だからである。
`Runtime` のメソッドにすると DB も provider も配線済みの環境でしか呼べなくなってしまい、
それでは問いに答えられない（[ADR 0147](./docs/decisions/0147-recall-footprint-estimator.md)
決定5、[ADR 0171](./docs/decisions/0171-five-verbs-plus-three-layers.md)）。

⚠ **見ているのは量だけである。**「削っても目的の記憶が落ちていないか」には答えない
（下の「想起の質をどう測っているか」を見ること）。**量で負けていても、想起のために
mnemora を使うという判断はありうる。**

⚠ **同梱の既定係数は、このリポジトリのベンチ（日本語・記録済みカセット）で測った値である。**
自分の環境の値ではない。`calibrateRecallFootprint()` に `recall()` の結果を渡せば較正できる
（新しい計測は要らない）。較正したかどうかは戻り値の `estimate.profileOrigin.kind` で分岐できる。

---

## 記憶を誰に紐づけるか（`tenantId` / `subjectId`）

**上の5つは、すべて第一引数に `ctx` を取る。**その `ctx` が、記憶を誰に紐づけるかを決める。

```ts
// tenantId は必須。subjectId は省略できる。
const ctx = { tenantId: "guild-123", subjectId: "user-456" }

await observe(ctx, input)
const recalled = await recall(ctx, { text: "..." })
```

| | 何の単位か | 跨いだら |
|---|---|---|
| **`tenantId`** | **隔離境界。安全性の単位** | **事故** |
| **`subjectId`**（省略可） | テナント**内**の整理の単位 | 事故ではない |

**この非対称が芯である。**ひとつの Discord Bot をいくつものサーバーへ導入する場合、
**導入先のサーバーが `tenantId`、そのサーバー内の各ユーザーが `subjectId`** になる。
別のサーバーの記憶が出てくることは設計上あってはならない事故だが、同じサーバー内で
ユーザー A と B の記憶が混ざるのは整理の失敗であって、性質が違う。

**⟹ ひとつの DB で複数のエージェントを動かすなら、`tenantId` を分ける。**
`subjectId` を渡すと `recall()` はテナント内のその subject に絞られ、**省略するとテナント全体**になる。

**クロステナントで漏れないことは、`packages/testkit` の適合テストが測っている**——
どの adapter 実装に対しても走る:

- `VectorStore conformance` — 「クロステナントの search には他テナントの vector が現れない」
- `OutboxStore conformance` — 「クロステナントの claimBatch は他テナントの未処理ジョブを返さない」
- `EventStore conformance` — 「クロステナントの list は他テナントのイベントを含まない」

### ⚠ mnemora が保証していないこと

**`tenantId` は呼び出し側が渡す不透明な文字列である。mnemora はテナントの台帳を持たず、
`tenantId` の存在確認も認証もしない。**

**⟹ 隔離は「使う側が正しい `tenantId` を渡すこと」に依存している。**
誰がどの `tenantId` を名乗ってよいかを決めるのは、mnemora ではなく上のアプリケーションである。

詳細は [docs/vision.md](./docs/vision.md) の「Tenant と Subject を混同しない」と
[docs/architecture.md](./docs/architecture.md) §3.7。

**⚠ もう1つある: 矛盾の検出も、mnemora は行わない。**
`markContested` / `resolveContested` は **「この2件は対向する」と*既に決まっている*ものを
書き込む口**であり（上の「是正・取り消し」）、**会話の中から矛盾を*見つける*処理は
`@mnemora/core` に存在しない**（[ADR 0134](./docs/decisions/0134-mark-contested-explicit-operation.md)
決定1・[Issue #197](https://github.com/takecchi/mnemora/issues/197)）。

**⟹ npm から入れたままの既定の振る舞いは「訂正しても、古いほうが出続ける」。**
古いほうを遠ざけるには、**採用側が「どの2件が矛盾しているか」を決めて
`markContested` を呼び、決着を `resolveContested` で渡す**必要がある。
⛔ **どちらが正しいかも、どちらが新しいかも、mnemora は判定しない。**

⚠ **これは `docs/north-star.md`「目指す姿」の項目5「間違いを正すと、古いほうが先に
出てこなくなる」が、出荷物の既定では*まだ*満たされていないということである**
（[docs/roadmap.md](./docs/roadmap.md) §7.13）。**検出の設計は
[PR #366](https://github.com/takecchi/mnemora/pull/366)（ADR 0185 の草案）で検討中。
⚠ まだマージされていない。**

---

## ⚠ 暫定

- **ここに書かれているのは設計であって、実装された事実ではない。**
  実装の進み具合は [docs/roadmap.md](./docs/roadmap.md) を見ること
