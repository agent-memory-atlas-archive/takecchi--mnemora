# @mnemora/core

mnemora の core パッケージ。型・interface・`runtime.observe/tick/recall` の実装・
純関数の既定戦略（減衰・スコアリング）を持つ。実行時依存は [zod](https://www.npmjs.com/package/zod) だけ。

## インストール

```bash
pnpm add @mnemora/core
# または
npm i @mnemora/core
```

## 前提

- Node.js >= 22（`package.json` の `engines`）
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `moduleResolution` が `node10` か
  `nodenext` なら通る。`node16` は `TS1479` になるので `nodenext` にすること）
- 実行時の依存は zod のみ

## ⚠ `@mnemora/core` だけでは動く物が組めない

**このパッケージは interface・型・純関数が中心で、それ単体では DB にも LLM にも
埋め込みモデルにもつながらない。**`runtime.observe()` / `runtime.tick()` / `runtime.recall()` を
実際に動かすには、`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` /
`TenantSettingsStore`（すべて Postgres 実装は [`@mnemora/postgres`](../postgres/README.md)）と、
`LLMProvider` / `EmbeddingProvider`（OpenAI 実装は [`@mnemora/openai`](../openai/README.md)、
テスト用の決定的な擬似実装は [`@mnemora/testkit`](../testkit/README.md)）を
呼び出し側が用意して渡す必要がある。

```ts
import type {
  EmbeddingProvider,
  EventStore,
  LLMProvider,
  MemoryStore,
  OutboxStore,
  TenantSettingsStore,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { createHash } from "node:crypto";

// この7つは @mnemora/core が実装を持たない——ここでは型だけを示す骨格。
// 実際の値は @mnemora/postgres（store）と @mnemora/openai（provider）、
// またはテスト用に @mnemora/testkit の決定的な擬似 provider から調達する。
declare const memoryStore: MemoryStore;
declare const outboxStore: OutboxStore;
declare const vectorStore: VectorStore;
declare const eventStore: EventStore;
declare const tenantSettingsStore: TenantSettingsStore;
declare const llmProvider: LLMProvider;
declare const embeddingProvider: EmbeddingProvider;

const runtime = createRuntime({
  memoryStore,
  outboxStore,
  vectorStore,
  eventStore,
  tenantSettingsStore,
  llmProvider,
  embeddingProvider,
  // D16: SHA-256 hex 等、content からハッシュを計算する関数。core は計算しない。
  hashContent: (content) => createHash("sha256").update(content).digest("hex"),
});

const ctx = { tenantId: "tenant-1" };
const { observationId } = await runtime.observe(ctx, {
  kind: "utterance",
  text: "明日、京都へ出張する",
  speaker: "user",
});
```

配線をすぐ試したいだけなら、`@mnemora/postgres` と `@mnemora/openai` の README にある
そのままの例をつなげば動く（`@mnemora/postgres` 側は本物の Postgres + pgvector が要る）。

## ⚠ 連想枠（`recall()` の段3.5）は既定 off

**`recall()` は、`RecallQuery.association` を渡さないかぎり連想を一切走らせない。**
⟹ **このパッケージを入れたままの既定の振る舞いは「聞かれたことにしか答えない」。**
（`packages/core/src/recall.ts:1132` の doc コメント逐語「**省略時は連想を一切走らせない**（既定 off）」。
off の実体は `packages/core/src/recall-runtime.ts:1049` の `if (associationQuery !== undefined)`。
既定を off にした理由は [ADR 0151](../../docs/decisions/0151-recall-association-unprompted.md)）

使うには、呼び出し側が明示的に渡す:

```ts
const recalled = await runtime.recall(ctx, {
  text: "京都の予定は?",
  association: { maxCount: 10 },
});
```

- `maxCount` — **必須。既定値は無い**（「量の上限を呼び出し側に必ず明示させる」ため）
- `anchorCount?` — 段3までに残った上位何件を連想の起点（アンカー）にするか。
  既定 `DEFAULT_ASSOCIATION_ANCHOR_COUNT` = 3。
  **⚠ `limit`（既定 10）が天井になる**——アンカーは段2で `limit` の内側に入った候補から取るので、
  **`anchorCount` だけを上げても効かない。**裾野を広げたいなら `limit` と両方上げること
  （【実測 2026-09-17】`limit:10 / anchorCount:40` で実際に起点になったアンカーは **10件**、
  `limit:40 / anchorCount:40` では 40件。
  [docs/recall.md](../../docs/recall.md) §9.2「⚠ `anchorCount` の天井」）
- `minSimilarity?` — アンカーとの**生のコサイン類似度**の下限。
  既定 `DEFAULT_ASSOCIATION_MIN_SIMILARITY` = 0.5（`scoreThreshold` とは尺度が違う別の値）

連想で来た候補は `retrievedVia: "association"` と `associationOf`（どのアンカーが連れてきたか）を
持つので、**クエリに当たった候補と区別できる。**

**渡すと何が変わるか。** `association-probes` ベンチ（probe 12件、本物の Postgres + pgvector、
埋め込みは `@mnemora/local-embedding` のプロセス内 ONNX 推論）の実測では、`maxCount: 10` で
**連想でしか届かない gold の到達が 0/12 → 12/12、費用は `memoryChars` +4.32%** だった
（`maxCount: 5` では 10/12・+2.22%。
[ADR 0168](../../docs/decisions/0168-examples-chat-uses-association.md)）。
**⚠ これはこのリポジトリの probe 12件で測った値であり、他のデータでの値ではない。**
**⚠ `VectorStore.getVectors`（任意メソッド）を実装していない adapter では、`association` を
渡しても連想は走らない**——走らなかったことは
`stage_skipped { stage: 'association', reason: 'vector_store_lacks_get_vectors' }` として
`omitted` に名乗る（[docs/recall.md](../../docs/recall.md) §9）。

## ⚠ `ctx.subjectId` を省略すると「テナント全体」になる（既定はそちら）

**`subjectId` は `recall()` の引数ではない。`Ctx` の任意欄である。**

```ts
const ctx = { tenantId: "tenant-1" };                        // ⟹ テナント全体が対象
const scoped = { tenantId: "tenant-1", subjectId: "user-1" }; // ⟹ この subject だけが対象
```

⟹ **すべてのメソッドの第一引数に載る任意欄なので、意識して足さないかぎり付かない。**

**段5（目次帯の集計、`MemoryStore.aggregateScope`）のコストが、ここで大きく変わる**
【実測 2026-09-17、PostgreSQL 17.11 + pgvector 0.8.0、並列無効、`digestBand` あり、n=20 の中央値】:

| 行数（1テナント） | `subjectId` 無し | `subjectId` あり（絞り先 ≈1%） | `subjectId` あり（絞り先 10行） |
|---:|---:|---:|---:|
| 1,000 | 3.5ms | 1.5ms | 1.5ms |
| 10,000 | 17.0ms | 1.5ms | 1.4ms |
| **100,000** | **165.1ms** | **4.0ms** | **1.3ms** |

**絞ったときのコストは、テナント総行数ではなく絞り先の大きさに比例する**——10行の subject なら、
テナントが 1,000行でも 100,000行でも 1.3〜1.5ms で変わらない。

**⛔ 「だから絞れ」とは言っていない。**`subjectId` は隔離境界ではなく**整理の単位**であり、
絞れば当然、他の subject の記憶は返らない。**どちらを選ぶかは使う側が決めることである。**

**⚠ 段5 は `recall()` から無条件に呼ばれる**（渡さなくても走る）。
詳しい実測・測っていないこと・上の数字と
[docs/recall.md](../../docs/recall.md) §5 の古い表（100,000行で 45.8ms）との差は、
同 §5「**`subjectId` を省略すると何が起きるか**」を見ること。

## 単体で呼べる純関数（動く最小の例）

一方で、以下は `@mnemora/core` だけで完結して**そのまま実行できる**——
記憶の減衰（`DecayStrategy`）・スコアリング（`ScoringStrategy`）・時刻（`Clock`）・
トークン数の推定（`TokenCounter`）は、DB もネットワークも要らない純関数として公開している。

```ts
import {
  defaultDecayStrategy,
  defaultScoringStrategy,
  heuristicTokenCounter,
  systemClock,
} from "@mnemora/core";

const now = systemClock.now();

// 半減期720時間（30日）で、記録から時間が経つほど強度が下がる。
const decayed = defaultDecayStrategy.strengthAt(now, {
  recordedAt: new Date("2026-01-01T00:00:00Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
});

// 減衰・タグ一致・鮮度・強度を掛け合わせた合計スコア。
const score = defaultScoringStrategy({
  now,
  tags: ["work"],
  queryTags: ["work"],
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  recordedAt: new Date("2026-01-01T00:00:00Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
});

// 文字種で重み付けした粗い推定（CJK 0.9トークン/字・非CJK 0.25トークン/字）。
// counter: "heuristic" を必ず返す（推定値を実測値の顔で返さない、という契約そのもの）。
// ⚠ CJK 以外の非ラテン文字（キリル・タイ・アラビア文字）は依然として過小評価する。
// 厳密さが要るなら TokenCounter を差し替えること（docs/decisions/0083-*.md）。
const { tokens, counter } = heuristicTokenCounter.count("hello world");

console.log({ decayed, total: score.total, tokens, counter });
```

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) — 全体アーキテクチャ・主要 interface（§5）
- [docs/recall.md](../../docs/recall.md) — `recall()` の7段パイプライン
- [docs/memory-model.md](../../docs/memory-model.md) — Memory のライフサイクル・減衰・忘却
- リポジトリ: https://github.com/takecchi/mnemora
